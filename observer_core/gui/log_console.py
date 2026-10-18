"""Right column, tab 1: live event console. Tab 2 (diagnostics_view.py) aggregates every problem."""

from __future__ import annotations

import html
import time
from pathlib import Path

from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QLabel, QPlainTextEdit, QPushButton,
                             QVBoxLayout, QWidget)

from .. import paths
from ..storage.events import LEVELS
from .theme import LEVEL_COLORS, MUTED, icon


class LogConsole(QWidget):
    def __init__(self, app, parent=None) -> None:
        super().__init__(parent)
        self.app = app
        self._rows: list[dict] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        bar = QHBoxLayout()
        bar.addWidget(QLabel("Level"))
        self.level = QComboBox()
        self.level.addItems(["ALL", *LEVELS])
        self.level.setCurrentText("INFO")
        self.level.currentTextChanged.connect(self._rerender)
        bar.addWidget(self.level)
        bar.addStretch(1)
        self.btn_folder = QPushButton(icon("folder", size=14), "Logs folder")
        self.btn_folder.setToolTip("Open the folder with observer.log and events.jsonl")
        self.btn_folder.clicked.connect(self.open_logs)
        self.btn_jsonl = QPushButton("Export JSONL")
        self.btn_jsonl.clicked.connect(lambda: self.export("jsonl"))
        self.btn_csv = QPushButton("Export CSV")
        self.btn_csv.clicked.connect(lambda: self.export("csv"))
        for b in (self.btn_folder, self.btn_jsonl, self.btn_csv):
            bar.addWidget(b)
        lay.addLayout(bar)

        self.view = QPlainTextEdit()
        self.view.setReadOnly(True)
        self.view.setMaximumBlockCount(5000)
        self.view.setStyleSheet("font-family: monospace; font-size: 12px;")
        lay.addWidget(self.view, 1)

        # seed with history
        for row in reversed(self.app.events.recent(limit=300)):
            self._rows.append(row)
        self._rerender()

    def add_event(self, row: dict) -> None:
        self._rows.append(row)
        if len(self._rows) > 5000:
            del self._rows[: len(self._rows) - 5000]
        if self._passes(row):
            self.view.appendHtml(self._fmt(row))

    def _passes(self, row: dict) -> bool:
        want = self.level.currentText()
        return want == "ALL" or row.get("level") == want or (
            want in LEVELS and LEVELS.index(row.get("level", "INFO")) >= LEVELS.index(want))

    def _fmt(self, row: dict) -> str:
        ts = time.strftime("%H:%M:%S", time.localtime(row.get("ts", 0)))
        color = LEVEL_COLORS.get(row.get("level", "INFO"), MUTED)
        agent = row.get("agent_id") or ""
        tag = f" <span style='color:{MUTED}'>[{html.escape(agent)}]</span>" if agent else ""
        return (f"<span style='color:{MUTED}'>{ts}</span> <span style='color:{color}'><b>{row.get('level','')}</b></span>"
                f"{tag} <span style='color:{color}'>{html.escape(str(row.get('message','')))}</span>")

    def _rerender(self, *_a) -> None:
        self.view.clear()
        for row in self._rows:
            if self._passes(row):
                self.view.appendHtml(self._fmt(row))

    def open_logs(self) -> None:
        folder = paths.log_dir()
        folder.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def export(self, fmt: str) -> None:
        suffix = "csv" if fmt == "csv" else "jsonl"
        path, _ = QFileDialog.getSaveFileName(self, "Export events", f"observer-events.{suffix}",
                                              f"{suffix.upper()} (*.{suffix})")
        if path:
            out = self.app.events.export(Path(path), fmt=fmt)
            self.app.events.record(f"events exported to {out.name}", level="INFO", kind="export")


__all__ = ["LogConsole"]
