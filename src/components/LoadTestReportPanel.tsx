import { useMemo, useState } from 'react';
import { BarChart3, Check, Copy, Download, FileDown, FileText } from 'lucide-react';
import rawReportMarkdown from '../../LOAD_TEST_REPORT.md?raw';
import { exportLoadTestReportPdf } from '../utils/loadTestPdfExporter';

type ConfigFilter = 'default' | 'scaled' | 'all';
type ChartSeriesKey = 's3_mixed_w1' | 's3b_mixed_w3' | 's1_text_w1' | 's2_voice_w1';
type PriorityFilter = 'all' | 'P0' | 'P1' | 'P2' | 'ruled_out';
type ViewMode = 'visual' | 'markdown';

interface ScenarioRow {
  id: string;
  group: 'default' | 'scaled';
  name: string;
  config: string;
  load: string;
  requests: number;
  failures: number;
  failureRate: string;
  rawQps: string;
  effectiveQps: string;
  avgMs: string;
  p50Ms: string;
  p95Ms: string;
  p99Ms: string;
  maxMs: string;
  queuePeakAvg: string;
  cpuRss: string;
  note?: string;
}

interface TimePoint {
  t: number;
  q: number;
  ff: number;
}

const SCENARIO_ROWS: ScenarioRow[] = [
  {
    id: 'S1',
    group: 'default',
    name: 'S1 純文字請求',
    config: 'W=1, Q=10',
    load: '10u / 12s',
    requests: 87,
    failures: 0,
    failureRate: '0.0%',
    rawQps: '7.95',
    effectiveQps: '7.95',
    avgMs: '1,043.2',
    p50Ms: '1,100',
    p95Ms: '1,200',
    p99Ms: '1,200',
    maxMs: '1,210.6',
    queuePeakAvg: '9 / 7.00',
    cpuRss: '15.9% / 68.4 MB',
    note: '達單 Worker 理論上限（8.33 req/s）的 95.4%',
  },
  {
    id: 'S2',
    group: 'default',
    name: 'S2 純語音請求',
    config: 'W=1, Q=10',
    load: '10u / 12s',
    requests: 21,
    failures: 0,
    failureRate: '0.0%',
    rawQps: '1.98',
    effectiveQps: '1.98',
    avgMs: '3,732.4',
    p50Ms: '4,600',
    p95Ms: '4,900',
    p99Ms: '5,000',
    maxMs: '4,985.8',
    queuePeakAvg: '9 / 7.64',
    cpuRss: '9.9% / 71.4 MB',
    note: 'TTS 69 次呼叫：均 151.5 ms / P95 242.5 ms',
  },
  {
    id: 'S3',
    group: 'default',
    name: 'S3 混合 60%文 / 40%音',
    config: 'W=1, Q=10',
    load: '12u / 15s',
    requests: 188,
    failures: 154,
    failureRate: '81.9%',
    rawQps: '13.42',
    effectiveQps: '2.43',
    avgMs: '628.7*',
    p50Ms: '7*',
    p95Ms: '3,800',
    p99Ms: '4,000',
    maxMs: '4,290.8',
    queuePeakAvg: '10 / 9.52',
    cpuRss: '37.8% / 74.5 MB',
    note: '1 秒打滿佇列；成功文字 P95 3,500 ms、語音 P95 3,800 ms',
  },
  {
    id: 'S2b',
    group: 'scaled',
    name: 'S2b 純語音（擴容對照）',
    config: 'W=3, Q=30',
    load: '10u / 12s',
    requests: 64,
    failures: 0,
    failureRate: '0.0%',
    rawQps: '5.89',
    effectiveQps: '5.89',
    avgMs: '1,422.2',
    p50Ms: '1,500',
    p95Ms: '1,600',
    p99Ms: '1,600',
    maxMs: '1,612.5',
    queuePeakAvg: '7 / 5.60',
    cpuRss: '19.9% / 71.1 MB',
    note: '有效 QPS +197.5%（2.97×），P95 -67.3%',
  },
  {
    id: 'S3b',
    group: 'scaled',
    name: 'S3b 混合負載（擴容對照）',
    config: 'W=3, Q=30',
    load: '12u / 15s',
    requests: 136,
    failures: 0,
    failureRate: '0.0%',
    rawQps: '9.70',
    effectiveQps: '9.70',
    avgMs: '1,005.9',
    p50Ms: '1,000',
    p95Ms: '1,600',
    p99Ms: '1,700',
    maxMs: '1,816.2',
    queuePeakAvg: '9 / 6.68',
    cpuRss: '25.9% / 77.2 MB',
    note: '429 歸零，有效 QPS 4.0×；暴露 tts_wait P95 334.2 ms 與 ffmpeg 排隊 2',
  },
];

const QUEUE_SERIES: Record<
  ChartSeriesKey,
  {
    label: string;
    subtitle: string;
    maxQueue: number;
    yMax: number;
    accentColor: string;
    points: TimePoint[];
  }
