"""Camera sensor via OpenCV (V4L2 backend on Linux).

* ``options.device`` — integer index (default 0) or ``/dev/videoN`` path.
* Device enumeration scans ``/dev/video*`` without opening devices, so the
  doctor command never grabs the camera LED unnecessarily.
* The capture handle is opened lazily and kept open between cycles; it is
  released in :meth:`stop`.
"""

from __future__ import annotations

import glob
import os
import threading
import time

from ..config import AppConfig
from ..models import SensorKind, SensorPayload, SensorSpec
from ..util import jpeg_bytes
from .base import Sensor


def list_video_devices() -> list[str]:
    return sorted(glob.glob("/dev/video*"), key=lambda p: (len(p), p))


def _cv2():
    import cv2  # opencv-python-headless

    return cv2


class CameraSensor(Sensor):
    kind = SensorKind.CAMERA

    def __init__(self, spec: SensorSpec, config: AppConfig) -> None:
        super().__init__(spec, config)
        self.device = self.option("device", 0)
        self.width = int(self.option("width", 1280))
        self.height = int(self.option("height", 720))
        self._cap = None
        self._lock = threading.Lock()
        self._opened_at: float | None = None

    def _resolve_device(self):
        dev = self.device
        if isinstance(dev, str) and dev.isdigit():
            return int(dev)
        return dev

    def available(self) -> tuple[bool, str]:
        try:
            _cv2()
        except Exception as exc:
            return False, f"OpenCV not importable: {exc}"
        devices = list_video_devices()
        if not devices:
            return False, "no /dev/video* devices — no camera attached (or not in the 'video' group)"
        if isinstance(self._resolve_device(), int):
            idx = int(self._resolve_device())
            if f"/dev/video{idx}" not in devices:
                return False, f"camera index {idx} not present; available: {', '.join(devices)}"
        if not os.access("/dev/video0", os.R_OK | os.W_OK) and devices:
            return False, "no permission for camera device — add your user to the 'video' group"
        return True, f"devices: {', '.join(devices)}"

    def start(self) -> None:
        super().start()

    def _open(self):
        if self._cap is not None and self._cap.isOpened():
            return self._cap
        cv2 = _cv2()
        cap = cv2.VideoCapture(self._resolve_device(), cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"could not open camera {self.device!r}")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self._cap = cap
        self._opened_at = time.time()
        return cap

    def stop(self) -> None:
        with self._lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
        super().stop()

    def _capture(self) -> SensorPayload:
        with self._lock:
            cap = self._open()
            # Drain the V4L2 buffer so we get a fresh frame, not a stale one.
            ok, frame = cap.read()
            if not ok or frame is None:
                self._cap.release()
                self._cap = None
                return SensorPayload(kind=self.kind, degraded=True, error="camera returned no frame")
            cv2 = _cv2()
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
            if not ok:
                return SensorPayload(kind=self.kind, degraded=True, error="JPEG encode failed")
            data = jpeg_bytes(buf.tobytes(), max_width=1280)
            h, w = frame.shape[:2]
            return SensorPayload(
                kind=self.kind,
                data=data,
                mime="image/jpeg",
                meta={"width": w, "height": h, "device": str(self.device)},
            )


__all__ = ["CameraSensor", "list_video_devices"]
