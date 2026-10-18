"""Sensor registry: builds sensor instances and shares captures across agents.

Captures are cached per sensor kind for ``runtime.sensor_cache_ttl_s`` seconds,
so five agents that all watch the screen trigger one screenshot, not five.
"""

from __future__ import annotations

import threading
import time
from typing import Callable

from ..config import AppConfig
from ..models import Diagnostic, SensorKind, SensorPayload, SensorSpec
from .base import Sensor
from .camera import CameraSensor
from .clipboard import ClipboardSensor
from .microphone import AllAudioSensor, MicrophoneSensor, SystemAudioSensor
from .screen import ScreenSensor
from .screen_ocr import ScreenOcrSensor

SENSOR_CLASSES: dict[SensorKind, type[Sensor]] = {
    SensorKind.SCREEN: ScreenSensor,
    SensorKind.SCREEN_OCR: ScreenOcrSensor,
    SensorKind.CAMERA: CameraSensor,
    SensorKind.CLIPBOARD: ClipboardSensor,
    SensorKind.MICROPHONE: MicrophoneSensor,
    SensorKind.SCREEN_AUDIO: SystemAudioSensor,
    SensorKind.ALL_AUDIO: AllAudioSensor,
}


def default_spec(kind: SensorKind) -> SensorSpec:
    return SensorSpec(kind=kind, enabled=True)


class SensorRegistry:
    """One instance per kind, shared by every agent in the process."""

    def __init__(self, config: AppConfig, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.config = config
        self._clock = clock
        self._sensors: dict[SensorKind, Sensor] = {}
        self._cache: dict[SensorKind, tuple[float, SensorPayload]] = {}
        self._lock = threading.Lock()
        self._specs: dict[SensorKind, SensorSpec] = {}
        self.cache_hits = 0
        self.cache_misses = 0

    # ------------------------------------------------------------------ #
    def configure(self, specs: list[SensorSpec]) -> None:
        """(Re)build sensors from specs, stopping ones that were removed."""
        with self._lock:
            wanted = {s.kind for s in specs}
            for kind in list(self._sensors):
                if kind not in wanted:
                    self._sensors.pop(kind).stop()
                    self._cache.pop(kind, None)
            for spec in specs:
                self._specs[spec.kind] = spec
                existing = self._sensors.get(spec.kind)
                if existing is None:
                    self._sensors[spec.kind] = SENSOR_CLASSES[spec.kind](spec, self.config)
                else:
                    existing.spec = spec

    def get(self, kind: SensorKind) -> Sensor:
        with self._lock:
            if kind not in self._sensors:
                spec = self._specs.get(kind) or default_spec(kind)
                self._sensors[kind] = SENSOR_CLASSES[kind](spec, self.config)
            return self._sensors[kind]

    def all(self) -> list[Sensor]:
        with self._lock:
            return list(self._sensors.values())

    def start_all(self) -> None:
        for s in self.all():
            if s.spec.enabled:
                try:
                    s.start()
                except Exception:  # pragma: no cover - start must not crash the app
                    pass

    def stop_all(self) -> None:
        for s in self.all():
            try:
                s.stop()
            except Exception:  # pragma: no cover
                pass

    # ------------------------------------------------------------------ #
    def capture(self, kind: SensorKind, *, max_age_s: float | None = None) -> SensorPayload:
        """Capture ``kind``, reusing a cached payload if it is fresh enough."""
        ttl = self.config.runtime.sensor_cache_ttl_s if max_age_s is None else max_age_s
        now = self._clock()
        with self._lock:
            cached = self._cache.get(kind)
            if cached and (now - cached[0]) <= ttl:
                self.cache_hits += 1
                return cached[1]
        payload = self.get(kind).capture()
        with self._lock:
            self._cache[kind] = (self._clock(), payload)
            self.cache_misses += 1
        return payload

    def invalidate(self, kind: SensorKind | None = None) -> None:
        with self._lock:
            if kind is None:
                self._cache.clear()
            else:
                self._cache.pop(kind, None)

    # ------------------------------------------------------------------ #
    def diagnostics(self, kinds: list[SensorKind] | None = None) -> list[Diagnostic]:
        out: list[Diagnostic] = []
        for kind in kinds or list(SensorKind):
            sensor = self.get(kind)
            try:
                ok, reason = sensor.available()
            except Exception as exc:  # pragma: no cover
                ok, reason = False, f"probe failed: {exc}"
            status = "ok" if ok else "unavailable"
            out.append(
                Diagnostic(
                    area="sensor",
                    name=kind.value,
                    ok=ok,
                    status=status,  # type: ignore[arg-type]
                    detail=reason,
                    hint="" if ok else _hint_for(kind),
                )
            )
        return out


_HINTS = {
    SensorKind.SCREEN: "On Wayland, click 'Grant screen capture' to approve the desktop portal; on X11 install mss deps.",
    SensorKind.SCREEN_OCR: "sudo dnf install tesseract tesseract-langpack-eng",
    SensorKind.CAMERA: "Plug in a camera and add your user to the 'video' group.",
    SensorKind.CLIPBOARD: "sudo dnf install wl-clipboard xsel xclip",
    SensorKind.MICROPHONE: "sudo dnf install portaudio portaudio-devel; check PipeWire input device.",
    SensorKind.SCREEN_AUDIO: "sudo dnf install pulseaudio-utils pipewire-utils; start PipeWire.",
    SensorKind.ALL_AUDIO: "Needs both a microphone and a PipeWire monitor source.",
}


def _hint_for(kind: SensorKind) -> str:
    return _HINTS.get(kind, "")


__all__ = ["SensorRegistry", "SENSOR_CLASSES", "default_spec"]
