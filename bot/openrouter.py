import io

import edge_tts
import httpx

from bot.config import (
    LLM_BASE,
    LLM_MODEL,
    NVIDIA_API_KEY,
    TTS_VOICE,
    build_system_prompt,
)

CHAT_HEADERS = {
    "Authorization": f"Bearer {NVIDIA_API_KEY}",
    "Content-Type": "application/json",
}


async def chat(messages: list[dict]) -> str:
    system_prompt = build_system_prompt()
    body = {
        "model": LLM_MODEL,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(f"{LLM_BASE}/chat/completions", json=body, headers=CHAT_HEADERS)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def tts(text: str) -> bytes:
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
