import 'dotenv/config';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(__dirname, 'bot_bridge.py');

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const DIST_DIR = path.resolve(__dirname, 'dist');

function fileReadable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const winLocal = path.resolve(__dirname, 'telegram-voice-bot', '.venv', 'Scripts', 'python.exe');
  if (fileReadable(winLocal)) return winLocal;
  const posixLocal = path.resolve(__dirname, 'telegram-voice-bot', '.venv', 'bin', 'python');
  if (fileReadable(posixLocal)) return posixLocal;
  const winRoot = path.resolve(__dirname, '.venv', 'Scripts', 'python.exe');
  if (fileReadable(winRoot)) return winRoot;
  const posixRoot = path.resolve(__dirname, '.venv', 'bin', 'python');
  if (fileReadable(posixRoot)) return posixRoot;
  const optVenv = '/opt/bot-venv/bin/python';
  if (fileReadable(optVenv)) return optVenv;
  const tmpPosix = '/tmp/telegram-voice-bot/.venv/bin/python';
  if (fileReadable(tmpPosix)) return tmpPosix;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const BOT_SYSTEM_INSTRUCTION = `你是部署在 Web Voice Bot 內的智慧語音助手（底層使用專案開發的 Python 語音管線、ConversationStore 多輪記憶、Edge-TTS 與 ffmpeg）。
請遵守以下回覆原則：
1. 預設使用自然、親切的繁體中文回覆；若使用者以英文提問則以英文回覆。
2. 因為你的回覆會透過 TTS 語音合成朗讀出來，請盡量保持精簡口語（一般問答控制在 2 到 4 句話以內），避免過多複雜的 Markdown 符號或冗長列表；若使用者明確要求詳細程式碼或步驟時再展開說明。
3. 擅長軟體工程（特別是 C# / .NET、Python、TypeScript 與系統架構）以及日常知識問答，並善用多輪對話上下文回應追問。`;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function runFfmpeg(
  args: string[],
  timeoutMs = 15000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (process.platform === 'win32') {
          child.kill();
        } else {
          child.kill('SIGKILL');
        }
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function inputFileNameFromMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('webm')) return 'input.webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'input.m4a';
  if (m.includes('ogg') || m.includes('opus')) return 'input.ogg';
  if (m.includes('wav')) return 'input.wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'input.mp3';
  return 'input.bin';
}

interface NormalizedAudioResult {
  wavBase64: string;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
  durationSec: number | null;
  isSilent: boolean;
}

/**
 * Transcodes any browser audio (Chrome WebM/Opus, Safari MP4/AAC, Firefox OGG, MP3, WAV)
 * into normalized 16kHz mono PCM WAV and inspects peak loudness via ffmpeg volumedetect.
 */
