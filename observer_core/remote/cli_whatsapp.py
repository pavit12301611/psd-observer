"""`observer-core whatsapp ...` — set up, pair and run the WhatsApp remote.

Exit codes: 0 ok · 1 runtime failure (not paired, mismatch, timeout) · 2 config or missing dependency.
"""

from __future__ import annotations

import signal
import sys
import threading
import time


import typer
from rich.console import Console

from .. import paths
from ..config import load_or_create
from .phone import PhoneError, mask_phone, normalize_phone
from .service import RemoteConfigError, WhatsAppService, session_path, validated_numbers

whatsapp_app = typer.Typer(help="Control this computer from WhatsApp (see README: WhatsApp remote).",
                           no_args_is_help=True)
console = Console()

PAIR_TIMEOUT_S = 240
CONNECT_TIMEOUT_S = 60


def _uses_remote_model(cfg) -> bool:
    """True when instructions would leave the machine to a model host (cloud or non-local endpoint)."""
    from urllib.parse import urlparse

    if cfg.models.provider == "cloud":
        return True
    if cfg.models.provider == "openai_compat":
        host = (urlparse(cfg.models.openai_endpoint or "").hostname or "").lower()
        return host not in ("localhost", "127.0.0.1", "::1", "")
    return False


def _print_qr(code: str) -> None:
    try:
        import segno

        segno.make_qr(code).terminal(out=sys.stdout, compact=True)
    except Exception:
        console.print(f"[yellow]QR text (could not draw):[/] {code[:80]}...")


def _status(text: str) -> None:
    console.print(f"[dim]{time.strftime('%H:%M:%S')}[/] {text}")


