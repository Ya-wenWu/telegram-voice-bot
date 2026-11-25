import { jsPDF } from 'jspdf';

export interface PdfScenarioRow {
  id: string;
  name: string;
  config: string;
  load: string;
  requests: number;
  failures: number;
  failureRate: string;
  effectiveQps: string;
  avgMs: string;
  p50Ms: string;
  p95Ms: string;
  p99Ms: string;
  queuePeakAvg: string;
  cpuRss: string;
}

export interface PdfQueueSeries {
  label: string;
  subtitle: string;
  maxQueue: number;
  yMax: number;
  accentColor: string;
  points: Array<{ t: number; q: number; ff: number }>;
}

export interface PdfTtsRow {
  label: string;
  calls: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PdfFfmpegRow {
  label: string;
  reencodeMs: number;
  copyMs: number;
  speedup: string;
}

export interface PdfExpressRow {
  endpoint: string;
  requests: number;
  qps: string;
  p50Ms: string;
  p95Ms: string;
  maxMs: string;
  status: string;
}

export interface PdfBeforeAfterRow {
  metric: string;
  before: string;
  after: string;
  delta: string;
}

export interface PdfBottleneckRow {
  tier: 'P0' | 'P1' | 'P2' | 'ruled_out';
  verdict: string;
  component: string;
  evidence: string;
  recommendation: string;
  expectedImpact: string;
}

export interface LoadTestPdfPayload {
  filterSummary: string;
  scenarios: PdfScenarioRow[];
  selectedSeries: PdfQueueSeries;
  ttsRows: PdfTtsRow[];
  ffmpegRows: PdfFfmpegRow[];
  expressRows: PdfExpressRow[];
  beforeAfterRows: PdfBeforeAfterRow[];
  bottlenecks: PdfBottleneckRow[];
  recommendedEnvSnippet: string;
}

const PAGE_W = 794;
const PAGE_H = 1123;
const SCALE = 2;
const MARGIN_X = 44;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const FOOTER_Y = PAGE_H - 36;
const CONTENT_BOTTOM = PAGE_H - 64;

const FONT_SANS =
  '"Plus Jakarta Sans", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';

class StyledPdfCanvasBuilder {
  private pages: HTMLCanvasElement[] = [];
  private ctx!: CanvasRenderingContext2D;
  public y = 0;
  private exportTimestamp: string;

  constructor(exportTimestamp: string) {
    this.exportTimestamp = exportTimestamp;
    this.addPage();
  }

  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W * SCALE;
    canvas.height = PAGE_H * SCALE;
    return canvas;
  }

  public addPage(): void {
    const canvas = this.createCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('無法建立 PDF 繪圖畫布');
    }
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    // Subtle running header on pages 2+
    if (this.pages.length > 0) {
      ctx.font = `500 9.5px ${FONT_SANS}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'left';
      ctx.fillText('系統壓力測試與瓶頸分析報告 · Web Voice Bot', MARGIN_X, 34);
      ctx.textAlign = 'right';
      ctx.fillText(`匯出時間：${this.exportTimestamp}`, PAGE_W - MARGIN_X, 34);
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN_X, 44);
      ctx.lineTo(PAGE_W - MARGIN_X, 44);
      ctx.stroke();
      this.y = 62;
    } else {
      this.y = 42;
    }

    this.pages.push(canvas);
    this.ctx = ctx;
  }

  public ensureSpace(neededHeight: number): void {
    if (this.y + neededHeight > CONTENT_BOTTOM) {
      this.addPage();
    }
  }

  public get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  public wrapText(text: string, maxWidth: number, font: string): string[] {
    const ctx = this.ctx;
    ctx.font = font;
    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (const para of paragraphs) {
      if (!para) {
        lines.push('');
        continue;
      }
      let current = '';
      for (const ch of para) {
        const candidate = current + ch;
        if (ctx.measureText(candidate).width > maxWidth && current.length > 0) {
          lines.push(current);
          current = ch;
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);
    }

    return lines;
  }

  public drawRoundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    fill?: string,
    stroke?: string,
    lineWidth = 1
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  public drawSectionHeader(title: string, subtitle?: string): void {
    const needed = subtitle ? 44 : 26;
    this.ensureSpace(needed + 20);

    const ctx = this.ctx;
    ctx.textAlign = 'left';
    ctx.font = `700 13.5px ${FONT_SANS}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(title, MARGIN_X, this.y + 13);

    if (subtitle) {
      ctx.font = `400 10px ${FONT_SANS}`;
      ctx.fillStyle = '#475569';
      const lines = this.wrapText(subtitle, CONTENT_W, `400 10px ${FONT_SANS}`);
      let sy = this.y + 28;
      for (const line of lines) {
        ctx.fillText(line, MARGIN_X, sy);
        sy += 14;
      }
      this.y = sy + 4;
    } else {
      this.y += 24;
    }
  }

