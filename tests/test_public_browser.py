"""Public-web browser scope, web research jobs, playbooks, and model advice.

All fakes: no Chromium, no network, no model server.
"""

from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest

from observer_core.remote.browser import (
    ARENA_URL,
    PUBLIC_WEB,
    BrowserJobError,
    Element,
    JobResult,
    PageSnapshot,
    check_action,
    host_allowed,
    is_private_host,
    parse_browser_action,
    run_browser_job,
    scope_hosts,
    search_url,
    should_block,
    unwrap_result_url,
)
from observer_core.remote.model_advice import Hardware, advice_lines, detect_hardware, recommend
from observer_core.remote.playbooks import (
    MODES,
    build_system_prompt,
    load_examples,
    select_examples,
)
from tests.fakes import ScriptedModel
from tests.test_remote_features import OWNER, FakeSession, act, commander, wait_until

PUBLIC = (PUBLIC_WEB,)
DDG = "https://html.duckduckgo.com/html/?q=raspberry+pi+5+cpu"
ARTICLE = "https://en.wikipedia.org/wiki/Raspberry_Pi"


# ----------------------------------------------------------------------- #
# host rules
# ----------------------------------------------------------------------- #
@pytest.mark.parametrize("host", [
    "localhost", "router", "nas", "printer.local", "wiki.internal", "dev.localhost",
    "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.4.2", "169.254.169.254", "100.64.0.1",
    "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0",
])
def test_private_hosts_are_refused(host):
    assert is_private_host(host) is True


@pytest.mark.parametrize("host", [
    "example.com", "en.wikipedia.org", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "docs.python.org",
])
def test_public_hosts_are_allowed(host):
    assert is_private_host(host) is False


@pytest.mark.parametrize("url, ok", [
    ("https://en.wikipedia.org/wiki/Nainital", True),
    ("https://www.raspberrypi.com/products/", True),
    ("http://en.wikipedia.org/", False),           # https only
    ("https://192.168.1.1/admin", False),          # router admin
    ("https://localhost:8080/", False),
    ("https://nas/", False),
    ("file:///etc/passwd", False),
])
def test_public_scope_host_rule(url, ok):
    assert host_allowed(url, PUBLIC) is ok


def test_public_scope_blocks_local_network_requests_at_the_network_layer():
    assert should_block("https://example.com/app.js", PUBLIC) is False
    assert should_block("http://router.lan/", PUBLIC) is True
    assert should_block("https://192.168.0.10/", PUBLIC) is True
    assert should_block("about:blank", PUBLIC) is False


def test_scope_setting_maps_to_hosts_and_fails_closed():
    assert scope_hosts("public") == (PUBLIC_WEB,)
    assert scope_hosts("arena") == ("arena.ai",)
    assert scope_hosts("anything-else") == ("arena.ai",)   # unknown values stay narrow


def test_search_url_quotes_the_query():
    assert search_url("  a b&c  ") == "https://html.duckduckgo.com/html/?q=a+b%26c"


def test_search_results_are_unwrapped_to_the_real_destination():
    wrapped = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRaspberry_Pi&rut=abc"
    assert unwrap_result_url(wrapped) == ARTICLE
    assert unwrap_result_url("https://example.com/x") == "https://example.com/x"
    # a redirect to something that is not https is left alone (and then blocked by the rules)
    assert unwrap_result_url("https://duckduckgo.com/l/?uddg=http%3A%2F%2Fx") == "https://duckduckgo.com/l/?uddg=http%3A%2F%2Fx"


def test_search_action_parses_and_is_checked():
    assert parse_browser_action('{"action":"search","query":"python release"}') == {
        "action": "search", "query": "python release"}
    assert parse_browser_action('{"action":"search","query":"   "}') is None
    assert parse_browser_action('{"action":"search"}') is None
    elements: dict = {}
    assert check_action({"action": "search", "query": "x"}, elements, PUBLIC) is None
    assert "not available" in check_action({"action": "search", "query": "x"}, elements, ("arena.ai",))
    assert "characters" in check_action({"action": "search", "query": "x" * 300}, elements, PUBLIC)


