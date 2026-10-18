"""AgentRuntime cycles with fakes: triggers, actions, limits, privacy gate, failure isolation."""

import asyncio


from observer_core.config import AppConfig
from observer_core.llm.base import ProviderError
from observer_core.models import AgentDef, ModelSpec, SensorKind, SensorSpec, ToolKind, ToolSpec
from observer_core.runtime.agent import AgentRuntime
from observer_core.sensors.registry import SensorRegistry
from observer_core.tools.registry import ToolRegistry

from .fakes import FakeSensor, ScriptedModel


def make_agent(**kw):
    base = dict(
        id="a1", name="Test agent", description="watch things", system_prompt="Watch $SCREEN and reply JSON.",
        sensors=[SensorSpec(kind=SensorKind.SCREEN)],
        tools=[ToolSpec(kind=ToolKind.MEMORY), ToolSpec(kind=ToolKind.TELEGRAM)],
        model=ModelSpec(provider="ollama", model="fake", supports_vision=True),
        max_actions_per_cycle=3,
    )
    base.update(kw)
    return AgentDef(**base)


def build(agent, model, *, cfg=None, sensor_text=None, fail_sensor=None):
    cfg = cfg or AppConfig()
    cfg.runtime.memory_top_k = 3
    from observer_core.runtime.memory_store import MemoryStore
    from observer_core.storage.db import Database
    from observer_core.storage.events import EventLog
    import tempfile, pathlib

    tmp = pathlib.Path(tempfile.mkdtemp())
    db = Database(tmp / "t.db")
    mem = MemoryStore(db)
    events = EventLog(db)
    sensors = SensorRegistry(cfg)
    sensors.configure(agent.sensors)
    for spec in agent.sensors:
        sensors._sensors[spec.kind] = FakeSensor(spec.kind, config=cfg, fail_with=fail_sensor,
                                                 text=sensor_text or "ocr text here")
    tools = ToolRegistry(cfg, memory=mem)
    rt = AgentRuntime(agent, sensors, model, tools, mem, events, config=cfg)
    return rt, mem, events, db


def run(coro):
    return asyncio.run(coro)


def test_triggered_cycle_stores_memory_and_logs(tmp_path):
    model = ScriptedModel([
        '{"triggered": true, "reason": "seen it", "actions": [{"tool": "memory", "args": {"action": "store", "key": "k1", "value": "v1"}}],'
        ' "memory": [{"key": "last", "value": "x"}]}'
    ])
    rt, mem, events, db = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok and res.triggered
    assert res.plan.parse_mode == "json"
    assert mem.get("a1", "k1").value == "v1"          # action-driven write
    assert mem.get("a1", "last").value == "x"         # plan-level memory write
    assert any(r["kind"] == "trigger" for r in events.recent())
    assert res.results and res.results[0].ok
    # the model saw the screen as an image part
    assert len(model.calls[0][1].images) == 1


def test_untriggered_cycle_no_actions():
    model = ScriptedModel(['{"triggered": false}'])
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok and not res.triggered and res.results == []


def test_unknown_tool_is_ignored_not_crash():
    model = ScriptedModel(['{"triggered": true, "actions": [{"tool": "carrier_pigeon", "args": {}}]}'])
    rt, _, events, _ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok
    assert res.results[0].skipped and "unknown tool" in res.results[0].skipped_reason


def test_tool_not_enabled_for_agent_is_refused():
    model = ScriptedModel(['{"triggered": true, "actions": [{"tool": "discord", "args": {"text": "x"}}]}'])
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.results[0].ok is False and "not enabled" in res.results[0].detail


def test_missing_credentials_reported_clearly():
    model = ScriptedModel(['{"triggered": true, "actions": [{"tool": "telegram", "args": {"text": "hi"}}]}'])
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.results[0].ok is False
    assert "telegram.bot_token" in res.results[0].detail


