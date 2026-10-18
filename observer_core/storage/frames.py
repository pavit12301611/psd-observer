"""Frame ring buffer: optional, local, capped by file count AND total megabytes.

Only written when ``privacy.persist_frames`` is true. Oldest frames are evicted
first (LRU by write time). Rows are tracked in the ``frames`` table so eviction
works even after a restart.
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

from .db import Database


class FrameRingBuffer:
    def __init__(self, db: Database, directory: Path, *, max_files: int = 2000, max_mb: float = 500.0,
                 enabled: bool = False) -> None:
        self.db = db
        self.dir = Path(directory)
        self.max_files = int(max_files)
        self.max_bytes = int(max_mb * 1024 * 1024)
        self.enabled = enabled

    def write(self, agent_id: str, kind: str, data: bytes, ext: str = "png") -> Path | None:
        if not self.enabled or not data:
            return None
        self.dir.mkdir(parents=True, exist_ok=True)
        ts = time.time()
        # uuid suffix: two frames in the same millisecond must never overwrite each other
        name = f"{int(ts * 1000)}-{agent_id[:24]}-{kind}-{uuid.uuid4().hex[:8]}.{ext}"
        path = self.dir / name
        path.write_bytes(data)
        try:
            os.chmod(path, 0o600)
        except OSError:  # pragma: no cover
            pass
        self.db.execute(
            "INSERT INTO frames(ts, agent_id, kind, path) VALUES (?,?,?,?)",
            (ts, agent_id, kind, str(path)),
        )
        self.evict()
        return path

    def _total_bytes(self) -> int:
        total = 0
        for row in self.db.query("SELECT path FROM frames"):
            try:
                total += os.path.getsize(row["path"])
            except OSError:
                pass
        return total

    def count(self) -> int:
        return int(self.db.query("SELECT COUNT(*) AS n FROM frames")[0]["n"])

    def evict(self) -> int:
        """Drop oldest frames until both caps are satisfied. Returns number removed."""
        removed = 0
        while True:
            n = self.count()
            if n == 0:
                break
            over_count = n > self.max_files
            over_bytes = self._total_bytes() > self.max_bytes
            if not (over_count or over_bytes):
                break
            oldest = self.db.query("SELECT id, path FROM frames ORDER BY ts ASC, id ASC LIMIT 1")
            if not oldest:
                break
            row = oldest[0]
            try:
                Path(row["path"]).unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
            self.db.execute("DELETE FROM frames WHERE id = ?", (row["id"],))
            removed += 1
        return removed

    def wipe(self) -> int:
        """Delete every persisted frame (privacy: 'wipe captured data')."""
        n = 0
        for row in self.db.query("SELECT path FROM frames"):
            try:
                Path(row["path"]).unlink()
                n += 1
            except OSError:
                pass
        self.db.execute("DELETE FROM frames")
        return n


__all__ = ["FrameRingBuffer"]
