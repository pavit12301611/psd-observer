"""Main window: top bar · agent list · sensor control + agent editor · console/diagnostics."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (QApplication, QFrame, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QPushButton, QScrollArea, QSplitter, QStatusBar, QTabWidget, QToolButton, QVBoxLayout, QWidget)

from .. import __app_name__, __version__
from ..app import ObserverApp, new_agent_id
from ..logging_setup import setup_logging
from ..models import AgentDef
from ..util import detect_session
from .agent_editor import AgentEditor
from .agent_list import AgentList
from .bridge import Bridge, Engine
from .diagnostics_view import DiagnosticsView
from .log_console import LogConsole
from .sensor_panel import SensorPanel
from .settings_dialog import SettingsDialog
from .theme import DARK_QSS, ERR, MUTED, OK, WARN, icon, led_pixmap
from .tray import Tray
from .wizard import ObserveWizard


class MainWindow(QMainWindow):
    def __init__(self, app: ObserverApp) -> None:
        super().__init__()
        self.app = app
        self.bridge = Bridge()
        self.engine = Engine(app, self.bridge)
        self._quitting = False
        self.setWindowTitle(f"{__app_name__} {__version__}")
        self.resize(1480, 920)

        # ---------- top bar ----------
        top = QWidget()
        bar = QHBoxLayout(top)
        bar.setContentsMargins(8, 6, 8, 6)
        self.led = QLabel()
        self.led.setPixmap(led_pixmap(MUTED))
        self.status_text = QLabel("Stopped")
        self.toggle_btn = QPushButton(icon("play", size=14), "Start monitoring")
        self.toggle_btn.setObjectName("primary")
        self.toggle_btn.clicked.connect(self.toggle_monitoring)
        bar.addWidget(self.led)
        bar.addWidget(self.status_text)
        bar.addWidget(self.toggle_btn)
        bar.addSpacing(16)
        bar.addWidget(QLabel("Endpoint"))
        self.endpoint = QLineEdit()
        self.endpoint.setPlaceholderText("selected agent's inference endpoint")
        self.endpoint.setMinimumWidth(280)
        self.endpoint.editingFinished.connect(self._endpoint_changed)
        bar.addWidget(self.endpoint, 1)
        self.probe_btn = QPushButton(icon("eye", size=14), "Test connection")
        self.probe_btn.clicked.connect(self._test_connection)
        bar.addWidget(self.probe_btn)
        self.health_label = QLabel("")
        self.health_label.setObjectName("hint")
        self.health_label.setMaximumWidth(420)
        self.health_label.setWordWrap(False)
        bar.addWidget(self.health_label)
        self.lock = QToolButton()
        self.lock.setCheckable(True)
        self.lock.toggled.connect(self._toggle_local_only)
        bar.addWidget(self.lock)
        self.grant_btn = QPushButton(icon("screen", size=14), "Grant screen capture")
        self.grant_btn.setToolTip("Re-request screen capture through the desktop portal (Wayland)")
        self.grant_btn.clicked.connect(self._grant_screen)
        bar.addWidget(self.grant_btn)
        settings_btn = QToolButton()
        settings_btn.setIcon(icon("settings"))
        settings_btn.setToolTip("Settings")
        settings_btn.clicked.connect(self.open_settings)
        bar.addWidget(settings_btn)

        self.banner = QLabel("⚠ CLOUD MODEL SELECTED — prompts and screenshots for this agent leave this machine.")
        self.banner.setObjectName("banner_cloud")
        self.banner.setWordWrap(True)
        self.banner.hide()

        # ---------- columns ----------
        self.agent_list = AgentList(app)
        self.sensor_panel = SensorPanel(app, self.bridge)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.sensor_panel)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.editor = AgentEditor(app)
        centre = QSplitter(Qt.Orientation.Vertical)
        centre.addWidget(scroll)
        centre.addWidget(self.editor)
        centre.setSizes([430, 470])
        self.right = QTabWidget()
        self.console = LogConsole(app)
        self.diagnostics = DiagnosticsView(app, self.bridge)
        self.right.addTab(self.console, "Console")
        self.right.addTab(self.diagnostics, "Diagnostics")
        self.right.setMinimumWidth(380)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(self.agent_list)
        split.addWidget(centre)
        split.addWidget(self.right)
        split.setSizes([300, 760, 420])

        body = QWidget()
        lay = QVBoxLayout(body)
        lay.setContentsMargins(8, 4, 8, 4)
        lay.addWidget(top)
        lay.addWidget(self.banner)
        lay.addWidget(split, 1)
        self.setCentralWidget(body)
        self.setStatusBar(QStatusBar())

        # ---------- wiring ----------
        self.bridge.event.connect(self.console.add_event)
        self.bridge.status.connect(self._on_status)
        self.bridge.cycle_done.connect(self._on_cycle_done)
        self.bridge.health.connect(self._on_health)
        self.bridge.message.connect(self._on_message)

        self.agent_list.selected.connect(self._on_selected)
        self.agent_list.new_requested.connect(self.new_agent)
        self.agent_list.duplicate_requested.connect(self._duplicate)
        self.agent_list.import_requested.connect(self._import)
        self.agent_list.export_requested.connect(self._export)
        self.agent_list.toggle_requested.connect(self._set_enabled)
        self.agent_list.delete_requested.connect(self._delete)
        self.editor.saved.connect(self._save_agent)
        self.editor.run_now.connect(self._run_now)
        self.editor.request_probe.connect(self._probe_spec)

        self.tray = Tray(self)
        self.tray.show()

        self._refresh_chrome()
        QTimer.singleShot(0, self._post_start)

    # ------------------------------------------------------------------ #
    def _post_start(self) -> None:
        self.bridge.message.emit("INFO", f"ready · session {detect_session().session_type} · "
                                         "monitoring is OFF until you start it")
        self._test_connection(quiet=True)
        self.diagnostics.run_checks()

    def _refresh_chrome(self) -> None:
        running = self.engine.monitoring
        self.led.setPixmap(led_pixmap(OK if running else MUTED))
        self.status_text.setText("Monitoring" if running else "Stopped")
        self.toggle_btn.setText("Stop monitoring" if running else "Start monitoring")
        self.toggle_btn.setIcon(icon("stop" if running else "play", size=14))
        self.tray.set_running(running)
        self.lock.blockSignals(True)
        self.lock.setChecked(not self.app.config.privacy.allow_cloud_models)
        self.lock.blockSignals(False)
        self.lock.setIcon(icon("lock" if self.lock.isChecked() else "unlock"))
        self.lock.setToolTip("Local only: cloud models refused (click to allow cloud)" if self.lock.isChecked()
                             else "Cloud models ALLOWED — click to lock to local-only")
        sess = detect_session()
        self.grant_btn.setVisible(sess.session_type == "wayland")
        agent = self.agent_list.current()
        cloud = bool(agent and agent.model.provider == "cloud")
        self.banner.setVisible(cloud)

    def _on_selected(self, agent: AgentDef | None) -> None:
        self.editor.load(agent)
        self.endpoint.setText((agent.model.endpoint or "") if agent else "")
        self.endpoint.setEnabled(agent is not None)
        self._refresh_chrome()

    def _current(self) -> AgentDef | None:
        return self.agent_list.current()

    # ------------------------------------------------------------------ #
    def toggle_monitoring(self) -> None:
        if self.engine.monitoring:
            self.engine.stop_monitoring()
        else:
            enabled = [a for a in self.app.agents.list() if a.enabled]
            if not enabled:
                self.bridge.message.emit("WARN", "no enabled agents — tick ‘Enabled’ on an agent and Save first")
                return
            blocked = [a.name for a in enabled if a.model.provider == "cloud" and not self.app.config.privacy.allow_cloud_models]
            if blocked:
                self.bridge.message.emit("WARN", f"cloud agents blocked by local-only lock: {', '.join(blocked)}")
            self.engine.start_monitoring(enabled)
        self._refresh_chrome()

    def _on_status(self, st) -> None:
        if self.engine.monitoring:
            states = self.engine.scheduler.states() if self.engine.scheduler else []
            if any(s.state == "error" for s in states):
                self.led.setPixmap(led_pixmap(ERR))
            elif any(s.state == "degraded" for s in states):
                self.led.setPixmap(led_pixmap(WARN))
            else:
                self.led.setPixmap(led_pixmap(OK))
        self.statusBar().showMessage(f"{st.name}: {st.state}" + (f" — {st.last_error}" if st.last_error else ""), 5000)

    def _on_cycle_done(self, res) -> None:
        agent = self._current()
        if agent and agent.id == res.agent_id:
            self.editor.show_result(res)
        level = "OK" if res.ok and not res.error else "ERROR"
        self.bridge.message.emit(level, f"cycle #{res.cycle_index} for {res.agent_id}: "
                                        f"{'triggered' if res.triggered else 'no trigger'}"
                                        + (f" — {res.error}" if res.error else ""))

    def _on_health(self, h: dict) -> None:
        if h["ok"]:
            models = ", ".join(h.get("models") or [])[:120] or "no model list"
            self.health_label.setText(f"✓ {h['detail']} · {h.get('latency_ms')} ms · {models}")
            self.health_label.setStyleSheet(f"color:{OK};")
        else:
            self.health_label.setText(f"✗ {h['detail']}")
            self.health_label.setStyleSheet(f"color:{WARN};")
        self.health_label.setToolTip(h["detail"])

    def _on_message(self, level: str, text: str) -> None:
        self.statusBar().showMessage(text, 8000)
        self.app.events.record(text, level=level, kind="gui")

    # ------------------------------------------------------------------ #
    def _test_connection(self, quiet: bool = False) -> None:
        agent = self._current()
        spec = self.editor.collect_model() if agent else None
        if spec is None:
            from ..llm.factory import default_model_spec

            spec = default_model_spec(self.app.config)
        if not quiet:
            self.health_label.setText("checking…")
        self.engine.probe_model(spec)

    def _probe_spec(self, spec) -> None:
        self.health_label.setText("checking…")
        self.engine.probe_model(spec)

    def _endpoint_changed(self) -> None:
        agent = self._current()
        if not agent:
            return
        text = self.endpoint.text().strip() or None
        if text == agent.model.endpoint:
            return
        agent.model = agent.model.model_copy(update={"endpoint": text})
        self.app.agents.save(agent)
        self.editor.load(agent)
        self.engine.refresh_agent(agent)
        self.bridge.message.emit("INFO", f"endpoint for {agent.name} set to {text}")

    def _toggle_local_only(self, locked: bool) -> None:
        if not locked:
            ans = QMessageBox.warning(self, "Allow cloud models?",
                                      "Cloud models send prompts and screenshots to a third-party server.\n\n"
                                      "Only enable this if you accept that for the agents you configure.",
                                      QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if ans != QMessageBox.StandardButton.Yes:
                self.lock.blockSignals(True)
                self.lock.setChecked(True)
                self.lock.blockSignals(False)
                return
        self.app.config.privacy.allow_cloud_models = not locked
        self.app.config.save()
        self.bridge.message.emit("WARN" if not locked else "OK",
                                 "cloud models ALLOWED" if not locked else "local-only lock ON")
        self._refresh_chrome()

    def _grant_screen(self) -> None:
        from ..models import SensorKind

        screen = self.app.sensors.get(SensorKind.SCREEN)

        def work():
            ok, msg = screen.grant_permission()
            self.bridge.message.emit("OK" if ok else "WARN", f"screen capture: {msg}")

        threading.Thread(target=work, daemon=True).start()

    # ------------------------------------------------------------------ #
    def new_agent(self) -> None:
        wiz = ObserveWizard(self)
        if wiz.exec() and wiz.result_agent is not None:
            agent = wiz.result_agent
            agent.id = new_agent_id(agent.name)
            self.app.agents.save(agent)
            self.agent_list.refresh()
            self.agent_list.select(agent.id)
            self.bridge.message.emit("OK", f"created ‘{agent.name}’ (disabled — review, then enable)")

    def _duplicate(self, agent_id: str) -> None:
        dup = self.app.agents.duplicate(agent_id)
        self.agent_list.refresh()
        if dup:
            self.agent_list.select(dup.id)

    def _import(self, path: str) -> None:
        try:
            ag = self.app.agents.import_file(Path(path))
            self.agent_list.refresh()
            self.agent_list.select(ag.id)
            self.bridge.message.emit("OK", f"imported {ag.name}")
        except Exception as exc:
            QMessageBox.critical(self, "Import failed", f"{exc}")

    def _export(self, agent_id: str, path: str) -> None:
        out = self.app.agents.export_file(agent_id, Path(path))
        self.bridge.message.emit("OK", f"exported to {out}")

    def _set_enabled(self, agent_id: str, enabled: bool) -> None:
        agent = self.app.agents.get(agent_id)
        if not agent:
            return
        agent.enabled = enabled
        self.app.agents.save(agent)
        self.agent_list.refresh()
        self.agent_list.select(agent_id)
        if self.engine.monitoring:
            self.engine.refresh_agent(agent)   # starts or stops this agent's loop
        self._refresh_chrome()

    def _save_agent(self, agent: AgentDef) -> None:
        self.app.agents.save(agent)
        self.agent_list.refresh()
        self.agent_list.select(agent.id)
        self.engine.refresh_agent(agent)
        self.bridge.message.emit("OK", f"saved ‘{agent.name}’")
        self._refresh_chrome()

    def _delete(self, agent_id: str) -> None:
        agent = self.app.agents.get(agent_id)
        if self.engine.monitoring and agent is not None:
            agent.enabled = False
            self.engine.refresh_agent(agent)   # stops the loop before the row disappears
        self.app.agents.delete(agent_id)
        self.agent_list.refresh()

    def _run_now(self, agent: AgentDef, dry_run: bool) -> None:
        self.bridge.message.emit("INFO", f"running a cycle for ‘{agent.name}’…")
        self.engine.run_cycle(agent, dry_run=dry_run)

    # ------------------------------------------------------------------ #
    def open_settings(self) -> None:
        dlg = SettingsDialog(self.app, self)
        if dlg.exec():
            self._refresh_chrome()
            self.sensor_panel.refresh_availability()
            self._test_connection(quiet=True)
            self.bridge.message.emit("OK", "settings saved")

    def quit_app(self) -> None:
        self._quitting = True
        self.engine.shutdown()
        self.app.close()
        QApplication.quit()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self.tray.available and not self._quitting:
            self.hide()
            event.ignore()
            return
        self.quit_app()
        event.accept()


def run_gui(argv: list[str] | None = None) -> int:
    """Create the Qt application and show the main window. Returns an exit code."""
    setup_logging(json_logs=True)
    sess = detect_session()
    if not sess.has_display:
        print("Observer Core: no display found (DISPLAY/WAYLAND_DISPLAY unset).\n"
              "Use `observer-core daemon` for headless operation.", file=sys.stderr)
        return 2

    qapp = QApplication.instance() or QApplication(argv or sys.argv)
    qapp.setApplicationName(__app_name__)
    qapp.setQuitOnLastWindowClosed(False)
    qapp.setStyleSheet(DARK_QSS)

    app = ObserverApp()
    app.seed_examples()
    win = MainWindow(app)
    qapp.aboutToQuit.connect(win.engine.shutdown)     # stop loops + close DB on any quit path

    # Ctrl+C in the terminal: Qt's event loop does not return to Python on its own, so a
    # short timer lets the interpreter deliver SIGINT, which we turn into a clean quit.
    import signal

    signal.signal(signal.SIGINT, lambda *_: qapp.quit())
    ticker = QTimer()
    ticker.start(250)
    ticker.timeout.connect(lambda: None)

    win.show()
    code = qapp.exec()
    app.close()
    return code


__all__ = ["MainWindow", "run_gui"]