def test_max_actions_per_cycle_enforced():
    actions = ",".join('{"tool": "memory", "args": {"action": "store", "key": "k%d", "value": "v"}}' % i for i in range(6))
    model = ScriptedModel([f'{{"triggered": true, "actions": [{actions}]}}'])
    rt, mem, *_ = build(make_agent(max_actions_per_cycle=2), model)
    res = run(rt.cycle())
    assert len(res.results) == 2
    assert any("limit is 2" in w for w in res.warnings)


def test_cloud_model_blocked_without_privacy_opt_in():
    model = ScriptedModel(['{"triggered": true}'], is_cloud=True)
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok is False and "cloud model blocked" in res.error
    assert model.calls == []                       # never reached the provider


def test_cloud_model_allowed_with_opt_in():
    cfg = AppConfig()
    cfg.privacy.allow_cloud_models = True
    model = ScriptedModel(['{"triggered": false}'], is_cloud=True)
    rt, *_ = build(make_agent(), model, cfg=cfg)
    res = run(rt.cycle())
    assert res.ok and len(model.calls) == 1


def test_provider_error_is_contained():
    model = ScriptedModel([ProviderError("ollama not reachable at http://127.0.0.1:11434")])
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok is False and "model error" in res.error and "not reachable" in res.error


def test_unexpected_exception_is_contained():
    model = ScriptedModel([RuntimeError("boom")])
    rt, *_ = build(make_agent(), model)
    res = run(rt.cycle())
    assert res.ok is False and "boom" in res.error


def test_all_sensors_degraded_skips_model():
    model = ScriptedModel(['{"triggered": true}'])
    rt, *_ = build(make_agent(), model, fail_sensor="permission denied")
    res = run(rt.cycle())
    assert res.ok is False and "model not called" in res.error
    assert model.calls == []
    assert "screen" in res.degraded_sensors


def test_text_agent_without_vision_gets_text_only():
    agent = make_agent(sensors=[SensorSpec(kind=SensorKind.SCREEN_OCR)],
                       system_prompt="Read $SCREEN_OCR.",
                       model=ModelSpec(provider="ollama", model="fake", supports_vision=False))
    model = ScriptedModel(['{"triggered": false}'])
    rt, *_ = build(agent, model, sensor_text="BATTERY 9%")
    res = run(rt.cycle())
    assert res.ok
    user = model.calls[0][1]
    assert "BATTERY 9%" in user.content and user.images == []


def test_dry_run_never_calls_model_or_tools():
    model = ScriptedModel(['{"triggered": true, "actions": [{"tool": "memory", "args": {"action":"store","key":"z","value":"1"}}]}'])
    rt, mem, *_ = build(make_agent(), model)
    rt.dry_run = True
    run(rt.cycle())
    assert model.calls == []
    assert mem.get("a1", "z") is None


def test_cycle_index_increments():
    model = ScriptedModel(['{"triggered": false}'])
    rt, *_ = build(make_agent(), model)
    run(rt.cycle()); r2 = run(rt.cycle())
    assert r2.cycle_index == 2
    assert "Cycle: #2" in model.calls[1][1].content


def test_trigger_phrase_used_for_prose_response():
    model = ScriptedModel(["The job is DONE."])
    rt, *_ = build(make_agent(trigger_phrase="done"), model)
    res = run(rt.cycle())
    assert res.triggered and res.plan.parse_mode == "phrase"


def test_semaphore_bounds_concurrent_model_calls():
    import time as _t

    active = {"n": 0, "max": 0}

    class Slow(ScriptedModel):
        def chat(self, messages, tools=None):
            active["n"] += 1
            active["max"] = max(active["max"], active["n"])
            _t.sleep(0.05)
            active["n"] -= 1
            return '{"triggered": false}'

    async def go():
        sem = asyncio.Semaphore(1)
        rts = [build(make_agent(id=f"a{i}"), Slow([]))[0] for i in range(3)]
        for rt in rts:
            rt.semaphore = sem
        await asyncio.gather(*(rt.cycle() for rt in rts))

    run(go())
    assert active["max"] == 1