def test_public_scope_still_refuses_secrets_and_forbidden_clicks():
    elements = {1: Element(1, "input", "password", "Password", "pw", True),
                2: Element(2, "button", "", "Sign out", "", False),
                3: Element(3, "textarea", "", "Ask", "", True)}
    assert "password" in check_action({"action": "type", "id": 1, "text": "x"}, elements, PUBLIC)
    assert "not allowed" in check_action({"action": "click", "id": 2}, elements, PUBLIC)
    assert check_action({"action": "type", "id": 3, "text": "hello"}, elements, PUBLIC) is None
    assert "not allowed" in check_action({"action": "goto", "url": "https://192.168.0.1/"}, elements, PUBLIC)


def test_snapshot_render_shows_link_targets():
    snap = PageSnapshot(url=DDG, title="t", text="x", elements=[
        Element(2, "a", "", "Raspberry Pi", "", False, href=ARTICLE)])
    assert f"-> {ARTICLE}" in snap.render()


# ----------------------------------------------------------------------- #
# research job
# ----------------------------------------------------------------------- #
class PagesSession(FakeSession):
    """Each snapshot returns the next page; the last page repeats."""

    def __init__(self, pages):
        super().__init__()
        self._pages = list(pages)
        self._i = 0

    def snapshot(self):
        page = self._pages[min(self._i, len(self._pages) - 1)]
        self._i += 1
        return page


def results_page():
    return PageSnapshot(url=DDG, title="raspberry pi 5 cpu", text="Results", elements=[
        Element(1, "input", "text", "raspberry pi 5 cpu", "q", True),
        Element(2, "a", "", "Raspberry Pi - Wikipedia", "", False, href=ARTICLE)])


def article_page():
    return PageSnapshot(url=ARTICLE, title="Raspberry Pi", text="The Pi uses a Broadcom SoC.", elements=[])


def test_research_job_opens_search_follows_a_result_and_reports_sources():
    session = PagesSession([results_page(), article_page(), article_page()])
    model = ScriptedModel([
        act("click", id=2),
        act("done", summary="The Raspberry Pi 5 uses a Broadcom SoC."),
    ])
    said = []
    result = run_browser_job("raspberry pi 5 cpu", session=session, provider=model, ask=lambda q: "",
                             say=said.append, mode="research", allowed_hosts=PUBLIC)
    assert session.calls[0] == ("goto", search_url("raspberry pi 5 cpu"))
    assert ("click", 2) in session.calls
    assert result.summary.startswith("The Raspberry Pi 5")
    assert result.sources == [ARTICLE]               # the search page itself is not a source


def test_research_job_search_action_runs_a_second_query():
    session = PagesSession([results_page(), results_page(), article_page()])
    model = ScriptedModel([
        act("search", query="broadcom bcm2712 datasheet"),
        act("done", summary="Found the datasheet reference."),
    ])
    said = []
    run_browser_job("pi cpu", session=session, provider=model, ask=lambda q: "", say=said.append,
                    mode="research", allowed_hosts=PUBLIC)
    assert ("goto", search_url("broadcom bcm2712 datasheet")) in session.calls
    assert any("searched: broadcom bcm2712 datasheet" in s for s in said)


def test_research_job_refuses_search_when_scope_is_arena_only():
    session = PagesSession([results_page(), results_page()])
    model = ScriptedModel([act("search", query="x"), act("done", summary="ok")])
    with pytest.raises(BrowserJobError, match="browser_scope"):
        run_browser_job("pi cpu", session=session, provider=model, ask=lambda q: "", say=lambda t: None,
                        mode="research", allowed_hosts=("arena.ai",))
    assert session.calls == []                        # refused before any page loaded


def test_arena_job_never_gets_sources_and_refuses_search():
    session = FakeSession()
    model = ScriptedModel([act("search", query="x"), act("done", summary="done")])
    result = run_browser_job("make a logo", session=session, provider=model, ask=lambda q: "",
                             say=lambda t: None, mode="arena", allowed_hosts=("arena.ai",))
    assert result.sources == []
    assert ("goto", ARENA_URL) == session.calls[0]
    assert all(c[0] != "goto" or c[1] == ARENA_URL for c in session.calls)


def test_unknown_mode_is_rejected():
    with pytest.raises(BrowserJobError, match="unknown job mode"):
        run_browser_job("x", session=FakeSession(), provider=ScriptedModel([act("done", summary="x")]),
                        ask=lambda q: "", say=lambda t: None, mode="shell")


