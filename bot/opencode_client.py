import logging

import httpx

from bot.config import TTS_VOICE

logger = logging.getLogger(__name__)

OPCODE_BASE = "http://127.0.0.1:4096"

_sessions: dict[int, str] = {}

# Shared connection pool — ONE client per application lifetime
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=50,
                max_keepalive_connections=20,
                keepalive_expiry=30,
            ),
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0),
        )
    return _http_client


async def close_client() -> None:
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


async def _get_or_create_session(chat_id: int) -> str:
    if chat_id in _sessions:
        return _sessions[chat_id]
    client = _get_client()
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
    client = _get_client()
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
    import io

    import edge_tts

    communicate = edge_tts.Communicate(text, TTS_VOICE)
    audio_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.write(chunk["data"])
    return audio_bytes.getvalue()