async function normalizeAudioToWav(
  audioBase64: string,
  mimeType: string
): Promise<NormalizedAudioResult> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-voice-'));
  const safeInputName = inputFileNameFromMime(mimeType);
  const inPath = path.join(workDir, safeInputName);
  const outPath = path.join(workDir, 'output.wav');

  try {
    const rawBuf = Buffer.from(audioBase64, 'base64');
    if (rawBuf.length < 100) {
      throw new Error('錄音檔案過小（無有效音訊資料），請按住或開啟麥克風說話至少 1 秒再停止。');
    }
    const inFd = fs.openSync(inPath, 'wx', 0o600);
    try {
      fs.writeFileSync(inFd, rawBuf);
    } finally {
      fs.closeSync(inFd);
    }

    // 1. Measure raw loudness & duration first
    const probe = await runFfmpeg(
      ['-hide_banner', '-threads', '1', '-i', inPath, '-af', 'volumedetect', '-f', 'null', '-'],
      10000
    );

    const maxMatch = probe.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    const meanMatch = probe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    const durMatch = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const timeMatch = [...probe.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/gi)].pop();

    const maxVolumeDb = maxMatch ? Number.parseFloat(maxMatch[1]) : null;
    const meanVolumeDb = meanMatch ? Number.parseFloat(meanMatch[1]) : null;

    let durationSec: number | null = null;
    const activeTime = timeMatch || durMatch;
    if (activeTime) {
      durationSec =
        Number.parseInt(activeTime[1], 10) * 3600 +
        Number.parseInt(activeTime[2], 10) * 60 +
        Number.parseFloat(activeTime[3]);
    }

    const isSilent = maxVolumeDb !== null && maxVolumeDb <= -68;

    // 2. Transcode to crystal-clear 16kHz mono PCM WAV with gentle dynamic gain boost for quiet laptop mics
    const filterChain =
      maxVolumeDb !== null && maxVolumeDb > -68 && maxVolumeDb < -8
        ? 'highpass=f=80,dynaudnorm=f=150:g=15'
        : 'highpass=f=80';

    const conv = await runFfmpeg(
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-i',
        inPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-af',
        filterChain,
        '-c:a',
        'pcm_s16le',
        outPath,
      ],
      15000
    );

    if (conv.code !== 0) {
      throw new Error(`無法解碼音訊格式（${mimeType}）：${conv.stderr.trim() || 'ffmpeg error'}`);
    }

    let wavBuf: Buffer;
    try {
      const outFd = fs.openSync(outPath, 'r');
      try {
        wavBuf = fs.readFileSync(outFd);
      } finally {
        fs.closeSync(outFd);
      }
    } catch {
      throw new Error(`無法解碼音訊格式（${mimeType}）：ffmpeg 未產生輸出音檔`);
    }

    return {
      wavBase64: wavBuf.toString('base64'),
      maxVolumeDb,
      meanVolumeDb,
      durationSec: durationSec !== null ? Math.round(durationSec * 10) / 10 : null,
      isSilent,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function runPythonBridge<T>(command: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonBin(), [BRIDGE_SCRIPT, command], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start Python bridge: ${err.message}`));
    });

    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(stderr.trim() || `Python bridge exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as T);
      } catch {
        const lines = trimmed.split('\n');
        const last = lines[lines.length - 1];
        try {
          resolve(JSON.parse(last) as T);
        } catch {
          reject(new Error(`Invalid JSON from bridge (code ${code}): ${trimmed.slice(0, 300)}`));
        }
      }
    });

    if (payload !== undefined) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

interface PrepareResult {
  ok: boolean;
  rejected?: boolean;
  handled?: boolean;
  reason?: string;
  reply?: string;
  reqId?: string;
  history?: Array<{ role: string; content: string }>;
  preLogs?: string[];
  logs?: string[];
  elapsedMs?: number;
}

interface AccessResult {
  ok: boolean;
  rejected?: boolean;
  reason?: string;
  reqId?: string;
  preLogs?: string[];
  logs?: string[];
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timed out')
  );
}

function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return 'AI 服務目前流量尖峰暫時繁忙（503），請稍候幾秒後重試。';
  }
  if (raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return 'Gemini API 金鑰權限不足或無效，請在 Settings > Secrets 確認設定。';
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return '已達 API 速率上限（429），請稍後再試。';
  }
  return raw;
}

async function generateBotReply(
  userText: string,
  history: Array<{ role: string; content: string }>
): Promise<{ reply: string; llmMs: number; modelUsed: string }> {
  const ai = getGeminiClient();
  const t0 = Date.now();

  const contents = [
    ...history.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    })),
    {
      role: 'user',
      parts: [{ text: userText }],
    },
  ];

  const primaryModel = (process.env.GEMINI_MODEL || '').trim() || 'gemini-3.1-flash-lite';
  const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || '').trim() || 'gemini-4-hydrogen';

  const attempts: Array<{ model: string; useLowThinking: boolean; timeoutMs: number; delayMs: number }> = [
    { model: primaryModel, useLowThinking: false, timeoutMs: 9000, delayMs: 0 },
    { model: primaryModel, useLowThinking: false, timeoutMs: 10000, delayMs: 300 },
    {
      model: fallbackModel,
      useLowThinking: fallbackModel === 'gemini-4-hydrogen',
      timeoutMs: 10000,
      delayMs: 400,
    },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await new Promise((r) => setTimeout(r, attempt.delayMs));
    }
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: attempt.model,
          contents,
          config: attempt.useLowThinking
            ? {
                systemInstruction: BOT_SYSTEM_INSTRUCTION,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              }
            : {
                systemInstruction: BOT_SYSTEM_INSTRUCTION,
              },
        }),
        attempt.timeoutMs,
        attempt.model
      );

      const reply = (response.text ?? '').trim();
      if (!reply) {
        throw new Error('Model returned an empty reply.');
      }

      return {
        reply,
        llmMs: Date.now() - t0,
        modelUsed: attempt.model,
      };
    } catch (err) {
      lastErr = err;
      if (!isTransientGeminiError(err)) {
        break;
      }
    }
  }

  throw new Error(formatGeminiError(lastErr));
}

