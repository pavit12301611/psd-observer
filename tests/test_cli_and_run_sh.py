"""CLI behaviour and run.sh contract (syntax, --help, --version, exit codes, idempotent setup)."""

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUN_SH = ROOT / "run.sh"


def _env(**extra):
    env = dict(os.environ)
    env.pop("DISPLAY", None)
    env.pop("WAYLAND_DISPLAY", None)
    env.update(extra)
    return env


def _run(args, timeout=120, **extra):
    return subprocess.run(["bash", str(RUN_SH), *args], capture_output=True, text=True,
                          timeout=timeout, env=_env(**extra), cwd=ROOT)


def test_run_sh_is_executable_and_bash_clean():
    assert RUN_SH.exists()
    assert os.access(RUN_SH, os.X_OK)
    assert stat.S_IMODE(RUN_SH.stat().st_mode) & 0o111
    res = subprocess.run(["bash", "-n", str(RUN_SH)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_run_sh_uses_strict_mode():
    head = RUN_SH.read_text(encoding="utf-8").splitlines()[:20]
    assert any(line.strip() == "set -euo pipefail" for line in head)


@pytest.mark.parametrize("flag", ["--setup", "--reinstall", "--no-system-deps", "--with-ollama",
                                  "--skip-pip", "--doctor", "--daemon", "--dev"])
def test_help_documents_every_flag(flag):
    res = _run(["--help"])
    assert res.returncode == 0
    assert flag in res.stdout


def test_version_flag():
    res = _run(["--version"])
    assert res.returncode == 0
    assert "Observer Core" in res.stdout


def test_unknown_option_exits_1():
    res = _run(["--definitely-not-a-flag"])
    assert res.returncode == 1


def test_python_too_old_exits_3():
    res = _run(["--setup", "--no-system-deps", "--skip-pip"], OBSERVER_CORE_MIN_PY="9.9")
    assert res.returncode == 3
    assert "Python >= 9.9" in res.stderr


def test_refuses_nonsense_venv_path(tmp_path):
    res = _run(["--setup", "--no-system-deps", "--skip-pip"], OBSERVER_CORE_VENV="/",
               OBSERVER_CORE_MIN_PY="3.8")
    assert res.returncode == 1
    assert "Refusing" in res.stderr


@pytest.mark.skipif(shutil.which("python3") is None, reason="needs python3")
def test_setup_creates_venv_and_is_idempotent(tmp_path):
    venv = tmp_path / "venv"
    base = dict(OBSERVER_CORE_VENV=str(venv), OBSERVER_CORE_MIN_PY="3.8",
                XDG_CONFIG_HOME=str(tmp_path / "c"), XDG_DATA_HOME=str(tmp_path / "d"),
                XDG_STATE_HOME=str(tmp_path / "s"), XDG_CACHE_HOME=str(tmp_path / "k"))
    first = _run(["--setup", "--no-system-deps", "--skip-pip"], **base)
    assert first.returncode == 0, first.stdout + first.stderr
    assert (venv / "bin" / "python").exists()
    assert (tmp_path / "c" / "observer-core").is_dir()    # XDG dirs are created even without deps
    second = _run(["--setup", "--no-system-deps", "--skip-pip"], **base)
    assert second.returncode == 0


def test_doctor_runs_and_reports(tmp_path):
    """Uses the interpreter running the tests as the venv, so no network is needed."""
    venv = Path(sys.prefix)
    if not (venv / "bin" / "observer-core").exists() and not (venv / "bin" / "python").exists():
        pytest.skip("not running inside a virtualenv")
    res = _run(["--doctor", "--no-system-deps", "--skip-pip"], timeout=120,
               OBSERVER_CORE_VENV=str(venv), OBSERVER_CORE_MIN_PY="3.8",
               XDG_CONFIG_HOME=str(tmp_path / "c"), XDG_DATA_HOME=str(tmp_path / "d"),
               XDG_STATE_HOME=str(tmp_path / "s"), XDG_CACHE_HOME=str(tmp_path / "k"))
    assert res.returncode == 0, res.stdout + res.stderr
    assert "environment report" in res.stdout and "Summary:" in res.stdout


def test_cli_init_config_never_overwrites(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from observer_core.cli import app

    runner = CliRunner()
    r1 = runner.invoke(app, ["init-config"])
    assert r1.exit_code == 0
    from observer_core import paths
    target = paths.config_file()
    target.write_text('[models]\nprovider = "ollama"\n# user edit\n', encoding="utf-8")
    r2 = runner.invoke(app, ["init-config"])
    assert r2.exit_code == 0 and "left untouched" in r2.output
    assert "# user edit" in target.read_text(encoding="utf-8")
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600


def test_cli_agent_wizard_and_list(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app

    runner = CliRunner()
    r = runner.invoke(app, ["agent", "wizard", "tell me when the print is done", "--preset", "printer_fails",
                            "--action", "telegram", "--name", "Printer"])
    assert r.exit_code == 0, r.output
    r2 = runner.invoke(app, ["agent", "list"])
    assert "Printer" in r2.output


def test_gui_refuses_to_start_without_display(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    from observer_core.gui_entry import launch_gui_or_explain

    assert launch_gui_or_explain() == 2


def test_gui_modules_import_when_qt_is_available():
    """Headless Qt smoke test (QT_QPA_PLATFORM=offscreen). Skipped where Qt cannot load."""
    import importlib

    try:
        from PyQt6.QtWidgets import QApplication  # noqa: F401
    except ImportError as exc:  # missing libGL / xkb in minimal containers
        pytest.skip(f"Qt widgets not loadable here: {exc}")
    for mod in ("observer_core.gui.theme", "observer_core.gui.bridge", "observer_core.gui.sensor_panel",
                "observer_core.gui.agent_list", "observer_core.gui.agent_editor", "observer_core.gui.wizard",
                "observer_core.gui.log_console", "observer_core.gui.diagnostics_view",
                "observer_core.gui.settings_dialog", "observer_core.gui.tray", "observer_core.gui.main_window"):
        try:
            importlib.import_module(mod)
        except ImportError as exc:
            pytest.skip(f"{mod} needs system Qt libraries: {exc}")
