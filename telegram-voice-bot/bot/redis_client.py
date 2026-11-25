from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import random
import re
import socket
import time
import uuid
from collections.abc import AsyncIterator
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

try:
    from redis.asyncio import Redis
except ImportError:  # pragma: no cover - allow fail-open when redis package is absent
    Redis = None  # type: ignore[assignment,misc]

from bot.config import (
    DAILY_REQUEST_LIMIT,
    FFMPEG_CONCURRENCY,
    FFMPEG_LEASE_TTL_SEC,
    FFMPEG_TIMEOUT_SEC,
    REDIS_SEMAPHORE_ENABLED,
    REDIS_URL,
    TIMEZONE,
    TTS_CONCURRENCY,
    TTS_LEASE_TTL_SEC,
    TTS_PROVIDER,
    TTS_TIMEOUT_SEC,
)
from bot.observability import metrics

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

# Atomic ZSET lease semaphore: prune expired leases first so crashed/SIGKILL'd
# workers never leak permits, then grant a new lease if active < max_permits.
# KEYS[1]: semaphore ZSET key
# ARGV[1]: now_ms, ARGV[2]: ttl_ms, ARGV[3]: max_permits, ARGV[4]: member_id
_SEM_ACQUIRE_SCRIPT = """
local now_ms = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
local max_permits = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
local active = redis.call('ZCARD', KEYS[1])
if active < max_permits then
    redis.call('ZADD', KEYS[1], now_ms + ttl_ms, ARGV[4])
    redis.call('PEXPIRE', KEYS[1], math.max(ttl_ms * 2, 1000))
    return 1
end
return 0
"""

# Fencing-checked lease renewal: only extend TTL if our member_id still holds a lease.
# KEYS[1]: semaphore ZSET key
# ARGV[1]: now_ms, ARGV[2]: ttl_ms, ARGV[3]: member_id
_SEM_RENEW_SCRIPT = """
local now_ms = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
    redis.call('ZADD', KEYS[1], now_ms + ttl_ms, ARGV[3])
    redis.call('PEXPIRE', KEYS[1], math.max(ttl_ms * 2, 1000))
    return 1
end
return 0
"""

# Safe owner-scoped release: only removes our own member_id from the ZSET.
# KEYS[1]: semaphore ZSET key
# ARGV[1]: member_id
_SEM_RELEASE_SCRIPT = """
return redis.call('ZREM', KEYS[1], ARGV[1])
"""

