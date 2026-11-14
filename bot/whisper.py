import asyncio
import logging
import os
from typing import BinaryIO

import httpx

import bot
from bot.config import (
    WHISPER_API_BASE,
    WHISPER_API_KEY,
    WHISPER_LANGUAGE,
    WHISPER_MODEL,
    WHISPER_URL,
)
from bot.retry import request_with_retry

logger = logging.getLogger(__name__)

# Common remote APIs cap uploads at 25 MB.
MAX_AUDIO_BYTES = 25 * 1024 * 1024


async def transcribe(audio: bytes | str | os.PathLike[str]) -> str:
    """Transcribe audio bytes or a file path via an OpenAI-compatible API.

    Passing a path is preferred for large messages: the file is streamed to the
    API instead of being copied into memory multiple times.
    """
    if isinstance(audio, (bytes, bytearray)):
        if not audio:
            return ""
        if len(audio) > MAX_AUDIO_BYTES:
            raise ValueError("Audio exceeds 25 MB limit")
        return await _transcribe_chunk(bytes(audio))

    path = os.fspath(audio)
    size = os.path.getsize(path)
    if size == 0:
        return ""
    if size > MAX_AUDIO_BYTES:
        raise ValueError("Audio exceeds 25 MB limit")
    fh = await asyncio.to_thread(open, path, "rb")
    try:
        return await _transcribe_chunk(fh)
    finally:
        await asyncio.to_thread(fh.close)


def _endpoint() -> tuple[str, dict[str, str]]:
    """Return (url, headers), preferring a self-hosted WHISPER_URL when set."""
    if WHISPER_URL:
        return (
            f"{WHISPER_URL.rstrip('/')}/v1/audio/transcriptions",
            {},
        )
    if not WHISPER_API_KEY:
        raise RuntimeError(
            "WHISPER_API_KEY is not set; configure it or set WHISPER_URL "
            "to use a self-hosted transcription server."
        )
    return (
        f"{WHISPER_API_BASE.rstrip('/')}/audio/transcriptions",
        {"Authorization": f"Bearer {WHISPER_API_KEY}"},
    )


async def _transcribe_chunk(chunk: bytes | BinaryIO) -> str:
    url, headers = _endpoint()
    data = {"model": WHISPER_MODEL, "response_format": "json"}
    if WHISPER_LANGUAGE:
        data["language"] = WHISPER_LANGUAGE

    async def _send() -> httpx.Response:
        # File handles are consumed by the first upload; rewind so a retry
        # does not send an empty body.
        if hasattr(chunk, "seek"):
            chunk.seek(0)
        files = {"file": ("audio.ogg", chunk, "audio/ogg")}
        return await bot.http_client.get_client().post(url, files=files, data=data, headers=headers)

    resp = await request_with_retry(_send, label="Transcription")
    resp.raise_for_status()
    return resp.json().get("text", "")
