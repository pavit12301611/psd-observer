"""WhatsApp transport: a linked device session via neonize (whatsmeow).

IMPORTANT — read before use:

* This is the *unofficial* WhatsApp Web protocol. Meta does not allow it in its
  terms, and an account can be restricted or banned. Use a SIM you can afford to
  lose for the agent number (the one this device is linked as).
* Pairing is done once, by scanning the QR code with the phone that owns the agent
  number (WhatsApp > Linked devices). The session keys live in a 0600 SQLite file
  in the data directory, never in ``config.toml`` and never in git.
* Messages travel through WhatsApp's servers (that is inherent to WhatsApp). The
  model that interprets them runs locally unless you opted into a cloud provider.

The neonize import is lazy, so the rest of Observer Core works without it. Tests
replace :func:`_load_neonize` with fakes; nothing here opens a network connection
at import time.
"""

from __future__ import annotations

import os
import stat
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from loguru import logger

from .phone import mask_phone, normalize_phone

PHONE_SERVER = "s.whatsapp.net"


class WhatsAppUnavailable(RuntimeError):
    """neonize (or one of its system libraries) is not installed."""


class TransportError(RuntimeError):
    """Sending or connecting failed in a way the user should read."""


@dataclass(frozen=True)
class Inbound:
    """A plain-text message from a one-to-one chat. Built from a neonize event."""
    sender_phone: str | None      # digits only, when WhatsApp exposed the phone number
    text: str
    from_me: bool
    is_group: bool


def _phone_of(jid: Any) -> str | None:
    if jid is None:
        return None
    user = str(getattr(jid, "User", "") or "")
    server = str(getattr(jid, "Server", "") or "")
    return user if server == PHONE_SERVER and user.isdigit() else None


def inbound_from_event(event: Any) -> Inbound | None:
    """Map a neonize ``Message`` event to :class:`Inbound`. Pure; works on fakes."""
    info = getattr(event, "Info", None)
    if info is None:
        return None
    source = info.MessageSource
    message = getattr(event, "Message", None)
    text = ""
    if message is not None:
        text = str(getattr(message, "conversation", "") or "")
        ext = getattr(message, "extendedTextMessage", None)
        if not text and ext is not None:
            text = str(getattr(ext, "text", "") or "")
    phone = _phone_of(getattr(source, "Sender", None)) or _phone_of(getattr(source, "SenderAlt", None))
    return Inbound(
        sender_phone=phone,
        text=text,
        from_me=bool(getattr(source, "IsFromMe", False)),
        is_group=bool(getattr(source, "IsGroup", False)),
    )


def _load_neonize() -> SimpleNamespace:
    """Import neonize lazily and return the names this module needs."""
    try:
        from neonize.client import NewClient
        from neonize.events import ConnectedEv, DisconnectedEv, MessageEv, QREv
    except (ImportError, OSError) as exc:  # OSError: libmagic / libGL missing at load time
        raise WhatsAppUnavailable(
            "WhatsApp support needs the 'neonize' package and libmagic "
            f"(Fedora: sudo dnf install --needed file-libs). Detail: {exc}") from exc
    return SimpleNamespace(NewClient=NewClient, ConnectedEv=ConnectedEv,
                           DisconnectedEv=DisconnectedEv, MessageEv=MessageEv, QREv=QREv)