  public finalizeAndSave(filename: string): void {
    const total = this.pages.length;

    // Stamp page footers onto each canvas
    this.pages.forEach((canvas, idx) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN_X, FOOTER_Y - 14);
      ctx.lineTo(PAGE_W - MARGIN_X, FOOTER_Y - 14);
      ctx.stroke();

      ctx.font = `400 9.5px ${FONT_SANS}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'left';
      ctx.fillText('Web Voice Bot · Locust 2.47.0 壓測與瓶頸驗證報告', MARGIN_X, FOOTER_Y);
      ctx.textAlign = 'right';
      ctx.fillText(`第 ${idx + 1} 頁 / 共 ${total} 頁`, PAGE_W - MARGIN_X, FOOTER_Y);
      ctx.restore();
    });

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    this.pages.forEach((canvas, idx) => {
      if (idx > 0) doc.addPage();
      const imgData = canvas.toDataURL('image/jpeg', 0.94);
      doc.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    });

    doc.save(filename);
  }
}

function tierColor(tier: PdfBottleneckRow['tier']): string {
  switch (tier) {
    case 'P0':
      return '#B91C1C';
    case 'P1':
      return '#B45309';
    case 'P2':
      return '#1D4ED8';
    default:
      return '#047857';
  }
}

export async function exportLoadTestReportPdf(payload: LoadTestPdfPayload): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const now = new Date();
  const exportTimestamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`;

  const builder = new StyledPdfCanvasBuilder(exportTimestamp);
  const ctx = () => builder.context;

  // =========================================================================
  // Cover Header Block (Page 1)
  // =========================================================================
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, 114, 10, '#F8FAFC', '#CBD5E1', 1);

  ctx().textAlign = 'left';
  ctx().font = `700 20px ${FONT_SANS}`;
  ctx().fillStyle = '#0F172A';
  ctx().fillText('系統壓力測試與瓶頸分析報告', MARGIN_X + 20, builder.y + 32);

