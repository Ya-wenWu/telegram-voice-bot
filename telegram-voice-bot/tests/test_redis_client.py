from unittest.mock import AsyncMock, patch

import pytest

import bot.redis_client as rc


@pytest.fixture(autouse=True)
def _reset_state():
    rc._client = None
    rc._disabled_until = 0.0
    rc._degraded = True
    rc._probing = False
    yield
    rc._client = None
    rc._disabled_until = 0.0
    rc._degraded = True
    rc._probing = False


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
    async def test_single_flight_probe_prevents_concurrent_failure_storm(self):
        import asyncio

        calls = 0

        async def slow_fail(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            raise ConnectionError("down")

        client = AsyncMock()
        client.eval.side_effect = slow_fail
        with patch.object(rc, "_get_client", return_value=client):
            results = await asyncio.gather(
                *(rc.check_daily_quota(i, limit=5) for i in range(10))
            )

        assert all(results)
        assert calls == 1
        assert rc._probing is False
        assert rc._disabled_until > 0


class _FakeRedisZSetClient:
    """In-memory emulator implementing exact ZSET lease Lua script semantics."""

    def __init__(self) -> None:
        self.zsets: dict[str, dict[str, int]] = {}
        self.renew_calls = 0
        self.release_calls = 0

    async def eval(self, script: str, _numkeys: int, key: str, *args: object) -> int:
        bucket = self.zsets.setdefault(key, {})
        if script is rc._SEM_ACQUIRE_SCRIPT:
            now_ms, ttl_ms, max_permits, member_id = (
                int(args[0]),
                int(args[1]),
                int(args[2]),
                str(args[3]),
            )
            expired = [m for m, exp in bucket.items() if exp <= now_ms]
            for m in expired:
                del bucket[m]
            if len(bucket) < max_permits:
                bucket[member_id] = now_ms + ttl_ms
                return 1
            return 0
        if script is rc._SEM_RENEW_SCRIPT:
            now_ms, ttl_ms, member_id = int(args[0]), int(args[1]), str(args[2])
            self.renew_calls += 1
            if member_id in bucket:
                bucket[member_id] = now_ms + ttl_ms
                return 1
            return 0
        if script is rc._SEM_RELEASE_SCRIPT:
            member_id = str(args[0])
            self.release_calls += 1
            return 1 if bucket.pop(member_id, None) is not None else 0
        if script is rc._SEM_COUNT_SCRIPT:
            now_ms = int(args[0])
            expired = [m for m, exp in bucket.items() if exp <= now_ms]
            for m in expired:
                del bucket[m]
            return len(bucket)
        raise AssertionError("Unexpected Lua script")


class TestDistributedLeaseSemaphore:
    @pytest.mark.asyncio()
    async def test_enforces_distributed_concurrency_across_instances(self):
        import asyncio

        fake_redis = _FakeRedisZSetClient()
        # Simulate two separate bot instances sharing the same Redis key
        sem_node_a = rc.DistributedLeaseSemaphore(
            "ffmpeg", max_permits=2, lease_ttl_sec=5.0, acquire_timeout_sec=2.0
        )
        sem_node_b = rc.DistributedLeaseSemaphore(
            "ffmpeg", max_permits=2, lease_ttl_sec=5.0, acquire_timeout_sec=2.0
        )

        active = 0
        max_seen = 0
        backends: list[str] = []

        async def worker(sem: rc.DistributedLeaseSemaphore) -> None:
            nonlocal active, max_seen
            async with sem.acquire() as lease:
                backends.append(lease.backend)
                active += 1
                max_seen = max(max_seen, active)
                await asyncio.sleep(0.05)
                active -= 1

        with patch.object(rc, "_get_client", return_value=fake_redis):
            await asyncio.gather(
                worker(sem_node_a),
                worker(sem_node_a),
                worker(sem_node_b),
                worker(sem_node_b),
                worker(sem_node_a),
                worker(sem_node_b),
            )
            remaining = await sem_node_a.active_leases()

        assert max_seen <= 2
        assert backends == ["redis"] * 6
        assert remaining == 0
        assert fake_redis.release_calls == 6

    @pytest.mark.asyncio()
    async def test_reclaims_expired_lease_from_crashed_worker(self):
        fake_redis = _FakeRedisZSetClient()
        # Simulate a SIGKILL'd worker whose lease already expired in the past
        fake_redis.zsets["sem:ffmpeg"] = {"dead-host:999:abc": rc._now_ms() - 5000}
        sem = rc.create_ffmpeg_semaphore(max_permits=1, lease_ttl_sec=2.0)

        with patch.object(rc, "_get_client", return_value=fake_redis):
            async with sem.acquire(timeout_sec=0.5) as lease:
                assert lease.backend == "redis"
                assert "dead-host:999:abc" not in fake_redis.zsets["sem:ffmpeg"]
                assert await sem.active_leases() == 1
            assert await sem.active_leases() == 0

    @pytest.mark.asyncio()
    async def test_watchdog_renews_lease_during_long_operation(self):
        import asyncio

        fake_redis = _FakeRedisZSetClient()
        sem = rc.DistributedLeaseSemaphore(
            "ffmpeg",
            max_permits=1,
            lease_ttl_sec=0.18,
            acquire_timeout_sec=1.0,
        )

        with patch.object(rc, "_get_client", return_value=fake_redis):
            async with sem.acquire() as lease:
                initial_exp = fake_redis.zsets["sem:ffmpeg"][lease.member_id]
                await asyncio.sleep(0.15)
                renewed_exp = fake_redis.zsets["sem:ffmpeg"][lease.member_id]

        assert fake_redis.renew_calls >= 1
        assert renewed_exp > initial_exp
        assert fake_redis.zsets["sem:ffmpeg"] == {}

    @pytest.mark.asyncio()
    async def test_timeout_raises_and_releases_local_permit(self):
        from bot.observability import metrics

        metrics.reset()
        fake_redis = _FakeRedisZSetClient()
        # Cluster slot occupied by another live instance
        fake_redis.zsets["sem:tts:edge"] = {"other-host:1:xyz": rc._now_ms() + 60_000}

        sem = rc.create_tts_semaphore(
            "edge", max_permits=1, lease_ttl_sec=10.0, acquire_timeout_sec=0.06
        )

        with (
            patch.object(rc, "_get_client", return_value=fake_redis),
            pytest.raises(rc.SemaphoreAcquireTimeoutError) as exc_info,
        ):
            async with sem.acquire():
                pass

        assert exc_info.value.backend == "redis"
        assert metrics.redis_semaphore_rejected_total.get() == 1.0
        # Local semaphore must be released cleanly so next call does not deadlock
        fake_redis.zsets["sem:tts:edge"].clear()
        with patch.object(rc, "_get_client", return_value=fake_redis):
            async with sem.acquire(timeout_sec=0.2) as lease:
                assert lease.backend == "redis"
        metrics.reset()

    @pytest.mark.asyncio()
    async def test_redis_outage_degrades_to_local_semaphore_limit(self):
        import asyncio

        failing_client = AsyncMock()
        failing_client.eval.side_effect = ConnectionError("redis unreachable")

        sem = rc.create_ffmpeg_semaphore(
            max_permits=2, lease_ttl_sec=5.0, acquire_timeout_sec=2.0
        )

        active = 0
        max_seen = 0
        backends: list[str] = []

        async def run_job() -> None:
            nonlocal active, max_seen
            async with sem:
                backends.append("ok")
                active += 1
                max_seen = max(max_seen, active)
                await asyncio.sleep(0.04)
                active -= 1

        with patch.object(rc, "_get_client", return_value=failing_client):
            await asyncio.gather(*(run_job() for _ in range(6)))

        # Local semaphore strictly bounded concurrency to 2 despite Redis outage
        assert max_seen <= 2
        assert len(backends) == 6
        # Single-flight tripped circuit breaker once instead of 6 connection storms
        assert failing_client.eval.await_count == 1
        assert rc._disabled_until > 0

    @pytest.mark.asyncio()
    async def test_cancellation_releases_redis_and_local_permits(self):
        import asyncio

        fake_redis = _FakeRedisZSetClient()
        sem = rc.create_ffmpeg_semaphore(max_permits=1, lease_ttl_sec=5.0)
        entered = asyncio.Event()

        async def cancellable_work() -> None:
            async with sem.acquire():
                entered.set()
                await asyncio.sleep(10.0)

        with patch.object(rc, "_get_client", return_value=fake_redis):
            task = asyncio.create_task(cancellable_work())
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # Immediately re-acquiring must succeed without waiting for TTL expiry
            async with sem.acquire(timeout_sec=0.2) as lease:
                assert lease.backend == "redis"
