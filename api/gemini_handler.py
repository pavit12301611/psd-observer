#!/usr/bin/env python3
import os
import json
import logging
import httpx
from fastapi.responses import StreamingResponse

from api_handlers import BaseAPIHandler, ConfigError, BackendAPIError, HandlerError, get_http_client

logger = logging.getLogger("gemini_handler")

GEMINI_OPENAI_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"


class GeminiAPIHandler(BaseAPIHandler):
    """Thin proxy to Google's OpenAI-compatible Gemini endpoint."""

    def __init__(self):
        super().__init__("gemini")

        self.model_map = {
            # Hidden model for agent creator (free users)
            "gemini-2.0-flash-lite-free": {
                "model_id": "gemini-flash-lite-latest",
                "parameters": "N/A",
                "multimodal": True,
                "pro": False,
            },
            # Hidden model for agent creator (pro users)
            "gemini-2.5-flash-lite-free": {
                "model_id": "gemini-flash-lite-latest",
                "parameters": "N/A",
                "multimodal": True,
                "pro": False,
            },
        }

        self.models = [
            {
                "name": display_name,
                "parameters": info.get("parameters", "N/A"),
                "multimodal": info.get("multimodal", False),
                "pro": info.get("pro", False),
            }
            for display_name, info in self.model_map.items()
        ]

        self.api_key = os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            logger.error("GEMINI_API_KEY environment variable not set.")

        logger.info("GeminiAPIHandler registered models: %s", [m["name"] for m in self.models])

    def _headers(self):
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "ObserverAI-FastAPI-Client/1.0",
        }

    def _build_payload(self, request_data: dict, target_model: str) -> dict:
        payload = dict(request_data)
        payload["model"] = target_model
        return payload

    async def handle_request(self, request_data: dict):
        if not self.api_key:
            raise ConfigError("GEMINI_API_KEY is not configured on the server.")

        model_name = request_data.get("model")
        if not model_name:
            raise ValueError("Request data must include a 'model' field.")

        target_model = self.model_map.get(model_name, {}).get("model_id", model_name)
        payload = self._build_payload(request_data, target_model)

        if request_data.get("stream", False):
            return StreamingResponse(
                self._stream_response(payload),
                media_type="text/event-stream",
            )

        try:
            client = get_http_client()
            response = await client.post(GEMINI_OPENAI_COMPAT_URL, headers=self._headers(), json=payload)
            response.raise_for_status()
            data = response.json()
            for choice in data.get("choices", []):
                msg = choice.get("message", {})
                if "reasoning_content" in msg:
                    msg["reasoning"] = msg.pop("reasoning_content")
            return data
        except httpx.RequestError as exc:
            logger.error("Gemini API request failed: %s", exc)
            raise BackendAPIError(f"Could not connect to Gemini API: {exc}", status_code=503) from exc
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            try:
                message = exc.response.json().get("error", {}).get("message", exc.response.text)
            except Exception:
                message = exc.response.text
            logger.error("Gemini API error %s: %s", status_code, message[:500])
            raise BackendAPIError(f"Gemini API Error ({status_code}): {message}", status_code=status_code) from exc
        except Exception as exc:
            logger.exception("Unexpected error during Gemini API call for model %s", target_model)
            raise HandlerError(f"Unexpected error processing Gemini request: {exc}") from exc

    async def _stream_response(self, payload: dict):
        try:
            client = get_http_client()
            async with client.stream("POST", GEMINI_OPENAI_COMPAT_URL, headers=self._headers(), json=payload) as response:
                if response.status_code >= 400:
                    # Read error body while still inside the context manager (stream open).
                    try:
                        body = await response.aread()
                        detail = body.decode("utf-8", "replace")
                    except Exception:
                        detail = "<no body>"
                    logger.error("Gemini streaming API error %s: %s", response.status_code, detail[:1000])
                    yield f"data: {json.dumps({'error': f'API error ({response.status_code}): {detail[:500]}'})}\n\n"
                    return
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            chunk = json.loads(line[6:])
                            for choice in chunk.get("choices", []):
                                delta = choice.get("delta", {})
                                # compat endpoint signals thought chunks via extra_content.google.thought
                                is_thought = delta.get("extra_content", {}).get("google", {}).get("thought", False)
                                if is_thought and "content" in delta:
                                    text = delta.pop("content").strip("<thought>").strip("</thought>")
                                    delta["reasoning"] = text
                                    delta.pop("extra_content", None)
                                # also handle reasoning_content field (future-proofing)
                                elif "reasoning_content" in delta:
                                    delta["reasoning"] = delta.pop("reasoning_content")
                            yield f"data: {json.dumps(chunk)}\n\n"
                            continue
                        except (json.JSONDecodeError, KeyError):
                            pass
                    yield line + "\n\n"
        except httpx.RequestError as exc:
            logger.error("Gemini streaming request failed: %s", exc)
            yield f"data: {json.dumps({'error': f'Connection error: {exc}'})}\n\n"
        except Exception as exc:
            logger.exception("Unexpected error in Gemini streaming")
            yield f"data: {json.dumps({'error': f'Unexpected error: {exc}'})}\n\n"
