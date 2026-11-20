import asyncio
import logging
import time
from typing import Any

from telegram import Update
from telegram.ext import ContextTypes

from bot.config import ALLOWED_USER_IDS, MAX_VOICE_BYTES
from bot.logging_context import req_id_var
from bot.redis_client import check_daily_quota
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


def _set_request_id(update: Update) -> str:
    update_id = getattr(update, "update_id", None)
    req_id = str(update_id) if isinstance(update_id, int) else "-"
    req_id_var.set(req_id)
    return req_id


def _pool_has_space(pool: WorkerPool) -> bool:
    """Return True when the worker pool is accepting tasks and below maxsize."""
    accepting = getattr(pool, "_accepting", True)
    if accepting is False:
        return False
    q = getattr(pool, "_queue", None)
    if q is not None:
        maxsize = getattr(q, "maxsize", None)
        qsize_fn = getattr(q, "qsize", None)
        if isinstance(maxsize, int) and maxsize > 0 and callable(qsize_fn):
            current = qsize_fn()
            if isinstance(current, int) and current >= maxsize:
                return False
    return True


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
    _set_request_id(update)
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
        return
    await _reply(
        update,
        "Send me a voice or text message and I'll reply! Use /reset to clear memory.",
    )


async def reset_memory(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Clear multi-turn conversation history for the current chat (Issue #26)."""
    _set_request_id(update)
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
        return
    chat_id = _get_chat_id(update)
    if chat_id is not None and worker_pool is not None:
        worker_pool.clear_memory(chat_id)
    await _reply(update, "已清除目前的對話記憶。")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    req_id = _set_request_id(update)
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
        return

    text = _get_text(update)
    if len(text) > MAX_TEXT_LEN:
        await _reply(update, "Message too long.")
        return

    chat_id = _get_chat_id(update)
    message_id = _get_message_id(update)
    if chat_id is None or message_id is None or worker_pool is None:
        logger.warning(
            "Cannot enqueue text task: missing chat_id/message_id/worker_pool"
        )
        await _reply(update, "⚠️ 系統忙碌，請稍後再試")
        return

    if not _pool_has_space(worker_pool):
        logger.warning("Worker queue full; rejecting text request for chat %d", chat_id)
        await _reply(update, "⚠️ 系統目前排隊請求過多，請稍後再試")
        return

    if not await check_daily_quota(user_id):
        await _reply(update, "今日額度已用完，請明天再試。")
        return

    try:
        await worker_pool.enqueue(
            Task(
                chat_id=chat_id,
                reply_to_message_id=message_id,
                text=text,
                bot=context.bot,
                req_id=req_id,
            )
        )
    except asyncio.QueueFull:
        logger.warning("Worker queue full; rejecting text request for chat %d", chat_id)
        await _reply(update, "⚠️ 系統目前排隊請求過多，請稍後再試")


def _check_voice_file(voice: Any | None) -> str | None:
    """Validate voice attachment existence and file size."""
    if voice is None:
        return "❌ 無法取得語音檔案"
    if not voice.file_size or voice.file_size > MAX_VOICE_BYTES:
        return "Voice file too large or unknown size."
    return None


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Validate voice request and offload download + STT into WorkerPool.

    Moving voice download and transcription into WorkerPool prevents
    Head-of-Line Blocking on the polling loop when CONCURRENT_UPDATES=1.
    """
    req_id = _set_request_id(update)
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        await _reply(update, reason or "Unauthorized.")
        return

    voice = _get_voice(update)
    voice_error = _check_voice_file(voice)
    if voice_error:
        await _reply(update, voice_error)
        return

    chat_id = _get_chat_id(update)
    message_id = _get_message_id(update)
    if chat_id is None or message_id is None or worker_pool is None:
        logger.warning(
            "Cannot enqueue voice task: missing chat_id/message_id/worker_pool"
        )
        await _reply(update, "⚠️ 系統忙碌，請稍後再試")
        return

    if not _pool_has_space(worker_pool):
        logger.warning(
            "Worker queue full; rejecting voice request for chat %d", chat_id
        )
        await _reply(update, "⚠️ 系統目前排隊請求過多，請稍後再試")
        return

    if not await check_daily_quota(user_id):
        await _reply(update, "今日額度已用完，請明天再試。")
        return

    msg = await _reply(update, "⏳ Transcribing...")
    try:
        await worker_pool.enqueue(
            Task(
                chat_id=chat_id,
                reply_to_message_id=message_id,
                text="",
                bot=context.bot,
                is_voice=True,
                voice=voice,
                status_message=msg,
                req_id=req_id,
            )
        )
    except asyncio.QueueFull:
        logger.warning(
            "Worker queue full; rejecting voice request for chat %d", chat_id
        )
        await _edit_or_ignore(msg, "⚠️ 系統目前排隊請求過多，請稍後再試")
