import shutil
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from bot.opencode_client import chat_stream

_has_ffmpeg = shutil.which("ffmpeg") is not None
from bot.worker import _concat_mp3, _scan_sentences, _split_sentences


# ── _split_sentences ────────────────────────────────────────────────────────

class TestSplitSentences:
    def test_chinese_sentence_endings(self):
        result = _split_sentences("你好。請問有什麼需要幫忙的嗎？第一個句子。第二句！")
        assert result == ["你好。", "請問有什麼需要幫忙的嗎？", "第一個句子。", "第二句！"]

    def test_english_sentence_endings(self):
        result = _split_sentences("Hello. How are you? I'm fine! Done\nNext")
        assert result == ["Hello.", "How are you?", "I'm fine!", "Done", "Next"]

    def test_mixed_chinese_english(self):
        result = _split_sentences("好的。This is good。繼續！")
        assert result == ["好的。", "This is good。", "繼續！"]

    def test_no_sentence_ending(self):
        result = _split_sentences("這是一段沒有句號的文字")
        assert result == ["這是一段沒有句號的文字"]

    def test_empty_string(self):
        assert _split_sentences("") == []

    def test_only_punctuation(self):
        result = _split_sentences("。。。")
        assert result == ["。", "。", "。"]

    def test_multiple_sentences_same_line(self):
        result = _split_sentences("A。B！C？D")
        assert result == ["A。", "B！", "C？", "D"]

    def test_trailing_text_without_ending(self):
        result = _split_sentences("開始。中間。最後一句")
        assert result == ["開始。", "中間。", "最後一句"]

    def test_whitespace_only(self):
        assert _split_sentences("   ") == []
        assert _split_sentences("\n\n") == []

    def test_semicolon_as_boundary(self):
        result = _split_sentences("第一；第二；第三")
        assert result == ["第一；", "第二；", "第三"]

    def test_mixed_boundary_and_trailing(self):
        result = _split_sentences("你好！我叫小美。請問你")
        assert result == ["你好！", "我叫小美。", "請問你"]

    def test_newline_as_boundary(self):
        result = _split_sentences("line1\nline2\nline3")
        assert result == ["line1", "line2", "line3"]


# ── _concat_mp3 ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio()
async def test_concat_single_part_returns_as_is():
    result = await _concat_mp3([b"single_data"])
    assert result == b"single_data"


@pytest.mark.asyncio()
async def test_concat_empty_list_returns_empty():
    result = await _concat_mp3([])
    assert result == b""


@pytest.mark.skipif(not _has_ffmpeg, reason="ffmpeg not installed")
@pytest.mark.asyncio()
async def test_concat_multiple_parts_with_ffmpeg():
    part1 = b"\xff\xfb\x90\x00data1"
    part2 = b"\xff\xfb\x90\x00data2"
    result = await _concat_mp3([part1, part2])
    assert isinstance(result, bytes)
    assert len(result) > 0


@pytest.mark.asyncio()
async def test_concat_ffmpeg_failure_falls_back():
    with patch("bot.worker.asyncio.create_subprocess_exec") as mock_exec:
        proc = AsyncMock()
        proc.wait.return_value = 1
        mock_exec.return_value = proc
        result = await _concat_mp3([b"fallback_data", b"other"])
        assert result == b"fallback_data"