> = {
  s3_mixed_w1: {
    label: 'S3 混合負載（W=1, Q=10）',
    subtitle: '僅 1.0 秒即打滿佇列上限 10，全程鎖死並觸發 159 次 QueueFull 拒絕',
    maxQueue: 10,
    yMax: 12,
    accentColor: '#DC2626',
    points: [
      { t: 0.0, q: 0, ff: 0 },
      { t: 0.5, q: 7, ff: 0 },
      { t: 1.0, q: 10, ff: 0 },
      { t: 1.5, q: 9, ff: 0 },
      { t: 2.0, q: 10, ff: 0 },
      { t: 2.5, q: 10, ff: 0 },
      { t: 3.0, q: 10, ff: 0 },
      { t: 3.5, q: 10, ff: 0 },
      { t: 4.0, q: 10, ff: 0 },
      { t: 4.5, q: 10, ff: 0 },
      { t: 5.0, q: 10, ff: 1 },
      { t: 5.5, q: 10, ff: 1 },
      { t: 6.0, q: 10, ff: 0 },
      { t: 6.5, q: 10, ff: 1 },
      { t: 7.0, q: 10, ff: 1 },
      { t: 7.5, q: 10, ff: 0 },
      { t: 8.1, q: 10, ff: 0 },
      { t: 8.6, q: 10, ff: 0 },
      { t: 9.1, q: 10, ff: 0 },
      { t: 9.6, q: 10, ff: 0 },
      { t: 10.1, q: 10, ff: 0 },
      { t: 10.6, q: 10, ff: 0 },
      { t: 11.1, q: 10, ff: 1 },
      { t: 11.6, q: 10, ff: 0 },
      { t: 12.1, q: 10, ff: 0 },
      { t: 12.6, q: 10, ff: 0 },
      { t: 13.1, q: 10, ff: 0 },
      { t: 13.6, q: 10, ff: 0 },
      { t: 14.1, q: 10, ff: 0 },
      { t: 14.6, q: 9, ff: 0 },
      { t: 15.1, q: 10, ff: 1 },
    ],
  },
  s3b_mixed_w3: {
    label: 'S3b 混合負載（W=3, Q=30）',
    subtitle: '全程平穩維持在 6–9（遠低於上限 30、0 失敗），t=4.5s 觀測到 ffmpeg_queue_length = 2',
    maxQueue: 30,
    yMax: 12,
    accentColor: '#2563EB',
    points: [
      { t: 0.0, q: 0, ff: 0 },
      { t: 0.5, q: 3, ff: 1 },
      { t: 1.0, q: 3, ff: 0 },
      { t: 1.5, q: 0, ff: 0 },
      { t: 2.0, q: 3, ff: 0 },
      { t: 2.5, q: 3, ff: 1 },
      { t: 3.0, q: 7, ff: 1 },
      { t: 3.5, q: 8, ff: 1 },
      { t: 4.0, q: 7, ff: 0 },
      { t: 4.5, q: 9, ff: 2 },
      { t: 5.0, q: 9, ff: 1 },
      { t: 5.5, q: 8, ff: 0 },
      { t: 6.0, q: 8, ff: 1 },
      { t: 6.5, q: 7, ff: 0 },
      { t: 7.0, q: 7, ff: 0 },
      { t: 7.6, q: 9, ff: 0 },
      { t: 8.1, q: 7, ff: 1 },
      { t: 8.6, q: 7, ff: 1 },
      { t: 9.1, q: 7, ff: 1 },
      { t: 9.6, q: 9, ff: 1 },
      { t: 10.1, q: 9, ff: 1 },
      { t: 10.6, q: 8, ff: 0 },
      { t: 11.1, q: 9, ff: 1 },
      { t: 11.6, q: 8, ff: 1 },
      { t: 12.1, q: 7, ff: 0 },
      { t: 12.6, q: 8, ff: 1 },
      { t: 13.1, q: 9, ff: 0 },
      { t: 13.6, q: 7, ff: 0 },
      { t: 14.1, q: 7, ff: 0 },
      { t: 14.6, q: 8, ff: 0 },
      { t: 15.1, q: 6, ff: 1 },
    ],
  },
  s1_text_w1: {
    label: 'S1 純文字（W=1, Q=10）',
    subtitle: '10 併發穩定維持 1 執行 + 8 排隊（均值 7.00），吞吐量 7.95 req/s、0 失敗',
    maxQueue: 10,
    yMax: 12,
    accentColor: '#0F766E',
    points: [
      { t: 0.0, q: 0, ff: 0 },
      { t: 0.5, q: 0, ff: 0 },
      { t: 1.0, q: 3, ff: 0 },
      { t: 1.5, q: 3, ff: 0 },
      { t: 2.0, q: 8, ff: 0 },
      { t: 2.5, q: 8, ff: 0 },
      { t: 3.0, q: 9, ff: 0 },
      { t: 3.5, q: 8, ff: 0 },
      { t: 4.0, q: 8, ff: 0 },
      { t: 4.5, q: 8, ff: 0 },
      { t: 5.0, q: 9, ff: 0 },
      { t: 5.5, q: 8, ff: 0 },
      { t: 6.0, q: 8, ff: 0 },
      { t: 6.5, q: 8, ff: 0 },
      { t: 7.1, q: 8, ff: 0 },
      { t: 7.6, q: 7, ff: 0 },
      { t: 8.1, q: 8, ff: 0 },
      { t: 8.6, q: 8, ff: 0 },
      { t: 9.1, q: 8, ff: 0 },
      { t: 9.6, q: 8, ff: 0 },
      { t: 10.1, q: 8, ff: 0 },
      { t: 10.6, q: 8, ff: 0 },
      { t: 11.1, q: 8, ff: 0 },
      { t: 11.6, q: 8, ff: 0 },
      { t: 12.1, q: 8, ff: 0 },
    ],
  },
  s2_voice_w1: {
    label: 'S2 純語音（W=1, Q=10）',
    subtitle: '單 Worker 消化慢（1.98 req/s），佇列長期貼近 9（均 7.64），P95 達 4,900 ms',
    maxQueue: 10,
    yMax: 12,
    accentColor: '#D97706',
    points: [
      { t: 0.0, q: 0, ff: 0 },
      { t: 0.5, q: 3, ff: 0 },
      { t: 1.0, q: 4, ff: 0 },
      { t: 1.5, q: 4, ff: 0 },
      { t: 2.0, q: 9, ff: 0 },
      { t: 2.5, q: 8, ff: 0 },
      { t: 3.0, q: 8, ff: 0 },
      { t: 3.5, q: 8, ff: 0 },
      { t: 4.0, q: 8, ff: 0 },
      { t: 4.5, q: 8, ff: 0 },
      { t: 5.0, q: 8, ff: 0 },
      { t: 5.5, q: 8, ff: 0 },
      { t: 6.0, q: 8, ff: 0 },
      { t: 6.5, q: 9, ff: 0 },
      { t: 7.1, q: 9, ff: 0 },
      { t: 7.6, q: 8, ff: 0 },
      { t: 8.1, q: 9, ff: 0 },
      { t: 8.6, q: 9, ff: 0 },
      { t: 9.1, q: 9, ff: 0 },
      { t: 9.6, q: 9, ff: 0 },
      { t: 10.1, q: 9, ff: 0 },
      { t: 10.6, q: 9, ff: 0 },
      { t: 11.1, q: 9, ff: 0 },
      { t: 11.6, q: 9, ff: 1 },
      { t: 12.1, q: 9, ff: 1 },
    ],
  },
};

