"""Pluggable model providers: ollama, openai_compat, llamacpp_local, cloud."""

from .base import ModelProvider, ProviderError, TransientError  # noqa: F401
from .factory import PROVIDERS, default_model_spec, make_provider  # noqa: F401

__all__ = ["ModelProvider", "ProviderError", "TransientError", "PROVIDERS", "make_provider", "default_model_spec"]
