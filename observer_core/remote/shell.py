"""Run one shell command for the WhatsApp remote, with hard limits.

Safety properties (enforced here, not by the model):

* The command runs only after the owner approved it in WhatsApp (the caller checks).
* ``stdin`` is closed, so anything that wants a password or a tty fails fast
  instead of hanging. ``sudo`` therefore cannot prompt; it will simply fail.
* The command runs in its own process group. On timeout the whole group is killed,
  so background children do not survive the limit.
* Output is capped; the model and the chat only see a bounded excerpt.

This is NOT a sandbox. The command runs as the logged-in user with that user's
files, network and display. The confirmation step is the control.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

MAX_COMMAND_CHARS = 2000
MAX_OUTPUT_CHARS = 4000


@dataclass
class ShellResult:
    command: str
    exit_code: int | None
    output: str
    timed_out: bool = False
    duration_s: float = 0.0

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def status_line(self) -> str:
        if self.timed_out:
            return "timed out and was killed"
        return f"exit {self.exit_code}"


def truncate_middle(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    """Keep the head and tail of long output, marking the cut."""
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n...[{len(text) - limit} characters cut]...\n{text[-tail:]}"


def run_shell(command: str, *, cwd: Path | str | None = None, timeout_s: float = 120.0,
              shell: str = "/bin/bash") -> ShellResult:
    command = (command or "").strip()
    if not command:
        return ShellResult(command, None, "empty command", timed_out=False)
    if len(command) > MAX_COMMAND_CHARS:
        return ShellResult(command[:80] + "...", None, f"command too long (max {MAX_COMMAND_CHARS} chars)")
    started = time.monotonic()
    shell_path = shell if os.path.exists(shell) else "/bin/sh"
    try:
        proc = subprocess.Popen(
            [shell_path, "-c", command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(cwd) if cwd else None,
            start_new_session=True,
        )
    except OSError as exc:
        return ShellResult(command, None, f"could not start shell: {exc}")
    try:
        out, _ = proc.communicate(timeout=timeout_s)
        timed_out = False
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_group(proc)
        out, _ = proc.communicate()
    text = (out or b"").decode("utf-8", "replace")
    return ShellResult(
        command=command,
        exit_code=None if timed_out else proc.returncode,
        output=truncate_middle(text),
        timed_out=timed_out,
        duration_s=round(time.monotonic() - started, 2),
    )


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


__all__ = ["ShellResult", "run_shell", "truncate_middle", "MAX_OUTPUT_CHARS"]
