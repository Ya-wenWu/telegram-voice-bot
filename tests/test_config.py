import importlib
import logging
from pathlib import Path

import bot.config as cfg
from bot.config import _parse_user_ids, get_int


def test_parses_comma_separated_ids():
    assert _parse_user_ids("123, 456,789") == [123, 456, 789]


def test_empty_string_means_nobody():
    assert _parse_user_ids("") == []
    assert _parse_user_ids(" , ,") == []


def test_invalid_entries_are_skipped_not_fatal(caplog):
    with caplog.at_level(logging.WARNING, logger="bot.config"):
        assert _parse_user_ids("123,abc,456") == [123, 456]
    assert "abc" in caplog.text


def test_get_int_falls_back_on_invalid_value(monkeypatch):
    monkeypatch.setenv("TEST_INT_KEY", "not-a-number")
    assert get_int("TEST_INT_KEY", 42) == 42


def test_get_int_parses_valid_value(monkeypatch):
    monkeypatch.setenv("TEST_INT_KEY", "7")
    assert get_int("TEST_INT_KEY", 42) == 7


def test_tmp_dir_expands_tilde(monkeypatch):
    monkeypatch.setenv("TMP_DIR", "~/.cache/custom-bot-tmp")
    try:
        reloaded = importlib.reload(cfg)
        assert reloaded.TMP_DIR == Path.home() / ".cache" / "custom-bot-tmp"
        assert "~" not in str(reloaded.TMP_DIR)
    finally:
        monkeypatch.delenv("TMP_DIR", raising=False)
        importlib.reload(cfg)