const FFMPEG_BENCHMARKS = [
  { label: '3 × 0.6s（總長 1.8s）', reencodeMs: 107.2, copyMs: 89.0, speedup: '1.20×' },
  { label: '3 × 3.0s（總長 9.0s）', reencodeMs: 133.7, copyMs: 85.7, speedup: '1.56×' },
  { label: '3 × 10.0s（總長 30.0s）', reencodeMs: 229.8, copyMs: 99.3, speedup: '2.31×' },
];

const TTS_WAIT_COMPARISON = [
  { label: 'S2 純語音（W=1）', calls: 69, avgMs: 151.5, p50Ms: 175.0, p95Ms: 242.5 },
  { label: 'S2b 純語音（W=3）', calls: 212, avgMs: 161.3, p50Ms: 178.3, p95Ms: 248.8 },
  { label: 'S3b 混合負載（W=3）', calls: 199, avgMs: 178.4, p50Ms: 181.1, p95Ms: 334.2 },
];

const EXPRESS_PROBES = [
  { endpoint: 'GET /health', requests: 45, qps: '5.26', avgMs: '52.9', p50Ms: '17.0', p95Ms: '200.0', maxMs: '218.3', status: '修復後 P95 → 11.0 ms (-94.5%)' },
  { endpoint: 'GET /metrics', requests: 46, qps: '5.38', avgMs: '46.9', p50Ms: '11.0', p95Ms: '220.0', maxMs: '313.2', status: '修復後 P95 → 12.0 ms (-94.5%)' },
  { endpoint: 'GET /ready', requests: 2, qps: '0.23', avgMs: '7,527.0', p50Ms: '7,800.0', p95Ms: '7,800.0', maxMs: '7,806.8', status: '修復後 P95 → 18.0 ms (112× QPS)' },
];

const BEFORE_AFTER_ROWS = [
  { metric: 'S1 純文字 QPS（10u）', before: '7.95 req/s', after: '29.47 req/s', delta: '+270.7% (3.71×)' },
  { metric: 'S1 純文字 P50 / P95', before: '1,100 / 1,200 ms', after: '210 / 290 ms', delta: 'P95 -75.8%' },
  { metric: 'S2 純語音 QPS（10u）', before: '1.98 req/s', after: '6.82 req/s', delta: '+244.4% (3.44×)' },
  { metric: 'S2 純語音 P50 / P95', before: '4,600 / 4,900 ms', after: '1,200 / 1,500 ms', delta: 'P95 -69.4%' },
  { metric: 'S3 混合有效 QPS（12u）', before: '2.43 req/s', after: '12.77 req/s', delta: '+425.5% (5.26×)' },
  { metric: 'S3 混合 429 失敗率', before: '81.9% (154/188)', after: '0.0% (0/137)', delta: '徹底歸零' },
  { metric: 'S3 混合文字 P95（PriorityQueue）', before: '3,500 ms', after: '550 ms', delta: '-84.3%' },
  { metric: 'S3 混合 tts_wait P95', before: '334.2 ms (TTS=3)', after: '245.0 ms (TTS=8)', delta: '-26.7%' },
  { metric: 'S4 Express 總 QPS（20u）', before: '10.87 req/s', after: '176.05 req/s', delta: '+1,520% (16.2×)' },
  { metric: 'S4 GET /ready P50 / P95', before: '7,800 / 7,800 ms', after: '4.0 / 18.0 ms', delta: 'P95 -99.77%' },
];

interface BottleneckItem {
  id: string;
  tier: 'P0' | 'P1' | 'P2' | 'ruled_out';
  verdict: string;
  verdictClass: string;
  component: string;
  evidence: string;
  recommendation: string;
  expectedImpact: string;
}

