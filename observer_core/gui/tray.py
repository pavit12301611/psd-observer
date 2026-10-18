"""System tray: running state, Show/Hide, Start/Stop monitoring, Quit."""

from __future__ import annotations

from PyQt6.QtGui import QAction
from PyQt6.QtWidgets import QApplication, QMenu, QStyle, QSystemTrayIcon


class Tray:
    def __init__(self, window) -> None:
        self.window = window
        self.available = QSystemTrayIcon.isSystemTrayAvailable()
        self.icon_obj = QSystemTrayIcon(window)
        style = QApplication.style()
        self.icon_obj.setIcon(style.standardIcon(QStyle.StandardPixmap.SP_ComputerIcon))
        menu = QMenu()
        self.act_show = QAction("Show / Hide", menu)
        self.act_show.triggered.connect(self._toggle_window)
        self.act_toggle = QAction("Start monitoring", menu)
        self.act_toggle.triggered.connect(window.toggle_monitoring)
        self.act_quit = QAction("Quit", menu)
        self.act_quit.triggered.connect(window.quit_app)
        for a in (self.act_show, self.act_toggle):
            menu.addAction(a)
        menu.addSeparator()
        menu.addAction(self.act_quit)
        self.icon_obj.setContextMenu(menu)
        self.icon_obj.activated.connect(self._on_activated)
        self.set_running(False)

    def show(self) -> None:
        if self.available:
            self.icon_obj.show()

    def set_running(self, running: bool) -> None:
        self.act_toggle.setText("Stop monitoring" if running else "Start monitoring")
        self.icon_obj.setToolTip(f"Observer Core — {'monitoring' if running else 'stopped'}")

    def _toggle_window(self) -> None:
        if self.window.isVisible():
            self.window.hide()
        else:
            self.window.show()
            self.window.raise_()
            self.window.activateWindow()

    def _on_activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self._toggle_window()


__all__ = ["Tray"]
