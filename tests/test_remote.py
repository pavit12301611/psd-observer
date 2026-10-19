"""WhatsApp remote: owner gate, approval flow, shell limits, transport mapping, CLI.

No WhatsApp servers, no neonize import, no real shell except tiny `sh -c` probes.
"""

from __future__ import annotations

import os
import stat
import sys
import time
from types import SimpleNamespace

import pytest

from observer_core.config import AppConfig
from observer_core.llm.base import ProviderError
from observer_core.remote import commander as commander_mod
from observer_core.remote.commander import Commander, CommanderSettings, parse_action
from observer_core.remote.phone import PhoneError, mask_phone, normalize_phone
from observer_core.remote.service import RemoteConfigError, WhatsAppService, validated_numbers
from observer_core.remote.shell import ShellResult, run_shell, truncate_middle
from observer_core.remote.whatsapp import (
    Inbound,
    TransportError,
    WhatsAppTransport,
    inbound_from_event,
)
from tests.fakes import ScriptedModel

OWNER = "919528923866"
AGENT = "918859555795"
STRANGER = "919000000001"


# ----------------------------------------------------------------------- #
# helpers
# ----------------------------------------------------------------------- #
class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send_text(self, user: str, text: str) -> None:
        self.sent.append((user, text))

    def texts(self) -> list[str]:
        return [t for _, t in self.sent]


def wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def action(kind: str, **fields) -> str:
    import json

    return json.dumps({"action": kind, **fields})


def make_commander(responses, *, shell=None, max_steps=6, confirm_timeout_s=5.0, delay_s=0.0):
    transport = FakeTransport()
    model = ScriptedModel(responses, delay_s=delay_s)
    calls: list[str] = []

    def fake_shell(command, cwd=None, timeout_s=0):
        calls.append(command)
        if shell:
            return shell(command)
        return ShellResult(command=command, exit_code=0, output="ok")

    settings = CommanderSettings(owner_user=OWNER, max_steps=max_steps,
                                 confirm_timeout_s=confirm_timeout_s, answer_timeout_s=5.0)
    cmd = Commander(provider=model, transport=transport, settings=settings, shell=fake_shell)
    return cmd, transport, model, calls


# ----------------------------------------------------------------------- #
# phone numbers
# ----------------------------------------------------------------------- #
@pytest.mark.parametrize("raw,expected", [
    ("9528923866", "919528923866"),
    ("+91 95289 23866", "919528923866"),
    ("0091-95289-23866", "919528923866"),
    ("+919528923866", "919528923866"),
    ("8859555795", "918859555795"),
])
def test_normalize_phone_accepts_common_shapes(raw, expected):
    assert normalize_phone(raw, "91") == expected


def test_normalize_phone_uses_configured_country_code():
    assert normalize_phone("7700900123", "44") == "447700900123"


@pytest.mark.parametrize("raw", ["", "12", "abc", "+1234567890123456"])
def test_normalize_phone_rejects_garbage(raw):
    with pytest.raises(PhoneError):
        normalize_phone(raw)


def test_mask_phone_keeps_last_four_only():
    assert mask_phone("919528923866") == "********3866"
    assert "9528" not in mask_phone("919528923866")


# ----------------------------------------------------------------------- #
# action parsing
# ----------------------------------------------------------------------- #
def test_parse_action_finds_json_inside_prose():
    raw = 'Sure! {"action": "shell", "command": "ls ~", "reason": "look"} hope that helps'
    assert parse_action(raw) == {"action": "shell", "command": "ls ~", "reason": "look"}


def test_parse_action_rejects_unknown_or_empty_actions():
    assert parse_action('{"action": "format_disk", "command": "x"}') is None
    assert parse_action('{"action": "shell", "command": "   "}') is None
    assert parse_action('{"action": "ask"}') is None
    assert parse_action("no json at all") is None


