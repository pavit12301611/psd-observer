"""AgentRuntime: one agent's cycle — sense, prompt, think, parse, act, remember.

``cycle()`` is async and never raises: every failure is captured in the returned
:class:`CycleResult` and logged to the event log.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from ..config import AppConfig
from ..llm.base import ModelProvider, ProviderError, sanitize_error
from ..models import (
    ActionResult,
    AgentDef,
    CycleResult,
    SensorKind,
    SensorPayload,
    ToolContext,
)
from ..sensors.registry import SensorRegistry
from ..tools.registry import ToolRegistry, resolve_tool_name
from .memory_store import MemoryStore
from .parse import parse_response
from .prompt import _TOKEN_RE, build_messages, render_prompt


def _has_token(text: str) -> bool:
    return bool(_TOKEN_RE.search(text or ""))


class _NullLog:
    def record(self, message: str, **kwargs: Any) -> dict:  # pragma: no cover - trivial
        return {}


class AgentRuntime:
    def __init__(
        self,
        agent: AgentDef,
        sensors: SensorRegistry,
        provider: ModelProvider,
        tools: ToolRegistry,
        memory: MemoryStore,
        logger: Any = None,
        *,
        config: AppConfig | None = None,
        model_semaphore: asyncio.Semaphore | None = None,
        frame_writer: Any = None,
        dry_run: bool = False,
    ) -> None:
        self.agent = agent
        self.sensors = sensors
        self.provider = provider
        self.tools = tools
        self.memory = memory
        self.log = logger or _NullLog()
        self.config = config or getattr(tools, "config", None) or AppConfig()
        self.semaphore = model_semaphore
        self.frame_writer = frame_writer
        self.dry_run = dry_run
        self.cycle_index = 0
        self.last_result: CycleResult | None = None

        self._allowed_tools = tools.for_agent(agent.tools)
        self.sensors.configure(agent.sensors)

    # ------------------------------------------------------------------ #
    def _event(self, message: str, level: str = "INFO", kind: str = "cycle", payload: dict | None = None) -> None:
        try:
            self.log.record(message, level=level, agent_id=self.agent.id, kind=kind, payload=payload or {})
        except Exception:  # logging must never break a cycle
            pass

    def _gather(self) -> dict[SensorKind, SensorPayload | None]:
        out: dict[SensorKind, SensorPayload | None] = {}
        for kind in self.agent.enabled_sensor_kinds():
            out[kind] = self.sensors.capture(kind)
        return out

    def _memories_for(self) -> list:
        try:
            return self.memory.recall(self.agent.id, f"{self.agent.name} {self.agent.description}",
                                      top_k=self.config.runtime.memory_top_k)
        except Exception as exc:
            self._event(f"memory recall failed: {sanitize_error(exc)}", "WARN")
            return []

    # ------------------------------------------------------------------ #
    async def cycle(self) -> CycleResult:
        self.cycle_index += 1
        result = CycleResult(agent_id=self.agent.id, cycle_index=self.cycle_index)
        try:
            await self._cycle_inner(result)
        except asyncio.CancelledError:
            result.ok = False
            result.error = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001 - the loop must survive
            result.ok = False
            result.error = sanitize_error(exc)
            self._event(f"cycle crashed: {result.error}", "ERROR", kind="error")
        finally:
            result.finished_at = time.time()
            self.last_result = result
        return result

    async def _cycle_inner(self, result: CycleResult) -> None:
        # 0. privacy gate: refuse cloud models unless explicitly allowed
        if self.provider.is_cloud and not self.config.privacy.allow_cloud_models:
            result.ok = False
            result.error = "cloud model blocked: privacy.allow_cloud_models is false"
            self._event(result.error, "WARN", kind="blocked")
            return

        # 1. sense
        payloads = await asyncio.to_thread(self._gather)
        result.sensor_summary = {k.token: (p.summary() if p else "none") for k, p in payloads.items()}
        result.degraded_sensors = [k.value for k, p in payloads.items() if p is None or p.degraded or p.error]
        for kind, payload in payloads.items():
            if payload is not None and payload.is_image and self.frame_writer is not None:
                try:
                    self.frame_writer.write(self.agent.id, kind.value, bytes(payload.data))  # type: ignore[arg-type]
                except Exception as exc:
                    result.warnings.append(f"frame not persisted: {sanitize_error(exc)}")

        all_sensors_failed = bool(payloads) and all(
            p is None or (p.degraded and not p.is_image and not p.text) for p in payloads.values()
        )
        if all_sensors_failed:
            result.ok = False
            result.error = "all sensors degraded this cycle; model not called"
            self._event(result.error, "WARN", kind="degraded", payload={"sensors": result.degraded_sensors})
            return

        # 2. render
        supports_vision = bool(self.agent.model.supports_vision)
        rendered = render_prompt(
            self._observation_template(),
            payloads,
            agent_name=self.agent.name,
            cycle_index=self.cycle_index,
            memories=self._memories_for(),
            supports_vision=supports_vision,
            enabled_kinds=self.agent.enabled_sensor_kinds(),
        )
        result.warnings.extend(rendered.warnings)
        for w in rendered.warnings:
            self._event(f"prompt: {w}", "WARN", kind="prompt")
        result.prompt_text = rendered.user_text

        tool_names = sorted(self._allowed_tools.keys())
        messages = build_messages(self.agent.system_prompt, tool_names, rendered)

        # 3. think (bounded concurrency across agents)
        raw = await self._chat(messages, result)
        if raw is None:
            return
        result.raw_response = raw

        # 4. parse
        plan = parse_response(raw, self.agent.trigger_phrase)
        if plan.parse_mode in ("loose", "phrase", "none"):
            self._event(f"model response parsed as {plan.parse_mode}", "WARN", kind="parse",
                        payload={"raw": raw[:300]})
        result.plan = plan
        result.warnings.extend(plan.warnings)
        result.triggered = plan.triggered

        # 5. act
        if plan.triggered or plan.actions:
            if plan.triggered:
                self._event(f"TRIGGERED: {plan.reason or '(no reason given)'}", "OK", kind="trigger")
            await self._act(plan, rendered, payloads, result)

        # 6. persist memory writes
        for mw in plan.memory[:20]:
            try:
                self.memory.store(self.agent.id, mw.key, mw.value, mw.importance)
                self._event(f"memory stored: {mw.key}", "INFO", kind="memory")
            except Exception as exc:
                result.warnings.append(f"memory write failed for {mw.key!r}: {sanitize_error(exc)}")

        if not plan.triggered and not plan.actions and not plan.memory:
            self._event("no trigger", "DEBUG", kind="cycle")

    def _observation_template(self) -> str:
        """Text of the user message. Explicit tokens win; otherwise every enabled sensor is listed."""
        from ..models import SENSOR_TOKENS

        if _has_token(self.agent.system_prompt):
            return self.agent.system_prompt
        tokens = [SENSOR_TOKENS[k] for k in self.agent.enabled_sensor_kinds()]
        return "Observations:\n" + "\n".join(tokens) if tokens else "Observations: (no sensors enabled)"

    async def _chat(self, messages, result: CycleResult) -> str | None:
        if self.dry_run:
            result.warnings.append("dry run: model not called")
            return '{"triggered": false, "reason": "dry run"}'

        async def call() -> str:
            start = time.monotonic()
            try:
                text = await asyncio.to_thread(self.provider.chat, messages, None)
            finally:
                result.model_latency_ms = int((time.monotonic() - start) * 1000)
            return text

        try:
            if self.semaphore is not None:
                async with self.semaphore:
                    return await call()
            return await call()
        except ProviderError as exc:
            result.ok = False
            result.error = f"model error: {sanitize_error(exc)}"
            self._event(result.error, "ERROR", kind="model")
            return None
        except Exception as exc:  # pragma: no cover - providers should raise ProviderError
            result.ok = False
            result.error = f"model error: {sanitize_error(exc)}"
            self._event(result.error, "ERROR", kind="model")
            return None

    async def _act(self, plan, rendered, payloads, result: CycleResult) -> None:
        limit = max(0, int(self.agent.max_actions_per_cycle))
        if len(plan.actions) > limit:
            result.warnings.append(f"model proposed {len(plan.actions)} actions; limit is {limit}")
        ctx = ToolContext(
            agent_id=self.agent.id,
            agent_name=self.agent.name,
            cycle_index=self.cycle_index,
            prompt_excerpt=rendered.user_text[:500],
            sensor_summary=result.sensor_summary,
            dry_run=self.dry_run,
        )
        for action in plan.actions[:limit]:
            kind = resolve_tool_name(action.tool)
            if kind is None:
                msg = f"unknown tool {action.tool!r} ignored"
                result.results.append(ActionResult(tool=action.tool, ok=False, skipped=True, skipped_reason=msg))
                self._event(msg, "WARN", kind="tool")
                continue
            tool_res, name = await asyncio.to_thread(self.tools.dispatch, action.tool, dict(action.args), ctx, self._allowed_tools)
            level = "OK" if tool_res.ok else "ERROR"
            self._event(f"tool {name}: {tool_res.detail}", level, kind="tool", payload={"ok": tool_res.ok})
            result.results.append(ActionResult(tool=name, ok=tool_res.ok, detail=tool_res.detail))


__all__ = ["AgentRuntime"]
