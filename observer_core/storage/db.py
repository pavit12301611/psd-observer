"""SQLite storage: schema, migrations, connection factory.

WAL mode and a 5 s busy timeout so the GUI, the daemon and the CLI can share the
file. Schema version is tracked with ``PRAGMA user_version``.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .. import paths

SCHEMA_VERSION = 1

MIGRATIONS: dict[int, list[str]] = {
    1: [
        """CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT,
            definition TEXT,
            enabled INT,
            updated_at REAL
        )""",
        """CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY,
            ts REAL,
            agent_id TEXT,
            level TEXT,
            kind TEXT,
            message TEXT,
            payload TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS events_ts ON events(ts)",
        "CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, ts)",
        """CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY,
            agent_id TEXT,
            key TEXT,
            value TEXT,
            ts REAL,
            importance REAL DEFAULT 0.5
        )""",
        "CREATE UNIQUE INDEX IF NOT EXISTS memories_unique ON memories(agent_id, key)",
        """CREATE TABLE IF NOT EXISTS frames (
            id INTEGER PRIMARY KEY,
            ts REAL,
            agent_id TEXT,
            kind TEXT,
            path TEXT
        )""",
    ],
}


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    """Open (and migrate) the database. Returns a connection in autocommit-free mode."""
    db_path = Path(path) if path else paths.db_file()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5.0, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    migrate(conn)
    try:
        db_path.chmod(0o600)
    except OSError:  # pragma: no cover
        pass
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for version in sorted(MIGRATIONS):
        if version <= current:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for stmt in MIGRATIONS[version]:
                conn.execute(stmt)
            conn.execute(f"PRAGMA user_version = {int(version)}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        current = version
    return current


class Database:
    """Thread-safe wrapper: one connection guarded by a re-entrant lock."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else paths.db_file()
        self._conn = connect(self.path)
        self._lock = threading.RLock()
        self._closed = False

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def execute(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def query(self, sql: str, params: tuple | dict = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except sqlite3.Error:
                    pass
                self._conn.close()
                self._closed = True

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


__all__ = ["connect", "migrate", "Database", "SCHEMA_VERSION"]
