"""SQLite schema/migrations, event redaction + export, frame ring-buffer eviction."""

import json
import os

from observer_core.storage.db import Database, SCHEMA_VERSION, connect
from observer_core.storage.events import EventLog
from observer_core.storage.frames import FrameRingBuffer


def test_schema_created_and_wal(tmp_path):
    db = Database(tmp_path / "x.db")
    tables = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"agents", "events", "memories", "frames"} <= tables
    assert db.query("PRAGMA journal_mode")[0][0] == "wal"
    assert db.query("PRAGMA user_version")[0][0] == SCHEMA_VERSION
    assert db.query("PRAGMA busy_timeout")[0][0] == 5000
    db.close()


def test_migrate_is_idempotent(tmp_path):
    p = tmp_path / "y.db"
    connect(p).close()
    db = Database(p)  # second open must not fail on existing tables
    assert db.query("PRAGMA user_version")[0][0] == SCHEMA_VERSION
    db.close()


def test_db_file_permissions(tmp_path):
    p = tmp_path / "perm.db"
    connect(p).close()
    assert oct(os.stat(p).st_mode & 0o777) == "0o600"


def test_events_redact_secrets_and_export(tmp_path, db):
    log = EventLog(db, jsonl_path=tmp_path / "ev.jsonl")
    row = log.record("bearer abcdefghijkl used", payload={"bot_token": "999:ZZZ", "text": "hello"}, agent_id="a")
    assert "abcdefghijkl" not in row["message"]
    assert row["payload"]["bot_token"] == "***REDACTED***"
    assert row["payload"]["text"] == "hello"
    assert (tmp_path / "ev.jsonl").read_text().count("\n") == 1
    out = log.export(tmp_path / "all.csv", fmt="csv")
    assert "level" in out.read_text().splitlines()[0]
    out2 = log.export(tmp_path / "all.jsonl")
    assert json.loads(out2.read_text().splitlines()[0])["level"] == "INFO"


def test_events_filter_by_level(db):
    log = EventLog(db)
    log.record("a", level="ERROR")
    log.record("b", level="INFO")
    errs = log.recent(level="ERROR")
    assert [e["message"] for e in errs] == ["a"]
    assert len(log.recent(level="ALL")) == 2


def test_listener_failure_does_not_break_logging(db):
    log = EventLog(db)

    def bad(row):
        raise RuntimeError("listener broke")

    log.subscribe(bad)
    assert log.record("still works")["message"] == "still works"


def test_frame_ring_buffer_evicts_oldest_by_count(tmp_path, db):
    ring = FrameRingBuffer(db, tmp_path / "frames", max_files=3, max_mb=100, enabled=True)
    paths = [ring.write("a", "screen", b"x" * 100) for _ in range(5)]
    assert ring.count() == 3
    assert not paths[0].exists() and not paths[1].exists()
    assert paths[4].exists()


def test_frame_ring_buffer_evicts_by_bytes(tmp_path, db):
    ring = FrameRingBuffer(db, tmp_path / "frames", max_files=100, max_mb=0.001, enabled=True)  # ~1 KB
    for _ in range(5):
        ring.write("a", "camera", b"y" * 600, ext="jpg")
    total = sum(os.path.getsize(r["path"]) for r in db.query("SELECT path FROM frames"))
    assert total <= ring.max_bytes or ring.count() == 1


def test_frame_ring_buffer_disabled_writes_nothing(tmp_path, db):
    ring = FrameRingBuffer(db, tmp_path / "frames", enabled=False)
    assert ring.write("a", "screen", b"data") is None
    assert not (tmp_path / "frames").exists()


def test_frame_wipe(tmp_path, db):
    ring = FrameRingBuffer(db, tmp_path / "frames", enabled=True)
    ring.write("a", "screen", b"1")
    ring.write("a", "screen", b"2")
    assert ring.wipe() == 2 and ring.count() == 0
