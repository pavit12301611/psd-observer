"""Agent editor: Configuration · Sensors · Tools · System Prompt · Preview & Test."""

from __future__ import annotations

import copy
import json

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (QCheckBox, QComboBox, QDoubleSpinBox, QFormLayout, QGridLayout, QHBoxLayout,
                             QLabel, QLineEdit, QPlainTextEdit, QPushButton, QSpinBox, QTabWidget, QTextEdit,
                             QVBoxLayout, QWidget)

from ..llm.factory import PROVIDERS
from ..models import SENSOR_TOKENS, AgentDef, ModelSpec, SensorKind, SensorSpec, ToolKind, ToolSpec
from ..tools.registry import ToolRegistry
from .theme import ERR, MUTED, OK, icon

TOOL_OPTION_HINTS = {
    ToolKind.TELEGRAM: "chat_id=…",
    ToolKind.DISCORD: "webhook_url=…",
    ToolKind.WHATSAPP: "to=whatsapp:+15551234567",
    ToolKind.SMS: "to=+15551234567",
    ToolKind.PHONE_CALL: "to=+15551234567",
    ToolKind.EMAIL: "to=you@example.com, subject_template=Observer: {agent}",
    ToolKind.HTTP_WEBHOOK: "url=https://example.invalid/hook",
    ToolKind.RECORD_CLIP: "seconds=5",
}


