"""Shared fixtures. Every test runs with isolated XDG dirs, no display, no network."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Headless Qt and no accidental display use, for every test.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.pop("DISPLAY", None)
os.environ.pop("WAYLAND_DISPLAY", None)


@pytest.fixture(autouse=True)
def isolated_xdg(tmp_path, monkeypatch):
    """Point every XDG dir at tmp_path and clear the paths cache."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    from observer_core import config as cfgmod
    from observer_core import paths

    for fn in ("home_dir", "config_dir", "data_dir", "state_dir", "cache_dir", "repo_root"):
        getattr(paths, fn).cache_clear()
    cfgmod.set_active_config(None)
    yield tmp_path
    cfgmod.set_active_config(None)


@pytest.fixture
def cfg():
    from observer_core.config import AppConfig

    return AppConfig()


@pytest.fixture
def db(tmp_path):
    from observer_core.storage.db import Database

    d = Database(tmp_path / "t.db")
    yield d
    d.close()


@pytest.fixture
def memory(db):
    from observer_core.runtime.memory_store import MemoryStore

    return MemoryStore(db)
