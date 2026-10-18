"""Sensor Control: one row per sensor kind with status, live preview / level meter, options, actions."""

from __future__ import annotations

import time

from PyQt6.QtCore import QRunnable, Qt, QThreadPool, QTimer
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import (QCheckBox, QFrame, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit,
                             QProgressBar, QPushButton, QVBoxLayout)

from ..models import SensorKind, SensorPayload, SensorSpec
from ..sensors.microphone import level_meter
from ..sensors.preview import PreviewThrottle, downscale_png
from .bridge import Bridge
from .theme import MUTED, icon, pill_style

IMAGE_KINDS = (SensorKind.SCREEN, SensorKind.CAMERA)
METER_KINDS = (SensorKind.MICROPHONE, SensorKind.SCREEN_AUDIO)
AUDIO_POLL_S = 3.0      # audio captures record for a few seconds; poll slowly
OPTION_HINTS = {
    SensorKind.CAMERA: ("device index", "0"),
    SensorKind.SCREEN_OCR: ("OCR language", "eng"),
    SensorKind.MICROPHONE: ("device", "default"),
    SensorKind.SCREEN_AUDIO: ("monitor source", "default"),
    SensorKind.ALL_AUDIO: ("source", "default"),
}


def _spec_from_option(kind: SensorKind, raw: str) -> SensorSpec:
    raw = (raw or "").strip()
    opts: dict = {}
    if raw:
        if kind == SensorKind.CAMERA:
            opts["device"] = int(raw) if raw.isdigit() else raw
        elif kind == SensorKind.SCREEN_OCR:
            opts["lang"] = raw
        elif raw != "default":
            opts["source" if kind != SensorKind.MICROPHONE else "device"] = raw
    return SensorSpec(kind=kind, enabled=True, options=opts)


class _CaptureJob(QRunnable):
    """Runs one registry capture on the thread pool and reports via the bridge."""

    def __init__(self, registry, kind: SensorKind, bridge: Bridge, max_age: float) -> None:
        super().__init__()
        self.registry, self.kind, self.bridge, self.max_age = registry, kind, bridge, max_age
        self.setAutoDelete(True)

    def run(self) -> None:
        try:
            payload = self.registry.capture(self.kind, max_age_s=self.max_age)
        except Exception as exc:  # the registry never raises; stay defensive anyway
            payload = SensorPayload(kind=self.kind, degraded=True, error=str(exc))
        self.bridge.preview.emit(self.kind, payload)


class _TestCaptureJob(QRunnable):
    def __init__(self, registry, kind: SensorKind, bridge: Bridge) -> None:
        super().__init__()
        self.registry, self.kind, self.bridge = registry, kind, bridge
        self.setAutoDelete(True)

    def run(self) -> None:
        payload = self.registry.capture(self.kind, max_age_s=0)  # fresh, bypass cache
        if payload.error:
            self.bridge.message.emit("WARN", f"{self.kind.label} test: {payload.error}")
        else:
            self.bridge.message.emit("OK", f"{self.kind.label} test OK: {payload.summary()}")
        self.bridge.preview.emit(self.kind, payload)


class SensorRow(QFrame):
    def __init__(self, kind: SensorKind, panel: "SensorPanel") -> None:
        super().__init__()
        self.kind = kind
        self.setFrameShape(QFrame.Shape.StyledPanel)
        grid = QGridLayout(self)
        grid.setColumnStretch(3, 1)

        self.live = QCheckBox(kind.label)
        self.live.setToolTip("Live preview (throttled to 5 FPS max, downscaled to 640 px)")
        self.live.setChecked(True)
        self.live.toggled.connect(lambda on: panel.set_live(kind, on))

        self.pill = QLabel("…")
        self.pill.setStyleSheet(pill_style("unavailable"))
        self.reason = QLabel("probing…")
        self.reason.setObjectName("hint")
        self.reason.setWordWrap(True)
        self.reason.setMaximumWidth(260)

        self.visual = QLabel("no preview")
        self.visual.setObjectName("hint")
        self.visual.setFixedSize(224, 126)
        self.visual.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.visual.setWordWrap(True)
        self.visual.setStyleSheet(f"border: 1px dashed {MUTED}; border-radius: 4px;")
        self.meter = QProgressBar()
        self.meter.setRange(0, 100)
        self.meter.setValue(0)
        self.meter.setFormat("no signal")
        self.meter.setFixedSize(224, 22)

        hint_label, hint_placeholder = OPTION_HINTS.get(kind, ("", ""))
        self.opt = QLineEdit(panel.option_text(kind))
        self.opt.setPlaceholderText(hint_placeholder)
        self.opt.setToolTip(f"Option: {hint_label}" if hint_label else "No options for this sensor")
        self.opt.setEnabled(bool(hint_label))
        self.opt.setMaximumWidth(150)

        self.apply_btn = QPushButton("Apply")
        self.apply_btn.setToolTip("Apply options and re-check availability")
        self.apply_btn.clicked.connect(lambda: panel.apply(kind, self.opt.text()))
        self.test_btn = QPushButton(icon("play", size=14), "Test capture")
        self.test_btn.setToolTip("Capture once now and report the result")
        self.test_btn.clicked.connect(lambda: panel.test_capture(kind))

        left = QVBoxLayout()
        left.addWidget(self.live)
        left.addWidget(self.pill, alignment=Qt.AlignmentFlag.AlignLeft)
        left.addWidget(self.reason)
        grid.addLayout(left, 0, 0, 3, 1)
        grid.addWidget(self.visual if kind in IMAGE_KINDS else self.meter, 0, 1, 3, 1)
        opt_row = QHBoxLayout()
        if hint_label:
            opt_row.addWidget(QLabel(hint_label))
        opt_row.addWidget(self.opt)
        grid.addLayout(opt_row, 0, 2)
        btns = QHBoxLayout()
        btns.addWidget(self.apply_btn)
        btns.addWidget(self.test_btn)
        grid.addLayout(btns, 1, 2)

    def set_status(self, status: str, reason: str) -> None:
        label = {"ok": "OK", "degraded": "Degraded", "unavailable": "Unavailable", "error": "Error"}.get(status, status)
        self.pill.setText(label)
        self.pill.setStyleSheet(pill_style(status))
        self.reason.setText(reason)
        self.reason.setToolTip(reason)


