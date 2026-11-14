from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import bot.retry as retry_mod


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
