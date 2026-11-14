import logging
import os
import tempfile
import time

from telegram import Update
from telegram.ext import ContextTypes

from bot.config import ALLOWED_USER_IDS, MAX_VOICE_BYTES, TMP_DIR
from bot.redis_client import check_daily_quota
from bot.whisper import transcribe
from bot.worker import Task, WorkerPool

logger = logging.getLogger(__name__)

worker_pool: WorkerPool | None = None


# Default-deny: an empty allowlist means nobody is allowed.
def _is_allowed(user_id: int) -> bool:
    return user_id in ALLOWED_USER_IDS


# Per-user rate limiting / input size guards
MAX_TEXT_LEN = 4000
MIN_REQUEST_INTERVAL_SEC = 2.0
_last_request: dict[int, float] = {}


def _rate_limited(user_id: int) -> bool:
    now = time.monotonic()
    last = _last_request.get(user_id, 0.0)
    if now - last < MIN_REQUEST_INTERVAL_SEC:
        return True
    _last_request[user_id] = now
    return False


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        await update.message.reply_text("Unauthorized.")
        return
    await update.message.reply_text("Send me a voice or text message and I'll reply!")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not _is_allowed(user.id):
        await update.message.reply_text("Unauthorized.")
        return
    if _rate_limited(user.id):
        await update.message.reply_text("Too many requests, please wait.")
        return
    text = update.message.text or ""
    if len(text) > MAX_TEXT_LEN:
        await update.message.reply_text("Message too long.")
        return
    if not await check_daily_quota(user.id):
        await update.message.reply_text("今日額度已用完，請明天再試。")
        return

    await worker_pool.enqueue(
        Task(
            chat_id=update.effective_chat.id,
            reply_to_message_id=update.message.message_id,
            text=text,
            bot=context.bot,
        )
    )


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not _is_allowed(user.id):
        await update.message.reply_text("Unauthorized.")
        return
    if _rate_limited(user.id):
        await update.message.reply_text("Too many requests, please wait.")
        return

    voice = update.message.voice
    if voice.file_size and voice.file_size > MAX_VOICE_BYTES:
        await update.message.reply_text("Voice file too large.")
        return
    if not await check_daily_quota(user.id):
        await update.message.reply_text("今日額度已用完，請明天再試。")
        return

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=TMP_DIR, suffix=".ogg", delete=False
    ) as tmp:
        tmp_path = tmp.name

    msg = await update.message.reply_text("⏳ Transcribing...")

    try:
        file = await voice.get_file()
        await file.download_to_drive(tmp_path)
        text = await transcribe(tmp_path)
    except Exception:
        logger.exception("Whisper failed")
        await msg.edit_text("❌ 語音轉錄失敗，請稍後再試。")
        return
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

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
