"""Settings: model defaults, credentials (masked, stored 0600 in config.toml), privacy, runtime, data."""

from __future__ import annotations

import os

from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFormLayout,
                             QGroupBox, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPlainTextEdit, QPushButton,
                             QSpinBox, QTabWidget, QVBoxLayout, QWidget)

from .. import paths
from ..config import AppConfig
from ..models import ToolKind
from ..sensors.screen import choose_provider


class SettingsDialog(QDialog):
    def __init__(self, app, parent=None) -> None:
        super().__init__(parent)
        self.app = app
        self.cfg: AppConfig = app.config
        self.setWindowTitle("Settings")
        self.setMinimumWidth(640)
        root = QVBoxLayout(self)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)
        self.fields: dict[str, QWidget] = {}
        self._build_models()
        self._build_notifications()
        self._build_privacy()
        self._build_runtime()
        self._build_data()
        btns = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        btns.accepted.connect(self._save)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)

    # ------------------------------------------------------------------ #
    def _line(self, key: str, value: str, secret: bool = False, placeholder: str = "") -> QLineEdit:
        w = QLineEdit(value or "")
        if secret:
            w.setEchoMode(QLineEdit.EchoMode.Password)
        if placeholder:
            w.setPlaceholderText(placeholder)
        self.fields[key] = w
        return w

    def _check(self, key: str, value: bool, text: str) -> QCheckBox:
        w = QCheckBox(text)
        w.setChecked(bool(value))
        self.fields[key] = w
        return w

    def _build_models(self) -> None:
        w = QWidget()
        f = QFormLayout(w)
        d = self.cfg.models
        combo = QComboBox()
        combo.addItems(["ollama", "openai_compat", "llamacpp_local", "cloud"])
        combo.setCurrentText(d.provider)
        self.fields["models.provider"] = combo
        f.addRow("Default provider for new agents", combo)
        f.addRow("Ollama endpoint", self._line("models.endpoint", d.endpoint, placeholder="http://127.0.0.1:11434"))
        f.addRow("Ollama model", self._line("models.ollama_model", d.ollama_model))
        f.addRow("OpenAI-compatible endpoint", self._line("models.openai_endpoint", d.openai_endpoint,
                                                          placeholder="http://127.0.0.1:8080/v1 (llama.cpp, vLLM, LM Studio)"))
        f.addRow("OpenAI-compatible model", self._line("models.openai_model", d.openai_model))
        warn = QLabel("Cloud is opt-in. It is refused unless Privacy → 'Allow cloud models' is on.")
        warn.setStyleSheet("color:#FFB4B0;")
        f.addRow(warn)
        f.addRow("Cloud endpoint", self._line("models.cloud_endpoint", d.cloud_endpoint))
        f.addRow("Cloud model", self._line("models.cloud_model", d.cloud_model))
        f.addRow("API key env var", self._line("models.openai_api_key_env", d.openai_api_key_env,
                                               placeholder="name of the env var, never the key"))
        self.tabs.addTab(w, "Models")

    def _build_notifications(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        note = QLabel("Credentials are saved to config.toml (mode 600). Environment variables always win, "
                      "so you can keep them out of the file. Secrets are masked everywhere else.")
        note.setObjectName("hint")
        note.setWordWrap(True)
        lay.addWidget(note)
        c = self.cfg
        groups = [
            ("Telegram", [("telegram.bot_token", c.telegram.bot_token, True, "bot token"),
                          ("telegram.chat_id", c.telegram.chat_id, False, "chat id")], ToolKind.TELEGRAM),
            ("Discord", [("discord.webhook_url", c.discord.webhook_url, True, "webhook URL")], ToolKind.DISCORD),
            ("Twilio (WhatsApp / SMS / voice)", [("twilio.account_sid", c.twilio.account_sid, True, "account SID"),
                                                  ("twilio.auth_token", c.twilio.auth_token, True, "auth token"),
                                                  ("twilio.from_number", c.twilio.from_number, False, "+1555…")], ToolKind.SMS),
            ("Email (SMTP)", [("smtp.host", c.smtp.host, False, "smtp.example.com"), ("smtp.port", str(c.smtp.port), False, "587"),
                              ("smtp.user", c.smtp.user, False, ""), ("smtp.password", c.smtp.password, True, ""),
                              ("smtp.from_addr", c.smtp.from_addr, False, "observer@example.com")], ToolKind.EMAIL),
            ("SendGrid", [("sendgrid.api_key", c.sendgrid.api_key, True, ""), ("sendgrid.from_email", c.sendgrid.from_email, False, "")], None),
            ("Pushover", [("pushover.token", c.pushover.token, True, "app token"), ("pushover.user", c.pushover.user, True, "user key")], ToolKind.PUSHOVER),
        ]
        for title, rows, kind in groups:
            box = QGroupBox(title)
            form = QFormLayout(box)
            for key, val, secret, ph in rows:
                form.addRow(key.split(".")[-1].replace("_", " "), self._line(key, val, secret, ph))
            if kind is not None:
                btn = QPushButton(f"Send test to {title.split(' ')[0]}")
                btn.clicked.connect(lambda _=False, k=kind: self._test(k))
                form.addRow(btn)
            lay.addWidget(box)
        dn = QPushButton("Send test desktop notification")
        dn.clicked.connect(lambda: self._test(ToolKind.DESKTOP_NOTIFY))
        lay.addWidget(dn)
        lay.addStretch(1)
        self.tabs.addTab(w, "Notifications")

    def _build_privacy(self) -> None:
        w = QWidget()
        f = QFormLayout(w)
        p = self.cfg.privacy
        f.addRow(self._check("privacy.allow_cloud_models", p.allow_cloud_models,
                             "Allow cloud models (data leaves this machine)"))
        f.addRow(self._check("privacy.persist_frames", p.persist_frames,
                             "Keep screen/camera frames in a local ring buffer"))
        f.addRow(self._check("privacy.block_network_tools", p.block_network_tools,
                             "Kill-switch: block every tool that sends data off-machine"))
        mb = QSpinBox()
        mb.setRange(10, 100000)
        mb.setValue(p.max_frames_mb)
        mb.setSuffix(" MB")
        self.fields["privacy.max_frames_mb"] = mb
        f.addRow("Frame buffer limit", mb)
        pats = QPlainTextEdit("\n".join(p.redact_patterns))
        pats.setPlaceholderText("one regex per line — matches are replaced by [redacted]")
        pats.setMaximumHeight(90)
        self.fields["privacy.redact_patterns"] = pats
        f.addRow("Redact patterns", pats)
        f.addRow(QLabel("Telemetry: none. Observer Core has no server and sends nothing by default."))
        self.tabs.addTab(w, "Privacy")

    def _build_runtime(self) -> None:
        w = QWidget()
        f = QFormLayout(w)
        r = self.cfg.runtime
        t = QDoubleSpinBox(); t.setRange(5, 600); t.setValue(r.cycle_timeout_s); t.setSuffix(" s")
        self.fields["runtime.cycle_timeout_s"] = t
        f.addRow("Cycle hard timeout", t)
        m = QSpinBox(); m.setRange(1, 16); m.setValue(r.max_concurrent_model_calls)
        self.fields["runtime.max_concurrent_model_calls"] = m
        f.addRow("Concurrent model calls", m)
        k = QSpinBox(); k.setRange(0, 50); k.setValue(r.memory_top_k)
        self.fields["runtime.memory_top_k"] = k
        f.addRow("Memories per prompt", k)
        a = QDoubleSpinBox(); a.setRange(1, 60); a.setValue(r.audio_clip_s); a.setSuffix(" s")
        self.fields["runtime.audio_clip_s"] = a
        f.addRow("Audio sample length", a)
        provider, reason = choose_provider("auto")
        f.addRow("Screen capture backend", QLabel(f"{provider} — {reason}"))
        self.tabs.addTab(w, "Runtime")

    def _build_data(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        for label, p in (("Config", paths.config_file()), ("Data", paths.data_dir()),
                         ("Logs", paths.log_dir()), ("Cache", paths.cache_dir())):
            lay.addWidget(QLabel(f"<b>{label}:</b> {p}"))
        row = QHBoxLayout()
        b1 = QPushButton("Open data folder")
        b1.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(paths.data_dir()))))
        b2 = QPushButton("Wipe captured frames")
        b2.clicked.connect(self._wipe_frames)
        b3 = QPushButton("Wipe all agent memories")
        b3.clicked.connect(self._wipe_memories)
        b4 = QPushButton("Write config skeleton")
        b4.clicked.connect(self._init_config)
        for b in (b1, b2, b3, b4):
            row.addWidget(b)
        lay.addLayout(row)
        lay.addWidget(QLabel("Wipe deletes data permanently. Agent definitions are kept."))
        lay.addStretch(1)
        self.tabs.addTab(w, "Paths & data")

    # ------------------------------------------------------------------ #
    def _test(self, kind: ToolKind) -> None:
        self._apply_fields()  # test with what is on screen
        res = self.app.tools.test_send(kind)
        QMessageBox.information(self, "Test notification", f"{kind.value}: {'sent' if res.ok else 'failed'}\n{res.detail}")

    def _wipe_frames(self) -> None:
        if QMessageBox.question(self, "Wipe", "Delete all persisted frames?") == QMessageBox.StandardButton.Yes:
            n = self.app.frames.wipe()
            QMessageBox.information(self, "Wipe", f"Deleted {n} frame file(s).")

    def _wipe_memories(self) -> None:
        if QMessageBox.question(self, "Wipe", "Delete ALL agent memories?") == QMessageBox.StandardButton.Yes:
            n = self.app.memory.wipe()
            QMessageBox.information(self, "Wipe", f"Deleted {n} memory row(s).")

    def _init_config(self) -> None:
        from ..config import skeleton_toml

        target = paths.config_file()
        if target.exists():
            QMessageBox.information(self, "Config", f"{target} already exists; left untouched.")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(skeleton_toml(self.cfg), encoding="utf-8")
        os.chmod(target, 0o600)
        QMessageBox.information(self, "Config", f"Wrote {target} (mode 600).")

    def _apply_fields(self) -> None:
        for key, w in self.fields.items():
            section, attr = key.split(".", 1)
            target = getattr(self.cfg, section)
            if isinstance(w, QCheckBox):
                val = w.isChecked()
            elif isinstance(w, QPlainTextEdit):
                val = [line.strip() for line in w.toPlainText().splitlines() if line.strip()]
            elif isinstance(w, (QSpinBox, QDoubleSpinBox)):
                val = w.value()
            elif isinstance(w, QComboBox):
                val = w.currentText()
            else:
                val = w.text().strip()
                if attr == "port":
                    try:
                        val = int(val or 587)
                    except ValueError:
                        val = 587
            setattr(target, attr, val)

    def _save(self) -> None:
        self._apply_fields()
        self.cfg.save()
        # propagate to the live objects that captured the config at construction time
        from ..tools.registry import ToolRegistry

        self.app.tools = ToolRegistry(self.cfg, memory=self.app.memory)
        self.app.sensors.config = self.cfg
        self.app.frames.enabled = self.cfg.privacy.persist_frames
        self.app.frames.max_bytes = int(self.cfg.privacy.max_frames_mb * 1024 * 1024)
        self.app.events.record("settings saved (secrets masked in logs)", level="INFO", kind="settings")
        self.accept()


__all__ = ["SettingsDialog"]
