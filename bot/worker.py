import asyncio
import io
import logging
from dataclasses import dataclass, field

from telegram import Bot

from bot.opencode_client import chat, tts

logger = logging.getLogger(__name__)

# Telegram max message length
MAX_MSG_LEN = 4096
# Typing indicator refresh interval
TYPING_REFRESH_INTERVAL = 4.0
# Progress animation interval
PROGRESS_INTERVAL = 8.0


@dataclass
class Task:
    chat_id: int
    reply_to_message_id: int
    text: str
    bot: Bot
    is_voice: bool = False


async def _typing_loop(bot: Bot, chat_id: int, stop_event: asyncio.Event) -> None:
    """Refresh typing indicator every 4s until stop_event is set."""
    while not stop_event.is_set():
        try:
            await bot.send_chat_action(chat_id=chat_id, action="typing")
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=TYPING_REFRESH_INTERVAL)
        except asyncio.TimeoutError:
            pass


async def _progress_animation(
    bot: Bot, chat_id: int, msg_id: int, stop_event: asyncio.Event
) -> None:
    """Update placeholder message periodically to show the bot is alive."""
    frames = ["⏳ Thinking", "⏳ Thinking.", "⏳ Thinking..", "⏳ Thinking..."]
    idx = 0
    while not stop_event.is_set():
        try:
            await bot.edit_message_text(
                chat_id=chat_id,
                message_id=msg_id,
                text=frames[idx % len(frames)],
            )
        except Exception:
            pass
        idx += 1
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=PROGRESS_INTERVAL)
        except asyncio.TimeoutError:
            pass


def _split_message(text: str, limit: int = MAX_MSG_LEN) -> list[str]:
    """Split long messages at natural boundaries."""
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
                    task.bot,
                    task.chat_id,
                    f"❌ Processing error: {e}",
                    task.reply_to_message_id,
                )
            finally:
                self._queue.task_done()

    async def _process(self, task: Task) -> None:
        chat_id = task.chat_id
        stop_event = asyncio.Event()

        # Send placeholder immediately
        placeholder = await task.bot.send_message(
            chat_id=chat_id,
            text="⏳ Thinking",
            reply_to_message_id=task.reply_to_message_id,
        )
        msg_id = placeholder.message_id

        # Start background tasks: typing indicator + progress animation
        typing_task = asyncio.create_task(
            _typing_loop(task.bot, chat_id, stop_event)
        )
        progress_task = asyncio.create_task(
            _progress_animation(task.bot, chat_id, msg_id, stop_event)
        )

        try:
            # Call LLM (blocking I/O via asyncio — doesn't block event loop)
            reply_text = await chat(chat_id, task.text)

            # Replace placeholder with actual response
            try:
                await task.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=msg_id,
                    text=reply_text[:MAX_MSG_LEN],
                )
            except Exception:
                await task.bot.send_message(
                    chat_id=chat_id,
                    text=reply_text[:MAX_MSG_LEN],
                    reply_to_message_id=task.reply_to_message_id,
                )

            # Send remaining chunks if response > 4096 chars
            if len(reply_text) > MAX_MSG_LEN:
                for chunk in _split_message(reply_text[MAX_MSG_LEN:], MAX_MSG_LEN):
                    try:
                        await task.bot.send_message(
                            chat_id=chat_id,
                            text=chunk,
                            reply_to_message_id=task.reply_to_message_id,
                        )
                    except Exception:
                        pass

            # Fire TTS in background — don't block the next message
            if reply_text:
                asyncio.create_task(
                    self._send_tts(
                        task.bot, chat_id, reply_text, task.reply_to_message_id
                    )
                )

        except Exception as e:
            logger.exception("Worker failed processing task")
            await self._safe_send(
                task.bot, chat_id, f"❌ Error: {e}", task.reply_to_message_id
            )
        finally:
            stop_event.set()
            await asyncio.gather(typing_task, progress_task, return_exceptions=True)

    async def _send_tts(
        self, bot: Bot, chat_id: int, text: str, reply_to_message_id: int
    ) -> None:
        """Generate and send TTS audio in background (fire-and-forget)."""
        try:
            await bot.send_chat_action(chat_id=chat_id, action="upload_voice")
            speech = await tts(text)
            await bot.send_audio(
                chat_id=chat_id,
                audio=io.BytesIO(speech),
                filename="reply.mp3",
                title="AI Voice Reply",
                read_timeout=60,
                write_timeout=60,
                reply_to_message_id=reply_to_message_id,
            )
        except Exception as e:
            logger.warning("TTS or audio reply failed (non-fatal): %s", e)

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