async function transcribeVoiceAudio(
  wavBase64: string
): Promise<{ transcript: string; sttMs: number }> {
  const ai = getGeminiClient();
  const t0 = Date.now();

  const promptParts = [
    {
      inlineData: {
        mimeType: 'audio/wav',
        data: wavBase64,
      },
    },
    {
      text: 'Transcribe the spoken words in this audio accurately in their original language (use Traditional Chinese if Mandarin Chinese). Output ONLY the transcribed speech text. If there is only silence or background noise with no speech, output an empty string.',
    },
  ];

  const primaryModel = (process.env.GEMINI_MODEL || '').trim() || 'gemini-3.1-flash-lite';
  const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || '').trim() || 'gemini-4-hydrogen';
  const models = [primaryModel, primaryModel, fallbackModel];
  let lastErr: unknown;

  for (let i = 0; i < models.length; i += 1) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: models[i],
          contents: { parts: promptParts },
        }),
        9000,
        models[i]
      );
      const raw = (response.text ?? '').trim();
      // Filter out boilerplate silence markers if model outputs them
      const cleaned = /^(?:\[silence\]|\(silence\)|silence|無語音|沒有語音|空白)$/i.test(raw)
        ? ''
        : raw;
      return {
        transcript: cleaned,
        sttMs: Date.now() - t0,
      };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const canFallback = isTransientGeminiError(err) || msg.includes('404') || msg.includes('NOT_FOUND');
      if (!canFallback) {
        break;
      }
    }
  }

  throw new Error(formatGeminiError(lastErr));
}

async function executeConversationPipeline(params: {
  userId: number;
  chatId: number | string;
  text: string;
  isVoice: boolean;
  reqId?: string;
  preLogs?: string[];
  sttMs?: number;
}) {
  const prep = await runPythonBridge<PrepareResult>('prepare', {
    userId: params.userId,
    chatId: params.chatId,
    text: params.text,
    isVoice: params.isVoice,
    reqId: params.reqId,
    preLogs: params.preLogs,
  });

  if (prep.rejected || prep.handled) {
    return prep;
  }

  const { reply, llmMs } = await generateBotReply(params.text, prep.history ?? []);

  return runPythonBridge<Record<string, unknown>>('finalize', {
    userId: params.userId,
    chatId: params.chatId,
    text: params.text,
    reply,
    reqId: prep.reqId,
    isVoice: params.isVoice,
    preLogs: prep.preLogs ?? [],
    sttMs: params.sttMs ?? 0,
    llmMs,
  });
}

