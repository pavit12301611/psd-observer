"""Robust parsing of model output into an :class:`ActionPlan`.

Local models are messy. Strategy, in order:

1. first *balanced* ``{...}`` object that is valid JSON (braces inside strings ignored);
2. a ```json fenced block;
3. loose form: ``triggered: true`` plus ``tool: name`` pairs;
4. prose: ``trigger_phrase`` substring match only (never applied to JSON, so a
   model that writes ``"triggered": false, "reason": "...phrase..."`` is not a false positive);
5. nothing -> not triggered, with a warning.

Parsing never raises. Unknown tool names are kept in the plan; the runtime
ignores them with a log line.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..models import ActionPlan, MemoryWrite, PlannedAction

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(\{.*?\})\s*```", re.DOTALL)
_TRIGGERED_RE = re.compile(r"triggered\W{0,3}\s*[:=]\s*(true|false|yes|no)\b", re.IGNORECASE)
_TOOL_RE = re.compile(r"\btool\W{0,3}\s*[:=]\s*[\"']?([A-Za-z_][A-Za-z0-9_\-]*)", re.IGNORECASE)


def iter_balanced_objects(text: str):
    """Yield every top-level balanced ``{...}`` substring, ignoring braces inside strings."""
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                yield text[start : i + 1]
                start = -1


def _coerce_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1", "y")
    return False


def _plan_from_dict(obj: dict, raw: str, mode: str) -> ActionPlan:
    actions: list[PlannedAction] = []
    warnings: list[str] = []
    for a in obj.get("actions") or []:
        if isinstance(a, str):
            actions.append(PlannedAction(tool=a, args={}))
            continue
        if not isinstance(a, dict):
            warnings.append(f"ignored non-object action: {str(a)[:60]}")
            continue
        name = a.get("tool") or a.get("action") or a.get("name")
        if not name:
            warnings.append("action without a 'tool' field ignored")
            continue
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        actions.append(PlannedAction(tool=str(name), args=args))

    memory: list[MemoryWrite] = []
    for m in obj.get("memory") or []:
        if isinstance(m, dict) and m.get("key"):
            memory.append(MemoryWrite(key=str(m["key"]), value=str(m.get("value", "")),
                                      importance=float(m.get("importance", 0.5) or 0.5)))
        else:
            warnings.append("memory entry without key ignored")

    conf = obj.get("confidence")
    try:
        conf_f = float(conf) if conf is not None else None
    except (TypeError, ValueError):
        conf_f = None

    triggered = _coerce_bool(obj.get("triggered", False))
    if actions and "triggered" not in obj:
        triggered = True  # actions without an explicit flag still count as a trigger
    return ActionPlan(
        triggered=triggered,
        reason=str(obj.get("reason", ""))[:500],
        actions=actions,
        memory=memory,
        confidence=conf_f,
        parse_mode=mode,
        raw=raw,
        warnings=warnings,
    )


def parse_response(text: str, trigger_phrase: str | None = None) -> ActionPlan:
    raw = text or ""

    # 1. first balanced object that parses as JSON
    for candidate in iter_balanced_objects(raw):
        try:
            obj = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(obj, dict):
            return _plan_from_dict(obj, raw, "json")

    # 2. fenced ```json block (may contain pretty-printed JSON with comments removed)
    for m in _FENCE_RE.finditer(raw):
        try:
            obj = json.loads(m.group(1))
        except ValueError:
            continue
        if isinstance(obj, dict):
            return _plan_from_dict(obj, raw, "fenced")

    # 3. loose key/value form
    tm = _TRIGGERED_RE.search(raw)
    if tm:
        triggered = _coerce_bool(tm.group(1))
        tools = [t for t in _TOOL_RE.findall(raw)]
        actions = [PlannedAction(tool=t, args={}) for t in tools] if triggered else []
        return ActionPlan(triggered=triggered, actions=actions, parse_mode="loose", raw=raw,
                          warnings=["response was not valid JSON; parsed loosely"])

    # 4. prose: phrase matching only
    if trigger_phrase:
        if trigger_phrase.lower() in raw.lower():
            return ActionPlan(triggered=True, reason="trigger phrase matched in prose", parse_mode="phrase", raw=raw,
                              warnings=["response was not JSON; trigger phrase matched"])
        return ActionPlan(triggered=False, parse_mode="phrase", raw=raw,
                          warnings=["response was not JSON; trigger phrase not found"])

    # 5. nothing usable
    return ActionPlan(triggered=False, parse_mode="none", raw=raw,
                      warnings=["could not parse any JSON from the model response"])


__all__ = ["parse_response", "iter_balanced_objects"]
