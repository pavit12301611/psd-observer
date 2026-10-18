"""Install desktop integration into the user's home — no root required.

Writes:
* ~/.local/share/applications/observer-core.desktop
* ~/.config/systemd/user/observer-core-daemon.service  (only if systemd --user exists)
* ~/.local/share/metainfo/io.github.observer_core.metainfo.xml

Paths inside the templates are rewritten to the current interpreter and repo.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from . import paths

INSTALL_DIR = paths.repo_root() / "install"


def _render(text: str) -> str:
    venv_bin = Path(sys.executable).parent
    text = text.replace("@EXEC@", str(venv_bin / "observer-core"))
    text = text.replace("@DAEMON@", str(venv_bin / "observer-core-daemon"))
    text = text.replace("@REPO@", str(paths.repo_root()))
    return text


def install_desktop_files(home: Path | None = None) -> list[str]:
    home = Path(home) if home else Path(os.path.expanduser("~"))
    msgs: list[str] = []

    apps = home / ".local" / "share" / "applications"
    apps.mkdir(parents=True, exist_ok=True)
    desk = apps / "observer-core.desktop"
    desk.write_text(_render((INSTALL_DIR / "observer-core.desktop").read_text(encoding="utf-8")), encoding="utf-8")
    msgs.append(f"installed {desk}")

    meta = home / ".local" / "share" / "metainfo"
    meta.mkdir(parents=True, exist_ok=True)
    mi = meta / "io.github.observer_core.metainfo.xml"
    shutil.copyfile(INSTALL_DIR / "metainfo.xml", mi)
    msgs.append(f"installed {mi}")

    if shutil.which("systemctl"):
        unit_dir = home / ".config" / "systemd" / "user"
        unit_dir.mkdir(parents=True, exist_ok=True)
        unit = unit_dir / "observer-core-daemon.service"
        unit.write_text(_render((INSTALL_DIR / "observer-core-daemon.service").read_text(encoding="utf-8")), encoding="utf-8")
        msgs.append(f"installed {unit}")
        msgs.append("enable with:  systemctl --user daemon-reload && systemctl --user enable --now observer-core-daemon")
    else:
        msgs.append("systemd not found — skipped the user unit")

    return msgs


__all__ = ["install_desktop_files"]
