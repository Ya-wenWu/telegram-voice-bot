import asyncio
import io
import logging
import os
import shutil
import tempfile
import time
from dataclasses import dataclass

import httpx
from telegram import Bot

from bot.config import TMP_DIR
from bot.opencode_client import chat, chat_stream, tts

logger = logging.getLogger(__name__)

MAX_MSG_LEN = 4096  # Telegram limit, measured in UTF-16 code units
MAX_RESPONSE_CHARS = 16000
TYPING_REFRESH_INTERVAL = 4.0
STREAM_EDIT_INTERVAL = 0.5
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
    text: str, pos: int, min_len: int = 1,
) -> tuple[int, list[str]]:
    """Scan *text* from character position *pos* forward for complete sentences.

    Returns ``(new_pos, sentences)`` where *new_pos* advances past all
    examined characters and *sentences* are complete (boundary-terminated)
    fragments whose length >= *min_len* and contain actual content.

    ``min_len`` defaults to 1 so short replies such as "好。" are still spoken;
    punctuation-only fragments are filtered out.
    """
    found: list[str] = []
    while pos < len(text):
        boundary = None
        for i in range(pos, len(text)):
            if text[i] in _SENTENCE_ENDS:
                boundary = i
                break
        if boundary is None:
            break
        sentence = text[pos:boundary + 1].strip()
        pos = boundary + 1
        if len(sentence) >= min_len and _has_content(sentence):
            found.append(sentence)
    return pos, found


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences at natural boundaries.

    Kept for backwards compatibility / tests; the streaming path uses
    :func:`_scan_sentences` instead.
    """
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
    units = 0
    cut = len(text)
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            cut = i
            break
    prefix, rest = text[:cut], text[cut:]
    # Prefer breaking at a natural boundary when it is close to the limit.
    for sep in ("\n", " "):
        at = prefix.rfind(sep)
        if at > 0 and _utf16_len(prefix[:at]) >= limit * 0.6:
            return prefix[: at + 1], text[at + 1:]
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


async def _concat_mp3(parts: list[bytes]) -> bytes:
    """Concatenate multiple MP3 byte streams into one using ffmpeg."""
    if len(parts) <= 1:
        return parts[0] if parts else b""
    await asyncio.to_thread(TMP_DIR.mkdir, parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="tts_concat_", dir=TMP_DIR)
    try:
        paths = []
        for i, data in enumerate(parts):
            path = os.path.join(tmpdir, f"part_{i:03d}.mp3")
            await asyncio.to_thread(_write_bytes, path, data)
            paths.append(path)
        list_path = os.path.join(tmpdir, "files.txt")
        listing = "".join(f"file '{p}'\n" for p in paths)
        await asyncio.to_thread(_write_text, list_path, listing)
        out_path = os.path.join(tmpdir, "out.mp3")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", list_path, "-c:a", "libmp3lame", "-q:a", "4",
            "-loglevel", "quiet", out_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        ret = await proc.wait()
        if ret == 0 and os.path.exists(out_path):
            return await asyncio.to_thread(_read_bytes, out_path)
        logger.warning("ffmpeg concat failed (ret=%d), falling back to first part", ret)
        return parts[0]
    finally:
        await asyncio.to_thread(shutil.rmtree, tmpdir, True)


def _write_bytes(path: str, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)


def _write_text(path: str, data: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(data)


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


class WorkerPool:
    def __init__(self, num_workers: int = 5):
        self._queue: asyncio.Queue[Task] = asyncio.Queue()
        self._num_workers = num_workers
        self._workers: list[asyncio.Task] = []
        self._running = False
        # Created inside the running loop (post_init), not at import time.
        self._tts_semaphore = asyncio.Semaphore(TTS_CONCURRENCY)

    async def _tts_limited(self, text: str) -> bytes:
        async with self._tts_semaphore:
            return await tts(text)

    async def start(self) -> None:
        self._running = True
        self._workers = [
            asyncio.create_task(self._run(i), name=f"worker-{i}")
            for i in range(self._num_workers)
        ]
        logger.info("Worker pool started with %d workers", self._num_workers)

    async def stop(self) -> None:
        self._running = False
        for w in self._workers:
            w.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        logger.info("Worker pool stopped")

    async def enqueue(self, task: Task) -> None:
        await self._queue.put(task)

    async def _run(self, idx: int) -> None:
        while self._running:
            try:
                task = await asyncio.wait_for(self._queue.get(), timeout=5)
            except TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            try:
                await self._process(task)
            except Exception:
                logger.exception("Worker %d failed processing task", idx)
                await self._safe_send(
                    task.bot, task.chat_id,
                    "⚠️ 系統忙碌，請稍後再試",
                    task.reply_to_message_id,
                )
            finally:
                self._queue.task_done()

    async def _process(self, task: Task) -> None:
        chat_id = task.chat_id
        stop_event = asyncio.Event()

        placeholder = await task.bot.send_message(
            chat_id=chat_id,
            text="⏳ Thinking",
            reply_to_message_id=task.reply_to_message_id,
        )
        msg_id = placeholder.message_id

        typing_task = asyncio.create_task(_typing_loop(task.bot, chat_id, stop_event))
        full_text = ""
        try:
            tts_tasks: list[asyncio.Task[bytes]] = []
            tts_chars = 0
            pos = 0
            last_edit = 0.0

            def _schedule_tts_fragment(fragment: str) -> bool:
                """Schedule a single TTS fragment within char and sentence caps."""
                nonlocal tts_chars
                fragment = fragment.strip()
                if not fragment or not _has_content(fragment):
                    return True
                if len(tts_tasks) >= TTS_MAX_SENTENCES:
                    logger.info("TTS sentence budget reached; sending text only for the rest")
                    return False
                remaining_chars = TTS_MAX_CHARS - tts_chars
                if remaining_chars <= 0:
                    logger.info("TTS char budget reached; sending text only for the rest")
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
                async for token in chat_stream(chat_id, task.text):
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
                    complete = await chat(chat_id, task.text)
                except Exception:
                    logger.exception("Non-streaming fallback failed")
                    complete = None
                if complete:
                    # Partial streaming output is discarded; cancel its TTS work
                    # and rescan the complete text from the beginning.
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
                        combined = await _concat_mp3(parts)
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
                    task.bot, chat_id, "⚠️ 系統忙碌，請稍後再試", task.reply_to_message_id
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
