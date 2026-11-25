import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { copyToClipboard } from '../utils/clipboard';

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramMetric {
  count: number;
  sumSec: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  buckets: HistogramBucket[];
}

interface CompletedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  durationMs: number;
  status: 'OK' | 'ERROR';
  attributes: Record<string, string | number | boolean>;
}

interface ServerHistorySample {
  timestamp: string;
  queueDepth: number;
  queueDepthPeak: number;
  ffmpegQueueLength: number;
  ffmpegQueuePeak: number;
  reqAvgMs: number;
  reqP95Ms: number;
  ttsAvgMs: number;
  ttsP95Ms: number;
  rssMb: number;
  heapUsedMb: number;
  cpuPercent: number;
}

interface LiveObservabilitySnapshot {
  timestamp: string;
  uptimeSeconds: number;
  source: 'python-bot' | 'web-express';
  scrapeEndpoint: string;
  prometheusRaw: string;
  history?: ServerHistorySample[];
  metrics: {
    queueDepth: number;
    queueDepthPeak?: number;
    queueDepthAllTimePeak?: number;
    queueTasksTotal?: number;
    ffmpegQueueLength: number;
    ffmpegQueuePeak?: number;
    ffmpegTasksTotal?: number;
    redisFailuresTotal: number;
    ttsDegradedTotal?: number;
    lastTtsNote?: string | null;
    requestDuration: HistogramMetric;
    ttsWait: HistogramMetric;
  };
  redis: {
    status: 'healthy' | 'fail_open';
    target: string;
    latencyMs: number | null;
    error: string | null;
    checkedAtMs: number;
    failuresTotal: number;
    failOpenCooldownSec: number;
  };
  system: {
    cpuPercent: number;
    cpuCores: number;
    loadAvg1m: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    totalMemMb: number;
    pythonBridgeReady: boolean;
    ffmpegAvailable: boolean;
    geminiKeyState: string;
    readyCacheAgeMs: number;
  };
  deploymentProfile?: {
    mode: 'constrained_1c1g' | 'high_concurrency';
    tier: string;
    max_bots: number;
    ffmpeg_concurrency: number;
    tts_concurrency: number;
    resources: {
      effective_available_ram_mb: number;
      effective_cpu_cores: number;
    };
  };
  botGuard?: {
    enabled: boolean;
    blockedTotal: number;
    challengedTotal: number;
    verifiedHumansTotal: number;
    honeypotHitsTotal: number;
    activeQuarantinedIps: number;
  };
  recentSpans: CompletedSpan[];
}

interface RollingSample {
  time: string;
  queueDepth: number;
  queueDepthPeak: number;
  ffmpegQueueLength: number;
  ffmpegQueuePeak: number;
  reqAvgMs: number;
  reqP95Ms: number;
  ttsAvgMs: number;
  ttsP95Ms: number;
  rssMb: number;
  heapUsedMb: number;
  cpuPercent: number;
}

type PollIntervalMs = 2000 | 5000 | 10000 | 0;
type LatencyChartMode = 'timeseries' | 'histogram';
type AlertSeverity = 'ok' | 'warning' | 'critical';
type DurationEvalMetric = 'p95' | 'avg';

interface AlertThresholds {
  enabled: boolean;
  queueWarning: number;
  queueCritical: number;
  durationWarningMs: number;
  durationCriticalMs: number;
  durationMetric: DurationEvalMetric;
}

interface ActiveAlert {
  id: 'queue_depth' | 'request_duration_seconds';
  metricName: 'queue_depth' | 'request_duration_seconds';
  title: string;
  severity: 'warning' | 'critical';
  currentLabel: string;
  thresholdLabel: string;
  message: string;
}

interface RecentAlertEntry {
  id: string;
  timestamp: string;
  metricType: 'queue_depth' | 'request_duration_seconds';
  metricLabel: string;
  severity: 'warning' | 'critical';
  observedValue: string;
  thresholdValue: string;
  exceededValue: string;
  note: string;
}

type AlertLogFilter = 'all' | 'queue_depth' | 'request_duration_seconds';

interface HealthCheckCommand {
  label: string;
  command: string;
}

interface HealthCheckItem {
  id: string;
  name: string;
  category: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
  version: string | null;
  fixSummary: string;
  fixCommands: HealthCheckCommand[];
}

interface HealthCheckReport {
  checkedAt: string;
  elapsedMs: number;
  hostOs: 'linux' | 'windows';
  pythonBin: string;
  pythonVersion: string | null;
  overallStatus: 'healthy' | 'warning' | 'error';
  summary: {
    ok: number;
    warning: number;
    error: number;
    total: number;
  };
  checks: HealthCheckItem[];
}

interface SupplyChainSupplier {
  id: string;
  name: string;
  category: string;
  riskTier: 'high' | 'medium' | 'low';
  dataExposure: string;
  configured: boolean;
  credentialEnvNames: string[];
  endpointSummary: string;
  slaRequirement: string;
  offboardingAction: string;
  controls: string[];
}

interface SupplyChainChecklistItem {
  id: string;
  group: 'contract_5_clauses' | 'offboarding_14d';
  code: string;
  title: string;
  isoRef: string;
  description: string;
  checked: boolean;
  note: string;
  updatedAt: string | null;
}

interface SupplyChainAuditSnapshot {
  generatedAt: string;
  standard: string;
  crossStandards: string[];
  sbomSummary: {
    totalComponents: number;
    npmRuntimeCount: number;
    npmDevCount: number;
    pythonRuntimeCount: number;
    pythonDevCount: number;
    unpinnedCount: number;
    unpinnedNames: string[];
  };
  suppliers: SupplyChainSupplier[];
  automatedControls: Array<{
    id: string;
    stage: string;
    stageLabel: string;
    title: string;
    status: 'ok' | 'warning';
    detail: string;
  }>;
  checklist: SupplyChainChecklistItem[];
  summary: {
    totalSuppliers: number;
    highRiskSuppliers: number;
    totalSbomComponents: number;
    unpinnedSbomComponents: number;
    contractClausesCompleted: number;
    contractClausesTotal: number;
    offboardingCompleted: number;
    offboardingTotal: number;
  };
}

interface SystemResourcesPanelProps {
  onOpenWebBot: () => void;
}

const MAX_SAMPLES = 36;
const MAX_RECENT_ALERTS = 50;
const THRESHOLDS_STORAGE_KEY = 'system_resources_alert_thresholds_v1';
const RECENT_ALERTS_STORAGE_KEY = 'system_resources_recent_alerts_v1';

const DEFAULT_THRESHOLDS: AlertThresholds = {
  enabled: true,
  queueWarning: 5,
  queueCritical: 15,
  durationWarningMs: 8000,
  durationCriticalMs: 15000,
  durationMetric: 'p95',
};

