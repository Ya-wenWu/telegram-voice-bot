"""Host & container-aware resource detection and adaptive deployment profiles.

Detects real available RAM (minimum of host MemAvailable and Linux cgroup v1/v2
remaining memory quota) and effective CPU cores, then selects:
- ``constrained_1c1g`` when effective available RAM <= 1024 MB (strict 1 vCPU / 1 GB
  single-bot protection to prevent OOM crashes).
- ``high_concurrency`` when effective available RAM > 1024 MB (full high-concurrency
  voice pipeline + Redis distributed lease semaphores + multi-bot support).
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

CONSTRAINED_RAM_THRESHOLD_MB = 1024

ProfileMode = Literal["constrained_1c1g", "high_concurrency"]


@dataclass(frozen=True)
class ResourceSnapshot:
    host_total_ram_mb: int
    host_available_ram_mb: int
    cgroup_limit_ram_mb: int | None
    cgroup_available_ram_mb: int | None
    effective_available_ram_mb: int
    host_cpu_cores: int
    effective_cpu_cores: int
    platform: str


@dataclass(frozen=True)
class DeploymentProfile:
    mode: ProfileMode
    tier: str
    reason: str
    resources: ResourceSnapshot
    cpu_limit: int
    ram_limit_mb: int
    max_bots: int
    bot_workers: int
    concurrent_updates: int
    bot_queue_maxsize: int
    ffmpeg_concurrency: int
    tts_concurrency: int
    max_voice_bytes: int
    redis_semaphore_enabled: bool
    enable_web_console: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_first_int(path: Path) -> int | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        if not raw or raw.lower() == "max":
            return None
        val = int(raw)
        return val if val >= 0 else None
    except (OSError, ValueError):
        return None


def _read_linux_meminfo_mb() -> tuple[int, int] | None:
    meminfo = Path("/proc/meminfo")
    if not meminfo.is_file():
        return None
    values_kb: dict[str, int] = {}
    try:
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            parts = rest.strip().split()
            if parts and parts[0].isdigit():
                values_kb[key.strip()] = int(parts[0])
    except OSError:
        return None

    total_kb = values_kb.get("MemTotal")
    if not total_kb:
        return None
    avail_kb = values_kb.get("MemAvailable")
    if avail_kb is None:
        avail_kb = (
            values_kb.get("MemFree", 0)
            + values_kb.get("Buffers", 0)
            + values_kb.get("Cached", 0)
        )
    return max(1, total_kb // 1024), max(1, avail_kb // 1024)


def _read_windows_mem_mb() -> tuple[int, int] | None:
    if not sys.platform.startswith("win"):
        return None
    try:

        class _MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = _MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
            total_mb = max(1, int(stat.ullTotalPhys // (1024 * 1024)))
            avail_mb = max(1, int(stat.ullAvailPhys // (1024 * 1024)))
            return total_mb, avail_mb
    except Exception:
        return None
    return None


def _read_cgroup_memory_mb(host_total_mb: int) -> tuple[int | None, int | None]:
    """Read Linux cgroup v2 or v1 memory limit and remaining available MB."""
    # Ignore bogus/unlimited kernel sentinel values (>= 1 PiB or > host_total * 2)
    sane_cap_bytes = max(host_total_mb * 2, 1024 * 1024) * 1024 * 1024

    # cgroup v2
    v2_max = _read_first_int(Path("/sys/fs/cgroup/memory.max"))
    if v2_max is not None and 0 < v2_max < sane_cap_bytes:
        v2_cur = _read_first_int(Path("/sys/fs/cgroup/memory.current")) or 0
        limit_mb = max(1, v2_max // (1024 * 1024))
        avail_mb = max(1, max(0, v2_max - v2_cur) // (1024 * 1024))
        return limit_mb, avail_mb

    # cgroup v1
    v1_max = _read_first_int(Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
    if v1_max is not None and 0 < v1_max < sane_cap_bytes:
        v1_cur = (
            _read_first_int(Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")) or 0
        )
        limit_mb = max(1, v1_max // (1024 * 1024))
        avail_mb = max(1, max(0, v1_max - v1_cur) // (1024 * 1024))
        return limit_mb, avail_mb

    return None, None


def _read_cgroup_cpu_cores() -> int | None:
    """Read container CPU quota in cores (cgroup v2 cpu.max or v1 cfs_quota_us)."""
    v2_cpu = Path("/sys/fs/cgroup/cpu.max")
    try:
        if v2_cpu.is_file():
            parts = v2_cpu.read_text(encoding="utf-8").strip().split()
            if len(parts) >= 2 and parts[0] != "max":
                quota = int(parts[0])
                period = int(parts[1])
                if quota > 0 and period > 0:
                    return max(1, math.ceil(quota / period))
    except (OSError, ValueError):
        pass

    quota_v1 = _read_first_int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"))
    period_v1 = _read_first_int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us"))
    if quota_v1 is not None and period_v1 is not None and quota_v1 > 0 and period_v1 > 0:
        return max(1, math.ceil(quota_v1 / period_v1))
    return None


def detect_host_resources() -> ResourceSnapshot:
    """Probe host and container (cgroup v1/v2) memory and CPU availability."""
    host_cpu = max(1, os.cpu_count() or 1)
    cgroup_cpu = _read_cgroup_cpu_cores()
    effective_cpu = max(1, min(host_cpu, cgroup_cpu)) if cgroup_cpu else host_cpu

    mem = _read_linux_meminfo_mb() or _read_windows_mem_mb()
    if mem is None:
        # Conservative fallback when OS memory counters are inaccessible
        host_total_mb, host_avail_mb = 2048, 1536
    else:
        host_total_mb, host_avail_mb = mem

    cg_limit_mb, cg_avail_mb = _read_cgroup_memory_mb(host_total_mb)

    candidates = [host_avail_mb]
    if cg_avail_mb is not None:
        candidates.append(cg_avail_mb)
    if cg_limit_mb is not None:
        # Also cap by total container limit so a 1 GB container always stays <= 1024 MB
        candidates.append(cg_limit_mb)
    effective_avail_mb = max(1, min(candidates))

    return ResourceSnapshot(
        host_total_ram_mb=host_total_mb,
        host_available_ram_mb=host_avail_mb,
        cgroup_limit_ram_mb=cg_limit_mb,
        cgroup_available_ram_mb=cg_avail_mb,
        effective_available_ram_mb=effective_avail_mb,
        host_cpu_cores=host_cpu,
        effective_cpu_cores=effective_cpu,
        platform="windows" if sys.platform.startswith("win") else "linux",
    )


def resolve_deployment_profile(
    override: str | None = None,
    *,
    available_ram_mb: int | None = None,
    cpu_cores: int | None = None,
) -> DeploymentProfile:
    """Resolve the adaptive operating profile from host resources or explicit override."""
    snap = detect_host_resources()
    eff_ram = (
        max(1, int(available_ram_mb))
        if available_ram_mb is not None
        else snap.effective_available_ram_mb
    )
    eff_cpu = max(1, int(cpu_cores)) if cpu_cores is not None else snap.effective_cpu_cores
    if available_ram_mb is not None or cpu_cores is not None:
        snap = ResourceSnapshot(
            host_total_ram_mb=snap.host_total_ram_mb,
            host_available_ram_mb=snap.host_available_ram_mb,
            cgroup_limit_ram_mb=snap.cgroup_limit_ram_mb,
            cgroup_available_ram_mb=snap.cgroup_available_ram_mb,
            effective_available_ram_mb=eff_ram,
            host_cpu_cores=snap.host_cpu_cores,
            effective_cpu_cores=eff_cpu,
            platform=snap.platform,
        )

    raw_override = (override if override is not None else os.getenv("DEPLOYMENT_PROFILE", "auto")).strip().lower()
    force_constrained = raw_override in ("constrained", "constrained_1c1g", "1c1g", "low")
    force_high = raw_override in ("high", "high_concurrency", "multibot")

    if force_constrained or (not force_high and eff_ram <= CONSTRAINED_RAM_THRESHOLD_MB):
        reason = (
            "Forced via DEPLOYMENT_PROFILE=constrained"
            if force_constrained
            else f"Effective available RAM ({eff_ram} MB) <= {CONSTRAINED_RAM_THRESHOLD_MB} MB"
        )
        return DeploymentProfile(
            mode="constrained_1c1g",
            tier="Tier-1 (1C/1G Single-Bot)",
            reason=reason,
            resources=snap,
            cpu_limit=1,
            ram_limit_mb=CONSTRAINED_RAM_THRESHOLD_MB,
            max_bots=1,
            bot_workers=1,
            concurrent_updates=1,
            bot_queue_maxsize=10,
            ffmpeg_concurrency=1,
            tts_concurrency=2,
            max_voice_bytes=5 * 1024 * 1024,
            redis_semaphore_enabled=False,
            enable_web_console=False,
        )

    # High-concurrency multi-bot tiers (> 1 GB available RAM)
    if eff_ram <= 2048:
        tier = "Tier-2S (>1-2 GB High-Concurrency)"
        max_bots = 3
        bot_workers = 4
        concurrent_updates = 4
        queue_maxsize = 32
        ffmpeg_conc = max(1, min(eff_cpu, 2))
        tts_conc = 6
    elif eff_ram <= 4096:
        tier = "Tier-2M (>2-4 GB High-Concurrency)"
        max_bots = 8
        bot_workers = 6
        concurrent_updates = 6
        queue_maxsize = 64
        ffmpeg_conc = max(1, min(eff_cpu, 3))
        tts_conc = 10
    else:
        tier = "Tier-2L (>4 GB High-Concurrency)"
        max_bots = 16
        bot_workers = min(16, max(8, eff_cpu * 2))
        concurrent_updates = min(16, max(8, eff_cpu * 2))
        queue_maxsize = 128
        ffmpeg_conc = max(1, min(eff_cpu, 4))
        tts_conc = 16

    reason = (
        "Forced via DEPLOYMENT_PROFILE=high_concurrency"
        if force_high
        else f"Effective available RAM ({eff_ram} MB) > {CONSTRAINED_RAM_THRESHOLD_MB} MB"
    )
    return DeploymentProfile(
        mode="high_concurrency",
        tier=tier,
        reason=reason,
        resources=snap,
        cpu_limit=eff_cpu,
        ram_limit_mb=eff_ram,
        max_bots=max_bots,
        bot_workers=bot_workers,
        concurrent_updates=concurrent_updates,
        bot_queue_maxsize=queue_maxsize,
        ffmpeg_concurrency=ffmpeg_conc,
        tts_concurrency=tts_conc,
        max_voice_bytes=10 * 1024 * 1024,
        redis_semaphore_enabled=True,
        enable_web_console=True,
    )


def _cli() -> None:
    args = sys.argv[1:]
    override = os.getenv("DEPLOYMENT_PROFILE", "auto")
    profile = resolve_deployment_profile(override)
    if "--shell" in args:
        print(f"PROFILE_MODE={profile.mode}")
        print(f"PROFILE_TIER={json.dumps(profile.tier)}")
        print(f"EFFECTIVE_RAM_MB={profile.resources.effective_available_ram_mb}")
        print(f"EFFECTIVE_CPU_CORES={profile.resources.effective_cpu_cores}")
        print(f"MAX_BOT_INSTANCES={profile.max_bots}")
        print(f"BOT_WORKERS={profile.bot_workers}")
        print(f"CONCURRENT_UPDATES={profile.concurrent_updates}")
        print(f"BOT_QUEUE_MAXSIZE={profile.bot_queue_maxsize}")
        print(f"FFMPEG_CONCURRENCY={profile.ffmpeg_concurrency}")
        print(f"TTS_CONCURRENCY={profile.tts_concurrency}")
        print(
            f"REDIS_SEMAPHORE_ENABLED={'true' if profile.redis_semaphore_enabled else 'false'}"
        )
        print(f"ENABLE_WEB_CONSOLE={'1' if profile.enable_web_console else '0'}")
    else:
        print(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli()
