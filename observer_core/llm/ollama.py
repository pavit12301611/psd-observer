"""Ollama provider (default, recommended). Talks to http://127.0.0.1:11434."""

from __future__ import annotations

import httpx

from ..models import ChatMessage, ModelSpec
from .base import ModelProvider, ProviderError, TransientError, image_b64, sanitize_error, with_retries

DEFAULT_ENDPOINT = "http://127.0.0.1:11434"


class OllamaProvider(ModelProvider):
    provider_name = "ollama"
    is_cloud = False

    def __init__(self, spec: ModelSpec, *, client: httpx.Client | None = None) -> None:
        if not spec.endpoint:
            spec = spec.model_copy(update={"endpoint": DEFAULT_ENDPOINT})
        super().__init__(spec)
        self._client = client or httpx.Client(timeout=self.timeout_s)

    def health(self) -> tuple[bool, str]:
        try:
            r = self._client.get(f"{self.endpoint}/api/version", timeout=5.0)
            r.raise_for_status()
            return True, f"ollama {r.json().get('version', '?')} at {self.endpoint}"
        except Exception as exc:
            return False, f"ollama not reachable at {self.endpoint}: {sanitize_error(exc)} — start it with `ollama serve`"

    def list_models(self) -> list[str]:
        try:
            r = self._client.get(f"{self.endpoint}/api/tags", timeout=5.0)
            r.raise_for_status()
            return [m.get("name", "") for m in r.json().get("models", []) if m.get("name")]
        except Exception:
            return []

    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        body = {
            "model": self.spec.model,
            "stream": False,
            "options": {
                "temperature": self.spec.temperature,
                "num_predict": self.spec.max_tokens,
                "num_ctx": self.spec.context_window,
            },
            "messages": [_to_ollama(m) for m in messages],
        }

        def do() -> str:
            try:
                r = self._timed(lambda: self._client.post(f"{self.endpoint}/api/chat", json=body, timeout=self.timeout_s))
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                raise TransientError(f"ollama transport error: {sanitize_error(exc)}") from exc
            if r.status_code >= 500:
                raise TransientError(f"ollama HTTP {r.status_code}: {r.text[:200]}")
            if r.status_code >= 400:
                raise ProviderError(f"ollama HTTP {r.status_code}: {r.text[:200]} (is the model pulled? `ollama pull {self.spec.model}`)")
            try:
                return str(r.json()["message"]["content"])
            except Exception as exc:
                raise ProviderError(f"unexpected ollama response: {sanitize_error(exc)}") from exc

        return with_retries(do)


def _to_ollama(m: ChatMessage) -> dict:
    out: dict = {"role": m.role, "content": m.content}
    if m.images:
        out["images"] = [image_b64(img) for img in m.images]
    return out


__all__ = ["OllamaProvider", "DEFAULT_ENDPOINT"]