class WhatsAppTransport:
    """Owns one neonize client. Thread model: neonize delivers events on its own thread;
    handlers only record state and hand messages to ``on_message`` quickly."""

    def __init__(
        self,
        *,
        agent_number: str,
        session_path: Path,
        country_code: str = "91",
        on_message: Callable[[Inbound], None] | None = None,
        on_status: Callable[[str], None] | None = None,
        on_qr: Callable[[str], None] | None = None,
        client_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self.agent_user = normalize_phone(agent_number, country_code)
        self.country_code = country_code
        self.session_path = Path(session_path)
        self._on_message = on_message
        self._on_status = on_status or (lambda msg: None)
        self._on_qr = on_qr or (lambda code: None)
        self._client_factory = client_factory
        self._client: Any = None
        self._thread: threading.Thread | None = None
        self.connected = threading.Event()
        self.mismatch = False
        self.last_error: str | None = None

    # ------------------------------------------------------------------ #
    def start(self) -> None:
        names = None if self._client_factory else _load_neonize()
        self.session_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.session_path.parent, 0o700)
        except OSError:  # pragma: no cover
            pass
        if self._client_factory:
            client = self._client_factory(str(self.session_path))
            events = SimpleNamespace(ConnectedEv="ConnectedEv", DisconnectedEv="DisconnectedEv",
                                     MessageEv="MessageEv", QREv="QREv")
        else:
            client = names.NewClient(str(self.session_path))
            events = names
        self._client = client
        client.event.qr(self._handle_qr)
        client.event(events.ConnectedEv)(self._handle_connected)
        client.event(events.DisconnectedEv)(self._handle_disconnected)
        client.event(events.MessageEv)(self._handle_message)
        self._thread = threading.Thread(target=self._connect, name="observer-whatsapp-link", daemon=True)
        self._thread.start()
        self._status("connecting to WhatsApp (linked device)...")

    def _connect(self) -> None:
        try:
            self._client.connect()
        except Exception as exc:
            self.last_error = str(exc)[:200]
            logger.error("whatsapp connect failed: {}", self.last_error)
            self._status(f"connection failed: {self.last_error}")
        finally:
            self._secure_session_files()

    def stop(self) -> None:
        self.connected.clear()
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception as exc:  # shutdown must not raise
                logger.debug("whatsapp disconnect: {}", exc)
        self._secure_session_files()

    def send_text(self, user: str, text: str) -> None:
        if not self.connected.is_set() or self._client is None:
            raise TransportError("WhatsApp is not connected")
        try:
            self._client.send_message(user, text)
        except Exception as exc:
            raise TransportError(f"send failed: {str(exc)[:160]}") from exc

    # ------------------------------------------------------------------ #
    # neonize handlers
    # ------------------------------------------------------------------ #
    def _handle_qr(self, client: Any, data: Any) -> None:
        code = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
        self._status("scan this QR code with the agent phone: WhatsApp > Linked devices")
        self._on_qr(code)
        self._secure_session_files()

    def _handle_connected(self, client: Any, event: Any) -> None:
        try:
            me = client.get_me()
            linked = str(me.JID.User)
        except Exception as exc:
            linked = ""
            logger.warning("whatsapp: could not read linked account: {}", exc)
        if linked and linked != self.agent_user:
            self.mismatch = True
            self.last_error = (f"linked account {mask_phone(linked)} is not the configured agent number "
                               f"{mask_phone(self.agent_user)}")
            self._status(f"refusing to run: {self.last_error}. Run "
                         "'observer-core whatsapp unpair --yes', then pair with the agent phone.")
            try:
                client.disconnect()
            except Exception:
                pass
            return
        self.last_error = None
        self.connected.set()
        self._secure_session_files()
        self._status(f"connected as agent {mask_phone(self.agent_user)}")

    def _handle_disconnected(self, client: Any, event: Any) -> None:
        self.connected.clear()
        self._status("disconnected from WhatsApp (will retry if the library reconnects)")

    def _handle_message(self, client: Any, event: Any) -> None:
        inbound = inbound_from_event(event)
        if inbound is None or inbound.from_me or inbound.is_group or not inbound.text.strip():
            return
        if self._on_message is not None:
            self._on_message(inbound)

    # ------------------------------------------------------------------ #
    def _status(self, text: str) -> None:
        try:
            self._on_status(text)
        except Exception:  # a broken status callback must not kill the link
            logger.debug("whatsapp status callback failed")

    def _secure_session_files(self) -> None:
        """The session database holds linked-device keys: keep it owner-only."""
        for path in self.session_path.parent.glob(self.session_path.name + "*"):
            try:
                os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:  # pragma: no cover
                pass


__all__ = ["WhatsAppTransport", "Inbound", "inbound_from_event", "WhatsAppUnavailable",
           "TransportError", "PHONE_SERVER"]
