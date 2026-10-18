"""Wizard presets, agent store (save/duplicate/import/export), example seeding."""

from pathlib import Path

from observer_core.app import AgentStore, ObserverApp, slugify
from observer_core.config import AppConfig
from observer_core.models import AgentDef, ToolKind
from observer_core.presets import ACTION_CHOICES, PRESETS, build_agent, preset_by_key
from observer_core.storage.db import Database


def test_fifteen_presets_match_spec():
    labels = [p.label for p in PRESETS]
    assert len(PRESETS) == 15
    assert any("distracted" in l.lower() for l in labels)
    assert any("Steam" in l for l in labels)


def test_every_preset_builds_a_valid_agent():
    for p in PRESETS:
        ag = build_agent(name=p.label, observe="", preset_key=p.key)
        AgentDef.model_validate(ag.model_dump())
        assert ag.sensors and ag.tools
        assert ag.enabled is False                       # wizard creates disabled agents
        assert p.condition in ag.system_prompt


def test_user_words_are_appended_to_preset_condition():
    ag = build_agent(name="x", observe="tell me when the bed is empty", preset_key="printer_fails")
    assert "bed is empty" in ag.system_prompt


def test_action_choice_drives_tool():
    ag = build_agent(name="x", observe="o", preset_key="battery_low", action="sms")
    assert ag.tools[0].kind == ToolKind.SMS
    assert ACTION_CHOICES["call"] == ToolKind.PHONE_CALL


def test_free_form_wizard_without_preset():
    ag = build_agent(name="Kettle", observe="the kettle has boiled", action="telegram")
    assert ag.tools[0].kind == ToolKind.TELEGRAM
    assert "kettle has boiled" in ag.system_prompt


def test_text_only_preset_disables_vision():
    ag = build_agent(name="b", observe="", preset_key="battery_low")
    assert ag.model.supports_vision is False


def test_preset_by_key_unknown_raises():
    import pytest

    with pytest.raises(KeyError):
        preset_by_key("nope")


def test_slugify():
    assert slugify("GitHub Workflow!! Finished") == "github-workflow-finished"
    assert slugify("   ").startswith("agent-")


def test_store_save_list_get_delete(tmp_path):
    db = Database(tmp_path / "s.db")
    store = AgentStore(db, tmp_path / "agents")
    ag = build_agent(name="One", observe="o", preset_key="distracted", agent_id="one")
    store.save(ag)
    assert [a.id for a in store.list()] == ["one"]
    assert (tmp_path / "agents" / "one.yaml").exists()
    assert store.get("one").name == "One"
    assert store.delete("one") is True
    assert store.list() == []
    db.close()


def test_duplicate_and_import_export(tmp_path):
    db = Database(tmp_path / "s.db")
    store = AgentStore(db, tmp_path / "agents")
    store.save(build_agent(name="Src", observe="o", preset_key="distracted", agent_id="src"))
    dup = store.duplicate("src")
    assert dup.id != "src" and dup.name.endswith("(copy)") and dup.enabled is False
    out = store.export_file("src", tmp_path / "exp" / "src.json")
    imported = store.import_file(out)
    assert imported.id != "src"          # collision renamed, not overwritten
    yml = store.export_file("src", tmp_path / "exp" / "src.yaml")
    assert "system_prompt" in yml.read_text()
    db.close()


def test_seed_examples_only_once(tmp_path, monkeypatch):
    monkeypatch.setattr("observer_core.paths.repo_root", lambda: Path(__file__).resolve().parent.parent)
    app = ObserverApp(AppConfig(), db_path=tmp_path / "seed.db")
    first = app.seed_examples()
    second = app.seed_examples()
    assert first >= 3 and second == 0
    assert all(a.enabled is False for a in app.agents.list())
    app.close()


def test_app_builds_runtime_and_diagnostics(tmp_path):
    app = ObserverApp(AppConfig(), db_path=tmp_path / "rt.db")
    ag = build_agent(name="R", observe="o", preset_key="distracted", agent_id="r")
    rt = app.build_runtime(ag)
    assert rt.agent.id == "r"
    diags = app.diagnostics()
    assert any(d.area == "model" for d in diags)
    app.close()
