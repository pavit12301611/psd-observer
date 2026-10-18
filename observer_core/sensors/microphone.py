"""Microphone + system-audio sensors.

Capture backends, in order of preference:

* ``sounddevice`` (PortAudio) — microphone input. Also works with PipeWire's
  ALSA/Pulse shims.
* ``parec`` (pulseaudio-utils) — monitor source for *system audio* on
  PipeWire-pulse / PulseAudio.
* ``pw-record`` (pipewire-utils) — monitor source fallback.

Transcription is optional: ``faster-whisper`` if importable, else the
``whisper.cpp`` CLI named in ``OBSERVER_WHISPER_CLI``, else we degrade to an
energy level (RMS dBFS) and mark the payload ``degraded`` with a transcript-less
meta. The GUI meter uses the same RMS value.
"""

from __future__ import annotations

import io
import math
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from ..config import AppConfig
from ..models import SensorKind, SensorPayload, SensorSpec
from ..util import run_subprocess
from .base import Sensor


# --------------------------------------------------------------------------- #
# pure helpers (testable without hardware)
# --------------------------------------------------------------------------- #
def pcm16_rms_dbfs(pcm: bytes) -> float:
    """RMS level of little-endian signed 16-bit PCM, in dBFS (-120 .. 0)."""
    n = len(pcm) // 2
    if n == 0:
        return -120.0
    total = 0.0
    step = max(1, n // 4096)  # sub-sample very long buffers for speed
    count = 0
    for i in range(0, n, step):
        sample = struct.unpack_from("<h", pcm, i * 2)[0]
        total += float(sample) * float(sample)
        count += 1
    rms = math.sqrt(total / count) / 32768.0
    if rms <= 1e-6:
        return -120.0
    return max(-120.0, 20.0 * math.log10(rms))


def pcm16_to_wav(pcm: bytes, rate: int = 16000, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def level_meter(dbfs: float) -> float:
    """Map dBFS to a 0..1 meter position (-60 dB .. 0 dB)."""
    return max(0.0, min(1.0, (dbfs + 60.0) / 60.0))


# --------------------------------------------------------------------------- #
# transcription (optional)
# --------------------------------------------------------------------------- #
_WHISPER_MODEL = None


def transcriber_status() -> tuple[bool, str]:
    try:
        import faster_whisper  # noqa: F401  (availability probe)

        return True, "faster-whisper available"
    except Exception:
        pass
    cli = os.environ.get("OBSERVER_WHISPER_CLI") or shutil.which("whisper-cli") or shutil.which("whisper.cpp")
    if cli:
        return True, f"whisper.cpp CLI at {cli}"
    return False, "no transcriber (install faster-whisper or set OBSERVER_WHISPER_CLI) — energy level only"


def transcribe_wav(wav: bytes, model_size: str = "base.en") -> tuple[str, str]:
    """Return ``(transcript, error)``. Empty error and transcript means silence."""
    global _WHISPER_MODEL
    try:
        from faster_whisper import WhisperModel  # type: ignore

        if _WHISPER_MODEL is None:
            _WHISPER_MODEL = WhisperModel(model_size, device="cpu", compute_type="int8")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tf.write(wav)
            path = tf.name
        try:
            segments, _info = _WHISPER_MODEL.transcribe(path, vad_filter=True)
            text = " ".join(seg.text.strip() for seg in segments).strip()
            return text, ""
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
    except ImportError:
        pass
    except Exception as exc:  # pragma: no cover - model download etc.
        return "", f"faster-whisper failed: {exc}"

    cli = os.environ.get("OBSERVER_WHISPER_CLI") or shutil.which("whisper-cli")
    if cli:
        with tempfile.TemporaryDirectory(prefix="oc-whisper-") as td:
            path = Path(td) / "in.wav"
            path.write_bytes(wav)
            res = run_subprocess([cli, "-f", str(path), "-nt"], timeout=120)
            if res.ok:
                return res.stdout.strip(), ""
            return "", f"whisper.cpp failed: {res.message}"
    return "", "no transcriber available"


# --------------------------------------------------------------------------- #
# capture backends
# --------------------------------------------------------------------------- #
def _sounddevice_record(seconds: float, device: str | int | None, rate: int = 16000) -> tuple[bytes, str]:
    try:
        import sounddevice as sd
        import numpy as np
    except Exception as exc:
        return b"", f"sounddevice unavailable: {exc}"
    try:
        frames = int(seconds * rate)
        data = sd.rec(frames, samplerate=rate, channels=1, dtype="int16", device=device, blocking=True)
        return np.asarray(data, dtype="<i2").tobytes(), ""
    except Exception as exc:
        return b"", f"microphone capture failed: {exc}"


def _cli_record(argv: list[str], seconds: float, rate: int = 16000) -> tuple[bytes, str]:
    """Record raw PCM via parec/pw-record for ``seconds`` then stop."""
    binary = argv[0]
    if not shutil.which(binary):
        return b"", f"{binary} not installed"
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, _ = proc.communicate(timeout=seconds + 0.5)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                out, _ = proc.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, _ = proc.communicate()
        return out or b"", ""
    except Exception as exc:
        return b"", f"{binary} failed: {exc}"


def default_monitor_source() -> str | None:
    """Best-effort PulseAudio/PipeWire monitor source name for system audio."""
    if not shutil.which("pactl"):
        return None
    res = run_subprocess(["pactl", "get-default-sink"], timeout=5)
    if res.ok and res.stdout.strip():
        return res.stdout.strip() + ".monitor"
    return None


# --------------------------------------------------------------------------- #
# sensors
# --------------------------------------------------------------------------- #
class MicrophoneSensor(Sensor):
    kind = SensorKind.MICROPHONE

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self.device = self.option("device")  # None = default input
        self.seconds = float(self.option("seconds", config.runtime.audio_clip_s))
        self.rate = int(self.option("rate", 16000))
        self.level_only = bool(self.option("level_only", False))
        self.last_level_dbfs: float = -120.0

    def available(self) -> tuple[bool, str]:
        try:
            import sounddevice as sd

            devices = sd.query_devices()
            inputs = [d for d in devices if d.get("max_input_channels", 0) > 0]
            if not inputs:
                return False, "no microphone input devices found"
            return True, f"{len(inputs)} input device(s); transcription: {transcriber_status()[1]}"
        except Exception as exc:
            return False, f"sounddevice/PortAudio unavailable: {exc} (sudo dnf install portaudio)"

    def _capture(self) -> SensorPayload:
        pcm, err = _sounddevice_record(self.seconds, self.device, self.rate)
        if not pcm:
            return SensorPayload(kind=self.kind, degraded=True, error=err or "no audio data")
        dbfs = pcm16_rms_dbfs(pcm)
        self.last_level_dbfs = dbfs
        meta = {"level_dbfs": round(dbfs, 1), "duration_ms": int(self.seconds * 1000), "rate": self.rate}
        if self.level_only:
            return SensorPayload(kind=self.kind, data=f"microphone level {dbfs:.1f} dBFS", mime="text/plain", meta=meta)
        ok_t, reason_t = transcriber_status()
        if not ok_t:
            meta["transcript"] = None
            return SensorPayload(
                kind=self.kind,
                data=f"[no transcript] mic level {dbfs:.1f} dBFS",
                mime="text/plain",
                meta=meta,
                degraded=True,
                error=reason_t,
            )
        text, terr = transcribe_wav(pcm16_to_wav(pcm, self.rate))
        meta["transcript"] = text
        if terr:
            return SensorPayload(kind=self.kind, data=text, mime="text/plain", meta=meta, degraded=True, error=terr)
        return SensorPayload(kind=self.kind, data=text or "[silence]", mime="text/plain", meta=meta)


class SystemAudioSensor(Sensor):
    """Captures the default sink's monitor (what you hear) via PipeWire/Pulse."""

    kind = SensorKind.SCREEN_AUDIO

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self.source = self.option("source")  # explicit monitor name, else auto
        self.seconds = float(self.option("seconds", config.runtime.audio_clip_s))
        self.rate = int(self.option("rate", 16000))
        self.last_level_dbfs: float = -120.0

    def _source(self) -> str | None:
        return self.source or default_monitor_source()

    def available(self) -> tuple[bool, str]:
        if not (shutil.which("parec") or shutil.which("pw-record")):
            return False, "neither parec nor pw-record found — sudo dnf install pulseaudio-utils pipewire-utils"
        src = self._source()
        if not src:
            return False, "no monitor source found (pactl get-default-sink failed; is PipeWire/Pulse running?)"
        return True, f"monitor source {src}"

    def _capture(self) -> SensorPayload:
        src = self._source()
        if not src:
            return SensorPayload(kind=self.kind, degraded=True, error="no monitor source")
        n_bytes = int(self.seconds * self.rate * 2)
        if shutil.which("parec"):
            argv = ["parec", f"--device={src}", "--format=s16le", f"--rate={self.rate}", "--channels=1", "--raw"]
        else:
            argv = ["pw-record", f"--target={src}", "--format=s16", f"--rate={self.rate}", "--channels=1", "-"]
        pcm, err = _cli_record(argv, self.seconds, self.rate)
        pcm = pcm[:n_bytes]
        if not pcm:
            return SensorPayload(kind=self.kind, degraded=True, error=err or "no system audio captured")
        dbfs = pcm16_rms_dbfs(pcm)
        self.last_level_dbfs = dbfs
        meta = {"level_dbfs": round(dbfs, 1), "source": src, "duration_ms": int(self.seconds * 1000)}
        ok_t, reason_t = transcriber_status()
        if not ok_t:
            return SensorPayload(
                kind=self.kind,
                data=f"[no transcript] system audio level {dbfs:.1f} dBFS",
                mime="text/plain",
                meta=meta,
                degraded=True,
                error=reason_t,
            )
        text, terr = transcribe_wav(pcm16_to_wav(pcm, self.rate))
        meta["transcript"] = text
        return SensorPayload(kind=self.kind, data=text or "[silence]", mime="text/plain", meta=meta,
                             degraded=bool(terr), error=terr or None)


class AllAudioSensor(Sensor):
    """Mixed mic + system-audio transcript. Degrades to whichever half works."""

    kind = SensorKind.ALL_AUDIO

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self._mic = MicrophoneSensor(SensorSpec(kind=SensorKind.MICROPHONE, options=dict(spec.options)), config)
        self._sys = SystemAudioSensor(SensorSpec(kind=SensorKind.SCREEN_AUDIO, options=dict(spec.options)), config)

    def available(self) -> tuple[bool, str]:
        m_ok, m_reason = self._mic.available()
        s_ok, s_reason = self._sys.available()
        if m_ok and s_ok:
            return True, "mic + system audio"
        if m_ok or s_ok:
            return True, f"partial: mic={'ok' if m_ok else m_reason}; system={'ok' if s_ok else s_reason}"
        return False, f"mic: {m_reason}; system: {s_reason}"

    def _capture(self) -> SensorPayload:
        parts: list[str] = []
        errors: list[str] = []
        for sub in (self._mic, self._sys):
            p = sub.capture()
            if p.text and not p.error:
                parts.append(f"[{sub.kind.value}] {p.text}")
            elif p.text:
                parts.append(f"[{sub.kind.value}] {p.text}")
                errors.append(p.error or "")
            else:
                errors.append(p.error or "no data")
        if not parts:
            return SensorPayload(kind=self.kind, degraded=True, error="; ".join(e for e in errors if e))
        return SensorPayload(kind=self.kind, data="\n".join(parts), mime="text/plain",
                             degraded=bool(errors), error="; ".join(e for e in errors if e) or None)


__all__ = [
    "MicrophoneSensor",
    "SystemAudioSensor",
    "AllAudioSensor",
    "pcm16_rms_dbfs",
    "pcm16_to_wav",
    "level_meter",
    "transcriber_status",
    "transcribe_wav",
]
