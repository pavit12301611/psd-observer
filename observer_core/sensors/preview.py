"""Preview bridge: sensor payloads -> Qt widgets, throttled and downscaled.

Imported lazily so the sensor layer (and the headless tests) never need Qt.
Rules from the spec: <= 5 FPS, <= 640 px wide.
"""

from __future__ import annotations

import io
import time

from ..models import SensorPayload


def downscale_png(data: bytes, max_width: int = 640) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(data))
    if image.mode not in ("RGB", "RGBA", "L"):
        image = image.convert("RGB")
    if image.width > max_width:
        ratio = max_width / float(image.width)
        image = image.resize((max_width, max(1, int(image.height * ratio))))
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


class PreviewThrottle:
    """Allows at most ``fps`` updates per second."""

    def __init__(self, fps: float = 5.0, clock=time.monotonic) -> None:
        self.min_interval = 1.0 / max(0.1, min(5.0, fps))  # hard cap at 5 FPS
        self._clock = clock
        self._last = 0.0

    def ready(self) -> bool:
        now = self._clock()
        if now - self._last >= self.min_interval:
            self._last = now
            return True
        return False


def payload_to_qimage(payload: SensorPayload, max_width: int = 640):
    """Convert an image payload into a ``QImage``. Requires PyQt6 (lazy import)."""
    from PyQt6.QtGui import QImage  # type: ignore

    if not payload.is_image:
        return None
    png = downscale_png(payload.data, max_width=max_width)  # type: ignore[arg-type]
    img = QImage.fromData(png, "PNG")
    return img if not img.isNull() else None


__all__ = ["downscale_png", "PreviewThrottle", "payload_to_qimage"]
