from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import bot.retry as retry_mod
from main import TokenFilter


class TestRetry:
    @pytest.mark.asyncio()
    async def test_retries_on_429_then_succeeds(self):
        async def send():
            send.call_count += 1
            resp = MagicMock(spec=httpx.Response)
            resp.headers = {}
            if send.call_count == 1:
                resp.status_code = 429
            else:
                resp.status_code = 200
            return resp

        send.call_count = 0

        with patch.object(retry_mod.asyncio, "sleep", AsyncMock()):
            resp = await retry_mod.request_with_retry(send, label="test")

        assert resp.status_code == 200
        assert send.call_count == 2

    @pytest.mark.asyncio()
    async def test_does_not_retry_client_error(self):
        async def send():
            resp = MagicMock(spec=httpx.Response)
            resp.status_code = 400
            resp.headers = {}
            return resp

        with patch.object(retry_mod.asyncio, "sleep", AsyncMock()) as sleep:
            resp = await retry_mod.request_with_retry(send, label="test")

        assert resp.status_code == 400
        sleep.assert_not_awaited()

    @pytest.mark.asyncio()
    async def test_honors_retry_after(self):
        calls = 0

        async def send():
            nonlocal calls
            calls += 1
            resp = MagicMock(spec=httpx.Response)
            resp.headers = {"retry-after": "0"}
            if calls == 1:
                resp.status_code = 429
            else:
                resp.status_code = 200
            return resp

        with patch.object(retry_mod.asyncio, "sleep", AsyncMock()) as sleep:
            resp = await retry_mod.request_with_retry(send, label="test")

        assert resp.status_code == 200
        assert calls == 2
        sleep.assert_awaited_once()

    @pytest.mark.asyncio()
    async def test_gives_up_after_max_retries(self):
        async def send():
            resp = MagicMock(spec=httpx.Response)
            resp.status_code = 429
            resp.headers = {}
            return resp

        with patch.object(retry_mod.asyncio, "sleep", AsyncMock()):
            resp = await retry_mod.request_with_retry(send, label="test")

        assert resp.status_code == 429


class TestTokenFilterRedaction:
    """Test TokenFilter masks secrets in non-string log arguments."""

    def test_masks_token_in_dict_args(self):
        f = TokenFilter("supersecrettoken1234")
        record = MagicMock()
        record.msg = "user=%(user)s"
        record.args = {"user": "supersecrettoken1234"}
        assert f.filter(record)
        assert record.args == {"user": "***supe...1234***"}

    def test_masks_token_in_tuple_args_non_string(self):
        # Non-string arg (e.g. an HTTP URL object) - str() must be masked
        f = TokenFilter("supersecrettoken1234")
        record = MagicMock()
        record.msg = "url=%s"

        class FakeUrl:
            def __str__(self):
                return "https://api.example.com/supersecrettoken1234/path"

        record.args = (FakeUrl(),)
        assert f.filter(record)
        assert "***" in str(record.args[0])

    def test_masks_token_in_plain_args_non_string(self):
        f = TokenFilter("supersecrettoken1234")
        record = MagicMock()
        record.msg = "value=%s"
        record.args = (42,)
        assert f.filter(record)
        assert record.args == ("42",)

    def test_dict_args_stays_dict(self):
        f = TokenFilter("supersecrettoken1234")
        record = MagicMock()
        record.msg = "user=%(user)s token supersecrettoken1234"
        record.args = {"user": "alice"}
        assert f.filter(record)
        assert isinstance(record.args, dict)
        assert record.msg == "user=%(user)s token ***supe...1234***"



class TestRedactDiff:
    """Test _SECRET_PATTERNS redaction of sensitive values in diffs."""

    @pytest.fixture()
    def code_review_module(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "code_review", ".github/scripts/code_review.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    @pytest.mark.parametrize("diff_input,expected_pattern", [
        # Known project secret env var names
        ("TELEGRAM_BOT_TOKEN=REDACTED_TEST_TOKEN"TELEGRAM_BOT_TOKEN=REDACTED_TEST_TOKEN
        ("ZEN_API_KEY=REDACTED_TEST_KEY"ZEN_API_KEY=REDACTED_TEST_KEY
        ("WHISPER_API_KEY=REDACTED_TEST_KEY"WHISPER_API_KEY=REDACTED_TEST_KEY
        # Generic *_TOKEN, *_API_KEY, *_SECRET patterns
        ("MY_API_KEY=abc123def456", "MY_API_KEY=***REDACTED***"),
        ("MY_SECRET_KEY=xyz789abc", "MY_SECRET_KEY=***REDACTED***"),
        ("MY_PASSWORD=secret123", "MY_PASSWORD=***REDACTED***"),
        # Bearer tokens
        ("Authorization: Bearer abc123def456ghi789", "Authorization: Bearer ***REDACTED***"),
        # Grok/GitHub style keys
        ("gsk_REDACTED_TEST_KEY", "***REDACTED***"),
        ("sk_REDACTED_TEST_KEY", "***REDACTED***"),
    ])
    def test_redact_secret_patterns(self, diff_input, expected_pattern, code_review_module):
        redacted = diff_input
        for pattern, replacement in code_review_module._SECRET_PATTERNS:
            redacted = pattern.sub(replacement, redacted)
        assert expected_pattern in redacted, f"Expected '{expected_pattern}' in '{redacted}'"

    def test_redact_diff_function(self, code_review_module):
        diff = "diff --git a/.env b/.env\n+TELEGRAM_BOT_TOKEN=REDACTED_TEST_TOKEN
        redacted = code_review_module.redact_diff(diff)
        assert "TELEGRAM_BOT_TOKEN=REDACTED_TEST_TOKENin redacted
        assert "ZEN_API_KEY=REDACTED_TEST_KEYin redacted
        assert "WHISPER_API_KEY=REDACTED_TEST_KEYin redacted
        assert "12345:abcdef" not in redacted
        assert "sk-secret123" not in redacted
        assert "gsk-secret456" not in redacted
