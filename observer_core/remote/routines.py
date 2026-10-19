"""Pre-approved routines: named step lists the agent may run from WhatsApp, now or on a timer.

A routine lives in ``routines.toml`` in the config directory, written by you. The agent
can only run routines that exist in that file, so a timed run never needs a fresh
model decision. You approve a routine once, when you schedule or start it: the full
step list is shown and needs a YES.

Step types (exactly one key per step):

    { open_app = "firefox" }          start an installed program, no arguments
    { open_url = "https://..." }      open an http(s) address in the default browser
    { run = "exact shell command" }   run exactly this command (bash, 120 s limit)
    { notify = "text" }               send a WhatsApp message to the owner
    { wait = 5 }                      pause 0-300 seconds

Steps run in order and stop at the first failure, which is reported.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from .shell import ShellResult, run_shell
from .timers import MAX_DELAY_MIN, Timer, TimerStore

MAX_STEPS = 20
MAX_ROUTINES = 50
MAX_WAIT_S = 300
LATE_AFTER_S = 15 * 60          # a timer this late (computer asleep, Observer stopped) is skipped
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_APP = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
_STEP_KINDS = ("open_app", "open_url", "run", "notify", "wait")


class RoutineError(ValueError):
    """A routine file or step is invalid. The message names the problem."""


@dataclass(frozen=True)
class Step:
    kind: str
    value: Any

    def describe(self) -> str:
        if self.kind == "open_app":
            return f"open {self.value}"
        if self.kind == "open_url":
            return f"open {self.value}"
        if self.kind == "run":
            return f"run `{self.value}`"
        if self.kind == "notify":
            return f"message: {self.value}"
        return f"wait {self.value}s"


@dataclass(frozen=True)
class Routine:
    name: str
    description: str
    steps: tuple[Step, ...]

    def plan_lines(self) -> list[str]:
        return [f"{i}. {s.describe()}" for i, s in enumerate(self.steps, 1)]


def parse_step(raw: Any, where: str) -> Step:
    if not isinstance(raw, dict) or len(raw) != 1:
        raise RoutineError(f"{where}: each step must have exactly one key, e.g. {{ open_app = \"firefox\" }}")
    kind, value = next(iter(raw.items()))
    if kind not in _STEP_KINDS:
        raise RoutineError(f"{where}: unknown step {kind!r} (allowed: {', '.join(_STEP_KINDS)})")
    if kind == "open_app":
        if not isinstance(value, str) or not _APP.match(value):
            raise RoutineError(f"{where}: open_app needs a program name without spaces, e.g. \"firefox\"")
    elif kind == "open_url":
        if not isinstance(value, str) or not value.startswith(("https://", "http://")) or any(c.isspace() for c in value):
            raise RoutineError(f"{where}: open_url needs an http(s) address with no spaces")
    elif kind == "run":
        if not isinstance(value, str) or not value.strip() or len(value) > 500 or "\n" in value:
            raise RoutineError(f"{where}: run needs one command line of at most 500 characters")
        value = value.strip()
    elif kind == "notify":
        if not isinstance(value, str) or not value.strip() or len(value) > 300:
            raise RoutineError(f"{where}: notify needs text of at most 300 characters")
    elif kind == "wait":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not (0 <= value <= MAX_WAIT_S):
            raise RoutineError(f"{where}: wait needs a number of seconds from 0 to {MAX_WAIT_S}")
    return Step(kind, value)


def parse_routines(data: dict[str, Any]) -> tuple[dict[str, Routine], list[str]]:
    """Return ``(valid routines by name, error messages)``. A bad routine never hides the good ones."""
    routines: dict[str, Routine] = {}
    errors: list[str] = []
    entries = data.get("routine", [])
    if not isinstance(entries, list):
        return {}, ["routines.toml: use [[routine]] tables"]
    if len(entries) > MAX_ROUTINES:
        errors.append(f"routines.toml: more than {MAX_ROUTINES} routines; the rest were ignored")
    for index, entry in enumerate(entries[:MAX_ROUTINES], 1):
        where = f"routine #{index}"
        try:
            if not isinstance(entry, dict):
                raise RoutineError(f"{where}: must be a table")
            name = str(entry.get("name", "")).strip().lower()
            where = f"routine '{name or index}'"
            if not _NAME.match(name):
                raise RoutineError(f"{where}: name must be 1-32 lowercase letters, digits, '-' or '_'")
            if name in routines:
                raise RoutineError(f"{where}: duplicate name")
            steps_raw = entry.get("steps")
            if not isinstance(steps_raw, list) or not steps_raw:
                raise RoutineError(f"{where}: needs a non-empty steps list")
            if len(steps_raw) > MAX_STEPS:
                raise RoutineError(f"{where}: at most {MAX_STEPS} steps")
            steps = tuple(parse_step(s, where) for s in steps_raw)
            description = str(entry.get("description", "")).strip()[:120] or "(no description)"
            routines[name] = Routine(name=name, description=description, steps=steps)
        except RoutineError as exc:
            errors.append(str(exc))
    return routines, errors


def load_routines(path: Path) -> tuple[dict[str, Routine], list[str]]:
    if not path.exists():
        return {}, []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        return {}, [f"{path}: {exc}"]
    return parse_routines(data)


# ----------------------------------------------------------------------- #
# step execution (launchers are injectable for tests)
# ----------------------------------------------------------------------- #
def launch_app(name: str) -> tuple[bool, str]:
    """Start a program without waiting for it. Returns (started, message)."""
    path = shutil.which(name)
    try:
        if path:
            subprocess.Popen([path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return True, f"started {name}"
        if shutil.which("gtk-launch"):   # desktop-file id such as "org.gnome.Calculator"
            res = subprocess.run(["gtk-launch", name], stdin=subprocess.DEVNULL, capture_output=True,
                                 timeout=15, check=False)
            if res.returncode == 0:
                return True, f"started {name}"
        return False, f"{name} is not installed or has no desktop entry"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"could not start {name}: {exc}"


def open_url(url: str) -> tuple[bool, str]:
    opener = shutil.which("xdg-open")
    if not opener:
        return False, "xdg-open is not installed (sudo dnf install --needed xdg-utils)"
    try:
        subprocess.Popen([opener, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        return True, f"opened {url}"
    except OSError as exc:
        return False, f"could not open {url}: {exc}"


def execute_routine(routine: Routine, *, say: Callable[[str], None],
                    shell: Callable[..., ShellResult] = run_shell,
                    launch: Callable[[str], tuple[bool, str]] = launch_app,
                    opener: Callable[[str], tuple[bool, str]] = open_url,
                    sleep: Callable[[float], None] = time.sleep,
                    cwd: Path | None = None, command_timeout_s: float = 120.0) -> tuple[bool, str]:
    """Run every step in order. Returns (all_ok, summary)."""
    total = len(routine.steps)
    for index, step in enumerate(routine.steps, 1):
        if step.kind == "open_app":
            ok, msg = launch(step.value)
        elif step.kind == "open_url":
            ok, msg = opener(step.value)
        elif step.kind == "run":
            res = shell(step.value, cwd=cwd, timeout_s=command_timeout_s)
            ok = res.ok
            msg = f"ran `{step.value}`: {res.status_line()}" + (f"\n{res.output[-300:]}" if not ok and res.output else "")
        elif step.kind == "notify":
            ok, msg = True, str(step.value)
            say(f"📣 {step.value}")
        else:
            sleep(float(step.value))
            ok, msg = True, f"waited {step.value}s"
        if step.kind != "notify":
            say(f"{'✓' if ok else '✗'} step {index}/{total}: {msg}")
        if not ok:
            return False, f"stopped at step {index}/{total}: {msg}"
    return True, f"all {total} steps done"


# ----------------------------------------------------------------------- #
# the service the commander and the scheduler use
# ----------------------------------------------------------------------- #
@dataclass
class RoutineService:
    routines: dict[str, Routine]
    store: TimerStore
    say: Callable[[str], None]
    errors: list[str] = field(default_factory=list)
    clock: Callable[[], float] = time.time
    executor: Callable[..., tuple[bool, str]] = execute_routine
    cwd: Path | None = None
    command_timeout_s: float = 120.0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def get(self, name: str) -> Routine | None:
        return self.routines.get((name or "").strip().lower())

    def names(self) -> list[str]:
        return sorted(self.routines)

    def run_now(self, routine: Routine) -> tuple[bool, str]:
        return self.executor(routine, say=self.say, cwd=self.cwd, command_timeout_s=self.command_timeout_s)

    def schedule(self, routine: Routine, minutes: int) -> Timer:
        if not (1 <= minutes <= MAX_DELAY_MIN):
            raise RoutineError(f"delay must be 1-{MAX_DELAY_MIN} minutes")
        now = self.clock()
        return self.store.add(routine.name, fire_at=now + minutes * 60, now=now)

    def timers(self) -> list[Timer]:
        return self.store.list()

    def cancel(self, timer_id: int) -> bool:
        return self.store.cancel(timer_id)

    def tick(self, now: float | None = None) -> list[Timer]:
        """Fire due timers. Runs each routine on its own thread. Returns the timers handled."""
        now = self.clock() if now is None else now
        handled = []
        for timer in self.store.pop_due(now):
            handled.append(timer)
            routine = self.get(timer.routine)
            if routine is None:
                self.say(f"⏰ Timer #{timer.id}: routine '{timer.routine}' no longer exists; skipped.")
                continue
            if now - timer.fire_at > LATE_AFTER_S:
                self.say(f"⏰ Timer #{timer.id} '{routine.name}' was due earlier, but the computer was asleep "
                         "or Observer was stopped, so it was skipped. Schedule it again if you still need it.")
                continue
            threading.Thread(target=self._fire, args=(routine, timer), name=f"observer-timer-{timer.id}",
                             daemon=True).start()
        return handled

    def _fire(self, routine: Routine, timer: Timer) -> None:
        self.say(f"⏰ Timer #{timer.id}: running '{routine.name}' now.")
        try:
            ok, summary = self.run_now(routine)
            self.say(("✅ " if ok else "❌ ") + f"'{routine.name}': {summary}")
        except Exception as exc:  # a broken routine must not kill the scheduler
            logger.exception("routine crashed")
            self.say(f"❌ '{routine.name}' crashed: {type(exc).__name__}. Details are in the log.")


def describe_routines(routines: dict[str, Routine]) -> str:
    if not routines:
        return "No routines are defined. Add [[routine]] entries to routines.toml in your config folder."
    return "\n".join(f"• {r.name}: {r.description}" for r in routines.values())


def routine_context_for_prompt(routines: dict[str, Routine]) -> str:
    if not routines:
        return "No routines are defined."
    lines = []
    for r in routines.values():
        lines.append(f"- {r.name}: {r.description} (steps: {'; '.join(s.describe() for s in r.steps)})")
    return "\n".join(lines)


def timer_due_text(fire_at: float) -> str:
    return time.strftime("%H:%M", time.localtime(fire_at))


EXAMPLE_ROUTINES = """# Routines the WhatsApp agent may run. It can only run what is written here.
# Each step is ONE of:
#   { open_app = "firefox" }          start an installed program (no arguments)
#   { open_url = "https://..." }      open an http(s) address in the default browser
#   { run = "exact shell command" }   run exactly this command (120 s limit)
#   { notify = "text" }               send a WhatsApp message to you
#   { wait = 5 }                      pause 0-300 seconds
# Ask on WhatsApp:  RUN home            (runs now, after your YES)
#                   RUN home IN 5 MIN   (runs in 5 minutes, after your YES)
#
# [[routine]]
# name = "home"
# description = "Desk ready when I get home"
# steps = [
#   { open_app = "firefox" },
#   { open_url = "https://arena.ai/agent" },
#   { notify = "Welcome home. Desk is ready." },
# ]
"""


__all__ = ["EXAMPLE_ROUTINES", "Routine", "Step", "RoutineError", "RoutineService", "parse_routines", "load_routines",
           "execute_routine", "launch_app", "open_url", "describe_routines", "routine_context_for_prompt",
           "timer_due_text", "LATE_AFTER_S", "MAX_WAIT_S"]
