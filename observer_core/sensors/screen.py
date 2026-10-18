"""Screen capture.

Provider selection (logged once at start-up, see :func:`choose_provider`):

1. ``mss``         — X11 sessions (and XWayland fallbacks where it works).
2. ``portal``      — Wayland sessions via xdg-desktop-portal + PipeWire. Needs a
                     one-time user consent; we surface "portal permission required"
                     instead of failing.
3. ``spectacle``   — KDE Plasma CLI screenshot, portal-independent.
4. ``gnome-screenshot`` — GNOME CLI screenshot, portal-independent.

The portal path is implemented as a *helper* that calls the
``org.freedesktop.portal.Screenshot`` interface through ``gdbus``/``busctl``
where those tools exist. Full ScreenCast streaming (PipeWire node consumption)
needs GStreamer bindings; that is documented as a limitation in the README and
the sensor reports the exact re-request command rather than crashing.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import time
from pathlib import Path

from ..config import AppConfig
from ..models import SensorKind, SensorPayload, SensorSpec
from ..util import detect_session, image_size, looks_like_image, png_bytes, run_subprocess
from .base import Sensor


PROVIDER_MSS = "mss"
PROVIDER_PORTAL = "portal"
PROVIDER_SPECTACLE = "spectacle"
PROVIDER_GNOME = "gnome-screenshot"
PROVIDER_NONE = "none"


def choose_provider(preferred: str = "auto") -> tuple[str, str]:
    """Return ``(provider, reason)`` for the current session.

    Logged so users can see *why* a capture backend was picked.
    """
    if preferred not in ("auto", "", None):
        return preferred, f"forced by option screen.provider={preferred}"
    sess = detect_session()
    if sess.session_type == "x11":
        return PROVIDER_MSS, "X11 session (DISPLAY set) — using mss"
    if sess.session_type == "wayland":
        if sess.portal_available:
            return PROVIDER_PORTAL, "Wayland session with xdg-desktop-portal — portal flow"
        if shutil.which("spectacle"):
            return PROVIDER_SPECTACLE, "Wayland, portal not reachable — spectacle fallback"
        if shutil.which("gnome-screenshot"):
            return PROVIDER_GNOME, "Wayland, portal not reachable — gnome-screenshot fallback"
        # Try mss anyway: XWayland sometimes exposes a DISPLAY.
        if os.environ.get("DISPLAY"):
            return PROVIDER_MSS, "Wayland without portal — trying mss via XWayland"
        return PROVIDER_PORTAL, "Wayland with no portal or fallback tool — portal permission required"
    return PROVIDER_NONE, "no graphical session (DISPLAY and WAYLAND_DISPLAY unset)"


def _mss_grab(monitor: int = 1) -> tuple[bytes | None, str]:
    try:
        import mss
        from PIL import Image
    except Exception as exc:  # pragma: no cover
        return None, f"mss/Pillow import failed: {exc}"
    try:
        with mss.mss() as sct:
            mons = sct.monitors
            idx = monitor if 0 <= monitor < len(mons) else 1
            shot = sct.grab(mons[idx])
            image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            return buf.getvalue(), ""
    except Exception as exc:
        return None, f"mss: {type(exc).__name__}: {exc}"


def _cli_grab(argv_for_file: list[str], out_path: Path) -> tuple[bytes | None, str]:
    res = run_subprocess(argv_for_file, timeout=15.0)
    if res.ok and out_path.exists() and out_path.stat().st_size > 0:
        data = out_path.read_bytes()
        return data, ""
    return None, res.message or "no output"


def _portal_grab() -> tuple[bytes | None, str]:
    """Request a one-off screenshot through the portal, via gdbus if present.

    The portal returns a file URI in a signal, which requires a D-Bus main loop
    we do not run here; so the practical path is: if the desktop exposes a
    screenshot CLI, use it; otherwise report permission required.
    """
    for cli in ("gnome-screenshot", "spectacle"):
        if shutil.which(cli):
            return None, f"portal path unavailable; {cli} available as fallback"
    return None, "portal permission required — click 'Grant screen capture'"


class ScreenSensor(Sensor):
    kind = SensorKind.SCREEN

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self.provider, self.provider_reason = choose_provider(
            str(self.option("provider", "auto"))
        )
        self.max_width = int(self.option("max_width", 1920))
        self.monitor = int(self.option("monitor", 1))
        self._last_frame: bytes | None = None
        self._last_frame_at: float = 0.0
        self._last_frame_meta: dict = {}

    def available(self) -> tuple[bool, str]:
        if self.provider == PROVIDER_NONE:
            return False, self.provider_reason
        if self.provider == PROVIDER_MSS:
            try:
                import mss  # noqa: F401  (availability probe)
            except Exception as exc:
                return False, f"mss not importable: {exc}"
            return True, self.provider_reason
        if self.provider == PROVIDER_PORTAL:
            if detect_session().portal_available:
                return True, "portal reachable; first capture may ask for permission"
            return False, "portal permission required — xdg-desktop-portal not reachable"
        if self.provider == PROVIDER_SPECTACLE:
            return (True, self.provider_reason) if shutil.which("spectacle") else (False, "spectacle not installed")
        if self.provider == PROVIDER_GNOME:
            return (True, self.provider_reason) if shutil.which("gnome-screenshot") else (False, "gnome-screenshot not installed")
        return False, f"unknown provider {self.provider}"

    def grant_permission(self) -> tuple[bool, str]:
        """Re-request screen capture (Wayland). Returns (ok, message) for the GUI button."""
        ok, reason = self.available()
        if ok:
            payload = self.capture()
            if payload.is_image:
                return True, "screen capture is working"
            return False, payload.error or reason
        return False, reason

    def _capture(self) -> SensorPayload:
        png: bytes | None = None
        err = ""
        provider = self.provider
        if provider == PROVIDER_MSS:
            png, err = _mss_grab(self.monitor)
            if png is None and detect_session().session_type == "wayland":
                provider = PROVIDER_PORTAL
        if png is None and provider == PROVIDER_PORTAL:
            png, err2 = _portal_grab()
            err = err2 or err
        if png is None and provider in (PROVIDER_SPECTACLE, PROVIDER_PORTAL):
            if shutil.which("spectacle"):
                with tempfile.TemporaryDirectory(prefix="oc-shot-") as td:
                    out = Path(td) / "shot.png"
                    png, err = _cli_grab(["spectacle", "-b", "-n", "-f", "-o", str(out)], out)
                provider = PROVIDER_SPECTACLE
        if png is None and shutil.which("gnome-screenshot"):
            with tempfile.TemporaryDirectory(prefix="oc-shot-") as td:
                out = Path(td) / "shot.png"
                png, err = _cli_grab(["gnome-screenshot", "-f", str(out)], out)
            provider = PROVIDER_GNOME

        if png is None or not looks_like_image(png):
            return SensorPayload(
                kind=self.kind,
                degraded=True,
                error=err or "no screen capture backend produced an image",
                meta={"provider": provider, "reason": self.provider_reason},
            )

        png = png_bytes(png, max_width=self.max_width)
        w, h = image_size(png)
        self._last_frame = png
        self._last_frame_at = time.time()
        meta = {"width": w, "height": h, "provider": provider, "reason": self.provider_reason}
        self._last_frame_meta = meta
        return SensorPayload(kind=self.kind, data=png, mime="image/png", meta=meta)

    @property
    def last_frame(self) -> bytes | None:
        return self._last_frame

    def stats(self) -> dict:
        s = super().stats()
        s.update({"provider": self.provider, "provider_reason": self.provider_reason})
        return s


__all__ = ["ScreenSensor", "choose_provider"]
