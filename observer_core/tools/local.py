"""Local tools: desktop notifications, memory, clip recording, sandboxed Python."""

from __future__ import annotations

import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time

from .. import paths
from ..models import ToolKind, ToolResult
from ..util import run_subprocess
from .base import Tool


class DesktopNotifyTool(Tool):
    kind = ToolKind.DESKTOP_NOTIFY

    def validate(self):
        if not shutil.which("notify-send"):
            return False, "notify-send not found — sudo dnf install libnotify"
        return True, "ok"

    def invoke(self, args, context):
        title = str(args.get("title") or self.option("title") or context.agent_name or "Observer Core")[:120]
        body = str(args.get("text") or args.get("message") or "")[:500]
        urgency = str(self.option("urgency", "normal"))
        res = run_subprocess(["notify-send", "--app-name=Observer Core", f"--urgency={urgency}", title, body], timeout=10)
        if res.ok:
            return ToolResult.success("desktop notification shown")
        return ToolResult.failure(f"notify-send failed: {res.message}")

    def schema(self):
        return {"type": "object", "properties": {"text": {"type": "string"}, "title": {"type": "string"}}}


class MemoryTool(Tool):
    """Store / recall / list / forget memory for the calling agent."""

    kind = ToolKind.MEMORY

    def __init__(self, spec, config, memory=None) -> None:
        super().__init__(spec, config)
        self.memory = memory

    def validate(self):
        # Always available: the store is part of the app. Doctor runs without a DB handle.
        return True, "ok"

    def invoke(self, args, context):
        if self.memory is None:
            return ToolResult.failure("memory store not attached to this runtime")
        action = str(args.get("action", "store"))
        agent = context.agent_id
        if action == "store":
            key = str(args.get("key") or "").strip()
            if not key:
                return ToolResult.failure("memory.store needs 'key'")
            self.memory.store(agent, key, str(args.get("value", "")), float(args.get("importance", 0.5)))
            return ToolResult.success(f"stored {key}", key=key)
        if action == "forget":
            ok = self.memory.forget(agent, str(args.get("key", "")))
            return ToolResult.success("forgotten" if ok else "no such key", removed=ok)
        if action == "recall":
            rows = self.memory.recall(agent, str(args.get("query", "")), top_k=int(args.get("top_k", 5)))
            return ToolResult.success(f"{len(rows)} row(s)", rows=[r.__dict__ for r in rows])
        if action == "list":
            rows = self.memory.list(agent)
            return ToolResult.success(f"{len(rows)} row(s)", rows=[r.__dict__ for r in rows])
        return ToolResult.failure(f"unknown memory action {action!r}")

    def schema(self):
        return {
            "type": "object",
            "properties": {
                "action": {"enum": ["store", "recall", "list", "forget"]},
                "key": {"type": "string"},
                "value": {"type": "string"},
                "query": {"type": "string"},
            },
        }


class RecordClipTool(Tool):
    """Record a short clip of the screen (or a camera JPEG sequence) with ffmpeg."""

    kind = ToolKind.RECORD_CLIP

    def validate(self):
        ok, msg = (True, "ok") if shutil.which("ffmpeg") else (False, "ffmpeg not found — sudo dnf install ffmpeg")
        return ok, msg

    def invoke(self, args, context):
        seconds = max(1, min(60, int(args.get("seconds", self.option("seconds", 5)))))
        out_dir = paths.recordings_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"clip-{int(time.time())}-{context.agent_id[:24]}.mp4"
        source = str(self.option("source", "x11grab"))
        if source == "x11grab" and os.environ.get("DISPLAY"):
            argv = ["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab", "-t", str(seconds),
                    "-i", os.environ["DISPLAY"], "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(out)]
        else:
            return ToolResult.failure("no supported recording source: need X11 DISPLAY (Wayland portal recording is a documented limitation)")
        res = run_subprocess(argv, timeout=seconds + 30)
        if res.ok and out.exists():
            return ToolResult.success(f"clip saved to {out}", path=str(out))
        return ToolResult.failure(f"ffmpeg failed: {res.message}")

    def schema(self):
        return {"type": "object", "properties": {"seconds": {"type": "integer", "minimum": 1, "maximum": 60}}}


class RunPythonTool(Tool):
    """OFF by default. Runs a snippet in a restricted subprocess: no network, time & memory limits.

    Gate 1: ``ToolSpec.allow_python`` must be true for this agent.
    Gate 2: ``privacy.block_network_tools`` is ignored here — the snippet runs with
            no network namespace, so it cannot reach the network anyway (best-effort
            with ``unshare -rn`` when available; otherwise the snippet is stripped of
            socket imports by a static check and flagged in the result).
    """

    kind = ToolKind.RUN_PYTHON
    TIMEOUT_S = 10
    MEM_BYTES = 256 * 1024 * 1024
    FORBIDDEN = ("import socket", "from socket", "import subprocess", "os.system", "__import__", "urllib", "http.client", "requests", "httpx", "ctypes")

    def validate(self):
        if not self.spec.allow_python:
            return False, "run_python disabled for this agent (set allow_python: true to opt in)"
        return True, "ok"

    def invoke(self, args, context):
        code = str(args.get("code") or "")
        if not code.strip():
            return ToolResult.failure("run_python needs 'code'")
        if len(code) > 4000:
            return ToolResult.failure("code too long (max 4000 chars)")
        lowered = code.lower()
        for bad in self.FORBIDDEN:
            if bad in lowered:
                return ToolResult.failure(f"blocked construct: {bad!r}")
        unshare = shutil.which("unshare")
        argv = [sys.executable, "-I", "-S", "-c", code]
        if unshare:
            argv = [unshare, "-rn", *argv]

        def limits():  # pragma: no cover - runs in child
            resource.setrlimit(resource.RLIMIT_AS, (self.MEM_BYTES, self.MEM_BYTES))
            resource.setrlimit(resource.RLIMIT_CPU, (self.TIMEOUT_S, self.TIMEOUT_S))
            resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))

        with tempfile.TemporaryDirectory(prefix="oc-py-") as td:
            try:
                proc = subprocess.run(argv, cwd=td, capture_output=True, timeout=self.TIMEOUT_S,
                                      preexec_fn=limits, env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
            except subprocess.TimeoutExpired:
                return ToolResult.failure(f"run_python timed out after {self.TIMEOUT_S}s")
            except OSError as exc:
                return ToolResult.failure(f"run_python could not start: {exc}")
        out = proc.stdout.decode("utf-8", "replace")[:2000]
        err = proc.stderr.decode("utf-8", "replace")[:1000]
        return ToolResult(ok=proc.returncode == 0, detail=out or err or "(no output)",
                          payload={"exit_code": proc.returncode, "network_isolated": bool(unshare)})

    def schema(self):
        return {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}


__all__ = ["DesktopNotifyTool", "MemoryTool", "RecordClipTool", "RunPythonTool"]
