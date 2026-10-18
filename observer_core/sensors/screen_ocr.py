"""OCR sensor: screen capture -> tesseract -> text.

Tesseract is located automatically (PATH, then ``/usr/bin/tesseract``). The
language comes from ``options.lang``, then the ``OCR_LANG`` env var, then ``eng``.
If tesseract or its language pack is missing the sensor reports itself as
unavailable with the dnf command to fix it.
"""

from __future__ import annotations

import io
import os
import shutil
from functools import lru_cache

from ..config import AppConfig
from ..models import SensorKind, SensorPayload, SensorSpec
from ..util import run_subprocess
from .base import Sensor
from .screen import ScreenSensor


@lru_cache(maxsize=1)
def tesseract_binary() -> str | None:
    found = shutil.which("tesseract")
    if found:
        return found
    if os.path.exists("/usr/bin/tesseract"):
        return "/usr/bin/tesseract"
    return None


def tesseract_languages() -> list[str]:
    binary = tesseract_binary()
    if not binary:
        return []
    res = run_subprocess([binary, "--list-langs"], timeout=10)
    if not res.ok:
        return []
    langs = [line.strip() for line in (res.stdout or res.stderr).splitlines()[1:] if line.strip()]
    return langs


def ocr_text(png: bytes, lang: str = "eng", psm: int = 6, timeout: float = 30.0) -> tuple[str, str]:
    """Run tesseract on PNG bytes. Returns ``(text, error)``."""
    binary = tesseract_binary()
    if not binary:
        return "", "tesseract not installed (sudo dnf install tesseract tesseract-langpack-eng)"
    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = binary
        from PIL import Image

        image = Image.open(io.BytesIO(png))
        text = pytesseract.image_to_string(image, lang=lang, config=f"--psm {psm}", timeout=timeout)
        return text.strip(), ""
    except Exception as exc:
        # pytesseract missing or language pack missing — fall back to the CLI.
        res = run_subprocess(
            [binary, "stdin", "stdout", "-l", lang, "--psm", str(psm)],
            timeout=timeout,
            stdin=png,
        )
        if res.ok:
            return res.stdout.strip(), ""
        return "", f"tesseract failed ({type(exc).__name__}): {res.message}"


class ScreenOcrSensor(Sensor):
    kind = SensorKind.SCREEN_OCR

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self.lang = str(self.option("lang") or os.environ.get("OCR_LANG") or "eng")
        self.psm = int(self.option("psm", 6))
        self.roi = self.option("roi")  # [x, y, w, h] or None
        self._screen = ScreenSensor(SensorSpec(kind=SensorKind.SCREEN, options={}), config)

    def available(self) -> tuple[bool, str]:
        if not tesseract_binary():
            return False, "tesseract not installed — sudo dnf install tesseract tesseract-langpack-eng"
        langs = tesseract_languages()
        if langs and self.lang.split("+")[0] not in langs:
            return False, f"language '{self.lang}' not installed — sudo dnf install tesseract-langpack-{self.lang.split('+')[0]}"
        ok, reason = self._screen.available()
        if not ok:
            return False, f"screen unavailable: {reason}"
        return True, f"tesseract at {tesseract_binary()} (lang={self.lang})"

    def _capture(self) -> SensorPayload:
        frame = self._screen.capture()
        if not frame.is_image:
            return SensorPayload(kind=self.kind, degraded=True, error=f"screen: {frame.error}")
        png = frame.data
        if self.roi and isinstance(self.roi, (list, tuple)) and len(self.roi) == 4:
            png = _crop(png, self.roi)
        text, err = ocr_text(png, lang=self.lang, psm=self.psm)
        if err:
            return SensorPayload(kind=self.kind, degraded=True, error=err, data="", mime="text/plain")
        return SensorPayload(
            kind=self.kind,
            data=text,
            mime="text/plain",
            meta={"lang": self.lang, "chars": len(text)},
        )


def _crop(png: bytes, roi: list | tuple) -> bytes:
    try:
        from PIL import Image

        x, y, w, h = (int(v) for v in roi)
        image = Image.open(io.BytesIO(png))
        image = image.crop((x, y, x + w, y + h))
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()
    except Exception:
        return png


__all__ = ["ScreenOcrSensor", "ocr_text", "tesseract_binary", "tesseract_languages"]
