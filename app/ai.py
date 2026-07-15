"""AI backend: stream chat completions from Anthropic or an OpenAI-compatible
(local or hosted) endpoint, with a document-editing protocol.

The assistant is given the current document as context. When it wants to change
the document it emits a fenced block the frontend can detect and apply:

    ```ai_words:document
    <full new HTML for the document body>
    ```

This convention works uniformly across providers (it needs no provider-specific
tool-calling support), and keeps edits transparent — the user sees the proposed
document and applies it explicitly.
"""

from __future__ import annotations

import json
import ssl
from typing import AsyncIterator

import httpx

from .config import ModelBackend


def _ssl_context() -> ssl.SSLContext | bool:
    """TLS verification context that trusts the OS certificate store when
    possible, so HTTPS works behind corporate proxies / MITM setups that use a
    private root CA (the "CERTIFICATE_VERIFY_FAILED: unable to get local issuer
    certificate" case). Falls back to httpx's certifi default if truststore is
    unavailable.
    """
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:  # pragma: no cover - best effort
        return True

SYSTEM_PROMPT = """\
You are the AI assistant inside AI Words, a two-pane document editor. The left \
pane holds a rich-text document; you are on the right. You help the user read, \
analyze, and edit that document.

You will be given the current document as HTML inside <document>...</document>. \
Treat it as the single source of truth for the document's current state.

When the user asks you to change the document, reply with a short explanation of \
what you changed, then emit the COMPLETE revised document body as HTML inside a \
fenced block tagged `ai_words:document`, for example:

```ai_words:document
<h1>New title</h1>
<p>Revised body...</p>
```

Rules for the document block:
- Include the ENTIRE document body, not just the changed part.
- Use only simple, editor-friendly HTML: h1-h6, p, ul/ol/li, strong, em, u, \
br, a, table/tr/td. No <html>, <head>, <body>, <script>, or <style> tags.
- Emit at most one `ai_words:document` block per reply.
- If the user is only asking a question (not requesting an edit), answer \
normally with NO document block.
"""

MAX_TOKENS = 16000


def build_system_prompt(document_html: str, skill_prompt: str) -> str:
    prompt = SYSTEM_PROMPT
    if skill_prompt.strip():
        prompt += "\n\n# Loaded skills\n" + skill_prompt.strip()
    prompt += f"\n\n<document>\n{document_html}\n</document>"
    return prompt


async def stream_chat(
    backend: ModelBackend,
    messages: list[dict],
    document_html: str,
    skill_prompt: str = "",
) -> AsyncIterator[str]:
    """Yield text chunks from the model's streamed response."""
    system = build_system_prompt(document_html, skill_prompt)
    if backend.api_type == "anthropic":
        async for chunk in _stream_anthropic(backend, system, messages):
            yield chunk
    elif backend.api_type == "openai":
        async for chunk in _stream_openai(backend, system, messages):
            yield chunk
    else:
        raise ValueError(f"Unknown API type: {backend.api_type}")


async def _stream_anthropic(
    backend: ModelBackend, system: str, messages: list[dict]
) -> AsyncIterator[str]:
    try:
        from anthropic import AsyncAnthropic
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("The 'anthropic' package is not installed.") from exc

    key = backend.resolve_key()
    if not key:
        raise RuntimeError(
            "No Anthropic API key found. Set ANTHROPIC_API_KEY or configure the model."
        )
    async with httpx.AsyncClient(verify=_ssl_context()) as http_client:
        client = AsyncAnthropic(api_key=key, http_client=http_client)
        async with client.messages.stream(
            model=backend.model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text


async def _stream_openai(
    backend: ModelBackend, system: str, messages: list[dict]
) -> AsyncIterator[str]:
    base_url = (backend.base_url or "https://api.openai.com/v1").rstrip("/")
    key = backend.resolve_key() or "not-needed"
    payload = {
        "model": backend.model,
        "max_tokens": MAX_TOKENS,
        "stream": True,
        "messages": [{"role": "system", "content": system}, *messages],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0), verify=_ssl_context()) as client:
        async with client.stream(
            "POST", f"{base_url}/chat/completions", json=payload, headers=headers
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for choice in obj.get("choices", []):
                    delta = choice.get("delta", {})
                    content = delta.get("content")
                    if content:
                        yield content
