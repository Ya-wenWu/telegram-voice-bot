"""Tests for adaptive 1C/1G resource detection and high-concurrency multi-bot scheduling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from bot import redis_client
from bot.memory import ConversationStore
from bot.multi_bot import load_bot_registry
from bot.resource_profile import (
    CONSTRAINED_RAM_THRESHOLD_MB,
    resolve_deployment_profile,
)
from bot.worker import Task, WorkerPool


def test_profile_selects_constrained_1c1g_at_or_below_1gb():
    for ram_mb in (512, 900, CONSTRAINED_RAM_THRESHOLD_MB):
        profile = resolve_deployment_profile(
            override="auto", available_ram_mb=ram_mb, cpu_cores=4
        )
        assert profile.mode == "constrained_1c1g"
        assert profile.cpu_limit == 1
        assert profile.ram_limit_mb == 1024
        assert profile.max_bots == 1
        assert profile.bot_workers == 1
        assert profile.concurrent_updates == 1
        assert profile.bot_queue_maxsize == 10
        assert profile.ffmpeg_concurrency == 1
        assert profile.tts_concurrency == 2
        assert profile.redis_semaphore_enabled is False


def test_profile_selects_high_concurrency_above_1gb():
    profile_2s = resolve_deployment_profile(
        override="auto", available_ram_mb=1536, cpu_cores=2
    )
    assert profile_2s.mode == "high_concurrency"
    assert profile_2s.max_bots >= 2
    assert profile_2s.redis_semaphore_enabled is True

    profile_2m = resolve_deployment_profile(
        override="auto", available_ram_mb=3072, cpu_cores=2
    )
    assert profile_2m.mode == "high_concurrency"
    assert profile_2m.max_bots == 8
    assert profile_2m.bot_workers == 6
    assert profile_2m.ffmpeg_concurrency == 2
    assert profile_2m.tts_concurrency == 10


def test_load_bot_registry_enforces_single_bot_in_1c1g_and_multibot_in_high():
    tokens = "default=111:AAA,support=222:BBB,sales=333:CCC"

    low_profile = resolve_deployment_profile(
        override="auto", available_ram_mb=960, cpu_cores=2
    )
    low_bots = load_bot_registry(
        low_profile, registry_json="", tokens_csv=tokens, default_token=""
    )
    assert len(low_bots) == 1
    assert low_bots[0].bot_id == "default"

    high_profile = resolve_deployment_profile(
        override="auto", available_ram_mb=3072, cpu_cores=2
    )
    high_bots = load_bot_registry(
        high_profile, registry_json="", tokens_csv=tokens, default_token=""
    )
    assert [b.bot_id for b in high_bots] == ["default", "support", "sales"]


def test_worker_pool_weighted_fair_queuing_and_text_priority():
    pool = WorkerPool(num_workers=1, max_queue_size=32)
    dummy_bot = SimpleNamespace()

    # Bot A floods 5 voice tasks before Bot B submits 2 voice tasks
    for i in range(1, 6):
        pool.try_enqueue(
            Task(
                chat_id=100,
                reply_to_message_id=i,
                text=f"A-voice-{i}",
                bot=dummy_bot,  # type: ignore[arg-type]
                is_voice=True,
                bot_id="bot-a",
                bot_weight=1,
            )
        )
    for i in range(1, 3):
        pool.try_enqueue(
            Task(
                chat_id=200,
                reply_to_message_id=i,
                text=f"B-voice-{i}",
                bot=dummy_bot,  # type: ignore[arg-type]
                is_voice=True,
                bot_id="bot-b",
                bot_weight=1,
            )
        )
    # Text task from Bot C must still overtake all voice tasks
    pool.try_enqueue(
        Task(
            chat_id=300,
            reply_to_message_id=1,
            text="C-text-1",
            bot=dummy_bot,  # type: ignore[arg-type]
            is_voice=False,
            bot_id="bot-c",
            bot_weight=1,
        )
    )

    popped: list[str] = []
    while not pool._queue.empty():
        _prio, _vtime, _seq, task = pool._queue.get_nowait()
        popped.append(task.text)

    assert popped[0] == "C-text-1"
    # Bot B's first voice task must be interleaved right after Bot A's first voice task (not starved behind all 5)
    assert popped.index("B-voice-1") < popped.index("A-voice-2")
    assert popped.index("B-voice-2") < popped.index("A-voice-3")


def test_conversation_memory_isolated_per_bot():
    store = ConversationStore(max_turns=5)
    pool = WorkerPool(num_workers=1, memory=store)

    key_default = pool._memory_key("default", 123456)
    key_bot2 = pool._memory_key("bot-2", 123456)
    assert key_default == 123456
    assert key_bot2 == "bot-2:123456"

    store.append_turn(key_default, "hello default", "reply default")
    store.append_turn(key_bot2, "hello bot2", "reply bot2")

    assert store.get_history(key_default)[0]["content"] == "hello default"
    assert store.get_history(key_bot2)[0]["content"] == "hello bot2"

    pool.clear_memory(123456, bot_id="bot-2")
    assert store.get_history(key_bot2) == []
    assert len(store.get_history(key_default)) == 2


@pytest.mark.asyncio
async def test_redis_quota_key_namespaces_additional_bots():
    fake_client = SimpleNamespace(eval=AsyncMock(return_value=1))
    redis_client._disabled_until = 0.0
    redis_client._degraded = False
    redis_client._probing = False

    with patch.object(redis_client, "_get_client", return_value=fake_client):
        assert (
            await redis_client.check_daily_quota(42, limit=10, bot_id="default") is True
        )
        assert (
            await redis_client.check_daily_quota(42, limit=10, bot_id="bot-2") is True
        )

    first_key = fake_client.eval.call_args_list[0].args[2]
    second_key = fake_client.eval.call_args_list[1].args[2]
    assert first_key.startswith("quota:42:")
    assert second_key.startswith("quota:bot-2:42:")
