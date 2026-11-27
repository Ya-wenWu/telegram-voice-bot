import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Mic,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  ConversationRepository,
  MAX_DAILY_ROUND_TRIPS,
  getLocalDayKey,
  reconcileConversationTurns,
  synthesizeTurnsFromServerPairs,
  type PersistedChatTurn,
  type ServerHistoryPair,
} from '../services/conversationStorage';
import {
  VERDICT_LABELS_ZH,
  VoiceAudioDiagnosticLogger,
  type VoiceDiagnosticSession,
} from '../services/voiceDiagnostics';
import {
  botGuardFetch,
  buildBotGuardRequestHeaders,
  markBotGuardUserInteraction,
  setBotGuardToken,
} from '../services/botGuardClient';
import { copyToClipboard } from '../utils/clipboard';
import { VoiceDiagnosticsModal } from './VoiceDiagnosticsModal';

interface BotConfig {
  ALLOWED_USER_IDS: string;
  TTS_PROVIDER: string;
  TTS_VOICE: string;
  BOT_WORKERS: number;
  CONCURRENT_UPDATES: number;
  BOT_QUEUE_MAXSIZE: number;
  CONVERSATION_MAX_TURNS: number;
  DAILY_REQUEST_LIMIT: number;
  TTS_TIMEOUT_SEC: number;
  FFMPEG_TIMEOUT_SEC: number;
  ZEN_MAX_TOKENS: number;
}

type RuntimeOs = 'windows' | 'linux';

interface PreflightStatus {
  nodeVersion: string;
  nodeOk: boolean;
  pythonOk: boolean;
  pythonHint: string;
  ffmpegOk: boolean;
  ffmpegHint: string;
  apiKeyState: 'ready' | 'missing' | 'placeholder' | 'invalid_format';
  apiKeyHint: string;
  gitGuardAvailable: boolean;
  promptGuardActive?: boolean;
  botGuardActive?: boolean;
}

interface BotGuardSummary {
  enabled: boolean;
  blockedTotal: number;
  challengedTotal: number;
  verifiedHumansTotal: number;
  honeypotHitsTotal: number;
  activeQuarantinedIps: number;
}

interface HumanChallengePrompt {
  challengeId: string;
  question: string;
  reason: string;
  pendingRetryText?: string;
  pendingRetryVoice?: { blob: Blob; label: string; transcript: string };
}

interface DeploymentProfileInfo {
  mode: 'constrained_1c1g' | 'high_concurrency';
  tier: string;
  reason: string;
  max_bots: number;
  bot_workers: number;
  ffmpeg_concurrency: number;
  tts_concurrency: number;
  resources: {
    effective_available_ram_mb: number;
    effective_cpu_cores: number;
  };
}

interface ActiveBotEntry {
  botId: string;
  name: string;
  ttsVoice: string;
  weight: number;
  enabled: boolean;
}

interface BotStatus {
  hostOs?: RuntimeOs;
  pythonVersion: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  redisFailOpenOk: boolean;
  redisCheckMs: number;
  gitBranch: string;
  gitCommit: string;
  commitsAhead: string[];
  config: BotConfig;
  deploymentProfile?: DeploymentProfileInfo;
  activeBots?: ActiveBotEntry[];
  botGuard?: BotGuardSummary;
  memoryStats: {
    activeChats: number;
    totalMessages: number;
    maxTurns: number;
  };
  preflight?: PreflightStatus;
}

type ChatTurnItem = PersistedChatTurn;

interface TestRunResult {
  ok: boolean;
  elapsedMs: number;
  pytest: { exitCode: number; output: string };
  ruff: { exitCode: number; output: string };
  mypy: { exitCode: number; output: string };
}

interface MicDevice {
  deviceId: string;
  label: string;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [idx: number]: {
      isFinal: boolean;
      [alt: number]: { transcript: string };
    };
  };
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend?: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

// Long-recording stability guards (prevent browser OOM, 60fps re-render storms, and Chrome 60s SpeechRec crashes)
const MAX_RECORDING_SECONDS = 180; // 3 minutes safe auto-stop & submit
const RECORDING_WARN_SECONDS = 150; // 2:30 gentle reminder
const MAX_RECORDING_BYTES = 12 * 1024 * 1024; // 12 MB raw audio buffer cap
const SPEECH_REC_SAFE_CUTOFF_SEC = 55; // Stop optional browser live-caption before Chrome's 60s hard limit
const METER_UPDATE_INTERVAL_MS = 125; // ~8 Hz meter sampling instead of 60fps React re-render storm
const VOICE_UPLOAD_TIMEOUT_MS = 95_000; // Allow 1-3 min audio ffmpeg + Gemini STT + TTS pipeline

const ISSUE_MATRIX = [
  {
    id: 'Web',
    title: 'Custom Web Messenger (Replaces Telegram)',
    status: 'Live Now',
    detail:
      'Browser microphone recording + live volume meter + ffmpeg 16kHz WAV normalization -> STT -> multi-turn AI -> Python TTSProvider + ffmpeg MP3 auto-playback.',
  },
  {
    id: '#24',
    title: 'Zero-OOM & Runtime Hardening',
    status: 'Implemented',
    detail:
      'Non-blocking worker STT, bounded queue (QueueFull), ffmpeg -threads 1 + timeout kill + Semaphore(1), TTS timeout degradation, req_id logs, 15s drain stop, systemd service.',
  },
  {
    id: '#25',
    title: 'Pluggable TTSProvider Interface',
    status: 'Implemented',
    detail:
      'bot/tts_provider.py supports edge, openai, and piper backends selectable dynamically via TTS_PROVIDER.',
  },
  {
    id: '#26',
    title: 'Multi-Turn Conversation Memory',
    status: 'Implemented',
    detail:
      'bot/memory.py ConversationStore with LRU + TTL + CONVERSATION_MAX_TURNS cap and /reset command.',
  },
  {
    id: '#27',
    title: 'Provider-Neutral Docs & Secret Redaction',
    status: 'Implemented',
    detail:
      'TokenRedactingFormatter + safe InvalidToken handling (zero raw token leak to stderr) + clean README.',
  },
  {
    id: '#22',
    title: 'Admin Dashboard & Dynamic Config',
    status: 'Live Web Panel',
    detail:
      'Zero-restart dynamic config hot-reload connected directly to the running Python bot state and live redacted log stream.',
  },
];

const QUICK_COMMANDS = ['/start', '/help', '/status', '/reset'];

const QUICK_PROMPTS = [
  '你好！用簡短兩句話自我介紹一下',
  'C# 的 async 和 await 有什麼注意事項？',
  '你記得我上一句問了什麼嗎？',
];

const VOICE_OPTIONS = [
  'zh-TW-HsiaoChenNeural',
  'zh-TW-YunJheNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunxiNeural',
  'en-US-JennyNeural',
];

const OS_STORAGE_KEY = 'web_voice_bot_target_os_v1';

interface RuntimeGuide {
  label: string;
  shortLabel: string;
  shellName: string;
  scriptName: string;
  prereqNote: string;
  prereqCmd: string;
  quickStartCmd: string;
  manualCmds: string;
  venvPythonPath: string;
  micNote: string;
}

const RUNTIME_GUIDES: Record<RuntimeOs, RuntimeGuide> = {
  windows: {
    label: 'Windows 11',
    shortLabel: 'Windows',
    shellName: 'PowerShell',
    scriptName: 'start-win11.ps1',
    prereqNote: '需先安裝 Node.js 20+、Python 3.11+（勾選 Add to PATH）與 ffmpeg（裝完請重開終端機）：',
    prereqCmd: 'winget install Gyan.FFmpeg',
    quickStartCmd: 'powershell -ExecutionPolicy Bypass -File .\\start-win11.ps1',
    manualCmds: [
      'npm install',
      'python -m venv telegram-voice-bot\\.venv',
      '.\\telegram-voice-bot\\.venv\\Scripts\\python.exe -m pip install -r telegram-voice-bot\\requirements-dev.txt',
      'Copy-Item .env.example .env   # 填入真實 GEMINI_API_KEY（切勿提交至 Git）',
      'npm run doctor                # 一鍵環境與防呆健檢',
      'npm run dev',
    ].join('\n'),
    venvPythonPath: 'telegram-voice-bot\\.venv\\Scripts\\python.exe',
    micNote: '執行 start-win11.ps1 會自動檢查版本、啟用 Git 防外洩 Hook，並以隱藏輸入引導設定 .env；開啟 http://localhost:3000 即可授權麥克風錄音。',
  },
  linux: {
    label: 'Linux',
    shortLabel: 'Linux',
    shellName: 'Bash',
    scriptName: 'start-linux.sh',
    prereqNote: 'Ubuntu / Debian 需先安裝 Node.js 20+、Python 3.11+、python3-venv 與 ffmpeg：',
    prereqCmd: 'sudo apt update && sudo apt install -y ffmpeg python3-venv',
    quickStartCmd: 'chmod +x ./start-linux.sh && ./start-linux.sh',
    manualCmds: [
      'npm install',
      'python3 -m venv telegram-voice-bot/.venv',
      'telegram-voice-bot/.venv/bin/pip install -r telegram-voice-bot/requirements-dev.txt',
      'cp .env.example .env && chmod 600 .env   # 編輯填入真實 GEMINI_API_KEY',
      'npm run doctor                           # 一鍵環境與防呆健檢',
      'npm run dev',
    ].join('\n'),
    venvPythonPath: 'telegram-voice-bot/.venv/bin/python',
    micNote: '執行 ./start-linux.sh 會自動檢查版本、設 chmod 600 .env、啟用 Git 防外洩 Hook 並以隱藏輸入設定金鑰；遠端 IP 部署請搭配 HTTPS 以使用麥克風。',
  },
};

