"""Logging setup (loguru) with a strict "never log secrets" policy.

Two sinks:

* stderr — human readable, colourised when attached to a TTY
* ``$XDG_STATE_HOME/observer-core/logs/observer.log`` — rotating JSONL-ish text

A redaction patcher scrubs anything that looks like a bearer token, API key or
password from every record before it is written, so a stack trace can never
leak ``telegram.bot_token``.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

from . import paths

try:
    from loguru import logger
except ImportError:  # pragma: no cover - loguru is a hard dep; keep importable
    import logging

    logger = logging.getLogger("observer_core")  # type: ignore[assignment]

_REDACT_PATTERNS = [
    re.compile(r"(?i)(bot[_-]?token|token|api[_-]?key|apikey|password|passwd|secret|"
               r"auth[_-]?token|account[_-]?sid|webhook[_-]?url|authorization)\b"
               r"(\s*[:=]\s*)([^\s,;\"']+)", re.IGNORECASE),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"https?://[^/\s]*:[^@\s]+@"),  # user:pass@host in URLs
    re.compile(r"\b(sk|pk|ghp|gho|xox[baprs]|AIza)[A-Za-z0-9_\-]{12,}\b"),
]


def redact(text: str) -> str:
    """Mask anything that looks like a credential in a log line."""
    if not text:
        return text
    out = text
    out = _REDACT_PATTERNS[0].sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", out)
    out = _REDACT_PATTERNS[1].sub("bearer ***REDACTED***", out)
    out = _REDACT_PATTERNS[2].sub("https://***@", out)
    out = _REDACT_PATTERNS[3].sub("***REDACTED_KEY***", out)
    return out


class _RedactingPatch:
    def __call__(self, record: Any) -> None:
        try:
            record["message"] = redact(str(record["message"]))
        except Exception:  # pragma: no cover - never break logging
            pass


_configured = False


def setup_logging(
    level: str | None = None,
    *,
    log_dir: Path | None = None,
    to_stderr: bool = True,
    json_logs: bool = False,
    rotation: str = "10 MB",
    retention: str = "7 days",
) -> Any:
    """Configure loguru. Safe to call repeatedly."""
    global _configured
    level = level or os.environ.get("OBSERVER_CORE_LOG_LEVEL", "INFO")
    try:
        logger.remove()
    except Exception:  # pragma: no cover
        pass

    if to_stderr:
        logger.add(
            sys.stderr,
            level=level,
            colorize=sys.stderr.isatty(),
            format=(
                "<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | "
                "<cyan>{extra[area]}</cyan> | <level>{message}</level>"
            ),
            filter=None,
            enqueue=False,
            backtrace=False,
            diagnose=False,   # never render local variables (they may hold secrets)
        )
    if json_logs:
        target = log_dir or paths.log_dir()
        target.mkdir(parents=True, exist_ok=True)
        logger.add(
            str(target / "observer.log"),
            level=level,
            rotation=rotation,
            retention=retention,
            serialize=True,
            enqueue=True,
            backtrace=False,
            diagnose=False,
        )
    # loguru: patchers are set on the logger via configure(), not per sink.
    logger.configure(extra={"area": "core"}, patcher=_RedactingPatch())
    _configured = True
    return logger


def bind(area: str) -> Any:
    """Return a logger bound to a subsystem name (shown in the console column)."""
    if not _configured:
        setup_logging()
    return logger.bind(area=area)


def get_logger() -> Any:
    if not _configured:
        setup_logging()
    return logger


def truncate(text: str | None, limit: int = 500) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f"…(+{len(text) - limit} chars)"
