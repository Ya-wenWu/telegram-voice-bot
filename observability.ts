/**
 * Web Voice Bot Observability Module
 * 1. Prometheus metrics (queue_depth, tts_wait_seconds, ffmpeg_queue_length, request_duration_seconds, redis_failures_total)
 * 2. Structured JSON logging with trace_id & span_id (plus automatic secret redaction)
 * 3. W3C TraceContext / OpenTelemetry-compatible tracing across HTTP -> Queue -> Worker -> STT/LLM/TTS/ffmpeg -> Reply
 */

import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  reqId?: string;
}

export interface CompletedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  durationMs: number;
  status: 'OK' | 'ERROR';
  attributes: Record<string, string | number | boolean>;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();
const recentSpans: CompletedSpan[] = [];
const MAX_RECENT_SPANS = 200;

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function getTraceContext(): TraceContext {
  return traceStorage.getStore() ?? { traceId: '-', spanId: '-' };
}

export function parseTraceparent(header: string | undefined): {
  traceId?: string;
  parentSpanId?: string;
} {
  if (!header) return {};
  const match = header.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  if (!match) return {};
  return { traceId: match[1].toLowerCase(), parentSpanId: match[2].toLowerCase() };
}

export function formatTraceparent(ctx: TraceContext): string {
  if (!/^[0-9a-f]{32}$/.test(ctx.traceId) || !/^[0-9a-f]{16}$/.test(ctx.spanId)) {
    return '';
  }
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (ctx: TraceContext) => Promise<T>,
  incoming?: { traceId?: string; parentSpanId?: string; reqId?: string }
): Promise<T> {
  const parent = traceStorage.getStore();
  const traceId =
    incoming?.traceId && incoming.traceId !== '-'
      ? incoming.traceId
      : parent && parent.traceId !== '-'
      ? parent.traceId
      : generateTraceId();
  const parentSpanId =
    incoming?.parentSpanId && incoming.parentSpanId !== '-'
      ? incoming.parentSpanId
      : parent && parent.spanId !== '-'
      ? parent.spanId
      : null;
  const spanId = generateSpanId();
  const ctx: TraceContext = {
    traceId,
    spanId,
    reqId: incoming?.reqId ?? parent?.reqId,
  };

  const t0 = performance.now();
  let status: 'OK' | 'ERROR' = 'OK';
  try {
    return await traceStorage.run(ctx, () => fn(ctx));
  } catch (err) {
    status = 'ERROR';
    throw err;
  } finally {
    const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
    recentSpans.push({
      name,
      traceId,
      spanId,
      parentSpanId,
      durationMs,
      status,
      attributes,
    });
    if (recentSpans.length > MAX_RECENT_SPANS) {
      recentSpans.shift();
    }
  }
}

export function getRecentSpans(traceId?: string): CompletedSpan[] {
  if (!traceId) return [...recentSpans];
  return recentSpans.filter((s) => s.traceId === traceId);
}

// ---------------------------------------------------------------------------
// Structured JSON Logger (never leaks API keys / Bearer tokens)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{35}/g, '***REDACTED***'],
  [/ghp_[0-9A-Za-z]{36}/g, '***REDACTED***'],
  [/github_pat_[0-9A-Za-z_]{20,}/g, '***REDACTED***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***REDACTED***'],
];

function redactString(input: string): string {
  let out = input;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

export function logJson(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  extra?: Record<string, unknown>
): void {
  const ctx = getTraceContext();
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: 'web-voice-bot',
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    req_id: ctx.reqId ?? '-',
    message: redactString(message),
    ...(extra ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Prometheus Metrics Registry (exposition format v0.0.4)
// ---------------------------------------------------------------------------

class Gauge {
  private value = 0;
  private windowPeak = 0;
  private allTimePeak = 0;
  private totalEntered = 0;
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}
  set(v: number): void {
    const next = Math.max(0, v);
    this.value = next;
    if (next > this.windowPeak) this.windowPeak = next;
    if (next > this.allTimePeak) this.allTimePeak = next;
  }
  inc(v = 1): void {
    if (v > 0) this.totalEntered += v;
    this.value += v;
    if (this.value > this.windowPeak) this.windowPeak = this.value;
    if (this.value > this.allTimePeak) this.allTimePeak = this.value;
  }
  dec(v = 1): void {
    this.value = Math.max(0, this.value - v);
  }
  get(): number {
    return this.value;
  }
  peekWindowPeak(): number {
    return Math.max(this.value, this.windowPeak);
  }
  consumeWindowPeak(): number {
    const peak = Math.max(this.value, this.windowPeak);
    this.windowPeak = this.value;
    return peak;
  }
  getAllTimePeak(): number {
    return this.allTimePeak;
  }
  getTotalEntered(): number {
    return this.totalEntered;
  }
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.value}`;
  }
}

class Counter {
  private value = 0;
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}
  inc(v = 1): void {
    if (v >= 0) this.value += v;
  }
  get(): number {
    return this.value;
  }
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} ${this.value}`;
  }
}

