"""Provider wire formats via httpx.MockTransport: images, retries, errors, cloud opt-in."""

import json

import httpx
import pytest

from observer_core.llm import base as llm_base
from observer_core.llm.base import ProviderError
from observer_core.llm.cloud import CloudDisabledError, CloudProvider
from observer_core.llm.factory import make_provider
from observer_core.llm.ollama import OllamaProvider
from observer_core.llm.openai_compat import OpenAICompatProvider
from observer_core.models import ChatMessage, ModelSpec
from observer_core.util import synthesize_png

PNG = synthesize_png(64, 32)


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), timeout=5)


def _no_sleep(monkeypatch):
    monkeypatch.setattr(llm_base, "BACKOFF_BASE_S", 0.0)


def test_ollama_sends_base64_images_and_options():
    seen = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "{\"triggered\": false}"}})

    spec = ModelSpec(provider="ollama", endpoint="http://ollama.test", model="qwen2.5vl:7b", supports_vision=True)
    prov = OllamaProvider(spec, client=_client(handler))
    out = prov.chat([ChatMessage(role="system", content="sys"),
                     ChatMessage(role="user", content="look", images=[PNG])])
    assert out == '{"triggered": false}'
    body = seen["body"]
    assert body["model"] == "qwen2.5vl:7b" and body["stream"] is False
    assert body["messages"][1]["images"][0].startswith("iVBOR")       # base64 PNG
    assert body["options"]["temperature"] == pytest.approx(0.1)


def test_ollama_retries_transient_then_succeeds(monkeypatch):
    _no_sleep(monkeypatch)
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"message": {"content": "ok"}})

    prov = OllamaProvider(ModelSpec(provider="ollama", endpoint="http://x.test", model="m"), client=_client(handler))
    assert prov.chat([ChatMessage(role="user", content="hi")]) == "ok"
    assert calls["n"] == 3                                    # 1 try + 2 retries


def test_ollama_gives_up_after_two_retries(monkeypatch):
    _no_sleep(monkeypatch)
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        raise httpx.ConnectError("refused", request=req)

    prov = OllamaProvider(ModelSpec(provider="ollama", endpoint="http://x.test", model="m"), client=_client(handler))
    with pytest.raises(ProviderError) as ei:
        prov.chat([ChatMessage(role="user", content="hi")])
    assert calls["n"] == 3
    assert "Traceback" not in str(ei.value)                  # clean message, never a traceback


def test_ollama_404_is_not_retried_and_hints_pull(monkeypatch):
    _no_sleep(monkeypatch)
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(404, text="model 'nope' not found")

    prov = OllamaProvider(ModelSpec(provider="ollama", endpoint="http://x.test", model="nope"), client=_client(handler))
    with pytest.raises(ProviderError, match="ollama pull nope"):
        prov.chat([ChatMessage(role="user", content="hi")])
    assert calls["n"] == 1


def test_ollama_health_and_models():
    def handler(req):
        if req.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.5.1"})
        return httpx.Response(200, json={"models": [{"name": "a:1"}, {"name": "b:2"}]})

    prov = OllamaProvider(ModelSpec(provider="ollama", endpoint="http://x.test", model="a:1"), client=_client(handler))
    ok, detail = prov.health()
    assert ok and "0.5.1" in detail
    assert prov.list_models() == ["a:1", "b:2"]


def test_openai_compat_image_parts_and_bearer(monkeypatch):
    monkeypatch.setenv("TEST_KEY_ENV", "sk-secretvalue123")
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}]})

    spec = ModelSpec(provider="openai_compat", endpoint="http://llama.test/v1", model="local",
                     api_key_env="TEST_KEY_ENV", supports_vision=True)
    prov = OpenAICompatProvider(spec, client=_client(handler))
    assert prov.chat([ChatMessage(role="user", content="q", images=[PNG])]) == "hello"
    assert seen["auth"] == "Bearer sk-secretvalue123"
    parts = seen["body"]["messages"][0]["content"]
    assert parts[0]["type"] == "text"
    assert parts[1]["type"] == "image_url" and parts[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_openai_compat_error_string_is_clean():
    def handler(req):
        return httpx.Response(400, text="bad request body")

    prov = OpenAICompatProvider(ModelSpec(provider="openai_compat", endpoint="http://x.test/v1", model="m"),
                                client=_client(handler))
    with pytest.raises(ProviderError, match="HTTP 400"):
        prov.chat([ChatMessage(role="user", content="hi")])


def test_cloud_refused_without_privacy_opt_in(monkeypatch):
    monkeypatch.setenv("CLOUD_KEY_X", "k")
    with pytest.raises(CloudDisabledError):
        CloudProvider(ModelSpec(provider="cloud", model="m", api_key_env="CLOUD_KEY_X"), allow_cloud=False)


def test_cloud_requires_key_env(monkeypatch):
    monkeypatch.delenv("MISSING_CLOUD_KEY", raising=False)
    with pytest.raises(ProviderError, match="MISSING_CLOUD_KEY"):
        CloudProvider(ModelSpec(provider="cloud", model="m", api_key_env="MISSING_CLOUD_KEY"), allow_cloud=True)


def test_cloud_is_flagged_and_labelled(monkeypatch):
    monkeypatch.setenv("CLOUD_KEY_Y", "k")
    prov = CloudProvider(ModelSpec(provider="cloud", endpoint="https://openrouter.test/api/v1", model="m",
                                   api_key_env="CLOUD_KEY_Y"), allow_cloud=True)
    assert prov.is_cloud is True


def test_factory_routes_providers(cfg):
    assert make_provider(ModelSpec(provider="ollama", model="m")).provider_name == "ollama"
    assert make_provider(ModelSpec(provider="openai_compat", model="m")).provider_name == "openai_compat"
    assert make_provider(ModelSpec(provider="llamacpp_local", model="/nope.gguf")).provider_name == "llamacpp_local"
    with pytest.raises(CloudDisabledError):
        make_provider(ModelSpec(provider="cloud", model="m"), cfg)
