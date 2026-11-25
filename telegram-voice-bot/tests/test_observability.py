"""Unit & integration tests for Prometheus metrics, /health, /ready, JSON logging, and tracing."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import bot.handlers as handlers_mod
import bot.redis_client as redis_mod
import bot.worker as worker_mod
from bot.logging_context import RequestIdFilter, req_id_var
from bot.observability import (
    JsonTokenRedactingFormatter,
    ObservabilityServer,
    clear_recent_spans,
    get_recent_spans,
    metrics,
    start_span,
)
from bot.worker import WorkerPool


SERVER_DOMAIN:int = "127.0.0.1"

async def _http_request(
    port: int, method: str, path: str
) -> tuple[int, dict[str, str], str]:
    reader, writer = await asyncio.open_connection(SERVER_DOMAIN, port)
    try:
        writer.write(
            f"{method} {path} HTTP/1.1\r\nHost: {SERVER_DOMAIN}\r\n\r\n".encode("ascii")
        )
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), timeout=3.0)
    finally:
        writer.close()
        await writer.wait_closed()

    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, body.decode("utf-8")


class TestPrometheusMetrics:
    def test_renders_all_required_metrics_in_prometheus_format(self):
        metrics.reset()
        metrics.queue_depth.set(3)
        metrics.tts_wait_seconds.observe(0.12)
        metrics.tts_wait_seconds.observe(0.65)
        metrics.ffmpeg_queue_length.inc()
        metrics.request_duration_seconds.observe(1.42)
        metrics.redis_failures_total.inc(2)

        text = metrics.render_prometheus()
        assert "# TYPE queue_depth gauge" in text
        assert "queue_depth 3" in text
        assert "# TYPE tts_wait_seconds histogram" in text
        assert 'tts_wait_seconds_bucket{le="0.25"} 1' in text
        assert 'tts_wait_seconds_bucket{le="1"} 2' in text
        assert 'tts_wait_seconds_bucket{le="+Inf"} 2' in text
        assert "tts_wait_seconds_count 2" in text
        assert "# TYPE ffmpeg_queue_length gauge" in text
        assert "ffmpeg_queue_length 1" in text
        assert "# TYPE request_duration_seconds histogram" in text
        assert "request_duration_seconds_count 1" in text
        assert "# TYPE redis_failures_total counter" in text
        assert "redis_failures_total 2" in text
        metrics.reset()

    @pytest.mark.asyncio()
    async def test_redis_failure_increments_counter(self):
        metrics.reset()
        failing_client = MagicMock()
        failing_client.eval = AsyncMock(side_effect=ConnectionError("redis down"))
        with (
            patch.object(redis_mod, "_get_client", return_value=failing_client),
            patch.object(redis_mod, "_disabled_until", 0.0),
        ):
            allowed = await redis_mod.check_daily_quota(12345, limit=10)
        assert allowed is True
        assert metrics.redis_failures_total.get() == 1.0
        metrics.reset()


class TestObservabilityHttpServer:
    @pytest.mark.asyncio()
    async def test_health_ready_metrics_endpoints(self):
        metrics.reset()
        metrics.queue_depth.set(2)
        is_ready = True

        def readiness():
            return is_ready, {"worker_pool": {"running": is_ready}}

        server = ObservabilityServer(
            host=SERVER_DOMAIN,
            port=0,
            readiness_check=readiness,
            service_name="telegram-voice-bot",
        )
        await server.start()
        try:
            port = server.bound_port
            assert port is not None

            # /health (liveness)
            status, headers, body = await _http_request(port, "GET", "/health")
            assert status == 200
            assert "application/json" in headers["content-type"]
            health_data = json.loads(body)
            assert health_data["status"] == "ok"
            assert health_data["service"] == "telegram-voice-bot"

            # /ready -> 200 when ready
            status, _, body = await _http_request(port, "GET", "/ready")
            assert status == 200
            assert json.loads(body)["status"] == "ready"

            # /ready -> 503 when not ready
            is_ready = False
            status, _, body = await _http_request(port, "GET", "/ready")
            assert status == 503
            assert json.loads(body)["status"] == "not_ready"

            # /metrics -> Prometheus exposition format
            status, headers, body = await _http_request(port, "GET", "/metrics")
            assert status == 200
            assert "text/plain" in headers["content-type"]
            assert "queue_depth 2" in body
            assert "tts_wait_seconds_count" in body
            assert "ffmpeg_queue_length" in body
            assert "request_duration_seconds_count" in body
            assert "redis_failures_total" in body

            # /unknown -> 404 & POST -> 405
            status, _, _ = await _http_request(port, "GET", "/unknown")
            assert status == 404
            status, _, _ = await _http_request(port, "POST", "/health")
            assert status == 405
        finally:
            await server.stop()
            metrics.reset()


class TestStructuredJsonLogging:
    def test_json_log_contains_trace_id_span_id_and_redacts_secrets(self):
        formatter = JsonTokenRedactingFormatter(["secret_token_99999"])
        req_tok = req_id_var.set("req-42")
        try:
            with start_span("unit.test.span") as span:
                try:
                    raise RuntimeError("boom secret_token_99999")
                except RuntimeError:
                    exc_info = sys.exc_info()

                record = logging.LogRecord(
                    name="bot.test",
                    level=logging.ERROR,
                    pathname=__file__,
                    lineno=1,
                    msg="failed with %s",
                    args=("secret_token_99999",),
                    exc_info=exc_info,
                )
                RequestIdFilter().filter(record)
                raw = formatter.format(record)
        finally:
            req_id_var.reset(req_tok)

        parsed = json.loads(raw)
        assert parsed["level"] == "ERROR"
        assert parsed["logger"] == "bot.test"
        assert parsed["req_id"] == "req-42"
        assert parsed["trace_id"] == span.trace_id
        assert parsed["span_id"] == span.span_id
        assert len(parsed["trace_id"]) == 32
        assert len(parsed["span_id"]) == 16
        assert "secret_token_99999" not in raw
        assert "***REDACTED***" in parsed["message"]
        assert "***REDACTED***" in parsed["exception"]


class TestEndToEndTracingAndWorkerMetrics:
    @pytest.mark.asyncio()
    async def test_handler_to_queue_to_worker_to_tts_to_reply_trace_chain(self):
        metrics.reset()
        clear_recent_spans()

        pool = WorkerPool(num_workers=1, max_queue_size=4)
        await pool.start()

        bot = MagicMock()
        sent = MagicMock()
        sent.message_id = 777
        bot.send_message = AsyncMock(return_value=sent)
        bot.edit_message_text = AsyncMock()
        bot.send_chat_action = AsyncMock()
        bot.send_audio = AsyncMock()

        update = MagicMock()
        update.update_id = 9001
        update.effective_user.id = 12345
        update.effective_chat.id = 555
        update.message.message_id = 101
        update.message.voice = MagicMock(file_size=1024)
        status_msg = MagicMock()
        status_msg.edit_text = AsyncMock()
        update.message.reply_text = AsyncMock(return_value=status_msg)

        context = MagicMock()
        context.bot = bot

        async def fake_stream(chat_id, text, history=None):
            yield "你好。"
            yield "測試完成。"

        try:
            with (
                patch.object(handlers_mod, "ALLOWED_USER_IDS", [12345]),
                patch.object(handlers_mod, "_last_request", {}),
                patch.object(handlers_mod, "worker_pool", pool),
                patch.object(
                    handlers_mod, "check_daily_quota", AsyncMock(return_value=True)
                ),
                patch.object(
                    worker_mod,
                    "_download_and_transcribe_voice",
                    AsyncMock(return_value="哈囉"),
                ),
                patch.object(worker_mod, "chat_stream", fake_stream),
                patch.object(worker_mod, "tts", AsyncMock(return_value=b"ID3mp3bytes")),
                patch.object(
                    worker_mod,
                    "_concat_mp3",
                    AsyncMock(return_value=b"ID3combined"),
                ),
            ):
                await handlers_mod.handle_voice(update, context)
                await asyncio.wait_for(pool._queue.join(), timeout=5.0)
        finally:
            await pool.stop()

        spans = get_recent_spans()
        names = [s.name for s in spans]
        for expected in (
            "handler.handle_voice",
            "queue.enqueue",
            "worker.process",
            "worker.stt",
            "worker.llm",
            "worker.tts",
            "worker.ffmpeg_concat",
            "worker.send_audio",
            "worker.deliver_reply",
        ):
            assert expected in names, f"Missing span {expected} in {names}"

        # Every span in the chain shares the exact same trace_id
        root = next(s for s in spans if s.name == "handler.handle_voice")
        chain = [s for s in spans if s.trace_id == root.trace_id]
        chain_names = {s.name for s in chain}
        assert {
            "handler.handle_voice",
            "queue.enqueue",
            "worker.process",
            "worker.tts",
            "worker.ffmpeg_concat",
            "worker.deliver_reply",
        }.issubset(chain_names)

        # Verify queue -> worker parent linkage
        queue_span = next(s for s in chain if s.name == "queue.enqueue")
        worker_span = next(s for s in chain if s.name == "worker.process")
        assert worker_span.parent_span_id == queue_span.span_id

        # Verify all worker metrics recorded accurately
        assert metrics.queue_depth.get() == 0.0
        assert metrics.ffmpeg_queue_length.get() == 0.0
        assert metrics.tts_wait_seconds.snapshot()[1] >= 2
        assert metrics.request_duration_seconds.snapshot()[1] == 1
        metrics.reset()
