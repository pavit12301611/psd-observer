"""Tool registry: maps :class:`ToolKind` to implementations and dispatches calls."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..models import ToolContext, ToolKind, ToolResult, ToolSpec
from .base import Tool
from .channels import (
    DiscordTool,
    EmailSmtpTool,
    HttpWebhookTool,
    PhoneCallTool,
    PushoverTool,
    SendgridTool,
    SmsTool,
    TelegramTool,
    WhatsAppTool,
)
from .local import DesktopNotifyTool, MemoryTool, RecordClipTool, RunPythonTool

TOOL_CLASSES: dict[ToolKind, type[Tool]] = {
    ToolKind.TELEGRAM: TelegramTool,
    ToolKind.DISCORD: DiscordTool,
    ToolKind.WHATSAPP: WhatsAppTool,
    ToolKind.SMS: SmsTool,
    ToolKind.PHONE_CALL: PhoneCallTool,
    ToolKind.EMAIL: EmailSmtpTool,
    ToolKind.PUSHOVER: PushoverTool,
    ToolKind.DESKTOP_NOTIFY: DesktopNotifyTool,
    ToolKind.MEMORY: MemoryTool,
    ToolKind.RECORD_CLIP: RecordClipTool,
    ToolKind.HTTP_WEBHOOK: HttpWebhookTool,
    ToolKind.RUN_PYTHON: RunPythonTool,
}

#: Action names the model may use, mapped to kinds. Aliases keep messy models working.
ALIASES: dict[str, ToolKind] = {
    "telegram": ToolKind.TELEGRAM, "tg": ToolKind.TELEGRAM,
    "discord": ToolKind.DISCORD,
    "whatsapp": ToolKind.WHATSAPP,
    "sms": ToolKind.SMS, "text": ToolKind.SMS,
    "phone_call": ToolKind.PHONE_CALL, "phone": ToolKind.PHONE_CALL, "call": ToolKind.PHONE_CALL,
    "email": ToolKind.EMAIL, "mail": ToolKind.EMAIL,
    "pushover": ToolKind.PUSHOVER,
    "desktop_notify": ToolKind.DESKTOP_NOTIFY, "notify": ToolKind.DESKTOP_NOTIFY,
    "notification": ToolKind.DESKTOP_NOTIFY, "desktop": ToolKind.DESKTOP_NOTIFY,
    "memory": ToolKind.MEMORY, "remember": ToolKind.MEMORY,
    "record_clip": ToolKind.RECORD_CLIP, "record": ToolKind.RECORD_CLIP,
    "http_webhook": ToolKind.HTTP_WEBHOOK, "webhook": ToolKind.HTTP_WEBHOOK,
    "run_python": ToolKind.RUN_PYTHON, "python": ToolKind.RUN_PYTHON,
    "log": ToolKind.DESKTOP_NOTIFY,  # 'log' preset maps to a local notification
}


def resolve_tool_name(name: str) -> ToolKind | None:
    key = (name or "").strip().lower().replace("-", "_").replace(" ", "_")
    if key in ALIASES:
        return ALIASES[key]
    try:
        return ToolKind(key)
    except ValueError:
        return None


class ToolRegistry:
    def __init__(self, config: AppConfig, memory=None) -> None:
        self.config = config
        self.memory = memory
        self._cache: dict[tuple[str, int], Tool] = {}

    def build(self, spec: ToolSpec) -> Tool:
        cls = TOOL_CLASSES[spec.kind]
        if spec.kind == ToolKind.MEMORY:
            return MemoryTool(spec, self.config, memory=self.memory)
        if spec.kind == ToolKind.EMAIL and spec.options.get("provider") == "sendgrid":
            return SendgridTool(spec, self.config)
        return cls(spec, self.config)

    def for_agent(self, specs: list[ToolSpec]) -> dict[str, Tool]:
        """Map of kind-name -> tool for the agent's *enabled* tools."""
        out: dict[str, Tool] = {}
        for spec in specs:
            if not spec.enabled:
                continue
            out[spec.kind.value] = self.build(spec)
        return out

    def validate_all(self, specs: list[ToolSpec]) -> dict[str, tuple[bool, str]]:
        return {s.kind.value: self.build(s).validate() for s in specs}

    def dispatch(self, name: str, args: dict[str, Any], context: ToolContext,
                 allowed: dict[str, Tool]) -> tuple[ToolResult, str]:
        """Resolve ``name``, check it is allowed for this agent, run it. Never raises.

        Returns ``(result, resolved_name)``. Unknown tools are reported, not raised.
        """
        kind = resolve_tool_name(name)
        if kind is None:
            return ToolResult.failure(f"unknown tool {name!r}"), name
        tool = allowed.get(kind.value)
        if tool is None:
            return ToolResult.failure(f"tool {kind.value!r} is not enabled for this agent"), kind.value
        return tool.run(args, context), kind.value

    def test_send(self, kind: ToolKind, text: str = "Observer Core test message") -> ToolResult:
        """Used by the GUI's per-channel 'Send test' button."""
        spec = ToolSpec(kind=kind, enabled=True, options={})
        tool = self.build(spec)
        ctx = ToolContext(agent_id="test", agent_name="Observer Core test")
        return tool.run({"text": text, "message": text}, ctx)


__all__ = ["ToolRegistry", "TOOL_CLASSES", "resolve_tool_name", "ALIASES"]
