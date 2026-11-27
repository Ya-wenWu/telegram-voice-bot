"""Local load-test harness wrapping the real WorkerPool, ffmpeg concat, Redis quota, and Prometheus metrics.

Exposes HTTP endpoints so Locust or wrk can stress-test the actual bot pipeline:
  - POST /simulate/text   -> enqueues a text Task into WorkerPool and waits for delivery
  - POST /simulate/voice  -> enqueues a voice Task (STT + LLM + 3-sentence TTS + real ffmpeg concat)
  - GET  /health          -> liveness probe
  - GET  /ready           -> readiness probe (503 when queue saturated or pool stopped)
  - GET  /metrics         -> Prometheus v0.0.4 metrics
  - GET  /stats           -> JSON telemetry snapshot (queue_depth, ffmpeg_queue_length, CPU, RSS)
  - POST /reset           -> resets metrics & memory between scenarios
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

# Ensure telegram-voice-bot root is importable
BOT_ROOT = Path(__file__).resolve().parents[1]
if str(BOT_ROOT) not in sys.path:
    sys.path.insert(0, str(BOT_ROOT))

import bot.redis_client as redis_mod
import bot.worker as worker_mod
from bot.observability import (
    clear_recent_spans,
    metrics,
    start_span,
)
from bot.worker import Task, WorkerPool

try:
    import psutil  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    psutil = None


def _generate_sample_mp3() -> bytes:
    """Generate a real valid 0.6s MP3 clip using ffmpeg for authentic concat load testing."""
    with tempfile.TemporaryDirectory(prefix="bench_mp3_") as tmp:
        out_path = os.path.join(tmp, "sample.mp3")
        res = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.6",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "48k",
                "-loglevel",
                "error",
                out_path,
            ],
            check=False,
            capture_output=True,
        )
        if res.returncode == 0 and os.path.exists(out_path):
            return Path(out_path).read_bytes()
    return b"ID3" + b"\x00" * 4096


class BenchmarkHarness:
    def __init__(
        self,
        *,
        num_workers: int = 4,
        max_queue_size: int = 32,
        tts_concurrency: int = 8,
        ffmpeg_concurrency: int = 2,
        llm_delay_ms: float = 120.0,
        stt_delay_ms: float = 100.0,
        tts_delay_ms: float = 150.0,
        voice_sentences: int = 3,
        use_real_ffmpeg: bool = True,
        check_redis: bool = True,
    ) -> None:
        self.num_workers = num_workers
        self.max_queue_size = max_queue_size
        self.llm_delay_sec = llm_delay_ms / 1000.0
        self.stt_delay_sec = stt_delay_ms / 1000.0
        self.tts_delay_sec = tts_delay_ms / 1000.0
        self.voice_sentences = max(1, voice_sentences)
        self.use_real_ffmpeg = use_real_ffmpeg
        self.check_redis = check_redis
        self.sample_mp3 = _generate_sample_mp3()
        self.pool = WorkerPool(
            num_workers=num_workers,
            max_queue_size=max_queue_size,
            tts_concurrency=tts_concurrency,
            ffmpeg_concurrency=ffmpeg_concurrency,
        )
        self.started_at = time.monotonic()
        self._proc = psutil.Process(os.getpid()) if psutil is not None else None
        if self._proc is not None:
            self._proc.cpu_percent(interval=None)
        self._req_seq = 0
        self._queue_full_count = 0
        self._completed_text = 0
        self._completed_voice = 0

    def _install_calibrated_stubs(self) -> None:
        sentences = [
            f"這是第{i + 1}句語音測試回覆。" for i in range(self.voice_sentences)
        ]
        llm_delay = self.llm_delay_sec
        stt_delay = self.stt_delay_sec
        tts_delay = self.tts_delay_sec
        sample_mp3 = self.sample_mp3

        async def fake_stream(chat_id: int, text: str, history: Any = None):
            per_chunk = llm_delay / max(1, len(sentences))
            for s in sentences:
                await asyncio.sleep(per_chunk)
                yield s

        async def fake_chat(chat_id: int, text: str, history: Any = None) -> str:
            await asyncio.sleep(llm_delay)
            return "".join(sentences)

        async def fake_stt(voice: Any) -> str:
            await asyncio.sleep(stt_delay)
            return "請問這個系統的效能瓶頸在哪裡？"

        async def fake_tts(text: str) -> bytes:
            await asyncio.sleep(tts_delay)
            return sample_mp3

        worker_mod.chat_stream = fake_stream  # type: ignore[assignment]
        worker_mod.chat = fake_chat  # type: ignore[assignment]
        worker_mod._download_and_transcribe_voice = fake_stt  # type: ignore[assignment]
        worker_mod.tts = fake_tts  # type: ignore[assignment]
        if not self.use_real_ffmpeg:

            async def fast_concat(
                parts: list[bytes], *, timeout: float = 30.0
            ) -> bytes:
                return parts[0] if parts else b""

            worker_mod._concat_mp3 = fast_concat  # type: ignore[assignment]

    async def start(self) -> None:
        self._install_calibrated_stubs()
        metrics.reset()
        clear_recent_spans()
        await self.pool.start()

    async def stop(self) -> None:
        await self.pool.stop(drain_timeout=5.0)
        await redis_mod.close_redis()

    def reset_stats(self) -> None:
        metrics.reset()
        clear_recent_spans()
        self._queue_full_count = 0
        self._completed_text = 0
        self._completed_voice = 0
        redis_mod._disabled_until = 0.0
        redis_mod._degraded = True
        redis_mod._probing = False

    def _make_fake_bot(self, done_event: asyncio.Event) -> MagicMock:
        bot = MagicMock()
        sent = MagicMock()
        sent.message_id = 1000
        bot.send_message = AsyncMock(return_value=sent)
        bot.send_chat_action = AsyncMock()
        bot.send_audio = AsyncMock()

        async def _on_edit(*args: Any, **kwargs: Any) -> None:
            # Final edit signals reply delivery completed
            pass

        bot.edit_message_text = AsyncMock(side_effect=_on_edit)
        return bot

    async def simulate_request(
        self, *, is_voice: bool, user_id: int
    ) -> tuple[int, dict[str, Any]]:
        self._req_seq += 1
        req_id = f"bench-{self._req_seq}"
        started_at = time.monotonic()

        with start_span(
            "handler.handle_voice" if is_voice else "handler.handle_text",
            attributes={"req_id": req_id, "is_voice": is_voice},
        ) as root_span:
            if self.check_redis:
                await redis_mod.check_daily_quota(user_id, limit=100_000)

            done_event = asyncio.Event()
            bot = self._make_fake_bot(done_event)

            # Hook _deliver_text completion via a tiny subclass-free event wrapper
            orig_edit = bot.edit_message_text

            async def _track_deliver(*args: Any, **kwargs: Any) -> None:
                await orig_edit(*args, **kwargs)

            bot.edit_message_text = AsyncMock(side_effect=_track_deliver)

            voice_obj = MagicMock(file_size=4096) if is_voice else None
            task = Task(
                chat_id=user_id,
                reply_to_message_id=self._req_seq,
                text="" if is_voice else "請簡單說明系統架構瓶頸",
                bot=bot,
                is_voice=is_voice,
                voice=voice_obj,
                req_id=req_id,
                created_at=started_at,
                trace_id=root_span.trace_id,
            )

            # Attach completion signal cleanly by wrapping pool._process for this task
            fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            task._bench_future = fut  # type: ignore[attr-defined]

            try:
                with start_span(
                    "queue.enqueue", attributes={"is_voice": is_voice}
                ) as q_span:
                    task.parent_span_id = q_span.span_id
                    self.pool.try_enqueue(task)
            except asyncio.QueueFull:
                self._queue_full_count += 1
                return 429, {
                    "ok": False,
                    "error": "queue_full",
                    "queue_depth": int(metrics.queue_depth.get()),
                    "trace_id": root_span.trace_id,
                }

            try:
                await asyncio.wait_for(fut, timeout=30.0)
            except TimeoutError:
                return 504, {
                    "ok": False,
                    "error": "worker_timeout",
                    "trace_id": root_span.trace_id,
                }

            elapsed_ms = round((time.monotonic() - started_at) * 1000, 2)
            if is_voice:
                self._completed_voice += 1
            else:
                self._completed_text += 1
            return 200, {
                "ok": True,
                "is_voice": is_voice,
                "elapsed_ms": elapsed_ms,
                "queue_depth": int(metrics.queue_depth.get()),
                "ffmpeg_queue_length": int(metrics.ffmpeg_queue_length.get()),
                "trace_id": root_span.trace_id,
            }

    def snapshot_stats(self) -> dict[str, Any]:
        tts_buckets, tts_count, tts_sum = metrics.tts_wait_seconds.snapshot()
        req_buckets, req_count, req_sum = metrics.request_duration_seconds.snapshot()
        cpu_pct = (
            self._proc.cpu_percent(interval=None) if self._proc is not None else 0.0
        )
        rss_mb = (
            round(self._proc.memory_info().rss / (1024 * 1024), 2)
            if self._proc is not None
            else 0.0
        )
        return {
            "num_workers": self.num_workers,
            "max_queue_size": self.max_queue_size,
            "queue_depth": int(metrics.queue_depth.get()),
            "ffmpeg_queue_length": int(metrics.ffmpeg_queue_length.get()),
            "redis_failures_total": int(metrics.redis_failures_total.get()),
            "queue_full_rejects": self._queue_full_count,
            "completed_text": self._completed_text,
            "completed_voice": self._completed_voice,
            "tts_wait_count": tts_count,
            "tts_wait_avg_ms": round((tts_sum / tts_count) * 1000, 2)
            if tts_count
            else 0.0,
            "tts_wait_buckets": tts_buckets,
            "req_duration_count": req_count,
            "req_duration_avg_ms": round((req_sum / req_count) * 1000, 2)
            if req_count
            else 0.0,
            "req_duration_buckets": req_buckets,
            "cpu_percent": round(cpu_pct, 1),
            "rss_mb": rss_mb,
        }


async def run_server(args: argparse.Namespace) -> None:
    harness = BenchmarkHarness(
        num_workers=args.workers,
        max_queue_size=args.queue_size,
        tts_concurrency=args.tts_concurrency,
        ffmpeg_concurrency=args.ffmpeg_concurrency,
        llm_delay_ms=args.llm_ms,
        stt_delay_ms=args.stt_ms,
        tts_delay_ms=args.tts_ms,
        voice_sentences=args.sentences,
        use_real_ffmpeg=not args.no_real_ffmpeg,
        check_redis=not args.no_redis,
    )

    # Resolve per-task completion future after WorkerPool._process finishes
    orig_process = harness.pool._process

    async def _wrapped_process(task: Task) -> None:
        try:
            await orig_process(task)
        finally:
            fut = getattr(task, "_bench_future", None)
            if fut is not None and not fut.done():
                fut.set_result(None)

    harness.pool._process = _wrapped_process  # type: ignore[method-assign]
    await harness.start()

    async def handle_client(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            req_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not req_line:
                return
            parts = req_line.decode("latin-1", errors="replace").strip().split()
            method = parts[0].upper() if len(parts) >= 1 else "GET"
            target = parts[1] if len(parts) >= 2 else "/"
            path = target.split("?", 1)[0]

            content_len = 0
            for _ in range(64):
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if line in (b"", b"\r\n", b"\n"):
                    break
                decoded = line.decode("latin-1", errors="replace")
                if decoded.lower().startswith("content-length:"):
                    try:
                        content_len = min(65536, int(decoded.split(":", 1)[1].strip()))
                    except ValueError:
                        content_len = 0

            raw_body = b""
            if content_len > 0:
                raw_body = await asyncio.wait_for(
                    reader.readexactly(content_len), timeout=5.0
                )

            body_json: dict[str, Any] = {}
            if raw_body:
                try:
                    body_json = json.loads(raw_body.decode("utf-8"))
                except json.JSONDecodeError:
                    body_json = {}

            content_type = "application/json; charset=utf-8"
            if path == "/health" and method == "GET":
                status = 200
                resp_bytes = json.dumps(
                    {
                        "status": "ok",
                        "service": "telegram-voice-bot-bench",
                        "uptime_seconds": round(
                            time.monotonic() - harness.started_at, 3
                        ),
                    }
                ).encode("utf-8")
            elif path == "/ready" and method == "GET":
                ready, checks = harness.pool.is_ready()
                status = 200 if ready else 503
                resp_bytes = json.dumps(
                    {"status": "ready" if ready else "not_ready", "checks": checks}
                ).encode("utf-8")
            elif path == "/metrics" and method == "GET":
                status = 200
                content_type = "text/plain; version=0.0.4; charset=utf-8"
                resp_bytes = metrics.render_prometheus().encode("utf-8")
            elif path == "/stats" and method == "GET":
                status = 200
                resp_bytes = json.dumps(harness.snapshot_stats()).encode("utf-8")
            elif path == "/reset" and method == "POST":
                harness.reset_stats()
                status = 200
                resp_bytes = b'{"ok":true}'
            elif path == "/simulate/text" and method == "POST":
                uid = int(body_json.get("user_id", 12345))
                status, data = await harness.simulate_request(
                    is_voice=False, user_id=uid
                )
                resp_bytes = json.dumps(data).encode("utf-8")
            elif path == "/simulate/voice" and method == "POST":
                uid = int(body_json.get("user_id", 12345))
                status, data = await harness.simulate_request(
                    is_voice=True, user_id=uid
                )
                resp_bytes = json.dumps(data).encode("utf-8")
            else:
                status = 404
                resp_bytes = b'{"error":"not_found"}'

            reason = {
                200: "OK",
                404: "Not Found",
                429: "Too Many Requests",
                503: "Service Unavailable",
                504: "Gateway Timeout",
            }.get(status, "OK")
            headers = (
                f"HTTP/1.1 {status} {reason}\r\n"
                f"Content-Type: {content_type}\r\n"
                f"Content-Length: {len(resp_bytes)}\r\n"
                f"Connection: close\r\n\r\n"
            ).encode("ascii")
            writer.write(headers + resp_bytes)
            await writer.drain()
        except (TimeoutError, OSError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except OSError:
                pass

    server = await asyncio.start_server(handle_client, host="127.0.0.1", port=args.port)
    print(
        json.dumps(
            {
                "event": "benchmark_server_ready",
                "url": f"http://127.0.0.1:{args.port}",
                "workers": args.workers,
                "queue_size": args.queue_size,
                "real_ffmpeg": not args.no_real_ffmpeg,
            }
        ),
        flush=True,
    )
    try:
        async with server:
            await server.serve_forever()
    finally:
        await harness.stop()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark server for telegram-voice-bot"
    )
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--queue-size", type=int, default=32)
    parser.add_argument("--tts-concurrency", type=int, default=8)
    parser.add_argument("--ffmpeg-concurrency", type=int, default=2)
    parser.add_argument("--llm-ms", type=float, default=120.0)
    parser.add_argument("--stt-ms", type=float, default=100.0)
    parser.add_argument("--tts-ms", type=float, default=150.0)
    parser.add_argument("--sentences", type=int, default=3)
    parser.add_argument("--no-real-ffmpeg", action="store_true")
    parser.add_argument("--no-redis", action="store_true")
    args = parser.parse_args()
    asyncio.run(run_server(args))


if __name__ == "__main__":
    main()