class SensorPanel(QGroupBox):
    """Mirrors the upstream 'Sensor Control' concept for all seven sensor kinds."""

    def __init__(self, app, bridge: Bridge, parent=None) -> None:
        super().__init__("Sensor Control", parent)
        self.app = app
        self.bridge = bridge
        self.pool = QThreadPool.globalInstance()
        self.rows: dict[SensorKind, SensorRow] = {}
        self._busy: set[SensorKind] = set()
        self._live: set[SensorKind] = set(SensorKind)
        self._options: dict[SensorKind, str] = {SensorKind.CAMERA: "0", SensorKind.SCREEN_OCR: "eng"}
        self._throttle = PreviewThrottle(app.config.runtime.preview_fps)
        self._last_audio: dict[SensorKind, float] = {}

        layout = QVBoxLayout(self)
        for kind in SensorKind:
            row = SensorRow(kind, self)
            self.rows[kind] = row
            layout.addWidget(row)
        layout.addStretch(1)

        bridge.preview.connect(self._on_preview)
        self.timer = QTimer(self)
        self.timer.setInterval(200)
        self.timer.timeout.connect(self._tick)
        self.timer.start()
        self.refresh_availability()

    # ------------------------------------------------------------------ #
    def option_text(self, kind: SensorKind) -> str:
        return self._options.get(kind, "")

    def refresh_availability(self) -> None:
        self.app.sensors.configure([_spec_from_option(k, self._options.get(k, "")) for k in SensorKind])
        for kind in SensorKind:
            ok, reason = self.app.sensors.get(kind).available()
            if ok:
                status = "ok"
            elif kind == SensorKind.SCREEN and "permission" in reason:
                status = "degraded"          # Wayland: fixable with one click
            else:
                status = "unavailable"
            self.rows[kind].set_status(status, reason)

    def apply(self, kind: SensorKind, text: str) -> None:
        self._options[kind] = text.strip()
        self.refresh_availability()
        self.bridge.message.emit("INFO", f"{kind.label}: options applied")

    def set_live(self, kind: SensorKind, on: bool) -> None:
        if on:
            self._live.add(kind)
        else:
            self._live.discard(kind)
            row = self.rows[kind]
            if kind in IMAGE_KINDS:
                row.visual.setPixmap(QPixmap())
                row.visual.setText("preview paused")
            else:
                row.meter.setValue(0)
                row.meter.setFormat("paused")

    def test_capture(self, kind: SensorKind) -> None:
        self.pool.start(_TestCaptureJob(self.app.sensors, kind, self.bridge))

    # ------------------------------------------------------------------ #
    def _tick(self) -> None:
        now = time.monotonic()
        for kind in list(self._live):
            if kind in self._busy:
                continue
            if kind in IMAGE_KINDS:
                if not self._throttle.ready():
                    continue
            else:
                if now - self._last_audio.get(kind, 0.0) < AUDIO_POLL_S:
                    continue
                self._last_audio[kind] = now
            self._busy.add(kind)
            self.pool.start(_CaptureJob(self.app.sensors, kind, self.bridge, max_age=0.15))

    def _on_preview(self, kind: SensorKind, payload: SensorPayload) -> None:
        self._busy.discard(kind)
        row = self.rows.get(kind)
        if row is None:
            return
        if kind in IMAGE_KINDS:
            self._show_image(row, payload)
        else:
            self._show_level(row, payload)
        if payload.error:
            row.reason.setText(payload.error)
            row.pill.setText("Degraded")
            row.pill.setStyleSheet(pill_style("degraded"))
        else:
            row.pill.setText("OK")
            row.pill.setStyleSheet(pill_style("ok"))

    def _show_image(self, row: SensorRow, payload: SensorPayload) -> None:
        if not payload.is_image:
            row.visual.setPixmap(QPixmap())
            row.visual.setText((payload.error or "no image")[:90])
            return
        try:
            png = downscale_png(bytes(payload.data), max_width=640)  # type: ignore[arg-type]
            img = QImage.fromData(png, "PNG")
            if img.isNull():
                raise ValueError("decode failed")
            pm = QPixmap.fromImage(img).scaled(224, 126, Qt.AspectRatioMode.KeepAspectRatio,
                                               Qt.TransformationMode.SmoothTransformation)
            row.visual.setText("")
            row.visual.setPixmap(pm)
        except Exception as exc:
            row.visual.setPixmap(QPixmap())
            row.visual.setText(f"preview error: {exc}"[:90])

    def _show_level(self, row: SensorRow, payload: SensorPayload) -> None:
        dbfs = payload.meta.get("level_dbfs")
        if dbfs is not None:
            row.meter.setValue(int(round(level_meter(float(dbfs)) * 100)))
            row.meter.setFormat(f"%v%  ({float(dbfs):.0f} dBFS)")
        elif payload.error:
            row.meter.setFormat("no signal")


__all__ = ["SensorPanel", "SensorRow"]
