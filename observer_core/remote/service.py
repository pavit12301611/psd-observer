"""Assemble the WhatsApp remote from configuration: validation, transport, commander, routines, browser."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from loguru import logger

from .. import paths
from ..config import AppConfig
from ..llm.base import ModelProvider
from ..llm.factory import default_model_spec, make_provider
from .browser import DEFAULT_ALLOWED_HOSTS, PlaywrightSession, run_browser_job, scope_hosts
from .commander import Commander, CommanderSettings
from .phone import PhoneError, mask_phone, normalize_phone
from .routines import RoutineService, load_routines
from .timers import TimerStore
from .whatsapp import Inbound, WhatsAppTransport


class RemoteConfigError(ValueError):
    """The WhatsApp settings cannot be used. The message is safe to show the user."""


def remote_dir() -> Path:
    return paths.data_dir() / "whatsapp"


def session_path() -> Path:
    return remote_dir() / "session.sqlite3"


def timers_path() -> Path:
    return remote_dir() / "timers.json"


def routines_path() -> Path:
    return paths.config_dir() / "routines.toml"


def browser_profile_dir() -> Path:
    return remote_dir() / "arena-browser-profile"


def downloads_dir(cfg: AppConfig) -> Path:
    if cfg.whatsapp.downloads_dir:
        return Path(cfg.whatsapp.downloads_dir).expanduser()
    return paths.data_dir() / "arena-downloads"


def validated_numbers(cfg: AppConfig) -> tuple[str, str]:
    """Return ``(agent_user, owner_user)`` as digits, or raise :class:`RemoteConfigError`."""
    w = cfg.whatsapp
    cc = w.country_code or "91"
    if not w.agent_number.strip():
        raise RemoteConfigError("whatsapp.agent_number is empty (the number the agent runs on)")
    if not w.allowed_number.strip():
        raise RemoteConfigError("whatsapp.allowed_number is empty (the only number allowed to command the agent)")
    try:
        agent = normalize_phone(w.agent_number, cc)
        owner = normalize_phone(w.allowed_number, cc)
    except PhoneError as exc:
        raise RemoteConfigError(str(exc)) from exc
    if agent == owner:
        raise RemoteConfigError("agent_number and allowed_number must be different accounts")
    return agent, owner


class WhatsAppService:
    """Owns the transport, the commander, routines and timers. Start it once per process."""

    def __init__(
        self,
        cfg: AppConfig,
        *,
        provider: ModelProvider | None = None,
        client_factory: Callable[[str], Any] | None = None,
        on_status: Callable[[str], None] | None = None,
        on_qr: Callable[[str], None] | None = None,
        shell: Callable[..., Any] | None = None,
        session: Path | None = None,
        timers: Path | None = None,
        routines_file: Path | None = None,
    ) -> None:
        agent, owner = validated_numbers(cfg)
        self.agent_user = agent
        self.owner_user = owner
        self.cfg = cfg
        self.provider = provider or make_provider(default_model_spec(cfg), cfg)
        self._status = on_status or (lambda msg: None)
        self._stop = threading.Event()
        self._scheduler: threading.Thread | None = None

        self.transport = WhatsAppTransport(
            agent_number=agent,
            country_code=cfg.whatsapp.country_code or "91",
            session_path=session or session_path(),
            on_message=self._on_inbound,
            on_status=on_status,
            on_qr=on_qr,
            client_factory=client_factory,
        )

        loaded, self.routine_errors = load_routines(routines_file or routines_path())
        for err in self.routine_errors:
            self._status(f"routines: {err}")
        self.routines = RoutineService(
            routines=loaded,
            store=TimerStore(timers or timers_path()),
            say=self._say,
            cwd=Path.home(),
            command_timeout_s=float(cfg.whatsapp.command_timeout_s),
        )

        self.browser = self._make_browser_runner() if cfg.whatsapp.browser_enabled else None

        settings = CommanderSettings(
            owner_user=owner,
            max_steps=max(1, int(cfg.whatsapp.max_steps)),
            command_timeout_s=float(cfg.whatsapp.command_timeout_s),
            confirm_timeout_s=float(cfg.whatsapp.confirm_timeout_s),
            cwd=Path.home(),
        )
        kwargs: dict[str, Any] = {}
        if shell is not None:
            kwargs["shell"] = shell
        self.commander = Commander(provider=self.provider, transport=self.transport, settings=settings,
                                   routines=self.routines, browser=self.browser, **kwargs)

    # ------------------------------------------------------------------ #
    def _say(self, text: str) -> None:
        """Send to the owner. Used by routines and timers, which run outside a task."""
        try:
            self.transport.send_text(self.owner_user, text[:1500])
        except Exception as exc:
            logger.warning("whatsapp say failed: {}", type(exc).__name__)

    def _make_browser_runner(self) -> Callable[..., Any]:
        w = self.cfg.whatsapp

        def run(prompt: str, ask: Callable[[str], str | None], say: Callable[[str], None],
                mode: str = "arena") -> Any:
            # arena.ai jobs never leave arena.ai; the wider scope applies to research jobs only.
            hosts = scope_hosts(w.browser_scope) if mode == "research" else DEFAULT_ALLOWED_HOSTS
            session = PlaywrightSession(
                profile_dir=browser_profile_dir(),
                downloads_dir=downloads_dir(self.cfg),
                executable=w.browser_executable or None,
                headless=bool(w.browser_headless),
                allowed_hosts=hosts,
            )
            with session:
                return run_browser_job(
                    prompt, session=session, provider=self.provider, ask=ask, say=say, mode=mode,
                    max_steps=max(1, int(w.browser_max_steps)),
                    timeout_s=float(w.browser_timeout_min) * 60.0,
                    allowed_hosts=hosts,
                )

        return run

    def _on_inbound(self, inbound: Inbound) -> None:
        # The commander re-checks the owner; this keeps the transport dumb.
        if inbound.sender_phone is None:
            return
        self.commander.handle_inbound(inbound.sender_phone, inbound.text)

    def _scheduler_loop(self) -> None:
        while not self._stop.wait(1.0):
            try:
                self.routines.tick()
            except Exception as exc:  # the scheduler must survive a bad timer file
                logger.warning("scheduler tick failed: {}", type(exc).__name__)

    def start(self) -> None:
        self.transport.start()
        self._stop.clear()
        self._scheduler = threading.Thread(target=self._scheduler_loop, name="observer-whatsapp-timers",
                                           daemon=True)
        self._scheduler.start()

    def stop(self) -> None:
        self._stop.set()
        self.transport.stop()

    def describe(self) -> dict[str, str]:
        return {
            "agent": mask_phone(self.agent_user),
            "allowed": mask_phone(self.owner_user),
            "provider": getattr(self.provider, "provider_name", "?"),
            "is_cloud": str(bool(getattr(self.provider, "is_cloud", False))),
            "routines": str(len(self.routines.routines)),
            "browser": "on" if self.browser is not None else "off",
        }


__all__ = ["WhatsAppService", "RemoteConfigError", "validated_numbers", "session_path", "routines_path",
           "timers_path", "browser_profile_dir", "downloads_dir"]
