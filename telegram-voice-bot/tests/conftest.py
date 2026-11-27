import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture(autouse=True)
def _reset_bot_guard():
    """Each test starts with a clean BotGuard.

    The guard tracks per-user request velocity in a module-level singleton. Handler
    tests reuse the same user id back to back, so without a reset the Nth test is
    quarantined as flooding and fails for reasons unrelated to what it tests.
    """
    from bot.bot_guard import default_bot_guard

    default_bot_guard.reset()
    yield
    default_bot_guard.reset()
