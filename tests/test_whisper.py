import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from bot.whisper import _probe_duration, _split_audio, transcribe


class TestProbeDuration:
    @pytest.mark.asyncio()
    async def test_short_audio_returns_duration(self):
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (b"2.500000\n", b"")

        with patch("bot.whisper.asyncio.create_subprocess_exec", return_value=mock_proc):
            duration = await _probe_duration(b"fake_audio_data")
            assert duration == 2.5

    @pytest.mark.asyncio()
    async def test_raises_on_invalid_output(self):
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (b"not-a-number\n", b"")

        with patch("bot.whisper.asyncio.create_subprocess_exec", return_value=mock_proc):
            with pytest.raises(ValueError):
                await _probe_duration(b"fake_audio_data")


class TestSplitAudio:
    @pytest.mark.asyncio()
    async def test_short_audio_not_split(self):
        mock_proc = AsyncMock()
        mock_proc.wait.return_value = 0

        with patch("bot.whisper.asyncio.create_subprocess_exec", return_value=mock_proc):
            # ffmpeg returns success but no chunk files exist → fallback
            result = await _split_audio(b"fake_data", 30)
            assert result == [b"fake_data"]

    @pytest.mark.asyncio()
    async def test_ffmpeg_failure_falls_back(self):
        mock_proc = AsyncMock()
        mock_proc.wait.return_value = 1

        with patch("bot.whisper.asyncio.create_subprocess_exec", return_value=mock_proc):
            result = await _split_audio(b"fake_data", 30)
            assert result == [b"fake_data"]


class TestTranscribe:
    @pytest.mark.asyncio()
    async def test_short_audio_calls_transcribe_once(self):
        with patch("bot.whisper._probe_duration", return_value=5.0):
            with patch("bot.whisper._transcribe_chunk", return_value="Hello") as mock_tc:
                result = await transcribe(b"short_audio")
                assert result == "Hello"
                mock_tc.assert_called_once_with(b"short_audio")

    @pytest.mark.asyncio()
    async def test_long_audio_splits_and_combines(self):
        with patch("bot.whisper._probe_duration", return_value=90.0):
            with patch("bot.whisper._split_audio", return_value=[b"chunk1", b"chunk2", b"chunk3"]):
                with patch("bot.whisper._transcribe_chunk", side_effect=["A", "B", "C"]):
                    result = await transcribe(b"long_audio")
                    assert result == "ABC"

    @pytest.mark.asyncio()
    async def test_empty_chunks_handled(self):
        with patch("bot.whisper._probe_duration", return_value=90.0):
            with patch("bot.whisper._split_audio", return_value=[b"", b""]):
                with patch("bot.whisper._transcribe_chunk", return_value=""):
                    result = await transcribe(b"long_audio")
                    assert result == ""
