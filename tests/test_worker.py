import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import bot.worker as worker_mod
from bot.worker import Task, WorkerPool


@pytest.fixture()
def mock_bot():
    bot = MagicMock()
    placeholder = MagicMock()
    placeholder.message_id = 999
    bot.send_message = AsyncMock(return_value=placeholder)
    bot.edit_message_text = AsyncMock()
    bot.send_audio = AsyncMock()
    bot.send_chat_action = AsyncMock()
    return bot


@pytest.mark.asyncio()
async def test_worker_pool_start_stop():
    pool = WorkerPool(num_workers=2)
    await pool.start()
    assert len(pool._workers) == 2
    assert all(not w.done() for w in pool._workers)
    await pool.stop()
    assert all(w.done() for w in pool._workers)


@pytest.mark.asyncio()
async def test_worker_processes_single_task(mock_bot):
    pool = WorkerPool(num_workers=1)
    await pool.start()

    original_process = pool._process
    processed = []

    async def tracking_process(task):
        processed.append(task)
        await original_process(task)

    async def fake_stream(chat_id, text):
        yield "Hello back!"

    pool._process = tracking_process

    task = Task(
        chat_id=123,
        reply_to_message_id=456,
        text="Hello",
        bot=mock_bot,
    )

    with patch.object(worker_mod, "chat_stream", fake_stream):
        await pool.enqueue(task)
        await asyncio.sleep(0.2)

    assert len(processed) == 1
    assert processed[0].text == "Hello"
    assert processed[0].chat_id == 123
    mock_bot.edit_message_text.assert_any_await(
        chat_id=123, message_id=999, text="Hello back!"
    )

    await pool.stop()


@pytest.mark.asyncio()
async def test_worker_pool_processes_multiple_tasks_concurrently(mock_bot):
    pool = WorkerPool(num_workers=3)
    await pool.start()

    progress = []
    lock = asyncio.Lock()

    async def slow_process(task):
        async with lock:
            progress.append(f"start:{task.text}")
        await asyncio.sleep(0.3)
        async with lock:
            progress.append(f"end:{task.text}")

    pool._process = slow_process

    for i in range(3):
        await pool.enqueue(
            Task(
                chat_id=100 + i,
                reply_to_message_id=200 + i,
                text=f"msg-{i}",
                bot=mock_bot,
            )
        )

    await asyncio.sleep(0.5)

    start_count = sum(1 for p in progress if p.startswith("start:"))
    assert start_count == 3, f"Expected 3 tasks started, got {start_count}"

    await pool.stop()


@pytest.mark.asyncio()
async def test_task_error_does_not_crash_worker(mock_bot):
    pool = WorkerPool(num_workers=1)
    await pool.start()

    call_count = 0

    async def failing_process(task):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise ValueError("Simulated error")

    pool._process = failing_process

    await pool.enqueue(
        Task(chat_id=1, reply_to_message_id=1, text="fail", bot=mock_bot)
    )
    await pool.enqueue(Task(chat_id=2, reply_to_message_id=2, text="ok", bot=mock_bot))

    await asyncio.sleep(0.5)

    assert call_count == 2
    assert mock_bot.send_message.call_count >= 1

    await pool.stop()


@pytest.mark.asyncio()
async def test_enqueue_multiple_tasks_with_limited_workers():
    pool = WorkerPool(num_workers=2)
    await pool.start()

    active = 0
    max_active = 0
    lock = asyncio.Lock()

    async def controlled_process(task):
        nonlocal active, max_active
        async with lock:
            active += 1
            max_active = max(max_active, active)
        await asyncio.sleep(0.2)
        async with lock:
            active -= 1

    pool._process = controlled_process

    for i in range(4):
        bot = MagicMock()
        bot.send_message = AsyncMock()
        bot.send_audio = AsyncMock()
        bot.send_chat_action = AsyncMock()
        await pool.enqueue(
            Task(chat_id=i, reply_to_message_id=i, text=f"msg-{i}", bot=bot)
        )

    await asyncio.sleep(0.6)

    assert max_active <= 2, f"Expected at most 2 concurrent tasks, got {max_active}"

    await pool.stop()


@pytest.mark.asyncio()
async def test_enqueue_raises_when_queue_full(mock_bot):
    pool = WorkerPool(num_workers=1, max_queue_size=1)
    task = Task(chat_id=1, reply_to_message_id=1, text="a", bot=mock_bot)
    await pool.enqueue(task)
    with pytest.raises(asyncio.QueueFull):
        await pool.enqueue(task)


@pytest.mark.asyncio()
async def test_stream_failure_falls_back_and_truncates_response(mock_bot):
    pool = WorkerPool(num_workers=1)

    async def broken_stream(chat_id, text):
        yield "partial"
        raise httpx.ReadError("reset")

    huge_reply = "A" * (worker_mod.MAX_RESPONSE_CHARS + 500)
    task = Task(chat_id=1, reply_to_message_id=2, text="hi", bot=mock_bot)

    with (
        patch.object(worker_mod, "chat_stream", broken_stream),
        patch.object(worker_mod, "chat", AsyncMock(return_value=huge_reply)),
    ):
        await pool._process(task)

    delivered = mock_bot.edit_message_text.await_args_list[-1].kwargs["text"]
    followups = [
        call.kwargs["text"]
        for call in mock_bot.send_message.await_args_list[1:]
        if "text" in call.kwargs
    ]
    total_len = len(delivered) + sum(len(c) for c in followups)
    assert total_len == worker_mod.MAX_RESPONSE_CHARS


@pytest.mark.asyncio()
async def test_voice_tts_respects_char_and_sentence_budgets(mock_bot):
    pool = WorkerPool(num_workers=1)
    spoken: list[str] = []

    async def fake_stream(chat_id, text):
        yield "第一句。"
        yield "第二句很長很長很長。"
        yield "第三句不該被唸到"

    async def fake_tts(fragment: str) -> bytes:
        spoken.append(fragment)
        return b"mp3"

    task = Task(
        chat_id=1, reply_to_message_id=2, text="hi", bot=mock_bot, is_voice=True
    )

    with (
        patch.object(worker_mod, "chat_stream", fake_stream),
        patch.object(worker_mod, "tts", side_effect=fake_tts),
        patch.object(worker_mod, "_concat_mp3", AsyncMock(return_value=b"combined")),
        patch.object(worker_mod, "TTS_MAX_CHARS", 8),
    ):
        await pool._process(task)

    assert sum(len(s) for s in spoken) == 8
    assert spoken[0] == "第一句。"
    assert len(spoken) == 2
    mock_bot.send_audio.assert_awaited_once()


@pytest.mark.asyncio()
async def test_stop_cancels_in_flight_tts_tasks(mock_bot):
    pool = WorkerPool(num_workers=1)
    tts_started = asyncio.Event()
    tts_cancelled = asyncio.Event()

    async def slow_stream(chat_id, text):
        yield "第一句。"
        await asyncio.sleep(10)

    async def slow_tts(fragment: str) -> bytes:
        tts_started.set()
        try:
            await asyncio.sleep(10)
            return b"mp3"
        except asyncio.CancelledError:
            tts_cancelled.set()
            raise

    await pool.start()
    task = Task(
        chat_id=1, reply_to_message_id=2, text="hi", bot=mock_bot, is_voice=True
    )

    with (
        patch.object(worker_mod, "chat_stream", slow_stream),
        patch.object(worker_mod, "tts", side_effect=slow_tts),
    ):
        await pool.enqueue(task)
        await asyncio.wait_for(tts_started.wait(), timeout=2.0)
        await pool.stop()

    assert tts_cancelled.is_set()
