import asyncio
import io
import logging
import os
import tempfile
from dataclasses import dataclass

import httpx
from telegram import Bot

from bot.opencode_client import chat, chat_stream, tts

logger = logging.getLogger(__name__)

MAX_MSG_LEN = 4096
TYPING_REFRESH_INTERVAL = 4.0
PROGRESS_INTERVAL = 8.0

# Chinese + English sentence endings
_SENTENCE_ENDS = frozenset("。！？；.!?\n")


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
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=TYPING_REFRESH_INTERVAL)
        except asyncio.TimeoutError:
            pass


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


def _scan_sentences(
    text: str, pos: int, min_len: int = 4,
) -> tuple[int, list[str]]:
    """Scan *text* from character position *pos* forward for complete sentences.
    
    Returns ``(new_pos, sentences)`` where *new_pos* advances past all
    examined characters and *sentences* are complete (boundary-terminated)
    fragments whose length >= *min_len*.
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
        if len(sentence) >= min_len:
            found.append(sentence)
    return pos, found


def _split_message(text: str, limit: int = MAX_MSG_LEN) -> list[str]:
    if len(text) <= limit:
        return [text]
    chunks = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break
        split_at = text.rfind("\n", 0, limit)
        if split_at == -1:
            split_at = text.rfind(" ", 0, limit)
        if split_at == -1:
            split_at = limit
        else:
            split_at += 1
        chunks.append(text[:split_at])
        text = text[split_at:]
    return chunks


async def _concat_mp3(parts: list[bytes]) -> bytes:
    """Concatenate multiple MP3 byte streams into one using ffmpeg."""
    if len(parts) <= 1:
        return parts[0] if parts else b""
    tmpdir = tempfile.mkdtemp(prefix="tts_concat_")
    try:
        paths = []
        for i, data in enumerate(parts):
            path = os.path.join(tmpdir, f"part_{i:03d}.mp3")
            with open(path, "wb") as f:
                f.write(data)
            paths.append(path)
        list_path = os.path.join(tmpdir, "files.txt")
        with open(list_path, "w") as f:
            for p in paths:
                f.write(f"file '{p}'\n")
        out_path = os.path.join(tmpdir, "out.mp3")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", list_path, "-c", "copy", "-loglevel", "quiet", out_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        ret = await proc.wait()
        if ret == 0 and os.path.exists(out_path):
            with open(out_path, "rb") as f:
                return f.read()
        logger.warning("ffmpeg concat failed (ret=%d), falling back to first part", ret)
        return parts[0]
    finally:
        for fname in os.listdir(tmpdir):
            os.unlink(os.path.join(tmpdir, fname))
        os.rmdir(tmpdir)


class WorkerPool:
    def __init__(self, num_workers: int = 5):
        self._queue: asyncio.Queue[Task] = asyncio.Queue()
        self._num_workers = num_workers
        self._workers: list[asyncio.Task] = []
        self._running = False

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
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            try:
                await self._process(task)
            except Exception as e:
                logger.exception("Worker %d failed processing task", idx)
                await self._safe_send(
                    task.bot, task.chat_id,
                    f"❌ Processing error ({type(e).__name__}): {e}",
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

        try:
            full_text = ""
            tts_parts: list[bytes] = []
            tts_tasks: list[asyncio.Task[bytes]] = []
            pos = 0

            # Phase 1 — streaming (fast, progressive)
            stream_ok = True
            try:
                async for token in chat_stream(chat_id, task.text):
                    full_text += token
                    try:
                        await task.bot.edit_message_text(
                            chat_id=chat_id,
                            message_id=msg_id,
                            text=full_text[:MAX_MSG_LEN],
                        )
                    except Exception as e:
                        logger.debug("edit_message_text during streaming: %s: %s", type(e).__name__, e)
                    if task.is_voice:
                        pos, new = _scan_sentences(full_text, pos)
                        for s in new:
                            tts_tasks.append(asyncio.create_task(tts(s)))
            except (httpx.ReadError, httpx.TimeoutException, httpx.RemoteProtocolError):
                logger.warning("Stream failed for chat %d, falling back to non-streaming", chat_id)
                stream_ok = False

            # Phase 2 — fallback to non-streaming if stream failed
            if not stream_ok or not full_text:
                try:
                    complete = await chat(chat_id, task.text)
                except Exception:
                    complete = None
                if complete:
                    full_text = complete
                    try:
                        await task.bot.edit_message_text(
                            chat_id=chat_id, message_id=msg_id,
                            text=full_text[:MAX_MSG_LEN],
                        )
                    except Exception as e:
                        logger.debug("edit_message_text after non-streaming: %s: %s", type(e).__name__, e)
                    if task.is_voice:
                        pos, new = _scan_sentences(full_text, pos)
                        for s in new:
                            tts_tasks.append(asyncio.create_task(tts(s)))

            # Phase 3 — voice: collect TTS results and send audio
            if task.is_voice and tts_tasks:
                await task.bot.send_chat_action(chat_id=chat_id, action="upload_voice")
                for t in tts_tasks:
                    try:
                        tts_parts.append(await t)
                    except Exception as e:
                        logger.warning("TTS task failed: %s: %s", type(e).__name__, e)
                if tts_parts:
                    combined = await _concat_mp3(tts_parts)
                    await task.bot.send_audio(
                        chat_id=chat_id,
                        audio=io.BytesIO(combined),
                        filename="reply.mp3",
                        title="AI Voice Reply",
                        read_timeout=60,
                        write_timeout=60,
                        reply_to_message_id=task.reply_to_message_id,
                    )

            # Phase 4 — final text delivery
            await self._deliver_text(task, msg_id, full_text)

        except Exception as e:
            logger.exception("Worker failed processing task")
            await self._safe_send(
                task.bot, chat_id, f"❌ Error ({type(e).__name__}): {e}", task.reply_to_message_id
            )
        finally:
            stop_event.set()
            await asyncio.gather(typing_task, return_exceptions=True)

    async def _deliver_text(self, task: Task, msg_id: int, text: str) -> None:
        """Send or update the final text message after streaming completes."""
        try:
            await task.bot.edit_message_text(
                chat_id=task.chat_id,
                message_id=msg_id,
                text=text[:MAX_MSG_LEN],
            )
        except Exception as e:
            logger.debug("edit_message_text for final text failed: %s: %s", type(e).__name__, e)
            await task.bot.send_message(
                chat_id=task.chat_id,
                text=text[:MAX_MSG_LEN],
                reply_to_message_id=task.reply_to_message_id,
            )
        if len(text) > MAX_MSG_LEN:
            for chunk in _split_message(text[MAX_MSG_LEN:], MAX_MSG_LEN):
                try:
                    await task.bot.send_message(
                        chat_id=task.chat_id,
                        text=chunk,
                        reply_to_message_id=task.reply_to_message_id,
                    )
                except Exception:
                    pass

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
        except Exception as e:
            logger.error("Failed to send error message: %s", e)