# ----------------------------------------------------------------------- #
# owner gate
# ----------------------------------------------------------------------- #
def test_stranger_is_ignored_without_reply_or_model_call():
    cmd, transport, model, calls = make_commander([action("done", summary="x")])
    result = cmd.handle_inbound(STRANGER, "delete everything")
    assert result.action == "ignored"
    assert transport.sent == []
    assert model.calls == []
    assert calls == []


def test_empty_message_from_owner_is_ignored():
    cmd, transport, model, _ = make_commander([action("done", summary="x")])
    assert cmd.handle_inbound(OWNER, "   ").action == "ignored"
    assert transport.sent == [] and model.calls == []


# ----------------------------------------------------------------------- #
# approval flow
# ----------------------------------------------------------------------- #
def test_owner_instruction_runs_only_after_yes_and_reports_done():
    cmd, transport, model, calls = make_commander([
        action("shell", command="echo hi", reason="say hi"),
        action("done", summary="I printed hi."),
    ])
    assert cmd.handle_inbound(OWNER, "say hi").action == "started"
    assert wait_until(lambda: any("echo hi" in t for t in transport.texts()))
    assert calls == [], "command must not run before approval"
    assert cmd.handle_inbound(OWNER, "yes").action == "confirmed"
    assert cmd.wait_idle(5)
    assert calls == ["echo hi"]
    assert transport.texts()[-1] == "✅ I printed hi."
    assert all(user == OWNER for user, _ in transport.sent)
    assert not cmd.is_busy()


def test_no_declines_command_and_model_is_told():
    cmd, transport, model, calls = make_commander([
        action("shell", command="rm -rf /tmp/x", reason="cleanup"),
        action("done", summary="Cancelled as asked."),
    ])
    cmd.handle_inbound(OWNER, "clean up")
    assert wait_until(lambda: any("rm -rf" in t for t in transport.texts()))
    assert cmd.handle_inbound(OWNER, "NO").action == "declined"
    assert cmd.wait_idle(5)
    assert calls == []
    second_prompt = model.calls[1][-1].content
    assert "declined" in second_prompt


def test_other_text_during_approval_is_a_reminder_not_an_answer():
    cmd, transport, model, calls = make_commander([
        action("shell", command="uptime", reason="check load"),
        action("done", summary="ok"),
    ])
    cmd.handle_inbound(OWNER, "load?")
    assert wait_until(lambda: any("uptime" in t for t in transport.texts()))
    assert cmd.handle_inbound(OWNER, "maybe later").action == "reminded"
    assert any("waiting for approval" in t for t in transport.texts())
    assert calls == []
    cmd.handle_inbound(OWNER, "Y")
    assert cmd.wait_idle(5)
    assert calls == ["uptime"]


def test_stop_during_approval_cancels_without_running():
    cmd, transport, model, calls = make_commander([action("shell", command="reboot", reason="x")])
    cmd.handle_inbound(OWNER, "reboot please")
    assert wait_until(lambda: any("reboot" in t for t in transport.texts()))
    cmd.handle_inbound(OWNER, "STOP")
    assert cmd.wait_idle(5)
    assert calls == []
    assert "Cancelled." in transport.texts()


def test_no_reply_in_time_stops_and_runs_nothing():
    cmd, transport, model, calls = make_commander(
        [action("shell", command="ls", reason="look")], confirm_timeout_s=0.2)
    cmd.handle_inbound(OWNER, "list")
    assert cmd.wait_idle(5)
    assert calls == []
    assert any("No reply in time" in t for t in transport.texts())
    assert not cmd.is_busy()


def test_stop_when_idle_says_nothing_running():
    cmd, transport, model, calls = make_commander([])
    assert cmd.handle_inbound(OWNER, "STOP").action == "idle"
    assert transport.texts() == ["Nothing is running right now."]


def test_second_instruction_while_busy_is_refused_politely():
    cmd, transport, model, calls = make_commander(
        [action("done", summary="first")], delay_s=0.4)
    cmd.handle_inbound(OWNER, "first job")
    assert cmd.handle_inbound(OWNER, "second job").action == "busy"
    assert cmd.wait_idle(5)
    assert calls == []
    assert any("Still working on: first job" in t for t in transport.texts())