def test_sources_are_capped():
    pages = [PageSnapshot(url=f"https://site{i}.example.com/", title="t", text="x", elements=[])
             for i in range(20)]
    session = PagesSession(pages)
    model = ScriptedModel([act("read")] * 19 + [act("done", summary="ok")])
    result = run_browser_job("q", session=session, provider=model, ask=lambda q: "", say=lambda t: None,
                             mode="research", allowed_hosts=PUBLIC, max_steps=25)
    assert len(result.sources) == 10


# ----------------------------------------------------------------------- #
# playbooks
# ----------------------------------------------------------------------- #
ELEMENT_LINE = re.compile(r'^\[(\d+)\] (\w+)(?:\[(\w*)\])? "(.*?)"(?: \(secret[^)]*\))?(?: -> (\S+))?$')


def elements_from_page(page: str) -> dict[int, Element]:
    out = {}
    for line in page.splitlines():
        m = ELEMENT_LINE.match(line.strip())
        if not m:
            continue
        i, tag, typ, label, href = m.groups()
        out[int(i)] = Element(int(i), tag, typ or "", label, "", tag in ("input", "textarea"), href or "")
    return out


def test_playbook_files_exist_and_name_every_mode():
    from observer_core.remote.playbooks import PLAYBOOK_DIR

    for name in ("system.md", "arena.md", "research.md", "examples.jsonl"):
        assert (PLAYBOOK_DIR / name).read_text(encoding="utf-8").strip()
    system = (PLAYBOOK_DIR / "system.md").read_text(encoding="utf-8")
    assert '"search"' in system and '"done"' in system
    assert set(MODES) == {"arena", "research"}


def test_every_example_is_valid_for_the_browser_and_matches_its_page():
    examples = load_examples()
    assert len(examples) >= 10
    for ex in examples:
        assert ex.mode in MODES, ex.goal
        raw = json.dumps(ex.action)
        parsed = parse_browser_action(raw)
        assert parsed is not None, ex.goal
        elements = elements_from_page(ex.page)
        refusal = check_action(parsed, elements, PUBLIC if ex.mode == "research" else ("arena.ai",))
        assert refusal is None, (ex.goal, refusal)


def test_select_examples_prefers_matching_goal_within_the_mode():
    picked = select_examples("arena", "write a poem about hills")
    assert picked and all(e.mode == "arena" for e in picked)
    assert "poem" in picked[0].goal
    research = select_examples("research", "python version")
    assert all(e.mode == "research" for e in research)


def test_system_prompt_joins_instructions_playbook_and_examples():
    text = build_system_prompt("research", "who makes the raspberry pi 5 cpu")
    assert "reply with EXACTLY ONE JSON object" in text
    assert "Job: answer the owner's question" in text
    assert "Worked example" in text and "raspberry" in text.lower()
    assert len(text) <= 6000


def test_system_prompt_drops_whole_examples_never_cuts_one():
    for budget in (3000, 3500, 4500, 6000):
        text = build_system_prompt("arena", "write a poem", budget=budget)
        assert text.count("## Worked example") == text.count("Correct action:")   # every example is complete
        assert "reply with EXACTLY ONE JSON object" in text
        if text.count("## Worked example") == 0:
            assert len(text) <= budget or budget < 3000
    assert build_system_prompt("arena", "x", budget=10_000).count("## Worked example") == 3


def test_system_prompt_rejects_unknown_mode():
    with pytest.raises(ValueError):
        build_system_prompt("shell", "x")


# ----------------------------------------------------------------------- #
# commander: RESEARCH: command
# ----------------------------------------------------------------------- #
def test_research_command_shows_the_question_then_runs_after_yes(tmp_path):
    seen = {}

    def runner(prompt, ask, say, mode="arena"):
        seen.update(prompt=prompt, mode=mode)
        return JobResult(summary="Broadcom BCM2712.", downloads=[], sources=[ARTICLE])

    cmd, transport, _ = commander(tmp_path, browser=runner)
    cmd.handle_inbound(OWNER, "RESEARCH: what cpu is in the pi 5")
    assert wait_until(lambda: any("Research job" in t for t in transport.sent))
    assert "prompt" not in seen                         # nothing runs before YES
    assert any("what cpu is in the pi 5" in t for t in transport.sent)
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert seen == {"prompt": "what cpu is in the pi 5", "mode": "research"}
    reply = [t for t in transport.sent if t.startswith("✅ Research result")][0]
    assert "Broadcom BCM2712." in reply and f"Sources:\n{ARTICLE}" in reply


