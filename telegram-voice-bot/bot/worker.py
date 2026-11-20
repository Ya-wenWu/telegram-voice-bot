import asyncio
import io
import logging
import os
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from telegram import Bot

from bot.config import (
    BOT_QUEUE_MAXSIZE,
    CONVERSATION_MAX_TURNS,
    CONVERSATION_TTL_SEC,
    FFMPEG_TIMEOUT_SEC,
    MAX_VOICE_BYTES,
    TMP_DIR,
    TTS_TIMEOUT_SEC,
)
from bot.logging_context import req_id_var
from bot.memory import ConversationStore
from bot.opencode_client import chat, chat_stream, tts
from bot.whisper import transcribe

logger = logging.getLogger(__name__)

MAX_MSG_LEN = 4096  # Telegram limit, measured in UTF-16 code units
MAX_RESPONSE_CHARS = 16000
TYPING_REFRESH_INTERVAL = 4.0
STREAM_EDIT_INTERVAL = 1.0
TTS_CONCURRENCY = 3
# Keep synthesized audio bounded; 16k characters would be hours of speech.
TTS_MAX_CHARS = 1500
TTS_MAX_SENTENCES = 40

# Chinese + English sentence endings
_SENTENCE_ENDS = frozenset("。！？；.!?\n")


def _has_content(sentence: str) -> bool:
    """True when a sentence contains a letter, digit, or CJK character."""
    return any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in sentence)


@dataclass
class Task:
    chat_id: int
    reply_to_message_id: int
    text: str
    bot: Bot
    is_voice: bool = False
    voice: Any = None
    status_message: Any = None
    req_id: str = "-"


async def _typing_loop(bot: Bot, chat_id: int, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            await bot.send_chat_action(chat_id=chat_id, action="typing")
        except Exception as e:  # noqa: BLE001 - typing is best-effort
            logger.debug("send_chat_action failed: %s: %s", type(e).__name__, e)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=TYPING_REFRESH_INTERVAL)
        except TimeoutError:
            pass


def _scan_sentences(
    text: str,
    pos: int,
    min_len: int = 1,
) -> tuple[int, list[str]]:
    """Scan *text* from character position *pos* forward for complete sentences."""
    found: list[str] = []
    while pos < len(text):
        boundary = None
        for i in range(pos, len(text)):
            if text[i] in _SENTENCE_ENDS:
                boundary = i
                break
        if boundary is None:
            break
        sentence = text[pos : boundary + 1].strip()
        pos = boundary + 1
        if len(sentence) >= min_len and _has_content(sentence):
            found.append(sentence)
    return pos, found


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences at natural boundaries."""
    if not text:
        return []
    sentences = []
    buf: list[str] = []
    for ch in text:
        buf.append(ch)
        if ch in _SENTENCE_ENDS:
            s = "".join(buf).strip()
            if s:
                sentences.append(s)
            buf = []
    remaining = "".join(buf).strip()
    if remaining:
        sentences.append(remaining)
    return sentences


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _take_prefix(text: str, limit: int) -> tuple[str, str]:
    """Split *text* so the first part fits Telegram's UTF-16 limit."""
    if _utf16_len(text) <= limit:
        return text, ""
    units = 0
    cut = len(text)
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            cut = i
            break
    prefix, rest = text[:cut], text[cut:]
    for sep in ("\n", " "):
        at = prefix.rfind(sep)
        if at > 0 and _utf16_len(prefix[:at]) >= limit * 0.6:
            return prefix[: at + 1], text[at + 1 :]
    return prefix, rest


def _truncate(text: str, limit: int = MAX_MSG_LEN) -> str:
    return _take_prefix(text, limit)[0]


def _split_message(text: str, limit: int = MAX_MSG_LEN) -> list[str]:
    if not text:
        return []
    chunks: list[str] = []
    while text:
        chunk, text = _take_prefix(text, limit)
        chunks.append(chunk)
    return chunks


