"""Tests for bot.handlers — message handlers, allowlist, rate limiting, quotas."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import bot.handlers as h
from bot.handlers import handle_text, handle_voice, start


def _make_update(
    user_id=123, text="hello", voice_file_size=None, chat_id=456, message_id=789
):
    update = MagicMock()
    update.effective_user.id = user_id
    update.effective_chat.id = chat_id
    update.message.message_id = message_id
    update.message.text = text
    reply_msg = MagicMock()
    reply_msg.edit_text = AsyncMock()
    update.message.reply_text = AsyncMock(return_value=reply_msg)
    update.message.edit_text = AsyncMock()
    if voice_file_size is not None:
        voice = MagicMock()
        voice.file_size = voice_file_size
        file_mock = MagicMock()
        file_mock.download_to_drive = AsyncMock()
        voice.get_file = AsyncMock(return_value=file_mock)
        update.message.voice = voice
    else:
        update.message.voice = None
    return update


def _make_context(bot=None):
    context = MagicMock()
    context.bot = bot or AsyncMock()
    return context


class TestAllowlist:
    def test_empty_allows_nobody(self):
        h.ALLOWED_USER_IDS = []
        assert h._is_allowed(1) is False
        assert h._is_allowed(999) is False

    def test_allows_listed_users(self):
        h.ALLOWED_USER_IDS = [123, 456]
        assert h._is_allowed(123) is True
        assert h._is_allowed(456) is True
        assert h._is_allowed(999) is False


class TestRateLimiting:
    def setup_method(self):
        h._last_request.clear()

    def test_first_request_not_limited(self):
        assert h._rate_limited(1) is False

    def test_rapid_second_request_limited(self):
        h._rate_limited(1)
        assert h._rate_limited(1) is True

    def test_different_users_independent(self):
        h._rate_limited(1)
        assert h._rate_limited(2) is False


class TestStart:
    @pytest.mark.asyncio()
    async def test_unauthorized(self):
        h.ALLOWED_USER_IDS = []
        update = _make_update(user_id=999)
        context = _make_context()
        await start(update, context)
        update.message.reply_text.assert_awaited_once_with("Unauthorized.")
        context.bot.send_message.assert_not_awaited()

    @pytest.mark.asyncio()
    async def test_authorized_sends_welcome(self):
        h.ALLOWED_USER_IDS = [123]
        update = _make_update(user_id=123)
        context = _make_context()
        await start(update, context)
        update.message.reply_text.assert_awaited_once_with(
            "Send me a voice or text message and I'll reply!"
        )


class TestHandleText:
    @pytest.mark.asyncio()
    async def test_unauthorized(self):
        h.ALLOWED_USER_IDS = []
        update = _make_update(user_id=999)
        context = _make_context()
        await handle_text(update, context)
        update.message.reply_text.assert_awaited_once_with("Unauthorized.")

    @pytest.mark.asyncio()
    async def test_rate_limited(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        h._rate_limited(123)
        update = _make_update(user_id=123)
        context = _make_context()
        await handle_text(update, context)
        update.message.reply_text.assert_awaited_once_with(
            "Too many requests, please wait."
        )

    @pytest.mark.asyncio()
    async def test_too_long(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, text="x" * 5000)
        context = _make_context()
        await handle_text(update, context)
        update.message.reply_text.assert_awaited_once_with("Message too long.")

    @pytest.mark.asyncio()
    async def test_quota_exceeded(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123)
        context = _make_context()
        with patch("bot.handlers.check_daily_quota", AsyncMock(return_value=False)):
            await handle_text(update, context)
        update.message.reply_text.assert_awaited_once_with(
            "今日額度已用完，請明天再試。"
        )

    @pytest.mark.asyncio()
    async def test_enqueues_task(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, text="hello")
        context = _make_context()
        pool = MagicMock()
        pool.enqueue = AsyncMock()
        h.worker_pool = pool
        with patch("bot.handlers.check_daily_quota", AsyncMock(return_value=True)):
            await handle_text(update, context)
        pool.enqueue.assert_awaited_once()
        task = pool.enqueue.await_args[0][0]
        assert task.text == "hello"
        assert task.chat_id == 456
        assert task.reply_to_message_id == 789
        assert task.is_voice is False
        h.worker_pool = None


class TestHandleVoice:
    @pytest.mark.asyncio()
    async def test_unauthorized(self):
        h.ALLOWED_USER_IDS = []
        update = _make_update(user_id=999, voice_file_size=1000)
        context = _make_context()
        await handle_voice(update, context)
        update.message.reply_text.assert_awaited_once_with("Unauthorized.")

    @pytest.mark.asyncio()
    async def test_file_too_large(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, voice_file_size=20 * 1024 * 1024)
        context = _make_context()
        await handle_voice(update, context)
        update.message.reply_text.assert_awaited_once_with(
            "Voice file too large or unknown size."
        )

    @pytest.mark.asyncio()
    async def test_quota_exceeded(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, voice_file_size=1000)
        context = _make_context()
        with patch("bot.handlers.check_daily_quota", AsyncMock(return_value=False)):
            await handle_voice(update, context)
        update.message.reply_text.assert_awaited_once_with(
            "今日額度已用完，請明天再試。"
        )

    @pytest.mark.asyncio()
    async def test_transcription_failure_sends_generic_error(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, voice_file_size=1000)
        context = _make_context()
        with (
            patch("bot.handlers.check_daily_quota", AsyncMock(return_value=True)),
            patch("bot.handlers.transcribe", AsyncMock(side_effect=Exception("boom"))),
        ):
            await handle_voice(update, context)
        update.message.reply_text.assert_any_await("⏳ Transcribing...")
        update.message.reply_text.return_value.edit_text.assert_awaited_once_with(
            "❌ 語音轉錄失敗，請稍後再試。"
        )

    @pytest.mark.asyncio()
    async def test_enqueues_voice_task(self):
        h.ALLOWED_USER_IDS = [123]
        h._last_request.clear()
        update = _make_update(user_id=123, voice_file_size=1000)
        context = _make_context()
        pool = MagicMock()
        pool.enqueue = AsyncMock()
        h.worker_pool = pool
        with (
            patch("bot.handlers.check_daily_quota", AsyncMock(return_value=True)),
            patch("bot.handlers.transcribe", AsyncMock(return_value="你好")),
        ):
            await handle_voice(update, context)
        pool.enqueue.assert_awaited_once()
        task = pool.enqueue.await_args[0][0]
        assert task.text == "你好"
        assert task.is_voice is True
        h.worker_pool = None
