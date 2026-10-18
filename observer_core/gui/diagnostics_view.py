"""Diagnostics tab: every sensor / tool / model / system problem in one table, with fixes."""

from __future__ import annotations

from PyQt6.QtGui import QBrush, QColor
from PyQt6.QtWidgets import (QHBoxLayout, QHeaderView, QLabel, QPushButton, QTableWidget, QTableWidgetItem,
                             QVBoxLayout, QWidget)

from ..doctor import audio_devices, video_devices
from .bridge import Bridge
from .theme import ERR, MUTED, OK, WARN, icon

STATUS_COLORS = {"ok": OK, "degraded": WARN, "unavailable": ERR, "error": ERR}


class DiagnosticsView(QWidget):
    def __init__(self, app, bridge: Bridge, parent=None) -> None:
        super().__init__(parent)
        self.app = app
        self.bridge = bridge
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        top = QHBoxLayout()
        self.summary = QLabel("Run a check to see every problem in one place.")
        self.summary.setObjectName("hint")
        top.addWidget(self.summary, 1)
        self.refresh_btn = QPushButton(icon("settings", size=14), "Re-check")
        self.refresh_btn.clicked.connect(self.run_checks)
        top.addWidget(self.refresh_btn)
        lay.addLayout(top)

        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["Area", "Name", "Status", "Detail / fix"])
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        lay.addWidget(self.table, 1)
        self.devices = QLabel("")
        self.devices.setObjectName("hint")
        self.devices.setWordWrap(True)
        lay.addWidget(self.devices)
        bridge.diagnostics.connect(self._populate)

    def run_checks(self) -> None:
        import threading

        from ..doctor import collect_diagnostics

        self.refresh_btn.setEnabled(False)
        self.summary.setText("Checking…")

        def work():
            try:
                diags = collect_diagnostics(self.app, include_model=True)
            except Exception as exc:  # never let the view crash
                from ..models import Diagnostic

                diags = [Diagnostic(area="system", name="doctor", ok=False, status="error", detail=str(exc))]
            self.bridge.diagnostics.emit(diags)

        threading.Thread(target=work, daemon=True).start()

    def _populate(self, diags) -> None:
        self.refresh_btn.setEnabled(True)
        self.table.setRowCount(len(diags))
        problems = 0
        for r, d in enumerate(diags):
            if d.status != "ok":
                problems += 1
            detail = d.detail + (f"\n→ {d.hint}" if d.hint else "")
            vals = [d.area, d.name, d.status, detail]
            for c, v in enumerate(vals):
                item = QTableWidgetItem(str(v))
                if c == 2:
                    item.setForeground(QBrush(QColor(STATUS_COLORS.get(d.status, MUTED))))
                item.setToolTip(detail)
                self.table.setItem(r, c, item)
            self.table.setRowHeight(r, 22 if not d.hint else 40)
        self.summary.setText(f"{len(diags) - problems}/{len(diags)} checks OK — {problems} need attention. "
                             "Degraded items never stop the app from starting.")
        self.devices.setText(f"Cameras: {', '.join(video_devices()) or 'none'}   ·   "
                             f"Microphones: {'; '.join(audio_devices()) or 'none detected'}")


__all__ = ["DiagnosticsView"]
