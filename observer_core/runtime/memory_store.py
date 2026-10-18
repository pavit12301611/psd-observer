"""Persistent per-agent memory (SQLite) with keyword-overlap recall.

Operations: store (upsert on (agent_id, key)), recall (top-k by keyword overlap
with a query), list, forget, wipe. Recall is deliberately simple — no embeddings,
no network — so it stays local and deterministic.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from ..storage.db import Database

_WORD = re.compile(r"[a-z0-9]{3,}")
_STOP = {"the", "and", "for", "with", "that", "this", "from", "you", "are", "was", "your", "has", "have"}


@dataclass
class MemoryRow:
    agent_id: str
    key: str
    value: str
    ts: float
    importance: float = 0.5

    def as_line(self) -> str:
        return f"- {self.key}: {self.value}"


def tokenize(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if w not in _STOP}


class MemoryStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    def store(self, agent_id: str, key: str, value: str, importance: float = 0.5) -> None:
        key = (key or "").strip()
        if not key:
            raise ValueError("memory key must not be empty")
        self.db.execute(
            """INSERT INTO memories(agent_id, key, value, ts, importance) VALUES (?,?,?,?,?)
               ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, ts=excluded.ts,
                                                       importance=excluded.importance""",
            (agent_id, key, str(value), time.time(), float(importance)),
        )

    def get(self, agent_id: str, key: str) -> MemoryRow | None:
        rows = self.db.query("SELECT * FROM memories WHERE agent_id=? AND key=?", (agent_id, key))
        return _row(rows[0]) if rows else None

    def list(self, agent_id: str | None = None, limit: int = 500) -> list[MemoryRow]:
        if agent_id:
            rows = self.db.query("SELECT * FROM memories WHERE agent_id=? ORDER BY ts DESC LIMIT ?", (agent_id, limit))
        else:
            rows = self.db.query("SELECT * FROM memories ORDER BY ts DESC LIMIT ?", (limit,))
        return [_row(r) for r in rows]

    def forget(self, agent_id: str, key: str) -> bool:
        cur = self.db.execute("DELETE FROM memories WHERE agent_id=? AND key=?", (agent_id, key))
        return cur.rowcount > 0

    def wipe(self, agent_id: str | None = None) -> int:
        if agent_id:
            cur = self.db.execute("DELETE FROM memories WHERE agent_id=?", (agent_id,))
        else:
            cur = self.db.execute("DELETE FROM memories")
        return cur.rowcount

    def recall(self, agent_id: str, query: str, top_k: int = 5) -> list[MemoryRow]:
        """Rank this agent's memories by keyword overlap with ``query``; recency breaks ties."""
        q = tokenize(query)
        rows = self.list(agent_id, limit=1000)
        scored: list[tuple[float, float, MemoryRow]] = []
        for r in rows:
            overlap = len(q & tokenize(r.key + " " + r.value))
            score = overlap * (0.5 + r.importance)
            scored.append((score, r.ts, r))
        scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
        chosen = [r for s, _ts, r in scored if s > 0][:top_k]
        if len(chosen) < top_k:  # pad with the most recent rows so the model sees context
            seen = {r.key for r in chosen}
            for _s, _ts, r in scored:
                if len(chosen) >= top_k:
                    break
                if r.key not in seen:
                    chosen.append(r)
                    seen.add(r.key)
        return chosen


def _row(r) -> MemoryRow:
    return MemoryRow(agent_id=r["agent_id"], key=r["key"], value=r["value"], ts=r["ts"],
                     importance=r["importance"] if r["importance"] is not None else 0.5)


__all__ = ["MemoryStore", "MemoryRow", "tokenize"]
