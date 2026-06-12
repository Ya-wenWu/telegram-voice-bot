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


async def close_client() -> None:
    pass


async def tts(text: str) -> bytes:
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
