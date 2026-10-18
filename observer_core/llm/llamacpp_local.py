"""In-process llama.cpp via ``llama-cpp-python`` (optional extra).

Requires a GGUF model path in ``model.model`` (or ``extra.model_path``) and, for
vision, an ``extra.mmproj`` projector path. The module imports lazily so the
rest of the app works without the (large, compiled) dependency.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from ..models import ChatMessage, ModelSpec
from .base import ModelProvider, ProviderError, sanitize_error

_LLAMA_CACHE: dict[str, Any] = {}


def llama_cpp_available() -> tuple[bool, str]:
    try:
        import llama_cpp  # noqa: F401

        return True, f"llama-cpp-python {getattr(llama_cpp, '__version__', '?')}"
    except Exception as exc:
        return False, f"llama-cpp-python not installed ({sanitize_error(exc)}); pip install llama-cpp-python"


class LlamaCppLocalProvider(ModelProvider):
    provider_name = "llamacpp_local"
    is_cloud = False

    def __init__(self, spec: ModelSpec) -> None:
        super().__init__(spec)
        self.model_path = str(spec.extra.get("model_path") or spec.model)
        self.mmproj = spec.extra.get("mmproj")

    def health(self) -> tuple[bool, str]:
        ok, reason = llama_cpp_available()
        if not ok:
            return False, reason
        if not Path(self.model_path).expanduser().exists():
            return False, f"GGUF model not found at {self.model_path}"
        return True, f"GGUF {Path(self.model_path).name}"

    def _load(self):
        key = f"{self.model_path}|{self.mmproj}"
        if key in _LLAMA_CACHE:
            return _LLAMA_CACHE[key]
        from llama_cpp import Llama  # type: ignore

        kwargs: dict[str, Any] = {
            "model_path": str(Path(self.model_path).expanduser()),
            "n_ctx": self.spec.context_window,
            "verbose": False,
        }
        if self.mmproj:
            from llama_cpp import llama_chat_format  # type: ignore

            handler_cls = getattr(llama_chat_format, "Llava15ChatHandler", None)
            if handler_cls is not None:
                kwargs["chat_handler"] = handler_cls(clip_model_path=str(self.mmproj), verbose=False)
        llm = Llama(**kwargs)
        _LLAMA_CACHE[key] = llm
        return llm

    def chat(self, messages: list[ChatMessage], tools: list[dict] | None = None) -> str:
        ok, reason = llama_cpp_available()
        if not ok:
            raise ProviderError(reason)
        try:
            llm = self._load()
            msgs: list[dict] = []
            for m in messages:
                if m.images:
                    content: list[dict] = [{"type": "text", "text": m.content}]
                    for img in m.images:
                        b = base64.b64encode(img).decode("ascii")
                        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}})
                    msgs.append({"role": m.role, "content": content})
                else:
                    msgs.append({"role": m.role, "content": m.content})
            out = self._timed(lambda: llm.create_chat_completion(
                messages=msgs,
                temperature=self.spec.temperature,
                max_tokens=self.spec.max_tokens,
            ))
            return str(out["choices"][0]["message"]["content"] or "")
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(f"llama.cpp failed: {sanitize_error(exc)}") from exc


__all__ = ["LlamaCppLocalProvider", "llama_cpp_available"]