async function createServer() {
    const app = express();
    app.use(express.json({ limit: '15mb' }));

    app.get('/api/bot/status', async (_req, res) => {
        try {
            const data = await runPythonBridge('status');
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Status check failed' });
        }
    });

    app.get('/api/bot/history', async (req, res) => {
        try {
            const chatId = String(req.query.chatId ?? '123456');
            const data = await runPythonBridge('history', { chatId });
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'History fetch failed' });
        }
    });

    app.post('/api/bot/config', async (req, res) => {
        try {
            const data = await runPythonBridge('config', req.body ?? {});
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Config update failed' });
        }
    });

    app.post('/api/bot/chat', async (req, res) => {
        try {
            const body = req.body ?? {};
            const userId = Number(body.userId ?? 123456);
            const chatId = body.chatId ?? userId;
            const text = String(body.text ?? '').trim();
            const isVoice = Boolean(body.isVoice ?? true);

            const data = await executeConversationPipeline({
                userId,
                chatId,
                text,
                isVoice,
            });
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Chat execution failed' });
        }
    });

    app.post('/api/bot/voice', async (req, res) => {
        try {
            const body = req.body ?? {};
            const userId = Number(body.userId ?? 123456);
            const chatId = body.chatId ?? userId;
            const audioBase64 = String(body.audioBase64 ?? '').trim();
            const mimeType = String(body.mimeType ?? 'audio/webm');
            const clientTranscript = String(body.clientTranscript ?? '').trim();
            const isVoice = body.isVoice !== undefined ? Boolean(body.isVoice) : true;

            if (!audioBase64) {
                res.status(400).json({ error: '未收到錄音資料，請重新錄音。' });
                return;
            }

            // 1. Enforce allowlist + quota before invoking ffmpeg/STT
            const access = await runPythonBridge<AccessResult>('check_access', { userId, chatId });
            if (access.rejected) {
                res.json({
                    ok: false,
                    rejected: true,
                    reason: access.reason,
                    reqId: access.reqId,
                    logs: access.logs ?? [],
                    elapsedMs: 1,
                });
                return;
            }

            // 2. Transcode browser audio (WebM/Opus, MP4/AAC, OGG, MP3, WAV) to normalized 16kHz mono WAV
            const normalized = await normalizeAudioToWav(audioBase64, mimeType);

            if (normalized.isSilent && !clientTranscript) {
                res.status(422).json({
                    error: `偵測到麥克風錄音完全靜音（峰值音量 ${normalized.maxVolumeDb} dB，長度 ${normalized.durationSec ?? 0} 秒）。請檢查電腦麥克風是否靜音，或在上方「麥克風裝置」選單切換其他輸入裝置後再試。`,
                    diagnostics: {
                        maxVolumeDb: normalized.maxVolumeDb,
                        meanVolumeDb: normalized.meanVolumeDb,
                        durationSec: normalized.durationSec,
                        isSilent: true,
                    },
                });
                return;
            }

            // 3. Server-side STT on clean 16kHz mono WAV (with browser live-caption fallback if needed)
            let transcript = '';
            let sttMs = 0;
            try {
                const sttRes = await transcribeVoiceAudio(normalized.wavBase64);
                transcript = sttRes.transcript;
                sttMs = sttRes.sttMs;
            } catch (err) {
                if (!clientTranscript) {
                    throw err;
                }
            }

            if (!transcript && clientTranscript) {
                transcript = clientTranscript;
            }

            if (!transcript) {
                res.status(422).json({
                    error: `有收到聲音（峰值 ${normalized.maxVolumeDb ?? '?'} dB，長度 ${normalized.durationSec ?? '?'} 秒），但無法辨識清楚字句，請靠近麥克風說慢一點再試。`,
                    diagnostics: {
                        maxVolumeDb: normalized.maxVolumeDb,
                        meanVolumeDb: normalized.meanVolumeDb,
                        durationSec: normalized.durationSec,
                        isSilent: false,
                    },
                });
                return;
            }

            // 4. Execute multi-turn AI reply + Python ConversationStore + TTSProvider + ffmpeg
            const result = await executeConversationPipeline({
                userId,
                chatId,
                text: transcript,
                isVoice,
                reqId: access.reqId,
                preLogs: access.preLogs ?? [],
                sttMs,
            });

            res.json({
                ...result,
                transcript,
                sttMs,
                diagnostics: {
                    maxVolumeDb: normalized.maxVolumeDb,
                    durationSec: normalized.durationSec,
                },
            });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Voice processing failed' });
        }
    });

    app.post('/api/bot/run-tests', async (_req, res) => {
        try {
            const data = await runPythonBridge('tests');
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Test runner failed' });
        }
    });

    app.get('/api/download/complete-zip', (_req, res) => {
        res.setHeader('Content-Disposition', 'attachment; filename="web-voice-bot-complete.zip"');
        res.sendFile(path.join(PUBLIC_DIR, 'web-voice-bot-complete.zip'), (err) => {
            if (err && !res.headersSent) {
                res.status(404).json({ error: 'Complete project ZIP archive not found.' });
            }
        });
    });

    app.get('/api/download/launcher/:platform', (req, res) => {
        const platform = req.params.platform;
        if (platform === 'windows') {
            res.setHeader('Content-Disposition', 'attachment; filename="start-win11.ps1"');
            res.sendFile(path.join(__dirname, 'start-win11.ps1'), (err) => {
                if (err && !res.headersSent) {
                    res.status(404).json({ error: 'Windows launcher script not found.' });
                }
            });
            return;
        }
        if (platform === 'linux') {
            res.setHeader('Content-Disposition', 'attachment; filename="start-linux.sh"');
            res.sendFile(path.join(__dirname, 'start-linux.sh'), (err) => {
                if (err && !res.headersSent) {
                    res.status(404).json({ error: 'Linux launcher script not found.' });
                }
            });
            return;
        }
        res.status(400).json({ error: 'Unsupported platform. Use "windows" or "linux".' });
    });

    const isProd = process.env.NODE_ENV === 'production' && fileReadable(DIST_DIR);

    if (isProd) {
        app.use(express.static(DIST_DIR));
        app.get('*', (_req, res) => {
            res.sendFile(path.join(DIST_DIR, 'index.html'));
        });
    } else {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    }

    const port = Number(process.env.PORT || 3000);
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server listening on http://0.0.0:${port}`);
    });
}


createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
