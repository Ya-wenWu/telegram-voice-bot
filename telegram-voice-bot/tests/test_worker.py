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
async def test_bounded_queue_raises_queue_full(mock_bot):
    pool = WorkerPool(num_workers=1, max_queue_size=1)
    await pool.enqueue(
        Task(chat_id=1, reply_to_message_id=1, text="first", bot=mock_bot)
    )
    with pytest.raises(asyncio.QueueFull):
        await pool.enqueue(
            Task(chat_id=2, reply_to_message_id=2, text="second", bot=mock_bot)
        )


@pytest.mark.asyncio()
async def test_tts_timeout_degrades_gracefully_to_text_only(mock_bot):
    from unittest.mock import patch

    async def slow_tts(_text: str) -> bytes:
        await asyncio.sleep(5)
        return b"audio"

    async def fake_stream(_chat_id: int, _text: str):
        yield "測試文字回覆。"

    mock_bot.edit_message_text = AsyncMock()
    pool = WorkerPool(num_workers=1, tts_timeout=0.05)
    task = Task(
        chat_id=123,
        reply_to_message_id=456,
        text="你好",
        bot=mock_bot,
        is_voice=True,
    )
    with (
        patch("bot.worker.chat_stream", fake_stream),
        patch("bot.worker.tts", slow_tts),
    ):
        await pool._process(task)

    mock_bot.send_audio.assert_not_awaited()
    mock_bot.edit_message_text.assert_awaited()
    assert mock_bot.edit_message_text.await_args.kwargs["text"] == "測試文字回覆。"


@pytest.mark.asyncio()
async def test_concat_mp3_kills_subprocess_on_timeout():
    from unittest.mock import patch

    from bot.worker import _concat_mp3

    killed = False

    class HangingProc:
        returncode = None

        async def wait(self):
            if not killed:
                await asyncio.sleep(5)
            return -9

        def kill(self):
            nonlocal killed
            killed = True
            self.returncode = -9

    with patch(
        "bot.worker.asyncio.create_subprocess_exec",
        AsyncMock(return_value=HangingProc()),
    ):
        result = await _concat_mp3([b"part1", b"part2"], timeout=0.05)

    assert killed is True
    assert result == b"part1"


@pytest.mark.asyncio()
async def test_worker_stop_drains_in_flight_task(mock_bot):
    pool = WorkerPool(num_workers=1)
    finished = False

    async def slow_process(_task):
        nonlocal finished
        await asyncio.sleep(0.15)
        finished = True

    pool._process = slow_process
    await pool.start()
    await pool.enqueue(Task(chat_id=1, reply_to_message_id=1, text="hi", bot=mock_bot))
    await asyncio.sleep(0.02)
    await pool.stop(drain_timeout=2.0)
    assert finished is True


@pytest.mark.asyncio()
async def test_worker_transcribes_voice_by_file_path_and_remembers_turns(mock_bot):
    from unittest.mock import patch

    mock_bot.edit_message_text = AsyncMock()
    voice = MagicMock()
    file_mock = MagicMock()
    file_mock.download_to_drive = AsyncMock()
    voice.get_file = AsyncMock(return_value=file_mock)
    status_msg = MagicMock()
    status_msg.edit_text = AsyncMock()

    seen_histories: list[list[dict[str, str]] | None] = []

    async def fake_stream(_chat_id: int, _text: str, *, history=None):
        seen_histories.append(history)
        yield "回覆內容。"

    mock_transcribe = AsyncMock(return_value="第一句語音")
    pool = WorkerPool(num_workers=1)

    with (
        patch("bot.worker.transcribe", mock_transcribe),
        patch("bot.worker.chat_stream", fake_stream),
        patch("bot.worker.tts", AsyncMock(return_value=b"mp3")),
    ):
        await pool._process(
            Task(
                chat_id=777,
                reply_to_message_id=1,
                text="",
                bot=mock_bot,
                is_voice=True,
                voice=voice,
                status_message=status_msg,
                req_id="101",
            )
        )
        await pool._process(
            Task(
                chat_id=777,
                reply_to_message_id=2,
                text="追問問題",
                bot=mock_bot,
                is_voice=False,
                req_id="102",
            )
        )

    # Voice file streamed by path, not bytes
    arg = mock_transcribe.await_args.args[0]
    assert isinstance(arg, str) and arg.endswith(".ogg")
    # Second turn received the first turn's history
    assert seen_histories[0] is None
    assert seen_histories[1] is not None
    assert seen_histories[1][0] == {"role": "user", "content": "第一句語音"}
    assert seen_histories[1][1] == {"role": "assistant", "content": "回覆內容。"}


@pytest.mark.asyncio()
async def test_worker_handles_voice_transcription_failure(mock_bot):
    from unittest.mock import patch

    voice = MagicMock()
    file_mock = MagicMock()
    file_mock.download_to_drive = AsyncMock()
    voice.get_file = AsyncMock(return_value=file_mock)
    status_msg = MagicMock()
    status_msg.edit_text = AsyncMock()

    pool = WorkerPool(num_workers=1)
    with patch(
        "bot.worker.transcribe", AsyncMock(side_effect=RuntimeError("stt down"))
    ):
        await pool._process(
            Task(
                chat_id=888,
                reply_to_message_id=1,
                text="",
                bot=mock_bot,
                is_voice=True,
                voice=voice,
                status_message=status_msg,
            )
        )

    status_msg.edit_text.assert_awaited_once_with("❌ 語音轉錄失敗，請稍後再試。")
