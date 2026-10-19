"""Routines, timers, arena.ai browser job, and the direct WhatsApp commands.

Everything is driven by fakes: no Chromium, no WhatsApp, no real app launches
(except one probe that checks an app which cannot exist).
"""

from __future__ import annotations

import json
import os
import stat
import time
from types import SimpleNamespace

import pytest

from observer_core.llm.base import ProviderError
from observer_core.remote.browser import (
    ARENA_URL,
    BrowserJobError,
    BrowserUnavailable,
    Element,
    JobResult,
    PageSnapshot,
    PlaywrightSession,
    check_action,
    host_allowed,
    parse_browser_action,
    run_browser_job,
    safe_filename,
    should_block,
)
from observer_core.remote.commander import Commander, CommanderSettings
from observer_core.remote.routines import (
    EXAMPLE_ROUTINES,
    RoutineError,
    RoutineService,
    execute_routine,
    launch_app,
    load_routines,
    parse_routines,
)
from observer_core.remote.shell import ShellResult
from observer_core.remote.timers import TimerStore
from tests.fakes import ScriptedModel

OWNER = "919528923866"
STRANGER = "919000000001"


class Transport:
    def __init__(self):
        self.sent: list[str] = []

    def send_text(self, user, text):
        self.sent.append(text)


def wait_until(predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def act(kind, **fields):
    return json.dumps({"action": kind, **fields})


GOOD_TOML = """
[[routine]]
name = "home"
description = "Desk ready"
steps = [
  { open_app = "firefox" },
  { open_url = "https://arena.ai/agent" },
  { run = "echo hello" },
  { notify = "Welcome home" },
  { wait = 1 },
]

[[routine]]
name = "bad"
steps = [ { open_app = "two words" } ]
"""


# ----------------------------------------------------------------------- #
# routines: parsing
# ----------------------------------------------------------------------- #
def test_good_routine_parses_every_step_kind():
    import tomllib

    routines, errors = parse_routines(tomllib.loads(GOOD_TOML))
    assert [s.kind for s in routines["home"].steps] == ["open_app", "open_url", "run", "notify", "wait"]
    assert routines["home"].description == "Desk ready"


def test_bad_routine_is_reported_but_good_ones_still_load():
    import tomllib

    routines, errors = parse_routines(tomllib.loads(GOOD_TOML))
    assert "home" in routines and "bad" not in routines
    assert any("open_app needs a program name" in e for e in errors)


@pytest.mark.parametrize("step,message", [
    ({"open_app": "firefox", "run": "x"}, "exactly one key"),
    ({"format_disk": "sda"}, "unknown step"),
    ({"open_url": "file:///etc/passwd"}, "needs an http"),
    ({"run": "echo a\necho b"}, "one command line"),
    ({"wait": 9999}, "from 0 to 300"),
    ({"wait": True}, "from 0 to 300"),
    ({"notify": ""}, "notify needs text"),
])
def test_invalid_steps_are_rejected(step, message):
    from observer_core.remote.routines import parse_step

    with pytest.raises(RoutineError, match=message):
        parse_step(step, "routine 'x'")


def test_routine_name_and_duplicates_and_limits():
    routines, errors = parse_routines({"routine": [
        {"name": "Bad Name!", "steps": [{"wait": 1}]},
        {"name": "dup", "steps": [{"wait": 1}]},
        {"name": "dup", "steps": [{"wait": 1}]},
        {"name": "long", "steps": [{"wait": 1}] * 21},
        {"name": "nosteps", "steps": []},
    ]})
    assert list(routines) == ["dup"]
    joined = " | ".join(errors)
    assert "name must be" in joined and "duplicate" in joined and "at most 20 steps" in joined and "non-empty" in joined


def test_missing_and_broken_routine_files(tmp_path):
    assert load_routines(tmp_path / "none.toml") == ({}, [])
    broken = tmp_path / "r.toml"
    broken.write_text("[[routine\nname =", encoding="utf-8")
    routines, errors = load_routines(broken)
    assert routines == {} and errors and str(broken) in errors[0]


def test_example_file_is_valid_and_defines_nothing_active(tmp_path):
    path = tmp_path / "routines.toml"
    path.write_text(EXAMPLE_ROUTINES, encoding="utf-8")
    assert load_routines(path) == ({}, [])


# ----------------------------------------------------------------------- #
# routines: execution with fakes
# ----------------------------------------------------------------------- #
def test_execute_routine_runs_steps_in_order_and_stops_on_failure():
    import tomllib

    routines, _ = parse_routines(tomllib.loads(GOOD_TOML))
    said, launched, opened, shelled, slept = [], [], [], [], []

    def launch(name):
        launched.append(name)
        return True, f"started {name}"

    def opener(url):
        opened.append(url)
        return True, f"opened {url}"

    def shell(cmd, cwd=None, timeout_s=0):
        shelled.append(cmd)
        return ShellResult(command=cmd, exit_code=0, output="hello")

    ok, summary = execute_routine(routines["home"], say=said.append, shell=shell, launch=launch,
                                  opener=opener, sleep=slept.append)
    assert ok and "all 5 steps done" in summary
    assert launched == ["firefox"] and opened == ["https://arena.ai/agent"]
    assert shelled == ["echo hello"] and slept == [1.0]
    assert "📣 Welcome home" in said


def test_execute_routine_stops_at_first_failure():
    import tomllib

    routines, _ = parse_routines(tomllib.loads(GOOD_TOML))
    later = []
    ok, summary = execute_routine(routines["home"], say=lambda t: None,
                                  launch=lambda n: (False, f"{n} is not installed"),
                                  opener=lambda u: later.append(u) or (True, "ok"))
    assert not ok and "stopped at step 1/5" in summary and later == []


def test_launch_app_reports_missing_program_without_crashing():
    started, message = launch_app("definitely-not-an-app-xyz-123")
    assert started is False and "not installed" in message


# ----------------------------------------------------------------------- #
# timers
# ----------------------------------------------------------------------- #
def test_timers_persist_with_private_mode_and_survive_restart(tmp_path):
    path = tmp_path / "data" / "timers.json"
    store = TimerStore(path, clock=lambda: 1000.0)
    t1 = store.add("home", fire_at=1300.0)
    t2 = store.add("work", fire_at=1600.0)
    assert (t1.id, t2.id) == (1, 2)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    again = TimerStore(path)
    assert [t.routine for t in again.list()] == ["home", "work"]
    assert again.add("x", fire_at=2000.0).id == 3   # ids keep counting after restart


def test_timer_cancel_and_pop_due(tmp_path):
    store = TimerStore(tmp_path / "timers.json")
    a = store.add("home", fire_at=100.0, now=0.0)
    b = store.add("home", fire_at=500.0, now=0.0)
    assert store.cancel(b.id) is True and store.cancel(b.id) is False
    due = store.pop_due(now=150.0)
    assert [t.id for t in due] == [a.id]
    assert store.list() == []


def test_corrupt_timer_file_is_moved_aside_not_fatal(tmp_path):
    path = tmp_path / "timers.json"
    path.write_text("{not json", encoding="utf-8")
    store = TimerStore(path)
    assert store.list() == []
    assert path.with_suffix(".corrupt").exists()


def make_service(tmp_path, *, routines_text=GOOD_TOML, executor=None, clock=None):
    import tomllib

    routines, _ = parse_routines(tomllib.loads(routines_text))
    said: list[str] = []
    now = {"t": 10_000.0}
    svc = RoutineService(
        routines=routines,
        store=TimerStore(tmp_path / "timers.json", clock=lambda: now["t"]),
        say=said.append,
        clock=clock or (lambda: now["t"]),
        executor=executor or (lambda routine, say, **kw: (True, "all steps done")),
    )
    return svc, said, now


def test_schedule_then_tick_runs_the_routine(tmp_path):
    ran = []
    svc, said, now = make_service(tmp_path, executor=lambda r, say, **kw: (ran.append(r.name) or True, "ok"))
    timer = svc.schedule(svc.get("home"), 5)
    assert timer.fire_at == now["t"] + 300
    assert svc.tick(now=now["t"] + 10) == []
    fired = svc.tick(now=now["t"] + 301)
    assert [t.routine for t in fired] == ["home"]
    assert wait_until(lambda: ran == ["home"])
    assert wait_until(lambda: any("✅" in s and "'home'" in s for s in said))


def test_late_timer_is_skipped_and_reported(tmp_path):
    ran = []
    svc, said, now = make_service(tmp_path, executor=lambda r, say, **kw: (ran.append(1) or True, "ok"))
    svc.schedule(svc.get("home"), 1)
    svc.tick(now=now["t"] + 60 * 60)          # an hour late: the laptop was asleep
    time.sleep(0.05)
    assert ran == []
    assert any("was skipped" in s for s in said)


def test_timer_for_removed_routine_is_skipped(tmp_path):
    svc, said, now = make_service(tmp_path)
    svc.store.add("gone", fire_at=now["t"] - 1, now=now["t"] - 100)
    svc.tick(now=now["t"])
    assert any("no longer exists" in s for s in said)


def test_schedule_rejects_out_of_range_minutes(tmp_path):
    svc, _, _ = make_service(tmp_path)
    with pytest.raises(RoutineError):
        svc.schedule(svc.get("home"), 0)
    with pytest.raises(RoutineError):
        svc.schedule(svc.get("home"), 99999)


# ----------------------------------------------------------------------- #
# browser: pure rules
# ----------------------------------------------------------------------- #
@pytest.mark.parametrize("url,ok", [
    ("https://arena.ai/agent", True),
    ("https://www.arena.ai/", True),
    ("https://arena.ai.evil.example/", False),
    ("https://evil-arena.ai/", False),
    ("http://arena.ai/", False),
    ("javascript:alert(1)", False),
    ("", False),
])
def test_host_allowed(url, ok):
    assert host_allowed(url, ("arena.ai",)) is ok


def test_should_block_everything_off_host_but_allows_inline():
    assert should_block("https://cdn.example.com/x.js") is True
    assert should_block("about:blank") is False
    assert should_block("data:text/plain,hi") is False
    assert should_block("https://arena.ai/static/app.js") is False


def el(i, tag="input", type_="text", label="", name="", editable=False):
    return Element(id=i, tag=tag, type=type_, label=label, name=name, editable=editable)


def test_check_action_refusals():
    elements = {
        1: el(1, label="Ask anything"),
        2: el(2, type_="password", label="Password"),
        3: el(3, tag="button", type_="", label="Delete account"),
        4: el(4, tag="div", type_="", label="Notes"),
        5: el(5, tag="button", type_="", label="Send"),
    }
    assert check_action({"action": "type", "id": 1, "text": "hi"}, elements) is None
    assert "password" in check_action({"action": "type", "id": 2, "text": "x"}, elements)
    assert "not allowed" in check_action({"action": "click", "id": 3}, elements)
    assert "not a text field" in check_action({"action": "type", "id": 4, "text": "x"}, elements)
    assert "no element" in check_action({"action": "click", "id": 99}, elements)
    assert check_action({"action": "click", "id": 5}, elements) is None
    assert "not allowed" in check_action({"action": "goto", "url": "https://evil.example"}, elements)
    assert check_action({"action": "goto", "url": ARENA_URL}, elements) is None


def test_parse_browser_action_validates_fields():
    assert parse_browser_action('{"action":"click","id":3}') == {"action": "click", "id": 3}
    assert parse_browser_action('{"action":"press","key":"rm -rf"}') is None
    assert parse_browser_action('{"action":"wait","seconds":600}') is None
    assert parse_browser_action('{"action":"type","id":"3","text":"x"}') is None
    assert parse_browser_action('Sure: {"action":"done","summary":"ok"} thanks')["summary"] == "ok"


def test_safe_filename_blocks_path_tricks():
    assert safe_filename("../../etc/passwd") == "passwd"
    assert "/" not in safe_filename("a/b\\c.png")
    assert safe_filename("") == "download"


def test_snapshot_render_marks_secret_fields():
    snap = PageSnapshot(url="https://arena.ai", title="Arena", text="hello",
                        elements=[el(1, type_="password", label="Password")])
    rendered = snap.render()
    assert "do not type here" in rendered and "hello" in rendered


def test_playwright_route_blocks_foreign_hosts(tmp_path):
    session = PlaywrightSession(profile_dir=tmp_path / "p", downloads_dir=tmp_path / "d", executable="/bin/true")
    calls = []

    class Route:
        def abort(self):
            calls.append("abort")

        def continue_(self):
            calls.append("continue")

    def req(url, nav=False):
        return SimpleNamespace(url=url, is_navigation_request=lambda: nav)

    session._route(Route(), req("https://tracker.example.net/x", nav=True))   # a page to another site
    session._route(Route(), req("https://arena.ai/agent", nav=True))          # the allowed page
    session._route(Route(), req("https://cdn.example.net/app.js"))            # a resource from elsewhere
    session._route(Route(), req("http://192.168.1.1/admin"))                  # local network: never
    assert calls == ["abort", "continue", "continue", "abort"]


def test_missing_chromium_is_explained(tmp_path, monkeypatch):
    import observer_core.remote.browser as browser

    monkeypatch.setattr(browser, "find_chromium", lambda: None)
    session = PlaywrightSession(profile_dir=tmp_path / "p", downloads_dir=tmp_path / "d")
    with pytest.raises(BrowserUnavailable, match="dnf install --needed chromium"):
        session.open()


# ----------------------------------------------------------------------- #
# browser: the job loop with a fake page
# ----------------------------------------------------------------------- #
class FakeSession:
    def __init__(self, pages=None):
        self.downloads: list[str] = []
        self.calls: list[tuple] = []
        self.pages = pages or [PageSnapshot(
            url="https://arena.ai/agent", title="Arena", text="Ready",
            elements=[el(1, tag="textarea", type_="", label="Ask anything"),
                      el(2, tag="input", type_="password", label="Password"),
                      el(3, tag="button", type_="", label="Sign out"),
                      el(4, tag="button", type_="", label="Send")])]

    def goto(self, url):
        self.calls.append(("goto", url))

    def snapshot(self):
        return self.pages[0]

    def click(self, element_id):
        self.calls.append(("click", element_id))

    def type_text(self, element_id, text):
        self.calls.append(("type", element_id, text))

    def press(self, key):
        self.calls.append(("press", key))

    def wait(self, seconds):
        self.calls.append(("wait", seconds))

    def close(self):
        self.calls.append(("close",))


def test_browser_job_types_prompt_presses_send_and_returns_summary():
    session = FakeSession()
    model = ScriptedModel([
        act("type", id=1, text="Make a logo"),
        act("press", key="Enter"),
        act("wait", seconds=5),
        act("done", summary="Here is the logo description."),
    ])
    said = []
    result = run_browser_job("Make a logo", session=session, provider=model, ask=lambda q: "",
                             say=said.append)
    assert isinstance(result, JobResult)
    assert result.summary == "Here is the logo description."
    assert ("goto", ARENA_URL) == session.calls[0]
    assert ("type", 1, "Make a logo") in session.calls
    assert ("press", "Enter") in session.calls
    assert any("typed on the page" in s for s in said)


def test_browser_job_refuses_password_and_forbidden_clicks():
    session = FakeSession()
    model = ScriptedModel([
        act("type", id=2, text="hunter2"),
        act("click", id=3),
        act("done", summary="Stopped; I did not sign out or type a password."),
    ])
    result = run_browser_job("x", session=session, provider=model, ask=lambda q: "", say=lambda t: None)
    assert ("type", 2, "hunter2") not in session.calls
    assert ("click", 3) not in session.calls
    assert any("Refused" in m.content for m in model.calls[1])
    assert "did not sign out" in result.summary


def test_browser_job_will_not_leave_arena():
    session = FakeSession()
    model = ScriptedModel([act("goto", url="https://evil.example/login"), act("done", summary="ok")])
    run_browser_job("x", session=session, provider=model, ask=lambda q: "", say=lambda t: None)
    assert not any(c[0] == "goto" and "evil" in c[1] for c in session.calls)


def test_browser_job_stops_when_owner_cancels_a_question():
    session = FakeSession()
    model = ScriptedModel([act("ask", question="Which style?")])
    with pytest.raises(BrowserJobError, match="stopped by the owner"):
        run_browser_job("x", session=session, provider=model, ask=lambda q: None, say=lambda t: None)


def test_browser_job_answers_an_owner_question_and_continues():
    session = FakeSession()
    model = ScriptedModel([act("ask", question="Which style?"), act("done", summary="Used the style you chose.")])
    result = run_browser_job("x", session=session, provider=model, ask=lambda q: "minimal",
                             say=lambda t: None)
    assert result.summary.startswith("Used the style")
    assert any("Owner answered: minimal" in m.content for m in model.calls[1])


def test_browser_job_step_and_time_limits():
    session = FakeSession()
    model = ScriptedModel([act("read")])
    with pytest.raises(BrowserJobError, match="did not finish within 3 steps"):
        run_browser_job("x", session=session, provider=model, ask=lambda q: "", say=lambda t: None, max_steps=3)

    ticks = iter([0.0, 5000.0, 5000.0])
    with pytest.raises(BrowserJobError, match="time limit"):
        run_browser_job("x", session=FakeSession(), provider=ScriptedModel([act("read")]), ask=lambda q: "",
                        say=lambda t: None, clock=lambda: next(ticks), timeout_s=60)


def test_browser_job_rejects_overlong_prompt_before_touching_the_page():
    session = FakeSession()
    with pytest.raises(BrowserJobError, match="longer than"):
        run_browser_job("x" * 900, session=session, provider=ScriptedModel([]), ask=lambda q: "", say=lambda t: None)
    assert session.calls == []


def test_browser_job_model_failure_propagates_as_provider_error():
    with pytest.raises(ProviderError):
        run_browser_job("x", session=FakeSession(), provider=ScriptedModel([ProviderError("down")]),
                        ask=lambda q: "", say=lambda t: None)


# ----------------------------------------------------------------------- #
# commander: direct commands and approvals
# ----------------------------------------------------------------------- #
def commander(tmp_path, responses=(), *, browser=None, executor=None):
    import tomllib

    transport = Transport()
    routines, _ = parse_routines(tomllib.loads(GOOD_TOML))
    svc = RoutineService(routines=routines, store=TimerStore(tmp_path / "t.json"), say=transport.send_text,
                         executor=executor or (lambda r, say, **kw: (True, "all steps done")))
    cmd = Commander(provider=ScriptedModel(list(responses)), transport=transport,
                    settings=CommanderSettings(owner_user=OWNER, max_steps=5, confirm_timeout_s=5,
                                               answer_timeout_s=5),
                    shell=lambda c, cwd=None, timeout_s=0: ShellResult(c, 0, "ok"),
                    routines=svc, browser=browser)
    return cmd, transport, svc


def test_routines_and_timers_listing_are_direct(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    cmd.handle_inbound(OWNER, "ROUTINES")
    assert "home" in transport.sent[-1]
    cmd.handle_inbound(OWNER, "TIMERS")
    assert transport.sent[-1] == "No timers are scheduled."


def test_run_now_shows_steps_and_runs_after_yes(tmp_path):
    ran = []
    cmd, transport, svc = commander(tmp_path, executor=lambda r, say, **kw: (ran.append(r.name) or True, "all done"))
    assert cmd.handle_inbound(OWNER, "RUN home").action == "started"
    assert wait_until(lambda: any("Routine 'home'" in t for t in transport.sent))
    prompt = [t for t in transport.sent if "Routine 'home'" in t][0]
    assert "1. open firefox" in prompt and "without asking again" in prompt
    assert ran == []
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert ran == ["home"]


def test_run_in_minutes_schedules_after_yes(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    cmd.handle_inbound(OWNER, "run home in 5 min")
    assert wait_until(lambda: any("Routine 'home'" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    timers = svc.timers()
    assert len(timers) == 1 and timers[0].routine == "home"
    assert 290 <= timers[0].fire_at - time.time() <= 305
    assert any("Scheduled #1" in t and "CANCEL 1" in t for t in transport.sent)


def test_declined_routine_schedules_nothing(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    cmd.handle_inbound(OWNER, "RUN home IN 10")
    assert wait_until(lambda: any("Routine 'home'" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "NO")
    assert cmd.wait_idle(5)
    assert svc.timers() == []
    assert "OK, nothing was scheduled or run." in transport.sent


def test_unknown_routine_is_refused_without_a_model_call(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    cmd.handle_inbound(OWNER, "RUN nope")
    assert cmd.wait_idle(5)
    assert "There is no routine named 'nope'" in transport.sent[-1]


def test_timers_list_and_cancel_by_id(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    timer = svc.schedule(svc.get("home"), 10)
    cmd.handle_inbound(OWNER, "TIMERS")
    assert f"#{timer.id} 'home'" in transport.sent[-1]
    cmd.handle_inbound(OWNER, f"CANCEL {timer.id}")
    assert transport.sent[-1] == f"⏰ Timer #{timer.id} cancelled."
    cmd.handle_inbound(OWNER, "CANCEL 99")
    assert "No timer #99" in transport.sent[-1]


def test_model_can_choose_a_routine_by_name(tmp_path):
    ran = []
    cmd, transport, svc = commander(
        tmp_path, [act("routine", name="home", in_minutes=0)],
        executor=lambda r, say, **kw: (ran.append(r.name) or True, "all done"))
    cmd.handle_inbound(OWNER, "I'm coming home, get the desk ready")
    assert wait_until(lambda: any("Routine 'home'" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert ran == ["home"]


def test_stranger_cannot_use_direct_commands(tmp_path):
    cmd, transport, svc = commander(tmp_path)
    assert cmd.handle_inbound(STRANGER, "RUN home").action == "ignored"
    assert cmd.handle_inbound(STRANGER, "ARENA: do something").action == "ignored"
    assert transport.sent == []


def test_arena_job_shows_full_prompt_then_runs_and_reports_files(tmp_path):
    seen = {}

    def runner(prompt, ask, say, mode="arena"):
        seen["prompt"] = prompt
        say("⌨️ typed on the page: " + prompt[:20])
        return JobResult(summary="Logo concept: a fox.", downloads=["fox.png"])

    cmd, transport, svc = commander(tmp_path, browser=runner)
    cmd.handle_inbound(OWNER, "ARENA: make a fox logo for my shop")
    assert wait_until(lambda: any("type this prompt" in t for t in transport.sent))
    assert "prompt" not in seen   # nothing runs before YES
    prompt_text = [t for t in transport.sent if "type this prompt" in t][0]
    assert "make a fox logo for my shop" in prompt_text
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert seen["prompt"] == "make a fox logo for my shop"
    assert any("Logo concept: a fox." in t and "fox.png" in t for t in transport.sent)


def test_arena_job_declined_does_not_start(tmp_path):
    called = []
    cmd, transport, svc = commander(tmp_path, browser=lambda p, a, s: called.append(p))
    cmd.handle_inbound(OWNER, "arena: write a poem")
    assert wait_until(lambda: any("type this prompt" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "NO")
    assert cmd.wait_idle(5)
    assert called == [] and "OK, the job was not started." in transport.sent


def test_arena_disabled_says_how_to_enable(tmp_path):
    cmd, transport, svc = commander(tmp_path, browser=None)
    cmd.handle_inbound(OWNER, "ARENA: hello")
    assert cmd.wait_idle(5)
    assert "Browser jobs are off" in transport.sent[-1]


def test_arena_job_errors_are_reported_not_raised(tmp_path):
    def runner(prompt, ask, say, mode="arena"):
        raise BrowserJobError("the job did not finish within 40 steps")

    cmd, transport, svc = commander(tmp_path, browser=runner)
    cmd.handle_inbound(OWNER, "ARENA: long job")
    assert wait_until(lambda: any("type this prompt" in t for t in transport.sent))
    cmd.handle_inbound(OWNER, "YES")
    assert cmd.wait_idle(5)
    assert any("arena.ai job stopped: the job did not finish" in t for t in transport.sent)


def test_arena_prompt_over_limit_is_refused_before_approval(tmp_path):
    cmd, transport, svc = commander(tmp_path, browser=lambda p, a, s: None)
    cmd.handle_inbound(OWNER, "ARENA: " + "x" * 900)
    assert cmd.wait_idle(5)
    assert "longer than 800 characters" in transport.sent[-1]


def test_system_prompt_lists_routines_and_browser_when_enabled(tmp_path):
    cmd, transport, svc = commander(tmp_path, browser=lambda p, a, s: None)
    assert "home: Desk ready" in cmd._system
    assert '"action": "browser"' in cmd._system
    cmd2, _, _ = commander(tmp_path / "x", browser=None)
    assert '"action": "browser"' not in cmd2._system


# ----------------------------------------------------------------------- #
# service and CLI
# ----------------------------------------------------------------------- #
def test_service_loads_routines_file_and_reports_problems(tmp_path):
    from observer_core.config import AppConfig
    from observer_core.remote.service import WhatsAppService

    routines_file = tmp_path / "routines.toml"
    routines_file.write_text(GOOD_TOML, encoding="utf-8")
    cfg = AppConfig()
    cfg.whatsapp.enabled = True
    cfg.whatsapp.agent_number = "8859555795"
    cfg.whatsapp.allowed_number = "9528923866"
    statuses = []
    svc = WhatsAppService(cfg, provider=ScriptedModel([]), client_factory=lambda p: object(),
                          session=tmp_path / "s.sqlite3", timers=tmp_path / "t.json",
                          routines_file=routines_file, on_status=statuses.append)
    assert svc.describe()["routines"] == "1"
    assert svc.describe()["browser"] == "off"
    assert any("routines:" in s for s in statuses)


def test_cli_routines_and_browser_login_failure_paths(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from observer_core.cli import app
    from observer_core.remote.service import routines_path

    runner = CliRunner()
    assert runner.invoke(app, ["whatsapp", "routines"]).exit_code == 0
    routines_path().parent.mkdir(parents=True, exist_ok=True)
    routines_path().write_text(GOOD_TOML, encoding="utf-8")
    bad = runner.invoke(app, ["whatsapp", "routines"])
    assert bad.exit_code == 1 and "problem" in bad.output and "home" in bad.output
    import observer_core.remote.browser as browser

    monkeypatch.setattr(browser, "find_chromium", lambda: None)
    login = runner.invoke(app, ["whatsapp", "browser-login"])
    assert login.exit_code == 2 and "chromium" in login.output.lower()