def parse_kv(text: str) -> dict:
    out: dict = {}
    for part in (text or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            k, v = k.strip(), v.strip()
            if k:
                out[k] = v
    return out


def format_kv(d: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in d.items() if k != "allow_python")


class AgentEditor(QWidget):
    saved = pyqtSignal(object)            # AgentDef
    run_now = pyqtSignal(object, bool)    # AgentDef, dry_run
    request_probe = pyqtSignal(object)    # ModelSpec

    def __init__(self, app, parent=None) -> None:
        super().__init__(parent)
        self.app = app
        self.agent: AgentDef | None = None
        self.tools_registry = ToolRegistry(app.config, memory=app.memory)
        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        self.header = QLabel("No agent selected")
        self.header.setObjectName("h2")
        root.addWidget(self.header)

        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)
        self._build_config()
        self._build_sensors()
        self._build_tools()
        self._build_prompt()
        self._build_test()

        bar = QHBoxLayout()
        self.dirty_label = QLabel("")
        self.dirty_label.setObjectName("hint")
        bar.addWidget(self.dirty_label)
        bar.addStretch(1)
        self.save_btn = QPushButton(icon("export", size=14), "Save agent")
        self.save_btn.setObjectName("primary")
        self.save_btn.clicked.connect(self.save)
        bar.addWidget(self.save_btn)
        root.addLayout(bar)
        self._set_enabled(False)

    # ------------------------------------------------------------------ #
    def _build_config(self) -> None:
        w = QWidget()
        f = QFormLayout(w)
        self.name = QLineEdit()
        self.description = QLineEdit()
        self.enabled = QCheckBox("Enabled (runs while monitoring is on)")
        self.provider = QComboBox()
        allowed = [p for p in PROVIDERS if p != "cloud" or self.app.config.privacy.allow_cloud_models]
        self.provider.addItems(allowed)
        self.endpoint = QLineEdit()
        self.model = QLineEdit()
        self.model.setPlaceholderText("e.g. qwen2.5vl:7b")
        self.api_key_env = QLineEdit()
        self.api_key_env.setPlaceholderText("env var name, e.g. OBSERVER_CLOUD_KEY (never the key itself)")
        self.vision = QCheckBox("Model accepts images (vision)")
        self.temperature = QDoubleSpinBox()
        self.temperature.setRange(0, 2)
        self.temperature.setSingleStep(0.05)
        self.max_tokens = QSpinBox()
        self.max_tokens.setRange(16, 8192)
        self.interval = QDoubleSpinBox()
        self.interval.setRange(1, 3600)
        self.interval.setSuffix(" s")
        self.max_actions = QSpinBox()
        self.max_actions.setRange(0, 20)
        self.trigger = QLineEdit()
        self.trigger.setPlaceholderText("optional: phrase that fires the agent in prose replies")
        self.probe_btn = QPushButton("Test connection")
        self.probe_btn.clicked.connect(lambda: self.request_probe.emit(self.collect_model()))
        self.probe_label = QLabel("")
        self.probe_label.setObjectName("hint")
        self.probe_label.setWordWrap(True)
        f.addRow(self.enabled)
        f.addRow("Name", self.name)
        f.addRow("Description", self.description)
        f.addRow("Provider", self.provider)
        f.addRow("Endpoint", self.endpoint)
        f.addRow("Model", self.model)
        f.addRow("API key env", self.api_key_env)
        f.addRow(self.vision)
        f.addRow("Temperature", self.temperature)
        f.addRow("Max tokens", self.max_tokens)
        f.addRow("Check interval", self.interval)
        f.addRow("Max actions / cycle", self.max_actions)
        f.addRow("Trigger phrase", self.trigger)
        row = QHBoxLayout()
        row.addWidget(self.probe_btn)
        row.addWidget(self.probe_label, 1)
        f.addRow(row)
        self.tabs.addTab(w, "Configuration")
        for widget in (self.name, self.description, self.endpoint, self.model, self.api_key_env, self.trigger):
            widget.textChanged.connect(self._mark_dirty)
        for widget in (self.temperature, self.max_tokens, self.interval, self.max_actions):
            widget.valueChanged.connect(self._mark_dirty)
        for widget in (self.provider,):
            widget.currentTextChanged.connect(self._mark_dirty)
        self.enabled.toggled.connect(self._mark_dirty)
        self.vision.toggled.connect(self._mark_dirty)

    def _build_sensors(self) -> None:
        w = QWidget()
        g = QGridLayout(w)
        self.sensor_checks: dict[SensorKind, QCheckBox] = {}
        self.sensor_opts: dict[SensorKind, QLineEdit] = {}
        for i, kind in enumerate(SensorKind):
            cb = QCheckBox(f"{kind.label}  {kind.token}")
            cb.toggled.connect(self._mark_dirty)
            opt = QLineEdit()
            opt.setPlaceholderText("options as key=value, e.g. lang=eng" if kind == SensorKind.SCREEN_OCR else "options")
            opt.textChanged.connect(self._mark_dirty)
            self.sensor_checks[kind] = cb
            self.sensor_opts[kind] = opt
            g.addWidget(cb, i, 0)
            g.addWidget(opt, i, 1)
        note = QLabel("A screen/camera sensor needs a vision model. Text sensors (OCR, clipboard, audio) work with any model.")
        note.setObjectName("hint")
        note.setWordWrap(True)
        g.addWidget(note, len(SensorKind), 0, 1, 2)
        g.setRowStretch(len(SensorKind) + 1, 1)
        self.tabs.addTab(w, "Sensors")

    def _build_tools(self) -> None:
        w = QWidget()
        g = QGridLayout(w)
        g.addWidget(QLabel("<b>Tool</b>"), 0, 0)
        g.addWidget(QLabel("<b>Options</b>"), 0, 1)
        g.addWidget(QLabel("<b>Credentials</b>"), 0, 2)
        self.tool_checks: dict[ToolKind, QCheckBox] = {}
        self.tool_opts: dict[ToolKind, QLineEdit] = {}
        self.tool_status: dict[ToolKind, QLabel] = {}
        self.python_optin = QCheckBox("allow_python — let this agent run sandboxed Python (OFF by default)")
        self.python_optin.setStyleSheet(f"color: {ERR};")
        for i, kind in enumerate(ToolKind, start=1):
            cb = QCheckBox(kind.label)
            cb.toggled.connect(self._mark_dirty)
            opt = QLineEdit()
            opt.setPlaceholderText(TOOL_OPTION_HINTS.get(kind, ""))
            opt.textChanged.connect(self._mark_dirty)
            st = QLabel("—")
            st.setWordWrap(True)
            self.tool_checks[kind] = cb
            self.tool_opts[kind] = opt
            self.tool_status[kind] = st
            g.addWidget(cb, i, 0)
            g.addWidget(opt, i, 1)
            g.addWidget(st, i, 2)
        g.addWidget(self.python_optin, len(ToolKind) + 1, 0, 1, 3)
        g.setRowStretch(len(ToolKind) + 2, 1)
        self.tabs.addTab(w, "Tools")

    def _build_prompt(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.prompt = QPlainTextEdit()
        mono = QFont("monospace")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self.prompt.setFont(mono)
        self.prompt.setPlaceholderText("Describe what to watch for and the JSON reply you expect.")
        self.prompt.textChanged.connect(self._mark_dirty)
        self.token_hint = QLabel("")
        self.token_hint.setObjectName("hint")
        self.token_hint.setWordWrap(True)
        lay.addWidget(self.prompt, 1)
        lay.addWidget(self.token_hint)
        self.tabs.addTab(w, "System Prompt")

    def _build_test(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        row = QHBoxLayout()
        self.run_btn = QPushButton(icon("play", size=14), "Run cycle now")
        self.run_btn.setObjectName("primary")
        self.run_btn.clicked.connect(lambda: self.run_now.emit(self.collect(), self.dry_run.isChecked()))
        self.dry_run = QCheckBox("Dry run (no model call, no actions)")
        row.addWidget(self.run_btn)
        row.addWidget(self.dry_run)
        row.addStretch(1)
        lay.addLayout(row)
        self.test_out = QTextEdit()
        self.test_out.setReadOnly(True)
        mono = QFont("monospace")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self.test_out.setFont(mono)
        self.test_out.setPlaceholderText("The raw prompt, the raw model reply and the parsed plan appear here.")
        lay.addWidget(self.test_out, 1)
        self.tabs.addTab(w, "Preview & Test")

    # ------------------------------------------------------------------ #
    def _set_enabled(self, on: bool) -> None:
        for i in range(self.tabs.count()):
            self.tabs.widget(i).setEnabled(on)
        self.save_btn.setEnabled(on)
        self.run_btn.setEnabled(on)

    def load(self, agent: AgentDef | None) -> None:
        self._loading = True
        self.agent = agent
        if agent is None:
            self.header.setText("No agent selected")
            self._set_enabled(False)
            self._loading = False
            return
        self.header.setText(f"{agent.name}  ·  {agent.id}")
        self.name.setText(agent.name)
        self.description.setText(agent.description)
        self.enabled.setChecked(agent.enabled)
        idx = self.provider.findText(agent.model.provider)
        if idx < 0:
            self.provider.addItem(agent.model.provider)
            idx = self.provider.findText(agent.model.provider)
        self.provider.setCurrentIndex(idx)
        self.endpoint.setText(agent.model.endpoint or "")
        self.model.setText(agent.model.model)
        self.api_key_env.setText(agent.model.api_key_env or "")
        self.vision.setChecked(agent.model.supports_vision)
        self.temperature.setValue(agent.model.temperature)
        self.max_tokens.setValue(agent.model.max_tokens)
        self.interval.setValue(agent.loop_interval_s)
        self.max_actions.setValue(agent.max_actions_per_cycle)
        self.trigger.setText(agent.trigger_phrase or "")
        by_kind = {s.kind: s for s in agent.sensors}
        for kind, cb in self.sensor_checks.items():
            spec = by_kind.get(kind)
            cb.setChecked(bool(spec and spec.enabled))
            self.sensor_opts[kind].setText(format_kv(spec.options) if spec else "")
        tools = {t.kind: t for t in agent.tools}
        for kind, cb in self.tool_checks.items():
            spec = tools.get(kind)
            cb.setChecked(bool(spec and spec.enabled))
            self.tool_opts[kind].setText(format_kv(spec.options) if spec else "")
        py_spec = tools.get(ToolKind.RUN_PYTHON)
        self.python_optin.setChecked(bool(py_spec and py_spec.allow_python))
        self.prompt.setPlainText(agent.system_prompt)
        self.dirty_label.setText("")
        self._refresh_tool_status()
        self._update_token_hint()
        self._set_enabled(True)
        self.test_out.clear()
        self._loading = False

    def collect_model(self) -> ModelSpec:
        base = self.agent.model if self.agent else ModelSpec(model="")
        return base.model_copy(update={
            "provider": self.provider.currentText() or "ollama",
            "endpoint": self.endpoint.text().strip() or None,
            "model": self.model.text().strip(),
            "api_key_env": self.api_key_env.text().strip() or None,
            "supports_vision": self.vision.isChecked(),
            "temperature": float(self.temperature.value()),
            "max_tokens": int(self.max_tokens.value()),
        })

    def collect(self) -> AgentDef:
        """Build the AgentDef from the widgets (does not persist)."""
        assert self.agent is not None
        sensors = []
        for kind, cb in self.sensor_checks.items():
            opts = parse_kv(self.sensor_opts[kind].text())
            if cb.isChecked() or opts:
                sensors.append(SensorSpec(kind=kind, enabled=cb.isChecked(), options=opts))
        tools = []
        for kind, cb in self.tool_checks.items():
            opts = parse_kv(self.tool_opts[kind].text())
            spec = ToolSpec(kind=kind, enabled=cb.isChecked(), options=opts)
            if kind == ToolKind.RUN_PYTHON:
                spec.allow_python = self.python_optin.isChecked()
            if cb.isChecked() or opts:
                tools.append(spec)
        data = copy.deepcopy(self.agent.model_dump())
        data.update({
            "name": self.name.text().strip() or self.agent.name,
            "description": self.description.text().strip(),
            "enabled": self.enabled.isChecked(),
            "system_prompt": self.prompt.toPlainText(),
            "sensors": [s.model_dump() for s in sensors],
            "tools": [t.model_dump() for t in tools],
            "model": self.collect_model().model_dump(),
            "loop_interval_s": float(self.interval.value()),
            "max_actions_per_cycle": int(self.max_actions.value()),
            "trigger_phrase": self.trigger.text().strip() or None,
        })
        return AgentDef.model_validate(data)

    def save(self) -> None:
        if self.agent is None:
            return
        agent = self.collect()
        self.saved.emit(agent)
        self.agent = agent
        self.dirty_label.setText("saved")
        self._refresh_tool_status()

    def _mark_dirty(self, *_a) -> None:
        if getattr(self, "_loading", False) or self.agent is None:
            return
        self.dirty_label.setText("unsaved changes")
        self._refresh_tool_status()
        self._update_token_hint()

    def _refresh_tool_status(self) -> None:
        for kind, label in self.tool_status.items():
            spec = ToolSpec(kind=kind, enabled=True, options=parse_kv(self.tool_opts[kind].text()))
            try:
                ok, msg = self.tools_registry.build(spec).validate()
            except Exception as exc:
                ok, msg = False, str(exc)
            label.setText(("✓ ready" if ok else f"✗ {msg}"))
            label.setStyleSheet(f"color: {OK if ok else (MUTED if not self.tool_checks[kind].isChecked() else ERR)};")

    def _update_token_hint(self) -> None:
        enabled = [kind for kind, cb in self.sensor_checks.items() if cb.isChecked()]
        available = " ".join(SENSOR_TOKENS[k] for k in enabled) or "none — enable a sensor to use tokens"
        self.token_hint.setText(f"Tokens for enabled sensors: {available}   ·   all: "
                                + " ".join(SENSOR_TOKENS.values()))

    # ------------------------------------------------------------------ #
    def show_result(self, res) -> None:
        plan = res.plan
        parts = [
            f"=== cycle #{res.cycle_index} · {res.duration_ms} ms · model {res.model_latency_ms} ms · ok={res.ok}",
        ]
        if res.error:
            parts.append(f"ERROR: {res.error}")
        parts.append("--- prompt sent (images are attached separately) ---")
        parts.append(res.prompt_text or "(no prompt)")
        parts.append("--- raw model response ---")
        parts.append(res.raw_response or "(none)")
        parts.append("--- parsed plan ---")
        parts.append(json.dumps(plan.model_dump(exclude={"raw"}), indent=2, default=str))
        if res.results:
            parts.append("--- actions ---")
            for r in res.results:
                parts.append(f"{'✓' if r.ok else '✗'} {r.tool}: {r.detail or r.skipped_reason}")
        if res.warnings:
            parts.append("--- warnings ---")
            parts.extend(f"! {w}" for w in res.warnings)
        self.test_out.setPlainText("\n".join(parts))
        self.tabs.setCurrentIndex(self.tabs.count() - 1)


__all__ = ["AgentEditor", "parse_kv", "format_kv"]
