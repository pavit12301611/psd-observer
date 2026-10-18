"""Scheduler policy: jitter bounds, exponential back-off cap, timeouts, survival, cancellation."""

import asyncio
import dataclasses

import pytest

from observer_core.config import AppConfig
from observer_core.models import AgentDef, CycleResult
from observer_core.runtime.loop import Scheduler
from observer_core.runtime.scheduler import backoff_delay, jittered_interval


def test_jitter_stays_within_bounds():
    vals = [jittered_interval(30, 10, rng=lambda lo, hi: lo) for _ in range(1)]
    assert vals == [27.0]
    assert jittered_interval(30, 10, rng=lambda lo, hi: hi) == pytest.approx(33.0)


def test_jitter_has_floor():
    assert jittered_interval(0.1, 0, rng=lambda lo, hi: lo) == 0.5


def test_backoff_exponential_and_capped():
    assert backoff_delay(0) == 0
    assert backoff_delay(1, base_s=5, cap_s=300) == 5
    assert backoff_delay(2, base_s=5, cap_s=300) == 10
    assert backoff_delay(3, base_s=5, cap_s=300) == 20
    assert backoff_delay(20, base_s=5, cap_s=300) == 300


class _Runtime:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.count = 0

    async def cycle(self):
        self.count += 1
        return await self.behaviour(self.count)


def _agent(i, interval=0.5):
    return AgentDef(id=f"s{i}", name=f"S{i}", system_prompt="x", loop_interval_s=interval)


def _config(timeout=0.2, base=0.01, cap=0.05, concurrent=2):
    cfg = AppConfig()
    cfg.runtime.cycle_timeout_s = timeout
    cfg.runtime.backoff_base_s = base
    cfg.runtime.backoff_cap_s = cap
    cfg.runtime.max_concurrent_model_calls = concurrent
    cfg.runtime.jitter_pct = 0
    return cfg


def test_loop_survives_exceptions_and_backs_off():
    async def behave(n):
        raise RuntimeError(f"boom {n}")

    async def go():
        rt = _Runtime(behave)
        sched = Scheduler(_config(), lambda agent, sem: rt, rng=lambda lo, hi: lo)
        await sched.start([_agent(1)])
        await asyncio.sleep(0.35)
        st = sched.state_of("s1")
        await sched.stop()
        return st, rt.count

    st, count = asyncio.run(go())
    assert st.failures >= 2 and st.state in ("error", "stopped")
    assert "boom" in (st.last_error or "")
    assert count >= 2  # it kept going after the first failure


def test_cycle_timeout_is_an_error_not_a_hang():
    async def behave(n):
        await asyncio.sleep(5)
        return CycleResult(agent_id="s1")

    async def go():
        sched = Scheduler(_config(timeout=0.05), lambda agent, sem: _Runtime(behave), rng=lambda lo, hi: lo)
        await sched.start([_agent(1)])
        await asyncio.sleep(0.2)
        st = sched.state_of("s1")
        await sched.stop()
        return st

    st = asyncio.run(go())
    assert "timed out" in (st.last_error or "")
    assert st.failures >= 1


def test_soft_failure_marks_degraded_not_error():
    async def behave(n):
        return CycleResult(agent_id="s1", ok=False, error="model error: not reachable")

    async def go():
        sched = Scheduler(_config(), lambda agent, sem: _Runtime(behave), rng=lambda lo, hi: lo)
        await sched.start([_agent(1)])
        await asyncio.sleep(0.05)
        st = sched.state_of("s1")
        await sched.stop()
        return st

    st = asyncio.run(go())
    assert st.state in ("degraded", "stopped")
    assert st.failures == 0 and "not reachable" in st.last_error


def test_one_bad_agent_does_not_stop_the_others():
    async def bad(n):
        raise RuntimeError("bad")

    async def good(n):
        return CycleResult(agent_id="g", ok=True)

    async def go():
        runtimes = {"b": _Runtime(bad), "g": _Runtime(good)}
        sched = Scheduler(_config(), lambda agent, sem: runtimes[agent.id], rng=lambda lo, hi: lo)
        await sched.start([_agent(0).model_copy(update={"id": "b"}), _agent(0).model_copy(update={"id": "g"})])
        await asyncio.sleep(0.15)
        g = dataclasses.replace(sched.state_of("g"))   # snapshot before stop() flips states
        b = dataclasses.replace(sched.state_of("b"))
        await sched.stop()
        return g, b

    g, b = asyncio.run(go())
    # loop_interval_s has a 1 s floor, so only the first cycle runs inside this window
    assert g.cycles >= 1 and g.state == "ok"
    assert b.failures >= 1


def test_stop_cancels_tasks_and_marks_stopped():
    async def behave(n):
        return CycleResult(agent_id="s1", ok=True)

    async def go():
        sched = Scheduler(_config(), lambda agent, sem: _Runtime(behave), rng=lambda lo, hi: lo)
        await sched.start([_agent(1, interval=60)])
        await asyncio.sleep(0.02)
        await sched.stop()
        return sched

    sched = asyncio.run(go())
    assert not sched.running
    assert sched.state_of("s1").state == "stopped"


def test_disabled_agents_not_scheduled():
    async def behave(n):
        return CycleResult(agent_id="s1")

    async def go():
        sched = Scheduler(_config(), lambda agent, sem: _Runtime(behave))
        a = _agent(1).model_copy(update={"enabled": False})
        await sched.start([a])
        await asyncio.sleep(0.02)
        await sched.stop()
        return sched.state_of("s1")

    assert asyncio.run(go()) is None
