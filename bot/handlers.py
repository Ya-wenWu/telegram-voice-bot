import io
import logging

from telegram import Update
from telegram.ext import ContextTypes

from bot.config import ALLOWED_USER_IDS
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

    try:
        text = await transcribe(audio_bytes.getvalue())
    except Exception as e:
        logger.exception("Whisper failed")
        await msg.edit_text(f"❌ Transcription failed: {e}")
        return

    await msg.edit_text(f"You: {text}\n\n⏳ Thinking...")
    await worker_pool.enqueue(
        Task(
            chat_id=update.effective_chat.id,
            reply_to_message_id=update.message.message_id,
            text=text,
            bot=context.bot,
            is_voice=True,
        )
    )
