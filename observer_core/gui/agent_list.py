"""Left column: agent list with the toolbar (New, Duplicate, Import, Export, Enable, Delete) and search."""

from __future__ import annotations

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (QFileDialog, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
                             QMessageBox, QToolButton, QVBoxLayout, QWidget)

from ..models import AgentDef
from .theme import ERR, MUTED, OK, icon


class AgentList(QWidget):
    selected = pyqtSignal(object)           # AgentDef or None
    new_requested = pyqtSignal()
    duplicate_requested = pyqtSignal(str)
    import_requested = pyqtSignal(str)
    export_requested = pyqtSignal(str, str)
    toggle_requested = pyqtSignal(str, bool)
    delete_requested = pyqtSignal(str)

    def __init__(self, app, parent=None) -> None:
        super().__init__(parent)
        self.app = app
        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)

        bar = QHBoxLayout()
        self.btn_new = self._tool("plus", "New agent (What do you want me to Observe?)", self.new_requested.emit)
        self.btn_dup = self._tool("copy", "Duplicate", lambda: self._emit(self.duplicate_requested))
        self.btn_imp = self._tool("import", "Import YAML / JSON", self._import)
        self.btn_exp = self._tool("export", "Export YAML / JSON", self._export)
        self.btn_toggle = self._tool("play", "Enable / disable", lambda: self._toggle())
        self.btn_del = self._tool("trash", "Delete (asks first)", lambda: self._delete())
        for b in (self.btn_new, self.btn_dup, self.btn_imp, self.btn_exp, self.btn_toggle, self.btn_del):
            bar.addWidget(b)
        bar.addStretch(1)
        lay.addLayout(bar)

        self.search = QLineEdit()
        self.search.setPlaceholderText("Search agents…")
        self.search.textChanged.connect(self.refresh)
        lay.addWidget(self.search)

        self.list = QListWidget()
        self.list.currentItemChanged.connect(self._on_change)
        lay.addWidget(self.list, 1)

        self.summary = QLabel("Select an agent to see its summary.")
        self.summary.setWordWrap(True)
        self.summary.setObjectName("hint")
        self.summary.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(self.summary)
        self.refresh()

    # ------------------------------------------------------------------ #
    def _tool(self, icon_name: str, tip: str, slot) -> QToolButton:
        b = QToolButton()
        b.setIcon(icon(icon_name))
        b.setToolTip(tip)
        b.clicked.connect(slot)
        return b

    def _emit(self, sig) -> None:
        agent = self.current()
        if agent:
            sig.emit(agent.id)

    def current(self) -> AgentDef | None:
        item = self.list.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def select(self, agent_id: str) -> None:
        for i in range(self.list.count()):
            it = self.list.item(i)
            if it.data(Qt.ItemDataRole.UserRole).id == agent_id:
                self.list.setCurrentItem(it)
                return

    def refresh(self) -> None:
        keep = self.current().id if self.current() else None
        self.list.blockSignals(True)
        self.list.clear()
        needle = self.search.text().strip().lower()
        for ag in self.app.agents.list():
            hay = f"{ag.name} {ag.description} {' '.join(ag.tags)}".lower()
            if needle and needle not in hay:
                continue
            item = QListWidgetItem(("● " if ag.enabled else "○ ") + ag.name)
            item.setData(Qt.ItemDataRole.UserRole, ag)
            item.setToolTip(ag.description or ag.id)
            item.setForeground(_color(OK if ag.enabled else MUTED))
            self.list.addItem(item)
        self.list.blockSignals(False)
        if keep:
            self.select(keep)
        if self.list.currentItem() is None:
            self._on_change(None, None)

    def _on_change(self, cur, _prev) -> None:
        agent = cur.data(Qt.ItemDataRole.UserRole) if cur else None
        self.btn_toggle.setIcon(icon("stop" if agent and agent.enabled else "play"))
        if agent is None:
            self.summary.setText("Select an agent to see its summary.")
        else:
            sensors = ", ".join(s.kind.value for s in agent.sensors if s.enabled) or "none"
            tools = ", ".join(t.kind.value for t in agent.tools if t.enabled) or "none"
            self.summary.setText(
                f"<b>{agent.name}</b><br>"
                f"<span style='color:{MUTED}'>{agent.description or '—'}</span><br>"
                f"sensors: {sensors}<br>tools: {tools}<br>"
                f"model: {agent.model.provider}/{agent.model.model} · every {agent.loop_interval_s:.0f}s<br>"
                f"status: <span style='color:{OK if agent.enabled else ERR}'>{'enabled' if agent.enabled else 'disabled'}</span>"
            )
        self.selected.emit(agent)

    def _toggle(self) -> None:
        agent = self.current()
        if agent:
            self.toggle_requested.emit(agent.id, not agent.enabled)

    def _delete(self) -> None:
        agent = self.current()
        if not agent:
            return
        ans = QMessageBox.question(self, "Delete agent", f"Delete “{agent.name}” and its YAML file?\n"
                                   "Memories are kept until you wipe them in Settings.")
        if ans == QMessageBox.StandardButton.Yes:
            self.delete_requested.emit(agent.id)

    def _import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import agent", "", "Agents (*.yaml *.yml *.json)")
        if path:
            self.import_requested.emit(path)

    def _export(self) -> None:
        agent = self.current()
        if not agent:
            return
        path, _ = QFileDialog.getSaveFileName(self, "Export agent", f"{agent.id}.yaml", "YAML (*.yaml);;JSON (*.json)")
        if path:
            self.export_requested.emit(agent.id, path)


def _color(hex_: str):
    from PyQt6.QtGui import QBrush, QColor

    return QBrush(QColor(hex_))


__all__ = ["AgentList"]
