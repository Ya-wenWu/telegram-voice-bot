import httpx

from bot.config import TTS_VOICE

OPCODE_BASE = "http://127.0.0.1:4096"

_sessions: dict[int, str] = {}


async def _get_or_create_session(chat_id: int) -> str:
    if chat_id in _sessions:
        return _sessions[chat_id]
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{OPCODE_BASE}/session",
            json={"title": f"telegram-{chat_id}"},
        )
        resp.raise_for_status()
        sid = resp.json()["id"]
        _sessions[chat_id] = sid
        return sid


async def chat(chat_id: int, text: str) -> str:
    sid = await _get_or_create_session(chat_id)
    body = {
        "parts": [{"type": "text", "text": text}],
        "noReply": False,
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{OPCODE_BASE}/session/{sid}/message",
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()
        parts = data.get("parts", [])
        texts = [p["text"] for p in parts if p.get("type") == "text"]
        return "\n".join(texts)


async def tts(text: str) -> bytes:
    import edge_tts
    import io

    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