def test_word_research_without_colon_is_not_a_direct_command(tmp_path):
    cmd, transport, _ = commander(tmp_path, responses=[json.dumps({"action": "done", "summary": "hi"})],
                                  browser=lambda *a, **k: JobResult(summary="x", downloads=[]))
    cmd.handle_inbound(OWNER, "research the history of hill stations")
    assert cmd.wait_idle(5)
    assert not any("Research job" in t for t in transport.sent)


def test_arena_word_without_colon_is_not_a_direct_command(tmp_path):
    cmd, transport, _ = commander(tmp_path, responses=[json.dumps({"action": "done", "summary": "hi"})],
                                  browser=lambda *a, **k: JobResult(summary="x", downloads=[]))
    cmd.handle_inbound(OWNER, "arena is a good name for a club")
    assert cmd.wait_idle(5)
    assert not any("Arena browser job" in t for t in transport.sent)


def test_research_job_stop_message_uses_research_label(tmp_path):
    def runner(prompt, ask, say, mode="arena"):
        raise BrowserJobError("the job did not finish within 40 steps")

    cmd, transport, _ = commander(tmp_path, browser=runner)
    cmd.handle_inbound(OWNER, "RESEARCH: anything")
    assert wait_until(lambda: any("Research job" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert any("research job stopped: the job did not finish" in t for t in transport.sent)


# ----------------------------------------------------------------------- #
# model advice
# ----------------------------------------------------------------------- #
def test_detect_hardware_reads_ram_and_no_gpu(tmp_path, monkeypatch):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:       16777216 kB\nMemFree:  1 kB\n", encoding="utf-8")
    monkeypatch.setattr("observer_core.remote.model_advice.shutil.which", lambda name: None)
    hw = detect_hardware(str(meminfo))
    assert hw.ram_gb == 16.0 and hw.gpu is None and hw.vram_gb is None


def test_detect_hardware_reads_gpu_when_nvidia_smi_works(tmp_path, monkeypatch):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 8388608 kB\n", encoding="utf-8")
    monkeypatch.setattr("observer_core.remote.model_advice.shutil.which", lambda name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr("observer_core.remote.model_advice.subprocess.run",
                        lambda *a, **k: SimpleNamespace(stdout="NVIDIA GeForce RTX 3060, 12288\n"))
    hw = detect_hardware(str(meminfo))
    assert hw.gpu == "NVIDIA GeForce RTX 3060" and hw.vram_gb == 12.0


def test_detect_hardware_tolerates_missing_meminfo(tmp_path, monkeypatch):
    monkeypatch.setattr("observer_core.remote.model_advice.shutil.which", lambda name: None)
    assert detect_hardware(str(tmp_path / "nope")).ram_gb is None


@pytest.mark.parametrize("hw, tag", [
    (Hardware(ram_gb=32, gpu="RTX", vram_gb=12), "qwen2.5:7b"),
    (Hardware(ram_gb=16, gpu=None, vram_gb=None), "qwen2.5:7b"),
    (Hardware(ram_gb=8, gpu=None, vram_gb=None), "qwen2.5:3b"),
    (Hardware(ram_gb=4, gpu=None, vram_gb=None), "qwen2.5:1.5b"),
    (Hardware(ram_gb=None, gpu=None, vram_gb=None), "qwen2.5:1.5b"),
])
def test_recommendation_follows_hardware(hw, tag):
    assert recommend(hw).tag == tag


def test_small_machine_gets_a_warning_and_the_cloud_trade_off_is_stated():
    lines = advice_lines(Hardware(ram_gb=4, gpu=None, vram_gb=None), recommend(Hardware(4, None, None)), "llama3.2")
    text = "\n".join(lines)
    assert "ollama pull qwen2.5:1.5b" in text
    assert "more retries" in text
    assert "your WhatsApp messages" in text             # cloud trade-off is always shown
    assert "Currently configured: llama3.2" in text


def test_model_advice_cli_prints_without_changing_config(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from observer_core.remote.cli_whatsapp import whatsapp_app

    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setattr("observer_core.remote.cli_whatsapp.load_or_create", lambda *a, **k: _cfg())
    monkeypatch.setattr("observer_core.remote.model_advice.detect_hardware",
                        lambda *a, **k: Hardware(ram_gb=16, gpu=None, vram_gb=None))
    result = CliRunner().invoke(whatsapp_app, ["model-advice"])
    assert result.exit_code == 0, result.output
    assert "Suggested model: qwen2.5:7b" in result.output
    assert "ollama pull qwen2.5:7b" in result.output


def _cfg():
    from observer_core.config import AppConfig

    return AppConfig()


def test_browser_scope_defaults_to_public_and_is_documented():
    from observer_core.config import skeleton_toml

    assert _cfg().whatsapp.browser_scope == "public"
    assert "browser_scope" in skeleton_toml()


def test_service_refuses_automated_arena_jobs_and_runs_research_on_public_web(tmp_path, monkeypatch):
    """Automated arena.ai jobs are off; the research runner still uses the configured public scope."""
    from observer_core.remote import service as service_mod
    from observer_core.remote.browser import BrowserJobError

    cfg = _cfg()
    cfg.whatsapp.browser_scope = "public"
    seen = []

    class FakeSession2:
        def __init__(self, **kwargs):
            seen.append(("session", kwargs["allowed_hosts"]))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_job(prompt, *, session, provider, ask, say, mode, max_steps, timeout_s, allowed_hosts):
        seen.append(("job", mode, allowed_hosts))
        return JobResult(summary="ok", downloads=[])

    monkeypatch.setattr(service_mod, "PlaywrightSession", FakeSession2)
    monkeypatch.setattr(service_mod, "run_browser_job", fake_job)
    svc = SimpleNamespace(cfg=cfg, provider=None)
    runner = service_mod.WhatsAppService._make_browser_runner(svc)
    with pytest.raises(BrowserJobError, match="manual arena mode"):
        runner("make a logo", lambda q: None, lambda t: None, mode="arena")
    assert seen == []   # no browser session is opened for arena.ai
    runner("who makes the pi cpu", lambda q: None, lambda t: None, mode="research")
    assert seen == [("session", (PUBLIC_WEB,)), ("job", "research", (PUBLIC_WEB,))]


@pytest.mark.parametrize("url, nav, scope, blocked", [
    ("https://arena.ai/agent", True, ("arena.ai",), False),           # the page itself
    ("https://accounts.example.com/login", True, ("arena.ai",), True),   # navigating away: no
    ("https://cdn.example.net/app.js", False, ("arena.ai",), False),  # a script the page needs: yes
    ("https://fonts.example.org/x.woff2", False, ("arena.ai",), False),
    ("http://cdn.example.net/app.js", False, ("arena.ai",), True),    # plain http: no
    ("https://192.168.1.1/admin", False, (PUBLIC_WEB,), True),       # local network: never
    ("https://192.168.1.1/admin", True, (PUBLIC_WEB,), True),
    ("https://router.lan/", False, ("arena.ai",), True),
    ("https://en.wikipedia.org/wiki/X", True, (PUBLIC_WEB,), False),  # research: any public page
    ("about:blank", True, ("arena.ai",), False),
    ("data:text/plain,hi", False, ("arena.ai",), False),
])
def test_request_rule_separates_pages_from_resources(url, nav, scope, blocked):
    from observer_core.remote.browser import should_block_request

    assert should_block_request(url, nav, scope) is blocked


@pytest.mark.parametrize("title, text, blocked", [
    ("arena", "We've prompted this page a thousand ways. It's not cooperating. Something unexpected happened.", True),
    ("Just a moment...", "Checking your browser before accessing the site.", True),
    ("Unusual traffic", "Our systems have detected unusual traffic from your network.", True),
    ("Wikipedia", "Nainital is a hill station in Uttarakhand.", False),
    ("DuckDuckGo", "Results for raspberry pi 5 cpu", False),
])
def test_block_page_detection(title, text, blocked):
    from observer_core.remote.browser import is_blocked_page

    assert is_blocked_page(title, text) is blocked
