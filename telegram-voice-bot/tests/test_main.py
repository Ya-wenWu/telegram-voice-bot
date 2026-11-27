"""Tests for main.py startup guards, preflight checks, and secret-safe error handling."""

from unittest.mock import MagicMock, patch

import pytest
from telegram.error import InvalidToken

import main as main_mod


def test_cleanup_stale_tmp_files_removes_only_bot_artifacts(tmp_path):
    stale_dir = tmp_path / "tts_concat_abcd1234"
    stale_dir.mkdir()
    (stale_dir / "part_000.mp3").write_bytes(b"mp3")
    stale_ogg = tmp_path / "voice123.ogg"
    stale_ogg.write_bytes(b"ogg")
    unrelated = tmp_path / "keep.txt"
    unrelated.write_text("keep", encoding="utf-8")

    with patch.object(main_mod, "TMP_DIR", tmp_path):
        removed = main_mod._cleanup_stale_tmp_files()

    assert removed == 2
    assert not stale_dir.exists()
    assert not stale_ogg.exists()
    assert unrelated.exists()


def test_preflight_check_fails_without_required_tokens(tmp_path):
    with (
        patch.object(main_mod, "TELEGRAM_BOT_TOKEN", "your_token_here"),
        patch.object(main_mod, "ZEN_API_KEY", ""),
        patch.object(main_mod, "TMP_DIR", tmp_path / "tmp"),
        patch.object(main_mod, "LOCK_FILE", str(tmp_path / "state" / "bot.lock")),
    ):
        assert main_mod.run_preflight_check() == 1


def test_preflight_check_passes_with_required_tokens(tmp_path):
    with (
        patch.object(main_mod, "TELEGRAM_BOT_TOKEN", "123456:valid-format-token"),
        patch.object(main_mod, "ZEN_API_KEY", "test-api-key"),
        patch.object(main_mod, "ALLOWED_USER_IDS", [12345]),
        patch.object(main_mod, "WHISPER_API_KEY", "test-whisper-key"),
        patch.object(main_mod, "TMP_DIR", tmp_path / "tmp"),
        patch.object(main_mod, "LOCK_FILE", str(tmp_path / "state" / "bot.lock")),
    ):
        assert main_mod.run_preflight_check() == 0
        assert (tmp_path / "tmp").is_dir()
        assert (tmp_path / "state").is_dir()


def test_main_invalid_token_exits_cleanly_without_traceback_and_releases_lock(tmp_path):
    secret_token = f"{123456789}:{'TEST_DUMMY_TOKEN_' + 'X' * 24}"
    fake_app = MagicMock()
    fake_app.run_polling.side_effect = InvalidToken(
        f"The token `{secret_token}` was rejected by the server."
    )
    builder = MagicMock()
    builder.token.return_value = builder
    builder.post_init.return_value = builder
    builder.post_stop.return_value = builder
    builder.concurrent_updates.return_value = builder
    builder.build.return_value = fake_app

    lock_path = tmp_path / "state" / "bot.lock"
    with (
        patch.object(main_mod, "TELEGRAM_BOT_TOKEN", secret_token),
        patch.object(main_mod, "ZEN_API_KEY", "test-zen-key"),
        patch.object(main_mod, "TMP_DIR", tmp_path / "tmp"),
        patch.object(main_mod, "LOCK_FILE", str(lock_path)),
        patch.object(main_mod.Application, "builder", return_value=builder),
        pytest.raises(SystemExit) as exc_info,
    ):
        main_mod.main([])

    assert exc_info.value.code == 1
    assert main_mod._LOCK_FD is None
