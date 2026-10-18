"""Sensor ABC + shared helpers.

Design rules:

* ``capture()`` must never raise. Any failure becomes a
  ``SensorPayload(degraded=True, error=...)`` so the loop keeps running.
* ``available()`` returns ``(ok, human_readable_reason)`` and is what
  ``observer-core doctor`` and the GUI status pills call.
* Long-lived resources (camera handles, audio streams) are opened in
  :meth:`Sensor.start` and released in :meth:`Sensor.stop`.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from abc import ABC, abstractmethod
from typing import Any

from ..config import AppConfig
from ..models import SensorKind, SensorPayload, SensorSpec
from ..util import run_subprocess


class SensorStatus:
    OK = "ok"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


class Sensor(ABC):
    """Base class for every sensor."""

    kind: SensorKind = SensorKind.SCREEN

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        self.spec = spec
        self.config = config
        self._started = False
        self._last_error: str | None = None
        self._capture_count = 0
        self._started_at: float | None = None

    # ------------------------------------------------------------------ #
    # lifecycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        """Open long-lived resources. Default implementation is a no-op."""
        self._started = True
        self._started_at = time.time()

    def stop(self) -> None:
        """Release long-lived resources. Default implementation is a no-op."""
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    # ------------------------------------------------------------------ #
    # diagnostics
    # ------------------------------------------------------------------ #
    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """Return ``(ok, reason)``. ``reason`` must be actionable."""

    @property
    def token(self) -> str:
        return self.kind.token

    def option(self, name: str, default: Any = None) -> Any:
        return self.spec.options.get(name, default)

    # ------------------------------------------------------------------ #
    # capture
    # ------------------------------------------------------------------ #
    @abstractmethod
    def _capture(self) -> SensorPayload:
        """Sensor-specific capture. May raise; :meth:`capture` guards it."""

    def capture(self) -> SensorPayload:
        """Guarded capture — never raises, never returns ``None``."""
        if not self.spec.enabled:
            return SensorPayload(
                kind=self.kind,
                degraded=True,
                error="sensor disabled",
                captured_at=time.time(),
            )
        try:
            payload = self._capture()
            payload.captured_at = payload.captured_at or time.time()
            payload.kind = payload.kind or self.kind
            self._capture_count += 1
            self._last_error = payload.error
            return payload
        except Exception as exc:  # noqa: BLE001 - sensors must never crash the loop
            self._last_error = f"{type(exc).__name__}: {exc}"
            return SensorPayload(
                kind=self.kind,
                degraded=True,
                error=self._last_error,
                captured_at=time.time(),
            )

    @property
    def last_error(self) -> str | None:
        return self._last_error

    @property
    def capture_count(self) -> int:
        return self._capture_count

    def stats(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "enabled": self.spec.enabled,
            "captures": self._capture_count,
            "last_error": self._last_error,
            "options": dict(self.spec.options),
        }


# --------------------------------------------------------------------------- #
# shared helpers used by several sensors
# --------------------------------------------------------------------------- #
def which(binary: str) -> str | None:
    return shutil.which(binary)


def binary_available(binary: str) -> tuple[bool, str]:
    path = shutil.which(binary)
    if path:
        return True, path
    return False, f"`{binary}` not found in PATH"


def run_capture_command(argv: list[str], timeout: float = 10.0) -> tuple[bool, bytes, str]:
    """Run a screenshot-ish subprocess, returning ``(ok, stdout_bytes, message)``."""
    result = run_subprocess(argv, timeout=timeout, capture_binary=True)
    if result.ok and result.stdout_bytes:
        return True, result.stdout_bytes, ""
    return False, b"", result.error or "no output"


def capture_with_fallbacks(candidates: list[list[str]], timeout: float = 10.0) -> tuple[bytes | None, list[str]]:
    """Try each command in order; return the first successful image plus a trail."""
    trail: list[str] = []
    for argv in candidates:
        if not argv or not shutil.which(argv[0]):
            trail.append(f"{argv[0] if argv else '?'}: not installed")
            continue
        ok, data, msg = run_capture_command(argv, timeout=timeout)
        if ok and data:
            trail.append(f"{argv[0]}: ok ({len(data)} bytes)")
            return data, trail
        trail.append(f"{argv[0]}: {msg}")
    return None, trail


def subprocess_run(argv: list[str], timeout: float = 10.0, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


__all__ = [
    "Sensor",
    "SensorStatus",
    "which",
    "binary_available",
    "capture_with_fallbacks",
    "run_capture_command",
    "subprocess_run",
]
