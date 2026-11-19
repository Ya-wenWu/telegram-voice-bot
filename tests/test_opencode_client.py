import logging
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import bot.opencode_client as oc_mod
import bot.retry as retry_mod
from main import TokenRedactingFormatter, _extract_url_secret


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

    @pytest.mark.asyncio()
    async def test_transport_error_logs_type_without_raw_url(self, caplog):
        async def send():
            raise httpx.ConnectError("failed connecting to http://user:topsecret@host")

        with (
            patch.object(retry_mod.asyncio, "sleep", AsyncMock()),
            caplog.at_level(logging.WARNING, logger="bot.retry"),
            pytest.raises(httpx.ConnectError),
        ):
            await retry_mod.request_with_retry(send, label="test")

        assert "ConnectError" in caplog.text
        assert "topsecret" not in caplog.text


class TestOpenCodeHeaders:
    def test_omits_authorization_when_key_empty(self):
        with patch.object(oc_mod, "ZEN_API_KEY", ""):
            headers = oc_mod._headers()
        assert headers == {"Content-Type": "application/json"}
        assert "Authorization" not in headers

    def test_includes_bearer_when_key_present(self):
        with patch.object(oc_mod, "ZEN_API_KEY", "test-zen-key"):
            headers = oc_mod._headers()
        assert headers["Authorization"] == "Bearer test-zen-key"


class TestTokenRedactingFormatter:
    """測試正式環境使用的 TokenRedactingFormatter 完整遮蔽規則。"""

    def test_fully_redacts_short_and_long_tokens(self):
        formatter = TokenRedactingFormatter(
            ["short_secret_16c", "very_long_secret_token_25"]
        )
        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="short=%s long=%s",
            args=("short_secret_16c", "very_long_secret_token_25"),
            exc_info=None,
        )
        formatted = formatter.format(record)
        assert "[INFO] test.logger:" in formatted
        assert "short=***REDACTED***" in formatted
        assert "long=***REDACTED***" in formatted
        assert "short_secret_16c" not in formatted
        assert "very_long_secret_token_25" not in formatted
        assert "very..." not in formatted

    def test_redacts_dict_args_and_numeric_formatting(self):
        formatter = TokenRedactingFormatter(["fake0000000000000"])
        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="count=%(count)d token=%(token)s",
            args={"count": 42, "token": "fake0000000000000"},
            exc_info=None,
        )
        formatted = formatter.format(record)
        assert "count=42" in formatted
        assert "token=***REDACTED***" in formatted
        assert "fake0000000000000" not in formatted

    def test_redacts_non_string_url_objects_and_tracebacks(self):
        class FakeUrl:
            def __str__(self):
                return "https://api.example.com/secret_in_url_1234/path"

        formatter = TokenRedactingFormatter(["secret_in_url_1234"])
        try:
            raise RuntimeError("boom secret_in_url_1234")
        except RuntimeError:
            exc_info = sys.exc_info()

        record = logging.LogRecord(
            name="test.logger",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="url=%s",
            args=(FakeUrl(),),
            exc_info=exc_info,
        )
        formatted = formatter.format(record)
        assert "secret_in_url_1234" not in formatted
        assert formatted.count("***REDACTED***") >= 2

    def test_extract_url_secret(self):
        url = "redis://:my_redis_pw@127.0.0.1:6379/0"
        assert _extract_url_secret(url) == "my_redis_pw"
        assert _extract_url_secret("redis://127.0.0.1:6379/0") is None
        assert _extract_url_secret("") is None


class TestRedactDiff:
    """測試 _SECRET_PATTERNS 對 diff 中敏感值的遮蔽。"""

    @pytest.fixture()
    def code_review_module(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "code_review", ".github/scripts/code_review.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    @pytest.mark.parametrize(
        "diff_input,expected_pattern",
        [
            # 已知的專案機密環境變數名稱
            ("TELEGRAM_BOT_TOKEN=12345:abcdef", "TELEGRAM_BOT_TOKEN=***REDACTED***"),
            ("ZEN_API_KEY=fake0000000000000", "ZEN_API_KEY=***REDACTED***"),
            ("WHISPER_API_KEY=fake0000000000001", "WHISPER_API_KEY=***REDACTED***"),
            # 通用的 *_TOKEN、*_API_KEY、*_SECRET 模式
            ("MY_API_KEY=fake0000000000002", "MY_API_KEY=***REDACTED***"),
            ("MY_SECRET_KEY=fake0000000000003", "MY_SECRET_KEY=***REDACTED***"),
            ("MY_PASSWORD=fake0000000000004", "MY_PASSWORD=***REDACTED***"),
            # Bearer 權杖
            (
                "Authorization: Bearer fake0000000000005",
                "Authorization: Bearer ***REDACTED***",
            ),
            # Grok/GitHub 風格的密鑰
            ("gsk_123456789abcdef", "***REDACTED***"),
            ("sk_123456789abcdef", "***REDACTED***"),
        ],
    )
    def test_redact_secret_patterns(
        self, diff_input, expected_pattern, code_review_module
    ):
        redacted = diff_input
        for pattern, replacement in code_review_module._SECRET_PATTERNS:
            redacted = pattern.sub(replacement, redacted)
        assert expected_pattern in redacted, (
            f"預期在 '{redacted}' 中找到 '{expected_pattern}'"
        )

    def test_redact_diff_function(self, code_review_module):
        diff = (
            "diff --git a/.env b/.env\n"
            "+TELEGRAM_BOT_TOKEN=12345:abcdef\n"
            "+ZEN_API_KEY=fake0000000000000\n"
            "+WHISPER_API_KEY=fake0000000000001\n"
            "+sk_123456789abcdef\n"
            "+gsk_123456789abcdef"
        )
        redacted = code_review_module.redact_diff(diff)
        assert "12345:abcdef" not in redacted
        assert "fake0000000000000" not in redacted
        assert "fake0000000000001" not in redacted
        assert "sk_123456789abcdef" not in redacted
        assert "gsk_123456789abcdef" not in redacted
