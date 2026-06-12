import asyncio
import logging
import os
import tempfile

import httpx

from bot.config import WHISPER_URL

logger = logging.getLogger(__name__)

MAX_CHUNK_SEC = 30


async def transcribe(audio_bytes: bytes) -> str:
    duration = await _probe_duration(audio_bytes)
    if duration <= MAX_CHUNK_SEC:
        return await _transcribe_chunk(audio_bytes)
    chunks = await _split_audio(audio_bytes, MAX_CHUNK_SEC)
    texts = []
    for chunk in chunks:
        text = await _transcribe_chunk(chunk)
        texts.append(text)
        logger.info("Chunk done (%d/%d): %d chars", len(texts), len(chunks), len(text))
    return "".join(texts)


async def _probe_duration(audio_bytes: bytes) -> float:
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".ogg")
    try:
        tmp.write(audio_bytes)
        tmp.close()
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            tmp.name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        return float(out.decode().strip())
    finally:
        os.unlink(tmp.name)


async def _split_audio(audio_bytes: bytes, chunk_sec: int) -> list[bytes]:
    tmpdir = tempfile.mkdtemp(prefix="whisper_split_")
    try:
        in_path = os.path.join(tmpdir, "input.ogg")
        with open(in_path, "wb") as f:
            f.write(audio_bytes)
        out_pattern = os.path.join(tmpdir, "chunk_%03d.ogg")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", in_path,
            "-f", "segment",
            "-segment_time", str(chunk_sec),
            "-c", "copy",
            "-map", "0",
            "-loglevel", "quiet",
            out_pattern,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        ret = await proc.wait()
        if ret != 0:
            logger.warning("ffmpeg segment failed (ret=%d), falling back to full audio", ret)
            return [audio_bytes]
        chunks = []
        i = 0
        while True:
            path = os.path.join(tmpdir, f"chunk_{i:03d}.ogg")
            if not os.path.exists(path):
                break
            with open(path, "rb") as f:
                chunks.append(f.read())
            i += 1
        if not chunks:
            logger.warning("ffmpeg produced no segments, using full audio")
            return [audio_bytes]
        return chunks
    finally:
        for fname in os.listdir(tmpdir):
            os.unlink(os.path.join(tmpdir, fname))
        os.rmdir(tmpdir)


async def _transcribe_chunk(chunk: bytes) -> str:
    files = {"file": ("audio.ogg", chunk, "audio/ogg")}
    data = {"model": "base", "language": "zh", "response_format": "json"}
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{WHISPER_URL}/v1/audio/transcriptions",
            files=files,
            data=data,
        )
        resp.raise_for_status()
        return resp.json()["text"]
