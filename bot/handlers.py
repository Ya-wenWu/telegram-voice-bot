import logging
import os
import tempfile
import time
from typing import Any

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


def _get_user_id(update: Update) -> int | None:
    """Safely extract user ID from update."""
    return update.effective_user.id if update.effective_user else None


def _get_chat_id(update: Update) -> int | None:
    """Safely extract chat ID from update."""
    return update.effective_chat.id if update.effective_chat else None


def _get_message_id(update: Update) -> int | None:
    """Safely extract message ID from update."""
    return update.message.message_id if update.message else None


def _get_text(update: Update) -> str:
    """Safely extract text from update message."""
    return update.message.text or "" if update.message else ""


def _get_voice(update: Update) -> Any | None:
    """Safely extract voice from update message."""
    return update.message.voice if update.message else None


async def _reply(update: Update, text: str):
    """Safely send a reply message and return the sent message object."""
    if update.message:
        return await update.message.reply_text(text)
    return None


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = _get_user_id(update)
    if user_id is None or not _is_allowed(user_id):
        await _reply(update, "Unauthorized.")
        return
    await _reply(update, "Send me a voice or text message and I'll reply!")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = _get_user_id(update)
    if user_id is None or not _is_allowed(user_id):
        await _reply(update, "Unauthorized.")
        return
    if _rate_limited(user_id):
        await _reply(update, "Too many requests, please wait.")
        return
    text = _get_text(update)
    if len(text) > MAX_TEXT_LEN:
        await _reply(update, "Message too long.")
        return
    if not await check_daily_quota(user_id):
        await _reply(update, "今日額度已用完，請明天再試。")
        return

    chat_id = _get_chat_id(update)
    message_id = _get_message_id(update)
    if chat_id is None or message_id is None or worker_pool is None:
        logger.warning("Cannot enqueue text task: missing chat_id/message_id/worker_pool")
        await _reply(update, "⚠️ 系統忙碌，請稍後再試")
        return

    await worker_pool.enqueue(
        Task(
            chat_id=chat_id,
            reply_to_message_id=message_id,
            text=text,
            bot=context.bot,
        )
    )


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = _get_user_id(update)
    if user_id is None or not _is_allowed(user_id):
        await _reply(update, "Unauthorized.")
        return
    if _rate_limited(user_id):
        await _reply(update, "Too many requests, please wait.")
        return

    voice = _get_voice(update)
    if voice is None:
        await _reply(update, "❌ 無法取得語音檔案")
        return
    if voice.file_size and voice.file_size > MAX_VOICE_BYTES:
        await _reply(update, "Voice file too large.")
        return
    if not await check_daily_quota(user_id):
        await _reply(update, "今日額度已用完，請明天再試。")
        return

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=TMP_DIR, suffix=".ogg", delete=False
    ) as tmp:
        tmp_path = tmp.name

    msg = await _reply(update, "⏳ Transcribing...")

    try:
        file = await voice.get_file()
        await file.download_to_drive(tmp_path)
        text = await transcribe(tmp_path)
    except Exception:
        logger.exception("Whisper failed")
        if msg:
            await msg.edit_text("❌ 語音轉錄失敗，請稍後再試。")
        return
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if msg:
        await msg.edit_text(f"You: {text}\n\n⏳ Thinking...")

    chat_id = _get_chat_id(update)
    message_id = _get_message_id(update)
    if chat_id is None or message_id is None or worker_pool is None:
        logger.warning("Cannot enqueue voice task: missing chat_id/message_id/worker_pool")
        return

    await worker_pool.enqueue(
        Task(
            chat_id=chat_id,
            reply_to_message_id=message_id,
            text=text,
            bot=context.bot,
            is_voice=True,
        )
    )