# ----------------------------------------------------------------------- #
# loop behaviour
# ----------------------------------------------------------------------- #
def test_ask_action_waits_for_free_text_answer():
    cmd, transport, model, calls = make_commander([
        action("ask", question="Which folder?"),
        action("done", summary="Used the folder you named."),
    ])
    cmd.handle_inbound(OWNER, "tidy up")
    assert wait_until(lambda: "❓ Which folder?" in transport.texts())
    assert cmd.handle_inbound(OWNER, "Downloads").action == "answered"
    assert cmd.wait_idle(5)
    assert "Owner answered: Downloads" in model.calls[1][-1].content


def test_invalid_model_output_counts_as_a_step_and_is_bounded():
    cmd, transport, model, calls = make_commander(["just chatting, no json"], max_steps=2)
    cmd.handle_inbound(OWNER, "do something")
    assert cmd.wait_idle(5)
    assert len(model.calls) == 2
    assert any("Stopped after 2 steps" in t for t in transport.texts())


def test_model_error_is_reported_not_raised():
    cmd, transport, model, calls = make_commander([ProviderError("ollama is down")])
    cmd.handle_inbound(OWNER, "hello")
    assert cmd.wait_idle(5)
    assert any(t.startswith("❌ The model could not answer") for t in transport.texts())
    assert not cmd.is_busy()


def test_command_failure_is_reported_and_fed_back():
    cmd, transport, model, calls = make_commander(
        [action("shell", command="false", reason="test"), action("done", summary="it failed")],
        shell=lambda c: ShellResult(command=c, exit_code=1, output="boom"))
    cmd.handle_inbound(OWNER, "try")
    assert wait_until(lambda: any("false" in t for t in transport.texts()))
    cmd.handle_inbound(OWNER, "yes")
    assert cmd.wait_idle(5)
    assert any("exit 1" in t for t in transport.texts())
    assert "boom" in model.calls[1][-1].content


def test_worker_crash_is_contained_and_reported():
    def exploding_shell(command, cwd=None, timeout_s=0):
        raise RuntimeError("kaboom")

    transport = FakeTransport()
    settings = CommanderSettings(owner_user=OWNER, max_steps=3, confirm_timeout_s=5)
    cmd = Commander(provider=ScriptedModel([action("shell", command="x", reason="r")]),
                    transport=transport, settings=settings, shell=exploding_shell)
    cmd.handle_inbound(OWNER, "go")
    assert wait_until(lambda: any(t.startswith("Step 1") for t in transport.texts()))
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert any("Internal error: RuntimeError" in t for t in transport.texts())
    assert not cmd.is_busy()


def test_overlong_command_is_refused_not_clipped_in_approval():
    """The owner must never approve a command they could not see in full."""
    huge = "echo " + "a" * 1200
    cmd, transport, model, calls = make_commander([
        action("shell", command=huge, reason="x"),
        action("done", summary="split it up"),
    ])
    cmd.handle_inbound(OWNER, "do it")
    assert cmd.wait_idle(5)
    assert calls == []
    assert not any("Reply YES to run" in t for t in transport.texts()), "no approval prompt for a clipped command"
    assert "too long for the owner to review" in model.calls[1][-1].content


def test_long_replies_are_clipped():
    cmd, transport, model, calls = make_commander([action("done", summary="x" * 5000)])
    cmd.handle_inbound(OWNER, "long")
    assert cmd.wait_idle(5)
    assert max(len(t) for t in transport.texts()) <= commander_mod.MAX_REPLY_CHARS


# ----------------------------------------------------------------------- #
# shell runner
# ----------------------------------------------------------------------- #
def test_run_shell_captures_output_and_exit_code():
    res = run_shell("echo hello; exit 3", timeout_s=5)
    assert res.exit_code == 3 and "hello" in res.output and not res.ok


