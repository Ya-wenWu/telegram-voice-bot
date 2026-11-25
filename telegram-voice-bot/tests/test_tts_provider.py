"""Tests for pluggable TTSProvider implementations (Issue #25)."""

from unittest.mock import AsyncMock, MagicMock, patch

import bot.tts_provider as tp
import pytest


def test_factory_selects_providers():
    with (
        patch.object(tp, "TTS_API_KEY", "k"),
        patch.object(tp, "PIPER_MODEL_PATH", "/models/zh.onnx"),
    ):
        assert isinstance(tp.get_tts_provider("edge"), tp.EdgeTTSProvider)
        assert isinstance(tp.get_tts_provider("openai"), tp.OpenAITTSProvider)
        assert isinstance(tp.get_tts_provider("piper"), tp.PiperTTSProvider)


def test_factory_rejects_unknown_provider():
    with pytest.raises(ValueError, match="Unsupported TTS_PROVIDER"):
        tp.get_tts_provider("unknown")


@pytest.mark.asyncio()
async def test_openai_tts_provider_posts_speech_request():
    resp = MagicMock()
    resp.status_code = 200
    resp.content = b"mp3-bytes"
    resp.headers = {}
    client = MagicMock()
    client.is_closed = False
    client.post = AsyncMock(return_value=resp)

    provider = tp.OpenAITTSProvider(
        api_base="https://api.openai.com/v1/",
        api_key="test-key",
        model="tts-1",
        voice="alloy",
    )
    with patch("bot.http_client.get_client", return_value=client):
        data = await provider.synthesize("hello")

    assert data == b"mp3-bytes"
    client.post.assert_awaited_once()
    url = client.post.await_args.args[0]
    assert url == "https://api.openai.com/v1/audio/speech"


@pytest.mark.asyncio()
async def test_piper_tts_provider_requires_model_path():
    provider = tp.PiperTTSProvider(binary="piper", model_path="")
    with pytest.raises(RuntimeError, match="PIPER_MODEL_PATH"):
        await provider.synthesize("hello")
