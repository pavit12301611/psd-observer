"""asyncio scheduler: one task per enabled agent.

* loop_interval_s per agent, ±jitter so agents do not hit the model together;
* each cycle runs under ``asyncio.wait_for(cycle_timeout_s)``;
* a global semaphore caps concurrent model calls (``max_concurrent_model_calls``);
* exceptions and timeouts are caught, logged, and retried with exponential
  back-off (capped at ``backoff_cap_s``); the loop never dies from one agent.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import AppConfig
from ..models import AgentDef
from .scheduler import backoff_delay, jittered_interval

AgentFactory = Callable[[AgentDef, asyncio.Semaphore], Any]


@dataclass
class AgentState:
    agent_id: str
    name: str
    state: str = "idle"          # idle | running | ok | degraded | error | stopped
    failures: int = 0
    cycles: int = 0
    last_run: float | None = None
    last_error: str | None = None
    next_run: float | None = None
    last_triggered: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


class Scheduler:
    def __init__(
        self,
        config: AppConfig,
        factory: AgentFactory,
        *,
        rng: Callable[[float, float], float] = random.uniform,
        on_status: Callable[[AgentState], None] | None = None,
    ) -> None:
        self.config = config
        self.factory = factory
        self.rng = rng
        self.on_status = on_status
        self.semaphore: asyncio.Semaphore | None = None
        self._tasks: dict[str, asyncio.Task] = {}
        self._runtimes: dict[str, Any] = {}
        self._states: dict[str, AgentState] = {}
        self._running = False

    # ------------------------------------------------------------------ #
    @property
    def running(self) -> bool:
        return self._running

    def states(self) -> list[AgentState]:
        return list(self._states.values())

    def state_of(self, agent_id: str) -> AgentState | None:
        return self._states.get(agent_id)

    def _emit(self, st: AgentState) -> None:
        if self.on_status:
            try:
                self.on_status(st)
            except Exception:
                pass

    # ------------------------------------------------------------------ #
    async def start(self, agents: list[AgentDef]) -> None:
        if self._running:
            return
        self._running = True
        self.semaphore = asyncio.Semaphore(max(1, int(self.config.runtime.max_concurrent_model_calls)))
        for agent in agents:
            if agent.enabled:
                self.add_agent(agent)

    def add_agent(self, agent: AgentDef) -> None:
        if not self._running:
            return
        if agent.id in self._tasks and not self._tasks[agent.id].done():
            return
        st = self._states.setdefault(agent.id, AgentState(agent_id=agent.id, name=agent.name))
        st.state = "idle"
        st.failures = 0
        runtime = self.factory(agent, self.semaphore)
        self._runtimes[agent.id] = runtime
        self._tasks[agent.id] = asyncio.create_task(self._agent_loop(agent, runtime, st), name=f"agent:{agent.id}")

    async def remove_agent(self, agent_id: str) -> None:
        task = self._tasks.pop(agent_id, None)
        self._runtimes.pop(agent_id, None)
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if agent_id in self._states:
            self._states[agent_id].state = "stopped"
            self._emit(self._states[agent_id])

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()
        self._runtimes.clear()
        for st in self._states.values():
            st.state = "stopped"
            st.next_run = None
            self._emit(st)

    async def run_once(self, agent_id: str) -> Any:
        """'Run cycle now' — bypasses the timer but respects the timeout and semaphore."""
        runtime = self._runtimes.get(agent_id)
        if runtime is None:
            raise KeyError(f"agent {agent_id} is not running")
        return await asyncio.wait_for(runtime.cycle(), timeout=self.config.runtime.cycle_timeout_s)

    # ------------------------------------------------------------------ #
    async def _agent_loop(self, agent: AgentDef, runtime: Any, st: AgentState) -> None:
        timeout = float(self.config.runtime.cycle_timeout_s)
        base = float(self.config.runtime.backoff_base_s)
        cap = float(self.config.runtime.backoff_cap_s)
        jitter = float(self.config.runtime.jitter_pct)
        try:
            while True:
                st.state = "running"
                st.last_run = time.time()
                self._emit(st)
                try:
                    result = await asyncio.wait_for(runtime.cycle(), timeout=timeout)
                    st.cycles += 1
                    st.last_triggered = bool(getattr(result, "triggered", False))
                    if getattr(result, "ok", True):
                        st.state = "ok"
                        st.failures = 0
                        st.last_error = None
                        delay = jittered_interval(agent.loop_interval_s, jitter, self.rng)
                    else:
                        # The sensor/model/cloud gate reported a soft failure: the agent is
                        # degraded, not crashed. Keep polling at the normal cadence.
                        st.state = "degraded"
                        st.last_error = getattr(result, "error", None)
                        delay = jittered_interval(agent.loop_interval_s, jitter, self.rng)
                except asyncio.TimeoutError:
                    st.failures += 1
                    st.last_error = f"cycle timed out after {timeout:.0f}s"
                    st.state = "error"
                    delay = backoff_delay(st.failures, base, cap)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - survive anything
                    st.failures += 1
                    st.last_error = f"{type(exc).__name__}: {exc}"[:300]
                    st.state = "error"
                    delay = backoff_delay(st.failures, base, cap)
                st.next_run = time.time() + delay
                self._emit(st)
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            st.state = "stopped"
            st.next_run = None
            self._emit(st)
            raise


__all__ = ["Scheduler", "AgentState"]
