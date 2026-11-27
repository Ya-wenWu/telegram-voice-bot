/**
 * Web Audio API, WebSocket/Stream Buffer & API Latency Diagnostic Logger
 *
 * Designed to trace >60s voice streams in BotLiveConsole and pinpoint root causes:
 * - BUFFER_OVERFLOW: Audio chunk buffer growth, WebSocket bufferedAmount backpressure,
 *   abnormal bitrate spikes, or Chrome JS Heap exhaustion.
 * - WEB_AUDIO_TIMEOUT: AudioContext.currentTime stall or unexpected suspend/interrupt.
 * - RECORDER_STALL_TIMEOUT: MediaRecorder ondataavailable starvation (>5s gap).
 * - TRACK_TERMINATED: OS/Bluetooth/browser MediaStreamTrack ended/muted cutoff.
 * - UPLOAD_TIMEOUT / API_TIMEOUT: Upload RTT, ffmpeg normalization, or STT/LLM/TTS API timeout.
 *
 * Crash-resilient: writes rolling checkpoints to localStorage every 2s and uses
 * navigator.sendBeacon on pagehide so abrupt tab terminations remain inspectable.
 * Zero PII: never persists raw audio bytes or spoken transcripts.
 */

export type VoiceDiagLevel = 'debug' | 'info' | 'warn' | 'error';

export type VoiceDiagCategory =
  | 'lifecycle'
  | 'webaudio'
  | 'websocket'
  | 'mediarecorder'
  | 'track'
  | 'speech_api'
  | 'memory'
  | 'upload'
  | 'anomaly';

export type VoiceAnomalyVerdict =
  | 'HEALTHY'
  | 'BUFFER_OVERFLOW'
  | 'WEB_AUDIO_TIMEOUT'
  | 'RECORDER_STALL_TIMEOUT'
  | 'TRACK_TERMINATED'
  | 'UPLOAD_TIMEOUT'
  | 'API_TIMEOUT'
  | 'UNKNOWN_TAB_TERMINATION';

export interface VoiceDiagEvent {
  ts: string;
  elapsedSec: number;
  level: VoiceDiagLevel;
  category: VoiceDiagCategory;
  code: string;
  message: string;
  metrics?: Record<string, string | number | boolean | null>;
}

export interface WebSocketBufferSnapshot {
  transportMode: 'websocket' | 'http-binary-stream';
  readyState: string;
  bufferedAmountBytes: number;
  peakBufferedAmountBytes: number;
  streamQueueBytes: number;
  streamHighWaterBytes: number;
  bufferCapBytes: number;
  bufferUtilizationPct: number;
  backpressureEvents: number;
}

export interface ProcessingLatencySnapshot {
  analyserReadAvgMs: number;
  analyserReadMaxMs: number;
  chunkGapAvgMs: number;
  chunkGapMaxMs: number;
  uploadRttMs: number | null;
  ffmpegNormalizeMs: number | null;
  sttApiMs: number | null;
  llmApiMs: number | null;
  ttsApiMs: number | null;
  totalPipelineMs: number | null;
}

export interface Over60sCheckpoint {
  ts: string;
  elapsedSec: number;
  chunkCount: number;
  streamQueueKb: number;
  wsBufferedKb: number;
  bufferUtilizationPct: number;
  chunkGapMs: number;
  analyserReadMs: number;
  audioContextState: string;
  audioContextTimeSec: number | null;
  jsHeapUsedMb: number | null;
}

export interface VoiceDiagMetricsSnapshot {
  elapsedSec: number;
  over60sTrackingActive: boolean;
  chunkCount: number;
  bufferedBytes: number;
  bytesPerSec: number;
  maxChunkGapMs: number;
  lastChunkGapMs: number;
  audioContextState: string;
  audioContextTimeSec: number | null;
  audioClockStallSec: number;
  analyserReadMsMax: number;
  trackReadyState: string;
  trackMuted: boolean;
  jsHeapUsedMb: number | null;
  jsHeapLimitMb: number | null;
  jsHeapPercent: number | null;
  jsHeapDeltaMb: number | null;
  wsBuffer: WebSocketBufferSnapshot;
  latency: ProcessingLatencySnapshot;
}

export interface VoiceDiagnosticSession {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  status: 'recording' | 'uploading' | 'completed' | 'cancelled' | 'error' | 'interrupted';
  verdict: VoiceAnomalyVerdict;
  verdictReason: string;
  mimeType: string;
  targetBitrateBps: number;
  userAgentShort: string;
  source?: 'local' | 'server' | 'synced';
  snapshot: VoiceDiagMetricsSnapshot;
  over60sCheckpoints: Over60sCheckpoint[];
  events: VoiceDiagEvent[];
}

export interface InterruptionRootCauseAnalysis {
  category: string;
  severity: 'ok' | 'warn' | 'error';
  headline: string;
  signals: string[];
  recommendations: string[];
}

interface ChromePerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const STORAGE_KEY_ACTIVE = 'web_voice_bot_audio_diag_active_v1';
const STORAGE_KEY_HISTORY = 'web_voice_bot_audio_diag_history_v1';
const MAX_EVENTS_PER_SESSION = 180;
const MAX_OVER_60S_CHECKPOINTS = 60;
const MAX_STORED_SESSIONS = 8;
const STREAM_BUFFER_CAP_BYTES = 12 * 1024 * 1024;

// Diagnostic classification thresholds
export const DIAG_THRESHOLDS = {
  OVER_60S_THRESHOLD_SEC: 60,
  OVER_60S_CHECKPOINT_STEP_SEC: 5,
  BUFFER_WARN_BYTES: 9 * 1024 * 1024, // 9 MB (~75% of 12 MB cap)
  BUFFER_OVERFLOW_BYTES: 11.5 * 1024 * 1024, // Near/at 12 MB cap
  WS_BACKPRESSURE_WARN_BYTES: 1 * 1024 * 1024, // 1 MB WebSocket send queue warning
  WS_BUFFER_OVERFLOW_BYTES: 4 * 1024 * 1024, // 4 MB WebSocket send buffer overflow
  ABNORMAL_BYTES_PER_SEC: 48 * 1024, // 48 KB/s (~12x expected 32kbps = 4 KB/s)
  JS_HEAP_PRESSURE_PCT: 82, // >= 82% of V8 heap limit
  JS_HEAP_DELTA_MB: 150, // >= 150 MB heap growth during a single recording
  AUDIO_CLOCK_STALL_SEC: 3, // AudioContext.currentTime frozen >= 3s while recording
  RECORDER_CHUNK_GAP_WARN_MS: 3500, // No ondataavailable for >= 3.5s (timeslice=1000ms)
  RECORDER_CHUNK_GAP_TIMEOUT_MS: 5000, // Confirmed MediaRecorder stall
  ANALYSER_READ_SLOW_MS: 45, // Main-thread audio buffer read lag
  TRACK_MUTE_TIMEOUT_SEC: 6, // Sustained OS/hardware track mute
  SLOW_API_STAGE_WARN_MS: 12_000, // Single backend API stage taking >12s
} as const;

export const VERDICT_LABELS_ZH: Record<
  VoiceAnomalyVerdict,
  { label: string; summary: string; severity: 'ok' | 'warn' | 'error' }
