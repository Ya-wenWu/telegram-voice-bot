from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import bot.retry as retry_mod
from main import TokenFilter, TokenRedactingFormatter


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
    """測試 TokenFilter 與 TokenRedactingFormatter 的機密遮蔽規則。"""

    def test_masks_token_in_dict_args(self):
        # 20 字元以內的短金鑰應完全遮蔽為 ***
        f = TokenFilter("supersecrettoken1234")
        record = MagicMock()
        record.msg = "user=%(user)s"
        record.args = {"user": "supersecrettoken1234"}
        assert f.filter(record)
        assert record.args == {"user": "***"}

    def test_masks_long_token_partially(self):
        # 超過 20 字元的長金鑰才保留前 4 碼與後 4 碼
        f = TokenFilter("supersecrettoken12345")
        record = MagicMock()
        record.msg = "token=%s"
        record.args = ("supersecrettoken12345",)
        assert f.filter(record)
        assert record.args == ("***supe...2345***",)

    def test_masks_token_in_tuple_args_non_string(self):
        # 非字串參數（例如 HTTP URL 物件）- 必須對 str() 進行遮蔽
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
        assert record.msg == "user=%(user)s token ***"


class TestTokenRedactingFormatter:
    """測試正式環境使用的 TokenRedactingFormatter。"""

    def test_redacts_short_and_long_tokens_and_keeps_format(self):
        import logging

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
        assert "short=***" in formatted
        assert "long=***very...n_25***" in formatted
        assert "short_secret_16c" not in formatted
        assert "very_long_secret_token_25" not in formatted


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


class TestOpencodeEndpoint:
    def test_endpoint_strips_trailing_slash(self):
        import bot.opencode_client as oc

        with patch.object(oc, "ZEN_API_BASE", "https://api.example.com/v1/"):
            assert oc._endpoint() == "https://api.example.com/v1/chat/completions"