# Count currently active (non-expired) leases for diagnostics/observability.
# KEYS[1]: semaphore ZSET key
# ARGV[1]: now_ms
_SEM_COUNT_SCRIPT = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
return redis.call('ZCARD', KEYS[1])
"""

_INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}"
_SAFE_RESOURCE_RE = re.compile(r"[^a-zA-Z0-9:_.-]+")

_client: Any = None
_disabled_until = 0.0
_FAILURE_COOLDOWN_SEC = 30.0
# Start in degraded/probe-once mode until Redis answers at least once; when
# degraded or recovering after cooldown, only 1 coroutine probes Redis while
# concurrent callers fail open / fall back immediately (single-flight).
_degraded = True
_probing = False


class SemaphoreAcquireTimeoutError(TimeoutError):
    """Raised when a distributed/local resource semaphore cannot be acquired in time."""

    def __init__(self, resource: str, timeout_sec: float, backend: str) -> None:
        self.resource = resource
        self.timeout_sec = timeout_sec
        self.backend = backend
        super().__init__(
            f"Timed out after {timeout_sec:.2f}s waiting for {backend} semaphore '{resource}'"
        )


@dataclass(frozen=True)
class LeaseHandle:
    """Metadata describing an active semaphore lease."""

    resource: str
    member_id: str
    backend: Literal["redis", "local"]
    waited_sec: float


def _sanitize_resource(resource: str) -> str:
    cleaned = _SAFE_RESOURCE_RE.sub("_", resource.strip()).strip(":")
    return cleaned or "default"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _get_client() -> Any:
    global _client
    if Redis is None:
        raise RuntimeError("redis package is not installed")
    if _client is None:
        _client = Redis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=1.0,
            socket_connect_timeout=1.0,
        )
    return _client


def _enter_redis_call() -> tuple[bool, bool]:
    """Check circuit breaker and single-flight probe gate before calling Redis.

    Returns ``(can_call, is_probe)``. When ``is_probe`` is True the caller MUST
    call ``_exit_redis_probe()`` in a ``finally`` block.
    """
    global _probing
    if time.monotonic() < _disabled_until:
        return False, False
    if _degraded:
        if _probing:
            return False, False
        _probing = True
        return True, True
    return True, False


def _exit_redis_probe(is_probe: bool) -> None:
    global _probing
    if is_probe:
        _probing = False


def _mark_redis_healthy() -> None:
    global _degraded
    _degraded = False


def _record_redis_failure(operation: str, exc: Exception) -> None:
    global _disabled_until, _degraded
    metrics.redis_failures_total.inc()
    _degraded = True
    _disabled_until = time.monotonic() + _FAILURE_COOLDOWN_SEC
    logger.warning(
        "Redis %s failed; degrading for %ss (error_type=%s)",
        operation,
        int(_FAILURE_COOLDOWN_SEC),
        type(exc).__name__,
    )


async def check_daily_quota(
    user_id: int,
    limit: int = DAILY_REQUEST_LIMIT,
    *,
    bot_id: str = "default",
) -> bool:
    """Return True when *user_id* is still within today's request quota.

    Redis failures fail open so a cache outage does not take the bot down.
    """
    if limit <= 0:
        return True

    can_call, is_probe = _enter_redis_call()
    if not can_call:
        return True

    try:
        day_str = f"{datetime.now(ZoneInfo(TIMEZONE)):%Y-%m-%d}"
        safe_bot = _sanitize_resource(bot_id)
        key = (
            f"quota:{user_id}:{day_str}"
            if safe_bot == "default"
            else f"quota:{safe_bot}:{user_id}:{day_str}"
        )
        allowed = await _get_client().eval(_QUOTA_SCRIPT, 1, key, 172800, limit)
        _mark_redis_healthy()
        return bool(int(allowed))
    except Exception as exc:  # noqa: BLE001 - fail open on any Redis/timezone failure
        _record_redis_failure("quota check", exc)
        return True
    finally:
        _exit_redis_probe(is_probe)


class DistributedLeaseSemaphore:
    """Two-layer distributed lease semaphore backed by Redis ZSET + local asyncio.Semaphore.

    Layer 1 (Local): Always enforces per-process concurrency via ``asyncio.Semaphore`` so a
    Redis outage never causes unbounded FFmpeg/TTS fan-out or OOM crashes.

    Layer 2 (Redis): Enforces cluster-wide concurrency across multiple bot instances using
    atomic ZSET lease expiration, watchdog auto-renewal for long-running tasks, and safe
    owner-scoped release. If Redis is unavailable or trips the 30s circuit breaker, callers
    degrade seamlessly to Layer 1 local protection.
    """

    def __init__(
        self,
        resource: str,
        *,
        max_permits: int,
        lease_ttl_sec: float = 30.0,
        acquire_timeout_sec: float = 15.0,
        local_permits: int | None = None,
        key_prefix: str = "sem",
        poll_interval_sec: float = 0.02,
        max_poll_interval_sec: float = 0.2,
        redis_enabled: bool | None = None,
    ) -> None:
        if max_permits < 1:
            raise ValueError("max_permits must be >= 1")
        if lease_ttl_sec <= 0:
            raise ValueError("lease_ttl_sec must be > 0")
        if acquire_timeout_sec <= 0:
            raise ValueError("acquire_timeout_sec must be > 0")

        self._resource = _sanitize_resource(resource)
        self._key = f"{_sanitize_resource(key_prefix)}:{self._resource}"
        self._max_permits = int(max_permits)
        self._local_permits = max(
            1, int(local_permits if local_permits is not None else max_permits)
        )
        self._lease_ttl_sec = float(lease_ttl_sec)
        self._acquire_timeout_sec = float(acquire_timeout_sec)
        self._poll_interval_sec = max(0.005, float(poll_interval_sec))
        self._max_poll_interval_sec = max(
            self._poll_interval_sec, float(max_poll_interval_sec)
        )
        self._redis_enabled = redis_enabled
        self._local_sem = asyncio.Semaphore(self._local_permits)
        # Task-isolated stack so ``async with sem:`` is safe under concurrent tasks.
        self._ctx_stack: ContextVar[tuple[Any, ...]] = ContextVar(
            f"redis_sem_stack_{self._resource}_{id(self)}", default=()
        )

    @property
    def resource(self) -> str:
        return self._resource

    @property
    def key(self) -> str:
        return self._key

    @property
    def max_permits(self) -> int:
        return self._max_permits

    @property
    def lease_ttl_sec(self) -> float:
        return self._lease_ttl_sec

    def _use_redis(self) -> bool:
        if self._redis_enabled is not None:
            return self._redis_enabled
        return REDIS_SEMAPHORE_ENABLED

    async def _try_acquire_redis_once(self, member_id: str) -> Literal["acquired", "busy", "fallback"]:
        """Execute a single atomic ZSET lease acquisition attempt."""
        can_call, is_probe = _enter_redis_call()
        if not can_call:
            return "fallback"

        ttl_ms = max(100, int(self._lease_ttl_sec * 1000))
        try:
            granted = await _get_client().eval(
                _SEM_ACQUIRE_SCRIPT,
                1,
                self._key,
                _now_ms(),
                ttl_ms,
                self._max_permits,
                member_id,
            )
            _mark_redis_healthy()
            return "acquired" if int(granted) == 1 else "busy"
        except Exception as exc:  # noqa: BLE001 - degrade to local semaphore on Redis error
            _record_redis_failure(f"semaphore acquire ({self._resource})", exc)
            return "fallback"
        finally:
            _exit_redis_probe(is_probe)

    async def _release_redis(self, member_id: str) -> None:
        """Best-effort release of an owned Redis lease (never raises)."""
        if time.monotonic() < _disabled_until:
            return
        try:
            await asyncio.wait_for(
                _get_client().eval(_SEM_RELEASE_SCRIPT, 1, self._key, member_id),
                timeout=1.0,
            )
        except Exception as exc:  # noqa: BLE001 - TTL expiration will still reclaim lease
            logger.debug(
                "Redis semaphore release failed for %s (error_type=%s); lease will expire via TTL",
                self._resource,
                type(exc).__name__,
            )

    async def _renew_loop(self, member_id: str) -> None:
        """Periodically extend the Redis lease while the protected operation is still running."""
        interval = min(15.0, max(0.05, self._lease_ttl_sec / 3.0))
        ttl_ms = max(100, int(self._lease_ttl_sec * 1000))
        while True:
            await asyncio.sleep(interval)
            if time.monotonic() < _disabled_until:
                return
            try:
                renewed = await asyncio.wait_for(
                    _get_client().eval(
                        _SEM_RENEW_SCRIPT,
                        1,
                        self._key,
                        _now_ms(),
                        ttl_ms,
                        member_id,
                    ),
                    timeout=1.0,
                )
                if int(renewed) != 1:
                    logger.warning(
                        "Redis semaphore lease expired before renewal (resource=%s, member=%s)",
                        self._resource,
                        member_id,
                    )
                    return
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep running, retry next interval
                logger.debug(
                    "Redis semaphore lease renewal error for %s: %s",
                    self._resource,
                    type(exc).__name__,
                )

    async def active_leases(self) -> int | None:
        """Return active lease count in Redis, or ``None`` if Redis is unavailable."""
        if not self._use_redis():
            return None
        can_call, is_probe = _enter_redis_call()
        if not can_call:
            return None
        try:
            count = await _get_client().eval(_SEM_COUNT_SCRIPT, 1, self._key, _now_ms())
            _mark_redis_healthy()
            return int(count)
        except Exception as exc:  # noqa: BLE001
            _record_redis_failure(f"semaphore inspect ({self._resource})", exc)
            return None
        finally:
            _exit_redis_probe(is_probe)

    @contextlib.asynccontextmanager
    async def acquire(
        self, *, timeout_sec: float | None = None
    ) -> AsyncIterator[LeaseHandle]:
        """Acquire a concurrency permit with bounded wait, watchdog renewal, and safe cleanup."""
        effective_timeout = (
            self._acquire_timeout_sec if timeout_sec is None else max(0.01, float(timeout_sec))
        )
        wait_started = time.monotonic()
        deadline = wait_started + effective_timeout

        # Layer 1: Always enforce local per-process concurrency limit first.
        try:
            await asyncio.wait_for(self._local_sem.acquire(), timeout=effective_timeout)
        except TimeoutError as exc:
            waited = max(0.0, time.monotonic() - wait_started)
            metrics.redis_semaphore_wait_seconds.observe(waited)
            metrics.redis_semaphore_rejected_total.inc()
            raise SemaphoreAcquireTimeoutError(
                self._resource, effective_timeout, "local"
            ) from exc

        member_id = f"{_INSTANCE_ID}:{uuid.uuid4().hex}"
        backend: Literal["redis", "local"] = "local"
        renew_task: asyncio.Task[None] | None = None

        try:
            # Layer 2: Coordinate cluster-wide concurrency via Redis ZSET lease.
            if self._use_redis():
                backoff = self._poll_interval_sec
                while True:
                    status = await self._try_acquire_redis_once(member_id)
                    if status == "acquired":
                        backend = "redis"
                        break
                    if status == "fallback":
                        backend = "local"
                        break

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        waited = max(0.0, time.monotonic() - wait_started)
                        metrics.redis_semaphore_wait_seconds.observe(waited)
                        metrics.redis_semaphore_rejected_total.inc()
                        raise SemaphoreAcquireTimeoutError(
                            self._resource, effective_timeout, "redis"
                        )

                    # Jittered exponential backoff avoids thundering-herd polling.
                    sleep_for = min(remaining, backoff * random.uniform(0.75, 1.25))
                    await asyncio.sleep(max(0.002, sleep_for))
                    backoff = min(self._max_poll_interval_sec, backoff * 1.5)

            waited = max(0.0, time.monotonic() - wait_started)
            metrics.redis_semaphore_wait_seconds.observe(waited)

            if backend == "redis":
                renew_task = asyncio.create_task(
                    self._renew_loop(member_id),
                    name=f"redis-sem-renew-{self._resource}",
                )

            yield LeaseHandle(
                resource=self._resource,
                member_id=member_id,
                backend=backend,
                waited_sec=waited,
            )
        finally:
            if renew_task is not None:
                renew_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await renew_task
            if backend == "redis":
                # Shield release so task cancellation still frees the Redis lease immediately.
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.shield(self._release_redis(member_id))
            self._local_sem.release()

    async def __aenter__(self) -> LeaseHandle:
        cm = self.acquire()
        handle = await cm.__aenter__()
        self._ctx_stack.set((*self._ctx_stack.get(), cm))
        return handle

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> None:
        stack = self._ctx_stack.get()
        if not stack:
            return
        cm = stack[-1]
        self._ctx_stack.set(stack[:-1])
        await cm.__aexit__(exc_type, exc_val, exc_tb)


def create_ffmpeg_semaphore(
    *,
    max_permits: int | None = None,
    lease_ttl_sec: float | None = None,
    acquire_timeout_sec: float | None = None,
    local_permits: int | None = None,
) -> DistributedLeaseSemaphore:
    """Create a distributed lease semaphore guarding concurrent FFmpeg executions."""
    permits = max(1, max_permits if max_permits is not None else FFMPEG_CONCURRENCY)
    timeout = float(
        acquire_timeout_sec if acquire_timeout_sec is not None else FFMPEG_TIMEOUT_SEC
    )
    ttl = float(
        lease_ttl_sec
        if lease_ttl_sec is not None
        else max(FFMPEG_LEASE_TTL_SEC, timeout + 10.0)
    )
    return DistributedLeaseSemaphore(
        "ffmpeg",
        max_permits=permits,
        lease_ttl_sec=ttl,
        acquire_timeout_sec=timeout,
        local_permits=local_permits,
    )


def create_tts_semaphore(
    provider: str | None = None,
    *,
    max_permits: int | None = None,
    lease_ttl_sec: float | None = None,
    acquire_timeout_sec: float | None = None,
    local_permits: int | None = None,
) -> DistributedLeaseSemaphore:
    """Create a distributed lease semaphore guarding concurrent TTS calls per provider."""
    provider_name = _sanitize_resource((provider or TTS_PROVIDER or "edge").lower())
    permits = max(1, max_permits if max_permits is not None else TTS_CONCURRENCY)
    timeout = float(
        acquire_timeout_sec if acquire_timeout_sec is not None else TTS_TIMEOUT_SEC
    )
    ttl = float(
        lease_ttl_sec
        if lease_ttl_sec is not None
        else max(TTS_LEASE_TTL_SEC, timeout + 10.0)
    )
    return DistributedLeaseSemaphore(
        f"tts:{provider_name}",
        max_permits=permits,
        lease_ttl_sec=ttl,
        acquire_timeout_sec=timeout,
        local_permits=local_permits,
    )


async def close_redis() -> None:
    global _client, _degraded, _probing
    if _client is not None:
        try:
            await _client.aclose()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            logger.debug("Redis close failed (error_type=%s)", type(exc).__name__)
    _client = None
    _degraded = True
    _probing = False