def test_run_shell_closes_stdin_so_prompts_do_not_hang():
    res = run_shell("cat", timeout_s=5)
    assert res.exit_code == 0 and res.output == ""


def test_run_shell_kills_on_timeout_including_children():
    started = time.monotonic()
    res = run_shell("sleep 30 & sleep 30", timeout_s=0.5)
    assert res.timed_out and res.exit_code is None
    assert time.monotonic() - started < 10


def test_run_shell_truncates_huge_output():
    res = run_shell(f"{sys.executable} -c \"print('x' * 20000)\"", timeout_s=20)
    assert len(res.output) <= 4200 and "characters cut" in res.output


def test_run_shell_rejects_empty_and_oversized_commands():
    assert run_shell("   ").exit_code is None
    big = run_shell("echo " + "a" * 2500)
    assert big.exit_code is None and "too long" in big.output


def test_truncate_middle_keeps_head_and_tail():
    text = "H" * 3000 + "T" * 3000
    out = truncate_middle(text, 100)
    assert out.startswith("H") and out.endswith("T") and "cut" in out


# ----------------------------------------------------------------------- #
# transport: event mapping and handlers (fake neonize client)
# ----------------------------------------------------------------------- #
def jid(user, server="s.whatsapp.net"):
    return SimpleNamespace(User=user, Server=server)


def msg_event(text="hi", *, sender=OWNER, from_me=False, group=False, alt=None, extended=False):
    message = SimpleNamespace(conversation="", extendedTextMessage=SimpleNamespace(text=""))
    if extended:
        message.extendedTextMessage.text = text
    else:
        message.conversation = text
    source = SimpleNamespace(Chat=jid(sender), Sender=jid(sender), SenderAlt=jid(alt) if alt else None,
                             IsFromMe=from_me, IsGroup=group)
    return SimpleNamespace(Info=SimpleNamespace(MessageSource=source), Message=message)


def test_inbound_maps_plain_and_extended_text():
    assert inbound_from_event(msg_event("hello")).text == "hello"
    assert inbound_from_event(msg_event("link", extended=True)).text == "link"


def test_inbound_prefers_phone_when_sender_is_lid():
    lid_event = msg_event("x")
    lid_event.Info.MessageSource.Sender = jid("123456789", server="lid")
    lid_event.Info.MessageSource.SenderAlt = jid(OWNER)
    assert inbound_from_event(lid_event).sender_phone == OWNER


def test_inbound_flags_group_and_own_messages():
    assert inbound_from_event(msg_event(group=True)).is_group is True
    assert inbound_from_event(msg_event(from_me=True)).from_me is True


class FakeEventManager:
    def __init__(self):
        self.handlers: dict = {}
        self.qr_handler = None

    def __call__(self, event_type):
        def register(fn):
            self.handlers[event_type] = fn
        return register

    def qr(self, fn):
        self.qr_handler = fn


class FakeClient:
    def __init__(self, linked_user=AGENT):
        self.event = FakeEventManager()
        self.linked_user = linked_user
        self.sent: list[tuple[str, str]] = []
        self.disconnected = False

    def connect(self):
        return None

    def disconnect(self):
        self.disconnected = True

    def get_me(self):
        return SimpleNamespace(JID=SimpleNamespace(User=self.linked_user))

    def send_message(self, to, text):
        self.sent.append((to, text))

    def fire(self, event_type, event):
        self.event.handlers[event_type](self, event)


def make_transport(tmp_path, client, **kwargs):
    statuses: list[str] = []
    inbound: list[Inbound] = []
    t = WhatsAppTransport(agent_number=AGENT, session_path=tmp_path / "wa" / "session.sqlite3",
                          on_message=inbound.append, on_status=statuses.append,
                          client_factory=lambda path: client, **kwargs)
    return t, statuses, inbound


def test_transport_refuses_to_send_before_connected(tmp_path):
    client = FakeClient()
    t, _, _ = make_transport(tmp_path, client)
    t.start()
    with pytest.raises(TransportError):
        t.send_text(OWNER, "hi")


