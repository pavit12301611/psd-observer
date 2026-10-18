"""Token substitution for every sensor kind, unknown tokens, degraded sensors, message assembly."""

import pytest

from observer_core.models import SENSOR_TOKENS, SensorKind, SensorPayload
from observer_core.runtime.prompt import build_messages, render_prompt


def _text_payload(kind, text="hello"):
    return SensorPayload(kind=kind, data=text, mime="text/plain")


def _img_payload(kind, w=1280, h=720):
    return SensorPayload(kind=kind, data=b"\x89PNG\r\n\x1a\nfake", mime="image/png", meta={"width": w, "height": h})


def test_every_sensor_kind_has_a_token():
    assert set(SENSOR_TOKENS) == set(SensorKind)
    assert SENSOR_TOKENS[SensorKind.SCREEN] == "$SCREEN"
    assert SENSOR_TOKENS[SensorKind.ALL_AUDIO] == "$ALL_AUDIO"


@pytest.mark.parametrize("kind", [SensorKind.SCREEN, SensorKind.CAMERA])
def test_image_tokens_attach_image_and_caption(kind):
    tok = SENSOR_TOKENS[kind]
    r = render_prompt(f"Look at {tok}", {kind: _img_payload(kind)}, agent_name="a", cycle_index=1,
                      supports_vision=True, enabled_kinds=[kind])
    assert len(r.images) == 1
    assert "[image attached:" in r.user_text and "1280x720" in r.user_text
    assert tok not in r.user_text.split("Observations")[-1] or "image attached" in r.user_text


@pytest.mark.parametrize("kind", [SensorKind.SCREEN_OCR, SensorKind.CLIPBOARD, SensorKind.MICROPHONE,
                                  SensorKind.SCREEN_AUDIO, SensorKind.ALL_AUDIO])
def test_text_tokens_become_fenced_blocks(kind):
    tok = SENSOR_TOKENS[kind]
    r = render_prompt(f"Read {tok} now", {kind: _text_payload(kind, "some words")}, agent_name="a",
                      cycle_index=2, enabled_kinds=[kind])
    assert "```text" in r.user_text and "some words" in r.user_text
    assert r.images == []


def test_vision_disabled_model_gets_no_image_but_a_note():
    r = render_prompt("$SCREEN", {SensorKind.SCREEN: _img_payload(SensorKind.SCREEN)}, agent_name="a",
                      cycle_index=1, supports_vision=False, enabled_kinds=[SensorKind.SCREEN])
    assert r.images == []
    assert "not vision-capable" in r.user_text
    assert any("vision" in w for w in r.warnings)


def test_unknown_token_left_literal_with_warning():
    r = render_prompt("value $NOT_A_SENSOR here", {}, agent_name="a", cycle_index=1)
    assert "$NOT_A_SENSOR" in r.user_text
    assert r.unknown_tokens == ["$NOT_A_SENSOR"]
    assert any("unknown token" in w for w in r.warnings)


def test_plain_dollar_amounts_are_not_tokens():
    r = render_prompt("pay $5 or $12.50 today", {}, agent_name="a", cycle_index=1)
    assert r.unknown_tokens == [] and "$5" in r.user_text


def test_missing_payload_reports_unavailable():
    r = render_prompt("$CLIPBOARD", {SensorKind.CLIPBOARD: None}, agent_name="a", cycle_index=1,
                      enabled_kinds=[SensorKind.CLIPBOARD])
    assert "[sensor unavailable: clipboard]" in r.user_text
    assert r.warnings


def test_disabled_sensor_token_is_flagged():
    r = render_prompt("$CAMERA", {}, agent_name="a", cycle_index=1, enabled_kinds=[SensorKind.SCREEN])
    assert "not enabled" in r.user_text


def test_degraded_image_reports_error():
    p = SensorPayload(kind=SensorKind.SCREEN, degraded=True, error="portal permission required")
    r = render_prompt("$SCREEN", {SensorKind.SCREEN: p}, agent_name="a", cycle_index=1,
                      enabled_kinds=[SensorKind.SCREEN])
    assert "portal permission required" in r.user_text


def test_cycle_metadata_present():
    r = render_prompt("x", {}, agent_name="Printer", cycle_index=7, memories=[])
    assert "Agent: Printer" in r.user_text and "Cycle: #7" in r.user_text and "Cycle time:" in r.user_text


def test_memory_block_rendered():
    from observer_core.runtime.memory_store import MemoryRow

    mem = [MemoryRow(agent_id="a", key="last_workflow", value="failed", ts=0.0)]
    r = render_prompt("x", {}, agent_name="a", cycle_index=1, memories=mem)
    assert "Relevant memory:" in r.user_text and "last_workflow: failed" in r.user_text


def test_fence_cannot_break_out():
    r = render_prompt("$OCR", {}, agent_name="a", cycle_index=1)  # unknown token but still ok
    p = _text_payload(SensorKind.SCREEN_OCR, "evil ``` injection")
    r = render_prompt("$SCREEN_OCR", {SensorKind.SCREEN_OCR: p}, agent_name="a", cycle_index=1,
                      enabled_kinds=[SensorKind.SCREEN_OCR])
    assert "evil '''" in r.user_text


def test_build_messages_contract_and_tools():
    r = render_prompt("$SCREEN", {SensorKind.SCREEN: _img_payload(SensorKind.SCREEN)}, agent_name="a",
                      cycle_index=1, enabled_kinds=[SensorKind.SCREEN])
    msgs = build_messages("Watch the screen.", ["telegram", "memory"], r)
    assert msgs[0].role == "system" and "telegram, memory" in msgs[0].content
    assert '"triggered"' in msgs[0].content and "{\"triggered\": false}" in msgs[0].content
    assert msgs[1].role == "user" and len(msgs[1].images) == 1
