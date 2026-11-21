"""Pluggable TTS provider abstraction (Edge TTS, OpenAI TTS, local Piper)."""

import asyncio
import io
import logging
from typing import Protocol

import edge_tts

import bot.http_client
from bot.config import (
    PIPER_BIN,
    PIPER_MODEL_PATH,
    TTS_API_BASE,
    TTS_API_KEY,
    TTS_MODEL,
    TTS_PROVIDER,
    TTS_VOICE,
)
from bot.retry import request_with_retry

logger = logging.getLogger(__name__)


class TTSProvider(Protocol):
    """Common interface for speech synthesis backends."""

    async def synthesize(self, text: str) -> bytes: ...


class EdgeTTSProvider:
    def __init__(self, voice: str) -> None:
        self.voice = voice

    async def synthesize(self, text: str) -> bytes:
        communicate = edge_tts.Communicate(text, self.voice)
        audio_bytes = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_bytes.write(chunk["data"])
        return audio_bytes.getvalue()


class OpenAITTSProvider:
    """OpenAI-compatible /audio/speech TTS backend."""

    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model: str,
        voice: str,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.voice = voice

    async def synthesize(self, text: str) -> bytes:
        if not self.api_key:
            raise RuntimeError("TTS_API_KEY is required when TTS_PROVIDER=openai")
        url = f"{self.api_base}/audio/speech"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "voice": self.voice,
            "input": text,
            "response_format": "mp3",
        }

        async def _send():
            return await bot.http_client.get_client().post(
                url, json=payload, headers=headers
            )

        resp = await request_with_retry(_send, label="OpenAI TTS")
        resp.raise_for_status()
        return resp.content


class PiperTTSProvider:
    """Local offline Piper CLI TTS backend."""

    def __init__(self, *, binary: str, model_path: str) -> None:
        self.binary = binary
        self.model_path = model_path

    async def synthesize(self, text: str) -> bytes:
        if not self.model_path:
            raise RuntimeError("PIPER_MODEL_PATH is required when TTS_PROVIDER=piper")
        proc = await asyncio.create_subprocess_exec(
            self.binary,
            "--model",
            self.model_path,
            "--output-raw",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await proc.communicate(text.encode("utf-8"))
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            raise
        if proc.returncode != 0:
            raise RuntimeError(f"Piper exited with status {proc.returncode}")
        return stdout


def get_tts_provider(
    provider_name: str | None = None,
    voice: str | None = None,
) -> TTSProvider:
    """Resolve the active TTSProvider implementation from configuration."""
    name = (provider_name or TTS_PROVIDER or "edge").strip().lower()
    active_voice = voice or TTS_VOICE
    if name == "edge":
        return EdgeTTSProvider(voice=active_voice)
    if name == "openai":
        return OpenAITTSProvider(
            api_base=TTS_API_BASE,
            api_key=TTS_API_KEY,
            model=TTS_MODEL,
            voice=active_voice,
        )
    if name == "piper":
        return PiperTTSProvider(binary=PIPER_BIN, model_path=PIPER_MODEL_PATH)
    raise ValueError(
        f"Unsupported TTS_PROVIDER: {name!r} (expected edge, openai, piper)"
    )
