"""Command line: `observer-core run | daemon | init-config | doctor | agent ... | notify-test`."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from . import __app_name__, __version__, paths
from .config import skeleton_toml

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Observer Core — local-first micro-agents that sense your screen, camera and audio.",
)
agent_app = typer.Typer(help="Manage agent definitions.", no_args_is_help=True)
app.add_typer(agent_app, name="agent")
console = Console()


def _app():
    from .app import ObserverApp
    from .logging_setup import setup_logging

    setup_logging()
    app = ObserverApp()
    app.seed_examples()   # first run: bundled examples are imported (disabled)
    return app


@app.command()
def run() -> None:
    """Launch the graphical interface (default when run with no command)."""
    from .gui_entry import launch_gui_or_explain

    sys.exit(launch_gui_or_explain())


@app.command()
def daemon() -> None:
    """Run enabled agents headless (no GUI)."""
    from .daemon import run_daemon

    sys.exit(run_daemon())


@app.command("init-config")
def init_config(force: bool = typer.Option(False, "--force", help="Overwrite (a backup is kept).")) -> None:
    """Write a commented config.toml skeleton. Never overwrites unless --force."""
    paths.ensure_dirs()
    target = paths.config_file()
    if target.exists() and not force:
        console.print(f"[yellow]exists:[/] {target} (left untouched — use --force to replace; a .bak is kept)")
        raise typer.Exit(0)
    if target.exists():
        target.replace(target.with_suffix(".toml.bak"))
    target.write_text(skeleton_toml(), encoding="utf-8")
    import os

    os.chmod(target, 0o600)
    console.print(f"[green]wrote[/] {target} (mode 600)")


@app.command()
def doctor(
    json_out: bool = typer.Option(False, "--json", help="Machine-readable output."),
    no_model: bool = typer.Option(False, "--no-model", help="Skip the inference endpoint probe."),
) -> None:
    """Print a full environment report: OS, session, sensors, tools, model endpoint."""
    from .doctor import collect_diagnostics, render_text

    diags = collect_diagnostics(None, include_model=not no_model)
    if json_out:
        print(json.dumps([d.model_dump() for d in diags], indent=2))
    else:
        print(render_text(diags))
    # Exit 0 for any completed report; 1 only when a hard error was found.
    raise typer.Exit(1 if any(d.status == "error" for d in diags) else 0)


@app.command()
def version() -> None:
    """Print the version."""
    console.print(f"{__app_name__} {__version__}")


@app.command("notify-test")
def notify_test(channel: str = typer.Argument("desktop_notify", help="telegram|discord|whatsapp|sms|phone_call|email|pushover|desktop_notify|http_webhook")) -> None:
    """Send a test message through one channel (no model involved)."""
    a = _app()
    res = a.test_notification(channel)
    style = "green" if res["ok"] else "red"
    console.print(f"[{style}]{channel}[/]: {res['detail']}")
    a.close()
    raise typer.Exit(0 if res["ok"] else 1)


@app.command("install-desktop")
def install_desktop() -> None:
    """Install the .desktop launcher, systemd user unit and AppStream metainfo (no root)."""
    from .install import install_desktop_files

    for line in install_desktop_files():
        console.print(line)


@agent_app.command("list")
def agent_list() -> None:
    """List agents."""
    a = _app()
    table = Table(title="Agents")
    for col in ("id", "name", "enabled", "sensors", "tools", "provider"):
        table.add_column(col)
    for ag in a.agents.list():
        table.add_row(ag.id, ag.name, "yes" if ag.enabled else "no",
                      ",".join(s.kind.value for s in ag.sensors), ",".join(t.kind.value for t in ag.tools),
                      ag.model.provider)
    console.print(table)
    a.close()


@agent_app.command("import")
def agent_import(path: Path) -> None:
    """Import an agent from YAML or JSON."""
    a = _app()
    ag = a.agents.import_file(path)
    console.print(f"[green]imported[/] {ag.id} ({ag.name})")
    a.close()


@agent_app.command("export")
def agent_export(agent_id: str, dest: Path) -> None:
    """Export an agent to YAML (.yaml/.yml) or JSON (.json)."""
    a = _app()
    out = a.agents.export_file(agent_id, dest)
    console.print(f"[green]exported[/] {out}")
    a.close()


@agent_app.command("enable")
def agent_enable(agent_id: str, off: bool = typer.Option(False, "--off")) -> None:
    """Enable (or with --off, disable) an agent for the daemon."""
    a = _app()
    ag = a.agents.get(agent_id)
    if not ag:
        console.print(f"[red]no such agent:[/] {agent_id}")
        raise typer.Exit(1)
    ag.enabled = not off
    a.agents.save(ag)
    console.print(f"{ag.id}: enabled={ag.enabled}")
    a.close()


@agent_app.command("delete")
def agent_delete(agent_id: str, yes: bool = typer.Option(False, "--yes")) -> None:
    """Delete an agent (asks for confirmation unless --yes)."""
    if not yes and not typer.confirm(f"Delete agent {agent_id}?"):
        raise typer.Exit(1)
    a = _app()
    a.agents.delete(agent_id)
    a.close()
    console.print("deleted")


@agent_app.command("run-once")
def agent_run_once(agent_id: str, dry_run: bool = typer.Option(False, "--dry-run")) -> None:
    """Run one cycle for an agent now and print the parsed plan."""
    import asyncio

    a = _app()
    ag = a.agents.get(agent_id)
    if not ag:
        console.print(f"[red]no such agent:[/] {agent_id}")
        raise typer.Exit(1)
    rt = a.build_runtime(ag)
    rt.dry_run = dry_run
    res = asyncio.run(rt.cycle())
    console.print_json(data=json.loads(res.model_dump_json(exclude={"prompt_text"})))
    a.close()


@agent_app.command("wizard")
def agent_wizard(
    observe: str = typer.Argument(..., help="What do you want me to observe?"),
    preset: Optional[str] = typer.Option(None, help="Preset key, e.g. github_workflow"),
    action: Optional[str] = typer.Option(None, help="whatsapp|sms|call|telegram|discord|log|email"),
    name: str = typer.Option("", help="Agent name"),
) -> None:
    """Create an agent from a plain-language request (same logic as the GUI wizard)."""
    from .presets import build_agent

    a = _app()
    ag = build_agent(name=name or observe[:40], observe=observe, preset_key=preset, action=action)
    a.agents.save(ag)
    console.print(f"[green]created[/] {ag.id} — disabled until you enable it")
    a.close()


def main() -> None:
    if len(sys.argv) == 1:
        sys.argv.append("run")
    app()


if __name__ == "__main__":
    main()
