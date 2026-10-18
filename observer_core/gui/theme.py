"""Dark theme, inline SVG icons and small widget helpers. No external assets."""

from __future__ import annotations

from importlib import resources

from PyQt6.QtCore import QByteArray, QSize, Qt
from PyQt6.QtGui import QColor, QIcon, QPainter, QPixmap
from PyQt6.QtSvg import QSvgRenderer

BG = "#0D1117"
PANEL = "#161B22"
BORDER = "#30363D"
TEXT = "#E6EDF7"
MUTED = "#8B949E"
ACCENT = "#2F81F7"
OK = "#3FB950"
WARN = "#D29922"
ERR = "#F85149"

DARK_QSS = f"""
QWidget {{ background: {BG}; color: {TEXT}; font-size: 13px; }}
QMainWindow, QDialog {{ background: {BG}; }}
QGroupBox {{ border: 1px solid {BORDER}; border-radius: 6px; margin-top: 12px; padding: 8px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 10px; color: {MUTED}; }}
QLineEdit, QPlainTextEdit, QTextEdit, QComboBox, QSpinBox, QDoubleSpinBox {{
  background: {PANEL}; border: 1px solid {BORDER}; border-radius: 4px; padding: 4px; selection-background-color: {ACCENT};
}}
QPushButton {{ background: {PANEL}; border: 1px solid {BORDER}; border-radius: 4px; padding: 5px 10px; }}
QPushButton:hover {{ border-color: {ACCENT}; }}
QPushButton:disabled {{ color: {MUTED}; }}
QPushButton#primary {{ background: {ACCENT}; border-color: {ACCENT}; color: white; font-weight: 600; }}
QPushButton#danger {{ color: {ERR}; }}
QToolButton {{ background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 4px; }}
QToolButton:hover {{ border-color: {BORDER}; background: {PANEL}; }}
QToolButton:checked {{ border-color: {ACCENT}; background: {PANEL}; }}
QListWidget, QTableWidget, QTreeWidget {{ background: {PANEL}; border: 1px solid {BORDER}; border-radius: 4px; alternate-background-color: {BG}; }}
QListWidget::item:selected, QTableWidget::item:selected {{ background: {ACCENT}; color: white; }}
QTabWidget::pane {{ border: 1px solid {BORDER}; border-radius: 4px; }}
QTabBar::tab {{ background: {PANEL}; border: 1px solid {BORDER}; padding: 6px 12px; margin-right: 2px; border-top-left-radius: 4px; border-top-right-radius: 4px; }}
QTabBar::tab:selected {{ background: {BG}; border-bottom-color: {BG}; color: {ACCENT}; }}
QHeaderView::section {{ background: {PANEL}; color: {MUTED}; border: none; border-bottom: 1px solid {BORDER}; padding: 4px; }}
QProgressBar {{ background: {PANEL}; border: 1px solid {BORDER}; border-radius: 4px; text-align: center; }}
QProgressBar::chunk {{ background: {OK}; border-radius: 3px; }}
QSplitter::handle {{ background: {BORDER}; }}
QToolTip {{ background: {PANEL}; color: {TEXT}; border: 1px solid {BORDER}; }}
QStatusBar {{ border-top: 1px solid {BORDER}; color: {MUTED}; }}
QScrollBar:vertical {{ background: {BG}; width: 10px; }}
QScrollBar::handle:vertical {{ background: {BORDER}; border-radius: 4px; min-height: 20px; }}
QLabel#banner_cloud {{ background: #3D1212; color: #FFB4B0; border: 1px solid {ERR}; border-radius: 4px; padding: 6px; font-weight: 600; }}
QLabel#hint {{ color: {MUTED}; }}
QLabel#h2 {{ font-size: 15px; font-weight: 600; }}
"""


def icon(name: str, color: str | None = None, size: int = 18) -> QIcon:
    """Render a bundled SVG icon. Returns an empty icon if the resource is missing."""
    try:
        data = resources.files("observer_core.resources.icons").joinpath(f"{name}.svg").read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return QIcon()
    text = data.decode("utf-8")
    if color:
        text = text.replace('stroke="#E6EDF7"', f'stroke="{color}"')
    renderer = QSvgRenderer(QByteArray(text.encode("utf-8")))
    pm = QPixmap(QSize(size, size))
    pm.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pm)
    renderer.render(painter)
    painter.end()
    return QIcon(pm)


def led_pixmap(color: str, size: int = 12) -> QPixmap:
    pm = QPixmap(QSize(size, size))
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QColor(color))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(1, 1, size - 2, size - 2)
    p.end()
    return pm


def pill_style(status: str) -> str:
    color = {"ok": OK, "degraded": WARN, "unavailable": ERR, "error": ERR}.get(status, MUTED)
    return (f"QLabel {{ background: transparent; color: {color}; border: 1px solid {color};"
            f" border-radius: 9px; padding: 2px 8px; font-weight: 600; }}")


LEVEL_COLORS = {"DEBUG": MUTED, "INFO": TEXT, "OK": OK, "WARN": WARN, "ERROR": ERR}
