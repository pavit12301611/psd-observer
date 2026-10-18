"""Application container: wires config, storage, sensors, tools and the scheduler.

Both the GUI and the headless daemon build an :class:`ObserverApp` so behaviour
is identical whether or not a window is open.
"""

from __future__ import annotations

import re
import time
import uuid
from pathlib import Path

from . import paths
from .config import AppConfig, load_or_create, set_active_config
from .llm.base import ProviderError
from .llm.factory import default_model_spec, make_provider
from .models import AgentDef, Diagnostic, ModelSpec, ToolKind
from .runtime.agent import AgentRuntime
from .runtime.loop import Scheduler
from .runtime.memory_store import MemoryStore
from .sensors.registry import SensorRegistry
from .storage.db import Database
from .storage.events import EventLog
from .storage.frames import FrameRingBuffer
from .tools.registry import ToolRegistry


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:48] or f"agent-{uuid.uuid4().hex[:8]}"


class AgentStore:
    """Agents persisted in SQLite (source of truth) and mirrored as YAML files."""

    def __init__(self, db: Database, directory: Path) -> None:
        self.db = db
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[AgentDef]:
        rows = self.db.query("SELECT definition FROM agents ORDER BY name COLLATE NOCASE")
        out = []
        for r in rows:
            try:
                out.append(AgentDef.model_validate_json(r["definition"]))
            except Exception:
                continue
        return out

    def get(self, agent_id: str) -> AgentDef | None:
        rows = self.db.query("SELECT definition FROM agents WHERE id=?", (agent_id,))
        return AgentDef.model_validate_json(rows[0]["definition"]) if rows else None

    def save(self, agent: AgentDef) -> AgentDef:
        agent.updated_at = time.time()
        self.db.execute(
            "INSERT INTO agents(id, name, definition, enabled, updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition, "
            "enabled=excluded.enabled, updated_at=excluded.updated_at",
            (agent.id, agent.name, agent.model_dump_json(), int(agent.enabled), agent.updated_at),
        )
        try:
            (self.dir / f"{agent.id}.yaml").write_text(agent.to_yaml(), encoding="utf-8")
        except OSError:
            pass
        return agent

    def delete(self, agent_id: str) -> bool:
        cur = self.db.execute("DELETE FROM agents WHERE id=?", (agent_id,))
        try:
            (self.dir / f"{agent_id}.yaml").unlink()
        except OSError:
            pass
        return cur.rowcount > 0

    def duplicate(self, agent_id: str) -> AgentDef | None:
        src = self.get(agent_id)
        if not src:
            return None
        data = src.model_dump()
        data["id"] = f"{slugify(src.name)}-{uuid.uuid4().hex[:6]}"
        data["name"] = f"{src.name} (copy)"
        data["enabled"] = False
        new = AgentDef.model_validate(data)
        return self.save(new)

    def import_file(self, path: Path) -> AgentDef:
        agent = AgentDef.from_file(path)
        if self.get(agent.id) is not None:
            agent.id = f"{agent.id}-{uuid.uuid4().hex[:4]}"
        return self.save(agent)

    def export_file(self, agent_id: str, dest: Path) -> Path:
        agent = self.get(agent_id)
        if agent is None:
            raise KeyError(agent_id)
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(agent.to_json() if dest.suffix.lower() == ".json" else agent.to_yaml(), encoding="utf-8")
        return dest


class ObserverApp:
    """The composition root. Cheap to construct; ``open()`` touches disk."""

    def __init__(self, config: AppConfig | None = None, *, db_path: Path | None = None) -> None:
        self.dirs = paths.ensure_dirs()
        self.config = config or load_or_create(create=False)
        set_active_config(self.config)
        self.db = Database(db_path or paths.db_file())
        self.events = EventLog(self.db, jsonl_path=paths.event_log_file())
        self.memory = MemoryStore(self.db)
        self.agents = AgentStore(self.db, paths.agents_dir())
        self.frames = FrameRingBuffer(
            self.db, paths.frames_dir(),
            max_files=self.config.privacy.max_frames,
            max_mb=self.config.privacy.max_frames_mb,
            enabled=self.config.privacy.persist_frames,
        )
        self.sensors = SensorRegistry(self.config)
        self.tools = ToolRegistry(self.config, memory=self.memory)
        self.scheduler: Scheduler | None = None
        self.monitoring = False

    # ------------------------------------------------------------------ #
    def seed_examples(self) -> int:
        """Import bundled example agents the first time (no-op afterwards)."""
        if self.agents.list():
            return 0
        n = 0
        ex_dir = paths.repo_root() / "examples" / "agents"
        if ex_dir.is_dir():
            for f in sorted(ex_dir.glob("*.yaml")):
                try:
                    a = AgentDef.from_file(f)
                    a.enabled = False
                    self.agents.save(a)
                    n += 1
                except Exception as exc:  # pragma: no cover
                    self.events.record(f"could not import example {f.name}: {exc}", level="WARN")
        return n

    def model_spec_for(self, agent: AgentDef) -> ModelSpec:
        return agent.model

    def provider_for(self, agent: AgentDef):
        return make_provider(agent.model, self.config)

    def build_runtime(self, agent: AgentDef, semaphore=None) -> AgentRuntime:
        provider = self.provider_for(agent)
        return AgentRuntime(
            agent=agent,
            sensors=self.sensors,
            provider=provider,
            tools=self.tools,
            memory=self.memory,
            logger=self.events,
            config=self.config,
            model_semaphore=semaphore,
            frame_writer=self.frames if self.frames.enabled else None,
        )

    # ------------------------------------------------------------------ #
    def start_monitoring(self, on_status=None) -> Scheduler:

        self.sensors.start_all()
        self.scheduler = Scheduler(self.config, self.build_runtime, on_status=on_status)
        self.monitoring = True
        return self.scheduler

    def stop_monitoring(self) -> None:
        self.monitoring = False
        self.sensors.stop_all()

    def close(self) -> None:
        try:
            self.stop_monitoring()
        finally:
            self.db.close()

    # ------------------------------------------------------------------ #
    def model_health(self, spec: ModelSpec | None = None) -> tuple[bool, str, float | None, list[str]]:
        spec = spec or default_model_spec(self.config)
        try:
            prov = make_provider(spec, self.config)
        except ProviderError as exc:
            return False, str(exc), None, []
        t0 = time.monotonic()
        ok, detail = prov.health()
        latency = (time.monotonic() - t0) * 1000
        models = prov.list_models() if ok else []
        return ok, detail, round(latency, 1), models

    def diagnostics(self) -> list[Diagnostic]:
        from .doctor import collect_diagnostics

        return collect_diagnostics(self)

    def test_notification(self, channel: str) -> dict:
        try:
            kind = ToolKind(channel)
        except ValueError:
            return {"ok": False, "detail": f"unknown channel {channel}"}
        res = self.tools.test_send(kind)
        self.events.record(f"test {channel}: {res.detail}", level="OK" if res.ok else "ERROR", kind="test")
        return {"ok": res.ok, "detail": res.detail}


def new_agent_id(name: str) -> str:
    return f"{slugify(name)}-{uuid.uuid4().hex[:6]}"


__all__ = ["ObserverApp", "AgentStore", "slugify", "new_agent_id"]