  ctx().font = `400 10.5px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  const introLines = builder.wrapText(
    '使用 Locust 2.47.0 壓測真實 WorkerPool、ffmpeg 拼接、Redis 配額與實機 Express HTTP 端點，完整量化純文字、純語音與混合負載下的效能瓶頸、擴容收益與修復前後對照。',
    CONTENT_W - 40,
    `400 10.5px ${FONT_SANS}`
  );
  let introY = builder.y + 52;
  for (const line of introLines) {
    ctx().fillText(line, MARGIN_X + 20, introY);
    introY += 15;
  }

  ctx().font = `400 9.5px ${FONT_MONO}`;
  ctx().fillStyle = '#64748B';
  ctx().fillText(
    `測試環境：2 vCPU · 4,096 MB RAM · Python 3.11.2 · Node v22.23.2 · ffmpeg 4.4.2`,
    MARGIN_X + 20,
    builder.y + 92
  );
  ctx().fillText(
    `匯出時間：${exportTimestamp}  |  ${payload.filterSummary}`,
    MARGIN_X + 20,
    builder.y + 106
  );

  builder.y += 128;

  // =========================================================================
  // 4-Column Executive KPI Strip
  // =========================================================================
  const kpiH = 74;
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, kpiH, 8, '#FFFFFF', '#E2E8F0', 1);
  const kpis = [
    {
      label: '純文字單 Worker 吞吐',
      value: '7.95 req/s',
      sub: 'P50 1,100 / P95 1,200 ms',
      valueColor: '#0F172A',
    },
    {
      label: '純語音擴容（W=1→3）',
      value: '1.98 → 5.89',
      sub: '+197% · P95 -67.3%',
      valueColor: '#047857',
    },
    {
      label: '混合負載 429 拒絕率',
      value: '81.9% → 0.0%',
      sub: '有效 QPS 2.43 → 9.70 (4×)',
      valueColor: '#047857',
    },
    {
      label: '實機 /ready 修復前後',
      value: '7,800 → 18 ms',
      sub: 'P95 -99.77% · 10s TTL',
      valueColor: '#2563EB',
    },
  ];
  const colW = CONTENT_W / 4;
  kpis.forEach((k, i) => {
    const x = MARGIN_X + i * colW;
    if (i > 0) {
      ctx().strokeStyle = '#E2E8F0';
      ctx().lineWidth = 1;
      ctx().beginPath();
      ctx().moveTo(x, builder.y + 12);
      ctx().lineTo(x, builder.y + kpiH - 12);
      ctx().stroke();
    }
    ctx().textAlign = 'left';
    ctx().font = `500 9.5px ${FONT_SANS}`;
    ctx().fillStyle = '#64748B';
    ctx().fillText(k.label, x + 12, builder.y + 22);

    ctx().font = `700 14px ${FONT_MONO}`;
    ctx().fillStyle = k.valueColor;
    ctx().fillText(k.value, x + 12, builder.y + 44);

    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#475569';
    ctx().fillText(k.sub, x + 12, builder.y + 61);
  });

  builder.y += kpiH + 22;

  // =========================================================================
  // Section 01: Core Scenario Data Table
  // =========================================================================
  builder.drawSectionHeader(
    '01. 核心場景壓測數據總表（Locust 實測）',
    '涵蓋預設單 Worker 配置（W=1, Q=10）與瓶頸隔離擴容對照組（W=3, Q=30）。'
  );

  const sCols = [
    { label: '場景 / 配置', x: 0, w: 174, align: 'left' as const },
    { label: '併發', x: 174, w: 66, align: 'left' as const },
    { label: '總數/失敗', x: 240, w: 88, align: 'right' as const },
    { label: '有效QPS', x: 328, w: 62, align: 'right' as const },
    { label: 'Avg(ms)', x: 390, w: 58, align: 'right' as const },
    { label: 'P50(ms)', x: 448, w: 56, align: 'right' as const },
    { label: 'P95(ms)', x: 504, w: 56, align: 'right' as const },
    { label: 'Queue峰/均', x: 560, w: 66, align: 'right' as const },
    { label: 'CPU/RSS', x: 626, w: 80, align: 'right' as const },
  ];

  const rowH = 30;
  const headerH = 26;
  const tableTotalH = headerH + payload.scenarios.length * rowH;
  builder.ensureSpace(tableTotalH + 26);

  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, tableTotalH, 6, '#FFFFFF', '#CBD5E1', 1);
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, headerH, 6, '#F1F5F9');

  ctx().font = `600 9px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  sCols.forEach((col) => {
    ctx().textAlign = col.align;
    const tx = col.align === 'right' ? MARGIN_X + col.x + col.w - 6 : MARGIN_X + col.x + 8;
    ctx().fillText(col.label, tx, builder.y + 16);
  });

