"""Hardware-dependent sensors: they must report availability honestly on any machine."""

from observer_core.config import AppConfig
from observer_core.models import SensorKind, SensorSpec
from observer_core.sensors.camera import CameraSensor, list_video_devices
from observer_core.sensors.clipboard import ClipboardSensor, redact_text
from observer_core.sensors.microphone import (AllAudioSensor, MicrophoneSensor, SystemAudioSensor,
                                              transcriber_status)
from observer_core.sensors.screen_ocr import ScreenOcrSensor, tesseract_binary


def test_camera_unavailable_without_devices(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.camera.list_video_devices", lambda: [])
    ok, reason = CameraSensor(SensorSpec(kind=SensorKind.CAMERA), AppConfig()).available()
    assert ok is False and "no /dev/video" in reason


def test_camera_capture_degrades_not_crashes(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.camera.list_video_devices", lambda: [])
    p = CameraSensor(SensorSpec(kind=SensorKind.CAMERA, options={"device": 9}), AppConfig()).capture()
    assert p.degraded and p.error


def test_list_video_devices_is_a_list():
    assert isinstance(list_video_devices(), list)


def test_ocr_reports_missing_tesseract(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.screen_ocr.tesseract_binary", lambda: None)
    ok, reason = ScreenOcrSensor(SensorSpec(kind=SensorKind.SCREEN_OCR), AppConfig()).available()
    assert ok is False and "dnf install tesseract" in reason


def test_ocr_capture_degrades_without_tesseract(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.screen_ocr.tesseract_binary", lambda: None)
    s = ScreenOcrSensor(SensorSpec(kind=SensorKind.SCREEN_OCR), AppConfig())
    p = s.capture()
    assert p.degraded and p.error


def test_ocr_lang_from_env(monkeypatch):
    monkeypatch.setenv("OCR_LANG", "deu")
    assert ScreenOcrSensor(SensorSpec(kind=SensorKind.SCREEN_OCR), AppConfig()).lang == "deu"


def test_tesseract_binary_is_str_or_none():
    assert tesseract_binary() is None or isinstance(tesseract_binary(), str)


def test_microphone_unavailable_message_is_actionable(monkeypatch):
    import sys
    import types

    fake = types.SimpleNamespace(query_devices=lambda: (_ for _ in ()).throw(OSError("PortAudio library not found")))
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    ok, reason = MicrophoneSensor(SensorSpec(kind=SensorKind.MICROPHONE), AppConfig()).available()
    assert ok is False and "portaudio" in reason.lower()


def test_system_audio_unavailable_without_tools(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.microphone.shutil.which", lambda name: None)
    ok, reason = SystemAudioSensor(SensorSpec(kind=SensorKind.SCREEN_AUDIO), AppConfig()).available()
    assert ok is False and "pulseaudio-utils" in reason


def test_all_audio_capture_degrades_not_raises(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.microphone.shutil.which", lambda name: None)
    p = AllAudioSensor(SensorSpec(kind=SensorKind.ALL_AUDIO), AppConfig()).capture()
    assert p.degraded and p.error


def test_transcriber_status_reports_something():
    ok, msg = transcriber_status()
    assert isinstance(ok, bool) and msg


def test_clipboard_redaction():
    assert redact_text("my key is SECRET-123", [r"SECRET-\d+"]) == "my key is [redacted]"
    assert redact_text("unchanged", ["(["]) == "unchanged"  # bad regex is ignored


def test_clipboard_unavailable_without_tools(monkeypatch):
    monkeypatch.setattr("observer_core.sensors.clipboard.shutil.which", lambda name: None)
    ok, reason = ClipboardSensor(SensorSpec(kind=SensorKind.CLIPBOARD), AppConfig()).available()
    assert ok is False and "wl-clipboard" in reason