def test_transport_connects_with_matching_account_and_sends(tmp_path):
    client = FakeClient(linked_user=AGENT)
    t, statuses, _ = make_transport(tmp_path, client)
    t.start()
    client.fire("ConnectedEv", None)
    assert t.connected.is_set()
    t.send_text(OWNER, "hello")
    assert client.sent == [(OWNER, "hello")]
    assert any("connected as agent" in s for s in statuses)


def test_transport_refuses_wrong_linked_account(tmp_path):
    client = FakeClient(linked_user=OWNER)  # someone linked the owner's own phone
    t, statuses, _ = make_transport(tmp_path, client)
    t.start()
    client.fire("ConnectedEv", None)
    assert t.mismatch is True
    assert not t.connected.is_set()
    assert client.disconnected is True
    assert any("refusing to run" in s for s in statuses)


def test_transport_routes_only_direct_messages_to_callback(tmp_path):
    client = FakeClient()
    t, _, inbound = make_transport(tmp_path, client)
    t.start()
    client.fire("MessageEv", msg_event("from owner"))
    client.fire("MessageEv", msg_event("group chatter", group=True))
    client.fire("MessageEv", msg_event("my own reply", from_me=True))
    client.fire("MessageEv", msg_event("   "))
    assert [m.text for m in inbound] == ["from owner"]
    assert inbound[0].sender_phone == OWNER


def test_session_files_are_forced_to_owner_only(tmp_path):
    client = FakeClient()
    t, _, _ = make_transport(tmp_path, client)
    t.start()
    db = t.session_path
    db.write_bytes(b"keys")
    os.chmod(db, 0o644)
    t._secure_session_files()
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(db.parent).st_mode) == 0o700


def test_qr_is_forwarded_to_sink(tmp_path):
    client = FakeClient()
    codes: list[str] = []
    t, statuses, _ = make_transport(tmp_path, client, on_qr=codes.append)
    t.start()
    client.event.qr_handler(client, b"2@abc,def")
    assert codes == ["2@abc,def"]
    assert any("scan this QR code" in s for s in statuses)


def test_missing_neonize_gives_actionable_error(monkeypatch, tmp_path):
    from observer_core.remote import whatsapp as wa

    def boom():
        raise wa.WhatsAppUnavailable("needs neonize and libmagic")

    monkeypatch.setattr(wa, "_load_neonize", boom)
    t = WhatsAppTransport(agent_number=AGENT, session_path=tmp_path / "s.sqlite3")
    with pytest.raises(wa.WhatsAppUnavailable) as info:
        t.start()
    assert "libmagic" in str(info.value)


# ----------------------------------------------------------------------- #
# service wiring and end to end through the fake client
# ----------------------------------------------------------------------- #
def configured(**overrides) -> AppConfig:
    cfg = AppConfig()
    cfg.whatsapp.enabled = True
    cfg.whatsapp.agent_number = overrides.get("agent", "8859555795")
    cfg.whatsapp.allowed_number = overrides.get("allowed", "9528923866")
    cfg.whatsapp.country_code = "91"
    return cfg


def test_validated_numbers_rejects_same_account_and_empty():
    with pytest.raises(RemoteConfigError):
        validated_numbers(configured(agent="9528923866", allowed="+91 95289 23866"))
    with pytest.raises(RemoteConfigError):
        validated_numbers(configured(allowed=""))
    with pytest.raises(RemoteConfigError):
        validated_numbers(configured(agent="12"))
    assert validated_numbers(configured()) == (AGENT, OWNER)


