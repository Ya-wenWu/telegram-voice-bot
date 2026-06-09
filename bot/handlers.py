import io
import logging

from telegram import Update
from telegram.ext import ContextTypes

from bot.config import ALLOWED_USER_IDS
from bot.opencode_client import chat, tts
from bot.whisper import transcribe
from bot.worker import Task, WorkerPool

logger = logging.getLogger(__name__)

worker_pool: WorkerPool | None = None


def _is_allowed(user_id: int) -> bool:
    return not ALLOWED_USER_IDS or user_id in ALLOWED_USER_IDS


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        await update.message.reply_text("Unauthorized.")
        return
    await update.message.reply_text("Send me a voice or text message and I'll reply!")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not _is_allowed(user.id):
        return

    # Enqueue immediately — streaming handled by worker
    await worker_pool.enqueue(
        Task(
            chat_id=update.effective_chat.id,
            reply_to_message_id=update.message.message_id,
            text=update.message.text,
            bot=context.bot,
        )
    )


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not _is_allowed(user.id):
        return

    voice = update.message.voice
    file = await voice.get_file()
    audio_bytes = io.BytesIO()
    await file.download_to_memory(audio_bytes)

    msg = await update.message.reply_text("⏳ Transcribing...")

    # Run transcription in thread pool to avoid blocking event loop
    import asyncio
    loop = asyncio.get_running_loop()
    try:
        text = await loop.run_in_executor(
            None, lambda: _transcribe_sync(audio_bytes.getvalue())
        )
    except Exception as e:
        logger.exception("Whisper failed")
        await msg.edit_text(f"❌ Transcription failed: {e}")
        return

    await msg.edit_text(f"You: {text}\n\n⏳ Processing...")

    await worker_pool.enqueue(
        Task(
            chat_id=update.effective_chat.id,
            reply_to_message_id=update.message.message_id,
            text=text,
            bot=context.bot,
            is_voice=True,
        )
    )


def _transcribe_sync(audio_bytes: bytes) -> str:
    """Synchronous transcription wrapper for run_in_executor."""
    import httpx
    from bot.config import WHISPER_URL

    with httpx.Client(timeout=120) as client:
        files = {"file": ("audio.ogg", audio_bytes, "audio/ogg")}
        data = {"model": "base", "language": "zh", "response_format": "json"}
        resp = client.post(
            f"{WHISPER_URL}/v1/audio/transcriptions",
            files=files,
            data=data,
        )
        resp.raise_for_status()
        return resp.json()["text"]