> = {
  HEALTHY: {
    label: '串流正常',
    summary: 'Web Audio API、緩衝區與後端 API 處理延遲皆在安全範圍，無溢位或超時。',
    severity: 'ok',
  },
  BUFFER_OVERFLOW: {
    label: '緩衝區溢位 (Buffer Overflow)',
    summary: '偵測到音訊切片緩衝、WebSocket 發送緩衝或 JS Heap 快速膨脹，已觸發保護機制避免崩潰。',
    severity: 'error',
  },
  WEB_AUDIO_TIMEOUT: {
    label: 'Web Audio 逾時／時鐘停滯',
    summary: 'AudioContext 音訊時鐘停止推進或意外進入 suspended/interrupted 狀態。',
    severity: 'error',
  },
  RECORDER_STALL_TIMEOUT: {
    label: 'MediaRecorder 串流逾時',
    summary: 'MediaRecorder 超過 5 秒未輸出任何音訊切片（ondataavailable 停滯）。',
    severity: 'error',
  },
  TRACK_TERMINATED: {
    label: '麥克風音軌中斷',
    summary: '作業系統、藍牙裝置或瀏覽器提前終止／靜音了麥克風 MediaStreamTrack。',
    severity: 'warn',
  },
  UPLOAD_TIMEOUT: {
    label: '上傳／網路傳輸超時',
    summary: '音訊串流上傳階段發生網路中斷或請求逾時（AbortError / 408 / 504）。',
    severity: 'error',
  },
  API_TIMEOUT: {
    label: '後端 API 處理超時 (API Timeout)',
    summary: '後端 ffmpeg 轉檔、STT 語音辨識或 LLM API 回應超時。',
    severity: 'error',
  },
  UNKNOWN_TAB_TERMINATION: {
    label: '分頁異常終止（重載後還原）',
    summary: '上一次錄音在未正常結束前分頁即被終止，請檢視下方最後一筆緩衝區與延遲快照。',
    severity: 'error',
  },
};

const WS_READY_STATE_LABELS: Record<number, string> = {
  0: 'CONNECTING (0)',
  1: 'OPEN (1)',
  2: 'CLOSING (2)',
  3: 'CLOSED (3)',
};