@pytest.mark.asyncio()
async def test_concat_missing_ffmpeg_raises():
    with patch("bot.worker.asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        with pytest.raises(FileNotFoundError):
            await _concat_mp3([b"a", b"b"])


@pytest.mark.skipif(not _has_ffmpeg, reason="ffmpeg not installed")
@pytest.mark.asyncio()
async def test_concat_large_number_of_parts():
    parts = [f"part_{i:03d}:".encode() for i in range(20)]
    result = await _concat_mp3(parts)
    assert isinstance(result, bytes)
    assert len(result) > 0


# ── chat_stream SSE parsing ─────────────────────────────────────────────────

class TestChatStream:
    """Chat stream uses httpx.AsyncClient with streaming POST.
    
    We mock by replacing httpx.AsyncClient with a factory
    that returns a mock client with a mock stream().
    """

    @pytest.fixture()
    def mock_http(self):
        with patch("bot.opencode_client.httpx.AsyncClient") as MockClient:
            mock_client = MagicMock()
            MockClient.return_value.__aenter__.return_value = mock_client
            yield mock_client

    def _make_stream_cm(
        self,
        lines: list[str] | None = None,
        mock_response: MagicMock | None = None,
        *,
        aiter_lines_fn=None,
    ):
        """Create a callable that acts like client.stream() returning a context manager.
        
        Provide *lines* for a simple line-by-line async generator,
        or *aiter_lines_fn* for custom stream behavior (e.g. raising an error mid-stream).
        """
        if mock_response is None:
            mock_response = MagicMock()
        if aiter_lines_fn:
            mock_response.aiter_lines = aiter_lines_fn
        elif lines is not None:
            async def _gen():
                for line in lines:
                    yield line
            mock_response.aiter_lines = _gen
        mock_stream_value = MagicMock()
        mock_stream_value.__aenter__.return_value = mock_response
        mock_stream_value.__aexit__ = AsyncMock(return_value=None)
        return MagicMock(return_value=mock_stream_value)

    @pytest.mark.asyncio()
    async def test_yields_content_tokens(self, mock_http):
        mock_response = MagicMock()
        mock_http.stream = self._make_stream_cm([
            'data: {"choices":[{"delta":{"content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"。"}}]}',
            "data: [DONE]",
        ], mock_response)

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == ["你好", "。"]

    @pytest.mark.asyncio()
    async def test_skips_non_content_delta(self, mock_http):
        mock_response = MagicMock()
        mock_http.stream = self._make_stream_cm([
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            "data: [DONE]",
        ], mock_response)

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == ["Hello"]

    @pytest.mark.asyncio()
    async def test_handles_json_decode_error(self, mock_http):
        mock_response = MagicMock()
        mock_http.stream = self._make_stream_cm([
            "data: not-valid-json",
            'data: {"choices":[{"delta":{"content":"still works"}}]}',
            "data: [DONE]",
        ], mock_response)

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == ["still works"]

    @pytest.mark.asyncio()
    async def test_handles_empty_content(self, mock_http):
        mock_response = MagicMock()
        mock_http.stream = self._make_stream_cm([
            'data: {"choices":[{"delta":{"content":null}}]}',
            'data: {"choices":[{"delta":{}}]}',
            "data: [DONE]",
        ], mock_response)

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == []

    @pytest.mark.asyncio()
    async def test_raises_on_http_error(self, mock_http):
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = ValueError("HTTP 500")
        mock_http.stream = self._make_stream_cm([
            "data: [DONE]",
        ], mock_response)

        with pytest.raises(ValueError, match="HTTP 500"):
            async for _ in chat_stream(0, "test"):
                pass

    @pytest.mark.asyncio()
    async def test_preserves_token_order(self, mock_http):
        mock_response = MagicMock()
        chars = "hello"
        mock_http.stream = self._make_stream_cm(
            [f'data: {{"choices":[{{"delta":{{"content":"{c}"}}}}]}}' for c in chars]
            + ["data: [DONE]"],
            mock_response,
        )

        result = ""
        async for token in chat_stream(0, "test"):
            result += token
        assert result == "hello"

    @pytest.mark.asyncio()
    async def test_read_error_ends_gracefully(self, mock_http):
        async def aiter_lines():
            yield 'data: {"choices":[{"delta":{"content":"partial"}}]}'
            raise httpx.ReadError("Connection reset")
        mock_http.stream = self._make_stream_cm(
            aiter_lines_fn=aiter_lines,
        )

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == ["partial"]

    @pytest.mark.asyncio()
    async def test_timeout_ends_gracefully(self, mock_http):
        async def aiter_lines():
            yield 'data: {"choices":[{"delta":{"content":"超時前"}}]}'
            yield 'data: {"choices":[{"delta":{"content":"的內容"}}]}'
            raise httpx.TimeoutException("Read timeout")
        mock_http.stream = self._make_stream_cm(
            aiter_lines_fn=aiter_lines,
        )

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == ["超時前", "的內容"]

    @pytest.mark.asyncio()
    async def test_remote_protocol_error_ends_gracefully(self, mock_http):
        async def aiter_lines():
            yield ''  # dummy → makes it an async generator, not coroutine
            raise httpx.RemoteProtocolError("Server disconnected")
        mock_http.stream = self._make_stream_cm(
            aiter_lines_fn=aiter_lines,
        )

        tokens = []
        async for token in chat_stream(0, "test"):
            tokens.append(token)
        assert tokens == []

    @pytest.mark.asyncio()
    async def test_non_httpx_error_still_propagates(self, mock_http):
        async def aiter_lines():
            yield ''
            raise RuntimeError("Unexpected")
        mock_http.stream = self._make_stream_cm(
            aiter_lines_fn=aiter_lines,
        )
        with pytest.raises(RuntimeError, match="Unexpected"):
            async for _ in chat_stream(0, "test"):
                pass


# ── _scan_sentences ─────────────────────────────────────────────────────────

class TestScanSentences:
    """Test the production function ``_scan_sentences`` directly.
    
    Each test simulates the streaming loop: accumulate *full_text* across
    tokens, call ``_scan_sentences(full_text, pos)`` on each token, and
    verify the accumulated output.
    """

    def _run(self, tokens: list[str], min_len: int = 4) -> list[str]:
        dispatched: list[str] = []
        full_text = ""
        pos = 0
        for token in tokens:
            full_text += token
            pos, found = _scan_sentences(full_text, pos, min_len)
            dispatched.extend(found)
        return dispatched

    def test_single_complete_sentence(self):
        assert self._run(["今天天氣真好。"]) == ["今天天氣真好。"]

    def test_multiple_sentences_sequential(self):
        assert self._run(["第一句。", "第二句。", "第三句。"]) == [
            "第一句。", "第二句。", "第三句。",
        ]

    def test_partial_then_complete(self):
        assert self._run(["今天", "天氣", "真好。"]) == ["今天天氣真好。"]

    def test_short_fragments_skipped(self):
        assert self._run(["AB。", "長句子。"]) == ["長句子。"]

    def test_mixed_partial_sentences(self):
        assert self._run(["這是一", "個測試。第二個", "句子。最後一", "句。"]) == [
            "這是一個測試。", "第二個句子。", "最後一句。",
        ]

    def test_no_duplicate_on_identical_tokens(self):
        assert self._run(["第一句。", "第一句。"]) == ["第一句。", "第一句。"]

    def test_overlapping_content(self):
        assert self._run(["第一句。", "第一句。第二句。"]) == [
            "第一句。", "第一句。", "第二句。",
        ]

    def test_stress_many_tokens(self):
        result = self._run([f"第{i}句。" for i in range(50)])
        assert len(result) == 50
        assert result[0] == "第0句。"
        assert result[-1] == "第49句。"

    def test_inline_newline_boundary(self):
        assert self._run(["line1\nline2\nlong_enough\n"]) == [
            "line1", "line2", "long_enough",
        ]

    def test_no_sentence_boundary_at_all(self):
        assert self._run(["這是一段話"]) == []

    def test_min_len_parameter(self):
        assert self._run(["AB。", "CD。", "EFGH。"], min_len=2) == [
            "AB。", "CD。", "EFGH。",
        ]

    def test_pos_resume_across_tokens(self):
        full = "第一句。第二句。第三句。"
        pos, result = _scan_sentences(full, 0)
        assert result == ["第一句。", "第二句。", "第三句。"]
        pos, result = _scan_sentences(full, pos)
        assert result == []
