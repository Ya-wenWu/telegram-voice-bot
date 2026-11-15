import logging
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from redis.asyncio import Redis

from bot.config import DAILY_REQUEST_LIMIT, REDIS_URL, TIMEZONE

logger = logging.getLogger(__name__)

# Increment the daily counter and expire it after two days. Returns 1 when the
# request is within the limit, 0 otherwise.
_QUOTA_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count > tonumber(ARGV[2]) then
    return 0
end
return 1
"""

_client: Redis | None = None
_disabled_until = 0.0
_FAILURE_COOLDOWN_SEC = 30.0


def _get_client() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=1.0,
            socket_connect_timeout=1.0,
        )
    return _client


async def check_daily_quota(
    user_id: int, limit: int = DAILY_REQUEST_LIMIT
) -> bool:
    """Return True when *user_id* is still within today's request quota.

    Redis failures fail open so a cache outage does not take the bot down.
    """
    if limit <= 0:
        return True

    global _disabled_until
    if time.monotonic() < _disabled_until:
        return True

    key = f"quota:{user_id}:{datetime.now(ZoneInfo(TIMEZONE)):%Y-%m-%d}"
    try:
        allowed = await _get_client().eval(_QUOTA_SCRIPT, 1, key, 172800, limit)
        return bool(int(allowed))
    except Exception as exc:  # noqa: BLE001 - fail open on any Redis failure

        _disabled_until = time.monotonic() + _FAILURE_COOLDOWN_SEC
        logger.warning(
            "Redis quota check failed; allowing request for %ss (error_type=%s)",
            int(_FAILURE_COOLDOWN_SEC),
            type(exc).__name__,
        )
        return True


async def close_redis() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            logger.debug("Redis close failed: %s", exc)
    _client = None