function detectDefaultOs(): RuntimeOs {
  try {
    const saved = window.localStorage.getItem(OS_STORAGE_KEY);
    if (saved === 'windows' || saved === 'linux') return saved;
  } catch {
    // ignore storage errors
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  return ua.includes('win') ? 'windows' : 'linux';
}

function formatKb(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function encodeUtf8ToBase64(text: string): string {
  if (!text) return '';
  try {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  } catch {
    return '';
  }
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function BotLiveConsole() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [configForm, setConfigForm] = useState<BotConfig | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [failedRecordingUrl, setFailedRecordingUrl] = useState<string | null>(null);
  const [failedVoicePayload, setFailedVoicePayload] = useState<{
    blob: Blob;
    label: string;
    transcript: string;
  } | null>(null);

  const [rightTab, setRightTab] = useState<'env' | 'config' | 'logs' | 'tests'>('env');
  const [logsSubTab, setLogsSubTab] = useState<'server' | 'audio'>('server');
  const [targetOs, setTargetOs] = useState<RuntimeOs>(() => detectDefaultOs());
  const [copiedCommands, setCopiedCommands] = useState(false);
  const [downloadingLauncher, setDownloadingLauncher] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSavedNotice, setConfigSavedNotice] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<{ sizeLabel: string; url: string } | null>(
    null
  );
  const [copiedDownloadUrl, setCopiedDownloadUrl] = useState(false);

  const [activeBotId, setActiveBotId] = useState('default');
  const [newBotName, setNewBotName] = useState('');
  const [newBotVoice, setNewBotVoice] = useState('zh-TW-YunJheNeural');
  const [managingBots, setManagingBots] = useState(false);
  const [botManageNotice, setBotManageNotice] = useState<string | null>(null);

  const [userIdInput, setUserIdInput] = useState('123456');
  const activeChatId = userIdInput.trim() || '123456';
  const storageChatKey =
    activeBotId === 'default' ? activeChatId : `${activeBotId}:${activeChatId}`;
  const [messageInput, setMessageInput] = useState('');
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(true);
  const [autoPlayAudio, setAutoPlayAudio] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendingStage, setSendingStage] = useState('');
  const [sendingElapsedSec, setSendingElapsedSec] = useState(0);
  const [turns, setTurns] = useState<ChatTurnItem[]>(
    () => ConversationRepository.loadToday('123456').retained
  );
  const [retentionNotice, setRetentionNotice] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);

  // Web Audio & MediaRecorder diagnostic state (Buffer Overflow vs Stream Timeout)
  const [activeDiagSession, setActiveDiagSession] = useState<VoiceDiagnosticSession | null>(null);
  const [diagHistory, setDiagHistory] = useState<VoiceDiagnosticSession[]>(() =>
    VoiceAudioDiagnosticLogger.loadHistory()
  );
  const [diagSyncing, setDiagSyncing] = useState(false);
  const [diagLastSyncedAt, setDiagLastSyncedAt] = useState<string | null>(null);
  const [recoveredCrashSession, setRecoveredCrashSession] =
    useState<VoiceDiagnosticSession | null>(null);
  const [copiedDiagReport, setCopiedDiagReport] = useState(false);
  const [showDiagModal, setShowDiagModal] = useState(false);

  const syncDiagHistoryFromServer = useCallback(async () => {
    setDiagSyncing(true);
    try {
      const local = VoiceAudioDiagnosticLogger.loadHistory();
      const server = await VoiceAudioDiagnosticLogger.fetchServerHistory();
      const merged = VoiceAudioDiagnosticLogger.mergeSessions(local, server);
      setDiagHistory(merged);
      setDiagLastSyncedAt(new Date().toISOString());
    } finally {
      setDiagSyncing(false);
    }
  }, []);

  useEffect(() => {
    void syncDiagHistoryFromServer();
  }, [syncDiagHistoryFromServer]);

  // Microphone devices + live recording & audio level state
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [peakMicLevel, setPeakMicLevel] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef<number>(0);
  const recordingDurationRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const activeTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const diagLoggerRef = useRef<VoiceAudioDiagnosticLogger | null>(null);
  const recorderNudgedRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const meterTimerRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const liveTranscriptRef = useRef('');
  const cancelRecordingRef = useRef(false);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);
  const createdObjectUrlsRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Anti-malicious-bot state: tokens stay strictly in JS memory (never localStorage/sessionStorage)
  const [honeypotValue, setHoneypotValue] = useState('');
  const [humanChallenge, setHumanChallenge] = useState<HumanChallengePrompt | null>(null);
  const [challengeAnswer, setChallengeAnswer] = useState('');
  const [verifyingChallenge, setVerifyingChallenge] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const buildBotGuardHeaders = useCallback((): Record<string, string> => {
    return buildBotGuardRequestHeaders();
  }, []);

  const [runningTests, setRunningTests] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);

  const loadMicDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `麥克風裝置 ${idx + 1}`,
        }));
      setMicDevices(mics);
    } catch {
      // Ignore permission errors before first mic request
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const res = await botGuardFetch('/api/bot/status', { cache: 'no-store' });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          challengeRequired?: boolean;
          challenge?: { challengeId: string; question: string };
          reason?: string;
        };
        if (err.challengeRequired && err.challenge) {
          setHumanChallenge({
            challengeId: err.challenge.challengeId,
            question: err.challenge.question,
            reason: err.reason || err.error || '請完成人機驗證以載入系統狀態。',
          });
          setChallengeAnswer('');
          setChallengeError(null);
        }
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as BotStatus;
      setStatus(data);
      setConfigForm(data.config);
      if (
        Array.isArray(data.activeBots) &&
        data.activeBots.length > 0 &&
        !data.activeBots.some((b) => b.botId === activeBotId)
      ) {
        setActiveBotId(data.activeBots[0].botId);
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unable to reach Python bot bridge.');
    } finally {
      setLoadingStatus(false);
    }
  }, [activeBotId]);

  useEffect(() => {
    void fetchStatus();
    void loadMicDevices();
    const recovered = VoiceAudioDiagnosticLogger.recoverInterruptedSession();
    if (recovered) {
      setRecoveredCrashSession(recovered);
      setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
    }
    const handlePageHide = () => {
      diagLoggerRef.current?.flushBeacon('pagehide');
    };
    const markUserInteraction = () => {
      markBotGuardUserInteraction();
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pointerdown', markUserInteraction, { passive: true, once: true });
    window.addEventListener('keydown', markUserInteraction, { passive: true, once: true });
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pointerdown', markUserInteraction);
      window.removeEventListener('keydown', markUserInteraction);
    };
  }, [fetchStatus, loadMicDevices]);

  // Dual-layer hydration & server reconciliation: survives tab switches, refreshes, and server restarts
  useEffect(() => {
    let cancelled = false;
    const todayKey = getLocalDayKey();
    const localResult = ConversationRepository.loadToday(storageChatKey, todayKey);
    setTurns(localResult.retained);
    if (localResult.dayRolloverCleared) {
      setRetentionNotice('已跨日，系統自動清除前一日的歷史對話。');
    }

    const reconcileWithServer = async () => {
      try {
        const res = await botGuardFetch(
          `/api/bot/history?botId=${encodeURIComponent(activeBotId)}&chatId=${encodeURIComponent(
            activeChatId
          )}&dayKey=${encodeURIComponent(todayKey)}`,
          { cache: 'no-store', headers: { 'X-Bot-Id': activeBotId } }
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          ok?: boolean;
          turns?: PersistedChatTurn[];
          history?: ServerHistoryPair[];
        };
        if (cancelled || !data.ok) return;

        const serverTurns =
          Array.isArray(data.turns) && data.turns.length > 0
            ? data.turns
            : Array.isArray(data.history) && data.history.length > 0
              ? synthesizeTurnsFromServerPairs(activeChatId, data.history, todayKey)
              : [];

        const { merged, shouldHydrateServer } = reconcileConversationTurns(
          localResult.retained,
          serverTurns,
          todayKey
        );

        if (cancelled) return;
        if (merged.length > 0) {
          ConversationRepository.saveToday(storageChatKey, merged, todayKey);
          setTurns(merged);
        }

        // If backend restarted/wiped while client holds today's turns, re-hydrate backend LLM memory
        if (shouldHydrateServer && merged.length > 0) {
          await botGuardFetch('/api/bot/history/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Id': activeBotId },
            body: JSON.stringify({
              botId: activeBotId,
              chatId: activeChatId,
              dayKey: todayKey,
              turns: merged,
            }),
          });
          if (!cancelled) {
            setRetentionNotice(
              `偵測到系統重啟，已自動還原今日 ${merged.length} 筆往返對話與多輪記憶。`
            );
          }
        }
      } catch {
        // Offline or backend booting: keep local hydrated turns intact
      }
    };

    void reconcileWithServer();
    return () => {
      cancelled = true;
    };
  }, [activeBotId, activeChatId, storageChatKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns, sending]);

  const stopOptionalSpeechRecognition = useCallback(() => {
    const rec = speechRecRef.current;
    if (!rec) return;
    speechRecRef.current = null;
    try {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      if (rec.abort) {
        rec.abort();
      } else {
        rec.stop();
      }
    } catch {
      // ignore browser SpeechRecognition state errors
    }
  }, []);

  /**
   * Disconnects every Web Audio API node BEFORE closing AudioContext so native
   * audio render threads & ring buffers release deterministically without deadlocks.
   * Can also be called in isolation if Web Audio stalls while MediaRecorder continues.
   */
  const teardownWebAudioMeter = useCallback(() => {
    if (meterTimerRef.current) {
      window.clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.disconnect();
      } catch {
        // ignore already disconnected nodes
      }
      audioSourceRef.current = null;
    }
    if (audioAnalyserRef.current) {
      try {
        audioAnalyserRef.current.disconnect();
      } catch {
        // ignore
      }
      audioAnalyserRef.current = null;
    }
    if (silentGainRef.current) {
      try {
        silentGainRef.current.disconnect();
      } catch {
        // ignore
      }
      silentGainRef.current = null;
    }
    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      ctx.onstatechange = null;
      if (ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
    }
  }, []);

  const cleanupRecordingResources = useCallback(() => {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    teardownWebAudioMeter();
    stopOptionalSpeechRecognition();
    if (activeTrackRef.current) {
      activeTrackRef.current.onended = null;
      activeTrackRef.current.onmute = null;
      activeTrackRef.current.onunmute = null;
      activeTrackRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [stopOptionalSpeechRecognition, teardownWebAudioMeter]);

  useEffect(() => {
    if (!sending) {
      setSendingElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => {
      setSendingElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    const objectUrls = createdObjectUrlsRef.current;
    return () => {
      cleanupRecordingResources();
      activeRequestAbortRef.current?.abort();
      if (playingAudioRef.current) {
        playingAudioRef.current.pause();
        playingAudioRef.current = null;
      }
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.clear();
    };
  }, [cleanupRecordingResources]);

  const appendTurnWithRetention = useCallback(
    (chatId: string, nextItem: ChatTurnItem) => {
      const todayKey = getLocalDayKey();
      setTurns((prev) => {
        const result = ConversationRepository.saveToday(chatId, [...prev, nextItem], todayKey);
        // Revoke blob URLs of evicted turns to prevent memory leaks
        const retainedIds = new Set(result.retained.map((t) => t.id));
        for (const oldTurn of prev) {
          if (
            !retainedIds.has(oldTurn.id) &&
            oldTurn.userAudioUrl &&
            createdObjectUrlsRef.current.has(oldTurn.userAudioUrl)
          ) {
            URL.revokeObjectURL(oldTurn.userAudioUrl);
            createdObjectUrlsRef.current.delete(oldTurn.userAudioUrl);
          }
        }
        if (result.evictedCount > 0) {
          setRetentionNotice(
            `今日往返已超過 ${MAX_DAILY_ROUND_TRIPS} 筆，已自動清除最舊的 ${result.evictedCount} 筆對話（保留最新 ${MAX_DAILY_ROUND_TRIPS} 筆）。`
          );
        } else {
          setRetentionNotice(null);
        }
        return result.retained;
      });
    },
    []
  );

  const stopBotAudioPlayback = useCallback(() => {
    if (playingAudioRef.current) {
      playingAudioRef.current.pause();
      playingAudioRef.current.currentTime = 0;
      playingAudioRef.current = null;
    }
  }, []);

  const maybeAutoPlay = useCallback(
    (audioUrl: string | null) => {
      if (!audioUrl || !autoPlayAudio) return;
      stopBotAudioPlayback();
      const audio = new Audio(audioUrl);
      playingAudioRef.current = audio;
      audio.onended = () => {
        if (playingAudioRef.current === audio) {
          playingAudioRef.current = null;
        }
      };
      void audio.play().catch(() => {
        // Browser autoplay policy may require manual play on <audio controls>
      });
    },
    [autoPlayAudio, stopBotAudioPlayback]
  );

  const cancelPendingRequest = () => {
    activeRequestAbortRef.current?.abort();
    activeRequestAbortRef.current = null;
    setSending(false);
    setSendingStage('');
  };

  const sendBotMessage = async (textOverride?: string) => {
    const text = (textOverride ?? messageInput).trim();
    if (!text || sending) return;

    const uid = Number.parseInt(userIdInput.trim(), 10);
    const resolvedUserId = Number.isFinite(uid) ? uid : 0;

    if (!textOverride) {
      setMessageInput('');
    }
    setSending(true);
    setSendingStage(voiceReplyEnabled && !text.startsWith('/') ? 'AI 思考與語音合成中...' : '處理中...');
    setStatusError(null);
    setFailedRecordingUrl(null);
    setFailedVoicePayload(null);

    const controller = new AbortController();
    activeRequestAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 35000);

    try {
      const res = await botGuardFetch('/api/bot/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': activeBotId,
          ...buildBotGuardHeaders(),
        },
        signal: controller.signal,
        body: JSON.stringify({
          botId: activeBotId,
          userId: resolvedUserId,
          chatId: resolvedUserId || 123456,
          text,
          isVoice: voiceReplyEnabled,
          _hp: honeypotValue,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        rejected?: boolean;
        blocked?: boolean;
        botBlocked?: boolean;
        challengeRequired?: boolean;
        challenge?: { challengeId: string; question: string };
        reason?: string;
        reply?: string;
        reqId?: string;
        sentences?: string[];
        audioBase64?: string | null;
        audioMimeType?: string | null;
        audioBytes?: number;
        llmMs?: number;
        ttsMs?: number;
        ffmpegMs?: number;
        ttsNote?: string | null;
        logs?: string[];
        elapsedMs?: number;
        error?: string;
      };

      if (!res.ok) {
        if (data.challengeRequired && data.challenge) {
          setHumanChallenge({
            challengeId: data.challenge.challengeId,
            question: data.challenge.question,
            reason: data.reason || data.error || '請完成人機驗證以繼續操作。',
            pendingRetryText: text,
          });
          setChallengeAnswer('');
          setChallengeError(null);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const audioUrl = data.audioBase64
        ? `data:${data.audioMimeType || 'audio/mpeg'};base64,${data.audioBase64}`
        : null;
      const rawChatKey = String(resolvedUserId || 123456);
      const chatKey = activeBotId === 'default' ? rawChatKey : `${activeBotId}:${rawChatKey}`;
      const todayKey = getLocalDayKey();

      if (text === '/reset') {
        ConversationRepository.clear(chatKey);
        createdObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        createdObjectUrlsRef.current.clear();
        setTurns([]);
        setRetentionNotice('已手動清除今日對話紀錄與伺服器多輪記憶。');
      } else {
        const item: ChatTurnItem = {
          id: `${Date.now()}-${crypto.randomUUID()}`,
          userId: resolvedUserId,
          userText: text,
          inputMode: 'text',
          isVoiceReply: voiceReplyEnabled,
          rejected: Boolean(data.rejected),
          blocked: Boolean(data.blocked),
          reply: data.reply,
          reason: data.reason,
          reqId: data.reqId || '-',
          sentences: data.sentences,
          audioUrl,
          audioBytes: data.audioBytes,
          llmMs: data.llmMs,
          ttsMs: data.ttsMs,
          ffmpegMs: data.ffmpegMs,
          ttsNote: data.ttsNote,
          elapsedMs: data.elapsedMs ?? 0,
          dayKey: todayKey,
          createdAt: new Date().toISOString(),
        };
        appendTurnWithRetention(chatKey, item);
      }
      if (Array.isArray(data.logs) && data.logs.length > 0) {
        setLiveLogs((prev) => [...data.logs!, ...prev].slice(0, 120));
      }
      maybeAutoPlay(audioUrl);
      void fetchStatus();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusError('請求等待超時或已取消，請再試一次。');
      } else {
        setStatusError(err instanceof Error ? err.message : 'Failed to execute bot pipeline.');
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequestAbortRef.current === controller) {
        activeRequestAbortRef.current = null;
      }
      setSending(false);
      setSendingStage('');
    }
  };

  const sendVoiceBlob = async (
    blob: Blob,
    fallbackLabel = '語音訊息',
    clientTranscript = '',
    activeLogger: VoiceAudioDiagnosticLogger | null = null
  ) => {
    if (sending) return;
    const uid = Number.parseInt(userIdInput.trim(), 10);
    const resolvedUserId = Number.isFinite(uid) ? uid : 0;

    setSending(true);
    setSendingStage('串流上傳音訊 → ffmpeg 正規化 → 語音辨識 (STT) → AI 回覆中...');
    setStatusError(null);
    setFailedRecordingUrl(null);
    setFailedVoicePayload(null);

    const userAudioUrl = URL.createObjectURL(blob);
    createdObjectUrlsRef.current.add(userAudioUrl);
    const controller = new AbortController();
    activeRequestAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), VOICE_UPLOAD_TIMEOUT_MS);

    activeLogger?.markUploading(blob.size, 'binary_stream');
    const uploadStartedMs = performance.now();

    try {
      const mimeType = blob.type || 'audio/webm';
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-Bot-Id': activeBotId,
        'X-Voice-User-Id': String(resolvedUserId),
        'X-Voice-Chat-Id': String(resolvedUserId || 123456),
        'X-Voice-Mime-Type': mimeType,
        'X-Voice-Is-Voice': String(voiceReplyEnabled),
        ...buildBotGuardHeaders(),
      };
      if (activeLogger) {
        headers['X-Voice-Session-Id'] = activeLogger.getSessionId();
      }
      if (clientTranscript) {
        const b64Transcript = encodeUtf8ToBase64(clientTranscript.slice(0, 1200));
        if (b64Transcript) {
          headers['X-Voice-Client-Transcript-B64'] = b64Transcript;
        }
      }

      // Zero-copy binary upload: eliminates 8x-10x browser FileReader + Base64 + JSON.stringify heap spike
      const res = await botGuardFetch('/api/bot/voice-stream', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: blob,
      });
      const uploadRttMs = Math.round(performance.now() - uploadStartedMs);
      const rawText = await res.text();
      let data: {
        ok?: boolean;
        rejected?: boolean;
        blocked?: boolean;
        botBlocked?: boolean;
        challengeRequired?: boolean;
        challenge?: { challengeId: string; question: string };
        reason?: string;
        transcript?: string;
        reply?: string;
        reqId?: string;
        sentences?: string[];
        audioBase64?: string | null;
        audioMimeType?: string | null;
        audioBytes?: number;
        sttMs?: number;
        llmMs?: number;
        ttsMs?: number;
        ffmpegMs?: number;
        ttsNote?: string | null;
        logs?: string[];
        elapsedMs?: number;
        diagnostics?: {
          normalizeMs?: number;
          totalVoicePipelineMs?: number;
          durationSec?: number | null;
        };
        error?: string;
      } = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText) as typeof data;
        } catch {
          data = {
            error:
              res.status === 413
                ? '錄音檔案體積超過上限，請縮短錄音時間後再試。'
                : `伺服器回應異常（HTTP ${res.status}），請按「重試送出」。`,
          };
        }
      }

      if (!res.ok) {
        if (data.challengeRequired && data.challenge) {
          setHumanChallenge({
            challengeId: data.challenge.challengeId,
            question: data.challenge.question,
            reason: data.reason || data.error || '請完成人機驗證以繼續送出語音。',
            pendingRetryVoice: { blob, label: fallbackLabel, transcript: clientTranscript },
          });
          setChallengeAnswer('');
          setChallengeError(null);
          return;
        }
        setFailedRecordingUrl(userAudioUrl);
        setFailedVoicePayload({ blob, label: fallbackLabel, transcript: clientTranscript });
        const errMessage = data.error || `HTTP ${res.status}`;
        if (activeLogger) {
          activeLogger.recordApiProcessingLatency({
            uploadRttMs,
            ffmpegNormalizeMs: data.diagnostics?.normalizeMs ?? null,
            sttApiMs: data.sttMs ?? null,
            llmApiMs: data.llmMs ?? null,
            ttsApiMs: data.ttsMs ?? null,
            totalPipelineMs: data.diagnostics?.totalVoicePipelineMs ?? uploadRttMs,
          });
          const isApiTimeout =
            res.status === 504 ||
            res.status === 408 ||
            /timed out|timeout|逾時|超時/i.test(errMessage);
          activeLogger.finalize(
            'error',
            `上傳或後端辨識失敗：${errMessage}`,
            isApiTimeout ? 'API_TIMEOUT' : undefined
          );
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          if (diagLoggerRef.current === activeLogger) diagLoggerRef.current = null;
        }
        throw new Error(errMessage);
      }

      const audioUrl = data.audioBase64
        ? `data:${data.audioMimeType || 'audio/mpeg'};base64,${data.audioBase64}`
        : null;
      const rawChatKey = String(resolvedUserId || 123456);
      const chatKey = activeBotId === 'default' ? rawChatKey : `${activeBotId}:${rawChatKey}`;
      const item: ChatTurnItem = {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        userId: resolvedUserId,
        userText: data.transcript || clientTranscript || fallbackLabel,
        inputMode: 'voice',
        userAudioUrl,
        isVoiceReply: voiceReplyEnabled,
        rejected: Boolean(data.rejected),
        blocked: Boolean(data.blocked),
        reply: data.reply,
        reason: data.reason,
        reqId: data.reqId || '-',
        sentences: data.sentences,
        audioUrl,
        audioBytes: data.audioBytes,
        sttMs: data.sttMs,
        llmMs: data.llmMs,
        ttsMs: data.ttsMs,
        ffmpegMs: data.ffmpegMs,
        ttsNote: data.ttsNote,
        elapsedMs: data.elapsedMs ?? 0,
        dayKey: getLocalDayKey(),
        createdAt: new Date().toISOString(),
      };

      appendTurnWithRetention(chatKey, item);
      if (Array.isArray(data.logs) && data.logs.length > 0) {
        setLiveLogs((prev) => [...data.logs!, ...prev].slice(0, 120));
      }
      if (activeLogger) {
        activeLogger.recordApiProcessingLatency({
          uploadRttMs,
          ffmpegNormalizeMs: data.diagnostics?.normalizeMs ?? null,
          sttApiMs: data.sttMs ?? null,
          llmApiMs: data.llmMs ?? null,
          ttsApiMs: data.ttsMs ?? null,
          totalPipelineMs: data.diagnostics?.totalVoicePipelineMs ?? uploadRttMs,
        });
        activeLogger.finalize(
          'completed',
          `錄音與語音管線完成（RTT ${uploadRttMs}ms / ffmpeg ${data.diagnostics?.normalizeMs ?? '-'}ms / STT ${data.sttMs ?? 0}ms / AI ${data.llmMs ?? 0}ms）`
        );
        setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
        if (diagLoggerRef.current === activeLogger) diagLoggerRef.current = null;
      }
      maybeAutoPlay(audioUrl);
      void fetchStatus();
    } catch (err) {
      const uploadRttMs = Math.round(performance.now() - uploadStartedMs);
      if (err instanceof DOMException && err.name === 'AbortError') {
        setFailedRecordingUrl(userAudioUrl);
        setFailedVoicePayload({ blob, label: fallbackLabel, transcript: clientTranscript });
        setStatusError('語音處理等待超時或已取消，你可以直接按下方「重試送出」不需重錄。');
        if (activeLogger && diagLoggerRef.current === activeLogger) {
          activeLogger.recordApiProcessingLatency({ uploadRttMs });
          activeLogger.finalize(
            'error',
            `上傳／語音處理超過 ${Math.round(VOICE_UPLOAD_TIMEOUT_MS / 1000)} 秒逾時或被取消`,
            'UPLOAD_TIMEOUT'
          );
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          diagLoggerRef.current = null;
        }
      } else {
        setStatusError(err instanceof Error ? err.message : '語音處理失敗。');
        if (activeLogger && diagLoggerRef.current === activeLogger) {
          activeLogger.recordApiProcessingLatency({ uploadRttMs });
          activeLogger.finalize(
            'error',
            err instanceof Error ? err.message : '語音處理失敗'
          );
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          diagLoggerRef.current = null;
        }
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequestAbortRef.current === controller) {
        activeRequestAbortRef.current = null;
      }
      setSending(false);
      setSendingStage('');
    }
  };

  const startRecording = async () => {
    if (isRecording || sending) return;
    stopBotAudioPlayback();
    setStatusError(null);
    setFailedRecordingUrl(null);
    setFailedVoicePayload(null);
    setLiveTranscript('');
    liveTranscriptRef.current = '';
    setMicLevel(0);
    setPeakMicLevel(0);

    if (status?.preflight && !status.preflight.ffmpegOk) {
      setStatusError(
        `尚未偵測到 ffmpeg，無法進行語音轉檔。${status.preflight.ffmpegHint}（或先使用下方文字輸入測試）。`
      );
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatusError('目前瀏覽器不支援麥克風錄音，請使用右側「上傳音訊檔」按鈕測試語音問答。');
      return;
    }

    const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || 'audio/webm';
    const logger = new VoiceAudioDiagnosticLogger(mimeType, 32_000, (snap) => {
      setActiveDiagSession(snap);
    });
    diagLoggerRef.current = logger;
    recorderNudgedRef.current = false;

    try {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (selectedMicId) {
        audioConstraints.deviceId = { exact: selectedMicId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;

      // Monitor MediaStreamTrack lifecycle (detects OS/Bluetooth/browser 60s track termination)
      const primaryTrack = stream.getAudioTracks()[0] ?? null;
      activeTrackRef.current = primaryTrack;
      if (primaryTrack) {
        logger.recordTrackEvent('attached', primaryTrack);
        primaryTrack.onmute = () => logger.recordTrackEvent('muted', primaryTrack);
        primaryTrack.onunmute = () => logger.recordTrackEvent('unmuted', primaryTrack);
        primaryTrack.onended = () => {
          logger.recordTrackEvent('ended', primaryTrack);
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            setStatusError(
              '偵測到系統或麥克風裝置中斷音訊輸入，已自動保存並送出目前錄製的內容。'
            );
            try {
              mediaRecorderRef.current.stop();
            } catch {
              cleanupRecordingResources();
              setIsRecording(false);
            }
          }
        };
      }

      // Refresh mic device labels now that permission has been granted
      void loadMicDevices();

      // Start hardened (~8Hz) Web Audio API AnalyserNode with zero-gain pull sink & explicit state monitoring
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          if (ctx.state === 'suspended') {
            await ctx.resume().catch(() => {});
          }
          logger.recordAudioContextInit(ctx);

          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          // Zero-gain pull sink keeps Chromium's audio clock continuously active past 60s without speaker echo
          const silentGain = ctx.createGain();
          silentGain.gain.value = 0;

          source.connect(analyser);
          analyser.connect(silentGain);
          silentGain.connect(ctx.destination);

          audioSourceRef.current = source;
          audioAnalyserRef.current = analyser;
          silentGainRef.current = silentGain;

          ctx.onstatechange = () => {
            logger.recordAudioContextStateChange(ctx.state, ctx.currentTime);
            if (ctx.state === 'suspended' && audioContextRef.current === ctx) {
              void ctx.resume().catch(() => {});
            }
          };

          const timeData = new Uint8Array(analyser.fftSize);
          let lastPct = -1;

          meterTimerRef.current = window.setInterval(() => {
            if (!audioAnalyserRef.current) return;
            try {
              const tRead = performance.now();
              audioAnalyserRef.current.getByteTimeDomainData(timeData);
              logger.recordAnalyserRead(performance.now() - tRead);

              let sumSq = 0;
              for (let i = 0; i < timeData.length; i += 1) {
                const norm = (timeData[i] - 128) / 128;
                sumSq += norm * norm;
              }
              const rms = Math.sqrt(sumSq / timeData.length);
              const pct = Math.min(100, Math.round(rms * 350));
              if (pct !== lastPct) {
                lastPct = pct;
                setMicLevel(pct);
                setPeakMicLevel((prev) => (pct > prev ? pct : prev));
              }
            } catch {
              // ignore analyser read errors during teardown
            }
          }, METER_UPDATE_INTERVAL_MS);
        } catch (audioErr) {
          logger.log(
            'warn',
            'webaudio',
            'AUDIOCONTEXT_INIT_FAILED',
            'Web Audio 音量監測初始化失敗（不影響主錄音）',
            { error: audioErr instanceof Error ? audioErr.message : String(audioErr) }
          );
          teardownWebAudioMeter();
        }
      }

      // Start optional browser live speech captioning (auto-stopped at 55s to avoid Chrome's 60s hard crash/limit)
      const SpeechCtor = getSpeechRecognitionCtor();
      if (SpeechCtor) {
        try {
          const rec = new SpeechCtor();
          rec.lang = 'zh-TW';
          rec.continuous = true;
          rec.interimResults = true;
          let finalized = '';
          rec.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
              const part = event.results[i][0]?.transcript || '';
              if (event.results[i].isFinal) {
                finalized = `${finalized}${part}`.slice(-1800);
              } else {
                interim += part;
              }
            }
            const combined = (finalized + interim).trim().slice(-2000);
            liveTranscriptRef.current = combined;
            setLiveTranscript(combined);
          };
          rec.onerror = () => {
            logger.log('warn', 'speech_api', 'SPEECH_REC_ERROR', '瀏覽器即時字幕異常，已靜默交由後端 STT 處理');
            stopOptionalSpeechRecognition();
          };
          rec.onend = () => {
            speechRecRef.current = null;
          };
          rec.start();
          speechRecRef.current = rec;
        } catch {
          // Ignore if browser blocks SpeechRecognition in iframe
        }
      }

      let recorder: MediaRecorder;
      try {
        // 32 kbps speech-optimized bitrate keeps 3-minute recordings under ~720 KB (prevents browser OOM)
        recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
      } catch {
        recorder = MediaRecorder.isTypeSupported(mimeType)
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      }

      audioChunksRef.current = [];
      recordedBytesRef.current = 0;
      recordingDurationRef.current = 0;
      cancelRecordingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          recordedBytesRef.current += event.data.size;
          const { bufferOverflowDetected } = logger.recordChunk(
            event.data.size,
            audioChunksRef.current.length,
            recordedBytesRef.current
          );
          if (
            (bufferOverflowDetected || recordedBytesRef.current >= MAX_RECORDING_BYTES) &&
            recorder.state === 'recording'
          ) {
            setStatusError('錄音緩衝已達安全上限，系統已自動停止並送出辨識以防止記憶體溢位。');
            try {
              recorder.stop();
            } catch {
              // ignore
            }
          }
        }
      };

      recorder.onerror = (ev) => {
        const errDetail =
          (ev as Event & { error?: { message?: string; name?: string } }).error?.message ||
          (ev as Event & { error?: { name?: string } }).error?.name ||
          'MediaRecorder error';
        logger.log('error', 'mediarecorder', 'RECORDER_ERROR', `MediaRecorder 異常：${errDetail}`);
        logger.finalize('error', `MediaRecorder 異常中斷：${errDetail}`);
        setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
        if (diagLoggerRef.current === logger) diagLoggerRef.current = null;

        cleanupRecordingResources();
        mediaRecorderRef.current = null;
        audioChunksRef.current = [];
        recordedBytesRef.current = 0;
        setIsRecording(false);
        setRecordingSeconds(0);
        setMicLevel(0);
        setStatusError('麥克風錄音器發生異常中斷，已安全停止以避免畫面當機，請重新嘗試錄音。');
      };

      recorder.onstop = () => {
        const capturedTranscript = liveTranscriptRef.current.trim();
        cleanupRecordingResources();
        mediaRecorderRef.current = null;
        setIsRecording(false);
        setRecordingSeconds(0);
        setMicLevel(0);

        if (cancelRecordingRef.current) {
          audioChunksRef.current = [];
          recordedBytesRef.current = 0;
          setLiveTranscript('');
          logger.finalize('cancelled', '使用者手動取消錄音');
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          if (diagLoggerRef.current === logger) diagLoggerRef.current = null;
          return;
        }

        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType,
        });
        audioChunksRef.current = [];
        recordedBytesRef.current = 0;
        setLiveTranscript('');

        if (blob.size > 0) {
          void sendVoiceBlob(blob, '語音錄音', capturedTranscript, logger);
        } else if (capturedTranscript) {
          logger.finalize('completed', '錄音切片為空，改以即時字幕送出');
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          if (diagLoggerRef.current === logger) diagLoggerRef.current = null;
          void sendBotMessage(capturedTranscript);
        } else {
          logger.finalize('error', '錄音內容為空（0 bytes）');
          setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
          if (diagLoggerRef.current === logger) diagLoggerRef.current = null;
          setStatusError('錄音內容為空，請至少說話 1 秒後再點擊「停止並送出語音」。');
        }
      };

      mediaRecorderRef.current = recorder;
      // 1000ms timeslice reduces chunk fragmentation 4x during >1-minute recordings
      recorder.start(1000);
      logger.log('info', 'mediarecorder', 'RECORDER_STARTED', 'MediaRecorder 已啟動（1000ms 切片）', {
        mimeType: recorder.mimeType || mimeType,
        state: recorder.state,
      });

      setIsRecording(true);
      setRecordingSeconds(0);
      let elapsedSec = 0;
      recordTimerRef.current = window.setInterval(() => {
        elapsedSec += 1;
        recordingDurationRef.current = elapsedSec;
        setRecordingSeconds(elapsedSec);

        // Stop optional browser SpeechRecognition before Chrome's 60s session timeout/hang
        if (elapsedSec === SPEECH_REC_SAFE_CUTOFF_SEC) {
          logger.log(
            'info',
            'speech_api',
            'SPEECH_REC_55S_CUTOFF',
            '已達 55 秒安全門檻，主動關閉瀏覽器即時字幕避免 Chrome 60 秒上限中斷'
          );
          stopOptionalSpeechRecognition();
        }

        // Run Buffer Overflow vs Web Audio / MediaRecorder Timeout Watchdog
        const watchdog = logger.sampleWatchdogTick({
          elapsedSec,
          audioContext: audioContextRef.current,
          recorderState: mediaRecorderRef.current?.state ?? 'inactive',
          track: activeTrackRef.current,
          totalChunks: audioChunksRef.current.length,
          totalBytes: recordedBytesRef.current,
        });

        // Isolation guard: if Web Audio API clock stalls, detach ONLY the optional meter so recording never dies!
        if (watchdog.audioClockStalled && audioContextRef.current) {
          teardownWebAudioMeter();
          setMicLevel(0);
        }

        // Recorder stall recovery: nudge once via requestData(), or flush safely if stalled
        if (watchdog.recorderStalled && mediaRecorderRef.current?.state === 'recording') {
          if (!recorderNudgedRef.current) {
            recorderNudgedRef.current = true;
            try {
              mediaRecorderRef.current.requestData();
              logger.log('warn', 'mediarecorder', 'RECORDER_NUDGE_FLUSH', '嘗試呼叫 requestData() 喚醒停滯的錄音串流');
            } catch {
              // ignore
            }
          }
        }

        // Memory pressure guard: auto-stop & submit BEFORE browser OOM kills the tab
        if (watchdog.memoryCritical) {
          setStatusError('偵測到瀏覽器記憶體壓力偏高，系統已自動安全結束錄音並送出辨識，避免應用程式終止。');
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            try {
              mediaRecorderRef.current.stop();
            } catch {
              cleanupRecordingResources();
              setIsRecording(false);
            }
          }
          return;
        }

        // Gracefully auto-stop & submit at 3 minutes so recordings never trigger OOM
        if (elapsedSec >= MAX_RECORDING_SECONDS) {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            try {
              mediaRecorderRef.current.stop();
            } catch {
              cleanupRecordingResources();
              setIsRecording(false);
            }
          }
        }
      }, 1000);
    } catch (err) {
      cleanupRecordingResources();
      logger.finalize(
        'error',
        `啟動麥克風失敗：${err instanceof Error ? err.message : String(err)}`
      );
      setDiagHistory(VoiceAudioDiagnosticLogger.loadHistory());
      if (diagLoggerRef.current === logger) diagLoggerRef.current = null;
      setStatusError(
        err instanceof Error
          ? `無法開啟麥克風（${err.message}）。請允許瀏覽器麥克風權限，或切換麥克風輸入裝置。`
          : '無法開啟麥克風，請確認瀏覽器權限。'
      );
    }
  };

  const stopRecording = (cancel = false) => {
    cancelRecordingRef.current = cancel;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      // Per W3C MediaStream Recording spec, stop() automatically flushes final buffered data
      // without the double-flush race caused by calling requestData() right before stop().
      mediaRecorderRef.current.stop();
    } else {
      cleanupRecordingResources();
      setIsRecording(false);
    }
  };

  const handleAudioFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setStatusError('音訊檔案超過 10 MB 上限，請選擇較短的音訊檔。');
      return;
    }
    void sendVoiceBlob(file, file.name);
  };

  const handleVerifyHumanChallenge = async (e: FormEvent) => {
    e.preventDefault();
    if (!humanChallenge || verifyingChallenge || !challengeAnswer.trim()) return;
    setVerifyingChallenge(true);
    setChallengeError(null);
    try {
      const res = await fetch('/api/bot/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildBotGuardHeaders() },
        body: JSON.stringify({
          challengeId: humanChallenge.challengeId,
          answer: challengeAnswer.trim(),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        token?: string;
        humanToken?: string;
        expiresInSec?: number;
        error?: string;
      };
      const verifiedToken = data.token || data.humanToken || res.headers.get('x-bot-guard-token');
      if (!res.ok || !data.ok || !verifiedToken) {
        setChallengeError(data.error || '驗證失敗，請再試一次。');
        return;
      }
      setBotGuardToken(verifiedToken, data.expiresInSec ?? 900);
      const retryText = humanChallenge.pendingRetryText;
      const retryVoice = humanChallenge.pendingRetryVoice;
      setHumanChallenge(null);
      setChallengeAnswer('');
      setChallengeError(null);
      void fetchStatus();
      if (retryText) {
        window.setTimeout(() => void sendBotMessage(retryText), 900);
      } else if (retryVoice) {
        window.setTimeout(
          () => void sendVoiceBlob(retryVoice.blob, retryVoice.label, retryVoice.transcript),
          900
        );
      }
    } catch (err) {
      setChallengeError(err instanceof Error ? err.message : '驗證連線失敗，請稍後再試。');
    } finally {
      setVerifyingChallenge(false);
    }
  };

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendBotMessage();
  };

  const handleSaveConfig = async (e: FormEvent) => {
    e.preventDefault();
    if (!configForm || savingConfig) return;
    setSavingConfig(true);
    setConfigSavedNotice(null);
    setStatusError(null);

    try {
      const res = await botGuardFetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildBotGuardHeaders() },
        body: JSON.stringify({ ...configForm, _hp: honeypotValue }),
      });
      const data = (await res.json()) as { ok?: boolean; config?: BotConfig; error?: string };
      if (!res.ok || !data.config) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfigForm(data.config);
      setConfigSavedNotice('設定已零停機熱更新，下一則訊息立即生效。');
      void fetchStatus();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update runtime config.');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleRunTests = async () => {
    if (runningTests) return;
    setRunningTests(true);
    setRightTab('tests');
    setStatusError(null);
    try {
      const res = await botGuardFetch('/api/bot/run-tests', {
        method: 'POST',
        headers: { ...buildBotGuardHeaders() },
      });
      const data = (await res.json()) as TestRunResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setTestResult(data);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to execute test suite.');
    } finally {
      setRunningTests(false);
    }
  };

  const handleDownloadCompleteZip = async () => {
    if (downloadingZip) return;
    setDownloadingZip(true);
    setStatusError(null);
    setCopiedDownloadUrl(false);

    const staticUrl = `${window.location.origin}/api/download/complete-zip`;
    try {
      const res = await fetch('/api/download/complete-zip', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`下載失敗（HTTP ${res.status}）`);
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error('伺服器回傳了 HTML 而非 ZIP 壓縮檔，請確認後端服務已啟動。');
      }

      const blob = await res.blob();
      if (blob.size < 1024) {
        throw new Error('壓縮檔內容異常過小，請重新整理後再試。');
      }
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = 'web-voice-bot-complete.zip';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      const fileCount = res.headers.get('x-zip-file-count');
      setDownloadNotice({
        sizeLabel: fileCount ? `${formatKb(blob.size)} · ${fileCount} 檔` : formatKb(blob.size),
        url: staticUrl,
      });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : '無法下載壓縮檔，請稍後再試。');
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleSelectTargetOs = (osChoice: RuntimeOs) => {
    setTargetOs(osChoice);
    setCopiedCommands(false);
    try {
      window.localStorage.setItem(OS_STORAGE_KEY, osChoice);
    } catch {
      // ignore storage errors
    }
  };

  const handleCopyOsCommands = async () => {
    const guide = RUNTIME_GUIDES[targetOs];
    const text = `# ${guide.label} (${guide.shellName})\n# 1. 安裝系統依賴\n${guide.prereqCmd}\n\n# 2. 一鍵啟動（解壓縮進 web-voice-bot-complete 後執行）\n${guide.quickStartCmd}\n\n# 或手動步驟：\n${guide.manualCmds}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCommands(true);
      window.setTimeout(() => setCopiedCommands(false), 2500);
    } catch {
      setStatusError('無法自動複製指令，請直接選取下方程式碼區塊複製。');
    }
  };

  const handleDownloadLauncherScript = async () => {
    if (downloadingLauncher) return;
    setDownloadingLauncher(true);
    setStatusError(null);
    const guide = RUNTIME_GUIDES[targetOs];
    try {
      const res = await fetch(`/api/download/launcher/${targetOs}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`無法下載 ${guide.scriptName}（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = guide.scriptName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 8000);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : '下載啟動腳本失敗。');
    } finally {
      setDownloadingLauncher(false);
    }
  };

  const handleCopyDownloadUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedDownloadUrl(true);
      window.setTimeout(() => setCopiedDownloadUrl(false), 2500);
    } catch {
      setStatusError(`無法自動複製，請手動複製此網址下載：${url}`);
    }
  };

  const activeGuide = RUNTIME_GUIDES[targetOs];

  const preflightIssues: string[] = [];
  if (status?.preflight) {
    if (!status.preflight.nodeOk) {
      preflightIssues.push(`Node.js 版本過舊（目前 ${status.preflight.nodeVersion}，需 20+）。`);
    }
    if (!status.preflight.pythonOk) {
      preflightIssues.push(status.preflight.pythonHint);
    }
    if (status.preflight.apiKeyState !== 'ready') {
      preflightIssues.push(status.preflight.apiKeyHint);
    }
    if (!status.preflight.ffmpegOk) {
      preflightIssues.push(status.preflight.ffmpegHint);
    }
  }

  return (
    <div className="space-y-6">
      {/* Runtime Health & Branch Strip */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              Web Voice Bot
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              免 Telegram 與 BotFather Token——支援 Windows 11 與 Linux 雙平台，直接在網頁使用 Python 語音核心（麥克風辨識、多輪記憶、Edge-TTS 與{' '}
              <code className="text-xs">ffmpeg -threads 1</code>）。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {/* Target OS Selector: Windows vs Linux */}
            <div
              role="group"
              aria-label="選擇執行環境"
              className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-lg shrink-0"
            >
              <button
                type="button"
                onClick={() => {
                  handleSelectTargetOs('windows');
                  setRightTab('env');
                }}
                aria-pressed={targetOs === 'windows'}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  targetOs === 'windows'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Windows 11</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  handleSelectTargetOs('linux');
                  setRightTab('env');
                }}
                aria-pressed={targetOs === 'linux'}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  targetOs === 'linux'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Server className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Linux</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => void handleDownloadCompleteZip()}
              disabled={downloadingZip}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {downloadingZip ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{downloadingZip ? '下載中...' : '下載完整專案 (.zip)'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRunTests()}
              disabled={runningTests}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningTests ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{runningTests ? 'Running CI Suite...' : 'Run pytest + ruff + mypy'}</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchStatus()}
              disabled={loadingStatus}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-slate-500 ${loadingStatus ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Unboxed tabular runtime summary */}
        {status && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600 font-mono tabular-nums">
            <span>Host {status.hostOs === 'windows' ? 'Windows' : 'Linux'}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>Target {activeGuide.label}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>Python {status.pythonVersion}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>TTS {status.config.TTS_PROVIDER} ({status.config.TTS_VOICE})</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>ffmpeg {status.ffmpegAvailable ? 'OK' : 'missing'}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              Redis fail-open {status.redisFailOpenOk ? `OK (${status.redisCheckMs}ms)` : 'error'}
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              Memory {status.memoryStats.totalMessages} msgs / {status.memoryStats.activeChats} chat(s)
            </span>
            {status.deploymentProfile && (
              <>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span
                  className={
                    status.deploymentProfile.mode === 'constrained_1c1g'
                      ? 'text-amber-700 font-semibold'
                      : 'text-emerald-700 font-semibold'
                  }
                >
                  {status.deploymentProfile.mode === 'constrained_1c1g'
                    ? `1C/1G 保護模式 (${status.deploymentProfile.resources.effective_available_ram_mb}MB · 1 Bot)`
                    : `高併發模式 (${status.deploymentProfile.resources.effective_available_ram_mb}MB · ${status.activeBots?.length ?? 1}/${status.deploymentProfile.max_bots} Bots)`}
                </span>
              </>
            )}
            {status.botGuard && (
              <>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span className="text-slate-700">
                  防惡意機器人 {status.botGuard.enabled ? 'ON' : 'OFF'}
                  {status.botGuard.blockedTotal > 0
                    ? ` (攔截 ${status.botGuard.blockedTotal})`
                    : ''}
                </span>
              </>
            )}
          </div>
        )}

        {/* Actionable Preflight Guardrail Alert (only shown if a real setup issue exists) */}
        {preflightIssues.length > 0 && (
          <div
            role="alert"
            className="mt-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5 text-xs text-amber-950"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                <span>啟動防呆檢查偵測到 {preflightIssues.length} 項未完成設定</span>
              </div>
              <button
                type="button"
                onClick={() => setRightTab('env')}
                className="text-xs font-medium text-amber-900 underline hover:text-amber-700 whitespace-nowrap cursor-pointer"
              >
                查看修復步驟
              </button>
            </div>
            <ul className="pl-6 list-disc space-y-1 text-amber-900">
              {preflightIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}

        {downloadNotice && (
          <div
            role="status"
            className="mt-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-emerald-900"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-0.5 min-w-0">
                <p className="font-semibold">
                  已觸發下載 <span className="font-mono">web-voice-bot-complete.zip</span>（{downloadNotice.sizeLabel}）
                </p>
                <p className="text-emerald-800/90">
                  若預覽視窗攔截自動下載，可點右側「開新分頁下載」或「複製網址」到瀏覽器新分頁下載（亦可切至 Email Patch 分頁寄到信箱）。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={downloadNotice.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-white border border-emerald-300 hover:bg-emerald-100/60 rounded-md transition-colors whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>開新分頁下載</span>
              </a>
              <button
                type="button"
                onClick={() => void handleCopyDownloadUrl(downloadNotice.url)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                {copiedDownloadUrl ? (
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{copiedDownloadUrl ? '已複製網址' : '複製網址'}</span>
              </button>
              <button
                type="button"
                onClick={() => setDownloadNotice(null)}
                aria-label="關閉下載通知"
                className="p-1 text-emerald-700 hover:text-emerald-900 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {recoveredCrashSession && (
          <div
            role="alert"
            className="mt-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-950"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-0.5 min-w-0">
                <p className="font-semibold">
                  偵測到上一次錄音異常終止 — 診斷判定：
                  {VERDICT_LABELS_ZH[recoveredCrashSession.verdict].label}
                </p>
                <p className="text-amber-900/90">{recoveredCrashSession.verdictReason}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowDiagModal(true)}
                className="px-3 py-1.5 text-xs font-medium text-amber-950 bg-white border border-amber-300 hover:bg-amber-100/70 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                檢視錄音診斷紀錄
              </button>
              <button
                type="button"
                onClick={() => setRecoveredCrashSession(null)}
                aria-label="關閉異常還原通知"
                className="p-1 text-amber-700 hover:text-amber-950 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {humanChallenge && (
          <form
            onSubmit={handleVerifyHumanChallenge}
            role="alert"
            className="mt-4 px-4 py-3 bg-amber-50 border border-amber-300 rounded-lg space-y-2.5 text-xs sm:text-sm text-amber-950"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="font-semibold">防惡意機器人驗證（人機識別）</p>
                  <p className="text-xs text-amber-900 mt-0.5">{humanChallenge.reason}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setHumanChallenge(null);
                  setChallengeError(null);
                }}
                aria-label="關閉人機驗證"
                className="text-amber-700 hover:text-amber-950 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <span className="font-mono font-semibold text-slate-900 bg-white border border-amber-200 px-2.5 py-1 rounded">
                {humanChallenge.question}
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={challengeAnswer}
                onChange={(e) => setChallengeAnswer(e.target.value)}
                placeholder="輸入答案"
                aria-label="人機驗證答案"
                className="w-28 h-8 px-2.5 text-xs font-mono bg-white border border-amber-300 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
              />
              <button
                type="submit"
                disabled={verifyingChallenge || !challengeAnswer.trim()}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                {verifyingChallenge ? '驗證中...' : '確認並繼續'}
              </button>
            </div>
            {challengeError && <p className="pl-6 text-xs text-red-700 font-medium">{challengeError}</p>}
          </form>
        )}

        {statusError && (
          <div
            role="alert"
            className="mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg space-y-2.5 text-xs sm:text-sm text-red-800"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{statusError}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStatusError(null);
                  setFailedRecordingUrl(null);
                }}
                aria-label="Dismiss error"
                className="text-red-600 hover:text-red-800 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {failedRecordingUrl && (
              <div className="pl-6 space-y-2">
                <p className="text-xs text-red-700 font-medium">
                  回聽剛剛的錄音（確認麥克風是否有收到聲音）：
                </p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <audio controls src={failedRecordingUrl} className="w-full max-w-md h-8" />
                  {failedVoicePayload && !sending && (
                    <button
                      type="button"
                      onClick={() =>
                        void sendVoiceBlob(
                          failedVoicePayload.blob,
                          failedVoicePayload.label,
                          failedVoicePayload.transcript
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>重試送出</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Main Two-Pane Web Messenger + Admin Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Pane: Custom Web Voice Bot Messenger */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          {/* Messenger Header Bar */}
          <div className="px-5 py-3.5 border-b border-slate-200 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  Web Bot Chat
                </h2>
                <p className="text-xs text-slate-500">
                  支援麥克風即時收音（音量表＋即時字幕）、音訊檔上傳、文字與指令 ·{' '}
                  <span className="font-mono text-slate-700">
                    今日保留 {turns.length}/{MAX_DAILY_ROUND_TRIPS} 往返（重啟不遺失，超過{' '}
                    {MAX_DAILY_ROUND_TRIPS} 筆自動清除最舊）
                  </span>
                </p>
                {retentionNotice && (
                  <p className="mt-1 text-xs text-blue-700 font-medium">{retentionNotice}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                {/* Inline Bot switcher (only rendered when >= 2 bots are active, preserving default single-bot UI) */}
                {status?.activeBots && status.activeBots.length >= 2 && (
                  <div className="inline-flex items-center gap-1.5 text-slate-600">
                    <label htmlFor="active-bot-selector" className="text-slate-500">
                      Bot
                    </label>
                    <select
                      id="active-bot-selector"
                      value={activeBotId}
                      onChange={(e) => setActiveBotId(e.target.value)}
                      className="h-8 px-2 font-mono text-xs bg-blue-50/70 border border-blue-200 rounded-md text-blue-900 focus:outline-none focus:bg-white focus:border-blue-600 cursor-pointer"
                    >
                      {status.activeBots.map((bot) => (
                        <option key={bot.botId} value={bot.botId}>
                          {bot.name} ({bot.botId})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* User ID quick switcher for allowlist testing */}
                <div className="inline-flex items-center gap-1.5 text-slate-600">
                  <label htmlFor="bot-user-id" className="sr-only">
                    User ID
                  </label>
                  <span className="text-slate-500">ID</span>
                  <input
                    id="bot-user-id"
                    type="text"
                    value={userIdInput}
                    onChange={(e) => setUserIdInput(e.target.value)}
                    className="w-20 h-8 px-2 font-mono text-xs bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setUserIdInput(userIdInput === '123456' ? '999999' : '123456')}
                    className="px-2 py-1 text-[11px] font-mono text-slate-600 hover:text-blue-700 border border-slate-200 rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
                    title="切換授權帳號 (123456) 與未授權帳號 (999999) 測試白名單"
                  >
                    {userIdInput === '123456' ? '測未授權' : '切回授權'}
                  </button>
                </div>

                {/* Voice reply mode toggle */}
                <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-md">
                  <button
                    type="button"
                    onClick={() => setVoiceReplyEnabled(true)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                      voiceReplyEnabled ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    語音+文字
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoiceReplyEnabled(false)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                      !voiceReplyEnabled ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    純文字
                  </button>
                </div>

                {/* Auto-play toggle */}
                {voiceReplyEnabled && (
                  <button
                    type="button"
                    onClick={() => setAutoPlayAudio((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      autoPlayAudio
                        ? 'text-blue-700 border-blue-200 bg-blue-50/70'
                        : 'text-slate-600 border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                    title="收到語音回覆時自動播放"
                  >
                    {autoPlayAudio ? (
                      <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>自動播音</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void sendBotMessage('/reset')}
                  disabled={sending}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>/reset</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowDiagModal(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50/50 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                  title="檢視 >60 秒語音串流、WebSocket 緩衝區狀態與 API 處理延遲診斷紀錄"
                >
                  <Activity className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>檢視錄音診斷紀錄</span>
                </button>
              </div>
            </div>

            {/* Microphone Input Device Selector */}
            {micDevices.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Mic className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                <label htmlFor="mic-device-select" className="text-slate-500 whitespace-nowrap">
                  麥克風裝置
                </label>
                <select
                  id="mic-device-select"
                  value={selectedMicId}
                  onChange={(e) => setSelectedMicId(e.target.value)}
                  disabled={isRecording}
                  className="flex-1 max-w-sm h-7 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:border-blue-600"
                >
                  <option value="">系統預設麥克風</option>
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Conversation Viewport */}
          <div className="p-5 min-h-[380px] max-h-[540px] overflow-y-auto space-y-5 bg-slate-50/50">
            {turns.length === 0 ? (
              <div className="py-10 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center mx-auto">
                  <Mic className="w-5 h-5 text-blue-600" aria-hidden="true" />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-slate-900">
                    直接對你的 Web Voice Bot 說話或輸入訊息
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                    點擊下方麥克風按鈕開始錄音（畫面會即時顯示音量條與語音字幕），說完後按「停止並送出語音」，後端會以{' '}
                    <code className="font-mono text-slate-700">ffmpeg 16kHz WAV</code> 正規化後進行精準辨識並合成語音回覆。
                  </p>
                </div>

                {/* Slash command quick triggers */}
                <div className="pt-1 flex flex-wrap items-center justify-center gap-2 text-xs">
                  {QUICK_COMMANDS.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      onClick={() => void sendBotMessage(cmd)}
                      disabled={sending}
                      className="px-2.5 py-1 font-mono text-xs text-slate-700 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-700 rounded-md transition-colors cursor-pointer"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="space-y-2.5">
                  {/* User bubble */}
                  <div className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tr-sm bg-slate-900 text-white text-sm space-y-2">
                      <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-slate-300">
                        <span>
                          {turn.inputMode === 'voice' ? '語音訊息 (STT)' : '文字訊息'} · uid={turn.userId}
                        </span>
                        {turn.sttMs ? <span className="tabular-nums">STT {turn.sttMs}ms</span> : null}
                      </div>

                      {turn.userAudioUrl && (
                        <audio controls src={turn.userAudioUrl} className="w-full h-8" />
                      )}

                      <p className="whitespace-pre-wrap leading-relaxed">{turn.userText}</p>
                    </div>
                  </div>

                  {/* Bot reply or rejection */}
                  {turn.rejected ? (
                    <div className="max-w-[90%] px-4 py-3 rounded-2xl rounded-tl-sm bg-red-50 border border-red-200 text-xs text-red-800 space-y-1">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <AlertCircle className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
                        <span>已攔截未授權存取</span>
                      </div>
                      <p>{turn.reason}</p>
                      <div className="font-mono tabular-nums text-[11px] text-red-700/80">
                        req={turn.reqId} · {turn.elapsedMs}ms
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`max-w-[92%] px-4 py-3 rounded-2xl rounded-tl-sm text-sm space-y-2.5 ${
                        turn.blocked
                          ? 'bg-amber-50 border border-amber-200 text-amber-950'
                          : 'bg-white border border-slate-200 text-slate-800'
                      }`}
                    >
                      {turn.blocked && (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                          <ShieldCheck className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                          <span>Prompt Injection 安全攔截（零模型消耗・不寫入記憶）</span>
                        </div>
                      )}
                      <p className="whitespace-pre-wrap leading-relaxed">{turn.reply}</p>

                      {turn.ttsNote && (
                        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800">
                          {turn.ttsNote}
                        </div>
                      )}

                      {turn.audioUrl && (
                        <div className="pt-1">
                          <audio controls src={turn.audioUrl} className="w-full h-9" />
                        </div>
                      )}

                      <div className="pt-1.5 border-t border-slate-100 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-500">
                        <span>req={turn.reqId}</span>
                        {turn.sttMs ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>STT {turn.sttMs}ms</span>
                          </>
                        ) : null}
                        {turn.llmMs ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>AI {turn.llmMs}ms</span>
                          </>
                        ) : null}
                        {turn.audioBytes ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>TTS {turn.ttsMs}ms</span>
                            <span aria-hidden="true">·</span>
                            <span>ffmpeg {turn.ffmpegMs}ms</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatKb(turn.audioBytes)}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>total {turn.elapsedMs}ms</span>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}

            {sending && (
              <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white border border-slate-200 rounded-2xl rounded-tl-sm max-w-md text-xs text-slate-600">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
                  <span className="truncate">{sendingStage || '處理中...'}</span>
                  <span className="font-mono tabular-nums text-slate-400 shrink-0">
                    {sendingElapsedSec}s
                  </span>
                </div>
                <button
                  type="button"
                  onClick={cancelPendingRequest}
                  className="text-xs font-medium text-slate-500 hover:text-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  取消
                </button>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input Composer with Live Volume Meter, Live Caption & Audio Upload */}
          <div className="p-4 border-t border-slate-200 bg-white space-y-3">
            {/* Quick Prompts (unboxed quiet links) */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
              <span>快速試問：</span>
              {QUICK_PROMPTS.map((prompt, idx) => (
                <span key={prompt} className="inline-flex items-center gap-2.5">
                  {idx > 0 && (
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void sendBotMessage(prompt)}
                    disabled={sending || isRecording}
                    className="text-slate-700 hover:text-blue-700 hover:underline transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                </span>
              ))}
            </div>

            {isRecording ? (
              <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 text-sm text-red-800">
                    <Mic className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                    <span className="font-medium">錄音中</span>
                    <span className="font-mono tabular-nums text-xs text-red-700">
                      {formatDuration(recordingSeconds)} / {formatDuration(MAX_RECORDING_SECONDS)}
                    </span>
                  </div>

                  {/* Real-time live audio level meter */}
                  <div className="flex items-center gap-2 flex-1 min-w-[140px] max-w-[220px]">
                    <span className="text-[11px] text-red-700 shrink-0">音量</span>
                    <div className="flex-1 h-2 bg-red-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-75 ${
                          micLevel > 8 ? 'bg-emerald-500' : 'bg-red-300'
                        }`}
                        style={{ width: `${Math.max(4, micLevel)}%` }}
                      />
                    </div>
                    <span className="font-mono tabular-nums text-[11px] text-red-700 w-8 text-right">
                      {micLevel}%
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => stopRecording(true)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>取消</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => stopRecording(false)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors cursor-pointer"
                    >
                      <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                      <span>停止並送出語音</span>
                    </button>
                  </div>
                </div>

                {liveTranscript && (
                  <p className="text-xs text-slate-800 bg-white/80 border border-red-100 rounded px-2.5 py-1.5">
                    即時字幕：{liveTranscript}
                  </p>
                )}

                {recordingSeconds >= RECORDING_WARN_SECONDS && (
                  <p className="text-xs text-amber-800 font-medium">
                    提醒：即將達單次錄音上限（3 分鐘），剩餘{' '}
                    {Math.max(0, MAX_RECORDING_SECONDS - recordingSeconds)}{' '}
                    秒後將自動停止並送出辨識。
                  </p>
                )}

                {recordingSeconds >= SPEECH_REC_SAFE_CUTOFF_SEC &&
                  recordingSeconds < RECORDING_WARN_SECONDS && (
                    <p className="text-xs text-slate-600">
                      長時錄音穩定模式已啟用（32kbps 低記憶體編碼持續收音中，停止後將由後端進行完整語音辨識）。
                    </p>
                  )}

                {recordingSeconds >= 2 && peakMicLevel < 5 && (
                  <p className="text-xs text-red-700">
                    提醒：目前音量條維持在 0%，麥克風可能處於靜音或選錯輸入裝置，請檢查上方「麥克風裝置」選單。
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={handleChatSubmit} className="flex items-center gap-2">
                {/* Invisible honeypot field to catch automated form-filling bots */}
                <input
                  type="text"
                  name="website_url"
                  value={honeypotValue}
                  onChange={(e) => setHoneypotValue(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="sr-only"
                />
                {/* Microphone button */}
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  disabled={sending}
                  aria-label="錄製語音訊息"
                  title="點擊開始錄音，完成後自動轉文字並回覆語音"
                  className="inline-flex items-center justify-center h-10 w-10 text-slate-700 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 border border-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Mic className="w-4 h-4" aria-hidden="true" />
                </button>

                {/* Audio file upload fallback */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={handleAudioFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  aria-label="上傳音訊檔"
                  title="上傳音訊檔（.mp3 / .wav / .webm / .m4a）進行語音辨識與回覆"
                  className="inline-flex items-center justify-center h-10 w-10 text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" aria-hidden="true" />
                </button>

                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="輸入訊息或 /指令（例如 /status、/reset）..."
                  aria-label="Message to Web Voice Bot"
                  className="flex-1 min-w-0 h-10 px-3.5 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />

                <button
                  type="submit"
                  disabled={sending || !messageInput.trim()}
                  className="inline-flex items-center gap-2 h-10 px-4 sm:px-5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>送出</span>
                </button>
              </form>
            )}
          </div>
        </section>

        {/* Right Pane: Issue #22 Dynamic Admin Config, Live Redacted Logs & CI Runner */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setRightTab('env')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  rightTab === 'env' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                {targetOs === 'windows' ? (
                  <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <Server className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>執行環境</span>
              </button>
              <button
                type="button"
                onClick={() => setRightTab('config')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  rightTab === 'config' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Config</span>
              </button>
              <button
                type="button"
                onClick={() => setRightTab('logs')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  rightTab === 'logs' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Logs ({liveLogs.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setRightTab('tests')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  rightTab === 'tests' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                <span>CI Suite</span>
              </button>
            </div>
          </div>

          {rightTab === 'env' && (
            <div className="p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    選擇你的本機執行環境
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    同一套專案同時支援 Windows 11 與 Linux，切換後立即顯示對應指令與啟動腳本。
                  </p>
                </div>
                <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-lg">
                  <button
                    type="button"
                    onClick={() => handleSelectTargetOs('windows')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      targetOs === 'windows'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Windows 11</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTargetOs('linux')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      targetOs === 'linux'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Server className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Linux</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-slate-500">目前選擇環境</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5">
                    {activeGuide.label} ({activeGuide.shellName})
                  </div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-slate-500">Python 虛擬環境路徑</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5 truncate" title={activeGuide.venvPythonPath}>
                    {activeGuide.venvPythonPath}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-slate-700">1. 系統依賴（{activeGuide.label}）</div>
                <p className="text-xs text-slate-500">{activeGuide.prereqNote}</p>
                <pre className="p-2.5 bg-slate-900 text-slate-100 rounded-md text-xs font-mono overflow-x-auto">
                  {activeGuide.prereqCmd}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-slate-700">
                  2. 一鍵啟動（{activeGuide.scriptName}）
                </div>
                <pre className="p-2.5 bg-slate-900 text-emerald-300 rounded-md text-xs font-mono overflow-x-auto">
                  {activeGuide.quickStartCmd}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-slate-700">或手動逐步執行</div>
                <pre className="p-2.5 bg-slate-50 border border-slate-200 text-slate-800 rounded-md text-xs font-mono overflow-x-auto leading-relaxed">
                  {activeGuide.manualCmds}
                </pre>
              </div>

              <p className="text-xs text-slate-600 bg-blue-50/70 border border-blue-200/80 rounded-md px-3 py-2">
                {activeGuide.micNote}
              </p>

              {/* Real-time Admin Preflight & Security Guardrails Checklist */}
              {status?.preflight && (
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                      <span>管理員防呆與安全檢核</span>
                    </div>
                    <code className="text-[11px] font-mono text-slate-500">npm run doctor</code>
                  </div>
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                    {[
                      {
                        label: 'Node.js 20+',
                        ok: status.preflight.nodeOk,
                        value: status.preflight.nodeVersion,
                      },
                      {
                        label: 'Python 虛擬環境',
                        ok: status.preflight.pythonOk,
                        value: status.preflight.pythonOk ? `Python ${status.pythonVersion}` : '未就緒',
                      },
                      {
                        label: 'ffmpeg 語音引擎',
                        ok: status.preflight.ffmpegOk,
                        value: status.preflight.ffmpegOk ? '已安裝' : '缺少',
                      },
                      {
                        label: 'GEMINI_API_KEY (.env)',
                        ok: status.preflight.apiKeyState === 'ready',
                        value:
                          status.preflight.apiKeyState === 'ready'
                            ? '格式正常（僅後端讀取）'
                            : status.preflight.apiKeyState === 'placeholder'
                              ? '仍是範例佔位字'
                              : status.preflight.apiKeyState === 'invalid_format'
                                ? '格式異常'
                                : '尚未設定',
                      },
                      {
                        label: 'Git 防金鑰外洩 Hook',
                        ok: status.preflight.gitGuardAvailable,
                        value: status.preflight.gitGuardAvailable ? '.githooks/pre-commit 就緒' : '未設定',
                      },
                      {
                        label: 'Prompt Injection 防護',
                        ok: Boolean(status.preflight.promptGuardActive),
                        value: status.preflight.promptGuardActive
                          ? '已啟用（輸入攔截 + 隔離標籤 + 限流）'
                          : '未啟用',
                      },
                    ].map((row) => (
                      <div
                        key={row.label}
                        className="px-3 py-2 flex items-center justify-between gap-3 bg-white"
                      >
                        <span className="text-slate-700">{row.label}</span>
                        <span
                          className={`font-mono tabular-nums text-[11px] font-medium ${
                            row.ok ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {row.ok ? 'OK' : '需處理'} · {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleCopyOsCommands()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  {copiedCommands ? (
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{copiedCommands ? '已複製指令' : `複製 ${activeGuide.shortLabel} 指令`}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleDownloadLauncherScript()}
                  disabled={downloadingLauncher}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>下載 {activeGuide.scriptName}</span>
                </button>
              </div>
            </div>
          )}

          {rightTab === 'config' && configForm && (
            <form onSubmit={handleSaveConfig} className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                零停機熱更新設定（Issue #22）。可即時切換台灣中文／英文語音，或將{' '}
                <code className="font-mono">TTS_PROVIDER</code> 改為{' '}
                <code className="font-mono">openai</code> 測試無金鑰自動降級純文字保護。
              </p>

              {configSavedNotice && (
                <div className="px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-md flex items-center gap-2 text-xs text-emerald-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>{configSavedNotice}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    ALLOWED_USER_IDS (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={configForm.ALLOWED_USER_IDS}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, ALLOWED_USER_IDS: e.target.value })
                    }
                    className="w-full h-9 px-3 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    TTS_PROVIDER (#25)
                  </label>
                  <select
                    value={configForm.TTS_PROVIDER}
                    onChange={(e) => setConfigForm({ ...configForm, TTS_PROVIDER: e.target.value })}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600"
                  >
                    <option value="edge">edge (EdgeTTSProvider)</option>
                    <option value="openai">openai (OpenAITTSProvider)</option>
                    <option value="piper">piper (PiperTTSProvider)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">TTS_VOICE</label>
                  <select
                    value={configForm.TTS_VOICE}
                    onChange={(e) => setConfigForm({ ...configForm, TTS_VOICE: e.target.value })}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600"
                  >
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    CONVERSATION_MAX_TURNS (#26)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={configForm.CONVERSATION_MAX_TURNS}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        CONVERSATION_MAX_TURNS: Number(e.target.value),
                      })
                    }
                    className="w-full h-9 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded-md text-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    BOT_QUEUE_MAXSIZE (#24)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={configForm.BOT_QUEUE_MAXSIZE}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        BOT_QUEUE_MAXSIZE: Number(e.target.value),
                      })
                    }
                    className="w-full h-9 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded-md text-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    TTS_TIMEOUT_SEC
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={configForm.TTS_TIMEOUT_SEC}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        TTS_TIMEOUT_SEC: Number(e.target.value),
                      })
                    }
                    className="w-full h-9 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded-md text-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    FFMPEG_TIMEOUT_SEC
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={configForm.FFMPEG_TIMEOUT_SEC}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        FFMPEG_TIMEOUT_SEC: Number(e.target.value),
                      })
                    }
                    className="w-full h-9 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded-md text-slate-900"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingConfig}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
                >
                  {savingConfig ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>套用設定</span>
                </button>
              </div>

              {/* Adaptive Resource Mode & Multi-Bot High-Concurrency Management (Unified Single Website) */}
              {status?.deploymentProfile && (
                <div className="pt-4 mt-4 border-t border-slate-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-slate-800">
                        自適應資源與多 Bot 高併發池（單一網站共用）
                      </h3>
                      <p className="text-[11px] text-slate-500 font-mono">
                        {status.deploymentProfile.tier} · 可用{' '}
                        {status.deploymentProfile.resources.effective_available_ram_mb} MB RAM /{' '}
                        {status.deploymentProfile.resources.effective_cpu_cores} vCPU · FFmpeg×
                        {status.deploymentProfile.ffmpeg_concurrency} · TTS×
                        {status.deploymentProfile.tts_concurrency}
                      </p>
                    </div>
                  </div>

                  {botManageNotice && (
                    <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-700">
                      {botManageNotice}
                    </div>
                  )}

                  {status.deploymentProfile.mode === 'constrained_1c1g' ? (
                    <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
                      偵測到伺服器可用記憶體 ≤ 1 GB，已鎖定為 1 核心 CPU / 1 GB RAM 單一 Bot 保護模式，不開放新增第二個 Bot 以避免記憶體溢位。
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="space-y-1.5">
                        {(status.activeBots ?? []).map((bot) => (
                          <div
                            key={bot.botId}
                            className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs"
                          >
                            <div className="min-w-0">
                              <span className="font-medium text-slate-900">{bot.name}</span>{' '}
                              <span className="font-mono text-[11px] text-slate-500">
                                ({bot.botId} · {bot.ttsVoice})
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => setActiveBotId(bot.botId)}
                                className={`px-2 py-1 text-[11px] rounded border cursor-pointer ${
                                  activeBotId === bot.botId
                                    ? 'bg-blue-600 text-white border-blue-600'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                {activeBotId === bot.botId ? '目前對話' : '切換'}
                              </button>
                              {bot.botId !== 'default' && (
                                <button
                                  type="button"
                                  disabled={managingBots}
                                  onClick={async () => {
                                    setManagingBots(true);
                                    setBotManageNotice(null);
                                    try {
                                      const res = await botGuardFetch('/api/bot/bots', {
                                        method: 'POST',
                                        headers: {
                                          'Content-Type': 'application/json',
                                          ...buildBotGuardHeaders(),
                                        },
                                        body: JSON.stringify({
                                          action: 'remove',
                                          botId: bot.botId,
                                          _hp: honeypotValue,
                                        }),
                                      });
                                      const d = (await res.json()) as {
                                        ok?: boolean;
                                        error?: string;
                                      };
                                      if (!res.ok || d.ok === false) {
                                        throw new Error(d.error || `HTTP ${res.status}`);
                                      }
                                      if (activeBotId === bot.botId) setActiveBotId('default');
                                      setBotManageNotice(`已移除 Bot「${bot.name}」。`);
                                      await fetchStatus();
                                    } catch (err) {
                                      setBotManageNotice(
                                        err instanceof Error ? err.message : '移除 Bot 失敗'
                                      );
                                    } finally {
                                      setManagingBots(false);
                                    }
                                  }}
                                  className="px-2 py-1 text-[11px] text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded cursor-pointer"
                                >
                                  移除
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      {(status.activeBots?.length ?? 1) < status.deploymentProfile.max_bots && (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            placeholder="新 Bot 名稱（例：客服助手）"
                            value={newBotName}
                            onChange={(e) => setNewBotName(e.target.value)}
                            className="flex-1 min-w-[140px] h-8 px-2.5 text-xs bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600"
                          />
                          <select
                            value={newBotVoice}
                            onChange={(e) => setNewBotVoice(e.target.value)}
                            className="h-8 px-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md text-slate-900"
                          >
                            {VOICE_OPTIONS.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={managingBots}
                            onClick={async () => {
                              setManagingBots(true);
                              setBotManageNotice(null);
                              try {
                                const res = await botGuardFetch('/api/bot/bots', {
                                  method: 'POST',
                                  headers: {
                                    'Content-Type': 'application/json',
                                    ...buildBotGuardHeaders(),
                                  },
                                  body: JSON.stringify({
                                    action: 'add',
                                    name: newBotName.trim() || undefined,
                                    ttsVoice: newBotVoice,
                                    _hp: honeypotValue,
                                  }),
                                });
                                const d = (await res.json()) as {
                                  ok?: boolean;
                                  botId?: string;
                                  error?: string;
                                };
                                if (!res.ok || d.ok === false) {
                                  throw new Error(d.error || `HTTP ${res.status}`);
                                }
                                setNewBotName('');
                                if (d.botId) setActiveBotId(d.botId);
                                setBotManageNotice(
                                  `已啟用新 Bot（${d.botId}），與現有 Bot 共用高併發語音池並維持單一網站介面。`
                                );
                                await fetchStatus();
                              } catch (err) {
                                setBotManageNotice(
                                  err instanceof Error ? err.message : '新增 Bot 失敗'
                                );
                              } finally {
                                setManagingBots(false);
                              }
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md cursor-pointer whitespace-nowrap"
                          >
                            + 新增併發 Bot
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </form>
          )}

          {rightTab === 'logs' && (() => {
            const inspectedDiag = activeDiagSession ?? diagHistory[0] ?? null;
            const verdictMeta = inspectedDiag ? VERDICT_LABELS_ZH[inspectedDiag.verdict] : null;
            return (
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md text-xs">
                    <button
                      type="button"
                      onClick={() => setLogsSubTab('server')}
                      className={`px-2.5 py-1 rounded font-medium transition-colors cursor-pointer ${
                        logsSubTab === 'server'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      後端日誌 ({liveLogs.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setLogsSubTab('audio')}
                      className={`px-2.5 py-1 rounded font-medium transition-colors cursor-pointer ${
                        logsSubTab === 'audio'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      語音串流診斷 ({inspectedDiag?.events.length ?? 0})
                    </button>
                  </div>

                  {logsSubTab === 'server' && liveLogs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setLiveLogs([])}
                      className="text-xs text-blue-700 hover:underline cursor-pointer"
                    >
                      清除
                    </button>
                  )}

                  {logsSubTab === 'audio' && inspectedDiag && (
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await copyToClipboard(JSON.stringify(inspectedDiag, null, 2));
                          if (ok) {
                            setCopiedDiagReport(true);
                            window.setTimeout(() => setCopiedDiagReport(false), 2000);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer"
                      >
                        {copiedDiagReport ? (
                          <Check className="w-3 h-3 text-emerald-600" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3 h-3" aria-hidden="true" />
                        )}
                        <span>{copiedDiagReport ? '已複製 JSON' : '複製診斷報告'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          VoiceAudioDiagnosticLogger.clearHistory();
                          setDiagHistory([]);
                          if (!isRecording) setActiveDiagSession(null);
                          setRecoveredCrashSession(null);
                        }}
                        className="text-blue-700 hover:underline cursor-pointer"
                      >
                        清除
                      </button>
                    </div>
                  )}
                </div>

                {logsSubTab === 'server' ? (
                  <>
                    <div className="text-xs text-slate-500">
                      Formatted by TokenRedactingFormatter + RequestIdFilter
                    </div>
                    {liveLogs.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-500">
                        在左側發送文字或語音訊息，即可即時檢視 <code className="font-mono">[req=...]</code>{' '}
                        請求追蹤日誌與 Token 自動遮罩（<code className="font-mono">***1234..._XYZ***</code>）。
                      </div>
                    ) : (
                      <pre className="p-3 bg-slate-950 text-slate-100 rounded-lg text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[420px] whitespace-pre-wrap break-all">
                        {liveLogs.join('\n')}
                      </pre>
                    )}
                  </>
                ) : !inspectedDiag ? (
                  <div className="py-10 text-center space-y-2 text-xs text-slate-500">
                    <p className="font-medium text-slate-700">尚無 Web Audio API 串流診斷紀錄</p>
                    <p>
                      開始麥克風錄音後，系統將即時監控 AudioContext 時鐘、MediaRecorder 切片間隔、緩衝區體積與 JS Heap 記憶體，自動判別為「緩衝區溢位」或「串流逾時」。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {verdictMeta && (
                      <div
                        className={`px-3 py-2.5 rounded-lg border text-xs space-y-1 ${
                          verdictMeta.severity === 'error'
                            ? 'bg-red-50 border-red-200 text-red-900'
                            : verdictMeta.severity === 'warn'
                              ? 'bg-amber-50 border-amber-200 text-amber-950'
                              : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 font-semibold">
                          <span>診斷結論：{verdictMeta.label}</span>
                          <span className="font-mono text-[11px] opacity-80">
                            {inspectedDiag.status} · {inspectedDiag.mimeType}
                          </span>
                        </div>
                        <p className="opacity-90">{inspectedDiag.verdictReason}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] font-mono tabular-nums">
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">錄音時長 / 切片</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {inspectedDiag.snapshot.elapsedSec}s / {inspectedDiag.snapshot.chunkCount} 塊
                        </div>
                      </div>
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">緩衝區大小 / 速率</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {formatKb(inspectedDiag.snapshot.bufferedBytes)} ·{' '}
                          {(inspectedDiag.snapshot.bytesPerSec / 1024).toFixed(1)} KB/s
                        </div>
                      </div>
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">最大切片間隔</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {inspectedDiag.snapshot.maxChunkGapMs} ms
                        </div>
                      </div>
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">AudioContext 狀態</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {inspectedDiag.snapshot.audioContextState}
                          {inspectedDiag.snapshot.audioContextTimeSec !== null
                            ? ` (${inspectedDiag.snapshot.audioContextTimeSec}s)`
                            : ''}
                        </div>
                      </div>
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">音訊時鐘停滯</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {inspectedDiag.snapshot.audioClockStallSec}s · 音軌 {inspectedDiag.snapshot.trackReadyState}
                        </div>
                      </div>
                      <div className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-slate-500 font-sans">JS Heap 記憶體</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {inspectedDiag.snapshot.jsHeapUsedMb !== null
                            ? `${inspectedDiag.snapshot.jsHeapUsedMb} MB (${inspectedDiag.snapshot.jsHeapPercent ?? 0}%)`
                            : '瀏覽器未提供'}
                        </div>
                      </div>
                    </div>

                    <pre className="p-3 bg-slate-950 text-slate-100 rounded-lg text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[300px] whitespace-pre-wrap break-all">
                      {inspectedDiag.events
                        .slice()
                        .reverse()
                        .map(
                          (ev) =>
                            `[+${ev.elapsedSec.toFixed(1)}s][${ev.level.toUpperCase()}][${ev.category}:${ev.code}] ${ev.message}`
                        )
                        .join('\n')}
                    </pre>
                  </div>
                )}
              </div>
            );
          })()}

          {rightTab === 'tests' && (
            <div className="p-4 space-y-3">
              {runningTests ? (
                <div className="py-12 flex flex-col items-center gap-2 text-xs text-slate-600">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin" aria-hidden="true" />
                  <span>Executing pytest, ruff check, and mypy on telegram-voice-bot...</span>
                </div>
              ) : !testResult ? (
                <div className="py-12 text-center space-y-3">
                  <p className="text-xs text-slate-600">
                    直接在後端執行完整 Python 測試與靜態分析套件。
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleRunTests()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Run CI Suite Now</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className={testResult.ok ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                      {testResult.ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}
                    </span>
                    <span className="text-slate-500">{testResult.elapsedMs}ms</span>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-700">
                      pytest (exit {testResult.pytest.exitCode})
                    </div>
                    <pre className="p-3 bg-slate-50 border border-slate-200 rounded-md text-[11px] font-mono text-slate-800 overflow-x-auto max-h-60 whitespace-pre">
                      {testResult.pytest.output}
                    </pre>
                    <div className="text-xs font-semibold text-slate-700">
                      ruff (exit {testResult.ruff.exitCode}) · mypy (exit {testResult.mypy.exitCode})
                    </div>
                    <pre className="p-3 bg-slate-50 border border-slate-200 rounded-md text-[11px] font-mono text-slate-800 overflow-x-auto whitespace-pre-wrap">
                      {`${testResult.ruff.output}\n${testResult.mypy.output}`}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Issue Specification Compliance Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="font-display text-base font-semibold text-slate-900">
            Web Voice Bot 與 GitHub Issues 規格對照
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            保留專案所有後端核心模組與 Issue 規格（#22、#24、#25、#26、#27），並以自建 Web 介面取代 Telegram。
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-6">Module</th>
                <th className="py-2.5 px-4">Specification</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-6">Implementation Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {ISSUE_MATRIX.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-6 font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {row.id}
                  </td>
                  <td className="py-3 px-4 font-medium text-slate-900 whitespace-nowrap">
                    {row.title}
                  </td>
                  <td className="py-3 px-4 font-medium text-emerald-700 whitespace-nowrap">
                    {row.status}
                  </td>
                  <td className="py-3 px-6 text-slate-600">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <VoiceDiagnosticsModal
        open={showDiagModal}
        onClose={() => setShowDiagModal(false)}
        activeSession={activeDiagSession}
        history={diagHistory}
        isRecording={isRecording}
        syncing={diagSyncing}
        lastSyncedAt={diagLastSyncedAt}
        onSyncServerHistory={syncDiagHistoryFromServer}
        onClearHistory={() => {
          VoiceAudioDiagnosticLogger.clearHistory();
          void VoiceAudioDiagnosticLogger.clearServerHistory();
          setDiagHistory([]);
          if (!isRecording) setActiveDiagSession(null);
          setRecoveredCrashSession(null);
        }}
      />
    </div>
  );
}