  payload.scenarios.forEach((row, idx) => {
    const ry = builder.y + headerH + idx * rowH;
    if (idx % 2 === 1) {
      ctx().fillStyle = '#F8FAFC';
      ctx().fillRect(MARGIN_X + 1, ry, CONTENT_W - 2, rowH);
    }
    ctx().strokeStyle = '#E2E8F0';
    ctx().lineWidth = 0.75;
    ctx().beginPath();
    ctx().moveTo(MARGIN_X, ry);
    ctx().lineTo(MARGIN_X + CONTENT_W, ry);
    ctx().stroke();

    // Name + Config
    ctx().textAlign = 'left';
    ctx().font = `600 9.5px ${FONT_SANS}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(row.name, MARGIN_X + 8, ry + 13);
    ctx().font = `400 8.5px ${FONT_MONO}`;
    ctx().fillStyle = '#64748B';
    ctx().fillText(row.config, MARGIN_X + 8, ry + 24);

    // Numeric columns
    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#334155';
    ctx().fillText(row.load, MARGIN_X + sCols[1].x + 8, ry + 18);

    ctx().textAlign = 'right';
    ctx().fillStyle = row.failures > 0 ? '#B91C1C' : '#047857';
    ctx().font = `${row.failures > 0 ? 600 : 400} 8.8px ${FONT_MONO}`;
    ctx().fillText(
      `${row.requests}/${row.failures} (${row.failureRate})`,
      MARGIN_X + sCols[2].x + sCols[2].w - 6,
      ry + 18
    );

    ctx().fillStyle = '#0F172A';
    ctx().font = `700 9px ${FONT_MONO}`;
    ctx().fillText(row.effectiveQps, MARGIN_X + sCols[3].x + sCols[3].w - 6, ry + 18);

    ctx().fillStyle = '#334155';
    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillText(row.avgMs, MARGIN_X + sCols[4].x + sCols[4].w - 6, ry + 18);
    ctx().fillText(row.p50Ms, MARGIN_X + sCols[5].x + sCols[5].w - 6, ry + 18);

    ctx().fillStyle = '#0F172A';
    ctx().font = `600 8.8px ${FONT_MONO}`;
    ctx().fillText(row.p95Ms, MARGIN_X + sCols[6].x + sCols[6].w - 6, ry + 18);

    ctx().fillStyle = '#475569';
    ctx().font = `400 8.5px ${FONT_MONO}`;
    ctx().fillText(row.queuePeakAvg, MARGIN_X + sCols[7].x + sCols[7].w - 6, ry + 18);
    ctx().fillText(row.cpuRss, MARGIN_X + sCols[8].x + sCols[8].w - 6, ry + 18);
  });

  builder.y += tableTotalH + 12;

  ctx().textAlign = 'left';
  ctx().font = `400 8.5px ${FONT_SANS}`;
  ctx().fillStyle = '#64748B';
  ctx().fillText(
    '* 註：S3 混合負載有 81.9% 請求於入隊時立即回傳 HTTP 429 QueueFull（約 7–8 ms），成功請求文字 P95 為 3,500 ms、語音 P95 為 3,800 ms。',
    MARGIN_X,
    builder.y
  );
  builder.y += 22;

  // =========================================================================
  // Section 02: Queue Depth Time-Series Vector Chart
  // =========================================================================
  builder.ensureSpace(240);
  builder.drawSectionHeader(
    `02. 佇列深度時間序列 — ${payload.selectedSeries.label}`,
    payload.selectedSeries.subtitle
  );

  const chartBoxH = 186;
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, chartBoxH, 8, '#FFFFFF', '#CBD5E1', 1);

  const padL = 42;
  const padR = 20;
  const padT = 26;
  const padB = 28;
  const plotX = MARGIN_X + padL;
  const plotY = builder.y + padT;
  const plotW = CONTENT_W - padL - padR;
  const plotH = chartBoxH - padT - padB;
  const pts = payload.selectedSeries.points;
  const maxT = pts[pts.length - 1]?.t || 15;
  const yMax = payload.selectedSeries.yMax;

  const xOf = (t: number) => plotX + (t / maxT) * plotW;
  const yOf = (q: number) => plotY + plotH - (q / yMax) * plotH;

  // Legend
  ctx().textAlign = 'left';
  ctx().font = `400 8.8px ${FONT_MONO}`;
  ctx().fillStyle = '#475569';
  ctx().fillText('實線：queue_depth（0.5s 採樣）   橘點：ffmpeg_queue_length >= 1', plotX, builder.y + 16);
  if (payload.selectedSeries.maxQueue <= yMax) {
    ctx().textAlign = 'right';
    ctx().fillStyle = '#B91C1C';
    ctx().fillText(
      `紅色虛線：BOT_QUEUE_MAXSIZE = ${payload.selectedSeries.maxQueue}`,
      MARGIN_X + CONTENT_W - padR,
      builder.y + 16
    );
  }

  // Grid lines
  [0, 3, 6, 9, 10, 12].forEach((val) => {
    const gy = yOf(val);
    const isLimit = val === payload.selectedSeries.maxQueue;
    ctx().save();
    ctx().strokeStyle = isLimit ? '#DC2626' : '#E2E8F0';
    ctx().lineWidth = isLimit ? 1.2 : 0.8;
    if (isLimit) ctx().setLineDash([5, 4]);
    ctx().beginPath();
    ctx().moveTo(plotX, gy);
    ctx().lineTo(plotX + plotW, gy);
    ctx().stroke();
    ctx().restore();

    ctx().textAlign = 'right';
    ctx().font = `400 8.5px ${FONT_MONO}`;
    ctx().fillStyle = isLimit ? '#B91C1C' : '#64748B';
    ctx().fillText(String(val), plotX - 8, gy + 3);
  });

  // X ticks
  [0, 3, 6, 9, 12, Math.round(maxT)].forEach((sec) => {
    const clamped = Math.min(sec, maxT);
    ctx().textAlign = 'center';
    ctx().font = `400 8.5px ${FONT_MONO}`;
    ctx().fillStyle = '#64748B';
    ctx().fillText(`${clamped}s`, xOf(clamped), plotY + plotH + 16);
  });

  // Area fill + Line
  if (pts.length > 0) {
    ctx().save();
    ctx().beginPath();
    ctx().moveTo(xOf(pts[0].t), plotY + plotH);
    pts.forEach((p) => ctx().lineTo(xOf(p.t), yOf(p.q)));
    ctx().lineTo(xOf(pts[pts.length - 1].t), plotY + plotH);
    ctx().closePath();
    ctx().fillStyle = `${payload.selectedSeries.accentColor}1C`;
    ctx().fill();

    ctx().beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx().moveTo(xOf(p.t), yOf(p.q));
      else ctx().lineTo(xOf(p.t), yOf(p.q));
    });
    ctx().strokeStyle = payload.selectedSeries.accentColor;
    ctx().lineWidth = 2;
    ctx().lineJoin = 'round';
    ctx().stroke();

    pts.forEach((p) => {
      if (p.ff > 0) {
        ctx().beginPath();
        ctx().arc(xOf(p.t), yOf(p.ff), p.ff >= 2 ? 4.5 : 3.2, 0, Math.PI * 2);
        ctx().fillStyle = '#D97706';
        ctx().fill();
        ctx().strokeStyle = '#FFFFFF';
        ctx().lineWidth = 1;
        ctx().stroke();
      }
      ctx().beginPath();
      ctx().arc(xOf(p.t), yOf(p.q), 2.5, 0, Math.PI * 2);
      ctx().fillStyle = payload.selectedSeries.accentColor;
      ctx().fill();
    });
    ctx().restore();
  }

  builder.y += chartBoxH + 22;

  // =========================================================================
  // Page 2: TTS Wait & ffmpeg Bars + Express Probes + Before vs After Table
  // =========================================================================
  builder.addPage();

  // Side-by-side Section 03 (TTS) and Section 04 (ffmpeg)
  const halfW = (CONTENT_W - 18) / 2;
  const dualCardH = 196;
  const dualY = builder.y;

  // Left card: TTS Wait
  builder.drawRoundedRect(MARGIN_X, dualY, halfW, dualCardH, 8, '#FFFFFF', '#CBD5E1', 1);
  ctx().textAlign = 'left';
  ctx().font = `700 12px ${FONT_SANS}`;
  ctx().fillStyle = '#0F172A';
  ctx().fillText('03. TTS 排隊等待時間（tts_wait_seconds）', MARGIN_X + 14, dualY + 24);
  ctx().font = `400 9px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  ctx().fillText('基準 TTS 150ms；W=3 共用 Semaphore(3) 使 P95 +37.8%', MARGIN_X + 14, dualY + 40);

  payload.ttsRows.forEach((row, i) => {
    const by = dualY + 62 + i * 38;
    const barW = halfW - 28;
    ctx().textAlign = 'left';
    ctx().font = `600 9.5px ${FONT_SANS}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(row.label, MARGIN_X + 14, by);

    ctx().textAlign = 'right';
    ctx().font = `400 8.5px ${FONT_MONO}`;
    ctx().fillStyle = '#475569';
    ctx().fillText(
      `Avg ${row.avgMs.toFixed(1)}ms · P95 ${row.p95Ms.toFixed(1)}ms`,
      MARGIN_X + halfW - 14,
      by
    );

    builder.drawRoundedRect(MARGIN_X + 14, by + 8, barW, 8, 4, '#F1F5F9');
    builder.drawRoundedRect(
      MARGIN_X + 14,
      by + 8,
      Math.min(barW, (row.p95Ms / 360) * barW),
      8,
      4,
      '#FCD34D'
    );
    builder.drawRoundedRect(
      MARGIN_X + 14,
      by + 8,
      Math.min(barW, (row.avgMs / 360) * barW),
      8,
      4,
      '#2563EB'
    );
  });

  ctx().textAlign = 'left';
  ctx().font = `400 8.2px ${FONT_MONO}`;
  ctx().fillStyle = '#64748B';
  ctx().fillText('深藍：Avg 等待  ·  琥珀：P95 等待', MARGIN_X + 14, dualY + dualCardH - 12);

  // Right card: ffmpeg Benchmark
  const rightX = MARGIN_X + halfW + 18;
  builder.drawRoundedRect(rightX, dualY, halfW, dualCardH, 8, '#FFFFFF', '#CBD5E1', 1);
  ctx().textAlign = 'left';
  ctx().font = `700 12px ${FONT_SANS}`;
  ctx().fillStyle = '#0F172A';
  ctx().fillText('04. ffmpeg 拼接微基準（重編碼 vs copy）', rightX + 14, dualY + 24);
  ctx().font = `400 9px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  ctx().fillText('改用無損 -c copy 隨音長放大最高可加速 2.31×', rightX + 14, dualY + 40);

  payload.ffmpegRows.forEach((item, i) => {
    const by = dualY + 62 + i * 38;
    const barW = halfW - 28;
    ctx().textAlign = 'left';
    ctx().font = `600 9.5px ${FONT_SANS}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(item.label, rightX + 14, by);

    ctx().textAlign = 'right';
    ctx().font = `600 8.5px ${FONT_MONO}`;
    ctx().fillStyle = '#047857';
    ctx().fillText(
      `${item.reencodeMs}ms → ${item.copyMs}ms (${item.speedup})`,
      rightX + halfW - 14,
      by
    );

    builder.drawRoundedRect(rightX + 14, by + 6, barW, 5, 2.5, '#F1F5F9');
    builder.drawRoundedRect(
      rightX + 14,
      by + 6,
      Math.min(barW, (item.reencodeMs / 250) * barW),
      5,
      2.5,
      '#334155'
    );
    builder.drawRoundedRect(rightX + 14, by + 13, barW, 5, 2.5, '#F1F5F9');
    builder.drawRoundedRect(
      rightX + 14,
      by + 13,
      Math.min(barW, (item.copyMs / 250) * barW),
      5,
      2.5,
      '#059669'
    );
  });

  ctx().textAlign = 'left';
  ctx().font = `400 8.2px ${FONT_MONO}`;
  ctx().fillStyle = '#64748B';
  ctx().fillText('深灰：libmp3lame 重編碼  ·  翠綠：-c copy 無損拼接', rightX + 14, dualY + dualCardH - 12);

  builder.y = dualY + dualCardH + 22;

  // =========================================================================
  // Section 05: Live Express Probes Table
  // =========================================================================
  builder.drawSectionHeader(
    '05. 實機 Express HTTP 端點壓測（S4 · 20 併發 / 10 秒）',
    '直接對運行中服務發壓，暴露無快取 /ready 觸發 python3 子行程風暴對整機尾延遲的影響。'
  );

  const eRowH = 26;
  const eHeadH = 24;
  const eTableH = eHeadH + payload.expressRows.length * eRowH;
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, eTableH, 6, '#FFFFFF', '#CBD5E1', 1);
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, eHeadH, 6, '#F1F5F9');

  const eCols = [
    { label: '端點', x: 0, w: 120, align: 'left' as const },
    { label: '請求數', x: 120, w: 58, align: 'right' as const },
    { label: 'QPS', x: 178, w: 58, align: 'right' as const },
    { label: 'P50(ms)', x: 236, w: 68, align: 'right' as const },
    { label: 'P95(ms)', x: 304, w: 68, align: 'right' as const },
    { label: 'Max(ms)', x: 372, w: 74, align: 'right' as const },
    { label: '修復後診斷與驗證', x: 446, w: 260, align: 'left' as const },
  ];

  ctx().font = `600 9px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  eCols.forEach((col) => {
    ctx().textAlign = col.align;
    const tx = col.align === 'right' ? MARGIN_X + col.x + col.w - 8 : MARGIN_X + col.x + 10;
    ctx().fillText(col.label, tx, builder.y + 15);
  });

  payload.expressRows.forEach((row, idx) => {
    const ry = builder.y + eHeadH + idx * eRowH;
    const isCritical = row.endpoint === 'GET /ready';
    if (idx % 2 === 1) {
      ctx().fillStyle = '#F8FAFC';
      ctx().fillRect(MARGIN_X + 1, ry, CONTENT_W - 2, eRowH);
    }
    ctx().strokeStyle = '#E2E8F0';
    ctx().lineWidth = 0.75;
    ctx().beginPath();
    ctx().moveTo(MARGIN_X, ry);
    ctx().lineTo(MARGIN_X + CONTENT_W, ry);
    ctx().stroke();

    ctx().textAlign = 'left';
    ctx().font = `600 9px ${FONT_MONO}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(row.endpoint, MARGIN_X + 10, ry + 16);

    ctx().textAlign = 'right';
    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#334155';
    ctx().fillText(String(row.requests), MARGIN_X + eCols[1].x + eCols[1].w - 8, ry + 16);
    ctx().fillText(row.qps, MARGIN_X + eCols[2].x + eCols[2].w - 8, ry + 16);

    ctx().fillStyle = isCritical ? '#B91C1C' : '#334155';
    ctx().font = `${isCritical ? 700 : 400} 8.8px ${FONT_MONO}`;
    ctx().fillText(row.p50Ms, MARGIN_X + eCols[3].x + eCols[3].w - 8, ry + 16);
    ctx().fillText(row.p95Ms, MARGIN_X + eCols[4].x + eCols[4].w - 8, ry + 16);

    ctx().fillStyle = '#334155';
    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillText(row.maxMs, MARGIN_X + eCols[5].x + eCols[5].w - 8, ry + 16);

    ctx().textAlign = 'left';
    ctx().font = `500 8.8px ${FONT_SANS}`;
    ctx().fillStyle = isCritical ? '#B91C1C' : '#047857';
    ctx().fillText(row.status, MARGIN_X + eCols[6].x + 10, ry + 16);
  });

  builder.y += eTableH + 22;

  // =========================================================================
  // Section 07: Before vs After Verified Optimization Table
  // =========================================================================
  builder.drawSectionHeader(
    '06. 瓶頸修復落地與前後實測驗證（Before vs After）',
    '完成 6 項核心修復（W=4/Q=32、PriorityQueue、ffmpeg -c copy、TTS/FFMPEG 併發配置、Redis Single-Flight、Express /ready 10s TTL 快取）後以相同併發重測。'
  );

  const baRowH = 25;
  const baHeadH = 24;
  const baTableH = baHeadH + payload.beforeAfterRows.length * baRowH;
  builder.ensureSpace(baTableH + 12);

  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, baTableH, 6, '#FFFFFF', '#CBD5E1', 1);
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, baHeadH, 6, '#F1F5F9');

  const baCols = [
    { label: '指標項目', x: 0, w: 266, align: 'left' as const },
    { label: '修復前（基準）', x: 266, w: 148, align: 'right' as const },
    { label: '修復後（實測）', x: 414, w: 148, align: 'right' as const },
    { label: '實測改善幅度', x: 562, w: 144, align: 'right' as const },
  ];

  ctx().font = `600 9px ${FONT_SANS}`;
  ctx().fillStyle = '#475569';
  baCols.forEach((col) => {
    ctx().textAlign = col.align;
    const tx = col.align === 'right' ? MARGIN_X + col.x + col.w - 10 : MARGIN_X + col.x + 10;
    ctx().fillText(col.label, tx, builder.y + 15);
  });

  payload.beforeAfterRows.forEach((row, idx) => {
    const ry = builder.y + baHeadH + idx * baRowH;
    if (idx % 2 === 1) {
      ctx().fillStyle = '#F8FAFC';
      ctx().fillRect(MARGIN_X + 1, ry, CONTENT_W - 2, baRowH);
    }
    ctx().strokeStyle = '#E2E8F0';
    ctx().lineWidth = 0.75;
    ctx().beginPath();
    ctx().moveTo(MARGIN_X, ry);
    ctx().lineTo(MARGIN_X + CONTENT_W, ry);
    ctx().stroke();

    ctx().textAlign = 'left';
    ctx().font = `500 9px ${FONT_SANS}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(row.metric, MARGIN_X + 10, ry + 16);

    ctx().textAlign = 'right';
    ctx().font = `400 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#64748B';
    ctx().fillText(row.before, MARGIN_X + baCols[1].x + baCols[1].w - 10, ry + 16);

    ctx().font = `600 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#0F172A';
    ctx().fillText(row.after, MARGIN_X + baCols[2].x + baCols[2].w - 10, ry + 16);

    ctx().font = `700 8.8px ${FONT_MONO}`;
    ctx().fillStyle = '#047857';
    ctx().fillText(row.delta, MARGIN_X + baCols[3].x + baCols[3].w - 10, ry + 16);
  });

  builder.y += baTableH + 22;

  // =========================================================================
  // Page 3+: Bottleneck Matrix & Recommendations + Production Env Config
  // =========================================================================
  builder.addPage();
  builder.drawSectionHeader(
    '07. 瓶頸定位矩陣與優先級優化建議（P0 / P1 / P2）',
    '逐項排除 CPU、記憶體與 Redis，聚焦真正限制系統吞吐量與尾延遲的關鍵元件與建議行動。'
  );

  for (const item of payload.bottlenecks) {
    const titleLines = builder.wrapText(item.component, CONTENT_W - 28, `700 10.5px ${FONT_SANS}`);
    const evLines = builder.wrapText(
      `實測證據：${item.evidence}`,
      CONTENT_W - 28,
      `400 9.5px ${FONT_SANS}`
    );
    const recLines = builder.wrapText(
      `優化行動：${item.recommendation}`,
      CONTENT_W - 28,
      `400 9.5px ${FONT_SANS}`
    );

    const cardH =
      26 + titleLines.length * 14 + evLines.length * 13.5 + recLines.length * 13.5 + 24;
    builder.ensureSpace(cardH + 10);

    builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, cardH, 7, '#FFFFFF', '#CBD5E1', 1);

    let cy = builder.y + 17;
    ctx().textAlign = 'left';
    ctx().font = `700 9px ${FONT_MONO}`;
    ctx().fillStyle = tierColor(item.tier);
    ctx().fillText(item.verdict, MARGIN_X + 14, cy);

    cy += 15;
    ctx().font = `700 10.5px ${FONT_SANS}`;
    ctx().fillStyle = '#0F172A';
    for (const l of titleLines) {
      ctx().fillText(l, MARGIN_X + 14, cy);
      cy += 14;
    }

    cy += 2;
    ctx().font = `400 9.5px ${FONT_SANS}`;
    ctx().fillStyle = '#475569';
    for (const l of evLines) {
      ctx().fillText(l, MARGIN_X + 14, cy);
      cy += 13.5;
    }

    cy += 2;
    ctx().fillStyle = '#1E293B';
    for (const l of recLines) {
      ctx().fillText(l, MARGIN_X + 14, cy);
      cy += 13.5;
    }

    cy += 3;
    ctx().font = `600 9px ${FONT_MONO}`;
    ctx().fillStyle = '#047857';
    ctx().fillText(`預期收益：${item.expectedImpact}`, MARGIN_X + 14, cy);

    builder.y += cardH + 10;
  }

  // Production Recommended Config Block
  const envLines = payload.recommendedEnvSnippet.split('\n');
  const codeBlockH = 34 + envLines.length * 14 + 14;
  builder.ensureSpace(codeBlockH + 24);

  builder.y += 6;
  builder.drawSectionHeader('08. 建議生產環境設定與 Prometheus 告警規則');
  builder.drawRoundedRect(MARGIN_X, builder.y, CONTENT_W, codeBlockH, 8, '#0F172A');

  ctx().textAlign = 'left';
  ctx().font = `400 9.5px ${FONT_MONO}`;
  ctx().fillStyle = '#F1F5F9';
  let codeY = builder.y + 24;
  for (const line of envLines) {
    ctx().fillStyle = line.trim().startsWith('#') ? '#94A3B8' : '#E2E8F0';
    ctx().fillText(line, MARGIN_X + 16, codeY);
    codeY += 14;
  }

  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`;
  builder.finalizeAndSave(`系統壓力測試與瓶頸分析報告_${dateStamp}.pdf`);
}
