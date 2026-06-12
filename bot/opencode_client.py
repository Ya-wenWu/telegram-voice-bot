import io
import logging

import edge_tts
import httpx

from bot.config import ZEN_API_BASE, ZEN_API_KEY, ZEN_MODEL, TTS_VOICE, build_system_prompt

logger = logging.getLogger(__name__)

HEADERS = {
    "Authorization": f"Bearer {ZEN_API_KEY}",
    "Content-Type": "application/json",
}


async def chat(chat_id: int, text: str) -> str:
    system_prompt = build_system_prompt()
    body = {
        "model": ZEN_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{ZEN_API_BASE}/chat/completions",
            json=body,
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def chat_stream(chat_id: int, text: str):
    """Stream LLM response token by token via SSE."""
    system_prompt = build_system_prompt()
    body = {
        "model": ZEN_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{ZEN_API_BASE}/chat/completions",
                json=body,
                headers=HEADERS,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        payload = line[6:].strip()
                        if payload == "[DONE]":
                            break
                        import json
                        try:
                            chunk = json.loads(payload)
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue
    except (httpx.ReadError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
        logger.warning("Stream interrupted for chat %d: %s", chat_id, e)


async def close_client() -> None:
    pass


async def tts(text: str) -> bytes:
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
