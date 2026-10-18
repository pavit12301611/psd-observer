"""Sensor layer: provider choice, audio maths, graceful degradation, shared capture cache."""

import math
import struct

from observer_core.config import AppConfig
from observer_core.models import SensorKind, SensorPayload, SensorSpec
from observer_core.sensors.base import Sensor
from observer_core.sensors.microphone import level_meter, pcm16_rms_dbfs, pcm16_to_wav
from observer_core.sensors.registry import SensorRegistry
from observer_core.sensors.screen import (PROVIDER_MSS, PROVIDER_NONE, PROVIDER_PORTAL, ScreenSensor,
                                          choose_provider)

from .fakes import FakeSensor


def test_capture_never_raises_even_if_subclass_explodes():
    class Boom(Sensor):
        kind = SensorKind.CAMERA

        def available(self):
            return True, "ok"

        def _capture(self):
            raise OSError("device vanished")

    p = Boom(SensorSpec(kind=SensorKind.CAMERA), AppConfig()).capture()
    assert isinstance(p, SensorPayload)
    assert p.degraded and "device vanished" in p.error


def test_disabled_sensor_reports_disabled():
    s = FakeSensor(SensorKind.SCREEN)
    s.spec.enabled = False
    p = s.capture()
    assert p.degraded and p.error == "sensor disabled"


def test_choose_provider_by_session(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    prov, reason = choose_provider("auto")
    assert prov == PROVIDER_MSS and "X11" in reason

    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")
    monkeypatch.setattr("observer_core.sensors.screen.detect_session",
                        lambda: type("S", (), {"session_type": "wayland", "portal_available": True})())
    prov, reason = choose_provider("auto")
    assert prov == PROVIDER_PORTAL and "portal" in reason.lower()


def test_choose_provider_headless(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    prov, reason = choose_provider("auto")
    assert prov == PROVIDER_NONE and "no graphical session" in reason


def test_forced_provider_wins():
    assert choose_provider("spectacle")[0] == "spectacle"


def test_screen_sensor_degrades_gracefully_headless(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    s = ScreenSensor(SensorSpec(kind=SensorKind.SCREEN), AppConfig())
    ok, reason = s.available()
    assert ok is False and reason
    p = s.capture()             # must not raise
    assert p.degraded and p.error


def test_pcm_rms_silence_and_full_scale():
    assert pcm16_rms_dbfs(b"") == -120.0
    assert pcm16_rms_dbfs(b"\x00\x00" * 100) == -120.0
    full = struct.pack("<h", 32767) * 1000
    assert pcm16_rms_dbfs(full) > -0.1
    half = struct.pack("<h", 16384) * 1000
    assert math.isclose(pcm16_rms_dbfs(half), 20 * math.log10(0.5), abs_tol=0.05)


def test_level_meter_clamped():
    assert level_meter(-120) == 0.0
    assert level_meter(0) == 1.0
    assert 0 < level_meter(-30) < 1


def test_pcm_to_wav_header():
    wav = pcm16_to_wav(b"\x00\x00" * 160, rate=16000)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"


def test_registry_caches_across_agents_within_ttl():
    cfg = AppConfig()
    cfg.runtime.sensor_cache_ttl_s = 10
    now = {"t": 0.0}
    reg = SensorRegistry(cfg, clock=lambda: now["t"])
    reg.configure([SensorSpec(kind=SensorKind.SCREEN)])
    fake = FakeSensor(SensorKind.SCREEN, config=cfg)
    reg._sensors[SensorKind.SCREEN] = fake
    a = reg.capture(SensorKind.SCREEN)
    b = reg.capture(SensorKind.SCREEN)       # second agent, same window
    assert fake.calls == 1 and a is b
    assert reg.cache_hits == 1 and reg.cache_misses == 1
    now["t"] = 11.0
    reg.capture(SensorKind.SCREEN)           # window expired
    assert fake.calls == 2


def test_registry_diagnostics_list_every_kind():
    reg = SensorRegistry(AppConfig())
    diags = reg.diagnostics()
    assert {d.name for d in diags} == {k.value for k in SensorKind}
    assert all(d.area == "sensor" for d in diags)


def test_fake_sensor_degraded_path_is_reported():
    s = FakeSensor(SensorKind.CAMERA, fail_with="no frame")
    p = s.capture()
    assert p.degraded and p.error == "no frame" and not p.is_image
