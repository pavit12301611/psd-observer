#!/usr/bin/env python3
"""Needle 3 classifier adapter for the Observer agent.

Reads one JSON object on stdin, writes one JSON object on stdout:

    in : {"text": "...", "tools": [{"name": "tier_tiny", ...}, ...]}
    out: {"ok": true, "calls": [{"name": "tier_light"}], "confidence": 0.82}

The Node side (src/needle.js) owns the schema, the timeout, and every failure
mode; this file only bridges to the `cactus-needle` package. It is intentionally
thin so that a different install — a manual engine build, a different model
slice — only needs this one file adjusted.

Exit codes are not load-bearing: the Node side treats any non-zero exit as "no
answer" and falls back to the keyword router.

Accuracy, stated plainly: the shipped Needle 3 weights score ~27% on Cactus's
held-out tool-calling eval and ~84% after LoRA fine-tuning on that task. Until
this has been fine-tuned on the agent's own command traffic, treat its answer
as a hint, which is exactly how the router uses it.
"""

import json
import sys


def _load():
    """Import the needle package lazily so a missing install fails cleanly."""
    try:
        import needle  # type: ignore
        return needle
    except Exception:
        return None


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except Exception:
        print(json.dumps({"ok": False, "error": "request was not JSON"}))
        return 0

    text = str(request.get("text") or "").strip()
    tools = request.get("tools") or []
    if not text:
        print(json.dumps({"ok": False, "error": "no text"}))
        return 0

    needle = _load()
    if needle is None:
        # Not installed. The Node side treats this as "no second opinion".
        print(json.dumps({"ok": False, "error": "cactus-needle is not installed"}))
        return 0

    try:
        result = needle.run(text, tools=tools)  # type: ignore[attr-defined]
    except AttributeError:
        try:
            result = needle.classify(text, tools=tools)  # type: ignore[attr-defined]
        except Exception as error:  # pragma: no cover - depends on the install
            print(json.dumps({"ok": False, "error": str(error)[:300]}))
            return 0
    except Exception as error:  # pragma: no cover - depends on the install
        print(json.dumps({"ok": False, "error": str(error)[:300]}))
        return 0

    calls = []
    confidence = None
    if isinstance(result, dict):
        confidence = result.get("confidence")
        for call in result.get("function_calls") or result.get("calls") or []:
            if isinstance(call, dict):
                calls.append({"name": call.get("name")})
            elif isinstance(call, str):
                calls.append({"name": call})

    print(json.dumps({"ok": True, "calls": calls, "confidence": confidence}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