def test_service_end_to_end_with_fake_client(tmp_path):
    client = FakeClient(linked_user=AGENT)
    model = ScriptedModel([
        action("shell", command="df -h /", reason="check disk"),
        action("done", summary="Disk has room."),
    ])
    shell_calls: list[str] = []

    def shell(command, cwd=None, timeout_s=0):
        shell_calls.append(command)
        return ShellResult(command=command, exit_code=0, output="Filesystem ... 40% used")

    service = WhatsAppService(configured(), provider=model, client_factory=lambda p: client,
                              shell=shell, session=tmp_path / "s.sqlite3")
    service.start()
    client.fire("ConnectedEv", None)
    client.fire("MessageEv", msg_event("how is my disk?"))
    assert wait_until(lambda: any("df -h /" in t for _, t in client.sent))
    assert shell_calls == []
    client.fire("MessageEv", msg_event("yes"))
    assert wait_until(lambda: any("Disk has room" in t for _, t in client.sent))
    assert shell_calls == ["df -h /"]
    assert all(to == OWNER for to, _ in client.sent)
    service.stop()


def test_service_ignores_stranger_end_to_end(tmp_path):
    client = FakeClient(linked_user=AGENT)
    model = ScriptedModel([action("done", summary="should not happen")])
    service = WhatsAppService(configured(), provider=model, client_factory=lambda p: client,
                              session=tmp_path / "s.sqlite3")
    service.start()
    client.fire("ConnectedEv", None)
    client.fire("MessageEv", msg_event("run rm -rf", sender=STRANGER))
    time.sleep(0.2)
    assert client.sent == []
    assert model.calls == []


def test_service_describe_masks_numbers_and_flags_cloud(tmp_path):
    cfg = configured()
    cfg.models.provider = "cloud"
    cfg.privacy.allow_cloud_models = True
    service = WhatsAppService(cfg, provider=ScriptedModel([], is_cloud=True),
                              client_factory=lambda p: FakeClient(), session=tmp_path / "s.sqlite3")
    info = service.describe()
    assert "9528923866" not in str(info)
    assert info["is_cloud"] == "True" and info["agent"] == "********5795"


# ----------------------------------------------------------------------- #
# configuration and CLI
# ----------------------------------------------------------------------- #
def test_whatsapp_is_disabled_by_default_and_env_can_set_numbers(monkeypatch):
    cfg = AppConfig()
    assert cfg.whatsapp.enabled is False
    monkeypatch.setenv("OBSERVER_WHATSAPP_ALLOWED_NUMBER", "9528923866")
    monkeypatch.setenv("OBSERVER_WHATSAPP_AGENT_NUMBER", "8859555795")
    cfg.apply_env_overrides()
    assert cfg.whatsapp.allowed_number == "9528923866"
    assert cfg.whatsapp.agent_number == "8859555795"


def test_setup_command_writes_config_0600_and_enables(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app
    from observer_core.config import AppConfig as _AC

    runner = CliRunner()
    result = runner.invoke(app, ["whatsapp", "setup", "--agent", "8859555795", "--allow", "9528923866"])
    assert result.exit_code == 0, result.output
    assert "9528923866" not in result.output  # masked in output
    cfg_path = _AC.load(apply_env=False).source_path
    text = open(cfg_path, encoding="utf-8").read()
    assert "enabled = true" in text and "allowed_number" in text
    assert stat.S_IMODE(os.stat(cfg_path).st_mode) == 0o600


def test_setup_command_rejects_same_numbers(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app

    result = CliRunner().invoke(app, ["whatsapp", "setup", "--agent", "9528923866", "--allow", "9528923866"])
    assert result.exit_code == 2
    assert "must be different" in result.output


def test_run_refuses_when_not_paired(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app

    CliRunner().invoke(app, ["whatsapp", "setup", "--agent", "8859555795", "--allow", "9528923866"])
    result = CliRunner().invoke(app, ["whatsapp", "run"])
    assert result.exit_code == 2
    assert "not paired" in result.output


def test_status_runs_without_network_or_neonize(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app

    result = CliRunner().invoke(app, ["whatsapp", "status"])
    assert result.exit_code == 0, result.output
    assert "enabled:" in result.output and "session paired:" in result.output


def test_unpair_requires_yes(tmp_path):
    from typer.testing import CliRunner

    from observer_core.cli import app

    result = CliRunner().invoke(app, ["whatsapp", "unpair"])
    assert result.exit_code == 2 and "--yes" in result.output