def _create_temp_voice_path() -> str:
    """Create a uniquely named temporary .ogg file path inside TMP_DIR."""
    with tempfile.NamedTemporaryFile(
        dir=TMP_DIR,
        prefix=f"voice_{uuid.uuid4().hex[:8]}_",
        suffix=".ogg",
        delete=False,
    ) as tmp:
        return tmp.name


async def _download_and_transcribe_voice(voice: Any) -> str:
    """Download voice to disk, stream to Whisper STT, and always unlink temp file."""
    await asyncio.to_thread(TMP_DIR.mkdir, parents=True, exist_ok=True)
    tmp_path = await asyncio.to_thread(_create_temp_voice_path)
    try:
        file = await voice.get_file()
        await file.download_to_drive(tmp_path)
        size = await asyncio.to_thread(os.path.getsize, tmp_path)
        if size > MAX_VOICE_BYTES:
            raise ValueError("Voice file exceeds MAX_VOICE_BYTES after download")
        return await transcribe(tmp_path)
    finally:
        try:
            await asyncio.to_thread(os.unlink, tmp_path)
        except OSError:
            pass


async def _concat_mp3(
    parts: list[bytes],
    *,
    timeout: float = FFMPEG_TIMEOUT_SEC,
) -> bytes:
    """Concatenate multiple MP3 byte streams into one using ffmpeg.

    Limits ffmpeg to a single thread and enforces a hard timeout so a stalled
    subprocess cannot wedge the worker or spike memory on a 1 vCPU host.
    """
    if len(parts) <= 1:
        return parts[0] if parts else b""

    await asyncio.to_thread(TMP_DIR.mkdir, parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix=f"tts_concat_{uuid.uuid4().hex[:8]}_", dir=TMP_DIR)
    proc: asyncio.subprocess.Process | None = None
    try:
        paths = []
        for i, data in enumerate(parts):
            path = os.path.join(tmpdir, f"part_{i:03d}.mp3")
            await asyncio.to_thread(_write_bytes, path, data)
            paths.append(path)

        list_path = os.path.join(tmpdir, "files.txt")
        listing = "".join(_format_ffmpeg_concat_entry(p) for p in paths)
        await asyncio.to_thread(_write_text, list_path, listing)

        out_path = os.path.join(tmpdir, f"out_{uuid.uuid4().hex[:8]}.mp3")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-threads",
            "1",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path,
            "-c:a",
            "libmp3lame",
            "-q:a",
            "4",
            "-loglevel",
            "quiet",
            out_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            ret = await asyncio.wait_for(proc.wait(), timeout=timeout)
        except (TimeoutError, asyncio.CancelledError):
            logger.warning(
                "ffmpeg concat timed out or cancelled after %.1fs; killing subprocess",
                timeout,
            )
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
            raise

        if ret == 0 and os.path.exists(out_path):
            return await asyncio.to_thread(_read_bytes, out_path)
        logger.warning("ffmpeg concat failed (ret=%d), falling back to first part", ret)
        return parts[0]
    except TimeoutError:
        logger.warning("ffmpeg concat timed out; falling back to first part")
        return parts[0]
    finally:
        await asyncio.to_thread(shutil.rmtree, tmpdir, True)


def _write_bytes(path: str, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)


def _format_ffmpeg_concat_entry(path: str) -> str:
    """Format a path for ffmpeg concat demuxer (POSIX slashes for Windows compatibility)."""
    normalized = Path(path).as_posix().replace("\\", "/").replace("'", "'\\''")
    return f"file '{normalized}'\n"


