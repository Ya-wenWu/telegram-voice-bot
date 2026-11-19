import io
import json
import logging

import edge_tts
import httpx

import bot.http_client
from bot.config import (
    TTS_VOICE,
    ZEN_API_BASE,
    ZEN_API_KEY,
    ZEN_MODEL,
    build_system_prompt,
)
from bot.retry import request_with_retry

logger = logging.getLogger(__name__)

MAX_TEXT_LEN = 8000


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if ZEN_API_KEY:
        headers["Authorization"] = f"Bearer {ZEN_API_KEY}"
    return headers


def _messages(text: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": build_system_prompt()},
        {"role": "user", "content": (text or "")[:MAX_TEXT_LEN]},
    ]


async def chat(chat_id: int, text: str) -> str:
    body = {"model": ZEN_MODEL, "messages": _messages(text)}

    async def _send() -> httpx.Response:
        return await bot.http_client.get_client().post(
            f"{ZEN_API_BASE}/chat/completions",
            json=body,
            headers=_headers(),
        )

    resp = await request_with_retry(_send, label="LLM request")
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def chat_stream(chat_id: int, text: str):
    """Stream LLM response token by token via SSE."""
    body = {
        "model": ZEN_MODEL,
        "messages": _messages(text),
        "stream": True,
    }

    client = bot.http_client.get_client()
    async with client.stream(
        "POST",
        f"{ZEN_API_BASE}/chat/completions",
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
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
