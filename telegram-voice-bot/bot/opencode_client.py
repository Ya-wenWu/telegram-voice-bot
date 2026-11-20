import json
import logging

import httpx

import bot.http_client
from bot.config import (
    ZEN_API_BASE,
    ZEN_API_KEY,
    ZEN_MAX_TOKENS,
    ZEN_MODEL,
    build_system_prompt,
)
from bot.retry import request_with_retry
from bot.tts_provider import get_tts_provider

logger = logging.getLogger(__name__)

MAX_TEXT_LEN = 8000


def _endpoint() -> str:
    return f"{ZEN_API_BASE.rstrip('/')}/chat/completions"


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if ZEN_API_KEY:
        headers["Authorization"] = f"Bearer {ZEN_API_KEY}"
    return headers


def _messages(
    text: str,
    history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    msgs: list[dict[str, str]] = [{"role": "system", "content": build_system_prompt()}]
    if history:
        msgs.extend(history)
    msgs.append({"role": "user", "content": (text or "")[:MAX_TEXT_LEN]})
    return msgs


async def chat(
    chat_id: int,
    text: str,
    *,
    history: list[dict[str, str]] | None = None,
) -> str:
    body: dict[str, object] = {
        "model": ZEN_MODEL,
        "messages": _messages(text, history),
    }
    if ZEN_MAX_TOKENS > 0:
        body["max_tokens"] = ZEN_MAX_TOKENS

    async def _send() -> httpx.Response:
        return await bot.http_client.get_client().post(
            _endpoint(),
            json=body,
            headers=_headers(),
        )

    resp = await request_with_retry(_send, label="LLM request")
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def chat_stream(
    chat_id: int,
    text: str,
    *,
    history: list[dict[str, str]] | None = None,
):
    """Stream LLM response token by token via SSE."""
    body: dict[str, object] = {
        "model": ZEN_MODEL,
        "messages": _messages(text, history),
        "stream": True,
    }
    if ZEN_MAX_TOKENS > 0:
        body["max_tokens"] = ZEN_MAX_TOKENS

    client = bot.http_client.get_client()
    async with client.stream(
        "POST",
        _endpoint(),
        json=body,
        headers=_headers(),
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].lstrip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            # Some providers emit a final usage-only chunk with "choices": [].
            choices = chunk.get("choices") or [{}]
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield content


async def tts(text: str) -> bytes:
    """Synthesize speech via the configured TTSProvider."""
    return await get_tts_provider().synthesize(text)
