"""Test doubles: a synthetic sensor and a scripted model. No hardware, no network."""

from __future__ import annotations

import time
from collections import deque

from observer_core.config import AppConfig
from observer_core.llm.base import ModelProvider, ProviderError
from observer_core.models import ChatMessage, ModelSpec, SensorKind, SensorPayload, SensorSpec
from observer_core.sensors.base import Sensor
from observer_core.util import synthesize_png


class FakeSensor(Sensor):
    """Returns a synthetic PNG (image kinds) or fixed text (text kinds).

    ``fail_with`` makes every capture degraded with that error; ``calls`` counts captures.
    """

    def __init__(self, kind: SensorKind = SensorKind.SCREEN, *, text: str = "fake text",
                 fail_with: str | None = None, config: AppConfig | None = None, width: int = 320, height: int = 180):
        spec = SensorSpec(kind=kind)
        super().__init__(spec, config or AppConfig())
        self.kind = kind
        self.text = text
        self.fail_with = fail_with
        self.width = width
        self.height = height
        self.calls = 0

    def available(self) -> tuple[bool, str]:
        return (False, "fake unavailable") if self.fail_with else (True, "fake ok")

    def _capture(self) -> SensorPayload:
        self.calls += 1
        if self.fail_with:
            return SensorPayload(kind=self.kind, degraded=True, error=self.fail_with)
        if self.kind.is_image:
            png = synthesize_png(self.width, self.height, text=f"fake {self.calls}")
            return SensorPayload(kind=self.kind, data=png, mime="image/png",
                                 meta={"width": self.width, "height": self.height},
                                 captured_at=time.time())
        return SensorPayload(kind=self.kind, data=self.text, mime="text/plain", captured_at=time.time())


class ScriptedModel(ModelProvider):
    """Returns queued responses in order; the last one repeats when the queue is empty.

    Items may be strings (returned) or exceptions (raised). Records every call.
    """

    provider_name = "scripted"

    def __init__(self, responses=None, *, is_cloud: bool = False, healthy: bool = True,
                 delay_s: float = 0.0, spec: ModelSpec | None = None):
        super().__init__(spec or ModelSpec(provider="ollama", model="scripted", endpoint="http://fake"))
        self.queue: deque = deque(responses or [])
        self.last: object = None
        self.is_cloud = is_cloud
        self.healthy = healthy
        self.delay_s = delay_s
        self.calls: list[list[ChatMessage]] = []

    def health(self) -> tuple[bool, str]:
        return (True, "scripted ok") if self.healthy else (False, "scripted down")

    def list_models(self) -> list[str]:
        return ["scripted"]

    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        self.calls.append(list(messages))
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.queue:
            self.last = self.queue.popleft()
        item = self.last
        if isinstance(item, BaseException):
            raise item
        if item is None:
            raise ProviderError("scripted model has no response queued")
        return str(item)
