"""Prompt assembly: ``$TOKEN`` substitution, memory block, cycle metadata.

Rules (from the spec):
* ``$SCREEN`` / ``$CAMERA``  -> image attached as a multimodal part; the token is
  replaced by ``[image attached: screen capture WxH]``.
* text tokens (``$SCREEN_OCR``, ``$CLIPBOARD``, ``$MICROPHONE``, ``$SCREEN_AUDIO``,
  ``$ALL_AUDIO``) -> replaced by a fenced text block.
* A known token whose sensor produced nothing -> ``[sensor unavailable: ...]``
  plus a warning.
* An *unknown* ``$TOKEN`` -> left literal and a warning is appended to the cycle
  log. Nothing is silently dropped.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from ..models import SENSOR_TOKENS, ChatMessage, SensorKind, SensorPayload

CONTRACT = """\
RESPONSE CONTRACT — reply with ONLY one JSON object, no prose before or after:
{{"triggered": bool, "reason": str, "actions": [{{"tool": str, "args": {{}}}}],
 "memory": [{{"key": str, "value": str}}], "confidence": float}}
- "triggered" is true only when the condition in your instructions is met.
- "actions" may be empty. Allowed tool names: {tools}.
- If nothing should happen, reply exactly: {{"triggered": false}}
"""

_TOKEN_RE = re.compile(r"\$[A-Z][A-Z_]{2,}")
_TEXT_KINDS = {k for k in SensorKind if not k.is_image}
_KNOWN_TOKENS = set(SENSOR_TOKENS.values())


@dataclass
class RenderedPrompt:
    user_text: str
    images: list[bytes] = field(default_factory=list)
    used_tokens: list[str] = field(default_factory=list)
    unknown_tokens: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def image_caption(payload: SensorPayload) -> str:
    kind = "screen capture" if payload.kind == SensorKind.SCREEN else "camera frame"
    w = payload.meta.get("width")
    h = payload.meta.get("height")
    size = f"{w}x{h}" if w and h else "unknown size"
    return f"[image attached: {kind} {size}]"


def fence(text: str, label: str) -> str:
    safe = text.replace("```", "'''")
    return f"```{label}\n{safe}\n```"


def render_prompt(
    template: str,
    payloads: dict[SensorKind, SensorPayload | None],
    *,
    agent_name: str,
    cycle_index: int,
    now: float | None = None,
    memories: list | None = None,
    supports_vision: bool = True,
    enabled_kinds: list[SensorKind] | None = None,
) -> RenderedPrompt:
    """Substitute tokens in ``template`` and assemble the user message.

    ``payloads`` maps each enabled kind to its payload (or None if not captured).
    """
    now = now or time.time()
    out = RenderedPrompt(user_text="")
    images: list[bytes] = []

    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        if token not in _KNOWN_TOKENS:
            out.unknown_tokens.append(token)
            out.warnings.append(f"unknown token {token} left literal (not substituted)")
            return token
        kind = next(k for k, v in SENSOR_TOKENS.items() if v == token)
        out.used_tokens.append(token)
        if enabled_kinds is not None and kind not in enabled_kinds:
            out.warnings.append(f"{token} used but sensor '{kind.value}' is not enabled for this agent")
            return f"[sensor not enabled: {kind.value}]"
        payload = payloads.get(kind)
        if payload is None:
            out.warnings.append(f"{token} has no payload this cycle")
            return f"[sensor unavailable: {kind.value}]"
        if payload.error and not payload.is_image and not payload.text:
            out.warnings.append(f"{token} degraded: {payload.error}")
            return f"[sensor unavailable: {kind.value} — {payload.error}]"
        if kind.is_image:
            if not payload.is_image:
                out.warnings.append(f"{token} degraded: {payload.error or 'no image'}")
                return f"[sensor unavailable: {kind.value} — {payload.error or 'no image'}]"
            if supports_vision:
                images.append(bytes(payload.data))  # type: ignore[arg-type]
                return image_caption(payload)
            out.warnings.append(f"{token}: model does not support vision; image omitted")
            return f"[image omitted: model is not vision-capable; {kind.value} captured]"
        text = payload.text or ""
        if payload.error:
            out.warnings.append(f"{token} partial: {payload.error}")
        return "\n" + fence(text, "text") + "\n"

    body = _TOKEN_RE.sub(repl, template or "")

    header = [
        f"Agent: {agent_name}",
        f"Cycle: #{cycle_index}",
        f"Cycle time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))} (local)",
    ]
    if memories:
        header.append("Relevant memory:")
        header.extend(m.as_line() if hasattr(m, "as_line") else f"- {m}" for m in memories)
    user_text = "\n".join(header) + "\n\n" + body.strip()

    out.user_text = user_text
    out.images = images
    return out


def build_messages(system_prompt: str, tools: list[str], rendered: RenderedPrompt) -> list[ChatMessage]:
    contract = CONTRACT.format(tools=", ".join(tools) if tools else "(none — return triggered only)")
    instructions = (system_prompt or "You are a careful monitoring agent.").strip()
    # $TOKENs inside the instructions are rendered in the user message; keep the
    # system text readable by pointing at the observations instead.
    instructions = _TOKEN_RE.sub("(see observations)", instructions)
    system = instructions + "\n\n" + contract
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=rendered.user_text, images=list(rendered.images)),
    ]


def text_kinds() -> set[SensorKind]:
    return set(_TEXT_KINDS)


__all__ = ["render_prompt", "build_messages", "RenderedPrompt", "CONTRACT", "fence", "image_caption"]
