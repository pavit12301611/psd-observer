"""Persistent timers for routines: "run home in 5 minutes".

Stored as JSON in the state directory with mode 0600, written atomically (temp file +
rename) so a crash cannot leave a half-written file. Timers survive a restart. A timer
whose time passed while Observer was not running is handled by the scheduler (skipped
with a notice when it is too late), not silently dropped.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

MAX_DELAY_MIN = 12 * 60   # 12 hours is plenty for "I'm coming home"


@dataclass(frozen=True)
class Timer:
    id: int
    routine: str
    fire_at: float
    created_at: float


class TimerStore:
    def __init__(self, path: Path, *, clock=time.time) -> None:
        self.path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()
        self._timers: dict[int, Timer] = {}
        self._next_id = 1
        self._load()

    # ------------------------------------------------------------------ #
    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            # A damaged file must not stop the agent. Keep it aside for inspection.
            self.path.replace(self.path.with_suffix(".corrupt"))
            return
        for item in raw.get("timers", []):
            try:
                timer = Timer(int(item["id"]), str(item["routine"]), float(item["fire_at"]),
                              float(item["created_at"]))
            except (KeyError, TypeError, ValueError):
                continue
            self._timers[timer.id] = timer
        self._next_id = max([int(raw.get("next_id", 1))] + [t.id + 1 for t in self._timers.values()])

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.path.parent, 0o700)
        except OSError:  # pragma: no cover
            pass
        payload = {"next_id": self._next_id, "timers": [asdict(t) for t in self.list()]}
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, self.path)
        os.chmod(self.path, 0o600)

    # ------------------------------------------------------------------ #
    def add(self, routine: str, *, fire_at: float, now: float | None = None) -> Timer:
        with self._lock:
            now = self._clock() if now is None else now
            timer = Timer(self._next_id, routine, fire_at, now)
            self._timers[timer.id] = timer
            self._next_id += 1
            self._save()
            return timer

    def list(self) -> list[Timer]:
        return sorted(self._timers.values(), key=lambda t: (t.fire_at, t.id))

    def cancel(self, timer_id: int) -> bool:
        with self._lock:
            if timer_id not in self._timers:
                return False
            del self._timers[timer_id]
            self._save()
            return True

    def pop_due(self, now: float) -> list[Timer]:
        """Remove and return every timer whose time has come."""
        with self._lock:
            due = [t for t in self._timers.values() if t.fire_at <= now]
            if due:
                for t in due:
                    del self._timers[t.id]
                self._save()
            return sorted(due, key=lambda t: t.fire_at)


__all__ = ["Timer", "TimerStore", "MAX_DELAY_MIN"]
