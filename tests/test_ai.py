"""Tests for app.ai — prompt building and provider streaming dispatch.

No network: the Anthropic/OpenAI streamers are stubbed, and the OpenAI SSE
parser is exercised against a fake httpx client.
"""

from __future__ import annotations

import asyncio

import pytest

from app import ai
from app.config import ModelBackend


def drain(agen):
    """Collect an async iterator into a list from synchronous test code."""
    async def _run():
        return [item async for item in agen]

    return asyncio.run(_run())


# -- build_system_prompt ----------------------------------------------------
def test_system_prompt_embeds_document():
    prompt = ai.build_system_prompt("<p>Hello</p>", "")
    assert "<document>" in prompt and "<p>Hello</p>" in prompt
    assert "# Loaded skills" not in prompt


def test_system_prompt_includes_skills_when_present():
    prompt = ai.build_system_prompt("<p>x</p>", "Be terse.")
    assert "# Loaded skills" in prompt and "Be terse." in prompt


# -- stream_chat dispatch ---------------------------------------------------
def test_stream_chat_routes_by_api_type(monkeypatch):
    async def fake_anthropic(backend, system, messages):
        yield "anthropic"

    async def fake_openai(backend, system, messages):
        yield "openai"

    monkeypatch.setattr(ai, "_stream_anthropic", fake_anthropic)
    monkeypatch.setattr(ai, "_stream_openai", fake_openai)

    a = ModelBackend("i", "l", "Anthropic", "m", api_type="anthropic")
    o = ModelBackend("i", "l", "Local", "m", api_type="openai")
    assert drain(ai.stream_chat(a, [], "doc")) == ["anthropic"]
    assert drain(ai.stream_chat(o, [], "doc")) == ["openai"]


def test_stream_chat_unknown_api_type_raises():
    backend = ModelBackend("i", "l", "X", "m", api_type="mystery")
    with pytest.raises(ValueError, match="Unknown API type"):
        drain(ai.stream_chat(backend, [], "doc"))


# -- OpenAI SSE parsing -----------------------------------------------------
class _FakeResponse:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeClient:
    lines: list[str] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, *a, **k):
        return _FakeResponse(_FakeClient.lines)


def _sse(content):
    return f'data: {{"choices": [{{"delta": {{"content": "{content}"}}}}]}}'


def test_stream_openai_parses_deltas(monkeypatch):
    _FakeClient.lines = [
        _sse("Hello"),
        "",                       # blank line, ignored
        "event: ping",            # non-data line, ignored
        "data: not-json",         # malformed, skipped
        _sse(" world"),
        "data: [DONE]",           # terminates
        _sse("ignored-after-done"),
    ]
    monkeypatch.setattr(ai.httpx, "AsyncClient", _FakeClient)

    backend = ModelBackend("i", "l", "Local", "m", api_type="openai",
                           base_url="http://localhost:11434/v1")
    chunks = drain(ai._stream_openai(backend, "system", [{"role": "user", "content": "hi"}]))
    assert chunks == ["Hello", " world"]
