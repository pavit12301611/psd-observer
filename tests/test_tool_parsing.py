"""Response parsing: balanced JSON, fenced blocks, loose form, prose, malformed input."""

from observer_core.runtime.parse import iter_balanced_objects, parse_response


def test_plain_json_triggered():
    plan = parse_response('{"triggered": true, "reason": "done", "actions": [{"tool": "telegram", "args": {"text": "hi"}}]}')
    assert plan.triggered and plan.parse_mode == "json"
    assert plan.actions[0].tool == "telegram" and plan.actions[0].args == {"text": "hi"}
    assert plan.reason == "done"


def test_json_false():
    plan = parse_response('{"triggered": false}')
    assert not plan.triggered and plan.parse_mode == "json" and plan.actions == []


def test_json_surrounded_by_chatter():
    plan = parse_response('Sure! Here you go: {"triggered": true} hope it helps {not json}')
    assert plan.triggered and plan.parse_mode == "json"


def test_braces_inside_strings_do_not_break_scan():
    text = 'noise {"reason": "use } and { in strings", "triggered": true} tail'
    plan = parse_response(text)
    assert plan.triggered and plan.reason == "use } and { in strings"


def test_iter_balanced_objects_nested_and_escaped():
    text = r'{"a": {"b": "x\"}"}} and {"c": 1}'
    objs = list(iter_balanced_objects(text))
    assert objs == [r'{"a": {"b": "x\"}"}}', '{"c": 1}']


def test_fenced_json_block():
    text = "Analysis first.\n```json\n{\n  \"triggered\": true,\n  \"actions\": []\n}\n```"
    plan = parse_response(text)
    assert plan.triggered and plan.parse_mode == "json"  # first balanced object wins


def test_fenced_when_plain_scan_fails():
    # first balanced object is invalid JSON, so the fenced one is used
    text = "{oops this is not json} ```json\n{\"triggered\": true}\n```"
    plan = parse_response(text)
    assert plan.triggered


def test_loose_form_triggered_with_tools():
    plan = parse_response("triggered: true\ntool: telegram\ntool: memory")
    assert plan.triggered and plan.parse_mode == "loose"
    assert [a.tool for a in plan.actions] == ["telegram", "memory"]
    assert plan.warnings


def test_loose_form_false():
    plan = parse_response("triggered: false because nothing happened")
    assert not plan.triggered and plan.parse_mode == "loose"


def test_prose_with_trigger_phrase():
    plan = parse_response("I see the build is DONE now.", trigger_phrase="done")
    assert plan.triggered and plan.parse_mode == "phrase"


def test_prose_without_trigger_phrase():
    plan = parse_response("Nothing interesting here.", trigger_phrase="done")
    assert not plan.triggered and plan.parse_mode == "phrase"


def test_json_is_not_subject_to_phrase_false_positive():
    # The reason mentions the phrase, but the JSON says false: must NOT trigger.
    plan = parse_response('{"triggered": false, "reason": "build is done? no"}', trigger_phrase="done")
    assert not plan.triggered and plan.parse_mode == "json"


def test_garbage_never_raises():
    for text in ["", None, "{{{{", "}}}}", "```", "null", "[1,2,3]", "{\"triggered\": \"maybe\"}", "\x00\x01"]:
        plan = parse_response(text or "")
        assert plan.parse_mode in ("json", "fenced", "loose", "phrase", "none")


def test_actions_without_triggered_flag_count_as_trigger():
    plan = parse_response('{"actions": [{"tool": "discord", "args": {"text": "x"}}]}')
    assert plan.triggered and plan.actions[0].tool == "discord"


def test_malformed_actions_are_skipped_with_warning():
    plan = parse_response('{"triggered": true, "actions": ["telegram", 5, {"args": {}}, {"tool": "sms"}]}')
    tools = [a.tool for a in plan.actions]
    assert tools == ["telegram", "sms"]
    assert any("without" in w or "non-object" in w for w in plan.warnings)


def test_memory_entries_parsed_and_validated():
    plan = parse_response('{"triggered": false, "memory": [{"key": "last", "value": "x"}, {"value": "no key"}]}')
    assert [m.key for m in plan.memory] == ["last"]
    assert plan.warnings


def test_confidence_bad_value_is_none():
    plan = parse_response('{"triggered": true, "confidence": "high"}')
    assert plan.confidence is None