function loadSavedThresholds(): AlertThresholds {
  try {
    const raw = window.localStorage.getItem(THRESHOLDS_STORAGE_KEY);
    if (!raw) return DEFAULT_THRESHOLDS;
    const parsed = JSON.parse(raw) as Partial<AlertThresholds>;
    const queueWarning =
      typeof parsed.queueWarning === 'number' && parsed.queueWarning > 0
        ? parsed.queueWarning
        : DEFAULT_THRESHOLDS.queueWarning;
    const queueCritical =
      typeof parsed.queueCritical === 'number' && parsed.queueCritical > queueWarning
        ? parsed.queueCritical
        : Math.max(queueWarning + 1, DEFAULT_THRESHOLDS.queueCritical);
    const isLegacyUntouchedLatency =
      (parsed.durationWarningMs === 500 && parsed.durationCriticalMs === 1500) ||
      (parsed.durationWarningMs === 5000 && parsed.durationCriticalMs === 12000);
    const durationWarningMs =
      !isLegacyUntouchedLatency &&
      typeof parsed.durationWarningMs === 'number' &&
      parsed.durationWarningMs > 0
        ? parsed.durationWarningMs
        : DEFAULT_THRESHOLDS.durationWarningMs;
    const durationCriticalMs =
      !isLegacyUntouchedLatency &&
      typeof parsed.durationCriticalMs === 'number' &&
      parsed.durationCriticalMs > durationWarningMs
        ? parsed.durationCriticalMs
        : Math.max(durationWarningMs + 500, DEFAULT_THRESHOLDS.durationCriticalMs);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      queueWarning,
      queueCritical,
      durationWarningMs,
      durationCriticalMs,
      durationMetric: parsed.durationMetric === 'avg' ? 'avg' : 'p95',
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

function loadSavedRecentAlerts(): RecentAlertEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ALERTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentAlertEntry =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.timestamp === 'string' &&
          (item.metricType === 'queue_depth' || item.metricType === 'request_duration_seconds') &&
          (item.severity === 'warning' || item.severity === 'critical') &&
          typeof item.observedValue === 'string' &&
          typeof item.thresholdValue === 'string' &&
          typeof item.exceededValue === 'string'
      )
      .slice(0, MAX_RECENT_ALERTS);
  } catch {
    return [];
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAlertTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--/-- --:--:--';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd} ${formatClock(iso)}`;
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h} 時 ${m} 分 ${rem} 秒`;
  if (m > 0) return `${m} 分 ${rem} 秒`;
  return `${rem} 秒`;
}

function evaluateSeverity(value: number, warning: number, critical: number): AlertSeverity {
  if (value > critical) return 'critical';
  if (value > warning) return 'warning';
  return 'ok';
}

function geminiKeyLabel(state: string | undefined): string {
  if (!state) return '檢查中';
  if (state === 'ready' || state === 'configured') return '已設定';
  if (state === 'missing') return '未設定';
  return state;
}

interface ThresholdDraft {
  queueWarning: string;
  queueCritical: string;
  durationWarningMs: string;
  durationCriticalMs: string;
}

function toDraft(t: AlertThresholds): ThresholdDraft {
  return {
    queueWarning: String(t.queueWarning),
    queueCritical: String(t.queueCritical),
    durationWarningMs: String(t.durationWarningMs),
    durationCriticalMs: String(t.durationCriticalMs),
  };
}

export function SystemResourcesPanel({ onOpenWebBot }: SystemResourcesPanelProps) {
  const [snapshot, setSnapshot] = useState<LiveObservabilitySnapshot | null>(null);
  const [samples, setSamples] = useState<RollingSample[]>([]);
  const [pollIntervalMs, setPollIntervalMs] = useState<PollIntervalMs>(2000);
  const [latencyMode, setLatencyMode] = useState<LatencyChartMode>('timeseries');
  const [showRawPrometheus, setShowRawPrometheus] = useState(false);
  const [showThresholdConfig, setShowThresholdConfig] = useState(true);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedRaw, setCopiedRaw] = useState(false);

  const [thresholds, setThresholds] = useState<AlertThresholds>(() => loadSavedThresholds());
  const [draft, setDraft] = useState<ThresholdDraft>(() => toDraft(loadSavedThresholds()));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [recentAlerts, setRecentAlerts] = useState<RecentAlertEntry[]>(() =>
    loadSavedRecentAlerts()
  );
  const [alertFilter, setAlertFilter] = useState<AlertLogFilter>('all');

  const [healthReport, setHealthReport] = useState<HealthCheckReport | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [copiedCmdKey, setCopiedCmdKey] = useState<string | null>(null);
  const [copiedAllFixes, setCopiedAllFixes] = useState(false);

  const [showSupplyChain, setShowSupplyChain] = useState(false);
  const [supplyChainAudit, setSupplyChainAudit] = useState<SupplyChainAuditSnapshot | null>(null);
  const [supplyChainLoading, setSupplyChainLoading] = useState(false);
  const [supplyChainError, setSupplyChainError] = useState<string | null>(null);
  const [updatingChecklistId, setUpdatingChecklistId] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const settingsSectionRef = useRef<HTMLElement | null>(null);
  const healthSectionRef = useRef<HTMLElement | null>(null);
  const supplyChainSectionRef = useRef<HTMLElement | null>(null);
  const prevSeverityRef = useRef<{ queue: AlertSeverity; duration: AlertSeverity }>({
    queue: 'ok',
    duration: 'ok',
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(THRESHOLDS_STORAGE_KEY, JSON.stringify(thresholds));
    } catch {
      // Ignore storage quota errors
    }
  }, [thresholds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_ALERTS_STORAGE_KEY, JSON.stringify(recentAlerts));
    } catch {
      // Ignore storage quota errors
    }
  }, [recentAlerts]);

  const pushSample = useCallback((next: LiveObservabilitySnapshot) => {
    setSnapshot(next);
    if (Array.isArray(next.history) && next.history.length > 0) {
      const hydrated: RollingSample[] = next.history.slice(-MAX_SAMPLES).map((item) => ({
        time: formatClock(item.timestamp),
        queueDepth: item.queueDepth,
        queueDepthPeak: item.queueDepthPeak,
        ffmpegQueueLength: item.ffmpegQueueLength,
        ffmpegQueuePeak: item.ffmpegQueuePeak,
        reqAvgMs: item.reqAvgMs,
        reqP95Ms: item.reqP95Ms,
        ttsAvgMs: item.ttsAvgMs,
        ttsP95Ms: item.ttsP95Ms,
        rssMb: item.rssMb,
        heapUsedMb: item.heapUsedMb,
        cpuPercent: item.cpuPercent,
      }));
      setSamples(hydrated);
      return;
    }

    const point: RollingSample = {
      time: formatClock(next.timestamp),
      queueDepth: next.metrics.queueDepth,
      queueDepthPeak: next.metrics.queueDepthPeak ?? next.metrics.queueDepth,
      ffmpegQueueLength: next.metrics.ffmpegQueueLength,
      ffmpegQueuePeak: next.metrics.ffmpegQueuePeak ?? next.metrics.ffmpegQueueLength,
      reqAvgMs: next.metrics.requestDuration.avgMs,
      reqP95Ms: next.metrics.requestDuration.p95Ms,
      ttsAvgMs: next.metrics.ttsWait.avgMs,
      ttsP95Ms: next.metrics.ttsWait.p95Ms,
      rssMb: next.system.rssMb,
      heapUsedMb: next.system.heapUsedMb,
      cpuPercent: next.system.cpuPercent,
    };
    setSamples((prev) => [...prev.slice(-(MAX_SAMPLES - 1)), point]);
  }, []);

  const fetchLive = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch('/api/observability/live', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as LiveObservabilitySnapshot;
      pushSample(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法連線至 /api/observability/live');
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [pushSample]);

  const handleManualProbe = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const res = await fetch('/api/observability/probe', {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as LiveObservabilitySnapshot;
      pushSample(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '即時探測執行失敗');
    } finally {
      setProbing(false);
    }
  };

  const handleCopyPrometheus = async () => {
    if (!snapshot?.prometheusRaw) return;
    if (await copyToClipboard(snapshot.prometheusRaw)) {
      setCopiedRaw(true);
      window.setTimeout(() => setCopiedRaw(false), 1800);
    }
  };

  const handleRunHealthCheck = async () => {
    if (healthChecking) return;
    setHealthChecking(true);
    setHealthError(null);
    try {
      const res = await fetch('/api/observability/health-check', {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const report = (await res.json()) as HealthCheckReport;
      setHealthReport(report);
      window.requestAnimationFrame(() => {
        healthSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      // Refresh live metrics snapshot so the new trace span appears right away
      void fetchLive();
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : '無法執行系統健康檢查');
    } finally {
      setHealthChecking(false);
    }
  };

  const handleCopyFixCommand = async (key: string, command: string) => {
    if (await copyToClipboard(command)) {
      setCopiedCmdKey(key);
      window.setTimeout(() => {
        setCopiedCmdKey((prev) => (prev === key ? null : prev));
      }, 1800);
    }
  };

  const handleCopyAllFixCommands = async () => {
    if (!healthReport) return;
    const issueChecks = healthReport.checks.filter((c) => c.status !== 'ok');
    const lines = issueChecks.flatMap((c) => {
      const primary = c.fixCommands[0];
      return primary ? [`# ${c.name} (${primary.label})`, primary.command] : [];
    });
    if (lines.length === 0) return;
    if (await copyToClipboard(lines.join('\n'))) {
      setCopiedAllFixes(true);
      window.setTimeout(() => setCopiedAllFixes(false), 2000);
    }
  };

  const fetchSupplyChainAudit = useCallback(async () => {
    setSupplyChainLoading(true);
    setSupplyChainError(null);
    try {
      const res = await fetch('/api/observability/supply-chain', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SupplyChainAuditSnapshot;
      setSupplyChainAudit(data);
    } catch (err) {
      setSupplyChainError(err instanceof Error ? err.message : '無法載入 ISO/IEC 27036 供應鏈稽核資料');
    } finally {
      setSupplyChainLoading(false);
    }
  }, []);

  const handleToggleSupplyChain = () => {
    const next = !showSupplyChain;
    setShowSupplyChain(next);
    if (next) {
      void fetchSupplyChainAudit();
      window.requestAnimationFrame(() => {
        supplyChainSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  };

  const handleToggleChecklistItem = async (item: SupplyChainChecklistItem) => {
    if (updatingChecklistId) return;
    setUpdatingChecklistId(item.id);
    setSupplyChainError(null);
    try {
      const res = await fetch('/api/observability/supply-chain/checklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Interaction': '1',
        },
        body: JSON.stringify({
          id: item.id,
          checked: !item.checked,
          note: item.note,
          _hp: '',
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        audit?: SupplyChainAuditSnapshot;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.audit) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSupplyChainAudit(data.audit);
    } catch (err) {
      setSupplyChainError(err instanceof Error ? err.message : '更新檢核項目失敗');
    } finally {
      setUpdatingChecklistId(null);
    }
  };

  const handleDownloadSbom = async () => {
    try {
      const res = await fetch('/api/observability/sbom', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'web-voice-bot-sbom-cyclonedx.json';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 6000);
    } catch (err) {
      setSupplyChainError(err instanceof Error ? err.message : '無法匯出 SBOM 檔案');
    }
  };

  useEffect(() => {
    void fetchLive();
  }, [fetchLive]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return undefined;
    const id = window.setInterval(() => {
      void fetchLive();
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [pollIntervalMs, fetchLive]);

  // Evaluate live threshold status for queue_depth and request_duration_seconds
  const alertEvaluation = useMemo(() => {
    if (!snapshot || !thresholds.enabled) {
      return {
        queueSeverity: 'ok' as AlertSeverity,
        durationSeverity: 'ok' as AlertSeverity,
        activeAlerts: [] as ActiveAlert[],
        signature: '',
      };
    }

    const queueVal = snapshot.metrics.queueDepth;
    const queueSeverity = evaluateSeverity(
      queueVal,
      thresholds.queueWarning,
      thresholds.queueCritical
    );

    const hasRequestSamples = snapshot.metrics.requestDuration.count > 0;
    const durationValMs =
      thresholds.durationMetric === 'avg'
        ? snapshot.metrics.requestDuration.avgMs
        : snapshot.metrics.requestDuration.p95Ms;
    const durationMetricTag = thresholds.durationMetric === 'avg' ? '平均值 Avg' : 'P95';

    const durationSeverity = hasRequestSamples
      ? evaluateSeverity(
          durationValMs,
          thresholds.durationWarningMs,
          thresholds.durationCriticalMs
        )
      : ('ok' as AlertSeverity);

    const activeAlerts: ActiveAlert[] = [];

    if (queueSeverity !== 'ok') {
      const limit =
        queueSeverity === 'critical' ? thresholds.queueCritical : thresholds.queueWarning;
      activeAlerts.push({
        id: 'queue_depth',
        metricName: 'queue_depth',
        title: '佇列深度超標',
        severity: queueSeverity,
        currentLabel: `${queueVal} 筆`,
        thresholdLabel: `${limit} 筆`,
        message: `queue_depth 目前為 ${queueVal} 筆，已超過${
          queueSeverity === 'critical' ? '嚴重' : '警告'
        }上限（> ${limit} 筆）`,
      });
    }

    if (durationSeverity !== 'ok') {
      const limit =
        durationSeverity === 'critical'
          ? thresholds.durationCriticalMs
          : thresholds.durationWarningMs;
      activeAlerts.push({
        id: 'request_duration_seconds',
        metricName: 'request_duration_seconds',
        title: '請求延遲超標',
        severity: durationSeverity,
        currentLabel: `${durationValMs.toFixed(1)} ms (${durationMetricTag})`,
        thresholdLabel: `${limit} ms`,
        message: `request_duration_seconds（${durationMetricTag}）目前為 ${durationValMs.toFixed(
          1
        )} ms（${(durationValMs / 1000).toFixed(2)}s），已超過${
          durationSeverity === 'critical' ? '嚴重' : '警告'
        }上限（> ${limit} ms）`,
      });
    }

    const signature = activeAlerts.map((a) => `${a.id}:${a.severity}`).join('|');

    return {
      queueSeverity,
      durationSeverity,
      activeAlerts,
      signature,
    };
  }, [snapshot, thresholds]);

  // Persist triggered alerts whenever queue_depth or request_duration_seconds crosses into warning/critical
  useEffect(() => {
    if (!snapshot || !thresholds.enabled) return;

    const prev = prevSeverityRef.current;
    const timestamp = formatAlertTimestamp(snapshot.timestamp);
    const triggered: RecentAlertEntry[] = [];

    if (
      alertEvaluation.queueSeverity !== 'ok' &&
      alertEvaluation.queueSeverity !== prev.queue
    ) {
      const sev = alertEvaluation.queueSeverity;
      const val = snapshot.metrics.queueDepth;
      const limit = sev === 'critical' ? thresholds.queueCritical : thresholds.queueWarning;
      const delta = Math.max(0, val - limit);
      triggered.push({
        id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp,
        metricType: 'queue_depth',
        metricLabel: '佇列深度',
        severity: sev,
        observedValue: `${val} 筆`,
        thresholdValue: `> ${limit} 筆`,
        exceededValue: `+${delta} 筆`,
        note: sev === 'critical' ? '超過嚴重安全上限' : '超過警告安全上限',
      });
    }

    if (
      alertEvaluation.durationSeverity !== 'ok' &&
      alertEvaluation.durationSeverity !== prev.duration
    ) {
      const sev = alertEvaluation.durationSeverity;
      const durationValMs =
        thresholds.durationMetric === 'avg'
          ? snapshot.metrics.requestDuration.avgMs
          : snapshot.metrics.requestDuration.p95Ms;
      const metricTag = thresholds.durationMetric === 'avg' ? '平均 Avg' : 'P95';
      const limit =
        sev === 'critical' ? thresholds.durationCriticalMs : thresholds.durationWarningMs;
      const deltaMs = Math.max(0, durationValMs - limit);
      triggered.push({
        id: `duration-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp,
        metricType: 'request_duration_seconds',
        metricLabel: '請求延遲',
        severity: sev,
        observedValue: `${durationValMs.toFixed(1)} ms (${(durationValMs / 1000).toFixed(2)}s)`,
        thresholdValue: `> ${limit} ms (${(limit / 1000).toFixed(2)}s)`,
        exceededValue: `+${deltaMs.toFixed(1)} ms`,
        note: `${metricTag} ${sev === 'critical' ? '超過嚴重上限' : '超過警告上限'}`,
      });
    }

    if (triggered.length > 0) {
      setRecentAlerts((old) => [...triggered, ...old].slice(0, MAX_RECENT_ALERTS));
    }

    prevSeverityRef.current = {
      queue: alertEvaluation.queueSeverity,
      duration: alertEvaluation.durationSeverity,
    };
  }, [snapshot, thresholds, alertEvaluation]);

  const filteredRecentAlerts = useMemo(() => {
    if (alertFilter === 'all') return recentAlerts;
    return recentAlerts.filter((entry) => entry.metricType === alertFilter);
  }, [recentAlerts, alertFilter]);

  const handleDraftChange = (field: keyof ThresholdDraft, rawValue: string) => {
    setDraft((prev) => ({ ...prev, [field]: rawValue }));
    setDraftError(null);
    setSavedNotice(false);
  };

  const applyDraftThresholds = () => {
    const queueWarning = Number(draft.queueWarning);
    const queueCritical = Number(draft.queueCritical);
    const durationWarningMs = Number(draft.durationWarningMs);
    const durationCriticalMs = Number(draft.durationCriticalMs);

    if (
      !Number.isFinite(queueWarning) ||
      !Number.isFinite(queueCritical) ||
      queueWarning <= 0 ||
      queueCritical <= 0
    ) {
      setDraftError('佇列深度 (queue_depth) 門檻必須為大於 0 的數字。');
      return;
    }
    if (queueCritical <= queueWarning) {
      setDraftError('佇列深度的嚴重上限必須大於警告上限。');
      return;
    }
    if (
      !Number.isFinite(durationWarningMs) ||
      !Number.isFinite(durationCriticalMs) ||
      durationWarningMs <= 0 ||
      durationCriticalMs <= 0
    ) {
      setDraftError('請求延遲 (request_duration_seconds) 門檻必須為大於 0 的毫秒數。');
      return;
    }
    if (durationCriticalMs <= durationWarningMs) {
      setDraftError('請求延遲的嚴重上限必須大於警告上限。');
      return;
    }

    const updated: AlertThresholds = {
      ...thresholds,
      queueWarning: Math.round(queueWarning),
      queueCritical: Math.round(queueCritical),
      durationWarningMs: Math.round(durationWarningMs),
      durationCriticalMs: Math.round(durationCriticalMs),
    };
    setThresholds(updated);
    setDraft(toDraft(updated));
    setDraftError(null);
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2200);
  };

  const handleResetThresholds = () => {
    setThresholds(DEFAULT_THRESHOLDS);
    setDraft(toDraft(DEFAULT_THRESHOLDS));
    setDraftError(null);
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2200);
  };

  const scrollToSettings = () => {
    setShowThresholdConfig(true);
    window.requestAnimationFrame(() => {
      settingsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const hasUnsavedDraft =
    draft.queueWarning !== String(thresholds.queueWarning) ||
    draft.queueCritical !== String(thresholds.queueCritical) ||
    draft.durationWarningMs !== String(thresholds.durationWarningMs) ||
    draft.durationCriticalMs !== String(thresholds.durationCriticalMs);

  // Convert cumulative Prometheus histogram buckets into per-bucket counts for BarChart
  const requestHistogramBars = useMemo(() => {
    if (!snapshot) return [];
    const buckets = snapshot.metrics.requestDuration.buckets;
    let prev = 0;
    const bars = buckets.map((b) => {
      const delta = Math.max(0, b.count - prev);
      prev = b.count;
      return {
        label: b.le < 1 ? `${Math.round(b.le * 1000)}ms` : `${b.le}s`,
        count: delta,
        cumulative: b.count,
      };
    });
    const infDelta = Math.max(0, snapshot.metrics.requestDuration.count - prev);
    if (infDelta > 0) {
      bars.push({
        label: '>60s',
        count: infDelta,
        cumulative: snapshot.metrics.requestDuration.count,
      });
    }
    return bars;
  }, [snapshot]);

  const redisHealthy = snapshot?.redis.status === 'healthy';
  const hasActiveAlerts = alertEvaluation.activeAlerts.length > 0;
  const hasCriticalAlert = alertEvaluation.activeAlerts.some((a) => a.severity === 'critical');

  return (
    <div className="space-y-6">
      {/* Persistent, Non-Intrusive Top Warning Banner (Chinese) */}
      {thresholds.enabled && hasActiveAlerts && (
        <div
          role="alert"
          aria-live="polite"
          className={`px-4 sm:px-5 py-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            hasCriticalAlert
              ? 'bg-red-50/95 border-red-300 text-red-950'
              : 'bg-amber-50/95 border-amber-300 text-amber-950'
          }`}
        >
          <div className="flex items-start sm:items-center gap-2.5 min-w-0">
            {hasCriticalAlert ? (
              <AlertOctagon
                className="w-4 h-4 text-red-600 shrink-0 mt-0.5 sm:mt-0"
                aria-hidden="true"
              />
            ) : (
              <AlertTriangle
                className="w-4 h-4 text-amber-600 shrink-0 mt-0.5 sm:mt-0"
                aria-hidden="true"
              />
            )}
            <div className="text-xs sm:text-sm leading-snug min-w-0">
              <span className="font-semibold">
                {hasCriticalAlert ? '系統效能嚴重告警：' : '系統效能警告：'}
              </span>
              <span className="font-mono tabular-nums">
                {alertEvaluation.activeAlerts.map((a) => a.message).join('；')}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={scrollToSettings}
            className={`text-xs font-medium underline underline-offset-4 whitespace-nowrap shrink-0 self-start sm:self-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded ${
              hasCriticalAlert
                ? 'text-red-800 hover:text-red-950'
                : 'text-amber-900 hover:text-amber-950'
            }`}
          >
            調整閾值設定
          </button>
        </div>
      )}

      {/* Header & Live Polling Controls */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              系統資源與即時告警監控
            </h1>
            <p className="mt-1.5 text-sm sm:text-base text-slate-600">
              即時擷取執行中機器人的 Prometheus 指標，持續監控佇列深度、端到端請求延遲、TTS
              等待時間、主機記憶體與 Redis 健康狀態，並在超過安全上限時即時告警。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-slate-700">
                <span>
                  {pollIntervalMs > 0 ? `自動更新（每 ${pollIntervalMs / 1000} 秒）` : '已暫停自動更新'}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                來源：
                {snapshot
                  ? `${snapshot.source === 'python-bot' ? 'Python Bot' : 'Web Express'} (${
                      snapshot.scrapeEndpoint
                    })`
                  : '連線中...'}
              </span>
              {snapshot && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>運行時間 {formatUptime(snapshot.uptimeSeconds)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {snapshot.system.cpuCores} vCPU / {snapshot.system.totalMemMb.toLocaleString()}{' '}
                    MB RAM
                  </span>
                  {snapshot.deploymentProfile && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          snapshot.deploymentProfile.mode === 'constrained_1c1g'
                            ? 'text-amber-700 font-semibold'
                            : 'text-emerald-700 font-semibold'
                        }
                      >
                        {snapshot.deploymentProfile.mode === 'constrained_1c1g'
                          ? `1C/1G 單 Bot 保護（可用 ${snapshot.deploymentProfile.resources.effective_available_ram_mb} MB）`
                          : `高併發多 Bot（可用 ${snapshot.deploymentProfile.resources.effective_available_ram_mb} MB · 上限 ${snapshot.deploymentProfile.max_bots} Bots · FFmpeg×${snapshot.deploymentProfile.ffmpeg_concurrency}）`}
                      </span>
                    </>
                  )}
                  {snapshot.botGuard && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          snapshot.botGuard.blockedTotal > 0
                            ? 'text-amber-700 font-semibold'
                            : 'text-slate-700'
                        }
                      >
                        防惡意機器人 {snapshot.botGuard.enabled ? 'ON' : 'OFF'}（攔截{' '}
                        {snapshot.botGuard.blockedTotal} · 挑戰 {snapshot.botGuard.challengedTotal} ·
                        通過 {snapshot.botGuard.verifiedHumansTotal}）
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>更新於 {formatClock(snapshot.timestamp)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <div
              role="group"
              aria-label="輪詢間隔"
              className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              {(
                [
                  { ms: 2000, label: '2秒' },
                  { ms: 5000, label: '5秒' },
                  { ms: 10000, label: '10秒' },
                  { ms: 0, label: '暫停' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.ms}
                  type="button"
                  onClick={() => setPollIntervalMs(opt.ms)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                    pollIntervalMs === opt.ms
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void fetchLive()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <RefreshCw className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
              <span>立即更新</span>
            </button>

            <button
              type="button"
              onClick={() => void handleManualProbe()}
              disabled={probing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
            >
              <Play className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{probing ? '探測中...' : '執行即時探測'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRunHealthCheck()}
              disabled={healthChecking}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                healthReport?.overallStatus === 'error'
                  ? 'text-red-700 bg-red-50 border-red-300 hover:bg-red-100/70'
                  : healthReport?.overallStatus === 'warning'
                    ? 'text-amber-800 bg-amber-50 border-amber-300 hover:bg-amber-100/70'
                    : healthReport
                      ? 'text-emerald-800 bg-emerald-50 border-emerald-200 hover:bg-emerald-100/70'
                      : 'text-slate-800 bg-white border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Stethoscope
                className={`w-3.5 h-3.5 shrink-0 ${healthChecking ? 'animate-pulse' : ''}`}
                aria-hidden="true"
              />
              <span>{healthChecking ? '健康檢查中...' : '系統健康檢查'}</span>
            </button>

            <button
              type="button"
              onClick={handleToggleSupplyChain}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                showSupplyChain
                  ? 'text-blue-700 bg-blue-50 border-blue-200'
                  : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>供應鏈稽核 (27036)</span>
            </button>

            <button
              type="button"
              onClick={() => setShowThresholdConfig((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                showThresholdConfig
                  ? 'text-blue-700 bg-blue-50 border-blue-200'
                  : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>告警閾值</span>
            </button>

            <button
              type="button"
              onClick={() => setShowRawPrometheus((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                showRawPrometheus
                  ? 'text-blue-700 bg-blue-50 border-blue-200'
                  : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Terminal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>原始 /metrics</span>
            </button>
          </div>
        </div>

        {/* Scrape Error Notice */}
        {error && (
          <div
            role="alert"
            className="mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2.5 text-sm text-red-800"
          >
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
            <span>指標擷取失敗：{error}</span>
          </div>
        )}

        {/* Quiet Inline Operational Health Bar */}
        <div className="mt-4 pt-3.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
          {!thresholds.enabled ? (
            <div className="inline-flex items-center gap-1.5 text-slate-500">
              <BellOff className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <span>閾值告警監控已停用，僅持續記錄即時數據。</span>
            </div>
          ) : hasActiveAlerts ? (
            <div
              className={`inline-flex items-center gap-1.5 font-medium ${
                hasCriticalAlert ? 'text-red-700' : 'text-amber-700'
              }`}
            >
              <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>
                目前有 {alertEvaluation.activeAlerts.length} 項指標超過自訂安全上限（上方持續提示中）
              </span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
              <span>
                所有告警規則正常：queue_depth 與 request_duration_seconds 皆位於安全運作範圍內
              </span>
            </div>
          )}

          <div className="text-slate-500 font-mono tabular-nums">
            目前規則：queue_depth &gt; {thresholds.queueWarning}/{thresholds.queueCritical} 筆 ·{' '}
            request_duration ({thresholds.durationMetric === 'avg' ? 'Avg' : 'P95'}) &gt;{' '}
            {thresholds.durationWarningMs}/{thresholds.durationCriticalMs} ms
          </div>
        </div>

        {/* 4-Column Live KPI Row */}
        <div className="mt-4 pt-5 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-0 lg:divide-x lg:divide-slate-200">
          {/* KPI 1: Queue Depth */}
          <div className="lg:pr-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-500">佇列深度 (queue_depth)</p>
              {thresholds.enabled && alertEvaluation.queueSeverity !== 'ok' && (
                <span
                  className={`inline-flex items-center gap-1 text-xs font-semibold ${
                    alertEvaluation.queueSeverity === 'critical'
                      ? 'text-red-700'
                      : 'text-amber-700'
                  }`}
                >
                  {alertEvaluation.queueSeverity === 'critical' ? (
                    <AlertOctagon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>{alertEvaluation.queueSeverity === 'critical' ? '嚴重超標' : '警告'}</span>
                </span>
              )}
            </div>
            <p
              className={`mt-1 font-mono tabular-nums text-2xl font-bold ${
                alertEvaluation.queueSeverity === 'critical'
                  ? 'text-red-700'
                  : alertEvaluation.queueSeverity === 'warning'
                    ? 'text-amber-700'
                    : 'text-slate-900'
              }`}
            >
              {snapshot ? snapshot.metrics.queueDepth : '--'}{' '}
              <span className="text-sm font-normal text-slate-500">
                / ffmpeg {snapshot ? snapshot.metrics.ffmpegQueueLength : '--'}
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              近期峰值 {snapshot?.metrics.queueDepthPeak ?? 0}（最高{' '}
              {snapshot?.metrics.queueDepthAllTimePeak ?? 0}）· 累計任務{' '}
              {snapshot?.metrics.queueTasksTotal ?? 0} 次
            </p>
          </div>

          {/* KPI 2: Request Duration */}
          <div className="lg:px-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-500">請求延遲 (request_duration)</p>
              {thresholds.enabled && alertEvaluation.durationSeverity !== 'ok' && (
                <span
                  className={`inline-flex items-center gap-1 text-xs font-semibold ${
                    alertEvaluation.durationSeverity === 'critical'
                      ? 'text-red-700'
                      : 'text-amber-700'
                  }`}
                >
                  {alertEvaluation.durationSeverity === 'critical' ? (
                    <AlertOctagon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>
                    {alertEvaluation.durationSeverity === 'critical' ? '嚴重超標' : '警告'}
                  </span>
                </span>
              )}
            </div>
            <p
              className={`mt-1 font-mono tabular-nums text-2xl font-bold ${
                alertEvaluation.durationSeverity === 'critical'
                  ? 'text-red-700'
                  : alertEvaluation.durationSeverity === 'warning'
                    ? 'text-amber-700'
                    : 'text-slate-900'
              }`}
            >
              {snapshot ? `${snapshot.metrics.requestDuration.p95Ms.toFixed(1)}` : '--'}{' '}
              <span className="text-sm font-normal text-slate-500">ms P95</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              平均 {snapshot ? snapshot.metrics.requestDuration.avgMs.toFixed(1) : '--'} ms · 累計{' '}
              {snapshot ? snapshot.metrics.requestDuration.count : 0} 次請求
            </p>
          </div>

          {/* KPI 3: TTS Wait */}
          <div className="lg:px-6">
            <p className="text-xs font-medium text-slate-500">TTS 等待時間 (tts_wait_seconds)</p>
            <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              {snapshot ? `${snapshot.metrics.ttsWait.p95Ms.toFixed(1)}` : '--'}{' '}
              <span className="text-sm font-normal text-slate-500">ms P95</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              {snapshot && snapshot.metrics.ttsWait.count === 0
                ? (snapshot.metrics.ttsDegradedTotal ?? 0) > 0
                  ? `純文字降級 ${snapshot.metrics.ttsDegradedTotal} 次（TTS 套件未就緒）`
                  : '尚無語音合成紀錄（語音回覆時觸發）'
                : `平均 ${snapshot ? snapshot.metrics.ttsWait.avgMs.toFixed(1) : '--'} ms · 累計 ${
                    snapshot ? snapshot.metrics.ttsWait.count : 0
                  } 次語音合成`}
            </p>
          </div>

          {/* KPI 4: Redis Health */}
          <div className="lg:pl-6">
            <p className="text-xs font-medium text-slate-500">Redis 健康狀態</p>
            <div className="mt-1 flex items-center gap-2">
              {snapshot ? (
                redisHealthy ? (
                  <>
                    <CheckCircle2
                      className="w-5 h-5 text-emerald-600 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-display text-xl font-bold text-emerald-700">正常連線</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle
                      className="w-5 h-5 text-amber-600 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-display text-xl font-bold text-amber-700">
                      降級放行 (Fail-Open)
                    </span>
                  </>
                )
              ) : (
                <span className="font-mono text-xl font-bold text-slate-400">檢查中...</span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              {snapshot
                ? redisHealthy
                  ? `${snapshot.redis.target} · TCP ${snapshot.redis.latencyMs} ms`
                  : `${snapshot.redis.target} · 失敗次數 ${snapshot.redis.failuresTotal}`
                : '正在執行 TCP 探測'}
            </p>
          </div>
        </div>
      </section>

      {/* ISO/IEC 27036 Supply Chain Security, Supplier Risk Inventory & CycloneDX SBOM Drawer */}
      {showSupplyChain && (
        <section
          ref={supplyChainSectionRef}
          aria-label="ISO/IEC 27036 供應鏈資安與 SBOM 稽核"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden scroll-mt-20"
        >
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  ISO/IEC 27036 供應鏈資安與 SBOM 稽核
                </h2>
                {supplyChainAudit && (
                  <span className="text-xs font-mono text-slate-600">
                    {supplyChainAudit.summary.totalSuppliers} 供應商 ·{' '}
                    {supplyChainAudit.summary.totalSbomComponents} SBOM 元件 · 合約條款{' '}
                    {supplyChainAudit.summary.contractClausesCompleted}/
                    {supplyChainAudit.summary.contractClausesTotal} · 退場檢核{' '}
                    {supplyChainAudit.summary.offboardingCompleted}/
                    {supplyChainAudit.summary.offboardingTotal}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                對應 ISO/IEC 27036（四階段生命週期）× ISO/IEC 27035 × ISO/IEC 30111 × 歐盟 CRA/NIS2 24h 通報 SLA；所有憑證僅顯示環境變數狀態，絕不外洩真實金鑰。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleDownloadSbom()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>下載 CycloneDX 1.5 SBOM</span>
              </button>
              <button
                type="button"
                onClick={() => void fetchSupplyChainAudit()}
                disabled={supplyChainLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${supplyChainLoading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>重新盤點</span>
              </button>
              <button
                type="button"
                onClick={() => setShowSupplyChain(false)}
                aria-label="關閉供應鏈稽核面板"
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-5 sm:p-6 space-y-6">
            {supplyChainError && (
              <div
                role="alert"
                className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800"
              >
                {supplyChainError}
              </div>
            )}

            {supplyChainAudit && (
              <>
                {/* 4-Stage Automated Control Status */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {supplyChainAudit.automatedControls.map((ctrl) => (
                    <div
                      key={ctrl.id}
                      className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/60 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono text-slate-500">
                          {ctrl.stageLabel}
                        </span>
                        <span
                          className={`text-[11px] font-semibold ${
                            ctrl.status === 'ok' ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {ctrl.status === 'ok' ? '合規就緒' : '待補強'}
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-slate-900">{ctrl.title}</p>
                      <p className="text-xs text-slate-600 leading-relaxed">{ctrl.detail}</p>
                    </div>
                  ))}
                </div>

                {/* Supplier Risk Inventory Table */}
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    外部供應商風險分級盤點（高／中／低風險）
                  </h3>
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="py-2.5 px-3 font-semibold">供應商 / 角色</th>
                          <th className="py-2.5 px-3 font-semibold">風險等級</th>
                          <th className="py-2.5 px-3 font-semibold">憑證與端點（遮罩）</th>
                          <th className="py-2.5 px-3 font-semibold">通報 SLA 與退場撤銷</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {supplyChainAudit.suppliers.map((sup) => (
                          <tr key={sup.id} className="align-top">
                            <td className="py-2.5 px-3">
                              <p className="font-semibold text-slate-900">{sup.name}</p>
                              <p className="text-[11px] text-slate-500">{sup.category}</p>
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <span
                                className={`font-semibold ${
                                  sup.riskTier === 'high'
                                    ? 'text-red-700'
                                    : sup.riskTier === 'medium'
                                      ? 'text-amber-700'
                                      : 'text-emerald-700'
                                }`}
                              >
                                {sup.riskTier === 'high'
                                  ? '高風險'
                                  : sup.riskTier === 'medium'
                                    ? '中風險'
                                    : '低風險'}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px] text-slate-700 space-y-0.5">
                              <p>
                                {sup.credentialEnvNames.join(', ')}（
                                {sup.configured ? '已設定' : '未設定'}）
                              </p>
                              <p className="text-slate-500 break-all">{sup.endpointSummary}</p>
                            </td>
                            <td className="py-2.5 px-3 text-slate-600 space-y-0.5">
                              <p className="font-medium text-slate-800">{sup.slaRequirement}</p>
                              <p className="text-[11px] text-slate-500">
                                退場：{sup.offboardingAction}
                              </p>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Interactive 5 Contract Clauses + 14-Day Offboarding Checklist */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {(
                    [
                      {
                        group: 'contract_5_clauses',
                        title: '委外合約 5 個保命條款檢核表（決標前必查）',
                      },
                      {
                        group: 'offboarding_14d',
                        title: '委外終止 14 天退場與銷毀檢核表（Offboarding）',
                      },
                    ] as const
                  ).map((section) => (
                    <div
                      key={section.group}
                      className="border border-slate-200 rounded-lg p-4 space-y-2.5"
                    >
                      <h3 className="text-xs font-semibold text-slate-900">{section.title}</h3>
                      <div className="space-y-2">
                        {supplyChainAudit.checklist
                          .filter((item) => item.group === section.group)
                          .map((item) => (
                            <label
                              key={item.id}
                              className="flex items-start gap-2.5 p-2 rounded-md hover:bg-slate-50 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={item.checked}
                                disabled={updatingChecklistId === item.id}
                                onChange={() => void handleToggleChecklistItem(item)}
                                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                              />
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-[11px] text-slate-500">
                                    {item.code}
                                  </span>
                                  <span
                                    className={`text-xs font-medium ${
                                      item.checked
                                        ? 'line-through text-slate-500'
                                        : 'text-slate-900'
                                    }`}
                                  >
                                    {item.title}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 leading-relaxed">
                                  {item.description}
                                </p>
                              </div>
                            </label>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* System Health Check Results (Itemized list + Copyable Fix Commands) */}
      {(healthChecking || healthReport || healthError) && (
        <section
          ref={healthSectionRef}
          aria-label="系統健康檢查結果"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden scroll-mt-20"
        >
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <Stethoscope className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  系統健康檢查結果
                </h2>
                {healthReport && (
                  <span
                    className={`text-xs font-semibold font-mono ${
                      healthReport.overallStatus === 'error'
                        ? 'text-red-700'
                        : healthReport.overallStatus === 'warning'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }`}
                  >
                    {healthReport.overallStatus === 'error'
                      ? `發現 ${healthReport.summary.error} 項異常${
                          healthReport.summary.warning > 0
                            ? `、${healthReport.summary.warning} 項警告`
                            : ''
                        }`
                      : healthReport.overallStatus === 'warning'
                        ? `核心正常，${healthReport.summary.warning} 項建議注意`
                        : `全部通過（${healthReport.summary.ok}/${healthReport.summary.total}）`}
                  </span>
                )}
              </div>
              {healthReport && (
                <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums break-all">
                  檢查時間：{formatClock(healthReport.checkedAt)} · 耗時 {healthReport.elapsedMs} ms
                  · 作業系統：{healthReport.hostOs === 'windows' ? 'Windows' : 'Linux'} · Python：
                  {healthReport.pythonBin}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {healthReport && healthReport.summary.error + healthReport.summary.warning > 0 && (
                <button
                  type="button"
                  onClick={() => void handleCopyAllFixCommands()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100/70 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  {copiedAllFixes ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>{copiedAllFixes ? '已複製全部修復指令' : '複製全部修復指令'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void handleRunHealthCheck()}
                disabled={healthChecking}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-slate-500 shrink-0 ${
                    healthChecking ? 'animate-spin' : ''
                  }`}
                  aria-hidden="true"
                />
                <span>{healthChecking ? '重新檢查中...' : '重新檢查'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setHealthReport(null);
                  setHealthError(null);
                }}
                aria-label="關閉健康檢查結果"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>收合</span>
              </button>
            </div>
          </div>

          {healthError && (
            <div
              role="alert"
              className="px-5 sm:px-6 py-4 bg-red-50 border-b border-red-200 flex items-center gap-2.5 text-sm text-red-800"
            >
              <XCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
              <span>健康檢查執行失敗：{healthError}</span>
            </div>
          )}

          {healthChecking && !healthReport && (
            <div className="px-6 py-10 text-center text-sm text-slate-600">
              正在檢查 Python redis 模組、FFmpeg 安裝狀態與核心相依環境...
            </div>
          )}

          {healthReport && (
            <ul className="divide-y divide-slate-200">
              {healthReport.checks.map((item) => {
                const isError = item.status === 'error';
                const isWarning = item.status === 'warning';
                return (
                  <li
                    key={item.id}
                    className={`px-5 sm:px-6 py-4 ${
                      isError
                        ? 'bg-red-50/40'
                        : isWarning
                          ? 'bg-amber-50/35'
                          : 'bg-white'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                      {/* Left: Status + Itemized Diagnostic Detail */}
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="mt-0.5 shrink-0">
                          {isError ? (
                            <XCircle className="w-4 h-4 text-red-600" aria-hidden="true" />
                          ) : isWarning ? (
                            <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden="true" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <span className="text-sm font-semibold text-slate-900">
                              {item.name}
                            </span>
                            <span
                              className={`text-xs font-semibold ${
                                isError
                                  ? 'text-red-700'
                                  : isWarning
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {isError ? '異常（缺少元件）' : isWarning ? '警告' : '正常'}
                            </span>
                            <span className="text-xs text-slate-400" aria-hidden="true">
                              ·
                            </span>
                            <span className="text-xs text-slate-500">{item.category}</span>
                            {item.version && (
                              <>
                                <span className="text-xs text-slate-400" aria-hidden="true">
                                  ·
                                </span>
                                <span className="text-xs font-mono text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                                  {item.version}
                                </span>
                              </>
                            )}
                          </div>

                          <p className="mt-1 text-xs sm:text-sm text-slate-700 leading-relaxed">
                            {item.detail}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">{item.fixSummary}</p>

                          {/* Copyable Fix Commands */}
                          {item.fixCommands.length > 0 && (
                            <div className="mt-3 space-y-2">
                              {item.fixCommands.map((cmdObj, idx) => {
                                const cmdKey = `${item.id}-${idx}`;
                                const isCopied = copiedCmdKey === cmdKey;
                                return (
                                  <div
                                    key={cmdKey}
                                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 bg-slate-900 text-slate-100 rounded-lg border border-slate-800"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <span className="block text-[11px] text-slate-400 mb-0.5">
                                        {cmdObj.label}
                                      </span>
                                      <code className="block font-mono text-xs text-emerald-300 break-all select-all">
                                        {cmdObj.command}
                                      </code>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void handleCopyFixCommand(cmdKey, cmdObj.command)
                                      }
                                      className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 self-start sm:self-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                    >
                                      {isCopied ? (
                                        <>
                                          <Check
                                            className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                                            aria-hidden="true"
                                          />
                                          <span className="text-emerald-300">已複製</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                          <span>複製指令</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Custom Alert Threshold Settings Section */}
      {showThresholdConfig && (
        <section
          ref={settingsSectionRef}
          aria-label="自訂告警閾值設定"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden scroll-mt-20"
        >
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">
                自訂告警閾值設定
              </h2>
              <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                自訂{' '}
                <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                  queue_depth
                </code>{' '}
                與{' '}
                <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                  request_duration_seconds
                </code>{' '}
                的警告／嚴重上限。超過門檻時，分頁頂端會持續顯示中文警告橫幅，並於圖表下方記錄至「近期告警紀錄」。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setThresholds((prev) => ({ ...prev, enabled: !prev.enabled }))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  thresholds.enabled
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100/70'
                    : 'bg-slate-50 border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {thresholds.enabled ? (
                  <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <BellOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                )}
                <span>{thresholds.enabled ? '告警監控：開啟' : '告警監控：已停用'}</span>
              </button>

              <button
                type="button"
                onClick={handleResetThresholds}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <RotateCcw className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                <span>重設預設值</span>
              </button>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyDraftThresholds();
            }}
            className="p-5 sm:p-6 space-y-5"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:divide-x md:divide-slate-200">
              {/* Rule 1: queue_depth */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    佇列深度上限（<code className="font-mono text-xs">queue_depth</code>）
                  </span>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      alertEvaluation.queueSeverity === 'critical'
                        ? 'text-red-700'
                        : alertEvaluation.queueSeverity === 'warning'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }`}
                  >
                    {alertEvaluation.queueSeverity === 'critical'
                      ? '目前：嚴重超標'
                      : alertEvaluation.queueSeverity === 'warning'
                        ? '目前：警告'
                        : '目前：正常'}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  監控等待處理的佇列筆數，避免排隊積壓導致回應延遲。
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block text-xs text-slate-600 mb-1">警告上限（筆）</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.queueWarning}
                      onChange={(e) => handleDraftChange('queueWarning', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-slate-600 mb-1">嚴重上限（筆）</span>
                    <input
                      type="number"
                      min={2}
                      step={1}
                      value={draft.queueCritical}
                      onChange={(e) => handleDraftChange('queueCritical', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </label>
                </div>
              </div>

              {/* Rule 2: request_duration_seconds */}
              <div className="md:pl-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    請求延遲上限（
                    <code className="font-mono text-xs">request_duration_seconds</code>）
                  </span>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      alertEvaluation.durationSeverity === 'critical'
                        ? 'text-red-700'
                        : alertEvaluation.durationSeverity === 'warning'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }`}
                  >
                    {alertEvaluation.durationSeverity === 'critical'
                      ? '目前：嚴重超標'
                      : alertEvaluation.durationSeverity === 'warning'
                        ? '目前：警告'
                        : '目前：正常'}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">延遲評估基準</span>
                  <div
                    role="group"
                    aria-label="延遲評估基準"
                    className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setThresholds((prev) => ({ ...prev, durationMetric: 'p95' }))
                      }
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        thresholds.durationMetric === 'p95'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      P95 延遲
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setThresholds((prev) => ({ ...prev, durationMetric: 'avg' }))
                      }
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        thresholds.durationMetric === 'avg'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      平均 Avg
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="flex items-center justify-between text-xs text-slate-600 mb-1">
                      <span>警告上限（ms）</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {Number(draft.durationWarningMs) > 0
                          ? `= ${(Number(draft.durationWarningMs) / 1000).toFixed(2)}s`
                          : ''}
                      </span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      step={50}
                      value={draft.durationWarningMs}
                      onChange={(e) => handleDraftChange('durationWarningMs', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </label>
                  <label className="block">
                    <span className="flex items-center justify-between text-xs text-slate-600 mb-1">
                      <span>嚴重上限（ms）</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {Number(draft.durationCriticalMs) > 0
                          ? `= ${(Number(draft.durationCriticalMs) / 1000).toFixed(2)}s`
                          : ''}
                      </span>
                    </span>
                    <input
                      type="number"
                      min={2}
                      step={50}
                      value={draft.durationCriticalMs}
                      onChange={(e) => handleDraftChange('durationCriticalMs', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    />
                  </label>
                </div>
              </div>
            </div>

            {draftError && (
              <p role="alert" className="text-xs text-red-700 font-medium">
                {draftError}
              </p>
            )}

            <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                {savedNotice ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>已套用並儲存閾值設定</span>
                  </span>
                ) : hasUnsavedDraft ? (
                  <span className="text-amber-700 font-medium">尚有未套用的變更</span>
                ) : (
                  <span>設定會自動保留於此瀏覽器，並即時套用於圖表參考線</span>
                )}
              </span>
              <button
                type="submit"
                disabled={!hasUnsavedDraft}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                套用設定
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Optional Raw Prometheus Exposition View */}
      {showRawPrometheus && (
        <section
          aria-label="原始 Prometheus 指標輸出"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden"
        >
          <div className="px-5 sm:px-6 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="text-xs sm:text-sm font-mono font-semibold text-slate-900">
              GET {snapshot?.scrapeEndpoint ?? '/metrics'}（Prometheus v0.0.4）
            </div>
            <button
              type="button"
              onClick={() => void handleCopyPrometheus()}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedRaw ? (
                <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              )}
              <span>{copiedRaw ? '已複製' : '複製'}</span>
            </button>
          </div>
          <pre className="p-5 text-xs font-mono leading-relaxed text-slate-100 bg-slate-900 overflow-x-auto max-h-80">
            {snapshot?.prometheusRaw || '# 等待首次 Prometheus 指標擷取...'}
          </pre>
        </section>
      )}

      {/* Loading Skeleton on initial fetch */}
      {loading && !snapshot ? (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[0, 1].map((idx) => (
            <div
              key={idx}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <div className="h-5 w-48 bg-slate-100 rounded animate-pulse" />
              <div className="h-60 bg-slate-50 rounded-lg animate-pulse" />
            </div>
          ))}
        </section>
      ) : (
        <>
          {/* Primary Real-Time Charts Row: Queue Depth & Request Duration */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Chart 1: Real-Time Queue Depth & ffmpeg Queue */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      佇列深度與 ffmpeg 排隊數
                    </h2>
                    <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                      即時追蹤{' '}
                      <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                        queue_depth
                      </code>{' '}
                      與{' '}
                      <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                        ffmpeg_queue_length
                      </code>
                      ，虛線標示安全告警上限。
                    </p>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                    視窗：{samples.length}/{MAX_SAMPLES}
                  </span>
                </div>

                <div className="mt-4 h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={samples} margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="queueFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2563EB" stopOpacity={0.22} />
                          <stop offset="95%" stopColor="#2563EB" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="ffmpegFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#D97706" stopOpacity={0.22} />
                          <stop offset="95%" stopColor="#D97706" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        minTickGap={24}
                      />
                      <YAxis
                        allowDecimals={false}
                        domain={[
                          0,
                          (dataMax: number) =>
                            Math.max(
                              4,
                              dataMax + 1,
                              thresholds.enabled ? thresholds.queueCritical + 2 : 4
                            ),
                        ]}
                        tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#CBD5E1',
                          borderRadius: '8px',
                          fontSize: '12px',
                          fontFamily: 'JetBrains Mono, monospace',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      {thresholds.enabled && (
                        <>
                          <ReferenceLine
                            y={thresholds.queueWarning}
                            stroke="#D97706"
                            strokeDasharray="4 4"
                            label={{
                              value: `警告 ${thresholds.queueWarning}`,
                              position: 'insideTopRight',
                              fill: '#B45309',
                              fontSize: 11,
                            }}
                          />
                          <ReferenceLine
                            y={thresholds.queueCritical}
                            stroke="#DC2626"
                            strokeDasharray="4 4"
                            label={{
                              value: `嚴重 ${thresholds.queueCritical}`,
                              position: 'insideTopRight',
                              fill: '#B91C1C',
                              fontSize: 11,
                            }}
                          />
                        </>
                      )}
                      <Area
                        type="stepAfter"
                        dataKey="queueDepthPeak"
                        name="佇列區間峰值 (2s Peak)"
                        stroke="#2563EB"
                        strokeWidth={2}
                        fill="url(#queueFill)"
                        isAnimationActive={false}
                      />
                      <Area
                        type="stepAfter"
                        dataKey="ffmpegQueuePeak"
                        name="ffmpeg 區間峰值"
                        stroke="#D97706"
                        strokeWidth={2}
                        fill="url(#ffmpegFill)"
                        isAnimationActive={false}
                      />
                      <Area
                        type="stepAfter"
                        dataKey="queueDepth"
                        name="佇列即時值 (queue_depth)"
                        stroke="#475569"
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                        fill="none"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>
                  目前 queue_depth：{snapshot?.metrics.queueDepth ?? 0}（近期峰值{' '}
                  {snapshot?.metrics.queueDepthPeak ?? 0}）
                </span>
                <span>
                  ffmpeg 排隊：{snapshot?.metrics.ffmpegQueueLength ?? 0}（累計{' '}
                  {snapshot?.metrics.ffmpegTasksTotal ?? 0} 次）
                </span>
              </div>
            </div>

            {/* Chart 2: Request Duration & TTS Wait (Time-Series / Histogram Toggle) */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      端到端請求延遲與 TTS 等待時間
                    </h2>
                    <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                      即時追蹤{' '}
                      <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                        request_duration_seconds
                      </code>{' '}
                      與{' '}
                      <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                        tts_wait_seconds
                      </code>
                      （單位 ms）。
                    </p>
                  </div>

                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setLatencyMode('timeseries')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        latencyMode === 'timeseries'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      即時趨勢
                    </button>
                    <button
                      type="button"
                      onClick={() => setLatencyMode('histogram')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        latencyMode === 'histogram'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      延遲分佈直方圖
                    </button>
                  </div>
                </div>

                <div className="mt-4 h-64 w-full">
                  {latencyMode === 'timeseries' ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={samples}
                        margin={{ top: 10, right: 16, left: -8, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                          minTickGap={24}
                        />
                        <YAxis
                          domain={[
                            0,
                            (dataMax: number) =>
                              Math.max(
                                100,
                                Math.ceil(dataMax * 1.15),
                                thresholds.enabled
                                  ? Math.ceil(thresholds.durationCriticalMs * 1.1)
                                  : 100
                              ),
                          ]}
                          tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                          unit="ms"
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#FFFFFF',
                            borderColor: '#CBD5E1',
                            borderRadius: '8px',
                            fontSize: '12px',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: '12px' }} />
                        {thresholds.enabled && (
                          <>
                            <ReferenceLine
                              y={thresholds.durationWarningMs}
                              stroke="#D97706"
                              strokeDasharray="4 4"
                              label={{
                                value: `警告 ${thresholds.durationWarningMs}ms`,
                                position: 'insideTopRight',
                                fill: '#B45309',
                                fontSize: 11,
                              }}
                            />
                            <ReferenceLine
                              y={thresholds.durationCriticalMs}
                              stroke="#DC2626"
                              strokeDasharray="4 4"
                              label={{
                                value: `嚴重 ${thresholds.durationCriticalMs}ms`,
                                position: 'insideTopRight',
                                fill: '#B91C1C',
                                fontSize: 11,
                              }}
                            />
                          </>
                        )}
                        <Line
                          type="monotone"
                          dataKey="reqP95Ms"
                          name="請求 P95 (ms)"
                          stroke="#DC2626"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="reqAvgMs"
                          name="請求平均 Avg (ms)"
                          stroke="#2563EB"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="ttsP95Ms"
                          name="TTS 等待 P95 (ms)"
                          stroke="#0F766E"
                          strokeWidth={1.75}
                          strokeDasharray="4 3"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={requestHistogramBars}
                        margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#FFFFFF',
                            borderColor: '#CBD5E1',
                            borderRadius: '8px',
                            fontSize: '12px',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: '12px' }} />
                        <Bar
                          dataKey="count"
                          name="區間請求次數"
                          fill="#2563EB"
                          radius={[4, 4, 0, 0]}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-mono tabular-nums">
                <span>
                  P50 {snapshot?.metrics.requestDuration.p50Ms.toFixed(1) ?? '0.0'} ms · P99{' '}
                  {snapshot?.metrics.requestDuration.p99Ms.toFixed(1) ?? '0.0'} ms
                </span>
                <span>累計觀測請求：{snapshot?.metrics.requestDuration.count ?? 0} 次</span>
              </div>
            </div>
          </section>

          {/* Secondary Row: Redis Health Status & Process Memory/CPU */}
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Redis Health Status Panel */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-slate-600 shrink-0" aria-hidden="true" />
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      Redis 健康狀態與降級保護
                    </h2>
                  </div>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      redisHealthy ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {redisHealthy ? '連線正常' : '降級放行中'}
                  </span>
                </div>

                <p className="mt-1.5 text-xs sm:text-sm text-slate-600">
                  當 Redis 無法連線時，每日額度檢查會自動啟用 Fail-Open 降級保護（30 秒 single-flight
                  冷卻機制，避免阻塞正常請求）。
                </p>

                <dl className="mt-4 divide-y divide-slate-100 text-xs sm:text-sm">
                  <div className="py-2.5 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">目標端點</dt>
                    <dd className="font-mono tabular-nums font-medium text-slate-900">
                      {snapshot?.redis.target ?? '127.0.0.1:6379'}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">TCP 探測結果</dt>
                    <dd
                      className={`font-mono font-semibold ${
                        redisHealthy ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {redisHealthy
                        ? `可連線（${snapshot?.redis.latencyMs} ms）`
                        : `無法連線（${snapshot?.redis.error || '離線'}）`}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">Redis 故障計數 (redis_failures_total)</dt>
                    <dd className="font-mono tabular-nums font-semibold text-slate-900">
                      {snapshot?.redis.failuresTotal ?? 0}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">Python 橋接 / ffmpeg</dt>
                    <dd className="font-mono text-slate-800">
                      {snapshot?.system.pythonBridgeReady ? '橋接正常' : '橋接異常'} ·{' '}
                      {snapshot?.system.ffmpegAvailable ? 'ffmpeg 就緒' : '無 ffmpeg'}
                    </dd>
                  </div>
                  <div className="py-2.5 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">/ready 快取存活時間</dt>
                    <dd className="font-mono tabular-nums text-slate-700">
                      {snapshot ? `${snapshot.system.readyCacheAgeMs} ms（10 秒 TTL）` : '--'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500 font-mono">
                  冷卻時間：{snapshot?.redis.failOpenCooldownSec ?? 30} 秒 single-flight
                </span>
                <button
                  type="button"
                  onClick={() => void handleManualProbe()}
                  disabled={probing}
                  className="px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {probing ? '探測中...' : '立即探測 Redis'}
                </button>
              </div>
            </div>

            {/* Process Memory & CPU Real-Time Chart */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      主機記憶體與 CPU 使用率
                    </h2>
                    <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                      即時觀測 Node.js 服務的常駐記憶體（RSS）、V8 Heap 使用量（MB）與處理程序 CPU
                      百分比。
                    </p>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-600">
                    RSS {snapshot?.system.rssMb ?? '--'} MB · Heap{' '}
                    {snapshot?.system.heapUsedMb ?? '--'} MB · CPU{' '}
                    {snapshot?.system.cpuPercent ?? '--'}%
                  </div>
                </div>

                <div className="mt-4 h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={samples} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="rssFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0F172A" stopOpacity={0.14} />
                          <stop offset="95%" stopColor="#0F172A" stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        minTickGap={24}
                      />
                      <YAxis
                        yAxisId="mem"
                        tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        unit="MB"
                      />
                      <YAxis
                        yAxisId="cpu"
                        orientation="right"
                        domain={[0, 100]}
                        tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }}
                        unit="%"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#CBD5E1',
                          borderRadius: '8px',
                          fontSize: '12px',
                          fontFamily: 'JetBrains Mono, monospace',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Area
                        yAxisId="mem"
                        type="monotone"
                        dataKey="rssMb"
                        name="常駐記憶體 RSS (MB)"
                        stroke="#0F172A"
                        strokeWidth={1.8}
                        fill="url(#rssFill)"
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="mem"
                        type="monotone"
                        dataKey="heapUsedMb"
                        name="Heap 已使用 (MB)"
                        stroke="#2563EB"
                        strokeWidth={1.8}
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="cpu"
                        type="monotone"
                        dataKey="cpuPercent"
                        name="CPU 使用率 (%)"
                        stroke="#16A34A"
                        strokeWidth={1.8}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-mono tabular-nums">
                <span>1 分鐘平均負載：{snapshot?.system.loadAvg1m ?? '--'}</span>
                <span>Gemini API 金鑰：{geminiKeyLabel(snapshot?.system.geminiKeyState)}</span>
              </div>
            </div>
          </section>

          {/* Recent Alerts Scrollable Log (Stored Below the Graphs) */}
          <section
            aria-label="近期告警紀錄"
            className="bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  近期告警紀錄
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  自動保存於瀏覽器（最多保留 {MAX_RECENT_ALERTS} 筆），逐筆列出觸發時間、指標類型、觀測值與超出門檻幅度。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <div
                  role="group"
                  aria-label="依指標類型篩選告警"
                  className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
                >
                  {(
                    [
                      { id: 'all', label: `全部 (${recentAlerts.length})` },
                      { id: 'queue_depth', label: '佇列深度' },
                      { id: 'request_duration_seconds', label: '請求延遲' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setAlertFilter(item.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        alertFilter === item.id
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {recentAlerts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRecentAlerts([])}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                    <span>清除紀錄</span>
                  </button>
                )}
              </div>
            </div>

            {filteredRecentAlerts.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <CheckCircle2
                  className="w-7 h-7 text-emerald-500 mx-auto mb-2.5"
                  aria-hidden="true"
                />
                <p className="text-sm font-semibold text-slate-900">
                  {recentAlerts.length === 0
                    ? '目前尚無觸發任何近期告警'
                    : '此指標篩選條件下尚無告警紀錄'}
                </p>
                <p className="mt-1 text-xs sm:text-sm text-slate-500 max-w-md mx-auto">
                  當即時的{' '}
                  <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-700">
                    queue_depth
                  </code>{' '}
                  或{' '}
                  <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-700">
                    request_duration_seconds
                  </code>{' '}
                  超過上方自訂門檻時，系統會自動新增一筆可捲動查閱的告警紀錄於此處。
                </p>
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                <div className="sticky top-0 z-10 hidden sm:grid sm:grid-cols-12 gap-3 px-6 py-2.5 bg-slate-50/95 border-b border-slate-200 text-xs font-medium text-slate-500">
                  <div className="sm:col-span-2">觸發時間</div>
                  <div className="sm:col-span-2">告警等級</div>
                  <div className="sm:col-span-3">指標類型</div>
                  <div className="sm:col-span-3">觀測值 / 設定上限</div>
                  <div className="sm:col-span-2 text-right">超出門檻值</div>
                </div>

                <ul className="divide-y divide-slate-100">
                  {filteredRecentAlerts.map((entry) => (
                    <li
                      key={entry.id}
                      className="px-5 sm:px-6 py-3 hover:bg-slate-50/70 transition-colors grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3 items-center text-xs sm:text-sm"
                    >
                      <div className="sm:col-span-2 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                        {entry.timestamp}
                      </div>

                      <div className="sm:col-span-2">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${
                            entry.severity === 'critical' ? 'text-red-700' : 'text-amber-700'
                          }`}
                        >
                          {entry.severity === 'critical' ? (
                            <AlertOctagon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          )}
                          <span>{entry.severity === 'critical' ? '嚴重告警' : '警告告警'}</span>
                        </span>
                      </div>

                      <div className="sm:col-span-3 min-w-0">
                        <div className="font-medium text-slate-900 truncate">
                          {entry.metricLabel}{' '}
                          <span className="font-mono text-xs text-slate-500">
                            ({entry.metricType})
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 truncate">{entry.note}</div>
                      </div>

                      <div className="sm:col-span-3 font-mono tabular-nums text-xs text-slate-700">
                        <span className="font-semibold text-slate-900">{entry.observedValue}</span>
                        <span className="text-slate-400 mx-1.5">/</span>
                        <span className="text-slate-500">上限 {entry.thresholdValue}</span>
                      </div>

                      <div
                        className={`sm:col-span-2 sm:text-right font-mono tabular-nums text-xs sm:text-sm font-semibold whitespace-nowrap ${
                          entry.severity === 'critical' ? 'text-red-700' : 'text-amber-700'
                        }`}
                      >
                        超出 {entry.exceededValue}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Recent OpenTelemetry / W3C Spans Table */}
          <section
            aria-label="最近追蹤區段紀錄"
            className="bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  最近追蹤區段（W3C TraceContext）
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  記錄 HTTP 請求、即時探測、LLM 生成、TTS 合成與 ffmpeg 轉檔的實際執行耗時與鏈路。
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenWebBot}
                className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto cursor-pointer"
              >
                前往 Web Bot 產生測試流量
              </button>
            </div>

            {!snapshot || snapshot.recentSpans.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Activity className="w-7 h-7 text-slate-300 mx-auto mb-2.5" aria-hidden="true" />
                <p className="text-sm font-semibold text-slate-900">目前尚無追蹤區段紀錄</p>
                <p className="mt-1 text-xs sm:text-sm text-slate-500 max-w-md mx-auto">
                  請點擊上方「執行即時探測」，或切換至 Web Bot 傳送文字／語音訊息，即可即時檢視鏈路耗時與直方圖變化。
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                      <th className="py-2.5 pl-6 pr-3">區段名稱 (Span)</th>
                      <th className="py-2.5 px-3">Trace ID</th>
                      <th className="py-2.5 px-3">Span ID</th>
                      <th className="py-2.5 px-3 text-right">耗時</th>
                      <th className="py-2.5 pl-3 pr-6 text-right">狀態</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {snapshot.recentSpans.map((span) => (
                      <tr key={`${span.traceId}-${span.spanId}`} className="hover:bg-slate-50/70">
                        <td className="py-2.5 pl-6 pr-3 font-mono font-medium text-slate-900 whitespace-nowrap">
                          {span.name}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs text-slate-600 whitespace-nowrap">
                          {span.traceId.slice(0, 16)}...
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs text-slate-600 whitespace-nowrap">
                          {span.spanId}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                          {span.durationMs.toFixed(1)} ms
                        </td>
                        <td
                          className={`py-2.5 pl-3 pr-6 text-right font-mono text-xs font-semibold whitespace-nowrap ${
                            span.status === 'OK' ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {span.status === 'OK' ? '成功' : '錯誤'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
