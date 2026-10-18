"""Core pydantic v2 data model for Observer Core.

Everything persisted, transported between layers or shown in the GUI is one of
the models defined here. Concrete layers (sensors / llm / tools) re-export the
payload types from their own ``base`` modules so the interfaces read naturally.
"""

from __future__ import annotations

import json
import os
import time
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# --------------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------------- #
class SensorKind(str, Enum):
    """The seven senses an agent can be wired to."""

    SCREEN = "screen"                # $SCREEN        - PNG frame (multimodal)
    SCREEN_OCR = "screen_ocr"        # $SCREEN_OCR    - text via tesseract
    CAMERA = "camera"                # $CAMERA        - JPEG frame
    CLIPBOARD = "clipboard"          # $CLIPBOARD     - text
    MICROPHONE = "microphone"        # $MICROPHONE    - transcript (optional Whisper)
    SCREEN_AUDIO = "screen_audio"    # $SCREEN_AUDIO  - transcript of system/tab audio
    ALL_AUDIO = "all_audio"          # $ALL_AUDIO     - mic + system audio transcript

    @property
    def token(self) -> str:
        return f"${self.value.upper()}"

    @property
    def is_image(self) -> bool:
        return self in (SensorKind.SCREEN, SensorKind.CAMERA)

    @property
    def label(self) -> str:
        return self.value.replace("_", " ").title()


#: Maps each sensor kind to the ``$TOKEN`` substituted into prompts.
SENSOR_TOKENS: dict[SensorKind, str] = {k: k.token for k in SensorKind}


class ToolKind(str, Enum):
    TELEGRAM = "telegram"
    DISCORD = "discord"
    WHATSAPP = "whatsapp"
    SMS = "sms"
    PHONE_CALL = "phone_call"
    EMAIL = "email"
    PUSHOVER = "pushover"
    DESKTOP_NOTIFY = "desktop_notify"
    MEMORY = "memory"
    RECORD_CLIP = "record_clip"
    HTTP_WEBHOOK = "http_webhook"
    RUN_PYTHON = "run_python"

    @property
    def label(self) -> str:
        return self.value.replace("_", " ").title()

    @property
    def is_cloud(self) -> bool:
        """Tools that necessarily send data off-machine."""
        return self in (
            ToolKind.TELEGRAM,
            ToolKind.DISCORD,
            ToolKind.WHATSAPP,
            ToolKind.SMS,
            ToolKind.PHONE_CALL,
            ToolKind.EMAIL,
            ToolKind.PUSHOVER,
            ToolKind.HTTP_WEBHOOK,
        )


# --------------------------------------------------------------------------- #
# Specs (persisted in agent definitions / global config)
# --------------------------------------------------------------------------- #
class ModelSpec(BaseModel):
    """Which LLM answers for this agent."""

    model_config = ConfigDict(extra="ignore")

    provider: Literal["ollama", "openai_compat", "llamacpp_local", "cloud"] = "ollama"
    endpoint: str | None = None
    model: str = "llama3.2"
    api_key_env: str | None = None       # read the secret from env, never store inline
    temperature: float = 0.1
    max_tokens: int = 512
    context_window: int = 8192
    supports_vision: bool = False
    timeout_s: float = 60.0
    extra: dict[str, Any] = Field(default_factory=dict)

    @field_validator("temperature")
    @classmethod
    def _clamp_temp(cls, v: float) -> float:
        return max(0.0, min(2.0, float(v)))

    def masked_dict(self) -> dict[str, Any]:
        """A copy safe to log/persist in diagnostics (no secret material)."""
        d = self.model_dump()
        if d.get("api_key_env"):
            d["api_key_env"] = f"<env:{d['api_key_env']}>"
        return d


class SensorSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: SensorKind
    enabled: bool = True
    interval_override_s: float | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class ToolSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: ToolKind
    enabled: bool = True
    options: dict[str, Any] = Field(default_factory=dict)
    #: Only honoured for ``RUN_PYTHON``; everything else ignores it.
    allow_python: bool = False


