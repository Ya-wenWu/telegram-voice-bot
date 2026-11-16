import asyncio
import logging
import os
import tempfile
import time
from pathlib import Path
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


async def _edit_or_ignore(msg: Any, text: str) -> None:
    """Safely edit a status message if it exists."""
    if msg:
        try:
            await msg.edit_text(text)
        except Exception:
            logger.debug("Failed to edit status message", exc_info=True)


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
    """Download voice file to disk, read bytes asynchronously, and clean up."""
    await asyncio.to_thread(TMP_DIR.mkdir, parents=True, exist_ok=True)
    tmp_path = await asyncio.to_thread(_create_temp_voice_path)

    try:
        file = await voice.get_file()
        await file.download_to_drive(tmp_path)
        size = await asyncio.to_thread(os.path.getsize, tmp_path)
        if size > MAX_VOICE_BYTES:
            raise ValueError("Voice file exceeds MAX_VOICE_BYTES after download")
        audio_bytes = await asyncio.to_thread(Path(tmp_path).read_bytes)
        return await transcribe(audio_bytes)
    finally:
        try:
            await asyncio.to_thread(os.unlink, tmp_path)
        except OSError:
            pass


def _create_temp_voice_path() -> str:
    """Create a temporary file path synchronously for worker thread usage."""
    with tempfile.NamedTemporaryFile(dir=TMP_DIR, suffix=".ogg", delete=False) as tmp:
        return tmp.name


async def _enqueue_voice_task(
    update: Update, 
    context: ContextTypes.DEFAULT_TYPE, 
    msg: Any, 
    text: str, 
) -> None:
    """Update status message and enqueue the transcribed voice task."""
    preview = text if len(text) <= 3800 else text[:3800] + "..."
    await _edit_or_ignore(msg, f"You: {preview}\n\n⏳ Thinking...")

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


def _check_voice_file(voice: Any | None) -> str | None:
    """Validate voice attachment existence and file size."""
    if voice is None:
        return "❌ 無法取得語音檔案"
    if not voice.file_size or voice.file_size > MAX_VOICE_BYTES:
        return "Voice file too large or unknown size."
    return None


async def _validate_voice_request(update: Update) -> tuple[Any | None, str | None]:
    """Validate auth, rate limit, voice attachment, size, and daily quota."""
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        return None, reason or "Unauthorized."

    voice = _get_voice(update)
    voice_error = _check_voice_file(voice)
    if voice_error:
        return None, voice_error

    if not await check_daily_quota(user_id):
        return None, "今日額度已用完，請明天再試。"

    return voice, None


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    voice, error_msg = await _validate_voice_request(update)
    if error_msg:
        await _reply(update, error_msg)
        return

    msg = await _reply(update, "⏳ Transcribing...")
    try:
        text = await _download_and_transcribe(voice)
    except Exception:
        logger.exception("Whisper failed")
        await _edit_or_ignore(msg, "❌ 語音轉錄失敗，請稍後再試。")
        return

    if not text or not text.strip():
        await _edit_or_ignore(msg, "⚠️ 無法辨識語音內容，請重新錄製。")
        return

    await _enqueue_voice_task(update, context, msg, text)