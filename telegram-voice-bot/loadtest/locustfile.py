"""Locust load-test suite for telegram-voice-bot & Web Voice Bot HTTP endpoints.

Usage examples:
  # Scenario 1: Pure Text
  SCENARIO=text locust -f loadtest/locustfile.py --headless -u 10 -r 5 -t 15s --host http://127.0.0.1:8787

  # Scenario 2: Pure Voice
  SCENARIO=voice locust -f loadtest/locustfile.py --headless -u 10 -r 5 -t 15s --host http://127.0.0.1:8787

  # Scenario 3: Mixed (60% text + 40% voice)
  SCENARIO=mixed locust -f loadtest/locustfile.py --headless -u 12 -r 4 -t 20s --host http://127.0.0.1:8787

  # Scenario 4: Live Express Web Server HTTP Probes (/health, /ready, /metrics)
  SCENARIO=http_probes locust -f loadtest/locustfile.py --headless -u 20 -r 10 -t 10s --host http://127.0.0.1:3000
"""

from __future__ import annotations

import os
import random

from locust import HttpUser, between, task  # type: ignore[import-not-found]

SCENARIO = os.getenv("SCENARIO", "mixed").strip().lower()


class BotLoadUser(HttpUser):
    wait_time = between(0.05, 0.15)

    def _next_uid(self) -> int:
        return random.randint(10000, 99999)

    def _send_text(self) -> None:
        with self.client.post(
            "/simulate/text",
            json={"user_id": self._next_uid()},
            name="POST /simulate/text",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            elif resp.status_code == 429:
                resp.failure("QueueFull (429)")
            else:
                resp.failure(f"HTTP {resp.status_code}")

    def _send_voice(self) -> None:
        with self.client.post(
            "/simulate/voice",
            json={"user_id": self._next_uid()},
            name="POST /simulate/voice",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            elif resp.status_code == 429:
                resp.failure("QueueFull (429)")
            else:
                resp.failure(f"HTTP {resp.status_code}")

    @task
    def run_scenario(self) -> None:
        if SCENARIO == "text":
            self._send_text()
        elif SCENARIO == "voice":
            self._send_voice()
        elif SCENARIO == "http_probes":
            r = random.random()
            if r < 0.5:
                self.client.get("/health", name="GET /health")
            elif r < 0.85:
                self.client.get("/metrics", name="GET /metrics")
            else:
                self.client.get("/ready", name="GET /ready")
        else:
            # Mixed workload: 60% text + 40% voice
            if random.random() < 0.6:
                self._send_text()
            else:
                self._send_voice()
