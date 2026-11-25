from unittest.mock import AsyncMock, MagicMock, patch

import bot.http_client as http_client_mod
import pytest
from bot.whisper import MAX_AUDIO_BYTES, _endpoint, _transcribe_chunk, transcribe


@pytest.fixture(autouse=True)
def _reset_client():
    http_client_mod._client = None
    yield
    http_client_mod._client = None


def _mock_http(response=None, side_effect=None):
    """Patch httpx.AsyncClient with a mock client instance."""
    client = MagicMock()
    client.is_closed = False
    client.post = AsyncMock(return_value=response, side_effect=side_effect)
    return patch("bot.http_client.httpx.AsyncClient", return_value=client), client


class TestTranscribe:
    @pytest.mark.asyncio()
    async def test_empty_audio_returns_empty(self):
        assert await transcribe(b"") == ""

    @pytest.mark.asyncio()
    async def test_oversized_audio_rejected(self):
        with pytest.raises(ValueError, match="25 MB"):
            await transcribe(b"x" * (MAX_AUDIO_BYTES + 1))

    @pytest.mark.asyncio()
    async def test_delegates_to_chunk(self):
        with patch(
            "bot.whisper._transcribe_chunk", AsyncMock(return_value="你好")
        ) as mock_tc:
            result = await transcribe(b"short_audio")
            assert result == "你好"
            mock_tc.assert_awaited_once_with(b"short_audio")

    @pytest.mark.asyncio()
    async def test_file_path_is_streamed(self, tmp_path):
        audio = tmp_path / "voice.ogg"
        audio.write_bytes(b"file-audio")

        async def fake_chunk(handle):
            return handle.read().decode()

        with patch("bot.whisper._transcribe_chunk", side_effect=fake_chunk):
            assert await transcribe(audio) == "file-audio"

    @pytest.mark.asyncio()
    async def test_oversized_file_rejected(self, tmp_path):
        audio = tmp_path / "big.ogg"
        audio.write_bytes(b"x" * (MAX_AUDIO_BYTES + 1))
        with pytest.raises(ValueError, match="25 MB"):
            await transcribe(audio)


class TestEndpoint:
    def test_hosted_uses_bearer_auth(self):
        with (
            patch("bot.whisper.WHISPER_URL", ""),
            patch("bot.whisper.WHISPER_API_BASE", "https://api.groq.com/openai/v1/"),
            patch("bot.whisper.WHISPER_API_KEY", "test-key"),
        ):
            url, headers = _endpoint()
            assert url == "https://api.groq.com/openai/v1/audio/transcriptions"
            assert headers == {"Authorization": "Bearer test-key"}

    def test_self_hosted_has_no_auth(self):
        with (
            patch("bot.whisper.WHISPER_URL", "http://127.0.0.1:12017/"),
            patch("bot.whisper.WHISPER_API_KEY", ""),
        ):
            url, headers = _endpoint()
            assert url == "http://127.0.0.1:12017/v1/audio/transcriptions"
            assert headers == {}

    def test_missing_key_raises(self):
        with (
            patch("bot.whisper.WHISPER_URL", ""),
            patch("bot.whisper.WHISPER_API_KEY", ""),
            pytest.raises(RuntimeError, match="WHISPER_API_KEY"),
        ):
            _endpoint()


class TestTranscribeChunk:
    @pytest.mark.asyncio()
    async def test_sends_file_and_parses_text(self):
        response = MagicMock()
        response.json.return_value = {"text": "測試轉錄"}
        patcher, client = _mock_http(response=response)

        with (
            patcher,
            patch("bot.whisper.WHISPER_URL", ""),
            patch("bot.whisper.WHISPER_API_BASE", "https://api.groq.com/openai/v1"),
            patch("bot.whisper.WHISPER_API_KEY", "test-key"),
            patch("bot.whisper.WHISPER_MODEL", "whisper-large-v3-turbo"),
        ):
            result = await _transcribe_chunk(b"audio-bytes")

        assert result == "測試轉錄"
        client.post.assert_awaited_once()
        _, kwargs = client.post.await_args
        assert kwargs["headers"] == {"Authorization": "Bearer test-key"}
        assert kwargs["data"]["model"] == "whisper-large-v3-turbo"
        assert kwargs["data"]["language"] == "zh"
        assert kwargs["files"]["file"][0] == "audio.ogg"

    @pytest.mark.asyncio()
    async def test_missing_text_returns_empty(self):
        response = MagicMock()
        response.json.return_value = {}
        patcher, _ = _mock_http(response=response)

        with (
            patcher,
            patch("bot.whisper.WHISPER_URL", "http://localhost:9000"),
        ):
            assert await _transcribe_chunk(b"audio") == ""

    @pytest.mark.asyncio()
    async def test_retries_on_429_then_succeeds(self):
        retry = MagicMock(status_code=429)
        ok = MagicMock(status_code=200)
        ok.json.return_value = {"text": "重試成功"}
        client = MagicMock()
        client.post = AsyncMock(side_effect=[retry, ok])

        with (
            patch("bot.http_client.get_client", return_value=client),
            patch("bot.retry.asyncio.sleep", AsyncMock()),
            patch("bot.whisper.WHISPER_URL", "http://localhost:9000"),
        ):
            assert await _transcribe_chunk(b"audio") == "重試成功"

        assert client.post.await_count == 2

    @pytest.mark.asyncio()
    async def test_http_error_propagates(self):
        response = MagicMock()
        response.raise_for_status.side_effect = ValueError("HTTP 401")
        patcher, _ = _mock_http(response=response)

        with (
            patcher,
            patch("bot.whisper.WHISPER_URL", "http://localhost:9000"),
            pytest.raises(ValueError, match="HTTP 401"),
        ):
            await _transcribe_chunk(b"audio")
