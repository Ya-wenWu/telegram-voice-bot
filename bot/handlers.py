import io
import logging

from telegram import Update
from telegram.ext import ContextTypes

from bot.config import ALLOWED_USER_IDS
from bot.opencode_client import chat, tts
from bot.whisper import transcribe

logger = logging.getLogger(__name__)


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

    text = update.message.text
    await update.message.reply_text("Thinking...")
    try:
        reply_text = await chat(update.effective_chat.id, text)
    except Exception as e:
        logger.exception("LLM failed")
        await update.message.reply_text(f"AI response failed: {e}")
        return

    await update.message.reply_text(reply_text)
    try:
        speech = await tts(reply_text)
    except Exception as e:
        logger.exception("TTS failed")
        return

    try:
        await update.message.reply_audio(
            io.BytesIO(speech),
            filename="reply.mp3",
            title="AI Voice Reply",
            read_timeout=60,
            write_timeout=60,
        )
    except Exception as e:
        logger.exception("Audio reply failed")
        await update.message.reply_text(f"Voice reply failed: {e}")


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not _is_allowed(user.id):
        return

    voice = update.message.voice
    file = await voice.get_file()
    audio_bytes = io.BytesIO()
    await file.download_to_memory(audio_bytes)

    await update.message.reply_text("Transcribing...")
    try:
        text = await transcribe(audio_bytes.getvalue())
    except Exception as e:
        logger.exception("Whisper failed")
        await update.message.reply_text(f"Transcription failed: {e}")
        return

    await update.message.reply_text(f"You: {text}\n\nThinking...")
    try:
        reply_text = await chat(update.effective_chat.id, text)
    except Exception as e:
        logger.exception("LLM failed")
        await update.message.reply_text(f"AI response failed: {e}")
        return

    await update.message.reply_text(f"AI: {reply_text}\n\nGenerating voice...")
    try:
        speech = await tts(reply_text)
    except Exception as e:
        logger.exception("TTS failed")
        await update.message.reply_text(f"TTS failed: {e}")
        return

    try:
        await update.message.reply_audio(
            io.BytesIO(speech),
            filename="reply.mp3",
            title="AI Voice Reply",
            read_timeout=60,
            write_timeout=60,
        )
    except Exception as e:
        logger.exception("Audio reply failed")
