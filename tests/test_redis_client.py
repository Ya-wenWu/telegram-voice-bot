import logging
from unittest.mock import AsyncMock, patch

import pytest

import bot.redis_client as rc


@pytest.fixture(autouse=True)
def _reset_state():
    rc._client = None
    rc._disabled_until = 0.0
    yield
    rc._client = None
    rc._disabled_until = 0.0


class TestDailyQuota:
    @pytest.mark.asyncio()
    async def test_allows_within_limit(self):
        client = AsyncMock()
        client.eval.return_value = 1
        with patch.object(rc, "_get_client", return_value=client):
            assert await rc.check_daily_quota(1, limit=5) is True
        args = client.eval.await_args.args
        assert args[1] == 1
        assert args[2].startswith("quota:1:")

    @pytest.mark.asyncio()
    async def test_denies_over_limit(self):
        client = AsyncMock()
        client.eval.return_value = 0
        with patch.object(rc, "_get_client", return_value=client):
            assert await rc.check_daily_quota(1, limit=5) is False

    @pytest.mark.asyncio()
    async def test_fail_open_on_redis_error(self):
        client = AsyncMock()
        client.eval.side_effect = ConnectionError("down")
        with patch.object(rc, "_get_client", return_value=client):
            assert await rc.check_daily_quota(1, limit=5) is True
            assert rc._disabled_until > 0

    @pytest.mark.asyncio()
    async def test_zero_limit_disables_quota(self):
        assert await rc.check_daily_quota(1, limit=0) is True

    @pytest.mark.asyncio()
    async def test_cooldown_skips_redis(self):
        client = AsyncMock()
        client.eval.side_effect = ConnectionError("down")
        with patch.object(rc, "_get_client", return_value=client):
            assert await rc.check_daily_quota(1, limit=5) is True
            client.eval.reset_mock()
            assert await rc.check_daily_quota(1, limit=5) is True
            client.eval.assert_not_awaited()

    @pytest.mark.asyncio()
    async def test_invalid_timezone_fails_open(self):
        with patch.object(rc, "TIMEZONE", "Invalid/Timezone"):
            assert await rc.check_daily_quota(1, limit=5) is True
            assert rc._disabled_until > 0

    @pytest.mark.asyncio()
    async def test_close_redis_logs_only_error_type(self, caplog):
        client = AsyncMock()
        client.aclose.side_effect = RuntimeError("redis://:secretpass@host:6379/0")
        rc._client = client
        with caplog.at_level(logging.DEBUG, logger="bot.redis_client"):
            await rc.close_redis()
        assert rc._client is None
        assert "RuntimeError" in caplog.text
        assert "secretpass" not in caplog.text
