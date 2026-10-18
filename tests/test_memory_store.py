"""Memory write / read / overwrite, forget, recall ranking."""

from observer_core.runtime.memory_store import tokenize


def test_store_and_get(memory):
    memory.store("a1", "last_workflow", "CI passed")
    row = memory.get("a1", "last_workflow")
    assert row and row.value == "CI passed"


def test_overwrite_is_upsert_not_duplicate(memory, db):
    memory.store("a1", "k", "v1")
    memory.store("a1", "k", "v2")
    rows = db.query("SELECT value FROM memories WHERE agent_id='a1' AND key='k'")
    assert len(rows) == 1 and rows[0]["value"] == "v2"


def test_memories_are_per_agent(memory):
    memory.store("a1", "k", "one")
    memory.store("a2", "k", "two")
    assert memory.get("a1", "k").value == "one"
    assert memory.get("a2", "k").value == "two"


def test_forget_and_wipe(memory):
    memory.store("a1", "k", "v")
    assert memory.forget("a1", "k") is True
    assert memory.forget("a1", "k") is False
    memory.store("a1", "x", "1")
    memory.store("a2", "y", "2")
    assert memory.wipe("a1") == 1
    assert len(memory.list()) == 1


def test_empty_key_rejected(memory):
    import pytest

    with pytest.raises(ValueError):
        memory.store("a1", "  ", "v")


def test_recall_prefers_keyword_overlap(memory):
    memory.store("a1", "last_workflow", "CI failed on main branch")
    memory.store("a1", "printer", "ender 3 finished the benchy")
    memory.store("a1", "coffee", "espresso at 9am")
    top = memory.recall("a1", "did the CI workflow fail on main?", top_k=1)
    assert [r.key for r in top] == ["last_workflow"]


def test_recall_pads_with_recent_when_no_overlap(memory):
    memory.store("a1", "a", "alpha")
    memory.store("a1", "b", "beta")
    assert len(memory.recall("a1", "zzzz qqqq", top_k=2)) == 2


def test_tokenize_drops_stopwords_and_short_words():
    assert tokenize("The CI is on the main branch") == {"main", "branch"}