class Histogram {
  private counts: number[];
  private totalCount = 0;
  private sum = 0;
  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly buckets: number[]
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.counts = this.buckets.map(() => 0);
  }
  observe(valueSec: number): void {
    if (!Number.isFinite(valueSec) || valueSec < 0) return;
    this.totalCount += 1;
    this.sum += valueSec;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (valueSec <= this.buckets[i]) {
        this.counts[i] += 1;
      }
    }
  }
  snapshot(): {
    buckets: Array<{ le: number; count: number }>;
    count: number;
    sum: number;
  } {
    return {
      buckets: this.buckets.map((le, idx) => ({ le, count: this.counts[idx] })),
      count: this.totalCount,
      sum: this.sum,
    };
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (let i = 0; i < this.buckets.length; i += 1) {
      lines.push(`${this.name}_bucket{le="${this.buckets[i]}"} ${this.counts[i]}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.totalCount}`);
    lines.push(`${this.name}_sum ${this.sum.toFixed(6)}`);
    lines.push(`${this.name}_count ${this.totalCount}`);
    return lines.join('\n');
  }
}

export function estimateHistogramQuantileMs(
  buckets: Array<{ le: number; count: number }>,
  totalCount: number,
  quantile: number
): number {
  if (totalCount <= 0 || buckets.length === 0) return 0;
  const target = totalCount * quantile;
  let prevBound = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      if (b.count === prevCount) {
        return Math.round(b.le * 10000) / 10;
      }
      const frac = (target - prevCount) / (b.count - prevCount);
      return Math.round((prevBound + frac * (b.le - prevBound)) * 10000) / 10;
    }
    prevBound = b.le;
    prevCount = b.count;
  }
  return Math.round(buckets[buckets.length - 1].le * 10000) / 10;
}

let lastTtsNoteValue: string | null = null;

export const serverMetrics = {
  queueDepth: new Gauge(
    'queue_depth',
    'Current number of in-flight/queued conversation or API tasks.'
  ),
  ttsWaitSeconds: new Histogram(
    'tts_wait_seconds',
    'TTS synthesis wait duration in seconds.',
    [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]
  ),
  ffmpegQueueLength: new Gauge(
    'ffmpeg_queue_length',
    'Current number of audio tasks waiting for or executing ffmpeg.'
  ),
  requestDurationSeconds: new Histogram(
    'request_duration_seconds',
    'End-to-end bot and observability request latency in seconds.',
    [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.5, 10.0, 15.0, 30.0, 60.0]
  ),
  redisFailuresTotal: new Counter(
    'redis_failures_total',
    'Total number of Redis quota check failures (fail-open events).'
  ),
  ttsDegradedTotal: new Counter(
    'tts_degraded_total',
    'Total number of replies where TTS gracefully degraded to text-only.'
  ),
  botGuardBlockedTotal: new Counter(
    'bot_guard_blocked_total',
    'Total number of malicious or automated bot requests blocked by BotGuard.'
  ),
  botGuardChallengedTotal: new Counter(
    'bot_guard_challenged_total',
    'Total number of suspicious requests challenged for human verification.'
  ),
  setLastTtsNote(note: string | null): void {
    lastTtsNoteValue = note;
  },
  getLastTtsNote(): string | null {
    return lastTtsNoteValue;
  },
  renderPrometheus(): string {
    const queueTasksLine = [
      '# HELP queue_tasks_total Total number of tasks handled by the request queue.',
      '# TYPE queue_tasks_total counter',
      `queue_tasks_total ${this.queueDepth.getTotalEntered()}`,
    ].join('\n');
    const ffmpegTasksLine = [
      '# HELP ffmpeg_tasks_total Total number of audio tasks executed by ffmpeg.',
      '# TYPE ffmpeg_tasks_total counter',
      `ffmpeg_tasks_total ${this.ffmpegQueueLength.getTotalEntered()}`,
    ].join('\n');
    return (
      [
        this.queueDepth.render(),
        queueTasksLine,
        this.ttsWaitSeconds.render(),
        this.ttsDegradedTotal.render(),
        this.ffmpegQueueLength.render(),
        ffmpegTasksLine,
        this.requestDurationSeconds.render(),
        this.redisFailuresTotal.render(),
        this.botGuardBlockedTotal.render(),
        this.botGuardChallengedTotal.render(),
      ].join('\n\n') + '\n'
    );
  },
};

