"""Global configuration: pydantic models + TOML load/save.

Security rules implemented here:

* ``config.toml`` is written with mode ``0600`` and its parent dir ``0700``.
* Secrets are never returned by :meth:`AppConfig.masked` — that method is the
  only one safe to log or show in the GUI.
* Environment variables always win over the file for credentials, so a user can
  keep ``config.toml`` free of secrets entirely.
* ``observer-core init-config`` writes a commented skeleton and never
  overwrites an existing file.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, ClassVar

import tomllib
from pydantic import BaseModel, ConfigDict, Field

from . import paths

try:  # tomli_w is a hard dep, but keep the module importable without it
    import tomli_w as _tomli_w
except ImportError:  # pragma: no cover
    _tomli_w = None  # type: ignore[assignment]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def mask_secret(value: Any, keep: int = 3) -> str:
    """Return ``ab***yz`` for anything that looks like a credential."""
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    if len(text) <= keep * 2:
        return "*" * len(text)
    return f"{text[:keep]}{'*' * 6}{text[-keep:]}"


def _env(name: str, default: Any = None) -> Any:
    raw = os.environ.get(name)
    return default if raw is None or raw == "" else raw


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# --------------------------------------------------------------------------- #
# sub-models
# --------------------------------------------------------------------------- #
class TelegramCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    bot_token: str = ""
    chat_id: str = ""
    api_base: str = "https://api.telegram.org"


class DiscordCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    webhook_url: str = ""


class TwilioCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    account_sid: str = ""
    auth_token: str = ""
    from_number: str = ""
    whatsapp_from: str = "whatsapp:"   # prefixed with the from_number at send time
    api_base: str = "https://api.twilio.com"


class SmtpCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    host: str = ""
    port: int = 587
    user: str = ""
    password: str = ""
    from_addr: str = ""
    use_tls: bool = True
    timeout_s: float = 20.0


class SendgridCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    api_key: str = ""
    from_email: str = ""
    api_base: str = "https://api.sendgrid.com"


class PushoverCreds(BaseModel):
    model_config = ConfigDict(extra="ignore")
    token: str = ""
    user: str = ""


class ModelDefaults(BaseModel):
    """Defaults applied to agents that do not pin their own ModelSpec."""

    model_config = ConfigDict(extra="ignore")
    provider: str = "ollama"
    endpoint: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    openai_endpoint: str = "http://127.0.0.1:8080/v1"
    openai_model: str = "local-model"
    cloud_endpoint: str = "https://openrouter.ai/api/v1"
    cloud_model: str = "openai/gpt-4o-mini"
    #: Name of the env var that holds the cloud/OpenAI API key. Never the key itself.
    openai_api_key_env: str = "OPENAI_API_KEY"
    temperature: float = 0.1
    max_tokens: int = 512
    context_window: int = 8192
    supports_vision: bool = False
    timeout_s: float = 60.0


class PrivacySettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    #: Refuse to start a cycle whose model is a cloud provider when False.
    allow_cloud_models: bool = False
    #: Write captured frames into the local ring buffer on disk.
    persist_frames: bool = False
    #: Ring buffer ceiling in MB.
    max_frames_mb: int = 500
    #: How many frames to keep at most.
    max_frames: int = 2000
    #: Frames are stored unencrypted; refuse when the dir is world-readable.
    warn_world_readable: bool = True
    #: Kill-switch: refuse any tool that leaves the machine.
    block_network_tools: bool = False
    #: Redact clipboard/OCR text matching these regexes before it reaches a model.
    redact_patterns: list[str] = Field(default_factory=list)
    #: Hard rule — there is no Observer Core server. Kept to make the guarantee explicit.
    telemetry: bool = False


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    cycle_timeout_s: float = 120.0
    max_concurrent_model_calls: int = 2
    jitter_pct: float = 10.0
    backoff_base_s: float = 5.0
    backoff_cap_s: float = 300.0
    sensor_cache_ttl_s: float = 4.0
    preview_fps: float = 5.0
    preview_max_width: int = 640
    memory_top_k: int = 5
    #: Seconds of audio captured per microphone/system-audio sample.
    audio_clip_s: float = 3.0
    #: When a transcriber is missing, degrade instead of failing.
    allow_no_transcript: bool = True


class PathsSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    #: Empty strings mean "use the XDG default".
    config_dir: str = ""
    data_dir: str = ""
    state_dir: str = ""
    cache_dir: str = ""
    frames_dir: str = ""
    recordings_dir: str = ""

    def apply_to_environment(self) -> None:
        """Push non-empty overrides into the environment before dirs are cached."""
        mapping = {
            "XDG_CONFIG_HOME": self.config_dir,
            "XDG_DATA_HOME": self.data_dir,
            "XDG_STATE_HOME": self.state_dir,
            "XDG_CACHE_HOME": self.cache_dir,
        }
        for env_name, value in mapping.items():
            if value:
                os.environ[env_name] = str(Path(value).expanduser())
        for fn in ("home_dir", "config_dir", "data_dir", "state_dir", "cache_dir"):
            getattr(paths, fn).cache_clear()


# --------------------------------------------------------------------------- #
# root model
# --------------------------------------------------------------------------- #
class AppConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int = 1
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    #: Bookkeeping (never serialised): where this config was read from / written to.
    source_path: str | None = Field(default=None, exclude=True)
    #: Populated when an existing file could not be parsed.
    load_error: str | None = Field(default=None, exclude=True)

    models: ModelDefaults = Field(default_factory=ModelDefaults)
    privacy: PrivacySettings = Field(default_factory=PrivacySettings)
    runtime: RuntimeSettings = Field(default_factory=RuntimeSettings)
    paths: PathsSettings = Field(default_factory=PathsSettings)

    telegram: TelegramCreds = Field(default_factory=TelegramCreds)
    discord: DiscordCreds = Field(default_factory=DiscordCreds)
    twilio: TwilioCreds = Field(default_factory=TwilioCreds)
    smtp: SmtpCreds = Field(default_factory=SmtpCreds)
    sendgrid: SendgridCreds = Field(default_factory=SendgridCreds)
    pushover: PushoverCreds = Field(default_factory=PushoverCreds)

    #: Keys whose values are credentials and must never be logged verbatim.
    SECRET_KEYS: ClassVar[dict[str, set[str]]] = {
        "telegram": {"bot_token"},
        "discord": {"webhook_url"},
        "twilio": {"account_sid", "auth_token"},
        "smtp": {"password"},
        "sendgrid": {"api_key"},
        "pushover": {"token", "user"},
    }

    # ------------------------------------------------------------------ #
    # environment overrides (env always wins for credentials)
    # ------------------------------------------------------------------ #
    def apply_env_overrides(self) -> None:
        m = self.models
        m.provider = _env("OBSERVER_CORE_PROVIDER", m.provider)
        m.endpoint = _env("OBSERVER_CORE_ENDPOINT", m.endpoint)
        m.ollama_model = _env("OLLAMA_MODEL", m.ollama_model)
        m.openai_endpoint = _env("OPENAI_BASE_URL", m.openai_endpoint)
        m.openai_model = _env("OPENAI_MODEL", m.openai_model)
        m.cloud_endpoint = _env("OBSERVER_CORE_CLOUD_ENDPOINT", m.cloud_endpoint)
        m.cloud_model = _env("OBSERVER_CORE_CLOUD_MODEL", m.cloud_model)
        m.openai_api_key_env = _env("OBSERVER_CORE_API_KEY_ENV", m.openai_api_key_env)

        self.telegram.bot_token = _env("TELEGRAM_BOT_TOKEN", self.telegram.bot_token)
        self.telegram.chat_id = _env("TELEGRAM_CHAT_ID", self.telegram.chat_id)
        self.discord.webhook_url = _env("DISCORD_WEBHOOK_URL", self.discord.webhook_url)
        self.twilio.account_sid = _env("TWILIO_ACCOUNT_SID", self.twilio.account_sid)
        self.twilio.auth_token = _env("TWILIO_AUTH_TOKEN", self.twilio.auth_token)
        self.twilio.from_number = _env("TWILIO_FROM_NUMBER", self.twilio.from_number)
        self.smtp.host = _env("SMTP_HOST", self.smtp.host)
        self.smtp.user = _env("SMTP_USER", self.smtp.user)
        self.smtp.password = _env("SMTP_PASSWORD", self.smtp.password)
        self.sendgrid.api_key = _env("SENDGRID_API_KEY", self.sendgrid.api_key)
        self.pushover.token = _env("PUSHOVER_TOKEN", self.pushover.token)
        self.pushover.user = _env("PUSHOVER_USER", self.pushover.user)

        self.privacy.allow_cloud_models = _bool_env(
            "OBSERVER_CORE_ALLOW_CLOUD", self.privacy.allow_cloud_models
        )
        self.privacy.persist_frames = _bool_env(
            "OBSERVER_CORE_PERSIST_FRAMES", self.privacy.persist_frames
        )

    # ------------------------------------------------------------------ #
    # reference resolution used by agent files: ${telegram.chat_id}
    # ------------------------------------------------------------------ #
    def resolve_ref(self, ref: str, default: Any = "") -> Any:
        node: Any = self
        for part in ref.split("."):
            if isinstance(node, BaseModel):
                node = getattr(node, part, None)
            elif isinstance(node, dict):
                node = node.get(part)
            else:
                return default
            if node is None:
                return default
        return node

    # ------------------------------------------------------------------ #
    # masking
    # ------------------------------------------------------------------ #
    def masked(self) -> dict[str, Any]:
        """A deep copy of the config with every credential masked."""
        data = self.model_dump()
        for section, keys in self.SECRET_KEYS.items():
            for key in keys:
                if key in data.get(section, {}):
                    data[section][key] = mask_secret(data[section][key])
        return data

    def secret_for(self, section: str, key: str) -> str:
        return str(getattr(getattr(self, section, object()), key, "") or "")

    # ------------------------------------------------------------------ #
    # persistence
    # ------------------------------------------------------------------ #
    @classmethod
    def load(cls, path: str | Path | None = None, *, apply_env: bool = True) -> "AppConfig":
        path = Path(path) if path else paths.config_file()
        if path.exists():
            try:
                raw = tomllib.loads(path.read_text(encoding="utf-8"))
                cfg = cls.model_validate(raw)
            except Exception as exc:  # corrupt file must not brick the app
                cfg = cls()
                cfg.load_error = f"{path}: {exc}"
        else:
            cfg = cls()
        if apply_env:
            cfg.apply_env_overrides()
        cfg.source_path = str(path)
        return cfg

    def save(self, path: str | Path | None = None) -> Path:
        if _tomli_w is None:  # pragma: no cover - dependency missing
            raise RuntimeError("tomli-w is required to save configuration")
        path = Path(path) if path else (self.source_path and Path(self.source_path)) or paths.config_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except OSError:  # pragma: no cover
            pass
        payload = self.model_dump()
        payload["updated_at"] = time.time()
        self.updated_at = payload["updated_at"]
        with open(path, "wb") as fh:
            _tomli_w.dump(payload, fh)
        try:
            os.chmod(path, 0o600)
        except OSError:  # pragma: no cover - e.g. read-only mount
            pass
        self.source_path = str(path)
        return path

    def save_masked_copy(self, path: str | Path) -> Path:
        """Write a version with secrets masked — used by ``doctor --dump``."""
        import json

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.masked(), indent=2, default=str), encoding="utf-8")
        os.chmod(path, 0o600)
        return path


# --------------------------------------------------------------------------- #
# module-level "active config" (used by AgentDef placeholder expansion)
# --------------------------------------------------------------------------- #
_ACTIVE: AppConfig | None = None


def set_active_config(cfg: AppConfig | None) -> None:
    global _ACTIVE
    _ACTIVE = cfg


def get_active_config() -> AppConfig | None:
    return _ACTIVE


def load_or_create(path: str | Path | None = None, *, create: bool = False) -> AppConfig:
    """Load the config, optionally writing a skeleton when missing."""
    cfg_path = Path(path) if path else paths.config_file()
    if create and not cfg_path.exists():
        cfg = AppConfig()
        cfg.save(cfg_path)
    cfg = AppConfig.load(cfg_path)
    set_active_config(cfg)
    return cfg


# --------------------------------------------------------------------------- #
# commented skeleton written by `observer-core init-config`
# --------------------------------------------------------------------------- #
SKELETON_HEADER = """\
# Observer Core — global configuration
# Generated by `observer-core init-config`. Re-running it will NOT overwrite this file.
#
# PRIVACY: this file may contain credentials. Observer Core writes it with mode
# 0600 and never sends its contents anywhere. Prefer environment variables
# (TELEGRAM_BOT_TOKEN, DISCORD_WEBHOOK_URL, ...) if you would rather keep this
# file free of secrets — the environment always wins.
#
# Every key below is optional; anything omitted falls back to the built-in
# default shown as the value.
"""


def skeleton_toml(cfg: AppConfig | None = None) -> str:
    """Render a fully commented ``config.toml`` skeleton."""
    cfg = cfg or AppConfig()
    d = cfg.model_dump()
    sections: dict[str, dict[str, Any]] = {
        "models": d["models"],
        "privacy": d["privacy"],
        "runtime": d["runtime"],
        "paths": d["paths"],
        "telegram": d["telegram"],
        "discord": d["discord"],
        "twilio": d["twilio"],
        "smtp": d["smtp"],
        "sendgrid": d["sendgrid"],
        "pushover": d["pushover"],
    }
    help_text = {
        ("models", "provider"): "ollama | openai_compat | llamacpp_local | cloud",
        ("models", "endpoint"): "ollama / llama.cpp / vLLM / LM Studio base URL",
        ("models", "ollama_model"): "run `ollama list` to see what you have pulled",
        ("models", "openai_api_key_env"): "NAME of the env var holding the key — never the key",
        ("privacy", "allow_cloud_models"): "false = the app refuses to call any cloud model",
        ("privacy", "persist_frames"): "true = keep screenshots in a local ring buffer",
        ("privacy", "block_network_tools"): "true = every tool that leaves the machine is disabled",
        ("runtime", "memory_top_k"): "how many memory rows are folded into each prompt",
        ("runtime", "audio_clip_s"): "seconds of audio sampled per capture",
        ("paths", "data_dir"): "empty = XDG default (~/.local/share/observer-core)",
    }
    out = [SKELETON_HEADER]
    for section, values in sections.items():
        out.append(f"\n[{section}]")
        for key, value in values.items():
            note = help_text.get((section, key))
            if note:
                out.append(f"# {note}")
            out.append(f"{key} = {_toml_literal(value)}")
    return "\n".join(out) + "\n"


def _toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_literal(v) for v in value) + "]"
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


_REF_PATTERN = re.compile(r"\$\{([a-z_][a-z0-9_.]*)\}", re.IGNORECASE)


def expand_refs(text: str, cfg: AppConfig) -> str:
    """Expand ``${telegram.chat_id}``-style refs anywhere inside a string."""

    def repl(match: re.Match[str]) -> str:
        value = cfg.resolve_ref(match.group(1), None)
        return "" if value is None else str(value)

    return _REF_PATTERN.sub(repl, text or "")
