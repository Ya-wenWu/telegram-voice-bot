import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  VERDICT_LABELS_ZH,
  analyzeInterruptionRootCause,
  type VoiceDiagnosticSession,
} from '../services/voiceDiagnostics';
import { copyToClipboard } from '../utils/clipboard';

interface VoiceDiagnosticsModalProps {
  open: boolean;
  onClose: () => void;
  activeSession: VoiceDiagnosticSession | null;
  history: VoiceDiagnosticSession[];
  isRecording: boolean;
  syncing?: boolean;
  lastSyncedAt?: string | null;
  onSyncServerHistory?: () => Promise<void> | void;
  onClearHistory: () => void;
}

type SessionFilter = 'all' | 'over60s' | 'anomaly';
type EventFilter = 'all' | 'warn_error' | 'over60s';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return `${ms} ms`;
}

function formatTimeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function sourceLabel(source: VoiceDiagnosticSession['source']): string {
  if (source === 'synced') return '本機＋伺服器已同步';
  if (source === 'server') return '伺服器持久化紀錄';
  return '瀏覽器本機紀錄';
}

export function VoiceDiagnosticsModal({
  open,
  onClose,
  activeSession,
  history,
  isRecording,
  syncing = false,
  lastSyncedAt = null,
  onSyncServerHistory,
  onClearHistory,
}: VoiceDiagnosticsModalProps) {
  const allSessions = useMemo(() => {
    const list: VoiceDiagnosticSession[] = [];
    if (activeSession) {
      list.push(activeSession);
    }
    for (const item of history) {
      if (!activeSession || item.sessionId !== activeSession.sessionId) {
        list.push(item);
      }
    }
    return list;
  }, [activeSession, history]);

  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [copiedJson, setCopiedJson] = useState(false);

  const sessionCounts = useMemo(() => {
    let over60s = 0;
    let anomaly = 0;
    for (const s of allSessions) {
      if (
        s.snapshot.over60sTrackingActive ||
        s.snapshot.elapsedSec >= 60 ||
        s.over60sCheckpoints.length > 0
      ) {
        over60s += 1;
      }
      if (s.verdict !== 'HEALTHY' || s.status === 'error' || s.status === 'interrupted') {
        anomaly += 1;
      }
    }
    return { all: allSessions.length, over60s, anomaly };
  }, [allSessions]);

  const visibleSessions = useMemo(() => {
    if (sessionFilter === 'over60s') {
      return allSessions.filter(
        (s) =>
          s.snapshot.over60sTrackingActive ||
          s.snapshot.elapsedSec >= 60 ||
          s.over60sCheckpoints.length > 0
      );
    }
    if (sessionFilter === 'anomaly') {
      return allSessions.filter(
        (s) => s.verdict !== 'HEALTHY' || s.status === 'error' || s.status === 'interrupted'
      );
    }
    return allSessions;
  }, [allSessions, sessionFilter]);

  const selectedSession = useMemo(() => {
    if (visibleSessions.length === 0) return null;
    if (selectedSessionId) {
      const found = visibleSessions.find((s) => s.sessionId === selectedSessionId);
      if (found) return found;
    }
    return visibleSessions[0];
  }, [visibleSessions, selectedSessionId]);

  const rootCause = useMemo(
    () => (selectedSession ? analyzeInterruptionRootCause(selectedSession) : null),
    [selectedSession]
  );

  const over60sChartData = useMemo(() => {
    if (!selectedSession || selectedSession.over60sCheckpoints.length === 0) return [];
    return selectedSession.over60sCheckpoints.map((cp) => ({
      label: `+${cp.elapsedSec}s`,
      streamQueueKb: cp.streamQueueKb,
      wsBufferedKb: cp.wsBufferedKb,
      chunkGapMs: cp.chunkGapMs,
      bufferUtilizationPct: cp.bufferUtilizationPct,
    }));
  }, [selectedSession]);

  useEffect(() => {
    if (!open) return;
    if (onSyncServerHistory) {
      void onSyncServerHistory();
    }
  }, [open, onSyncServerHistory]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const verdictMeta = selectedSession ? VERDICT_LABELS_ZH[selectedSession.verdict] : null;
  const filteredEvents = selectedSession
    ? selectedSession.events
        .filter((ev) => {
          if (eventFilter === 'warn_error') return ev.level === 'warn' || ev.level === 'error';
          if (eventFilter === 'over60s') return ev.elapsedSec >= 60;
          return true;
        })
        .slice()
        .reverse()
    : [];

  const handleCopyJson = async () => {
    if (!selectedSession) return;
    const ok = await copyToClipboard(JSON.stringify(selectedSession, null, 2));
    if (ok) {
      setCopiedJson(true);
      window.setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  const handleDownloadJson = () => {
    if (!selectedSession) return;
    const blob = new Blob([JSON.stringify(selectedSession, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voice-diagnostics-${selectedSession.sessionId}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-diag-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-5xl max-h-[90vh] bg-white border border-slate-200 rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50/70">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2
                id="voice-diag-modal-title"
                className="font-display text-base font-semibold text-slate-900 truncate"
              >
                錄音診斷紀錄（&gt;60 秒串流追蹤 · WebSocket 緩衝區與延遲日誌）
              </h2>
              <p className="text-xs text-slate-500">
                自動合併本機檢查點與伺服器持久化日誌（<code className="font-mono">/api/observability/voice-diagnostics</code>），協助定位錄音中斷、緩衝區溢位或 API 超時根因。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onSyncServerHistory && (
              <button
                type="button"
                onClick={() => void onSyncServerHistory()}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors cursor-pointer disabled:opacity-60"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${syncing ? 'animate-spin text-blue-600' : 'text-slate-500'}`}
                  aria-hidden="true"
                />
                <span>{syncing ? '讀取中...' : '重新讀取紀錄'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="關閉錄音診斷紀錄視窗"
              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 rounded-lg transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {allSessions.length === 0 ? (
            <div className="py-14 text-center space-y-2.5">
              <div className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center mx-auto">
                <Activity className="w-5 h-5 text-slate-500" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-slate-900">尚無錄音診斷紀錄</p>
              <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                按下麥克風開始錄音後，診斷 Logger 會每秒記錄串流緩衝區、WebSocket 積壓量、Web Audio 時鐘與處理延遲，並自動同步至伺服器持久化儲存；超過 60 秒時將每 5 秒採樣一次高解析度快照。
              </p>
            </div>
          ) : (
            <>
              {/* Session Filter Tabs + Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 pb-3 border-b border-slate-100">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    role="group"
                    aria-label="篩選錄音場次"
                    className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md text-xs"
                  >
                    {(
                      [
                        { id: 'all', label: `全部錄音 (${sessionCounts.all})` },
                        { id: 'over60s', label: `>60 秒長錄音 (${sessionCounts.over60s})` },
                        { id: 'anomaly', label: `僅異常／中斷 (${sessionCounts.anomaly})` },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setSessionFilter(opt.id)}
                        className={`px-2.5 py-1 rounded font-medium transition-colors cursor-pointer ${
                          sessionFilter === opt.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {lastSyncedAt && (
                    <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                      已同步：{formatTimeShort(lastSyncedAt)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    disabled={!selectedSession}
                    onClick={() => void handleCopyJson()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors cursor-pointer"
                  >
                    {copiedJson ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{copiedJson ? '已複製 JSON' : '複製 JSON'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!selectedSession}
                    onClick={handleDownloadJson}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>下載日誌</span>
                  </button>
                  {!isRecording && (
                    <button
                      type="button"
                      onClick={() => {
                        onClearHistory();
                        setSelectedSessionId('');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>清除全部</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Session Selector Strip */}
              {visibleSessions.length === 0 || !selectedSession ? (
                <div className="py-10 text-center text-xs text-slate-500 border border-slate-200 rounded-lg bg-slate-50/50">
                  此篩選條件下尚無符合的錄音場次（可切換回「全部錄音」檢視所有紀錄）。
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleSessions.map((s) => {
                      const isSelected = s.sessionId === selectedSession.sessionId;
                      const isOver60 =
                        s.snapshot.over60sTrackingActive ||
                        s.snapshot.elapsedSec >= 60 ||
                        s.over60sCheckpoints.length > 0;
                      const isErr =
                        s.verdict !== 'HEALTHY' ||
                        s.status === 'error' ||
                        s.status === 'interrupted';
                      return (
                        <button
                          key={s.sessionId}
                          type="button"
                          onClick={() => setSelectedSessionId(s.sessionId)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono rounded-md border transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <span>{formatTimeShort(s.startedAt)}</span>
                          <span className="opacity-75">({Math.round(s.snapshot.elapsedSec)}s)</span>
                          {isOver60 && (
                            <span
                              className={`px-1 py-0.2 rounded text-[10px] font-sans font-semibold ${
                                isSelected
                                  ? 'bg-blue-500/30 text-blue-100'
                                  : 'bg-blue-50 text-blue-700'
                              }`}
                            >
                              &gt;60s
                            </span>
                          )}
                          {isErr && (
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isSelected ? 'bg-red-400' : 'bg-red-500'
                              }`}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Verdict Banner */}
                  {verdictMeta && (
                    <div
                      className={`px-4 py-3 rounded-lg border text-xs space-y-1 ${
                        verdictMeta.severity === 'error'
                          ? 'bg-red-50 border-red-200 text-red-900'
                          : verdictMeta.severity === 'warn'
                            ? 'bg-amber-50 border-amber-200 text-amber-950'
                            : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                        <div className="flex items-center gap-1.5">
                          {verdictMeta.severity === 'ok' ? (
                            <CheckCircle2
                              className="w-4 h-4 text-emerald-600 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                          )}
                          <span>診斷判定：{verdictMeta.label}</span>
                        </div>
                        <span className="font-mono text-[11px] opacity-80">
                          {selectedSession.sessionId} · {selectedSession.status} ·{' '}
                          {sourceLabel(selectedSession.source)} · {selectedSession.mimeType}
                        </span>
                      </div>
                      <p className="pl-5.5 opacity-90">{selectedSession.verdictReason}</p>
                    </div>
                  )}

                  {/* Root-Cause Interruption Analysis & Developer Recommendations */}
                  {rootCause && (
                    <section className="border border-slate-200 rounded-lg p-4 bg-white space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                          <span>錄音中斷根因分析與開發者排查建議</span>
                        </h3>
                        <span
                          className={`text-[11px] font-semibold ${
                            rootCause.severity === 'error'
                              ? 'text-red-700'
                              : rootCause.severity === 'warn'
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }`}
                        >
                          {rootCause.category}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-slate-800">{rootCause.headline}</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-xs">
                        <div className="space-y-1">
                          <p className="text-[11px] font-semibold text-slate-500">關鍵觀測證據</p>
                          <ul className="space-y-1 text-slate-700 list-disc pl-4 leading-relaxed">
                            {rootCause.signals.map((sig, i) => (
                              <li key={i}>{sig}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[11px] font-semibold text-slate-500">工程排查建議</p>
                          <ul className="space-y-1 text-slate-700 list-disc pl-4 leading-relaxed">
                            {rootCause.recommendations.map((rec, i) => (
                              <li key={i}>{rec}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </section>
                  )}

                  {/* Two Diagnostic Metric Cards: Buffer/WebSocket + Processing Latency */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Card 1: WebSocket & Stream Buffer State */}
                    <section className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50/40">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <HardDrive className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                          <span>WebSocket 與音訊緩衝區狀態</span>
                        </h3>
                        <span className="text-[11px] font-mono text-slate-500">
                          {selectedSession.snapshot.wsBuffer.transportMode}
                        </span>
                      </div>

                      {/* Utilization bar */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-600 font-mono tabular-nums">
                          <span>串流緩衝使用率（上限 12 MB）</span>
                          <span
                            className={
                              selectedSession.snapshot.wsBuffer.bufferUtilizationPct >= 75
                                ? 'text-red-700 font-semibold'
                                : 'text-slate-900 font-semibold'
                            }
                          >
                            {selectedSession.snapshot.wsBuffer.bufferUtilizationPct}%
                          </span>
                        </div>
                        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              selectedSession.snapshot.wsBuffer.bufferUtilizationPct >= 75
                                ? 'bg-red-500'
                                : selectedSession.snapshot.wsBuffer.bufferUtilizationPct >= 45
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            }`}
                            style={{
                              width: `${Math.min(
                                100,
                                Math.max(2, selectedSession.snapshot.wsBuffer.bufferUtilizationPct)
                              )}%`,
                            }}
                          />
                        </div>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs font-mono tabular-nums">
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">WebSocket 狀態</dt>
                          <dd
                            className="text-slate-900 font-medium truncate"
                            title={selectedSession.snapshot.wsBuffer.readyState}
                          >
                            {selectedSession.snapshot.wsBuffer.readyState}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">WS 積壓 / 峰值</dt>
                          <dd className="text-slate-900 font-medium">
                            {formatBytes(selectedSession.snapshot.wsBuffer.bufferedAmountBytes)} /{' '}
                            {formatBytes(selectedSession.snapshot.wsBuffer.peakBufferedAmountBytes)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">音訊佇列 / 高水位</dt>
                          <dd className="text-slate-900 font-medium">
                            {formatBytes(selectedSession.snapshot.wsBuffer.streamQueueBytes)} /{' '}
                            {formatBytes(selectedSession.snapshot.wsBuffer.streamHighWaterBytes)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">切片數 / 寫入速率</dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.chunkCount} 塊 ·{' '}
                            {(selectedSession.snapshot.bytesPerSec / 1024).toFixed(1)} KB/s
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">背壓告警次數</dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.wsBuffer.backpressureEvents} 次
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">JS Heap 記憶體</dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.jsHeapUsedMb !== null
                              ? `${selectedSession.snapshot.jsHeapUsedMb} MB (${selectedSession.snapshot.jsHeapPercent ?? 0}%)`
                              : '瀏覽器未提供'}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    {/* Card 2: Processing & API Latency Breakdown */}
                    <section className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50/40">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                          <span>處理延遲與後端 API 耗時拆解</span>
                        </h3>
                        <span className="text-[11px] font-mono text-slate-500">
                          總長 {selectedSession.snapshot.elapsedSec}s
                        </span>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs font-mono tabular-nums">
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">
                            AudioContext 狀態 / 時鐘
                          </dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.audioContextState}
                            {selectedSession.snapshot.audioContextTimeSec !== null
                              ? ` (${selectedSession.snapshot.audioContextTimeSec}s)`
                              : ''}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">時鐘停滯 / 音軌狀態</dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.audioClockStallSec}s ·{' '}
                            {selectedSession.snapshot.trackReadyState}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">
                            Web Audio 讀取延遲 (均/峰)
                          </dt>
                          <dd className="text-slate-900 font-medium">
                            {selectedSession.snapshot.latency.analyserReadAvgMs} /{' '}
                            {selectedSession.snapshot.latency.analyserReadMaxMs} ms
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">
                            切片間隔延遲 (均/峰)
                          </dt>
                          <dd
                            className={
                              selectedSession.snapshot.latency.chunkGapMaxMs >= 3500
                                ? 'text-red-700 font-semibold'
                                : 'text-slate-900 font-medium'
                            }
                          >
                            {selectedSession.snapshot.latency.chunkGapAvgMs} /{' '}
                            {selectedSession.snapshot.latency.chunkGapMaxMs} ms
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">上傳往返 RTT</dt>
                          <dd className="text-slate-900 font-medium">
                            {formatMs(selectedSession.snapshot.latency.uploadRttMs)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">ffmpeg 正規化耗時</dt>
                          <dd className="text-slate-900 font-medium">
                            {formatMs(selectedSession.snapshot.latency.ffmpegNormalizeMs)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">STT API / LLM API</dt>
                          <dd className="text-slate-900 font-medium">
                            {formatMs(selectedSession.snapshot.latency.sttApiMs)} /{' '}
                            {formatMs(selectedSession.snapshot.latency.llmApiMs)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-sans text-[11px] text-slate-500">
                            TTS API / 管線總耗時
                          </dt>
                          <dd className="text-slate-900 font-medium">
                            {formatMs(selectedSession.snapshot.latency.ttsApiMs)} /{' '}
                            {formatMs(selectedSession.snapshot.latency.totalPipelineMs)}
                          </dd>
                        </div>
                      </dl>
                    </section>
                  </div>

                  {/* >60s High-Resolution Buffer & Latency Trend Chart + Table */}
                  <section className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        超過 60 秒語音串流追蹤快照（WebSocket 緩衝趨勢與每 5 秒延遲採樣）
                      </h3>
                      <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                        {selectedSession.over60sCheckpoints.length} 筆快照
                      </span>
                    </div>
                    {selectedSession.over60sCheckpoints.length === 0 ? (
                      <div className="px-4 py-4 text-xs text-slate-500">
                        此錄音尚未達 60 秒門檻（目前 {selectedSession.snapshot.elapsedSec} 秒）。當錄音超過 60 秒時，系統會每 5 秒自動記錄一次緩衝區、WS 積壓與切片延遲快照，並繪製趨勢曲線。
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-200">
                        {/* Interactive Buffer & Latency Trend Chart */}
                        <div className="p-4 bg-white">
                          <div className="h-48 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart
                                data={over60sChartData}
                                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                              >
                                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                                <XAxis
                                  dataKey="label"
                                  tick={{
                                    fontSize: 11,
                                    fill: '#64748B',
                                    fontFamily: 'JetBrains Mono',
                                  }}
                                />
                                <YAxis
                                  yAxisId="kb"
                                  tick={{
                                    fontSize: 11,
                                    fill: '#64748B',
                                    fontFamily: 'JetBrains Mono',
                                  }}
                                  unit="KB"
                                />
                                <YAxis
                                  yAxisId="ms"
                                  orientation="right"
                                  tick={{
                                    fontSize: 11,
                                    fill: '#64748B',
                                    fontFamily: 'JetBrains Mono',
                                  }}
                                  unit="ms"
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: '#FFFFFF',
                                    borderColor: '#CBD5E1',
                                    borderRadius: '8px',
                                    fontSize: '11px',
                                    fontFamily: 'JetBrains Mono, monospace',
                                  }}
                                />
                                <Legend wrapperStyle={{ fontSize: '11px' }} />
                                <ReferenceLine
                                  yAxisId="ms"
                                  y={3500}
                                  stroke="#DC2626"
                                  strokeDasharray="4 4"
                                  label={{
                                    value: '切片逾時警告 3500ms',
                                    position: 'insideTopRight',
                                    fill: '#B91C1C',
                                    fontSize: 10,
                                  }}
                                />
                                <Area
                                  yAxisId="kb"
                                  type="monotone"
                                  dataKey="streamQueueKb"
                                  name="音訊串流緩衝 (KB)"
                                  stroke="#2563EB"
                                  fill="#DBEAFE"
                                  strokeWidth={2}
                                  isAnimationActive={false}
                                />
                                <Line
                                  yAxisId="kb"
                                  type="monotone"
                                  dataKey="wsBufferedKb"
                                  name="WebSocket 積壓 (KB)"
                                  stroke="#D97706"
                                  strokeWidth={2}
                                  dot={{ r: 2.5 }}
                                  isAnimationActive={false}
                                />
                                <Line
                                  yAxisId="ms"
                                  type="monotone"
                                  dataKey="chunkGapMs"
                                  name="切片處理延遲 (ms)"
                                  stroke="#DC2626"
                                  strokeWidth={2}
                                  dot={{ r: 2.5 }}
                                  isAnimationActive={false}
                                />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </div>
                        </div>

                        {/* Detailed 5s Checkpoint Table */}
                        <div className="overflow-x-auto max-h-44">
                          <table className="w-full text-left border-collapse text-[11px] font-mono tabular-nums">
                            <thead>
                              <tr className="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-sans">
                                <th className="py-2 px-3">時間點</th>
                                <th className="py-2 px-3">切片數</th>
                                <th className="py-2 px-3">串流緩衝</th>
                                <th className="py-2 px-3">WS 積壓</th>
                                <th className="py-2 px-3">使用率</th>
                                <th className="py-2 px-3">切片延遲</th>
                                <th className="py-2 px-3">AudioContext</th>
                                <th className="py-2 px-3">JS Heap</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {selectedSession.over60sCheckpoints.map((cp) => (
                                <tr key={`${cp.elapsedSec}-${cp.ts}`} className="hover:bg-slate-50">
                                  <td className="py-1.5 px-3 font-semibold text-slate-900">
                                    +{cp.elapsedSec}s
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">{cp.chunkCount}</td>
                                  <td className="py-1.5 px-3 text-slate-700">
                                    {cp.streamQueueKb} KB
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">
                                    {cp.wsBufferedKb} KB
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">
                                    {cp.bufferUtilizationPct}%
                                  </td>
                                  <td
                                    className={`py-1.5 px-3 ${
                                      cp.chunkGapMs >= 3500
                                        ? 'text-red-700 font-semibold'
                                        : 'text-slate-700'
                                    }`}
                                  >
                                    {cp.chunkGapMs} ms
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">
                                    {cp.audioContextState}
                                    {cp.audioContextTimeSec !== null
                                      ? ` (${cp.audioContextTimeSec}s)`
                                      : ''}
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">
                                    {cp.jsHeapUsedMb !== null ? `${cp.jsHeapUsedMb} MB` : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </section>

                  {/* Event Log Timeline */}
                  <section className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        結構化診斷事件日誌（{filteredEvents.length} 筆）
                      </h3>
                      <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md text-[11px]">
                        {(
                          [
                            { id: 'all', label: '全部事件' },
                            { id: 'warn_error', label: '僅警告／異常' },
                            { id: 'over60s', label: '>60s 事件' },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setEventFilter(opt.id)}
                            className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
                              eventFilter === opt.id
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {filteredEvents.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-500 border border-slate-200 rounded-lg bg-slate-50/50">
                        目前篩選條件下無符合的診斷事件。
                      </div>
                    ) : (
                      <pre className="p-3 bg-slate-950 text-slate-100 rounded-lg text-[11px] font-mono leading-relaxed overflow-x-auto max-h-60 whitespace-pre-wrap break-all">
                        {filteredEvents
                          .map((ev) => {
                            const metaStr =
                              ev.metrics && Object.keys(ev.metrics).length > 0
                                ? ` ${JSON.stringify(ev.metrics)}`
                                : '';
                            return `[+${ev.elapsedSec.toFixed(1)}s][${ev.level.toUpperCase()}][${ev.category}:${ev.code}] ${ev.message}${metaStr}`;
                          })
                          .join('\n')}
                      </pre>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