const BOTTLENECKS: BottleneckItem[] = [
  {
    id: 'b1',
    tier: 'P0',
    verdict: '首要瓶頸 · P0',
    verdictClass: 'text-red-700',
    component: 'BOT_WORKERS=1 與單一 FIFO 佇列（BOT_QUEUE_MAXSIZE=10）',
    evidence:
      '純語音 QPS 被鎖死在 1.98 req/s；混合負載 1 秒打滿佇列、81.9% 請求 429 拒絕，快速文字遭語音隊頭阻塞（P95 飆升至 3,500 ms）。擴容至 W=3 / Q=30 後有效 QPS 躍升 4.0×、失敗率歸零。',
    recommendation:
      '2 vCPU 環境調高預設併發至 BOT_WORKERS=4、CONCURRENT_UPDATES=4、BOT_QUEUE_MAXSIZE=32。',
    expectedImpact: '混合有效 QPS +300%，消除突發流量 429 拒絕風暴',
  },
  {
    id: 'b2',
    tier: 'P0',
    verdict: 'Web 層瓶頸 · P0',
    verdictClass: 'text-red-700',
    component: 'Express GET /ready 無快取直接 spawn(python3 bot_bridge.py status)',
    evidence:
      '空載單次 Python 子行程啟動耗時 126.3 ms（/ready 898.6 ms）；20 併發壓測下暴增至 7,806.8 ms（0.23 req/s），並連帶拖慢 /health 與 /metrics P95 至 200–220 ms。',
    recommendation:
      '為 /ready 加入 10–15 秒 TTL 結果快取與 Single-Flight 共享 Promise，避免併發探活觸發子行程風暴。',
    expectedImpact: '/ready 20 併發 P95 由 7,800 ms 降至 <15 ms（-99.8%）',
  },
  {
    id: 'b3',
    tier: 'P1',
    verdict: '擴容後次級瓶頸 · P1',
    verdictClass: 'text-amber-700',
    component: '文字與語音共用單一 FIFO 佇列（Head-of-Line Blocking）',
    evidence:
      '即使在 W=3 混合負載下，120 ms 的文字任務仍因排在語音任務後方導致 P50 達 870 ms、P95 達 1,300 ms。',
    recommendation:
      '將 WorkerPool 拆分為快速文字佇列與語音佇列，或以 asyncio.PriorityQueue 優先調度文字請求。',
    expectedImpact: '文字延遲與語音解耦，穩定維持於 LLM 單輪等級',
  },
  {
    id: 'b4',
    tier: 'P1',
    verdict: '擴容後次級瓶頸 · P1',
    verdictClass: 'text-amber-700',
    component: '全域 TTS_CONCURRENCY=3 信號量與外部 API 延遲（4.0s–13.9s）',
    evidence:
      'Worker 增至 3 後，tts_wait_p95 立即從 242.5 ms 跳升至 334.2 ms（+37.8%）；實機真實 Gemini + Edge-TTS 單次即需 4,021 ms–13,961 ms。',
    recommendation:
      '將 TTS_CONCURRENCY 改為環境變數（預設 BOT_WORKERS × 2），搭配 Provider 速率控制與常用短語音 LRU 快取。',
    expectedImpact: '降低多 Worker TTS 排隊尾延遲並防止上游 429 限流',
  },
  {
    id: 'b5',
    tier: 'P1',
    verdict: '擴容後次級瓶頸 · P1',
    verdictClass: 'text-amber-700',
    component: 'ffmpeg 全域單鎖（Semaphore(1)）＋ libmp3lame 全量重編碼',
    evidence:
      'W=3 混合負載已出現 ffmpeg_queue_length = 2 排隊；30 秒語音拼接實測重編碼耗時 229.8 ms，改用 -c copy 僅需 99.3 ms（2.31× 加速）。',
    recommendation:
      '優先以 -c copy 無損拼接（失敗再降級 libmp3lame），並將 _ffmpeg_semaphore 改為 max(1, cpu_count // 2)。',
    expectedImpact: '30 秒音訊拼接耗時 -57%，解除單鎖併發排隊',
  },
  {
    id: 'b6',
    tier: 'P2',
    verdict: '長期優化 · P2',
    verdictClass: 'text-blue-700',
    component: 'Express Web Bridge 常駐化與 Redis 熔斷期滿 Single-Flight 探測',
    evidence:
      '每次呼叫 bot_bridge.py 需 ~126 ms 冷啟動；Redis 30 秒熔斷期滿瞬間多個併發協程會同時撞擊失敗（實測 redis_failures_total = 1~5）。',
    recommendation:
      '改用常駐本地 HTTP / Unix Socket Python Daemon，並以單一探測鎖保護 Redis 熔斷恢復檢查。',
    expectedImpact: '省去每次請求 ~126 ms 冷啟動，消除 30 秒週期探測抖動',
  },
  {
    id: 'b7',
    tier: 'ruled_out',
    verdict: '已排除 · 非瓶頸',
    verdictClass: 'text-emerald-700',
    component: 'CPU 算力 / 記憶體（RAM） / Redis Fail-Open 配額',
    evidence:
      '全場 6 組壓測 Peak CPU 僅 9.9%–37.8%（2 vCPU）、RSS 穩定於 68.4–77.2 MB；Redis 具備 30 秒 Fail-Open 熔斷，降級後零延遲。',
    recommendation:
      '無需急於升級硬體規格，優先從併發與架構參數釋放現有 60%+ 閒置算力即可獲得 3×–4× 吞吐提升。',
    expectedImpact: '零硬體成本達成 3×–4× 擴容效益',
  },
];

const RECOMMENDED_ENV_SNIPPET = `# 建議配置（2 vCPU / 4 GB RAM）
BOT_WORKERS=4
CONCURRENT_UPDATES=4
BOT_QUEUE_MAXSIZE=32

# Prometheus 建議告警規則
# 1. 佇列飽和：queue_depth / BOT_QUEUE_MAXSIZE > 0.8 持續 15s
# 2. TTS 排隊：histogram_quantile(0.95, rate(tts_wait_seconds_bucket[5m])) > 2.0
# 3. ffmpeg 阻塞：ffmpeg_queue_length >= 2 持續 10s
# 4. Redis 異常：increase(redis_failures_total[5m]) > 0`;

