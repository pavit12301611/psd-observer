"""Build the right :class:`ModelProvider` for an agent's :class:`ModelSpec`."""

from __future__ import annotations

from ..config import AppConfig
from ..models import ModelSpec
from .base import ModelProvider, ProviderError
from .cloud import CloudProvider
from .llamacpp_local import LlamaCppLocalProvider
from .ollama import OllamaProvider
from .openai_compat import OpenAICompatProvider

PROVIDERS = ("ollama", "openai_compat", "llamacpp_local", "cloud")


def make_provider(spec: ModelSpec, config: AppConfig | None = None) -> ModelProvider:
    allow_cloud = bool(config and config.privacy.allow_cloud_models)
    if spec.provider == "ollama":
        return OllamaProvider(spec)
    if spec.provider == "openai_compat":
        return OpenAICompatProvider(spec)
    if spec.provider == "llamacpp_local":
        return LlamaCppLocalProvider(spec)
    if spec.provider == "cloud":
        return CloudProvider(spec, allow_cloud=allow_cloud)
    raise ProviderError(f"unknown provider {spec.provider!r}; expected one of {PROVIDERS}")


def default_model_spec(config: AppConfig) -> ModelSpec:
    d = config.models
    if d.provider == "openai_compat":
        return ModelSpec(provider="openai_compat", endpoint=d.openai_endpoint, model=d.openai_model,
                         temperature=d.temperature, max_tokens=d.max_tokens,
                         context_window=d.context_window, supports_vision=d.supports_vision,
                         timeout_s=d.timeout_s)
    if d.provider == "cloud":
        return ModelSpec(provider="cloud", endpoint=d.cloud_endpoint, model=d.cloud_model,
                         api_key_env=d.openai_api_key_env, temperature=d.temperature,
                         max_tokens=d.max_tokens, context_window=d.context_window,
                         supports_vision=d.supports_vision, timeout_s=d.timeout_s)
    if d.provider == "llamacpp_local":
        return ModelSpec(provider="llamacpp_local", model=d.ollama_model, temperature=d.temperature,
                         max_tokens=d.max_tokens, context_window=d.context_window,
                         supports_vision=d.supports_vision, timeout_s=d.timeout_s)
    return ModelSpec(provider="ollama", endpoint=d.endpoint, model=d.ollama_model,
                     temperature=d.temperature, max_tokens=d.max_tokens,
                     context_window=d.context_window, supports_vision=d.supports_vision,
                     timeout_s=d.timeout_s)


__all__ = ["make_provider", "default_model_spec", "PROVIDERS"]
