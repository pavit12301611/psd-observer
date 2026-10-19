"""Assemble the WhatsApp remote from configuration: validation, transport, commander."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from .. import paths
from ..config import AppConfig
from ..llm.base import ModelProvider
from ..llm.factory import default_model_spec, make_provider
from .commander import Commander, CommanderSettings
from .phone import PhoneError, mask_phone, normalize_phone
from .whatsapp import Inbound, WhatsAppTransport


class RemoteConfigError(ValueError):
    """The WhatsApp settings cannot be used. The message is safe to show the user."""


def session_path() -> Path:
    return paths.data_dir() / "whatsapp" / "session.sqlite3"


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
    """Owns the transport and the commander. Start it once per process."""

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
    ) -> None:
        agent, owner = validated_numbers(cfg)
        self.agent_user = agent
        self.owner_user = owner
        self.provider = provider or make_provider(default_model_spec(cfg), cfg)
        self.transport = WhatsAppTransport(
            agent_number=agent,
            country_code=cfg.whatsapp.country_code or "91",
            session_path=session or session_path(),
            on_message=self._on_inbound,
            on_status=on_status,
            on_qr=on_qr,
            client_factory=client_factory,
        )
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
        self.commander = Commander(provider=self.provider, transport=self.transport,
                                   settings=settings, **kwargs)

    def _on_inbound(self, inbound: Inbound) -> None:
        # The commander re-checks the owner; this keeps the transport dumb.
        if inbound.sender_phone is None:
            return
        self.commander.handle_inbound(inbound.sender_phone, inbound.text)

    def start(self) -> None:
        self.transport.start()

    def stop(self) -> None:
        self.transport.stop()

    def describe(self) -> dict[str, str]:
        return {
            "agent": mask_phone(self.agent_user),
            "allowed": mask_phone(self.owner_user),
            "provider": getattr(self.provider, "provider_name", "?"),
            "is_cloud": str(bool(getattr(self.provider, "is_cloud", False))),
        }


__all__ = ["WhatsAppService", "RemoteConfigError", "validated_numbers", "session_path"]
