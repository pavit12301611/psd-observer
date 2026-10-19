"""The WhatsApp instruction loop: owner message -> model or direct command -> approval -> result.

Rules, in the order they are enforced:

1. Only messages from the configured owner number are considered. Anything else is
   dropped without a reply, so strangers cannot even probe whether the agent exists.
2. One task runs at a time. While it runs, new messages are answers to the agent's
   question, a YES/NO to a proposed action, or STOP.
3. Every action that changes something is approved first with YES:
     * ``shell``   one command, shown in full, run once
     * ``routine`` a named, pre-approved step list, run now or on a timer
     * ``browser`` one web job (arena.ai Agent Mode, or web research), shown in full, then unattended
4. The loop is bounded (``max_steps``). Every outcome, including timeouts and model
   errors, ends with a message to the owner.

Direct commands skip the model: ``RUN home [IN 5 MIN]``, ``ARENA: <prompt>``, ``RESEARCH: <question>``,
``TIMERS``, ``CANCEL <id>``, ``ROUTINES``.

Nothing here touches WhatsApp directly: it talks to a ``Transport`` (``send_text``),
a ``ModelProvider``, and optional routine/browser services. Tests use fakes for all.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from loguru import logger

from ..llm.base import ModelProvider, ProviderError, sanitize_error, with_retries
from ..models import ChatMessage
from ..runtime.parse import iter_balanced_objects
from .browser import MAX_PROMPT_CHARS, BrowserJobError, BrowserUnavailable, JobResult
from .phone import mask_phone
from .routines import (
    RoutineService,
    describe_routines,
    routine_context_for_prompt,
    timer_due_text,
)
from .shell import ShellResult, run_shell
from .timers import MAX_DELAY_MIN

MAX_REPLY_CHARS = 1500
#: A proposed command must fit whole in its approval message; it is never clipped.
MAX_PROPOSED_CHARS = 1000
OUTPUT_IN_REPLY_CHARS = 600
ACTIONS = ("shell", "ask", "done", "routine", "browser")

SYSTEM_PROMPT = """You are Observer, a personal assistant running on the owner's Fedora Linux computer.
The owner talks to you over WhatsApp. You can run ONE shell command at a time.
Every command you propose is shown to the owner, who must approve it with YES before it runs.

Reply with EXACTLY ONE JSON object and nothing else. Choose one of:
  {"action": "shell", "command": "<bash command>", "reason": "<why, one short sentence>"}
  {"action": "ask", "question": "<one short question for the owner>"}
  {"action": "done", "summary": "<what you did and the result, plain language>"}

