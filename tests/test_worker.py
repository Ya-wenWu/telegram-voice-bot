import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from bot.worker import Task, WorkerPool


@pytest.fixture()
def mock_bot():
    bot = MagicMock()
    bot.send_message = AsyncMock()
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

    pool._process = tracking_process

    task = Task(
        chat_id=123,
        reply_to_message_id=456,
        text="Hello",
        bot=mock_bot,
    )

    await pool.enqueue(task)
    await asyncio.sleep(0.5)

    assert len(processed) == 1
    assert processed[0].text == "Hello"
    assert processed[0].chat_id == 123

    await pool.stop()


@pytest.mark.asyncio()
async def test_worker_pool_processes_multiple_tasks_concurrently(mock_bot):
    pool = WorkerPool(num_workers=3)
    await pool.start()

    progress = []
    lock = asyncio.Lock()

    original_process = pool._process

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
    await pool.enqueue(
        Task(chat_id=2, reply_to_message_id=2, text="ok", bot=mock_bot)
    )

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
