"""Thread bridge between the Qt GUI thread and the asyncio engine.

The scheduler and the cycles run on a private asyncio loop in a background
thread. They talk to the GUI exclusively through :class:`Bridge` signals, which
Qt delivers queued to the main thread. Widgets are never touched off-thread.
"""

from __future__ import annotations

import asyncio
import dataclasses
import threading

from PyQt6.QtCore import QObject, pyqtSignal

from ..app import ObserverApp
from ..models import AgentDef, CycleResult


class Bridge(QObject):
    event = pyqtSignal(object)          # event-log row dict
    status = pyqtSignal(object)         # AgentState copy
    cycle_done = pyqtSignal(object)     # CycleResult
    preview = pyqtSignal(object, object)  # SensorKind, SensorPayload
    diagnostics = pyqtSignal(object)    # list[Diagnostic]
    health = pyqtSignal(object)         # dict(ok, detail, latency, models)
    message = pyqtSignal(str, str)      # level, text for the status bar


class Engine:
    """Owns the asyncio loop thread and the scheduler."""

    def __init__(self, app: ObserverApp, bridge: Bridge) -> None:
        self.app = app
        self.bridge = bridge
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="observer-engine", daemon=True)
        self._thread.start()
        self.scheduler = None
        app.events.subscribe(lambda row: bridge.event.emit(row))

    # ------------------------------------------------------------------ #
    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _submit(self, coro, timeout: float | None = 30.0):
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout) if timeout else fut

    def _on_status(self, st) -> None:
        self.bridge.status.emit(dataclasses.replace(st))

    # ------------------------------------------------------------------ #
    @property
    def monitoring(self) -> bool:
        return bool(self.scheduler and self.scheduler.running)

    def start_monitoring(self, agents: list[AgentDef]) -> None:
        async def go():
            self.scheduler = self.app.start_monitoring(on_status=self._on_status)
            await self.scheduler.start(agents)

        self._submit(go())
        self.bridge.message.emit("OK", f"monitoring started ({len(agents)} agent(s))")

    def stop_monitoring(self) -> None:
        async def go():
            if self.scheduler is not None:
                await self.scheduler.stop()
            self.app.stop_monitoring()

        self._submit(go(), timeout=20)
        self.bridge.message.emit("INFO", "monitoring stopped")

    def refresh_agent(self, agent: AgentDef) -> None:
        """Apply an edited agent to a running scheduler (restart its loop)."""
        if not self.monitoring:
            return

        async def go():
            await self.scheduler.remove_agent(agent.id)
            if agent.enabled:
                self.scheduler.add_agent(agent)

        self._submit(go(), timeout=10)

    def run_cycle(self, agent: AgentDef, dry_run: bool = False) -> None:
        """'Run cycle now' — works whether or not monitoring is on. Result comes back via signal."""
        try:
            runtime = self.app.build_runtime(agent)
        except Exception as exc:  # e.g. invalid provider
            self.bridge.cycle_done.emit(CycleResult(agent_id=agent.id, ok=False, error=str(exc)))
            return
        runtime.dry_run = dry_run
        timeout = float(self.app.config.runtime.cycle_timeout_s)

        async def go():
            return await asyncio.wait_for(runtime.cycle(), timeout=timeout)

        fut = asyncio.run_coroutine_threadsafe(go(), self.loop)

        def done(f):
            try:
                res = f.result()
            except Exception as exc:  # timeout or cancelled
                res = CycleResult(agent_id=agent.id, ok=False, error=f"{type(exc).__name__}: {exc}")
            self.bridge.cycle_done.emit(res)

        fut.add_done_callback(done)

    def probe_model(self, spec) -> None:
        """Health + model list, off the GUI thread."""

        def work():
            ok, detail, latency, models = self.app.model_health(spec)
            self.bridge.health.emit({"ok": ok, "detail": detail, "latency_ms": latency, "models": models})

        threading.Thread(target=work, daemon=True).start()

    def shutdown(self) -> None:
        try:
            if self.monitoring:
                self.stop_monitoring()
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)


__all__ = ["Bridge", "Engine"]
