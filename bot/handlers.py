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


def _check_auth_and_throttle(update: Update) -> tuple[int | None, str | None]:
    """Shared authorization and throttling guard.

    Returns (user_id, None) when allowed, or (None, reason) when the request
    should be rejected. Callers are responsible for sending rejection replies.
    """
    user_id = update.effective_user.id if update.effective_user else None
    if user_id is None or not _is_allowed(user_id):
        return None, "Unauthorized."
    if _rate_limited(user_id):
        return None, "Too many requests, please wait."
    return user_id, None


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
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
        return
    await _reply(update, "Send me a voice or text message and I'll reply!")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
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
        logger.warning(
            "Cannot enqueue text task: missing chat_id/message_id/worker_pool"
        )
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


async def _download_and_transcribe(voice: Any) -> str:
    """Download voice file to a temp path, transcribe it, and clean up."""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=TMP_DIR, suffix=".ogg", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        file = await voice.get_file()
        await file.download_to_drive(tmp_path)
        if os.path.getsize(tmp_path) > MAX_VOICE_BYTES:
            raise ValueError("Voice file exceeds MAX_VOICE_BYTES after download")
        return await transcribe(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def _enqueue_voice_task(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    msg: Any,
    text: str,
) -> None:
    """Update status message and enqueue the transcribed voice task."""
    if msg:
        await msg.edit_text(f"You: {text}\n\n⏳ Thinking...")

    chat_id = _get_chat_id(update)
    message_id = _get_message_id(update)
    if chat_id is None or message_id is None or worker_pool is None:
        logger.warning(
            "Cannot enqueue voice task: missing chat_id/message_id/worker_pool"
        )
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


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
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

    msg = await _reply(update, "⏳ Transcribing...")
    try:
        text = await _download_and_transcribe(voice)
    except Exception:
        logger.exception("Whisper failed")
        if msg:
            await msg.edit_text("❌ 語音轉錄失敗，請稍後再試。")
        return

    await _enqueue_voice_task(update, context, msg, text)
