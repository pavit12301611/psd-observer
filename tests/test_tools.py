"""Tools: credential validation messages, dispatch rules, privacy kill-switch, sandboxed Python."""

import pytest

from observer_core.config import AppConfig
from observer_core.models import ToolContext, ToolKind, ToolSpec
from observer_core.tools.registry import ToolRegistry, resolve_tool_name


@pytest.fixture
def reg(cfg, memory):
    return ToolRegistry(cfg, memory=memory)


def ctx(agent="a1"):
    return ToolContext(agent_id=agent, agent_name="Agent")


@pytest.mark.parametrize("kind,needle", [
    (ToolKind.TELEGRAM, "telegram.bot_token"),
    (ToolKind.DISCORD, "discord.webhook_url"),
    (ToolKind.WHATSAPP, "twilio.account_sid"),
    (ToolKind.SMS, "twilio.account_sid"),
    (ToolKind.PHONE_CALL, "twilio.account_sid"),
    (ToolKind.EMAIL, "smtp.host"),
    (ToolKind.PUSHOVER, "pushover.token"),
])
def test_missing_credentials_message_names_the_key(reg, kind, needle, monkeypatch):
    for var in ("TELEGRAM_BOT_TOKEN", "DISCORD_WEBHOOK_URL", "TWILIO_ACCOUNT_SID", "SMTP_HOST", "PUSHOVER_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    ok, msg = reg.build(ToolSpec(kind=kind)).validate()
    assert ok is False
    assert needle in msg and msg.startswith("missing")


def test_credentials_present_validates(cfg, memory):
    cfg.telegram.bot_token = "123:abc"
    cfg.telegram.chat_id = "9"
    reg = ToolRegistry(cfg, memory=memory)
    assert reg.build(ToolSpec(kind=ToolKind.TELEGRAM)).validate() == (True, "ok")


def test_chat_id_can_come_from_agent_options(cfg, memory):
    cfg.telegram.bot_token = "123:abc"
    reg = ToolRegistry(cfg, memory=memory)
    assert reg.build(ToolSpec(kind=ToolKind.TELEGRAM, options={"chat_id": "42"})).validate()[0] is True


def test_privacy_block_network_tools(cfg, memory):
    cfg.telegram.bot_token = "123:abc"
    cfg.telegram.chat_id = "9"
    cfg.privacy.block_network_tools = True
    res = ToolRegistry(cfg, memory=memory).build(ToolSpec(kind=ToolKind.TELEGRAM)).run({"text": "hi"}, ctx())
    assert res.ok is False and "block_network_tools" in res.detail


def test_dry_run_sends_nothing(cfg, memory):
    res = ToolRegistry(cfg, memory=memory).build(ToolSpec(kind=ToolKind.TELEGRAM)).run(
        {"text": "hi"}, ToolContext(agent_id="a", dry_run=True))
    assert res.ok and res.payload.get("dry_run")


def test_resolve_aliases():
    assert resolve_tool_name("Telegram") is ToolKind.TELEGRAM
    assert resolve_tool_name("text") is ToolKind.SMS
    assert resolve_tool_name("call") is ToolKind.PHONE_CALL
    assert resolve_tool_name("log") is ToolKind.DESKTOP_NOTIFY
    assert resolve_tool_name("desktop-notify") is ToolKind.DESKTOP_NOTIFY
    assert resolve_tool_name("nonsense") is None


def test_dispatch_unknown_and_disabled(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.MEMORY)])
    res, name = reg.dispatch("warp_drive", {}, ctx(), allowed)
    assert res.ok is False and "unknown tool" in res.detail
    res, name = reg.dispatch("telegram", {}, ctx(), allowed)
    assert res.ok is False and "not enabled" in res.detail


def test_disabled_tool_spec_is_not_allowed(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.MEMORY, enabled=False)])
    assert allowed == {}


def test_memory_tool_store_recall_forget(reg, memory):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.MEMORY)])
    r, _ = reg.dispatch("memory", {"action": "store", "key": "pizza", "value": "margherita"}, ctx(), allowed)
    assert r.ok and memory.get("a1", "pizza").value == "margherita"
    r, _ = reg.dispatch("memory", {"action": "recall", "query": "what pizza"}, ctx(), allowed)
    assert r.ok and r.payload["rows"][0]["key"] == "pizza"
    r, _ = reg.dispatch("memory", {"action": "forget", "key": "pizza"}, ctx(), allowed)
    assert r.ok and memory.get("a1", "pizza") is None


def test_memory_store_requires_key(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.MEMORY)])
    r, _ = reg.dispatch("memory", {"action": "store"}, ctx(), allowed)
    assert r.ok is False


def test_run_python_off_by_default(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.RUN_PYTHON)])
    r, _ = reg.dispatch("run_python", {"code": "print(1)"}, ctx(), allowed)
    assert r.ok is False and "disabled" in r.detail


def test_run_python_when_opted_in_runs_and_blocks_network(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.RUN_PYTHON, allow_python=True)])
    r, _ = reg.dispatch("run_python", {"code": "print(2+3)"}, ctx(), allowed)
    assert r.ok and "5" in r.detail
    r, _ = reg.dispatch("run_python", {"code": "import socket\nprint(1)"}, ctx(), allowed)
    assert r.ok is False and "blocked" in r.detail


def test_run_python_timeout_is_enforced(reg, monkeypatch):
    from observer_core.tools.local import RunPythonTool

    monkeypatch.setattr(RunPythonTool, "TIMEOUT_S", 1)
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.RUN_PYTHON, allow_python=True)])
    r, _ = reg.dispatch("run_python", {"code": "while True:\n    pass"}, ctx(), allowed)
    assert r.ok is False          # killed by the timeout / CPU rlimit, never reported as success


def test_run_python_rejects_huge_code(reg):
    allowed = reg.for_agent([ToolSpec(kind=ToolKind.RUN_PYTHON, allow_python=True)])
    r, _ = reg.dispatch("run_python", {"code": "x=1\n" * 2000}, ctx(), allowed)
    assert r.ok is False and "too long" in r.detail


def test_http_webhook_validates_url(reg):
    t = reg.build(ToolSpec(kind=ToolKind.HTTP_WEBHOOK, options={"url": "ftp://nope"}))
    assert t.validate()[0] is False


def test_desktop_notify_missing_binary_is_actionable(reg, monkeypatch):
    monkeypatch.setattr("observer_core.tools.local.shutil.which", lambda n: None)
    ok, msg = reg.build(ToolSpec(kind=ToolKind.DESKTOP_NOTIFY)).validate()
    assert ok is False and "libnotify" in msg


def test_tool_exceptions_are_contained(reg, monkeypatch):
    from observer_core.tools.channels import TelegramTool

    cfg = AppConfig()
    cfg.telegram.bot_token = "123:abc"
    cfg.telegram.chat_id = "1"
    t = TelegramTool(ToolSpec(kind=ToolKind.TELEGRAM), cfg)

    def boom(*a, **k):
        raise ConnectionError("network down")

    monkeypatch.setattr("observer_core.tools.channels.http_post", boom)
    res = t.run({"text": "hi"}, ctx())
    assert res.ok is False and "network down" in res.detail
