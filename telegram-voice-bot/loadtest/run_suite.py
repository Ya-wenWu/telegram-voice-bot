"""Automated Locust benchmark orchestrator for telegram-voice-bot & Web Voice Bot.

Runs real headless Locust tests across:
  1. Pure Text (default BOT_WORKERS=1, BOT_QUEUE_MAXSIZE=10)
  2. Pure Voice (default BOT_WORKERS=1, BOT_QUEUE_MAXSIZE=10, real ffmpeg -threads 1)
  3. Mixed Workload 60% text / 40% voice (default BOT_WORKERS=1, with 0.5s queue_depth curve)
  4. Bottleneck Isolation (BOT_WORKERS=3, BOT_QUEUE_MAXSIZE=30) on Pure Voice & Mixed
  5. Live Express Web Server HTTP probes (/health, /ready, /metrics)

Outputs structured JSON results to stdout / file for reproducible load test reporting.
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
LOCUST_BIN = str(Path(sys.executable).parent / "locust")

SERVER_DOMAIN :str  = "http://127.0.0.1"

def _http_json(
    url: str, method: str = "GET", body: bytes | None = None
) -> dict[str, Any]:
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _wait_ready(url: str, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _http_json(url)
            return
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    raise RuntimeError(f"Server did not become ready at {url}")


def _approx_histogram_percentile(
    buckets: list[list[Any]], total: int, pct: float
) -> float:
    if total <= 0:
        return 0.0
    target = total * pct
    prev_bound = 0.0
    prev_count = 0
    for bound, count in buckets:
        if count >= target:
            if count == prev_count:
                return float(bound) * 1000.0
            frac = (target - prev_count) / (count - prev_count)
            return (prev_bound + frac * (float(bound) - prev_bound)) * 1000.0
        prev_bound = float(bound)
        prev_count = int(count)
    return float(buckets[-1][0]) * 1000.0 if buckets else 0.0


def run_locust_scenario(
    *,
    name: str,
    scenario: str,
    host: str,
    users: int,
    spawn_rate: int,
    duration_sec: int,
    sample_stats_url: str | None = None,
    reset_url: str | None = None,
) -> dict[str, Any]:
    if reset_url:
        _http_json(reset_url, method="POST", body=b"{}")

    samples: list[dict[str, Any]] = []
    stop_evt = threading.Event()
    t0 = time.monotonic()

    def sampler() -> None:
        while not stop_evt.is_set():
            try:
                if sample_stats_url:
                    st = _http_json(sample_stats_url)
                    samples.append(
                        {
                            "t_sec": round(time.monotonic() - t0, 1),
                            "queue_depth": st["queue_depth"],
                            "ffmpeg_queue_length": st["ffmpeg_queue_length"],
                            "cpu_percent": st["cpu_percent"],
                            "rss_mb": st["rss_mb"],
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"sampler warning: {type(exc).__name__}: {exc}\n")
            stop_evt.wait(0.5)

    sampler_thread = threading.Thread(target=sampler, daemon=True)
    if sample_stats_url:
        sampler_thread.start()

    with tempfile.TemporaryDirectory(prefix="locust_csv_") as tmp:
        csv_prefix = os.path.join(tmp, "res")
        env = dict(os.environ)
        env["SCENARIO"] = scenario
        cmd = [
            LOCUST_BIN,
            "-f",
            str(HERE / "locustfile.py"),
            "--headless",
            "-u",
            str(users),
            "-r",
            str(spawn_rate),
            "-t",
            f"{duration_sec}s",
            "--host",
            host,
            "--csv",
            csv_prefix,
            "--only-summary",
        ]
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
        stop_evt.set()
        if sample_stats_url:
            sampler_thread.join(timeout=2.0)

        rows: list[dict[str, str]] = []
        stats_csv = Path(f"{csv_prefix}_stats.csv")
        if stats_csv.exists():
            with stats_csv.open("r", encoding="utf-8") as fh:
                rows = list(csv.DictReader(fh))

    final_stats = _http_json(sample_stats_url) if sample_stats_url else {}
    agg = next(
        (r for r in rows if r.get("Name") == "Aggregated"), rows[-1] if rows else {}
    )

    per_endpoint = [
        {
            "name": r.get("Name"),
            "requests": int(r.get("Request Count") or 0),
            "failures": int(r.get("Failure Count") or 0),
            "rps": round(float(r.get("Requests/s") or 0), 2),
            "avg_ms": round(float(r.get("Average Response Time") or 0), 1),
            "p50_ms": round(float(r.get("50%") or 0), 1),
            "p95_ms": round(float(r.get("95%") or 0), 1),
            "p99_ms": round(float(r.get("99%") or 0), 1),
            "max_ms": round(float(r.get("Max Response Time") or 0), 1),
        }
        for r in rows
        if r.get("Name") != "Aggregated"
    ]

    tts_buckets = final_stats.get("tts_wait_buckets", [])
    tts_count = int(final_stats.get("tts_wait_count", 0))

    return {
        "name": name,
        "scenario": scenario,
        "users": users,
        "spawn_rate": spawn_rate,
        "duration_sec": duration_sec,
        "exit_code": proc.returncode,
        "aggregated": {
            "requests": int(agg.get("Request Count") or 0),
            "failures": int(agg.get("Failure Count") or 0),
            "rps": round(float(agg.get("Requests/s") or 0), 2),
            "avg_ms": round(float(agg.get("Average Response Time") or 0), 1),
            "p50_ms": round(float(agg.get("50%") or 0), 1),
            "p95_ms": round(float(agg.get("95%") or 0), 1),
            "p99_ms": round(float(agg.get("99%") or 0), 1),
            "max_ms": round(float(agg.get("Max Response Time") or 0), 1),
        },
        "per_endpoint": per_endpoint,
        "server_stats": {
            "queue_full_rejects": final_stats.get("queue_full_rejects", 0),
            "redis_failures_total": final_stats.get("redis_failures_total", 0),
            "tts_wait_count": tts_count,
            "tts_wait_avg_ms": final_stats.get("tts_wait_avg_ms", 0.0),
            "tts_wait_p50_ms": round(
                _approx_histogram_percentile(tts_buckets, tts_count, 0.50), 1
            ),
            "tts_wait_p95_ms": round(
                _approx_histogram_percentile(tts_buckets, tts_count, 0.95), 1
            ),
            "queue_depth_max": max((s["queue_depth"] for s in samples), default=0),
            "queue_depth_avg": round(
                sum(s["queue_depth"] for s in samples) / max(1, len(samples)), 2
            ),
            "ffmpeg_queue_max": max(
                (s["ffmpeg_queue_length"] for s in samples), default=0
            ),
            "cpu_percent_peak": max((s["cpu_percent"] for s in samples), default=0.0),
            "rss_mb_peak": max((s["rss_mb"] for s in samples), default=0.0),
        },
        "queue_timeseries": [
            {"t": s["t_sec"], "q": s["queue_depth"], "ff": s["ffmpeg_queue_length"]}
            for s in samples
        ],
    }


def start_bench_server(
    port: int, workers: int, queue_size: int
) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        [
            sys.executable,
            str(HERE / "benchmark_server.py"),
            "--port",
            str(port),
            "--workers",
            str(workers),
            "--queue-size",
            str(queue_size),
            "--llm-ms",
            "120",
            "--stt-ms",
            "100",
            "--tts-ms",
            "150",
            "--sentences",
            "3",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    _wait_ready(f"{SERVER_DOMAIN}:{port}/health", timeout=15.0)
    return proc


def main() -> None:
    results: dict[str, Any] = {"scenarios": []}

    # --- Group A: Production Default (BOT_WORKERS=1, BOT_QUEUE_MAXSIZE=10) ---
    srv1 = start_bench_server(port=8787, workers=1, queue_size=10)
    try:
        base1 = f"{SERVER_DOMAIN}:8787"
        results["scenarios"].append(
            run_locust_scenario(
                name="S1_text_only_w1_q10",
                scenario="text",
                host=base1,
                users=10,
                spawn_rate=5,
                duration_sec=12,
                sample_stats_url=f"{base1}/stats",
                reset_url=f"{base1}/reset",
            )
        )
        results["scenarios"].append(
            run_locust_scenario(
                name="S2_voice_only_w1_q10",
                scenario="voice",
                host=base1,
                users=10,
                spawn_rate=5,
                duration_sec=12,
                sample_stats_url=f"{base1}/stats",
                reset_url=f"{base1}/reset",
            )
        )
        results["scenarios"].append(
            run_locust_scenario(
                name="S3_mixed_60t_40v_w1_q10",
                scenario="mixed",
                host=base1,
                users=12,
                spawn_rate=4,
                duration_sec=15,
                sample_stats_url=f"{base1}/stats",
                reset_url=f"{base1}/reset",
            )
        )
    finally:
        srv1.terminate()
        srv1.wait(timeout=5)

    # --- Group B: Bottleneck Isolation (BOT_WORKERS=3, BOT_QUEUE_MAXSIZE=30) ---
    srv3 = start_bench_server(port=8788, workers=3, queue_size=30)
    try:
        base3 = f"{SERVER_DOMAIN}:8788"
        results["scenarios"].append(
            run_locust_scenario(
                name="S2b_voice_only_w3_q30",
                scenario="voice",
                host=base3,
                users=10,
                spawn_rate=5,
                duration_sec=12,
                sample_stats_url=f"{base3}/stats",
                reset_url=f"{base3}/reset",
            )
        )
        results["scenarios"].append(
            run_locust_scenario(
                name="S3b_mixed_60t_40v_w3_q30",
                scenario="mixed",
                host=base3,
                users=12,
                spawn_rate=4,
                duration_sec=15,
                sample_stats_url=f"{base3}/stats",
                reset_url=f"{base3}/reset",
            )
        )
    finally:
        srv3.terminate()
        srv3.wait(timeout=5)

    # --- Group C: Live Express Web Server HTTP Probes (/health, /ready, /metrics) ---
    try:
        _wait_ready(f"{SERVER_DOMAIN}:3000/health", timeout=3.0)
        results["scenarios"].append(
            run_locust_scenario(
                name="S4_express_http_probes",
                scenario="http_probes",
                host=f"{SERVER_DOMAIN}:3000",
                users=20,
                spawn_rate=10,
                duration_sec=10,
            )
        )
    except Exception as exc:  # noqa: BLE001
        results["express_probe_error"] = str(exc)

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
