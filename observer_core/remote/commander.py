"""The WhatsApp instruction loop: owner message -> model -> (approved) shell -> report back.

Rules, in the order they are enforced:

1. Only messages from the configured owner number are considered. Anything else is
   dropped without a reply, so strangers cannot even probe whether the agent exists.
2. One instruction runs at a time. While it runs, new messages are either answers to
   the agent's question, a YES/NO to a proposed command, or STOP.
3. The model replies with exactly one JSON action per step: ``shell``, ``ask`` or
   ``done``. A ``shell`` action is never executed without a YES from the owner.
4. The loop is bounded (``max_steps``). Every outcome, including timeouts and model
   errors, ends with a message to the owner.

Nothing here touches WhatsApp directly: it talks to a ``Transport`` (``send_text``)
and a ``ModelProvider``. That keeps the whole loop testable with fakes.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from loguru import logger

from ..llm.base import ModelProvider, ProviderError, sanitize_error, with_retries
from ..models import ChatMessage
from ..runtime.parse import iter_balanced_objects
from .phone import mask_phone
from .shell import ShellResult, run_shell

MAX_REPLY_CHARS = 1500
#: A proposed command must fit whole in its approval message; it is never clipped.
MAX_PROPOSED_CHARS = 1000
OUTPUT_IN_REPLY_CHARS = 600
ACTIONS = ("shell", "ask", "done")

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


class Transport(Protocol):
    def send_text(self, user: str, text: str) -> None: ...


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
    action: str   # ignored | started | busy | answered | confirmed | declined | cancelled | reminded | idle
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
        if obj["action"] == "shell" and not str(obj.get("command", "")).strip():
            continue
        if obj["action"] == "ask" and not str(obj.get("question", "")).strip():
            continue
        return obj
    return None


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 15] + "\n...[cut]"


class Commander:
    def __init__(
        self,
        *,
        provider: ModelProvider,
        transport: Transport,
        settings: CommanderSettings,
        shell: Callable[..., ShellResult] = run_shell,
    ) -> None:
        self.provider = provider
        self.transport = transport
        self.settings = settings
        self._shell = shell
        self._lock = threading.Lock()
        self._task: _Task | None = None
        self.history: list[tuple[str, str]] = []   # (event, detail) for status output

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
                if word in ("STOP", "CANCEL"):
                    self._send("Nothing is running right now.")
                    return InboundResult("idle")
                if word in ("STATUS", "HELP"):
                    self._send(self._help_text())
                    return InboundResult("idle")
                task = _Task(instruction=message)
                self._task = task
                task.thread = threading.Thread(target=self._run_task, args=(task,),
                                               name="observer-whatsapp-task", daemon=True)
                task.thread.start()
                return InboundResult("started", message[:80])

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
                self._send("A command is waiting for approval. Reply YES to run it or NO to cancel it.")
                return InboundResult("reminded")

            if task.waiting == "answer":
                task.reply = message
                task.event.set()
                return InboundResult("answered")

            self._send(f"Still working on: {task.instruction[:80]}\nReply STOP to cancel.")
            return InboundResult("busy")

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
    def _run_task(self, task: _Task) -> None:
        messages: list[ChatMessage] = [
            ChatMessage(role="system", content=SYSTEM_PROMPT),
            ChatMessage(role="user", content=task.instruction),
        ]
        self._log("start", task.instruction[:80])
        try:
            for step in range(1, self.settings.max_steps + 1):
                if task.cancelled:
                    self._send("Cancelled.")
                    self._log("cancelled", "")
                    return
                raw = with_retries(lambda: self.provider.chat(messages))
                messages.append(ChatMessage(role="assistant", content=raw))
                action = parse_action(raw)
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
                    continue
                decision = self._await(task, "confirm", prompt, self.settings.confirm_timeout_s)
                if decision is None:
                    return
                if decision == "NO":
                    self._log("declined", command[:80])
                    messages.append(ChatMessage(
                        role="user",
                        content="The owner declined that command. Propose something else, or reply with done."))
                    continue

                result = self._shell(command, cwd=self.settings.cwd,
                                     timeout_s=self.settings.command_timeout_s)
                self._log("ran", f"{result.status_line()}: {command[:60]}")
                excerpt = _clip(result.output.strip() or "(no output)", OUTPUT_IN_REPLY_CHARS)
                self._send(f"Ran step {step} ({result.status_line()}):\n{excerpt}")
                messages.append(ChatMessage(
                    role="user",
                    content=f"Command result ({result.status_line()}):\n{result.output or '(no output)'}"))

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
    def _send(self, text: str) -> None:
        try:
            self.transport.send_text(self.settings.owner_user, _clip(text, MAX_REPLY_CHARS))
        except Exception as exc:  # a failed send must not kill the task
            logger.warning("whatsapp send failed: {}", sanitize_error(exc))

    def _log(self, event: str, detail: str) -> None:
        self.history = (self.history + [(event, detail)])[-50:]
        logger.info("whatsapp: {} {}", event, detail)

    def _help_text(self) -> str:
        return ("Send me an instruction and I will work on your computer.\n"
                "Each command is shown to you first: reply YES to run it, NO to cancel.\n"
                "STOP cancels the current task.")


__all__ = ["Commander", "CommanderSettings", "InboundResult", "SYSTEM_PROMPT", "parse_action"]
