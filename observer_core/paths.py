"""XDG directory handling.

All user-facing files live under the standard XDG locations so the app behaves
like a well-mannered Linux citizen:

=======================  ============================================
purpose                  location (defaults)
=======================  ============================================
config                   ``~/.config/observer-core``
data (db, frames, mem)   ``~/.local/share/observer-core``
state (logs, events)     ``~/.local/state/observer-core``
cache                    ``~/.cache/observer-core``
=======================  ============================================

Every directory is created lazily and with mode ``0700`` for the two that can
contain secrets/captured data (config and data).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

APP_ID = "observer-core"


def _xdg(env_var: str, fallback: Path) -> Path:
    raw = os.environ.get(env_var)
    if raw:
        # XDG_CONFIG_HOME may be a ':'-separated list in weird setups; take first.
        return Path(raw.split(":", 1)[0]).expanduser()
    return fallback


@lru_cache(maxsize=1)
def home_dir() -> Path:
    return Path(os.path.expanduser("~"))


@lru_cache(maxsize=1)
def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", home_dir() / ".config") / APP_ID


@lru_cache(maxsize=1)
def data_dir() -> Path:
    return _xdg("XDG_DATA_HOME", home_dir() / ".local" / "share") / APP_ID


@lru_cache(maxsize=1)
def state_dir() -> Path:
    return _xdg("XDG_STATE_HOME", home_dir() / ".local" / "state") / APP_ID


@lru_cache(maxsize=1)
def cache_dir() -> Path:
    return _xdg("XDG_CACHE_HOME", home_dir() / ".cache") / APP_ID


def ensure_dirs() -> dict[str, Path]:
    """Create every XDG directory Observer Core needs and return them."""
    out: dict[str, Path] = {
        "config": config_dir(),
        "data": data_dir(),
        "state": state_dir(),
        "cache": cache_dir(),
    }
    for name, path in out.items():
        path.mkdir(parents=True, exist_ok=True)
        if name in ("config", "data"):
            try:
                os.chmod(path, 0o700)
            except OSError:  # pragma: no cover - exotic filesystem
                pass
    # Sub-directories used by features.
    for sub in (
        data_dir() / "frames",
        data_dir() / "recordings",
        data_dir() / "agents",
        state_dir() / "logs",
        cache_dir() / "audio",
    ):
        sub.mkdir(parents=True, exist_ok=True)
    out["frames"] = data_dir() / "frames"
    out["recordings"] = data_dir() / "recordings"
    out["agents"] = data_dir() / "agents"
    out["logs"] = state_dir() / "logs"
    return out


def config_file() -> Path:
    return config_dir() / "config.toml"


def db_file() -> Path:
    return data_dir() / "observer.db"


def log_dir() -> Path:
    return state_dir() / "logs"


def frames_dir() -> Path:
    return data_dir() / "frames"


def recordings_dir() -> Path:
    return data_dir() / "recordings"


def agents_dir() -> Path:
    return data_dir() / "agents"


def event_log_file() -> Path:
    return state_dir() / "events.jsonl"


def venv_dir() -> Path:
    """Where ``run.sh`` puts the virtualenv (dev mode: ``<repo>/.venv``)."""
    env = os.environ.get("OBSERVER_CORE_VENV")
    if env:
        return Path(env).expanduser()
    return repo_root() / ".venv"


@lru_cache(maxsize=1)
def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def system_requirement_file() -> Path:
    return repo_root() / "requirements-system-fedora.txt"