Rules:
- Prefer read-only commands first to see what is there.
- Never run sudo or anything that waits for a password; it will fail.
- Keep each command small and specific. Use one command per step.
- When the owner's request is finished, reply with "done". If you cannot do it, say so in "done".
- The owner's home directory is the working directory.
"""

_RUN = re.compile(r"^run\s+([A-Za-z0-9_-]{1,32})(?:\s+in\s+(\d{1,4})\s*(?:m|min|mins|minutes?)?)?$", re.IGNORECASE)
_CANCEL = re.compile(r"^cancel\s+#?(\d+)$", re.IGNORECASE)
_ARENA = re.compile(r"^arena:\s*(.+)$", re.IGNORECASE | re.DOTALL)
_RESEARCH = re.compile(r"^research:\s*(.+)$", re.IGNORECASE | re.DOTALL)


class Transport(Protocol):
    def send_text(self, user: str, text: str) -> None: ...


#: (prompt, ask, say) -> JobResult. Built by the service; raises BrowserJobError / BrowserUnavailable.
BrowserRunner = Callable[..., JobResult]   # (prompt, ask, say, mode=...) -> JobResult


@dataclass
class CommanderSettings:
    owner_user: str
    max_steps: int = 10
    command_timeout_s: float = 120.0
    confirm_timeout_s: float = 600.0
    answer_timeout_s: float = 600.0
    cwd: Path | None = None


@dataclass
class _Task:
    instruction: str
    waiting: str | None = None          # None | "confirm" | "answer"
    reply: str | None = None
    event: threading.Event = field(default_factory=threading.Event)
    cancelled: bool = False
    thread: threading.Thread | None = None


@dataclass
class InboundResult:
    """What handle_inbound did with a message. Returned for tests and logs only."""
    action: str   # ignored | started | busy | answered | confirmed | declined | cancelled | reminded | idle | direct
    detail: str = ""


def parse_action(raw: str) -> dict[str, Any] | None:
    """Pull the first valid action object out of a model reply (tolerates prose around it)."""
    for blob in iter_balanced_objects(raw or ""):
        try:
            obj = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict) or obj.get("action") not in ACTIONS:
            continue
        if not valid_action(obj):
            continue
        return obj
    return None


def valid_action(obj: dict[str, Any]) -> bool:
    kind = obj.get("action")
    if kind == "shell":
        return bool(str(obj.get("command", "")).strip())
    if kind == "ask":
        return bool(str(obj.get("question", "")).strip())
    if kind == "routine":
        return bool(str(obj.get("name", "")).strip())
    if kind == "browser":
        return bool(str(obj.get("prompt", "")).strip())
    return kind == "done"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 15] + "\n...[cut]"


def _direct_action(message: str) -> dict[str, Any] | None:
    """Deterministic commands that start a task without the model."""
    run = _RUN.match(message)
    if run:
        minutes = int(run.group(2)) if run.group(2) else 0
        return {"action": "routine", "name": run.group(1).lower(), "in_minutes": minutes, "direct": True}
    arena = _ARENA.match(message)
    if arena:
        return {"action": "browser", "mode": "arena", "prompt": arena.group(1).strip(), "direct": True}
    research = _RESEARCH.match(message)
    if research:
        return {"action": "browser", "mode": "research", "prompt": research.group(1).strip(), "direct": True}
    return None


class Commander:
    def __init__(
        self,
        *,
        provider: ModelProvider,
        transport: Transport,
        settings: CommanderSettings,
        shell: Callable[..., ShellResult] = run_shell,
        routines: RoutineService | None = None,
        browser: BrowserRunner | None = None,
    ) -> None:
        self.provider = provider
        self.transport = transport
        self.settings = settings
        self._shell = shell
        self.routines = routines
        self.browser = browser
        self._lock = threading.Lock()
        self._task: _Task | None = None
        self.history: list[tuple[str, str]] = []   # (event, detail) for status output
        self._system = self._build_system_prompt()

    def _build_system_prompt(self) -> str:
        extra = ["", "Additional actions (each one needs the owner's YES first):",
                 '  {"action": "routine", "name": "<routine name>", "in_minutes": 0}   '
                 "(0 = run now; 1-720 = schedule that many minutes from now)",
                 "Pre-approved routines you may use:"]
        extra.append(routine_context_for_prompt(self.routines.routines) if self.routines else "No routines are defined.")
        if self.browser is not None:
            extra += ["", '  {"action": "browser", "mode": "arena", "prompt": "<exact text to submit to arena.ai Agent Mode>"}',
                      "Use mode arena only when the owner asks you to use arena.ai or Arena Agent Mode.",
                      '  {"action": "browser", "mode": "research", "prompt": "<the question to research on the web>"}',
                      "Use mode research when the owner asks you to look something up, find sources, or check the web. "
                      "The browser searches, opens sites, and reports back with sources."]
        return SYSTEM_PROMPT + "\n".join(extra) + "\n"

    # ------------------------------------------------------------------ #
    # inbound: called by the transport for each message from a 1:1 chat
    # ------------------------------------------------------------------ #
    def handle_inbound(self, sender_user: str, text: str) -> InboundResult:
        if sender_user != self.settings.owner_user:
            logger.info("whatsapp: ignored message from {}", mask_phone(sender_user))
            return InboundResult("ignored")
        message = (text or "").strip()
        if not message:
            return InboundResult("ignored", "empty")
        word = message.upper()

        with self._lock:
            task = self._task
            if task is None:
                return self._idle_message(message, word)

            if word in ("STOP", "CANCEL"):
                task.cancelled = True
                task.reply = "STOP"
                task.event.set()
                if task.waiting is None:
                    self._send("Stopping after the current step.")
                return InboundResult("cancelled")

            if task.waiting == "confirm":
                if word in ("YES", "Y"):
                    task.reply = "YES"
                    task.event.set()
                    return InboundResult("confirmed")
                if word in ("NO", "N"):
                    task.reply = "NO"
                    task.event.set()
                    return InboundResult("declined")
                self._send("Waiting for your approval. Reply YES to go ahead or NO to cancel.")
                return InboundResult("reminded")

            if task.waiting == "answer":
                task.reply = message
                task.event.set()
                return InboundResult("answered")

            self._send(f"Still working on: {task.instruction[:80]}\nReply STOP to cancel.")
            return InboundResult("busy")

    def _idle_message(self, message: str, word: str) -> InboundResult:
        """No task running: STOP, direct commands, or a new instruction for the model."""
        if word in ("STOP", "CANCEL"):
            self._send("Nothing is running right now.")
            return InboundResult("idle")
        if word in ("STATUS", "HELP"):
            self._send(self._help_text())
            return InboundResult("idle")
        if word == "ROUTINES":
            self._send(describe_routines(self.routines.routines) if self.routines else "Routines are not set up.")
            return InboundResult("direct", "routines")
        if word == "TIMERS":
            self._send(self._timers_text())
            return InboundResult("direct", "timers")
        cancel = _CANCEL.match(message)
        if cancel:
            timer_id = int(cancel.group(1))
            if self.routines and self.routines.cancel(timer_id):
                self._send(f"⏰ Timer #{timer_id} cancelled.")
            else:
                self._send(f"No timer #{timer_id}. Send TIMERS to see the list.")
            return InboundResult("direct", "cancel")
        direct = _direct_action(message)
        if direct is not None:
            return self._start_task(message, preset=direct)
        return self._start_task(message)

    def _start_task(self, instruction: str, *, preset: dict[str, Any] | None = None) -> InboundResult:
        task = _Task(instruction=instruction)
        self._task = task
        task.thread = threading.Thread(target=self._run_task, args=(task, preset),
                                       name="observer-whatsapp-task", daemon=True)
        task.thread.start()
        return InboundResult("started", instruction[:80])

    def is_busy(self) -> bool:
        with self._lock:
            return self._task is not None

    def wait_idle(self, timeout: float = 5.0) -> bool:
        """Block until the current task thread ends (used by tests and shutdown)."""
        with self._lock:
            thread = self._task.thread if self._task else None
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    # ------------------------------------------------------------------ #
    # the worker
    # ------------------------------------------------------------------ #
    def _run_task(self, task: _Task, preset: dict[str, Any] | None = None) -> None:
        messages: list[ChatMessage] = [
            ChatMessage(role="system", content=self._system),
            ChatMessage(role="user", content=task.instruction),
        ]
        self._log("start", task.instruction[:80])
        try:
            for step in range(1, self.settings.max_steps + 1):
                if task.cancelled:
                    self._send("Cancelled.")
                    self._log("cancelled", "")
                    return
                if preset is not None:
                    action, preset_used = preset, True
                    preset = None
                else:
                    raw = with_retries(lambda: self.provider.chat(messages))
                    messages.append(ChatMessage(role="assistant", content=raw))
                    action = parse_action(raw)
                    preset_used = False
                    if action is None:
                        messages.append(ChatMessage(
                            role="user",
                            content="That was not a valid action. Reply with exactly one JSON object as specified."))
                        continue

                kind = action["action"]
                if kind == "done":
                    summary = str(action.get("summary") or "Done.").strip()
                    self._send(f"✅ {summary}")
                    self._log("done", summary[:80])
                    return

                if kind == "ask":
                    question = str(action.get("question")).strip()
                    answer = self._await(task, "answer", f"❓ {question}", self.settings.answer_timeout_s)
                    if answer is None:
                        return
                    messages.append(ChatMessage(role="user", content=f"Owner answered: {answer}"))
                    continue

                if kind == "routine":
                    if self._handle_routine(task, action, preset_used, messages):
                        return
                    continue

                if kind == "browser":
                    self._handle_browser(task, action)
                    return

                if self._handle_shell(task, action, step, messages):
                    return

            self._send(f"⚠️ Stopped after {self.settings.max_steps} steps without finishing. "
                       "Send the instruction again to continue.")
            self._log("step_limit", "")
        except ProviderError as exc:
            self._send(f"❌ The model could not answer: {sanitize_error(exc)}")
            self._log("model_error", sanitize_error(exc)[:120])
        except Exception as exc:  # the worker must never die silently
            logger.exception("whatsapp task crashed")
            self._send(f"❌ Internal error: {type(exc).__name__}. Details are in the log.")
            self._log("crash", type(exc).__name__)
        finally:
            with self._lock:
                if self._task is task:
                    self._task = None

    def _handle_shell(self, task: _Task, action: dict[str, Any], step: int,
                      messages: list[ChatMessage]) -> bool:
        """Approve and run one command. Returns True when the task must end."""
        command = str(action.get("command")).strip()
        reason = str(action.get("reason") or "").strip()[:200]
        lines = [f"Step {step}: I want to run", command]
        if reason:
            lines.append(f"Why: {reason}")
        lines.append("Reply YES to run it or NO to cancel.")
        prompt = "\n".join(lines)
        if len(command) > MAX_PROPOSED_CHARS or len(prompt) > MAX_REPLY_CHARS:
            # The owner must see every character they approve. Never clip a proposal.
            messages.append(ChatMessage(
                role="user",
                content=f"That command is too long for the owner to review (limit {MAX_PROPOSED_CHARS} "
                        "characters). Split it into smaller steps or propose a shorter command."))
            self._log("too_long", str(len(command)))
            return False
        decision = self._await(task, "confirm", prompt, self.settings.confirm_timeout_s)
        if decision is None:
            return True
        if decision == "NO":
            self._log("declined", command[:80])
            messages.append(ChatMessage(
                role="user",
                content="The owner declined that command. Propose something else, or reply with done."))
            return False
        result = self._shell(command, cwd=self.settings.cwd, timeout_s=self.settings.command_timeout_s)
        self._log("ran", f"{result.status_line()}: {command[:60]}")
        excerpt = _clip(result.output.strip() or "(no output)", OUTPUT_IN_REPLY_CHARS)
        self._send(f"Ran step {step} ({result.status_line()}):\n{excerpt}")
        messages.append(ChatMessage(
            role="user",
            content=f"Command result ({result.status_line()}):\n{result.output or '(no output)'}"))
        return False

    def _handle_routine(self, task: _Task, action: dict[str, Any], direct: bool,
                        messages: list[ChatMessage]) -> bool:
        """Approve a routine, then run it now or schedule it. Returns True when the task must end."""
        name = str(action.get("name", "")).strip().lower()
        routine = self.routines.get(name) if self.routines else None

        def refuse(text: str) -> bool:
            if direct:
                self._send(text)
                return True
            messages.append(ChatMessage(role="user", content=text))
            return False

        if self.routines is None:
            return refuse("Routines are not set up on this computer.")
        if routine is None:
            return refuse(f"There is no routine named '{name}'. Available: "
                          f"{', '.join(self.routines.names()) or 'none'}.")
        try:
            minutes = int(action.get("in_minutes") or 0)
        except (TypeError, ValueError):
            return refuse("in_minutes must be a whole number.")
        if not (0 <= minutes <= MAX_DELAY_MIN):
            return refuse(f"in_minutes must be between 0 and {MAX_DELAY_MIN}.")
        when = "now" if minutes == 0 else f"at {timer_due_text(time.time() + minutes * 60)} (in {minutes} min)"
        prompt = "\n".join([f"⏰ Routine '{routine.name}' {when}:", *routine.plan_lines(),
                            "These steps run automatically at that time, without asking again.",
                            "Reply YES to confirm or NO to cancel."])
        if len(prompt) > MAX_REPLY_CHARS:
            return refuse(f"Routine '{routine.name}' is too long to approve in one message. Shorten it.")
        decision = self._await(task, "confirm", prompt, self.settings.confirm_timeout_s)
        if decision is None:
            return True
        if decision == "NO":
            self._send("OK, nothing was scheduled or run.")
            self._log("declined", f"routine {routine.name}")
            return True
        if minutes == 0:
            ok, summary = self.routines.run_now(routine)
            self._send(("✅ " if ok else "❌ ") + f"'{routine.name}': {summary}")
            self._log("routine_run", f"{routine.name} ok={ok}")
            return True
        timer = self.routines.schedule(routine, minutes)
        self._send(f"⏰ Scheduled #{timer.id} '{routine.name}' for {timer_due_text(timer.fire_at)}. "
                   f"Send CANCEL {timer.id} to stop it.")
        self._log("scheduled", f"#{timer.id} {routine.name} in {minutes}m")
        return True

    def _handle_browser(self, task: _Task, action: dict[str, Any]) -> None:
        prompt = str(action.get("prompt", "")).strip()
        mode = "research" if action.get("mode") == "research" else "arena"
        if self.browser is None:
            self._send("Browser jobs are off. Turn on whatsapp.browser_enabled and run "
                       "`observer-core whatsapp browser-login` once.")
            return
        if len(prompt) > MAX_PROMPT_CHARS:
            self._send(f"That prompt is longer than {MAX_PROMPT_CHARS} characters. Shorten it and send again.")
            return
        if mode == "research":
            intro = ["🔎 Research job. I will search the web in the dedicated browser, open the sites I need, "
                     "and answer your question with sources:"]
            outro = ["It opens public websites only (never your local network) and saves downloads to your folder.",
                     "Reply YES to start or NO to cancel."]
        else:
            intro = ["🌐 Arena browser job. I will open arena.ai/agent in the dedicated browser, "
                     "type this prompt, and wait for the answer:"]
            outro = ["It only uses arena.ai and saves downloads to your Arena folder.",
                     "Reply YES to start or NO to cancel."]
        text = "\n".join(intro + ["", prompt, ""] + outro)
        if len(text) > MAX_REPLY_CHARS:
            self._send("That prompt is too long to approve in one message. Shorten it and send again.")
            return
        decision = self._await(task, "confirm", text, self.settings.confirm_timeout_s)
        if decision is None:
            return
        if decision == "NO":
            self._send("OK, the job was not started.")
            return
        label = "research" if mode == "research" else "arena.ai"
        self._send(f"{'🔎' if mode == 'research' else '🌐'} Starting the {label} job. I will message you as I go.")
        self._log("browser_start", f"{mode}: {prompt[:60]}")

        def ask(question: str) -> str | None:
            return self._await(task, "answer", f"❓ ({label}) {question}", self.settings.answer_timeout_s)

        try:
            result = self.browser(prompt, ask, self._send, mode=mode)
        except BrowserJobError as exc:
            self._send(f"❌ {label} job stopped: {exc}")
            self._log("browser_stopped", str(exc)[:120])
            return
        except BrowserUnavailable as exc:
            self._send(f"❌ {exc}")
            self._log("browser_unavailable", str(exc)[:120])
            return
        files = f"\nFiles saved: {', '.join(result.downloads)}" if result.downloads else ""
        sources = list(getattr(result, "sources", []) or [])
        cited = ("\nSources:\n" + "\n".join(sources)) if sources else ""
        heading = "✅ Research result:" if mode == "research" else "✅ arena.ai result:"
        self._send(f"{heading}\n{result.summary}{files}{cited}")
        self._log("browser_done", result.summary[:80])

    def _await(self, task: _Task, kind: str, prompt: str, timeout_s: float) -> str | None:
        """Ask the owner and wait. Returns the reply, or None when the task must end."""
        with self._lock:
            task.reply = None
            task.event.clear()
            task.waiting = kind
        self._send(prompt)
        got = task.event.wait(timeout_s)
        with self._lock:
            task.waiting = None
            reply = task.reply
        if task.cancelled or (reply == "STOP"):
            self._send("Cancelled.")
            self._log("cancelled", kind)
            return None
        if not got or reply is None:
            self._send("⏱️ No reply in time, so I stopped. Nothing else was run.")
            self._log("timeout", kind)
            return None
        return reply

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _timers_text(self) -> str:
        timers = self.routines.timers() if self.routines else []
        if not timers:
            return "No timers are scheduled."
        now = time.time()
        return "⏰ Timers:\n" + "\n".join(
            f"#{t.id} '{t.routine}' at {timer_due_text(t.fire_at)} (in {max(0, round((t.fire_at - now) / 60))} min)"
            for t in timers)

    def _send(self, text: str) -> None:
        try:
            self.transport.send_text(self.settings.owner_user, _clip(text, MAX_REPLY_CHARS))
        except Exception as exc:  # a failed send must not kill the task
            logger.warning("whatsapp send failed: {}", sanitize_error(exc))

    def _log(self, event: str, detail: str) -> None:
        self.history = (self.history + [(event, detail)])[-50:]
        logger.info("whatsapp: {} {}", event, detail)

    def _help_text(self) -> str:
        lines = ["Send me an instruction and I will work on your computer.",
                 "Each command is shown to you first: reply YES to run it, NO to cancel.",
                 "ROUTINES lists saved routines. RUN <name> [IN <minutes> MIN] runs one.",
                 "TIMERS lists scheduled ones; CANCEL <id> stops one.",
                 "ARENA: <prompt> runs a job on arena.ai (if enabled).",
                 "RESEARCH: <question> searches the web and reports back with sources (if enabled).",
                 "STOP cancels the current task."]
        return "\n".join(lines)


__all__ = ["Commander", "CommanderSettings", "InboundResult", "SYSTEM_PROMPT", "parse_action", "BrowserRunner",
           "MAX_REPLY_CHARS"]