function readJsHeapStats(): { usedMb: number | null; limitMb: number | null; pct: number | null } {
  try {
    const perf = performance as Performance & { memory?: ChromePerformanceMemory };
    if (!perf.memory || !perf.memory.jsHeapSizeLimit) {
      return { usedMb: null, limitMb: null, pct: null };
    }
    const usedMb = Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
    const limitMb = Math.round((perf.memory.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10;
    const pct = Math.round((perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit) * 1000) / 10;
    return { usedMb, limitMb, pct };
  } catch {
    return { usedMb: null, limitMb: null, pct: null };
  }
}

function getShortUserAgent(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  const safari = !chrome ? ua.match(/Version\/([\d.]+).*Safari/) : null;
  const firefox = ua.match(/Firefox\/([\d.]+)/);
  if (chrome) return `Chrome/${chrome[1]}`;
  if (firefox) return `Firefox/${firefox[1]}`;
  if (safari) return `Safari/${safari[1]}`;
  return ua.slice(0, 48);
}

function createEmptyWsBuffer(): WebSocketBufferSnapshot {
  return {
    transportMode: 'http-binary-stream',
    readyState: 'HTTP Binary Stream (無長駐 WS 連線)',
    bufferedAmountBytes: 0,
    peakBufferedAmountBytes: 0,
    streamQueueBytes: 0,
    streamHighWaterBytes: 0,
    bufferCapBytes: STREAM_BUFFER_CAP_BYTES,
    bufferUtilizationPct: 0,
    backpressureEvents: 0,
  };
}

function createEmptyLatency(): ProcessingLatencySnapshot {
  return {
    analyserReadAvgMs: 0,
    analyserReadMaxMs: 0,
    chunkGapAvgMs: 0,
    chunkGapMaxMs: 0,
    uploadRttMs: null,
    ffmpegNormalizeMs: null,
    sttApiMs: null,
    llmApiMs: null,
    ttsApiMs: null,
    totalPipelineMs: null,
  };
}

function createEmptySnapshot(): VoiceDiagMetricsSnapshot {
  const heap = readJsHeapStats();
  return {
    elapsedSec: 0,
    over60sTrackingActive: false,
    chunkCount: 0,
    bufferedBytes: 0,
    bytesPerSec: 0,
    maxChunkGapMs: 0,
    lastChunkGapMs: 0,
    audioContextState: 'uninitialized',
    audioContextTimeSec: null,
    audioClockStallSec: 0,
    analyserReadMsMax: 0,
    trackReadyState: 'unknown',
    trackMuted: false,
    jsHeapUsedMb: heap.usedMb,
    jsHeapLimitMb: heap.limitMb,
    jsHeapPercent: heap.pct,
    jsHeapDeltaMb: 0,
    wsBuffer: createEmptyWsBuffer(),
    latency: createEmptyLatency(),
  };
}

function normalizeLegacySession(raw: Partial<VoiceDiagnosticSession>): VoiceDiagnosticSession {
  const emptySnap = createEmptySnapshot();
  const snap = raw.snapshot
    ? {
        ...emptySnap,
        ...raw.snapshot,
        wsBuffer: {
          ...createEmptyWsBuffer(),
          ...(raw.snapshot.wsBuffer ?? {}),
          streamQueueBytes: raw.snapshot.wsBuffer?.streamQueueBytes ?? raw.snapshot.bufferedBytes ?? 0,
          streamHighWaterBytes:
            raw.snapshot.wsBuffer?.streamHighWaterBytes ?? raw.snapshot.bufferedBytes ?? 0,
        },
        latency: {
          ...createEmptyLatency(),
          ...(raw.snapshot.latency ?? {}),
          analyserReadMaxMs:
            raw.snapshot.latency?.analyserReadMaxMs ?? raw.snapshot.analyserReadMsMax ?? 0,
          chunkGapMaxMs: raw.snapshot.latency?.chunkGapMaxMs ?? raw.snapshot.maxChunkGapMs ?? 0,
        },
      }
    : emptySnap;

  return {
    sessionId: raw.sessionId || `vdiag-legacy-${Date.now()}`,
    startedAt: raw.startedAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    endedAt: raw.endedAt ?? null,
    status: raw.status || 'completed',
    verdict: raw.verdict || 'HEALTHY',
    verdictReason: raw.verdictReason || VERDICT_LABELS_ZH.HEALTHY.summary,
    mimeType: raw.mimeType || 'audio/webm',
    targetBitrateBps: raw.targetBitrateBps ?? 32_000,
    userAgentShort: raw.userAgentShort || 'unknown',
    snapshot: snap,
    over60sCheckpoints: Array.isArray(raw.over60sCheckpoints) ? raw.over60sCheckpoints : [],
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

function safeWriteJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota or storage restrictions
  }
}

function safeReadJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class VoiceAudioDiagnosticLogger {
  private session: VoiceDiagnosticSession;
  private startedMs: number;
  private baselineHeapMb: number | null;
  private lastChunkAtMs: number;
  private lastAudioCtxTimeSec: number | null = null;
  private consecutiveClockStallSec = 0;
  private consecutiveTrackMuteSec = 0;
  private lastCheckpointSec = -1;
  private lastOver60sCheckpointSec = -1;
  private analyserReadCount = 0;
  private analyserReadTotalMs = 0;
  private lastAnalyserReadMs = 0;
  private chunkGapCount = 0;
  private chunkGapTotalMs = 0;
  private attachedWebSocket: WebSocket | null = null;
  private onUpdate?: (session: VoiceDiagnosticSession) => void;

  constructor(
    mimeType: string,
    targetBitrateBps: number,
    onUpdate?: (session: VoiceDiagnosticSession) => void
  ) {
    const nowIso = new Date().toISOString();
    this.startedMs = performance.now();
    this.lastChunkAtMs = this.startedMs;
    this.onUpdate = onUpdate;

    const initialHeap = readJsHeapStats();
    this.baselineHeapMb = initialHeap.usedMb;

    this.session = {
      sessionId: `vdiag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      startedAt: nowIso,
      updatedAt: nowIso,
      endedAt: null,
      status: 'recording',
      verdict: 'HEALTHY',
      verdictReason: VERDICT_LABELS_ZH.HEALTHY.summary,
      mimeType,
      targetBitrateBps,
      userAgentShort: getShortUserAgent(),
      snapshot: createEmptySnapshot(),
      over60sCheckpoints: [],
      events: [],
    };

    this.log('info', 'lifecycle', 'SESSION_START', '開始語音串流錄製診斷監控（支援 >60 秒深度追蹤）', {
      mimeType,
      targetBitrateBps,
      transportMode: this.session.snapshot.wsBuffer.transportMode,
      jsHeapUsedMb: initialHeap.usedMb,
      jsHeapLimitMb: initialHeap.limitMb,
    });
    this.persistActiveCheckpoint();
  }

  getSessionId(): string {
    return this.session.sessionId;
  }

  getSession(): VoiceDiagnosticSession {
    return {
      ...this.session,
      snapshot: {
        ...this.session.snapshot,
        wsBuffer: { ...this.session.snapshot.wsBuffer },
        latency: { ...this.session.snapshot.latency },
      },
      over60sCheckpoints: [...this.session.over60sCheckpoints],
      events: [...this.session.events],
    };
  }

  /**
   * Optional hook for live WebSocket audio streaming transports.
   * Samples ws.readyState and ws.bufferedAmount on every tick to detect send-buffer overflow.
   */
  attachWebSocket(ws: WebSocket | null): void {
    this.attachedWebSocket = ws;
    if (!ws) {
      this.session.snapshot.wsBuffer.transportMode = 'http-binary-stream';
      this.session.snapshot.wsBuffer.readyState = 'HTTP Binary Stream (無長駐 WS 連線)';
      this.session.snapshot.wsBuffer.bufferedAmountBytes = 0;
      return;
    }
    this.session.snapshot.wsBuffer.transportMode = 'websocket';
    this.sampleWebSocketBuffer();
    this.log('info', 'websocket', 'WS_ATTACHED', '已掛載 WebSocket 緩衝區監測', {
      readyState: this.session.snapshot.wsBuffer.readyState,
      bufferedAmountBytes: ws.bufferedAmount,
    });
  }

  private sampleWebSocketBuffer(): boolean {
    const ws = this.attachedWebSocket;
    if (!ws) return false;
    const wsBuf = this.session.snapshot.wsBuffer;
    wsBuf.transportMode = 'websocket';
    wsBuf.readyState = WS_READY_STATE_LABELS[ws.readyState] ?? `UNKNOWN (${ws.readyState})`;
    wsBuf.bufferedAmountBytes = ws.bufferedAmount;
    if (ws.bufferedAmount > wsBuf.peakBufferedAmountBytes) {
      wsBuf.peakBufferedAmountBytes = ws.bufferedAmount;
    }
    if (ws.bufferedAmount >= DIAG_THRESHOLDS.WS_BUFFER_OVERFLOW_BYTES) {
      wsBuf.backpressureEvents += 1;
      this.setVerdictIfMoreSevere(
        'BUFFER_OVERFLOW',
        `WebSocket 發送緩衝區（bufferedAmount）達 ${(ws.bufferedAmount / (1024 * 1024)).toFixed(2)} MB，發生嚴重背壓溢位。`
      );
      this.log('error', 'websocket', 'WS_BUFFER_OVERFLOW', 'WebSocket 發送緩衝區溢位', {
        readyState: wsBuf.readyState,
        bufferedAmountBytes: ws.bufferedAmount,
      });
      return true;
    }
    if (ws.bufferedAmount >= DIAG_THRESHOLDS.WS_BACKPRESSURE_WARN_BYTES) {
      wsBuf.backpressureEvents += 1;
      this.log(
        'warn',
        'websocket',
        'WS_BUFFER_BACKPRESSURE',
        `WebSocket 緩衝區累積 ${(ws.bufferedAmount / 1024).toFixed(0)} KB，網路吞吐受阻`,
        { readyState: wsBuf.readyState, bufferedAmountBytes: ws.bufferedAmount }
      );
    }
    return false;
  }

  log(
    level: VoiceDiagLevel,
    category: VoiceDiagCategory,
    code: string,
    message: string,
    metrics?: Record<string, string | number | boolean | null>
  ): void {
    const elapsedSec = Math.max(0, Math.round(((performance.now() - this.startedMs) / 1000) * 10) / 10);
    const entry: VoiceDiagEvent = {
      ts: new Date().toISOString(),
      elapsedSec,
      level,
      category,
      code,
      message,
      metrics,
    };

    this.session.events.push(entry);
    if (this.session.events.length > MAX_EVENTS_PER_SESSION) {
      this.session.events.shift();
    }
    this.session.updatedAt = entry.ts;

    const consoleLine = `[VoiceDiag][${this.session.sessionId}][+${elapsedSec.toFixed(1)}s][${category}:${code}] ${message}`;
    if (level === 'error') {
      console.error(consoleLine, metrics ?? '');
    } else if (level === 'warn') {
      console.warn(consoleLine, metrics ?? '');
    } else if (level === 'info') {
      console.info(consoleLine, metrics ?? '');
    } else {
      console.debug(consoleLine, metrics ?? '');
    }

    this.emitUpdate();
  }

  recordAudioContextInit(ctx: AudioContext): void {
    this.session.snapshot.audioContextState = ctx.state;
    this.session.snapshot.audioContextTimeSec = Math.round(ctx.currentTime * 100) / 100;
    this.lastAudioCtxTimeSec = ctx.currentTime;
    this.log('info', 'webaudio', 'AUDIOCONTEXT_INIT', `Web Audio API 初始化完成（state=${ctx.state}）`, {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatencyMs:
        typeof ctx.baseLatency === 'number' ? Math.round(ctx.baseLatency * 10000) / 10 : null,
    });
  }

  recordAudioContextStateChange(state: string, currentTime: number): void {
    this.session.snapshot.audioContextState = state;
    this.session.snapshot.audioContextTimeSec = Math.round(currentTime * 100) / 100;
    const isAbnormal = state === 'suspended' || state === 'interrupted';
    this.log(
      isAbnormal ? 'warn' : 'info',
      'webaudio',
      `AUDIOCONTEXT_${state.toUpperCase()}`,
      `AudioContext 狀態變更為 ${state}`,
      { state, currentTimeSec: Math.round(currentTime * 100) / 100 }
    );
    if (isAbnormal) {
      this.setVerdictIfMoreSevere(
        'WEB_AUDIO_TIMEOUT',
        `AudioContext 在錄音第 ${Math.round(this.session.snapshot.elapsedSec)} 秒意外進入 ${state} 狀態（已自動嘗試恢復）。`
      );
      this.persistActiveCheckpoint();
    }
  }

  recordAnalyserRead(readDurationMs: number): void {
    const rounded = Math.round(readDurationMs * 100) / 100;
    this.lastAnalyserReadMs = rounded;
    this.analyserReadCount += 1;
    this.analyserReadTotalMs += readDurationMs;
    this.session.snapshot.latency.analyserReadAvgMs =
      Math.round((this.analyserReadTotalMs / this.analyserReadCount) * 100) / 100;

    if (rounded > this.session.snapshot.analyserReadMsMax) {
      this.session.snapshot.analyserReadMsMax = rounded;
      this.session.snapshot.latency.analyserReadMaxMs = rounded;
    }
    if (readDurationMs >= DIAG_THRESHOLDS.ANALYSER_READ_SLOW_MS) {
      this.log(
        'warn',
        'webaudio',
        'ANALYSER_SLOW_READ',
        `AnalyserNode 讀取延遲偏高（${rounded}ms），主執行緒可能受阻`,
        { readDurationMs: rounded }
      );
    }
  }

  recordTrackEvent(
    eventType: 'attached' | 'muted' | 'unmuted' | 'ended',
    track: MediaStreamTrack
  ): void {
    this.session.snapshot.trackReadyState = track.readyState;
    this.session.snapshot.trackMuted = track.muted;
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};

    if (eventType === 'attached') {
      this.log('info', 'track', 'TRACK_ATTACHED', '麥克風音軌已連接', {
        readyState: track.readyState,
        muted: track.muted,
        sampleRate: settings.sampleRate ?? null,
        channelCount: settings.channelCount ?? null,
      });
    } else if (eventType === 'ended') {
      this.setVerdictIfMoreSevere(
        'TRACK_TERMINATED',
        `麥克風 MediaStreamTrack 在第 ${Math.round(this.session.snapshot.elapsedSec)} 秒意外觸發 ended 事件（OS/裝置/瀏覽器中止音訊輸入）。`
      );
      this.log('error', 'track', 'TRACK_ENDED', '麥克風音軌意外終止（onended）', {
        readyState: track.readyState,
      });
      this.persistActiveCheckpoint();
    } else if (eventType === 'muted') {
      this.log('warn', 'track', 'TRACK_MUTED', '麥克風音軌進入靜音狀態（onmute）', {
        readyState: track.readyState,
      });
      this.persistActiveCheckpoint();
    } else {
      this.consecutiveTrackMuteSec = 0;
      this.log('info', 'track', 'TRACK_UNMUTED', '麥克風音軌恢復收音（onunmute）', {
        readyState: track.readyState,
      });
    }
  }

  recordChunk(chunkBytes: number, totalChunks: number, totalBytes: number): {
    bufferOverflowDetected: boolean;
  } {
    const now = performance.now();
    const gapMs = Math.round(now - this.lastChunkAtMs);
    this.lastChunkAtMs = now;

    if (totalChunks > 1) {
      this.chunkGapCount += 1;
      this.chunkGapTotalMs += gapMs;
      this.session.snapshot.latency.chunkGapAvgMs = Math.round(
        this.chunkGapTotalMs / this.chunkGapCount
      );
    }

    const elapsedSec = Math.max(0.5, (now - this.startedMs) / 1000);
    const bytesPerSec = Math.round(totalBytes / elapsedSec);

    this.session.snapshot.chunkCount = totalChunks;
    this.session.snapshot.bufferedBytes = totalBytes;
    this.session.snapshot.bytesPerSec = bytesPerSec;
    this.session.snapshot.lastChunkGapMs = gapMs;
    if (gapMs > this.session.snapshot.maxChunkGapMs) {
      this.session.snapshot.maxChunkGapMs = gapMs;
      this.session.snapshot.latency.chunkGapMaxMs = gapMs;
    }

    const wsBuf = this.session.snapshot.wsBuffer;
    wsBuf.streamQueueBytes = totalBytes;
    if (totalBytes > wsBuf.streamHighWaterBytes) {
      wsBuf.streamHighWaterBytes = totalBytes;
    }
    wsBuf.bufferUtilizationPct =
      Math.round((totalBytes / wsBuf.bufferCapBytes) * 1000) / 10;

    if (gapMs >= DIAG_THRESHOLDS.RECORDER_CHUNK_GAP_WARN_MS && totalChunks > 1) {
      this.log(
        'warn',
        'mediarecorder',
        'CHUNK_GAP_SPIKE',
        `MediaRecorder 切片輸出延遲達 ${gapMs}ms（預期 1000ms）`,
        { gapMs, chunkBytes, totalChunks, totalKb: Math.round(totalBytes / 1024) }
      );
    }

    let bufferOverflowDetected = this.sampleWebSocketBuffer();
    if (totalBytes >= DIAG_THRESHOLDS.BUFFER_OVERFLOW_BYTES) {
      bufferOverflowDetected = true;
      wsBuf.backpressureEvents += 1;
      this.setVerdictIfMoreSevere(
        'BUFFER_OVERFLOW',
        `錄音緩衝區達到 ${(totalBytes / (1024 * 1024)).toFixed(2)} MB（${totalChunks} 個切片，使用率 ${wsBuf.bufferUtilizationPct}%），觸發緩衝區溢位保護。`
      );
      this.log('error', 'anomaly', 'BUFFER_OVERFLOW_CAP', '音訊緩衝區觸及上限，準備安全停止送出', {
        totalBytes,
        totalChunks,
        bytesPerSec,
        utilizationPct: wsBuf.bufferUtilizationPct,
      });
    } else if (elapsedSec >= 10 && bytesPerSec > DIAG_THRESHOLDS.ABNORMAL_BYTES_PER_SEC) {
      wsBuf.backpressureEvents += 1;
      this.setVerdictIfMoreSevere(
        'BUFFER_OVERFLOW',
        `音訊位元率異常飆高（${(bytesPerSec / 1024).toFixed(1)} KB/s），疑似編碼器未遵守 32kbps 限制導致緩衝膨脹。`
      );
      this.log(
        'warn',
        'memory',
        'ABNORMAL_BITRATE_GROWTH',
        `音訊緩衝增速異常（${(bytesPerSec / 1024).toFixed(1)} KB/s）`,
        { bytesPerSec, totalKb: Math.round(totalBytes / 1024), totalChunks }
      );
    }

    return { bufferOverflowDetected };
  }

  /**
   * Called every 1 second during recording.
   * Performs Buffer Overflow, WebSocket Backpressure, Web Audio & MediaRecorder Timeout diagnostics,
   * and activates dedicated >60s high-resolution checkpoint tracking once elapsedSec >= 60.
   */
  sampleWatchdogTick(params: {
    elapsedSec: number;
    audioContext: AudioContext | null;
    recorderState: string;
    track: MediaStreamTrack | null;
    totalChunks: number;
    totalBytes: number;
  }): {
    audioClockStalled: boolean;
    recorderStalled: boolean;
    memoryCritical: boolean;
  } {
    const { elapsedSec, audioContext, recorderState, track, totalChunks, totalBytes } = params;
    const now = performance.now();
    const heap = readJsHeapStats();
    const heapDeltaMb =
      heap.usedMb !== null && this.baselineHeapMb !== null
        ? Math.round((heap.usedMb - this.baselineHeapMb) * 10) / 10
        : null;

    const currentChunkGapMs = Math.round(now - this.lastChunkAtMs);
    this.session.snapshot.elapsedSec = elapsedSec;
    this.session.snapshot.chunkCount = totalChunks;
    this.session.snapshot.bufferedBytes = totalBytes;
    this.session.snapshot.bytesPerSec = elapsedSec > 0 ? Math.round(totalBytes / elapsedSec) : 0;
    this.session.snapshot.lastChunkGapMs = currentChunkGapMs;
    if (currentChunkGapMs > this.session.snapshot.maxChunkGapMs) {
      this.session.snapshot.maxChunkGapMs = currentChunkGapMs;
      this.session.snapshot.latency.chunkGapMaxMs = currentChunkGapMs;
    }
    this.session.snapshot.jsHeapUsedMb = heap.usedMb;
    this.session.snapshot.jsHeapLimitMb = heap.limitMb;
    this.session.snapshot.jsHeapPercent = heap.pct;
    this.session.snapshot.jsHeapDeltaMb = heapDeltaMb;

    // Update stream & WebSocket buffer metrics
    const wsBuf = this.session.snapshot.wsBuffer;
    wsBuf.streamQueueBytes = totalBytes;
    if (totalBytes > wsBuf.streamHighWaterBytes) {
      wsBuf.streamHighWaterBytes = totalBytes;
    }
    wsBuf.bufferUtilizationPct =
      Math.round((totalBytes / wsBuf.bufferCapBytes) * 1000) / 10;
    const wsOverflow = this.sampleWebSocketBuffer();

    if (track) {
      this.session.snapshot.trackReadyState = track.readyState;
      this.session.snapshot.trackMuted = track.muted;
      if (track.muted) {
        this.consecutiveTrackMuteSec += 1;
        if (this.consecutiveTrackMuteSec === DIAG_THRESHOLDS.TRACK_MUTE_TIMEOUT_SEC) {
          this.setVerdictIfMoreSevere(
            'TRACK_TERMINATED',
            `麥克風音軌持續靜音超過 ${DIAG_THRESHOLDS.TRACK_MUTE_TIMEOUT_SEC} 秒。`
          );
          this.log('warn', 'track', 'TRACK_MUTE_TIMEOUT', '麥克風音軌持續靜音逾時', {
            mutedSec: this.consecutiveTrackMuteSec,
          });
        }
      } else {
        this.consecutiveTrackMuteSec = 0;
      }
    }

    // 1. Check Web Audio API Clock Stall / Timeout
    let audioClockStalled = false;
    if (audioContext) {
      const ctxTime = Math.round(audioContext.currentTime * 100) / 100;
      this.session.snapshot.audioContextState = audioContext.state;
      this.session.snapshot.audioContextTimeSec = ctxTime;

      if (
        this.lastAudioCtxTimeSec !== null &&
        Math.abs(audioContext.currentTime - this.lastAudioCtxTimeSec) < 0.05
      ) {
        this.consecutiveClockStallSec += 1;
      } else {
        this.consecutiveClockStallSec = 0;
      }
      this.lastAudioCtxTimeSec = audioContext.currentTime;
      this.session.snapshot.audioClockStallSec = this.consecutiveClockStallSec;

      if (this.consecutiveClockStallSec >= DIAG_THRESHOLDS.AUDIO_CLOCK_STALL_SEC) {
        audioClockStalled = true;
        this.setVerdictIfMoreSevere(
          'WEB_AUDIO_TIMEOUT',
          `Web Audio API currentTime 在第 ${elapsedSec} 秒停滯達 ${this.consecutiveClockStallSec} 秒（state=${audioContext.state}）。`
        );
        this.log(
          'error',
          'webaudio',
          'AUDIO_CLOCK_STALL_TIMEOUT',
          `偵測到 Web Audio API 串流時鐘停滯（${this.consecutiveClockStallSec}s 未推進），將隔離音量監測以保護錄音`,
          {
            state: audioContext.state,
            currentTimeSec: ctxTime,
            stallSec: this.consecutiveClockStallSec,
          }
        );
      }
    } else {
      this.session.snapshot.audioContextState = 'detached';
      this.session.snapshot.audioClockStallSec = 0;
    }

    // 2. Check MediaRecorder ondataavailable Starvation / Stream Timeout
    let recorderStalled = false;
    if (
      recorderState === 'recording' &&
      elapsedSec >= 5 &&
      currentChunkGapMs >= DIAG_THRESHOLDS.RECORDER_CHUNK_GAP_TIMEOUT_MS
    ) {
      recorderStalled = true;
      this.setVerdictIfMoreSevere(
        'RECORDER_STALL_TIMEOUT',
        `MediaRecorder 在第 ${elapsedSec} 秒已連續 ${(currentChunkGapMs / 1000).toFixed(1)} 秒未輸出資料切片。`
      );
      if (elapsedSec % 2 === 0) {
        this.log(
          'error',
          'mediarecorder',
          'RECORDER_STALL_TIMEOUT',
          `MediaRecorder 串流逾時：${currentChunkGapMs}ms 未收到 ondataavailable 切片`,
          {
            recorderState,
            chunkGapMs: currentChunkGapMs,
            totalChunks,
            totalKb: Math.round(totalBytes / 1024),
          }
        );
      }
    }

    // 3. Check JS Heap Memory Pressure / WebSocket Buffer Overflow
    let memoryCritical = wsOverflow;
    if (
      (heap.pct !== null && heap.pct >= DIAG_THRESHOLDS.JS_HEAP_PRESSURE_PCT) ||
      (heapDeltaMb !== null && heapDeltaMb >= DIAG_THRESHOLDS.JS_HEAP_DELTA_MB)
    ) {
      memoryCritical = true;
      this.setVerdictIfMoreSevere(
        'BUFFER_OVERFLOW',
        `JS Heap 記憶體壓力過高（${heap.usedMb ?? '?'} MB / ${heap.limitMb ?? '?'} MB，成長 +${heapDeltaMb ?? '?'} MB），判定為記憶體／緩衝區溢位風險。`
      );
      this.log(
        'error',
        'memory',
        'JS_HEAP_OVERFLOW_RISK',
        `偵測到高記憶體壓力（Heap ${heap.pct ?? '?'}%，+${heapDeltaMb ?? '?'} MB），自動觸發安全截斷`,
        {
          jsHeapUsedMb: heap.usedMb,
          jsHeapLimitMb: heap.limitMb,
          jsHeapPercent: heap.pct,
          jsHeapDeltaMb: heapDeltaMb,
          bufferedKb: Math.round(totalBytes / 1024),
        }
      );
    }

    // 4. Dedicated >60s Long-Stream Tracking Mode
    if (elapsedSec >= DIAG_THRESHOLDS.OVER_60S_THRESHOLD_SEC) {
      if (!this.session.snapshot.over60sTrackingActive) {
        this.session.snapshot.over60sTrackingActive = true;
        this.log(
          'info',
          'websocket',
          'OVER_60S_TRACKING_ACTIVATED',
          '錄音已超過 60 秒門檻，啟動每 5 秒高解析度緩衝區與延遲追蹤快照',
          {
            elapsedSec,
            streamQueueKb: Math.round((totalBytes / 1024) * 10) / 10,
            wsBufferedKb: Math.round((wsBuf.bufferedAmountBytes / 1024) * 10) / 10,
            utilizationPct: wsBuf.bufferUtilizationPct,
            maxChunkGapMs: this.session.snapshot.maxChunkGapMs,
            audioCtxState: this.session.snapshot.audioContextState,
          }
        );
      }

      if (
        this.lastOver60sCheckpointSec < 0 ||
        elapsedSec - this.lastOver60sCheckpointSec >= DIAG_THRESHOLDS.OVER_60S_CHECKPOINT_STEP_SEC
      ) {
        this.lastOver60sCheckpointSec = elapsedSec;
        const cp: Over60sCheckpoint = {
          ts: new Date().toISOString(),
          elapsedSec,
          chunkCount: totalChunks,
          streamQueueKb: Math.round((totalBytes / 1024) * 10) / 10,
          wsBufferedKb: Math.round((wsBuf.bufferedAmountBytes / 1024) * 10) / 10,
          bufferUtilizationPct: wsBuf.bufferUtilizationPct,
          chunkGapMs: currentChunkGapMs,
          analyserReadMs: this.lastAnalyserReadMs,
          audioContextState: this.session.snapshot.audioContextState,
          audioContextTimeSec: this.session.snapshot.audioContextTimeSec,
          jsHeapUsedMb: heap.usedMb,
        };
        this.session.over60sCheckpoints.push(cp);
        if (this.session.over60sCheckpoints.length > MAX_OVER_60S_CHECKPOINTS) {
          this.session.over60sCheckpoints.shift();
        }
        this.log(
          'info',
          'websocket',
          `OVER_60S_SNAPSHOT_${elapsedSec}S`,
          `>60s 串流追蹤 [+${elapsedSec}s]：緩衝 ${cp.streamQueueKb} KB（${cp.bufferUtilizationPct}%）· WS 積壓 ${cp.wsBufferedKb} KB · 切片延遲 ${cp.chunkGapMs}ms`,
          {
            elapsedSec,
            streamQueueKb: cp.streamQueueKb,
            wsBufferedKb: cp.wsBufferedKb,
            bufferUtilizationPct: cp.bufferUtilizationPct,
            chunkGapMs: cp.chunkGapMs,
            analyserReadMs: cp.analyserReadMs,
            jsHeapUsedMb: cp.jsHeapUsedMb,
          }
        );
      }
    } else if (elapsedSec === 15 || elapsedSec === 30 || elapsedSec === 45 || elapsedSec === 55) {
      this.log(
        'info',
        'memory',
        `MILESTONE_${elapsedSec}S`,
        `錄音檢查點 ${elapsedSec}s：緩衝 ${(totalBytes / 1024).toFixed(1)} KB（${totalChunks} 切片）· WebAudio=${this.session.snapshot.audioContextState}`,
        {
          elapsedSec,
          bufferedKb: Math.round((totalBytes / 1024) * 10) / 10,
          totalChunks,
          bytesPerSec: this.session.snapshot.bytesPerSec,
          maxChunkGapMs: this.session.snapshot.maxChunkGapMs,
          audioCtxTimeSec: this.session.snapshot.audioContextTimeSec,
          jsHeapUsedMb: heap.usedMb,
          jsHeapDeltaMb: heapDeltaMb,
        }
      );
    }

    // Crash-surviving checkpoint every 2 seconds (or immediately on any anomaly)
    if (
      elapsedSec - this.lastCheckpointSec >= 2 ||
      audioClockStalled ||
      recorderStalled ||
      memoryCritical
    ) {
      this.lastCheckpointSec = elapsedSec;
      this.persistActiveCheckpoint();
    } else {
      this.emitUpdate();
    }

    return { audioClockStalled, recorderStalled, memoryCritical };
  }

  markUploading(blobBytes: number, transport: 'binary_stream' | 'json_base64'): void {
    this.session.status = 'uploading';
    this.session.snapshot.bufferedBytes = blobBytes;
    this.session.snapshot.wsBuffer.streamQueueBytes = blobBytes;
    this.session.snapshot.wsBuffer.bufferUtilizationPct =
      Math.round((blobBytes / this.session.snapshot.wsBuffer.bufferCapBytes) * 1000) / 10;
    this.log(
      'info',
      'upload',
      'UPLOAD_START',
      `開始上傳語音串流（${(blobBytes / 1024).toFixed(1)} KB，模式=${transport}）`,
      { blobBytes, transport }
    );
    this.persistActiveCheckpoint();
  }

  recordApiProcessingLatency(metrics: {
    uploadRttMs: number;
    ffmpegNormalizeMs?: number | null;
    sttApiMs?: number | null;
    llmApiMs?: number | null;
    ttsApiMs?: number | null;
    totalPipelineMs?: number | null;
  }): void {
    const lat = this.session.snapshot.latency;
    lat.uploadRttMs = Math.round(metrics.uploadRttMs);
    lat.ffmpegNormalizeMs =
      metrics.ffmpegNormalizeMs !== undefined && metrics.ffmpegNormalizeMs !== null
        ? Math.round(metrics.ffmpegNormalizeMs)
        : null;
    lat.sttApiMs =
      metrics.sttApiMs !== undefined && metrics.sttApiMs !== null
        ? Math.round(metrics.sttApiMs)
        : null;
    lat.llmApiMs =
      metrics.llmApiMs !== undefined && metrics.llmApiMs !== null
        ? Math.round(metrics.llmApiMs)
        : null;
    lat.ttsApiMs =
      metrics.ttsApiMs !== undefined && metrics.ttsApiMs !== null
        ? Math.round(metrics.ttsApiMs)
        : null;
    lat.totalPipelineMs =
      metrics.totalPipelineMs !== undefined && metrics.totalPipelineMs !== null
        ? Math.round(metrics.totalPipelineMs)
        : Math.round(metrics.uploadRttMs);

    const slowStage =
      (lat.sttApiMs ?? 0) >= DIAG_THRESHOLDS.SLOW_API_STAGE_WARN_MS
        ? `STT API (${lat.sttApiMs}ms)`
        : (lat.ffmpegNormalizeMs ?? 0) >= DIAG_THRESHOLDS.SLOW_API_STAGE_WARN_MS
          ? `ffmpeg 正規化 (${lat.ffmpegNormalizeMs}ms)`
          : (lat.llmApiMs ?? 0) >= DIAG_THRESHOLDS.SLOW_API_STAGE_WARN_MS
            ? `LLM API (${lat.llmApiMs}ms)`
            : null;

    this.log(
      slowStage ? 'warn' : 'info',
      'upload',
      slowStage ? 'API_LATENCY_SLOW' : 'API_LATENCY_BREAKDOWN',
      slowStage
        ? `偵測到後端階段處理偏慢（${slowStage}），總往返延遲 ${lat.uploadRttMs}ms`
        : `後端語音管線完成：往返 ${lat.uploadRttMs}ms（ffmpeg ${lat.ffmpegNormalizeMs ?? '-'}ms / STT ${lat.sttApiMs ?? '-'}ms / LLM ${lat.llmApiMs ?? '-'}ms / TTS ${lat.ttsApiMs ?? '-'}ms）`,
      {
        uploadRttMs: lat.uploadRttMs,
        ffmpegNormalizeMs: lat.ffmpegNormalizeMs,
        sttApiMs: lat.sttApiMs,
        llmApiMs: lat.llmApiMs,
        ttsApiMs: lat.ttsApiMs,
        totalPipelineMs: lat.totalPipelineMs,
      }
    );
  }

  finalize(
    status: 'completed' | 'cancelled' | 'error',
    detail: string,
    overrideVerdict?: VoiceAnomalyVerdict
  ): VoiceDiagnosticSession {
    if (overrideVerdict) {
      this.setVerdictIfMoreSevere(overrideVerdict, detail);
    }
    this.session.status = status;
    this.session.endedAt = new Date().toISOString();
    this.log(
      status === 'error' ? 'error' : 'info',
      'lifecycle',
      `SESSION_${status.toUpperCase()}`,
      detail,
      {
        verdict: this.session.verdict,
        elapsedSec: this.session.snapshot.elapsedSec,
        over60sTrackingActive: this.session.snapshot.over60sTrackingActive,
        bufferedKb: Math.round((this.session.snapshot.bufferedBytes / 1024) * 10) / 10,
        chunkCount: this.session.snapshot.chunkCount,
        maxChunkGapMs: this.session.snapshot.maxChunkGapMs,
        uploadRttMs: this.session.snapshot.latency.uploadRttMs,
      }
    );

    try {
      window.localStorage.removeItem(STORAGE_KEY_ACTIVE);
    } catch {
      // ignore
    }
    const existing = VoiceAudioDiagnosticLogger.loadHistory();
    const nextHistory = [
      this.getSession(),
      ...existing.filter((s) => s.sessionId !== this.session.sessionId),
    ].slice(0, MAX_STORED_SESSIONS);
    safeWriteJson(STORAGE_KEY_HISTORY, nextHistory);
    this.emitUpdate();

    void this.sendReportToServer(false);
    return this.getSession();
  }

  flushBeacon(reason: string): void {
    this.log('warn', 'lifecycle', 'PAGEHIDE_DURING_SESSION', `頁面在錄音/上傳期間卸載（${reason}）`, {
      reason,
      status: this.session.status,
      elapsedSec: this.session.snapshot.elapsedSec,
      bufferedBytes: this.session.snapshot.bufferedBytes,
      wsBufferedAmountBytes: this.session.snapshot.wsBuffer.bufferedAmountBytes,
    });
    this.persistActiveCheckpoint();
    void this.sendReportToServer(true);
  }

  private setVerdictIfMoreSevere(verdict: VoiceAnomalyVerdict, reason: string): void {
    if (this.session.verdict === 'HEALTHY') {
      this.session.verdict = verdict;
      this.session.verdictReason = reason;
    }
  }

  private persistActiveCheckpoint(): void {
    safeWriteJson(STORAGE_KEY_ACTIVE, this.getSession());
    this.emitUpdate();
  }

  private emitUpdate(): void {
    if (this.onUpdate) {
      this.onUpdate(this.getSession());
    }
  }

  private async sendReportToServer(useBeacon: boolean): Promise<void> {
    const payload = JSON.stringify({
      sessionId: this.session.sessionId,
      startedAt: this.session.startedAt,
      endedAt: this.session.endedAt,
      status: this.session.status,
      verdict: this.session.verdict,
      verdictReason: this.session.verdictReason,
      mimeType: this.session.mimeType,
      targetBitrateBps: this.session.targetBitrateBps,
      userAgentShort: this.session.userAgentShort,
      snapshot: this.session.snapshot,
      over60sCheckpoints: this.session.over60sCheckpoints.slice(-60),
      recentEvents: this.session.events.slice(-120),
    });

    try {
      if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/observability/voice-diagnostics', blob);
        return;
      }
      await fetch('/api/observability/voice-diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      });
    } catch {
      // Telemetry is strictly best-effort and must never interfere with recording
    }
  }

  static recoverInterruptedSession(): VoiceDiagnosticSession | null {
    const rawActive = safeReadJson<Partial<VoiceDiagnosticSession>>(STORAGE_KEY_ACTIVE);
    if (!rawActive) return null;

    try {
      window.localStorage.removeItem(STORAGE_KEY_ACTIVE);
    } catch {
      // ignore
    }

    const active = normalizeLegacySession(rawActive);
    if (active.status !== 'recording' && active.status !== 'uploading') {
      return null;
    }

    let inferredVerdict: VoiceAnomalyVerdict = active.verdict;
    let inferredReason = active.verdictReason;

    if (inferredVerdict === 'HEALTHY') {
      const snap = active.snapshot;
      if (
        snap.wsBuffer.bufferedAmountBytes >= DIAG_THRESHOLDS.WS_BUFFER_OVERFLOW_BYTES ||
        snap.bufferedBytes >= DIAG_THRESHOLDS.BUFFER_WARN_BYTES ||
        (snap.jsHeapPercent !== null && snap.jsHeapPercent >= DIAG_THRESHOLDS.JS_HEAP_PRESSURE_PCT) ||
        (snap.jsHeapDeltaMb !== null && snap.jsHeapDeltaMb >= DIAG_THRESHOLDS.JS_HEAP_DELTA_MB)
      ) {
        inferredVerdict = 'BUFFER_OVERFLOW';
        inferredReason = `分頁於第 ${Math.round(snap.elapsedSec)} 秒終止前緩衝達 ${(snap.bufferedBytes / 1024).toFixed(0)} KB / WS 積壓 ${(snap.wsBuffer.bufferedAmountBytes / 1024).toFixed(0)} KB / Heap ${snap.jsHeapUsedMb ?? '?'} MB，研判為緩衝區／記憶體溢位。`;
      } else if (
        snap.audioClockStallSec >= 2 ||
        snap.audioContextState === 'suspended' ||
        snap.audioContextState === 'interrupted'
      ) {
        inferredVerdict = 'WEB_AUDIO_TIMEOUT';
        inferredReason = `分頁於第 ${Math.round(snap.elapsedSec)} 秒終止前 AudioContext 處於 ${snap.audioContextState}（時鐘停滯 ${snap.audioClockStallSec}s），研判為 Web Audio API 串流逾時。`;
      } else if (snap.maxChunkGapMs >= DIAG_THRESHOLDS.RECORDER_CHUNK_GAP_WARN_MS) {
        inferredVerdict = 'RECORDER_STALL_TIMEOUT';
        inferredReason = `分頁於第 ${Math.round(snap.elapsedSec)} 秒終止前 MediaRecorder 最大切片延遲達 ${snap.maxChunkGapMs}ms，研判為錄音串流逾時。`;
      } else if (active.status === 'uploading') {
        inferredVerdict = 'API_TIMEOUT';
        inferredReason = `分頁於上傳與後端語音辨識期間中斷（錄音長度 ${Math.round(snap.elapsedSec)} 秒），疑似 API 回應超時或連線中斷。`;
      } else {
        inferredVerdict = 'UNKNOWN_TAB_TERMINATION';
        inferredReason = `上一次錄音在第 ${Math.round(snap.elapsedSec)} 秒（${(snap.bufferedBytes / 1024).toFixed(1)} KB，${snap.chunkCount} 切片）未正常結束即中斷，可能由外部容器重啟或瀏覽器終止。`;
      }
    }

    const recovered: VoiceDiagnosticSession = {
      ...active,
      status: 'interrupted',
      endedAt: new Date().toISOString(),
      verdict: inferredVerdict,
      verdictReason: inferredReason,
    };

    const existing = VoiceAudioDiagnosticLogger.loadHistory();
    safeWriteJson(
      STORAGE_KEY_HISTORY,
      [recovered, ...existing.filter((s) => s.sessionId !== recovered.sessionId)].slice(
        0,
        MAX_STORED_SESSIONS
      )
    );
    return recovered;
  }

  static loadHistory(): VoiceDiagnosticSession[] {
    const raw = safeReadJson<Array<Partial<VoiceDiagnosticSession>>>(STORAGE_KEY_HISTORY);
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => ({
      ...normalizeLegacySession(item),
      source: 'local' as const,
    }));
  }

  static async fetchServerHistory(): Promise<VoiceDiagnosticSession[]> {
    try {
      const res = await fetch('/api/observability/voice-diagnostics', { cache: 'no-store' });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        reports?: Array<
          Partial<VoiceDiagnosticSession> & {
            receivedAt?: string;
            recentEvents?: VoiceDiagEvent[];
          }
        >;
      };
      if (!Array.isArray(data.reports)) return [];
      return data.reports.map((r) => {
        const normalized = normalizeLegacySession({
          ...r,
          startedAt: r.startedAt || r.receivedAt || new Date().toISOString(),
          updatedAt: r.receivedAt || r.endedAt || r.startedAt || new Date().toISOString(),
          events: Array.isArray(r.events)
            ? r.events
            : Array.isArray(r.recentEvents)
              ? r.recentEvents
              : [],
        });
        return { ...normalized, source: 'server' as const };
      });
    } catch {
      return [];
    }
  }

  static mergeSessions(
    localSessions: VoiceDiagnosticSession[],
    serverSessions: VoiceDiagnosticSession[]
  ): VoiceDiagnosticSession[] {
    const map = new Map<string, VoiceDiagnosticSession>();
    for (const s of serverSessions) {
      map.set(s.sessionId, { ...s, source: 'server' });
    }
    for (const l of localSessions) {
      const existing = map.get(l.sessionId);
      if (!existing) {
        map.set(l.sessionId, { ...l, source: 'local' });
      } else {
        // Merge preferring richer event/checkpoint history while marking as synced
        const events = l.events.length >= existing.events.length ? l.events : existing.events;
        const over60sCheckpoints =
          l.over60sCheckpoints.length >= existing.over60sCheckpoints.length
            ? l.over60sCheckpoints
            : existing.over60sCheckpoints;
        map.set(l.sessionId, {
          ...existing,
          ...l,
          events,
          over60sCheckpoints,
          source: 'synced',
        });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 30);
  }

  static clearHistory(): void {
    try {
      window.localStorage.removeItem(STORAGE_KEY_HISTORY);
      window.localStorage.removeItem(STORAGE_KEY_ACTIVE);
    } catch {
      // ignore
    }
  }

  static async clearServerHistory(): Promise<void> {
    try {
      await fetch('/api/observability/voice-diagnostics', {
        method: 'DELETE',
        cache: 'no-store',
      });
    } catch {
      // ignore
    }
  }
}

export function analyzeInterruptionRootCause(
  session: VoiceDiagnosticSession
): InterruptionRootCauseAnalysis {
  const { snapshot, verdict, over60sCheckpoints } = session;
  const ws = snapshot.wsBuffer;
  const lat = snapshot.latency;
  const signals: string[] = [];
  const recommendations: string[] = [];

  if (snapshot.elapsedSec >= 60 || over60sCheckpoints.length > 0) {
    const peakCpBufKb = over60sCheckpoints.reduce(
      (max, cp) => Math.max(max, cp.streamQueueKb),
      Math.round((ws.streamHighWaterBytes / 1024) * 10) / 10
    );
    const peakCpWsKb = over60sCheckpoints.reduce(
      (max, cp) => Math.max(max, cp.wsBufferedKb),
      Math.round((ws.peakBufferedAmountBytes / 1024) * 10) / 10
    );
    const peakCpGap = over60sCheckpoints.reduce(
      (max, cp) => Math.max(max, cp.chunkGapMs),
      lat.chunkGapMaxMs
    );
    signals.push(
      `超過 60 秒長錄音共採樣 ${over60sCheckpoints.length} 筆檢查點：音訊緩衝峰值 ${peakCpBufKb} KB（${ws.bufferUtilizationPct}%）、WS 積壓峰值 ${peakCpWsKb} KB、最大切片間隔 ${peakCpGap} ms`
    );
  } else {
    signals.push(
      `本次錄音長度 ${snapshot.elapsedSec} 秒（尚未觸發 60 秒門檻），累計 ${snapshot.chunkCount} 個音訊切片，串流高水位 ${(ws.streamHighWaterBytes / 1024).toFixed(1)} KB`
    );
  }

  if (ws.backpressureEvents > 0 || ws.bufferUtilizationPct >= 70) {
    signals.push(
      `緩衝區壓力偏高：使用率達 ${ws.bufferUtilizationPct}%，背壓告警 ${ws.backpressureEvents} 次，平均位元率 ${(snapshot.bytesPerSec / 1024).toFixed(1)} KB/s`
    );
  }

  if (lat.chunkGapMaxMs >= DIAG_THRESHOLDS.RECORDER_CHUNK_GAP_WARN_MS) {
    signals.push(
      `MediaRecorder 切片輸出曾延遲達 ${lat.chunkGapMaxMs} ms（平均 ${lat.chunkGapAvgMs} ms，預期每 1000 ms 一片）`
    );
  }

  if (snapshot.audioClockStallSec > 0 || snapshot.audioContextState === 'suspended' || snapshot.audioContextState === 'interrupted') {
    signals.push(
      `Web Audio API 異常：AudioContext 狀態為 ${snapshot.audioContextState}，時鐘最長停滯 ${snapshot.audioClockStallSec} 秒`
    );
  }

  if (lat.uploadRttMs !== null || lat.totalPipelineMs !== null) {
    signals.push(
      `後端處理耗時：上傳 RTT ${lat.uploadRttMs ?? '—'} ms · ffmpeg ${lat.ffmpegNormalizeMs ?? '—'} ms · STT ${lat.sttApiMs ?? '—'} ms · LLM ${lat.llmApiMs ?? '—'} ms · TTS ${lat.ttsApiMs ?? '—'} ms`
    );
  }

  switch (verdict) {
    case 'BUFFER_OVERFLOW':
      recommendations.push('檢查 MediaRecorder audioBitsPerSecond 是否被瀏覽器忽略（正常 32kbps 約 4 KB/s）；若使用 WebSocket 串流，請在 bufferedAmount > 1 MB 時暫停推流並釋放佇列。');
      recommendations.push('若 JS Heap 持續上升，請確認沒有把 Blob 轉成大型 Base64 字串，改維持 /api/bot/voice-stream 二進位零拷貝上傳。');
      return {
        category: '緩衝區／記憶體溢位',
        severity: 'error',
        headline: '研判中斷主因為音訊緩衝區或 WebSocket 發送佇列溢位',
        signals,
        recommendations,
      };
    case 'WEB_AUDIO_TIMEOUT':
      recommendations.push('瀏覽器在分頁背景化或省電模式下可能暫停 AudioContext；確認 AnalyserNode 音量監測維持與 MediaRecorder 解耦，避免時鐘停滯拖垮錄音。');
      recommendations.push('檢查系統音訊裝置（尤其藍牙耳機切換 HFP/A2DP 模式）是否造成 AudioContext interrupted。');
      return {
        category: 'Web Audio API 逾時',
        severity: 'error',
        headline: '研判中斷主因為 AudioContext 時鐘停滯或進入暫停狀態',
        signals,
        recommendations,
      };
    case 'RECORDER_STALL_TIMEOUT':
      recommendations.push('MediaRecorder 超過 5 秒未觸發 ondataavailable，常見於編碼器卡死或主執行緒長時間阻塞；可檢視 >60s 檢查點中切片間隔陡升的時間點。');
      recommendations.push('嘗試切換不同麥克風裝置或確認瀏覽器硬體音訊編碼資源未被其他分頁佔用。');
      return {
        category: '錄音串流停滯逾時',
        severity: 'error',
        headline: '研判中斷主因為 MediaRecorder 切片輸出停滯超時',
        signals,
        recommendations,
      };
    case 'TRACK_TERMINATED':
      recommendations.push('作業系統權限、藍牙斷線或另一款會議軟體搶佔了麥克風，導致 MediaStreamTrack 觸發 ended/mute。');
      recommendations.push('建議在 Bot 控制台上方切換為有線／系統內建麥克風再進行超過 60 秒長錄音測試。');
      return {
        category: '硬體／音軌中斷',
        severity: 'warn',
        headline: '研判中斷主因為麥克風 MediaStreamTrack 被外部終止或靜音',
        signals,
        recommendations,
      };
    case 'UPLOAD_TIMEOUT':
    case 'API_TIMEOUT':
      recommendations.push('請對照上方後端耗時拆解：若 ffmpeg 或 STT 超過 12 秒，檢查音檔體積與單次轉碼設定（16kHz mono 32kbps MP3）。');
      recommendations.push('確認後端 Gemini API 金鑰配額、網路連線穩定度以及前端 fetch AbortController 逾時設定。');
      return {
        category: '傳輸／後端 API 超時',
        severity: 'error',
        headline: '研判異常主因為音訊上傳網路中斷或後端 STT/LLM/TTS 處理逾時',
        signals,
        recommendations,
      };
    case 'UNKNOWN_TAB_TERMINATION':
      recommendations.push('此紀錄為瀏覽器異常關閉／重整後由 2 秒檢查點自動還原；請檢視最後一筆 >60s 快照的 JS Heap 與串流緩衝值，判斷是否為分頁 OOM 或外部容器重啟。');
      return {
        category: '分頁異常終止',
        severity: 'error',
        headline: '錄音未正常結束即中斷，已從最後檢查點還原現場狀態',
        signals,
        recommendations,
      };
    default:
      recommendations.push(
        snapshot.elapsedSec >= 60
          ? '本次超過 60 秒的長語音串流全程穩定，緩衝使用率、切片間隔與後端延遲皆處於健康範圍。'
          : '串流與緩衝區指標均正常；若要驗證長錄音穩定性，可錄製超過 60 秒以檢視每 5 秒緩衝與延遲趨勢圖。'
      );
      return {
        category: '健康無異常',
        severity: 'ok',
        headline: '未偵測到緩衝區溢位、WebSocket 背壓或 API 超時中斷',
        signals,
        recommendations,
      };
  }
}
