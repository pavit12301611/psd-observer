"""Config round-trip, permissions, masking, env override, skeleton, agent YAML import/export."""

import os
import stat

import pytest

from observer_core.config import AppConfig, expand_refs, mask_secret, set_active_config, skeleton_toml
from observer_core.models import AgentDef, SensorKind, ToolKind


def test_roundtrip(tmp_path, cfg):
    cfg.telegram.bot_token = "123:ABCDEF"
    cfg.telegram.chat_id = "42"
    cfg.models.endpoint = "http://127.0.0.1:9999"
    path = cfg.save(tmp_path / "config.toml")
    loaded = AppConfig.load(path, apply_env=False)
    assert loaded.telegram.bot_token == "123:ABCDEF"
    assert loaded.telegram.chat_id == "42"
    assert loaded.models.endpoint == "http://127.0.0.1:9999"
    assert loaded.privacy.allow_cloud_models is False


def test_saved_file_is_0600(tmp_path, cfg):
    path = cfg.save(tmp_path / "sub" / "config.toml")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_masked_hides_secrets(cfg):
    cfg.telegram.bot_token = "123456789:SECRETSECRETSECRET"
    cfg.twilio.auth_token = "abcdefghijklmnop"
    m = cfg.masked()
    assert "SECRETSECRET" not in str(m)
    assert "abcdefghijklmnop" not in str(m)
    assert m["telegram"]["bot_token"].startswith("123") and "***" in m["telegram"]["bot_token"]


def test_mask_secret_short_values():
    assert mask_secret("abc") == "***"
    assert mask_secret("") == ""


def test_env_overrides_file(monkeypatch, tmp_path, cfg):
    cfg.telegram.bot_token = "from-file"
    cfg.save(tmp_path / "c.toml")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "from-env")
    loaded = AppConfig.load(tmp_path / "c.toml")
    assert loaded.telegram.bot_token == "from-env"


def test_corrupt_file_does_not_crash(tmp_path):
    p = tmp_path / "bad.toml"
    p.write_text("this is = not [valid toml", encoding="utf-8")
    loaded = AppConfig.load(p, apply_env=False)
    assert loaded.load_error and "bad.toml" in loaded.load_error
    assert loaded.models.provider == "ollama"


def test_skeleton_is_commented_and_parses(tmp_path):
    text = skeleton_toml()
    assert text.count("#") > 10
    import tomllib

    data = tomllib.loads(text)
    for section in ("models", "privacy", "runtime", "telegram", "discord", "twilio", "smtp", "sendgrid", "pushover"):
        assert section in data


def test_resolve_refs(cfg):
    cfg.telegram.chat_id = "777"
    set_active_config(cfg)
    assert cfg.resolve_ref("telegram.chat_id") == "777"
    assert expand_refs("chat=${telegram.chat_id}", cfg) == "chat=777"
    assert expand_refs("x=${nope.nothing}", cfg) == "x="


def test_agent_yaml_roundtrip(cfg):
    set_active_config(cfg)
    cfg.telegram.chat_id = "555"
    text = """
id: github-workflow
name: GitHub workflow finished
description: Notify me when CI completes.
enabled: true
loop_interval_s: 30
model:
  provider: ollama
  endpoint: "http://127.0.0.1:11434"
  model: "qwen2.5vl:7b"
  supports_vision: true
sensors:
  - kind: screen
  - kind: screen_ocr
    options: { lang: "eng", roi: null }
system_prompt: |
  Inspect the screen.
tools:
  - kind: telegram
    options: { chat_id: "${telegram.chat_id}" }
  - kind: memory
"""
    a = AgentDef.from_yaml(text)
    assert a.id == "github-workflow"
    assert a.sensors[1].kind == SensorKind.SCREEN_OCR
    assert a.tools[0].options["chat_id"] == "555"          # placeholder resolved
    assert a.tools[1].kind == ToolKind.MEMORY
    again = AgentDef.from_yaml(a.to_yaml())
    assert again.model_dump(exclude={"created_at", "updated_at"}) == a.model_dump(exclude={"created_at", "updated_at"})


def test_agent_json_import_export(cfg):
    set_active_config(cfg)
    a = AgentDef(id="x1", name="X", system_prompt="hi", sensors=[], tools=[])
    back = AgentDef.from_json(a.to_json())
    assert back.id == "x1" and back.name == "X"


def test_agent_rejects_empty_id():
    with pytest.raises(ValueError):
        AgentDef(id="   ", name="n", system_prompt="s")


def test_example_agents_parse():
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent / "examples" / "agents"
    files = sorted(root.glob("*.yaml"))
    assert len(files) >= 3
    for f in files:
        AgentDef.from_file(f)
