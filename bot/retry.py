"""Shared retry helper for outbound HTTP calls.

Retries transient failures (rate limits and 5xx) with exponential backoff and
honours ``Retry-After`` when the server provides it. A retry that would block
the bot for longer than :data:`MAX_RETRY_WAIT` is skipped so a long provider
back-off cannot stall the single worker.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx

logger = logging.getLogger(__name__)

MAX_RETRIES = 2
MAX_RETRY_WAIT = 10.0
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


def retry_after_seconds(resp: httpx.Response) -> float | None:
    """Parse ``Retry-After`` (seconds or HTTP-date) into seconds."""
    try:
        raw = resp.headers.get("retry-after")
    except Exception:  # noqa: BLE001 - headers must never break retries
        return None
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        pass
    try:
        when = parsedate_to_datetime(str(raw))
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


async def request_with_retry(
    send: Callable[[], Awaitable[httpx.Response]],
    *,
    label: str,
) -> httpx.Response:
    """Call ``send`` until it succeeds, hits a fatal status, or gives up."""
    for attempt in range(MAX_RETRIES + 1):
        resp = await send()
        if resp.status_code not in RETRY_STATUS or attempt == MAX_RETRIES:
            return resp

        hinted = retry_after_seconds(resp)
        delay = hinted if hinted is not None else float(2**attempt)
        if delay > MAX_RETRY_WAIT:
            logger.warning(
                "%s returned %d with Retry-After %.0fs (cap %.0fs); not retrying",
                label,
                resp.status_code,
                delay,
                MAX_RETRY_WAIT,
            )
            return resp

        logger.warning(
            "%s returned %d; retrying in %.1fs", label, resp.status_code, delay
        )
        await asyncio.sleep(delay)
    return resp  # pragma: no cover - the loop always returns
