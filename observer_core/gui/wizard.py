"""'What do you want me to Observe?' — the When → Then starter wizard."""

from __future__ import annotations

from PyQt6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFormLayout, QLabel,
                             QLineEdit, QVBoxLayout)

from ..models import AgentDef
from ..presets import ACTION_CHOICES, PRESETS, build_agent


class ObserveWizard(QDialog):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("What do you want me to Observe?")
        self.setMinimumWidth(520)
        self.result_agent: AgentDef | None = None

        root = QVBoxLayout(self)
        title = QLabel("<b>What do you want me to Observe?</b>")
        title.setObjectName("h2")
        root.addWidget(title)
        root.addWidget(QLabel("Describe it in your own words, pick a When and a Then. "
                              "The agent is created <i>disabled</i> so you can review it first."))

        form = QFormLayout()
        self.name = QLineEdit()
        self.name.setPlaceholderText("e.g. Printer watch")
        self.observe = QLineEdit()
        self.observe.setPlaceholderText("e.g. tell me when the print is done")
        self.when = QComboBox()
        self.when.addItem("Custom (use my words only)", None)
        for p in PRESETS:
            self.when.addItem(f"When: {p.label}", p.key)
        self.then = QComboBox()
        labels = {"whatsapp": "WhatsApp", "sms": "SMS", "call": "Phone call", "telegram": "Telegram",
                  "discord": "Discord", "log": "Desktop notification + log", "email": "Email", "notify": "Desktop notification"}
        for key, kind in ACTION_CHOICES.items():
            self.then.addItem(f"Then: {labels.get(key, key)}", key)
        self.interval = QDoubleSpinBox()
        self.interval.setRange(1, 3600)
        self.interval.setValue(30)
        self.interval.setSuffix(" s between checks")
        form.addRow("Name", self.name)
        form.addRow("Observe", self.observe)
        form.addRow("When", self.when)
        form.addRow("Then", self.then)
        form.addRow("Interval", self.interval)
        root.addLayout(form)

        self.hint = QLabel("")
        self.hint.setObjectName("hint")
        self.hint.setWordWrap(True)
        root.addWidget(self.hint)
        self.when.currentIndexChanged.connect(self._update_hint)
        self._update_hint()

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Create agent")
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

    def _update_hint(self) -> None:
        key = self.when.currentData()
        if key is None:
            self.hint.setText("Your sentence is used as the condition. Vision sensors are chosen automatically when needed.")
            return
        from ..presets import preset_by_key

        p = preset_by_key(key)
        sensors = ", ".join(s.value for s in p.sensors)
        self.hint.setText(f"Watches: {sensors}. Condition: {p.condition}.")

    def _accept(self) -> None:
        if not self.observe.text().strip() and self.when.currentData() is None:
            self.hint.setText("Describe what to observe, or pick a When preset.")
            return
        self.result_agent = build_agent(
            name=self.name.text().strip() or (self.when.currentText().replace("When: ", "") or "New agent"),
            observe=self.observe.text(),
            preset_key=self.when.currentData(),
            action=self.then.currentData(),
            interval_s=self.interval.value(),
        )
        self.accept()


__all__ = ["ObserveWizard"]
