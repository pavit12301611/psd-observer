"""Cloud provider — OpenRouter / Gemini-compatible / OpenAI — OPT-IN ONLY.

Guards:
* refuses to construct a request unless ``privacy.allow_cloud_models`` is true
  (checked by the factory and again here, defence in depth);
* the API key is read from the environment variable named in
  ``model.api_key_env`` — never from the agent file;
* ``is_cloud = True`` so the GUI shows the red banner.
"""

from __future__ import annotations

import os

from ..models import ChatMessage, ModelSpec
from .base import ModelProvider, ProviderError
from .openai_compat import OpenAICompatProvider


class CloudDisabledError(ProviderError):
    pass


class CloudProvider(ModelProvider):
    provider_name = "cloud"
    is_cloud = True

    def __init__(self, spec: ModelSpec, *, allow_cloud: bool, api_key: str | None = None) -> None:
        super().__init__(spec)
        if not allow_cloud:
            raise CloudDisabledError(
                "cloud models are disabled (privacy.allow_cloud_models = false). "
                "Enable them in Settings → Privacy if you really want data to leave this machine."
            )
        key = api_key if api_key is not None else os.environ.get(spec.api_key_env or "", "")
        if not key:
            raise ProviderError(f"cloud API key missing: set environment variable {spec.api_key_env or '(api_key_env)'}")
        self._inner = OpenAICompatProvider(spec, api_key=key)

    def health(self) -> tuple[bool, str]:
        ok, detail = self._inner.health()
        return ok, f"CLOUD — {detail}"

    def list_models(self) -> list[str]:
        return self._inner.list_models()

    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        return self._inner.chat(messages, tools)


__all__ = ["CloudProvider", "CloudDisabledError"]
