"""Event log: rows in SQLite + an optional JSONL mirror for export/grep.

Levels: DEBUG, INFO, OK, WARN, ERROR. Payloads are JSON and are passed through
the redactor before being written, so tokens never reach disk.
"""

from __future__ import annotations

import csv
import json
import threading
import time
from pathlib import Path
from typing import Any

from ..logging_setup import redact
from .db import Database

LEVELS = ("DEBUG", "INFO", "OK", "WARN", "ERROR")


class EventLog:
    def __init__(self, db: Database, jsonl_path: Path | None = None) -> None:
        self.db = db
        self.jsonl_path = jsonl_path
        self._lock = threading.Lock()
        self._listeners: list = []

    def subscribe(self, fn) -> None:
        """Register a callback ``fn(row_dict)`` (used by the GUI console)."""
        self._listeners.append(fn)

    def record(
        self,
        message: str,
        *,
        level: str = "INFO",
        agent_id: str | None = None,
        kind: str = "log",
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        level = level.upper() if level.upper() in LEVELS else "INFO"
        ts = time.time()
        msg = redact(str(message))
        pay = json.dumps(_redact_obj(payload or {}), default=str, ensure_ascii=False)
        with self._lock:
            cur = self.db.execute(
                "INSERT INTO events(ts, agent_id, level, kind, message, payload) VALUES (?,?,?,?,?,?)",
                (ts, agent_id, level, kind, msg, pay),
            )
            row_id = cur.lastrowid
        row = {"id": row_id, "ts": ts, "agent_id": agent_id, "level": level, "kind": kind,
               "message": msg, "payload": json.loads(pay)}
        if self.jsonl_path is not None:
            try:
                self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
                with open(self.jsonl_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row, default=str, ensure_ascii=False) + "\n")
            except OSError:
                pass
        for fn in list(self._listeners):
            try:
                fn(row)
            except Exception:  # listeners must never break logging
                pass
        return row

    def recent(self, limit: int = 200, level: str | None = None, agent_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM events WHERE 1=1"
        params: list[Any] = []
        if level and level.upper() != "ALL":
            sql += " AND level = ?"
            params.append(level.upper())
        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(int(limit))
        rows = self.db.query(sql, tuple(params))
        return [_row(r) for r in reversed(rows)]

    def export(self, dest: Path, fmt: str = "jsonl") -> Path:
        rows = self.db.query("SELECT * FROM events ORDER BY id ASC")
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = [_row(r) for r in rows]
        if fmt == "csv":
            with open(dest, "w", newline="", encoding="utf-8") as fh:
                w = csv.DictWriter(fh, fieldnames=["id", "ts", "agent_id", "level", "kind", "message", "payload"])
                w.writeheader()
                for r in data:
                    r = dict(r)
                    r["payload"] = json.dumps(r["payload"], default=str)
                    w.writerow(r)
        else:
            with open(dest, "w", encoding="utf-8") as fh:
                for r in data:
                    fh.write(json.dumps(r, default=str, ensure_ascii=False) + "\n")
        return dest


def _row(r) -> dict:
    d = dict(r)
    try:
        d["payload"] = json.loads(d.get("payload") or "{}")
    except (TypeError, ValueError):
        d["payload"] = {}
    return d


_SECRET_KEYS = ("token", "key", "secret", "password", "auth", "webhook", "sid")


def _redact_obj(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if any(s in str(k).lower() for s in _SECRET_KEYS):
                out[k] = "***REDACTED***" if v else v
            else:
                out[k] = _redact_obj(v)
        return out
    if isinstance(obj, list):
        return [_redact_obj(v) for v in obj]
    if isinstance(obj, str):
        return redact(obj)
    return obj


__all__ = ["EventLog", "LEVELS"]
