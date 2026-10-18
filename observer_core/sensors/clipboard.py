"""Clipboard sensor: wl-paste (Wayland) → xclip/xsel (X11) → Qt (if running in GUI).

Clipboard contents are text-only here; images are ignored. Output is passed
through the configured redaction patterns before it reaches a model.
"""

from __future__ import annotations

import os
import re
import shutil

from ..models import SensorKind, SensorPayload
from ..util import detect_session, run_subprocess
from .base import Sensor

MAX_CHARS = 8000


def _backend_candidates() -> list[list[str]]:
    sess = detect_session()
    cands: list[list[str]] = []
    if sess.session_type == "wayland":
        cands.append(["wl-paste", "--no-newline", "--type", "text/plain"])
    if sess.session_type in ("x11", "wayland") and os.environ.get("DISPLAY"):
        cands.append(["xclip", "-selection", "clipboard", "-o"])
        cands.append(["xsel", "--clipboard", "--output"])
    cands.append(["wl-paste", "--no-newline", "--type", "text/plain"])
    # de-dupe while keeping order
    seen: set[str] = set()
    out: list[list[str]] = []
    for c in cands:
        if c[0] not in seen:
            seen.add(c[0])
            out.append(c)
    return out


def redact_text(text: str, patterns: list[str]) -> str:
    for pat in patterns:
        try:
            text = re.sub(pat, "[redacted]", text)
        except re.error:
            continue
    return text


def read_clipboard_text() -> tuple[str | None, str]:
    trail = []
    for argv in _backend_candidates():
        if not shutil.which(argv[0]):
            trail.append(f"{argv[0]} missing")
            continue
        res = run_subprocess(argv, timeout=3)
        if res.ok:
            return res.stdout, ""
        # wl-paste exits non-zero on empty clipboard; treat as empty, not as error.
        if argv[0] == "wl-paste" and "No selection" in (res.stderr or ""):
            return "", ""
        trail.append(f"{argv[0]}: {res.message}")
    return None, "; ".join(trail) or "no clipboard tool (sudo dnf install wl-clipboard xsel xclip)"


class ClipboardSensor(Sensor):
    kind = SensorKind.CLIPBOARD

    def available(self) -> tuple[bool, str]:
        for argv in _backend_candidates():
            if shutil.which(argv[0]):
                return True, f"via {argv[0]}"
        return False, "no clipboard tool — sudo dnf install wl-clipboard xsel xclip"

    def _capture(self) -> SensorPayload:
        text, err = read_clipboard_text()
        if text is None:
            return SensorPayload(kind=self.kind, degraded=True, error=err)
        text = redact_text(text, list(self.config.privacy.redact_patterns))
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS] + "…"
        return SensorPayload(kind=self.kind, data=text, mime="text/plain", meta={"chars": len(text)})


__all__ = ["ClipboardSensor", "read_clipboard_text", "redact_text"]
