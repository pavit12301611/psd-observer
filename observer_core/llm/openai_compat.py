"""OpenAI-compatible provider: llama.cpp llama-server, vLLM, LM Studio, text-generation-webui.

Also used for the ``cloud`` provider (see :mod:`observer_core.llm.cloud`), which
differs only in ``is_cloud`` and in how the API key is supplied.
"""

from __future__ import annotations

import os

import httpx

from ..models import ChatMessage, ModelSpec
from .base import ModelProvider, ProviderError, TransientError, image_b64, sanitize_error, with_retries

DEFAULT_ENDPOINT = "http://127.0.0.1:8080/v1"


class OpenAICompatProvider(ModelProvider):
    provider_name = "openai_compat"
    is_cloud = False

    def __init__(self, spec: ModelSpec, *, api_key: str | None = None, client: httpx.Client | None = None) -> None:
        if not spec.endpoint:
            spec = spec.model_copy(update={"endpoint": DEFAULT_ENDPOINT})
        super().__init__(spec)
        self._api_key = api_key if api_key is not None else self._key_from_env()
        self._client = client or httpx.Client(timeout=self.timeout_s)

    def _key_from_env(self) -> str:
        if self.spec.api_key_env:
            return os.environ.get(self.spec.api_key_env, "")
        return ""

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    @property
    def base(self) -> str:
        return self.endpoint

    def health(self) -> tuple[bool, str]:
        try:
            r = self._client.get(f"{self.base}/models", headers=self._headers(), timeout=5.0)
            if r.status_code in (401, 403):
                return False, f"{self.base} rejected credentials (HTTP {r.status_code})"
            r.raise_for_status()
            return True, f"OpenAI-compatible server at {self.base}"
        except Exception as exc:
            return False, f"not reachable at {self.base}: {sanitize_error(exc)}"

    def list_models(self) -> list[str]:
        try:
            r = self._client.get(f"{self.base}/models", headers=self._headers(), timeout=5.0)
            r.raise_for_status()
            return [m.get("id", "") for m in r.json().get("data", []) if m.get("id")]
        except Exception:
            return []

    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        body = {
            "model": self.spec.model,
            "messages": [_to_openai(m) for m in messages],
            "temperature": self.spec.temperature,
            "max_tokens": self.spec.max_tokens,
            "stream": False,
        }
        if tools:
            body["tools"] = tools

        def do() -> str:
            try:
                r = self._timed(lambda: self._client.post(
                    f"{self.base}/chat/completions", json=body, headers=self._headers(), timeout=self.timeout_s))
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                raise TransientError(f"{self.provider_name} transport error: {sanitize_error(exc)}") from exc
            if r.status_code in (429,) or r.status_code >= 500:
                raise TransientError(f"HTTP {r.status_code} from {self.base}: {r.text[:200]}")
            if r.status_code >= 400:
                raise ProviderError(f"HTTP {r.status_code} from {self.base}: {r.text[:200]}")
            try:
                return str(r.json()["choices"][0]["message"]["content"] or "")
            except Exception as exc:
                raise ProviderError(f"unexpected completion payload: {sanitize_error(exc)}") from exc

        return with_retries(do)


def _to_openai(m: ChatMessage) -> dict:
    if not m.images:
        return {"role": m.role, "content": m.content}
    parts: list[dict] = [{"type": "text", "text": m.content}]
    for img in m.images:
        mime = "image/png" if img[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64(img)}"}})
    return {"role": m.role, "content": parts}


__all__ = ["OpenAICompatProvider", "DEFAULT_ENDPOINT"]
