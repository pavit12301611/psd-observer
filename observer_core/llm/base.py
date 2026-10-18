"""ModelProvider ABC and the shared HTTP retry/timeout policy.

Every provider must:
  (a) time out after 60 s,
  (b) retry transient network errors twice with exponential backoff,
  (c) surface clean error strings — never tracebacks — into the runtime log,
  (d) declare ``is_cloud`` so the GUI can show the red warning banner.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any, Callable

from ..models import ChatMessage, ModelSpec

DEFAULT_TIMEOUT_S = 60.0
RETRIES = 2                  # => up to 3 attempts total
BACKOFF_BASE_S = 0.5         # 0.5s, 1s, ...


class ProviderError(RuntimeError):
    """A provider failed in a way the user should read, not a bug to debug."""


class TransientError(ProviderError):
    """Network-level failure that is worth retrying."""


def with_retries(
    fn: Callable[[], Any],
    *,
    retries: int = RETRIES,
    base: float = BACKOFF_BASE_S,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """Call ``fn`` retrying only :class:`TransientError` with exponential backoff."""
    attempt = 0
    while True:
        try:
            return fn()
        except TransientError:
            if attempt >= retries:
                raise
            sleep(base * (2 ** attempt))
            attempt += 1


class ModelProvider(ABC):
    provider_name: str = "base"
    is_cloud: bool = False

    def __init__(self, spec: ModelSpec, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> None:
        self.spec = spec
        self.timeout_s = min(float(spec.timeout_s or timeout_s), 60.0) if spec.timeout_s else timeout_s
        self.last_latency_ms: int | None = None

    @property
    def endpoint(self) -> str:
        return (self.spec.endpoint or "").rstrip("/")

    @abstractmethod
    def health(self) -> tuple[bool, str]:
        """Cheap liveness probe. Must not run a generation."""

    def list_models(self) -> list[str]:
        return []

    @abstractmethod
    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        """Return the assistant text. Raise :class:`ProviderError` on failure."""

    def describe(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "endpoint": self.endpoint,
            "model": self.spec.model,
            "is_cloud": self.is_cloud,
            "supports_vision": self.spec.supports_vision,
            "latency_ms": self.last_latency_ms,
        }

    # helper for subclasses -------------------------------------------------
    def _timed(self, fn: Callable[[], Any]) -> Any:
        start = time.monotonic()
        try:
            return fn()
        finally:
            self.last_latency_ms = int((time.monotonic() - start) * 1000)


def image_b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


def sanitize_error(exc: BaseException, limit: int = 240) -> str:
    """One-line, secret-free description of an exception."""
    from ..logging_setup import redact

    text = f"{type(exc).__name__}: {exc}".replace("\n", " ")
    text = redact(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"