def _wait_connected(service: WhatsAppService, timeout: float) -> bool:
    """Wait for the link. Gives up early when the library reports a connection error."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if service.transport.connected.wait(0.5):
            return True
        if service.transport.mismatch or service.transport.last_error:
            return False
    return service.transport.connected.is_set()


def _die(message: str, code: int = 2) -> None:
    console.print(f"[red]error:[/] {message}")
    raise typer.Exit(code)


@whatsapp_app.command("setup")
def setup(
    agent: str = typer.Option(..., "--agent", help="WhatsApp number the agent runs on, e.g. 8859555795"),
    allow: str = typer.Option(..., "--allow", help="The ONLY number allowed to give instructions, e.g. 9528923866"),
    country: str = typer.Option("91", "--country", help="Country code used when a number has none"),
) -> None:
    """Save the two numbers and enable the remote. Does not connect; run `pair` next."""
    paths.ensure_dirs()
    cfg = load_or_create(create=True)
    try:
        cfg.whatsapp.country_code = country.lstrip("+") or "91"
        cfg.whatsapp.agent_number = agent.strip()
        cfg.whatsapp.allowed_number = allow.strip()
        validated_numbers(cfg)
    except (RemoteConfigError, PhoneError) as exc:
        _die(str(exc))
    cfg.whatsapp.enabled = True
    cfg.save()
    console.print(f"[green]saved[/] WhatsApp remote enabled: agent {mask_phone(normalize_phone(agent, country))}, "
                  f"allowed sender {mask_phone(normalize_phone(allow, country))}")
    if _uses_remote_model(cfg):
        console.print("[yellow]note:[/] your model provider is a cloud endpoint. Instructions and command output "
                      "will be sent to it. Switch to a local provider for private use.")
    console.print("Next: [bold]observer-core whatsapp pair[/] (scan the QR code with the agent phone).")


@whatsapp_app.command("status")
def status() -> None:
    """Show the configuration and what is installed. Makes no network connection."""
    from .whatsapp import WhatsAppUnavailable, _load_neonize

    cfg = load_or_create()
    w = cfg.whatsapp
    console.print(f"enabled:        {w.enabled}")
    console.print(f"agent number:   {mask_phone(w.agent_number) or '(not set)'}")
    console.print(f"allowed sender: {mask_phone(w.allowed_number) or '(not set)'}")
    console.print(f"country code:   +{w.country_code}")
    console.print(f"model provider: {cfg.models.provider}{' (CLOUD)' if cfg.models.provider == 'cloud' else ''}")
    console.print(f"session paired: {'yes' if session_path().exists() else 'no'}  ({session_path()})")
    try:
        validated_numbers(cfg)
        console.print("numbers:        [green]valid[/]")
    except RemoteConfigError as exc:
        console.print(f"numbers:        [red]{exc}[/]")
    try:
        _load_neonize()
        console.print("neonize:        [green]installed[/]")
    except WhatsAppUnavailable as exc:
        console.print(f"neonize:        [red]unavailable[/] — {exc}")


@whatsapp_app.command("pair")
def pair(timeout: int = typer.Option(PAIR_TIMEOUT_S, help="Seconds to wait for the QR scan")) -> None:
    """Link the agent number to this computer by scanning the QR code once."""
    from .whatsapp import WhatsAppUnavailable

    cfg = load_or_create()
    try:
        service = WhatsAppService(cfg, on_status=_status, on_qr=_print_qr)
    except RemoteConfigError as exc:
        _die(str(exc))
    try:
        service.start()
    except WhatsAppUnavailable as exc:
        _die(str(exc))
    try:
        ok = _wait_connected(service, timeout)
        if service.transport.mismatch:
            _die(service.transport.last_error or "wrong linked account", 1)
        if not ok:
            reason = service.transport.last_error or f"not paired within {timeout}s"
            _die(f"{reason}. Run pair again.", 1)
        console.print("[green]paired.[/] Start the agent with: [bold]observer-core whatsapp run[/]")
    finally:
        service.stop()


@whatsapp_app.command("run")
def run() -> None:
    """Listen for instructions from the allowed number until Ctrl-C."""
    from .whatsapp import WhatsAppUnavailable

    cfg = load_or_create()
    if not cfg.whatsapp.enabled:
        _die("WhatsApp remote is disabled. Run `observer-core whatsapp setup` first.")
    if not session_path().exists():
        _die("not paired yet. Run `observer-core whatsapp pair` first.")
    try:
        service = WhatsAppService(cfg, on_status=_status, on_qr=_print_qr)
    except RemoteConfigError as exc:
        _die(str(exc))
    stop_event = threading.Event()

    def _sigint(_signum, _frame):
        stop_event.set()

    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)
    try:
        service.start()
    except WhatsAppUnavailable as exc:
        _die(str(exc))
    if not _wait_connected(service, CONNECT_TIMEOUT_S):
        service.stop()
        _die(service.transport.last_error or f"could not connect within {CONNECT_TIMEOUT_S}s", 1)
    try:
        service.transport.send_text(service.owner_user,
                                    "🟢 Observer is online. Send me an instruction. "
                                    "Each command is shown to you and runs only after YES.")
    except Exception as exc:
        _status(f"could not send the online message: {exc}")
    _status(f"listening for instructions from {mask_phone(service.owner_user)} (Ctrl-C to stop)")
    while not stop_event.wait(1.0):
        if service.transport.mismatch:
            break
    service.stop()
    _status("stopped")


@whatsapp_app.command("disable")
def disable() -> None:
    """Turn the remote off. The pairing is kept, so `run` works again after `setup`."""
    cfg = load_or_create(create=True)
    cfg.whatsapp.enabled = False
    cfg.save()
    console.print("[green]WhatsApp remote disabled.[/]")


@whatsapp_app.command("unpair")
def unpair(yes: bool = typer.Option(False, "--yes", help="Required: forget the linked-device session")) -> None:
    """Delete the local WhatsApp session. You will need to scan the QR code again."""
    if not yes:
        _die("refusing without --yes (this deletes the local session keys)")
    removed = 0
    for path in session_path().parent.glob(session_path().name + "*"):
        path.unlink(missing_ok=True)
        removed += 1
    console.print(f"[green]removed {removed} session file(s).[/] Unlink the device in WhatsApp too if you like.")


__all__ = ["whatsapp_app"]