# --------------------------------------------------------------------------- #
# Agent definition
# --------------------------------------------------------------------------- #
class AgentDef(BaseModel):
    """A complete, serialisable agent (YAML/JSON importable + exportable)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: str = ""
    enabled: bool = True
    system_prompt: str = ""
    sensors: list[SensorSpec] = Field(default_factory=list)
    tools: list[ToolSpec] = Field(default_factory=list)
    model: ModelSpec = Field(default_factory=ModelSpec)
    loop_interval_s: float = 15.0
    max_actions_per_cycle: int = 3
    trigger_phrase: str | None = None    # if the model output contains this, fire
    stop_on_match: bool = False
    tags: list[str] = Field(default_factory=list)
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    @field_validator("id")
    @classmethod
    def _clean_id(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("agent id must not be empty")
        return v

    @field_validator("loop_interval_s")
    @classmethod
    def _min_interval(cls, v: float) -> float:
        return max(1.0, float(v))

    def sensor_specs(self, kind: SensorKind | None = None, enabled_only: bool = True) -> list[SensorSpec]:
        out = []
        for s in self.sensors:
            if enabled_only and not s.enabled:
                continue
            if kind is not None and s.kind != kind:
                continue
            out.append(s)
        return out

    def enabled_sensor_kinds(self) -> list[SensorKind]:
        seen: list[SensorKind] = []
        for s in self.sensors:
            if s.enabled and s.kind not in seen:
                seen.append(s.kind)
        return seen

    def enabled_tools(self) -> list[ToolSpec]:
        return [t for t in self.tools if t.enabled]

    def to_yaml(self) -> str:
        import yaml

        payload = self.model_dump(exclude={"created_at", "updated_at"})
        # enums -> plain strings so files are hand-editable
        payload = json.loads(json.dumps(payload, default=str))
        return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True)

    def to_json(self, indent: int = 2) -> str:
        payload = self.model_dump(exclude={"created_at", "updated_at"})
        return json.dumps(json.loads(json.dumps(payload, default=str)), indent=indent, ensure_ascii=False)

    @classmethod
    def from_yaml(cls, text: str) -> "AgentDef":
        import yaml

        data = yaml.safe_load(text)
        if not isinstance(data, dict):
            raise ValueError("agent YAML must be a mapping at the top level")
        return cls.model_validate(cls._expand_placeholders(data))

    @classmethod
    def from_json(cls, text: str) -> "AgentDef":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("agent JSON must be an object at the top level")
        return cls.model_validate(cls._expand_placeholders(data))

    @classmethod
    def from_file(cls, path: "str | os.PathLike[str]") -> "AgentDef":
        from pathlib import Path

        text = Path(path).read_text(encoding="utf-8")
        if Path(path).suffix.lower() in (".json",):
            return cls.from_json(text)
        try:
            return cls.from_yaml(text)
        except Exception:  # YAML is a superset; fall back to JSON
            return cls.from_json(text)

    @staticmethod
    def _expand_placeholders(data: Any) -> Any:
        """Resolve ``${config.path}`` / ``${env:NAME}`` references inside a raw dict.

        Global config values are looked up lazily through ``config.get_active()``
        so importing an agent file never requires a live config object.
        """
        import os
        import re

        pattern = re.compile(r"^\$\{(?P<ref>[^}]+)\}$")

        def resolve(value: str) -> Any:
            m = pattern.match(value.strip())
            if not m:
                return value
            ref = m.group("ref").strip()
            if ref.startswith("env:"):
                return os.environ.get(ref[4:], "")
            try:
                from .config import get_active_config

                cfg = get_active_config()
                if cfg is not None:
                    return cfg.resolve_ref(ref)
            except Exception:
                pass
            return value

        def walk(node: Any) -> Any:
            if isinstance(node, dict):
                return {k: walk(v) for k, v in node.items()}
            if isinstance(node, list):
                return [walk(v) for v in node]
            if isinstance(node, str):
                return resolve(node)
            return node

        return walk(data)


# --------------------------------------------------------------------------- #
# Runtime payload types
# --------------------------------------------------------------------------- #
class SensorPayload(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    kind: SensorKind
    data: bytes | str | None = None      # image bytes, or text
    mime: str | None = None              # "image/png", "image/jpeg", "text/plain"
    meta: dict[str, Any] = Field(default_factory=dict)   # width/height/fps/device/duration_ms/transcript
    captured_at: float = Field(default_factory=time.time)
    degraded: bool = False
    error: str | None = None

    @property
    def text(self) -> str | None:
        if isinstance(self.data, str):
            return self.data
        if isinstance(self.data, (bytes, bytearray)):
            try:
                return self.data.decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover - defensive
                return None
        return None

    @property
    def is_image(self) -> bool:
        return self.kind.is_image and isinstance(self.data, (bytes, bytearray)) and bool(self.data)

    def summary(self) -> str:
        if self.error:
            return f"error: {self.error}"
        if self.is_image:
            w = self.meta.get("width")
            h = self.meta.get("height")
            return f"image {w}x{h}" if w and h else "image"
        text = self.text or ""
        return text if len(text) <= 60 else text[:57] + "..."


class ChatMessage(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    role: Literal["system", "user", "assistant"]
    content: str
    images: list[bytes] = Field(default_factory=list)   # PNG/JPEG for multimodal models

    def image_count(self) -> int:
        return len(self.images)


class ToolResult(BaseModel):
    ok: bool
    detail: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def success(cls, detail: str = "", **payload: Any) -> "ToolResult":
        return cls(ok=True, detail=detail, payload=payload)

    @classmethod
    def failure(cls, detail: str, **payload: Any) -> "ToolResult":
        return cls(ok=False, detail=detail, payload=payload)


class ToolContext(BaseModel):
    """Handed to every tool invocation."""

    model_config = ConfigDict(extra="ignore")

    agent_id: str = ""
    agent_name: str = ""
    cycle_index: int = 0
    triggered_at: float = Field(default_factory=time.time)
    #: Rendered prompt text (for debugging / event rows). Never contains secrets.
    prompt_excerpt: str = ""
    #: Most recent sensor summaries, e.g. {"$SCREEN": "image 1280x720"}.
    sensor_summary: dict[str, str] = Field(default_factory=dict)
    #: Frames captured this cycle, as temp paths a clip recorder may reuse.
    frame_paths: list[str] = Field(default_factory=list)
    #: When True the tool must not touch the network (offline/dry-run mode).
    dry_run: bool = False


class PlannedAction(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)


class MemoryWrite(BaseModel):
    key: str
    value: str
    importance: float = 0.5


class ActionPlan(BaseModel):
    """Parsed model response."""

    triggered: bool = False
    reason: str = ""
    actions: list[PlannedAction] = Field(default_factory=list)
    memory: list[MemoryWrite] = Field(default_factory=list)
    confidence: float | None = None
    #: How the plan was extracted: "json", "fenced", "loose", "phrase", "none".
    parse_mode: str = "none"
    raw: str = ""
    warnings: list[str] = Field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.triggered and not self.actions and not self.memory


class ActionResult(BaseModel):
    tool: str
    ok: bool
    detail: str = ""
    skipped: bool = False
    skipped_reason: str = ""


class CycleResult(BaseModel):
    agent_id: str
    cycle_index: int = 0
    started_at: float = Field(default_factory=time.time)
    finished_at: float = 0.0
    ok: bool = True
    triggered: bool = False
    model_latency_ms: int = 0
    prompt_text: str = ""
    raw_response: str = ""
    plan: ActionPlan = Field(default_factory=ActionPlan)
    results: list[ActionResult] = Field(default_factory=list)
    sensor_summary: dict[str, str] = Field(default_factory=dict)
    degraded_sensors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None

    @property
    def duration_ms(self) -> int:
        end = self.finished_at or time.time()
        return int((end - self.started_at) * 1000)


# --------------------------------------------------------------------------- #
# Diagnostics
# --------------------------------------------------------------------------- #
class Diagnostic(BaseModel):
    """One row of the Diagnostics tab / ``observer-core doctor`` output."""

    area: str                      # "sensor", "tool", "model", "system", "network"
    name: str
    ok: bool
    status: Literal["ok", "degraded", "unavailable", "error"] = "ok"
    detail: str = ""
    hint: str = ""                 # actionable fix for the user


__all__ = [
    "SensorKind",
    "ToolKind",
    "SENSOR_TOKENS",
    "ModelSpec",
    "SensorSpec",
    "ToolSpec",
    "AgentDef",
    "SensorPayload",
    "ChatMessage",
    "ToolResult",
    "ToolContext",
    "PlannedAction",
    "MemoryWrite",
    "ActionPlan",
    "ActionResult",
    "CycleResult",
    "Diagnostic",
]
