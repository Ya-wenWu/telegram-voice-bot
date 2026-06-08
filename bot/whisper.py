import httpx

from bot.config import WHISPER_URL


async def transcribe(audio_bytes: bytes) -> str:
    files = {"file": ("audio.ogg", audio_bytes, "audio/ogg")}
    data = {"model": "base", "language": "zh", "response_format": "json"}
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{WHISPER_URL}/v1/audio/transcriptions",
            files=files,
            data=data,
        )
        resp.raise_for_status()
        return resp.json()["text"]
