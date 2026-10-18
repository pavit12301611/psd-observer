"""Tool ABC and shared HTTP helper.

A tool validates its credentials (``validate``), describes its arguments as a
JSON schema (``schema``) and performs one action (``invoke``). Tools never raise
into the runtime — they return :class:`ToolResult`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx

from ..config import AppConfig
from ..llm.base import sanitize_error
from ..models import ToolContext, ToolKind, ToolResult, ToolSpec

NETWORK_TIMEOUT_S = 20.0


class Tool(ABC):
    kind: ToolKind = ToolKind.MEMORY
    #: True when the tool sends data off this machine (honours privacy.block_network_tools).
    network: bool = False

    def __init__(self, spec: ToolSpec, config: AppConfig) -> None:
        self.spec = spec
        self.config = config

    def option(self, name: str, default: Any = None) -> Any:
        return self.spec.options.get(name, default)

    @abstractmethod
    def validate(self) -> tuple[bool, str]:
        """``(ok, message)``. Missing credentials -> ``(False, "telegram.bot_token not set")``."""

    @abstractmethod
    def invoke(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        """Perform the action. Must not raise."""

    @abstractmethod
    def schema(self) -> dict[str, Any]:
        """JSON schema of the accepted ``args``."""

    def blocked_reason(self) -> str | None:
        if self.network and self.config.privacy.block_network_tools:
            return "blocked by privacy.block_network_tools"
        return None

    def run(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        """Guarded wrapper used by the registry: never raises."""
        if context.dry_run:
            return ToolResult.success(f"dry run: {self.kind.value} not sent", dry_run=True)
        blocked = self.blocked_reason()
        if blocked:
            return ToolResult.failure(f"{self.kind.value}: {blocked}")
        ok, msg = self.validate()
        if not ok:
            return ToolResult.failure(msg)
        try:
            return self.invoke(args or {}, context)
        except Exception as exc:  # noqa: BLE001
            return ToolResult.failure(f"{self.kind.value} failed: {sanitize_error(exc)}")


def http_post(url: str, *, json: Any = None, data: Any = None, headers: dict | None = None,
              files: Any = None, auth: Any = None, timeout: float = NETWORK_TIMEOUT_S) -> httpx.Response:
    with httpx.Client(timeout=timeout) as client:
        return client.post(url, json=json, data=data, headers=headers, files=files, auth=auth)


def require(values: dict[str, str]) -> tuple[bool, str]:
    """Return ``(False, 'missing: a.b, c.d')`` for any empty value."""
    missing = [k for k, v in values.items() if not v]
    if missing:
        return False, "missing: " + ", ".join(missing)
    return True, "ok"


__all__ = ["Tool", "http_post", "require", "NETWORK_TIMEOUT_S"]