def _write_text(path: str, data: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(data)


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


class WorkerPool:
    def __init__(
        self,
        num_workers: int = 5,
        *,
        max_queue_size: int = BOT_QUEUE_MAXSIZE,
        tts_timeout: float = TTS_TIMEOUT_SEC,
        ffmpeg_timeout: float = FFMPEG_TIMEOUT_SEC,
        memory: ConversationStore | None = None,
    ):
        self._queue: asyncio.Queue[Task] = asyncio.Queue(maxsize=max_queue_size)
        self._num_workers = max(1, num_workers)
        self._workers: list[asyncio.Task] = []
        self._running = False
        self._tts_timeout = tts_timeout
        self._ffmpeg_timeout = ffmpeg_timeout
        self._memory = memory or ConversationStore(
            max_turns=CONVERSATION_MAX_TURNS,
            ttl_sec=CONVERSATION_TTL_SEC,
        )
        # Created inside the running loop (post_init), not at import time.
        self._tts_semaphore = asyncio.Semaphore(TTS_CONCURRENCY)
        self._ffmpeg_semaphore = asyncio.Semaphore(1)

    @property
    def memory(self) -> ConversationStore:
        return self._memory

    def clear_memory(self, chat_id: int) -> bool:
        return self._memory.clear(chat_id)

    async def _tts_limited(self, text: str) -> bytes:
        async with self._tts_semaphore:
            return await asyncio.wait_for(tts(text), timeout=self._tts_timeout)

    async def start(self) -> None:
        self._running = True
        self._workers = [
            asyncio.create_task(self._run(i), name=f"worker-{i}")
            for i in range(self._num_workers)
        ]
        logger.info(
            "Worker pool started with %d workers (queue_maxsize=%d)",
            self._num_workers,
            self._queue.maxsize,
        )

    async def stop(self, drain_timeout: float = 0.0) -> None:
        self._running = False
        if drain_timeout > 0 and self._workers:
            try:
                await asyncio.wait_for(self._queue.join(), timeout=drain_timeout)
            except TimeoutError:
                logger.warning(
                    "Worker pool drain timed out after %.1fs; cancelling remaining tasks",
                    drain_timeout,
                )
        for w in self._workers:
            w.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        logger.info("Worker pool stopped")

    async def enqueue(self, task: Task) -> None:
        self._queue.put_nowait(task)

    async def _run(self, idx: int) -> None:
        while self._running:
            try:
                task = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            token = req_id_var.set(task.req_id)
            try:
                await self._process(task)
            except Exception:
                logger.exception("Worker %d failed processing task", idx)
                await self._safe_send(
                    task.bot,
                    task.chat_id,
                    "⚠️ 系統忙碌，請稍後再試",
                    task.reply_to_message_id,
                )
            finally:
                req_id_var.reset(token)
                self._queue.task_done()

    async def _resolve_voice_text(self, task: Task) -> str | None:
        """Transcribe voice inside the worker to prevent polling loop blocking."""
        try:
            text = await _download_and_transcribe_voice(task.voice)
        except Exception:
            logger.exception("Whisper failed inside worker")
            if task.status_message is not None:
                try:
                    await task.status_message.edit_text("❌ 語音轉錄失敗，請稍後再試。")
                except Exception:
                    logger.debug("Failed to edit status message", exc_info=True)
            else:
                await self._safe_send(
                    task.bot,
                    task.chat_id,
                    "❌ 語音轉錄失敗，請稍後再試。",
                    task.reply_to_message_id,
                )
            return None

        if not text or not text.strip():
            if task.status_message is not None:
                try:
                    await task.status_message.edit_text(
                        "⚠️ 無法辨識語音內容，請重新錄製。"
                    )
                except Exception:
                    logger.debug("Failed to edit status message", exc_info=True)
            return None

        if task.status_message is not None:
            preview = text if len(text) <= 3800 else text[:3800] + "..."
            try:
                await task.status_message.edit_text(f"You: {preview}\n\n⏳ Thinking...")
            except Exception:
                logger.debug("Failed to edit status message", exc_info=True)
        return text

    async def _process(self, task: Task) -> None:
        chat_id = task.chat_id
        user_text = task.text
        if task.voice is not None and not user_text:
            transcribed = await self._resolve_voice_text(task)
            if transcribed is None:
                return
            user_text = transcribed

        stop_event = asyncio.Event()
        typing_task = asyncio.create_task(_typing_loop(task.bot, chat_id, stop_event))
        full_text = ""

        try:
            sent_msg = await task.bot.send_message(
                chat_id=chat_id,
                text="⏳ 思考中...",
                reply_to_message_id=task.reply_to_message_id,
            )
            msg_id = sent_msg.message_id

            history = self._memory.get_history(chat_id)
            pos = 0
            last_edit = time.monotonic()
            tts_tasks: list[asyncio.Task[bytes]] = []
            tts_chars = 0

            def _schedule_tts_fragment(raw: str) -> bool:
                """Enqueue one TTS fragment if within sentence/character caps."""
                nonlocal tts_chars
                fragment = raw.strip()
                if not fragment or not _has_content(fragment):
                    return True
                if len(tts_tasks) >= TTS_MAX_SENTENCES:
                    logger.info(
                        "Reached TTS_MAX_SENTENCES (%d); skipping remaining audio",
                        TTS_MAX_SENTENCES,
                    )
                    return False
                remaining_chars = TTS_MAX_CHARS - tts_chars
                if remaining_chars <= 0:
                    logger.info(
                        "Reached TTS_MAX_CHARS (%d); skipping remaining audio",
                        TTS_MAX_CHARS,
                    )
                    return False
                if len(fragment) > remaining_chars:
                    fragment = fragment[:remaining_chars]
                    logger.info(
                        "Truncated sentence to %d chars (TTS budget limit)",
                        remaining_chars,
                    )
                tts_chars += len(fragment)
                tts_tasks.append(asyncio.create_task(self._tts_limited(fragment)))
                return True

            def queue_tts(text_so_far: str, cursor: int) -> int:
                """Queue TTS for complete sentences, respecting both caps."""
                cursor, new = _scan_sentences(text_so_far, cursor)
                for sentence in new:
                    if not _schedule_tts_fragment(sentence):
                        break
                return cursor

            def flush_tts(text_so_far: str, cursor: int) -> int:
                """Flush any trailing unpunctuated text within TTS caps."""
                if cursor < len(text_so_far):
                    _schedule_tts_fragment(text_so_far[cursor:])
                return len(text_so_far)

            # Phase 1 — streaming (fast, progressive)
            stream_ok = True
            try:
                stream_iter = (
                    chat_stream(chat_id, user_text, history=history)
                    if history
                    else chat_stream(chat_id, user_text)
                )
                async for token in stream_iter:
                    full_text += token
                    if len(full_text) > MAX_RESPONSE_CHARS:
                        full_text = full_text[:MAX_RESPONSE_CHARS]
                        logger.warning(
                            "Response exceeded %d chars; truncating",
                            MAX_RESPONSE_CHARS,
                        )
                        break

                    now = time.monotonic()
                    if now - last_edit >= STREAM_EDIT_INTERVAL:
                        last_edit = now
                        try:
                            await task.bot.edit_message_text(
                                chat_id=chat_id,
                                message_id=msg_id,
                                text=_truncate(full_text),
                            )
                        except Exception as e:  # noqa: BLE001 - edit is cosmetic
                            logger.debug(
                                "edit_message_text during streaming: %s: %s",
                                type(e).__name__,
                                e,
                            )

                    if task.is_voice:
                        pos = queue_tts(full_text, pos)

                if task.is_voice:
                    pos = flush_tts(full_text, pos)

            except (httpx.TransportError, httpx.HTTPStatusError):
                logger.warning(
                    "Stream failed for chat %d, falling back to non-streaming", chat_id
                )
                stream_ok = False
                if task.is_voice:
                    pos = flush_tts(full_text, pos)

            # Phase 2 — fallback to non-streaming if stream failed
            if not stream_ok or not full_text:
                try:
                    complete = (
                        await chat(chat_id, user_text, history=history)
                        if history
                        else await chat(chat_id, user_text)
                    )
                except Exception:
                    logger.exception("Non-streaming fallback failed")
                    complete = None

                if complete:
                    for t in tts_tasks:
                        t.cancel()
                    await asyncio.gather(*tts_tasks, return_exceptions=True)
                    tts_tasks = []
                    tts_chars = 0
                    pos = 0
                    full_text = complete
                    try:
                        await task.bot.edit_message_text(
                            chat_id=chat_id,
                            message_id=msg_id,
                            text=_truncate(full_text),
                        )
                    except Exception as e:  # noqa: BLE001 - edit is cosmetic
                        logger.debug(
                            "edit_message_text after non-streaming: %s: %s",
                            type(e).__name__,
                            e,
                        )
                    if task.is_voice:
                        pos = queue_tts(full_text, pos)
                        pos = flush_tts(full_text, pos)

            if not full_text:
                await task.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=msg_id,
                    text="⚠️ 未取得回應，請稍後再試",
                )
                return

            self._memory.append_turn(chat_id, user_text, full_text)

            # Phase 3 — voice: collect TTS results and send audio
            if task.is_voice and tts_tasks:
                await task.bot.send_chat_action(chat_id=chat_id, action="upload_voice")
                parts: list[bytes] = []
                for t in tts_tasks:
                    try:
                        parts.append(await t)
                    except Exception as e:  # noqa: BLE001 - one sentence may fail
                        logger.warning("TTS task failed: %s: %s", type(e).__name__, e)
                if parts:
                    try:
                        async with self._ffmpeg_semaphore:
                            combined = await _concat_mp3(
                                parts, timeout=self._ffmpeg_timeout
                            )
                        await task.bot.send_audio(
                            chat_id=chat_id,
                            audio=io.BytesIO(combined),
                            filename="reply.mp3",
                            title="AI Voice Reply",
                            read_timeout=120,
                            write_timeout=120,
                            reply_to_message_id=task.reply_to_message_id,
                        )
                    except Exception as e:  # noqa: BLE001 - text still delivered
                        logger.warning(
                            "Voice reply failed, delivering text only: %s: %s",
                            type(e).__name__,
                            e,
                        )

            # Phase 4 — final text delivery
            await self._deliver_text(task, msg_id, full_text)

        except Exception:
            logger.exception("Worker failed processing task")
            if full_text:
                await self._deliver_text(task, msg_id, full_text)
            else:
                await self._safe_send(
                    task.bot,
                    chat_id,
                    "⚠️ 系統忙碌，請稍後再試",
                    task.reply_to_message_id,
                )
        finally:
            stop_event.set()
            await asyncio.gather(typing_task, return_exceptions=True)

    async def _deliver_text(self, task: Task, msg_id: int, text: str) -> None:
        """Send or update the final text message after streaming completes."""
        chunks = _split_message(text) or [""]
        try:
            await task.bot.edit_message_text(
                chat_id=task.chat_id,
                message_id=msg_id,
                text=chunks[0],
            )
        except Exception as e:  # noqa: BLE001 - fall back to a new message
            logger.debug(
                "edit_message_text for final text failed: %s: %s", type(e).__name__, e
            )
            await task.bot.send_message(
                chat_id=task.chat_id,
                text=chunks[0],
                reply_to_message_id=task.reply_to_message_id,
            )
        for chunk in chunks[1:]:
            try:
                await task.bot.send_message(
                    chat_id=task.chat_id,
                    text=chunk,
                    reply_to_message_id=task.reply_to_message_id,
                )
            except Exception as e:  # noqa: BLE001 - best effort, already logged
                logger.warning("Failed to send follow-up chunk: %s", e)

    @staticmethod
    async def _safe_send(
        bot: Bot, chat_id: int, text: str, reply_to_message_id: int
    ) -> None:
        try:
            await bot.send_message(
                chat_id=chat_id,
                text=text,
                reply_to_message_id=reply_to_message_id,
            )
        except Exception as e:  # noqa: BLE001 - nothing else we can do
            logger.error("Failed to send error message: %s", e)
