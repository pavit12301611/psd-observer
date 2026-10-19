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
    from .routines import EXAMPLE_ROUTINES
    from .service import routines_path

    if not routines_path().exists():
        routines_path().parent.mkdir(parents=True, exist_ok=True)
        routines_path().write_text(EXAMPLE_ROUTINES, encoding="utf-8")
        console.print(f"[dim]wrote example routines: {routines_path()} (edit it to add your own)[/]")
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
    from .routines import load_routines
    from .service import routines_path

    routines, route_errors = load_routines(routines_path())
    console.print(f"routines:       {len(routines)} valid ({routines_path()})")
    for err in route_errors:
        console.print(f"                [red]{err}[/]")
    from .browser import find_chromium

    console.print(f"arena browser:  {'on' if w.browser_enabled else 'off'}; "
                  f"chromium: {find_chromium() or 'not found (sudo dnf install --needed chromium)'}")
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


@whatsapp_app.command("model-advice")
def model_advice_cmd() -> None:
    """Suggest a local model for browser and WhatsApp jobs, based on this machine."""
    from .model_advice import advice_lines, detect_hardware, recommend

    cfg = load_or_create()
    hw = detect_hardware()
    adv = recommend(hw)
    for line in advice_lines(hw, adv, cfg.models.ollama_model if cfg.models.provider == "ollama"
                             else f"{cfg.models.provider} (not Ollama)"):
        console.print(line, markup=False)


@whatsapp_app.command("routines")
def routines_cmd() -> None:
    """List the routines in routines.toml and any problems with them."""
    from .routines import load_routines
    from .service import routines_path

    routines, errors = load_routines(routines_path())
    if not routines and not errors:
        console.print(f"No routines yet. Edit {routines_path()} (run `whatsapp setup` for an example).")
    for r in routines.values():
        console.print(f"[bold]{r.name}[/] — {r.description}")
        for line in r.plan_lines():
            console.print(f"    {line}")
    for err in errors:
        console.print(f"[red]problem:[/] {err}")
    if errors:
        raise typer.Exit(1)


@whatsapp_app.command("browser-login")
def browser_login() -> None:
    """Open arena.ai in the agent's own browser profile so YOU can log in once.

    The agent never types your password. Close the window when you are done.
    """
    from ..llm.base import sanitize_error
    from .browser import PUBLIC_WEB, BrowserUnavailable, PlaywrightSession
    from .service import browser_profile_dir, downloads_dir

    cfg = load_or_create()
    try:
        # You log in yourself, so the window may use any public site: sign-in pages often
        # redirect to other providers. Local network addresses stay blocked.
        session = PlaywrightSession(profile_dir=browser_profile_dir(), downloads_dir=downloads_dir(cfg),
                                    executable=cfg.whatsapp.browser_executable or None, headless=False,
                                    allowed_hosts=(PUBLIC_WEB,))
        with session:
            try:
                session.goto("https://arena.ai/agent")
            except Exception as exc:  # show the cause instead of a silent hang
                _die(f"arena.ai did not open: {sanitize_error(exc)}")
            console.print("A browser window is open at arena.ai/agent. Log in there, then close the window.")
            session.wait_until_closed()
    except BrowserUnavailable as exc:
        _die(str(exc))
    console.print("[green]browser profile saved.[/] Turn it on with whatsapp.browser_enabled = true.")


@whatsapp_app.command("browser-test")
def browser_test(url: str = typer.Argument(..., help="https address to open, e.g. https://duckduckgo.com")) -> None:
    """Open one address in the agent's browser and say whether it loaded or hit a block page."""
    from ..llm.base import sanitize_error
    from .browser import PUBLIC_WEB, BrowserUnavailable, PlaywrightSession, host_allowed, is_blocked_page
    from .service import browser_profile_dir, downloads_dir

    if not host_allowed(url, (PUBLIC_WEB,)):
        _die("use a full https address on a public site, e.g. https://duckduckgo.com")
    cfg = load_or_create()
    try:
        session = PlaywrightSession(profile_dir=browser_profile_dir(), downloads_dir=downloads_dir(cfg),
                                    executable=cfg.whatsapp.browser_executable or None, headless=False,
                                    allowed_hosts=(PUBLIC_WEB,))
        with session:
            try:
                session.goto(url)
            except Exception as exc:
                _die(f"did not open: {sanitize_error(exc)}")
            time.sleep(8)               # let the page finish its own loading
            snap = session.snapshot()
    except BrowserUnavailable as exc:
        _die(str(exc))
    console.print(f"title: {snap.title or '(none)'}")
    console.print(f"url:   {snap.url}")
    console.print(f"text:  {' '.join(snap.text.split())[:200]}", markup=False)
    if is_blocked_page(snap.title, snap.text):
        console.print("[red]result: blocked.[/] The site showed a block, challenge, or error page.")
        raise typer.Exit(1)
    console.print("[green]result: loaded.[/]")


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