export function LoadTestReportPanel() {
  const [viewMode, setViewMode] = useState<ViewMode>('visual');
  const [configFilter, setConfigFilter] = useState<ConfigFilter>('all');
  const [selectedSeries, setSelectedSeries] = useState<ChartSeriesKey>('s3_mixed_w1');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [copiedKey, setCopiedKey] = useState<'env' | 'md' | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [pdfExported, setPdfExported] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const visibleScenarios = useMemo(() => {
    if (configFilter === 'all') return SCENARIO_ROWS;
    return SCENARIO_ROWS.filter((row) => row.group === configFilter);
  }, [configFilter]);

  const visibleBottlenecks = useMemo(() => {
    if (priorityFilter === 'all') return BOTTLENECKS;
    return BOTTLENECKS.filter((item) => item.tier === priorityFilter);
  }, [priorityFilter]);

  const currentSeries = QUEUE_SERIES[selectedSeries];

  const handleCopyText = async (text: string, key: 'env' | 'md') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleDownloadMarkdown = () => {
    const blob = new Blob([rawReportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'LOAD_TEST_REPORT.md';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleExportPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    setPdfError(null);
    try {
      const configLabel =
        configFilter === 'all'
          ? '全部場景'
          : configFilter === 'default'
            ? '預設 W=1 / Q=10'
            : '對照 W=3 / Q=30';
      const priorityLabel =
        priorityFilter === 'all'
          ? '全部優先級'
          : priorityFilter === 'ruled_out'
            ? '已排除項目'
            : `${priorityFilter} 優先級`;

      await exportLoadTestReportPdf({
        filterSummary: `場景篩選：${configLabel} · 瓶頸篩選：${priorityLabel}`,
        scenarios: visibleScenarios,
        selectedSeries: currentSeries,
        ttsRows: TTS_WAIT_COMPARISON,
        ffmpegRows: FFMPEG_BENCHMARKS,
        expressRows: EXPRESS_PROBES,
        beforeAfterRows: BEFORE_AFTER_ROWS,
        bottlenecks: visibleBottlenecks,
        recommendedEnvSnippet: RECOMMENDED_ENV_SNIPPET,
      });
      setPdfExported(true);
      window.setTimeout(() => setPdfExported(false), 2400);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'PDF 匯出失敗，請稍後再試');
    } finally {
      setExportingPdf(false);
    }
  };

  // SVG chart geometry
  const chartW = 760;
  const chartH = 220;
  const padL = 42;
  const padR = 20;
  const padT = 18;
  const padB = 30;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const maxT = currentSeries.points[currentSeries.points.length - 1]?.t || 15;
  const xOf = (t: number) => padL + (t / maxT) * plotW;
  const yOf = (q: number) => padT + plotH - (q / currentSeries.yMax) * plotH;

  const polylinePoints = currentSeries.points
    .map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.q).toFixed(1)}`)
    .join(' ');
  const areaPath =
    currentSeries.points.length > 0
      ? `M ${xOf(currentSeries.points[0].t).toFixed(1)},${(padT + plotH).toFixed(1)} ` +
        currentSeries.points
          .map((p) => `L ${xOf(p.t).toFixed(1)},${yOf(p.q).toFixed(1)}`)
          .join(' ') +
        ` L ${xOf(currentSeries.points[currentSeries.points.length - 1].t).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
      : '';

  const hoveredPoint =
    hoveredIndex !== null ? currentSeries.points[hoveredIndex] ?? null : null;

  return (
    <div className="space-y-6">
      {/* Page Header & Actions */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              系統壓力測試與瓶頸分析報告
            </h1>
            <p className="mt-1.5 text-sm sm:text-base text-slate-600">
              使用 Locust 2.47.0 壓測真實 WorkerPool、ffmpeg 拼接、Redis 配額與實機 Express HTTP
              端點，完整量化純文字、純語音與混合負載下的效能瓶頸與擴容收益。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
              <span>2 vCPU · 4,096 MB RAM</span>
              <span aria-hidden="true">/</span>
              <span>Linux 4.19 (gVisor)</span>
              <span aria-hidden="true">/</span>
              <span>Python 3.11.2 · Node v22.23.2 · ffmpeg 4.4.2</span>
              <span aria-hidden="true">/</span>
              <span>LLM 120ms · STT 100ms · TTS 150ms</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <div
              role="tablist"
              aria-label="報告顯示模式"
              className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'visual'}
                onClick={() => setViewMode('visual')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === 'visual'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>圖表報告</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'markdown'}
                onClick={() => setViewMode('markdown')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === 'markdown'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Markdown 原文</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => void handleCopyText(rawReportMarkdown, 'md')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedKey === 'md' ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
              )}
              <span>{copiedKey === 'md' ? '已複製 Markdown' : '複製 Markdown'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadMarkdown}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <Download className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
              <span>下載 .md</span>
            </button>

            <button
              type="button"
              onClick={() => void handleExportPdf()}
              disabled={exportingPdf}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
            >
              {pdfExported ? (
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <FileDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>
                {exportingPdf ? '正在匯出 PDF...' : pdfExported ? '已匯出 PDF' : '匯出 PDF 報告'}
              </span>
            </button>
          </div>
        </div>

        {pdfError && (
          <div
            role="alert"
            className="mt-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-800"
          >
            PDF 匯出發生錯誤：{pdfError}
          </div>
        )}

        {/* 4-Column Executive KPI Strip (hairline divided, single elevation) */}
        <div className="mt-6 pt-5 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-0 lg:divide-x lg:divide-slate-200">
          <div className="lg:pr-6">
            <p className="text-xs font-medium text-slate-500">純文字單 Worker 吞吐量</p>
            <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              7.95 <span className="text-sm font-normal text-slate-500">req/s</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              P50 1,100 ms · P95 1,200 ms · 0% 失敗
            </p>
          </div>

          <div className="lg:px-6">
            <p className="text-xs font-medium text-slate-500">純語音吞吐（W=1 → W=3）</p>
            <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              1.98 <span className="text-slate-400 font-normal">→</span> 5.89{' '}
              <span className="text-sm font-normal text-emerald-700">+197%</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              P95 延遲 4,900 → 1,600 ms（-67.3%）
            </p>
          </div>

          <div className="lg:px-6">
            <p className="text-xs font-medium text-slate-500">混合負載拒絕率（W=1 → W=3）</p>
            <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              81.9% <span className="text-slate-400 font-normal">→</span>{' '}
              <span className="text-emerald-700">0.0%</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              有效成功 QPS 2.43 → 9.70 req/s（4.0×）
            </p>
          </div>

          <div className="lg:pl-6">
            <p className="text-xs font-medium text-slate-500">實機 Express /ready 20 併發</p>
            <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-red-700">
              7,800 <span className="text-sm font-normal text-slate-500">ms P95</span>
            </p>
            <p className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
              每次無快取 spawn python3 · Peak CPU 37.8%
            </p>
          </div>
        </div>
      </section>

      {viewMode === 'markdown' ? (
        <section
          aria-label="Markdown 報告原文"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="text-sm font-semibold text-slate-900 font-mono">
              LOAD_TEST_REPORT.md
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {rawReportMarkdown.split('\n').length} lines ·{' '}
              {(new Blob([rawReportMarkdown]).size / 1024).toFixed(1)} KB
            </div>
          </div>
          <pre className="p-6 overflow-x-auto text-xs sm:text-sm leading-relaxed text-slate-800 bg-slate-50/60 whitespace-pre-wrap font-mono">
            {rawReportMarkdown}
          </pre>
        </section>
      ) : (
        <>
          {/* Section 1: Core Scenario Data Table */}
          <section
            aria-label="核心場景實測數據"
            className="bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  01. 核心場景壓測數據總表（Locust 實測）
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  包含預設單 Worker 配置（W=1, Q=10）與瓶頸隔離擴容對照組（W=3, Q=30）。
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
                {(
                  [
                    { id: 'all', label: '全部場景' },
                    { id: 'default', label: '預設 W=1 / Q=10' },
                    { id: 'scaled', label: '對照 W=3 / Q=30' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setConfigFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      configFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                    <th className="py-3 pl-6 pr-3 whitespace-nowrap">場景 / 配置</th>
                    <th className="py-3 px-3 whitespace-nowrap">併發</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">總數 / 失敗</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">有效 QPS</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Avg (ms)</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">P50 (ms)</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">P95 (ms)</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">P99 (ms)</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Queue 峰/均</th>
                    <th className="py-3 pl-3 pr-6 text-right whitespace-nowrap">Peak CPU / RSS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleScenarios.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3.5 pl-6 pr-3">
                        <div className="font-medium text-slate-900 whitespace-nowrap">
                          {row.name}
                        </div>
                        <div className="text-xs text-slate-500 font-mono">
                          {row.config}
                          {row.note ? ` · ${row.note}` : ''}
                        </div>
                      </td>
                      <td className="py-3.5 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.load}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className="text-slate-900">{row.requests}</span>
                        <span className="text-slate-400"> / </span>
                        <span
                          className={
                            row.failures > 0 ? 'font-semibold text-red-700' : 'text-emerald-700'
                          }
                        >
                          {row.failures} ({row.failureRate})
                        </span>
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {row.effectiveQps}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.avgMs}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.p50Ms}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                        {row.p95Ms}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.p99Ms}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.queuePeakAvg}
                      </td>
                      <td className="py-3.5 pl-3 pr-6 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {row.cpuRss}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-3 bg-slate-50/70 border-t border-slate-200 text-xs text-slate-600">
              * 註：S3 混合負載有 81.9% 請求於入隊時立即回傳 HTTP 429 QueueFull（約 7–8 ms），拉低表觀 Avg/P50；實際成功完成的 34 筆請求中，文字 P95 達 3,500 ms（P99 3,900 ms）、語音 P95 達 3,800 ms（P99 4,300 ms）。
            </div>
          </section>

          {/* Section 2: Queue Depth Interactive Time-Series Chart */}
          <section
            aria-label="佇列深度時間序列變化"
            className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6"
          >
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  02. 佇列深度（queue_depth）與 ffmpeg 排隊時間序列
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  {currentSeries.subtitle}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
                {(Object.keys(QUEUE_SERIES) as ChartSeriesKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSelectedSeries(key);
                      setHoveredIndex(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedSeries === key
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {QUEUE_SERIES[key].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Interactive SVG Chart */}
            <div className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums mb-2">
                <div className="flex flex-wrap items-center gap-4">
                  <span>實線：queue_depth（每 0.5 秒採樣）</span>
                  <span>橘點：ffmpeg_queue_length &gt;= 1</span>
                  {currentSeries.maxQueue <= currentSeries.yMax && (
                    <span className="text-red-700">
                      虛線：BOT_QUEUE_MAXSIZE = {currentSeries.maxQueue}（滿載拒絕線）
                    </span>
                  )}
                </div>
                <div className="text-slate-700 font-medium">
                  {hoveredPoint
                    ? `t = ${hoveredPoint.t.toFixed(1)}s · queue_depth = ${hoveredPoint.q} · ffmpeg_queue = ${hoveredPoint.ff}`
                    : '移動滑鼠至曲線節點可檢視精確數值'}
                </div>
              </div>

              <div className="w-full overflow-x-auto">
                <svg
                  viewBox={`0 0 ${chartW} ${chartH}`}
                  className="w-full min-w-[560px] h-auto select-none"
                  role="img"
                  aria-label={`${currentSeries.label} 佇列深度變化曲線`}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  {/* Horizontal grid lines */}
                  {[0, 3, 6, 9, 10, 12].map((val) => {
                    const y = yOf(val);
                    const isLimit = val === currentSeries.maxQueue;
                    return (
                      <g key={val}>
                        <line
                          x1={padL}
                          x2={chartW - padR}
                          y1={y}
                          y2={y}
                          stroke={isLimit ? '#DC2626' : '#E2E8F0'}
                          strokeWidth={isLimit ? 1.25 : 1}
                          strokeDasharray={isLimit ? '5 4' : undefined}
                        />
                        <text
                          x={padL - 8}
                          y={y + 3.5}
                          textAnchor="end"
                          fontSize="10"
                          fill={isLimit ? '#B91C1C' : '#64748B'}
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {val}
                        </text>
                      </g>
                    );
                  })}

                  {/* X-axis ticks */}
                  {[0, 3, 6, 9, 12, Math.round(maxT)].map((sec) => {
                    const clamped = Math.min(sec, maxT);
                    const x = xOf(clamped);
                    return (
                      <text
                        key={sec}
                        x={x}
                        y={chartH - 8}
                        textAnchor="middle"
                        fontSize="10"
                        fill="#64748B"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {clamped}s
                      </text>
                    );
                  })}

                  {/* Area under curve */}
                  <path d={areaPath} fill={currentSeries.accentColor} fillOpacity="0.10" />

                  {/* Queue depth line */}
                  <polyline
                    fill="none"
                    stroke={currentSeries.accentColor}
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    points={polylinePoints}
                  />

                  {/* Points & ffmpeg indicators */}
                  {currentSeries.points.map((pt, idx) => {
                    const cx = xOf(pt.t);
                    const cy = yOf(pt.q);
                    const isHovered = hoveredIndex === idx;
                    return (
                      <g key={pt.t}>
                        {pt.ff > 0 && (
                          <circle
                            cx={cx}
                            cy={yOf(pt.ff)}
                            r={pt.ff >= 2 ? 5 : 3.5}
                            fill="#D97706"
                            stroke="#FFFFFF"
                            strokeWidth="1.2"
                          />
                        )}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isHovered ? 5 : 2.8}
                          fill={isHovered ? '#0F172A' : currentSeries.accentColor}
                          stroke="#FFFFFF"
                          strokeWidth="1.2"
                        />
                        {/* Invisible wide hit target for smooth hover */}
                        <rect
                          x={cx - 10}
                          y={padT}
                          width={20}
                          height={plotH}
                          fill="transparent"
                          className="cursor-crosshair"
                          onMouseEnter={() => setHoveredIndex(idx)}
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          </section>

          {/* Section 3: Side-by-Side TTS Wait & ffmpeg Micro-Benchmark */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* TTS Wait Distribution */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  03. TTS 排隊等待時間（tts_wait_seconds）
                </h2>
                <p className="mt-1 text-xs sm:text-sm text-slate-600">
                  基準單次 TTS 耗時 150 ms。W=1 時無爭用；W=3 時 3 個 Worker 共用全域{' '}
                  <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">
                    TTS_CONCURRENCY=3
                  </code>
                  ，P95 立即上升 +37.8%。
                </p>

                <div className="mt-5 space-y-4">
                  {TTS_WAIT_COMPARISON.map((row) => {
                    const avgPct = Math.min(100, (row.avgMs / 360) * 100);
                    const p95Pct = Math.min(100, (row.p95Ms / 360) * 100);
                    return (
                      <div key={row.label} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-slate-900">{row.label}</span>
                          <span className="font-mono tabular-nums text-slate-600">
                            {row.calls} calls · Avg {row.avgMs.toFixed(1)} ms · P95{' '}
                            <strong className="text-slate-900">{row.p95Ms.toFixed(1)} ms</strong>
                          </span>
                        </div>
                        <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden relative">
                          <div
                            className="h-full bg-amber-300/80 rounded-full absolute inset-y-0 left-0"
                            style={{ width: `${p95Pct}%` }}
                          />
                          <div
                            className="h-full bg-blue-600 rounded-full absolute inset-y-0 left-0"
                            style={{ width: `${avgPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-mono">
                <span>深藍：Avg 等待 · 琥珀：P95 等待</span>
                <span>全域鎖：Semaphore(3)</span>
              </div>
            </div>

            {/* ffmpeg Re-encode vs Stream Copy Benchmark */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  04. ffmpeg 拼接微基準：重編碼 vs -c copy
                </h2>
                <p className="mt-1 text-xs sm:text-sm text-slate-600">
                  現況使用{' '}
                  <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">
                    -c:a libmp3lame -q:a 4
                  </code>{' '}
                  全量重編碼並持全域單鎖；改用無損{' '}
                  <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">
                    -c copy
                  </code>{' '}
                  可隨音長放大加速至 2.31×。
                </p>

                <div className="mt-5 space-y-4">
                  {FFMPEG_BENCHMARKS.map((item) => {
                    const reencPct = Math.min(100, (item.reencodeMs / 250) * 100);
                    const copyPct = Math.min(100, (item.copyMs / 250) * 100);
                    return (
                      <div key={item.label} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-slate-900">{item.label}</span>
                          <span className="font-mono tabular-nums text-slate-600">
                            重編碼 {item.reencodeMs} ms vs copy{' '}
                            <strong className="text-emerald-700">{item.copyMs} ms</strong>（
                            {item.speedup}）
                          </span>
                        </div>
                        <div className="space-y-1">
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-slate-700 rounded-full"
                              style={{ width: `${reencPct}%` }}
                            />
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-600 rounded-full"
                              style={{ width: `${copyPct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-mono">
                <span>深灰：libmp3lame -q:a 4 · 翠綠：-c copy</span>
                <span>每組空載實測 4 次均值</span>
              </div>
            </div>
          </section>

          {/* Section 4: Live Express HTTP Probes & Upstream Latency */}
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 sm:px-6 py-4 border-b border-slate-200">
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  05. 實機 Express HTTP 端點壓測（S4 · 20 併發 / 10 秒）
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  直接對運行中的 Port 3000 發壓，暴露無快取 /ready 子行程風暴對整機尾延遲的影響。
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                      <th className="py-2.5 pl-6 pr-3">端點</th>
                      <th className="py-2.5 px-3 text-right">請求數</th>
                      <th className="py-2.5 px-3 text-right">QPS</th>
                      <th className="py-2.5 px-3 text-right">P50 (ms)</th>
                      <th className="py-2.5 px-3 text-right">P95 (ms)</th>
                      <th className="py-2.5 px-3 text-right">Max (ms)</th>
                      <th className="py-2.5 pl-3 pr-6">實測診斷</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {EXPRESS_PROBES.map((row) => {
                      const isCritical = row.endpoint === 'GET /ready';
                      return (
                        <tr key={row.endpoint} className="hover:bg-slate-50/70">
                          <td className="py-3 pl-6 pr-3 font-mono font-medium text-slate-900 whitespace-nowrap">
                            {row.endpoint}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                            {row.requests}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                            {row.qps}
                          </td>
                          <td
                            className={`py-3 px-3 text-right font-mono tabular-nums ${
                              isCritical ? 'font-semibold text-red-700' : 'text-slate-700'
                            }`}
                          >
                            {row.p50Ms}
                          </td>
                          <td
                            className={`py-3 px-3 text-right font-mono tabular-nums ${
                              isCritical ? 'font-semibold text-red-700' : 'text-slate-900'
                            }`}
                          >
                            {row.p95Ms}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                            {row.maxMs}
                          </td>
                          <td
                            className={`py-3 pl-3 pr-6 text-xs whitespace-nowrap ${
                              isCritical ? 'font-medium text-red-700' : 'text-slate-600'
                            }`}
                          >
                            {row.status}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  真實上游單輪校準
                </h2>
                <p className="mt-1 text-xs sm:text-sm text-slate-600">
                  單次實測真實外部 API 與 Python Bridge 啟動基準（HTTP 200）。
                </p>

                <dl className="mt-4 divide-y divide-slate-100 text-xs sm:text-sm">
                  <div className="py-3 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-600">純文字（Gemini 冷啟動首輪）</dt>
                    <dd className="font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                      13,960.7 ms
                    </dd>
                  </div>
                  <div className="py-3 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-600">語音回覆（Gemini + Edge-TTS）</dt>
                    <dd className="font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                      4,021.3 ms
                    </dd>
                  </div>
                  <div className="py-3 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-600">輸出語音檔大小</dt>
                    <dd className="font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      72,501 bytes
                    </dd>
                  </div>
                  <div className="py-3 flex items-baseline justify-between gap-3">
                    <dt className="text-slate-600">python3 bot_bridge.py status</dt>
                    <dd className="font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      126.3 ms（3 次均值）
                    </dd>
                  </div>
                </dl>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                結論：外部網路 I/O 佔總耗時 &gt;95%，屬典型 I/O-bound 工作負載。
              </p>
            </div>
          </section>

          {/* Section 5: Bottleneck Diagnosis & Optimization Roadmap */}
          <section
            aria-label="瓶頸定位與優化建議"
            className="bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  06. 瓶頸定位矩陣與優先級優化建議（P0 / P1 / P2）
                </h2>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                  逐項排除 CPU、記憶體與 Redis，聚焦真正限制系統吞吐量與尾延遲的關鍵元件。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
                {(
                  [
                    { id: 'all', label: '全部' },
                    { id: 'P0', label: 'P0 立即' },
                    { id: 'P1', label: 'P1 次級' },
                    { id: 'P2', label: 'P2 長期' },
                    { id: 'ruled_out', label: '已排除' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPriorityFilter(item.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      priorityFilter === item.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-200">
              {visibleBottlenecks.map((item) => (
                <div
                  key={item.id}
                  className="px-5 sm:px-6 py-4 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-6 items-start"
                >
                  <div className="lg:col-span-4 space-y-1">
                    <div className={`text-xs font-semibold font-mono ${item.verdictClass}`}>
                      {item.verdict}
                    </div>
                    <h3 className="text-sm font-semibold text-slate-900">{item.component}</h3>
                  </div>

                  <div className="lg:col-span-4 text-xs sm:text-sm text-slate-600 leading-relaxed">
                    <span className="font-medium text-slate-800">實測證據：</span>
                    {item.evidence}
                  </div>

                  <div className="lg:col-span-4 space-y-1 text-xs sm:text-sm">
                    <p className="text-slate-700 leading-relaxed">
                      <span className="font-medium text-slate-900">優化行動：</span>
                      {item.recommendation}
                    </p>
                    <p className="text-xs font-mono text-emerald-700">
                      預期收益：{item.expectedImpact}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Recommended Config & Alerting Snippet */}
            <div className="px-5 sm:px-6 py-5 bg-slate-50/70 border-t border-slate-200">
              <div className="flex items-center justify-between gap-4 mb-2.5">
                <h3 className="text-xs font-semibold text-slate-700">
                  建議生產環境設定與 Prometheus 告警規則
                </h3>
                <button
                  type="button"
                  onClick={() => void handleCopyText(RECOMMENDED_ENV_SNIPPET, 'env')}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedKey === 'env' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  )}
                  <span>{copiedKey === 'env' ? '已複製設定' : '複製設定'}</span>
                </button>
              </div>
              <pre className="p-4 rounded-lg bg-slate-900 text-slate-100 text-xs leading-relaxed overflow-x-auto font-mono">
                {RECOMMENDED_ENV_SNIPPET}
              </pre>
            </div>
          </section>
          {/* Section 6: Verified Post-Fix Before vs After Comparison */}
          <section
            aria-label="瓶頸修復前後實測驗證"
            className="bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                07. 瓶頸修復落地與前後實測驗證（Before vs After）
              </h2>
              <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
                已完成 6 項核心修復（W=4/Q=32、PriorityQueue、ffmpeg -c copy、TTS/FFMPEG 併發配置、Redis Single-Flight、Express /ready 10s TTL 快取），以相同 Locust 併發重跑實測。
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                    <th className="py-2.5 pl-6 pr-3">指標項目</th>
                    <th className="py-2.5 px-3 text-right">修復前（基準）</th>
                    <th className="py-2.5 px-3 text-right">修復後（實測）</th>
                    <th className="py-2.5 pl-3 pr-6 text-right">實測改善幅度</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {BEFORE_AFTER_ROWS.map((row) => (
                    <tr key={row.metric} className="hover:bg-slate-50/70">
                      <td className="py-3 pl-6 pr-3 font-medium text-slate-900 whitespace-nowrap">
                        {row.metric}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {row.before}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {row.after}
                      </td>
                      <td className="py-3 pl-3 pr-6 text-right font-mono tabular-nums font-semibold text-emerald-700 whitespace-nowrap">
                        {row.delta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
