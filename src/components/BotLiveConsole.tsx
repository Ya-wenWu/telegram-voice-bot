import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Square,
  Terminal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

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

interface BotStatus {
  pythonVersion: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  redisFailOpenOk: boolean;
  redisCheckMs: number;
  gitBranch: string;
  gitCommit: string;
  commitsAhead: string[];
  config: BotConfig;
  memoryStats: {
    activeChats: number;
    totalMessages: number;
    maxTurns: number;
  };
}

interface ChatTurnItem {
  id: string;
  userId: number;
  userText: string;
  inputMode: 'text' | 'voice';
  userAudioUrl?: string | null;
  isVoiceReply: boolean;
  rejected?: boolean;
  reply?: string;
  reason?: string;
  reqId: string;
  sentences?: string[];
  audioUrl?: string | null;
  audioBytes?: number;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  ffmpegMs?: number;
  ttsNote?: string | null;
  elapsedMs: number;
}

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
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('無法讀取錄音資料。'));
    reader.readAsDataURL(blob);
  });
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

  const [rightTab, setRightTab] = useState<'config' | 'logs' | 'tests'>('config');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSavedNotice, setConfigSavedNotice] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<{ sizeLabel: string; url: string } | null>(
    null
  );
  const [copiedDownloadUrl, setCopiedDownloadUrl] = useState(false);

  const [userIdInput, setUserIdInput] = useState('123456');
  const [messageInput, setMessageInput] = useState('');
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(true);
  const [autoPlayAudio, setAutoPlayAudio] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendingStage, setSendingStage] = useState('');
  const [sendingElapsedSec, setSendingElapsedSec] = useState(0);
  const [turns, setTurns] = useState<ChatTurnItem[]>([]);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);

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
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const speechRecRef = useRef<BrowserSpeechRecognition | null>(null);
  const liveTranscriptRef = useRef('');
  const cancelRecordingRef = useRef(false);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

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
      const res = await fetch('/api/bot/status');
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as BotStatus;
      setStatus(data);
      setConfigForm(data.config);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unable to reach Python bot bridge.');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void loadMicDevices();
  }, [fetchStatus, loadMicDevices]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns, sending]);

  const cleanupRecordingResources = useCallback(() => {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (speechRecRef.current) {
      try {
        speechRecRef.current.stop();
      } catch {
        // ignore
      }
      speechRecRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

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
    return () => {
      cleanupRecordingResources();
      activeRequestAbortRef.current?.abort();
      if (playingAudioRef.current) {
        playingAudioRef.current.pause();
        playingAudioRef.current = null;
      }
    };
  }, [cleanupRecordingResources]);

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
      const res = await fetch('/api/bot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          userId: resolvedUserId,
          chatId: resolvedUserId || 123456,
          text,
          isVoice: voiceReplyEnabled,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        rejected?: boolean;
        reason?: string;
        reply?: string;
        reqId?: string;
        sentences?: string[];
        audioBase64?: string | null;
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
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const audioUrl = data.audioBase64 ? `data:audio/mpeg;base64,${data.audioBase64}` : null;
      const item: ChatTurnItem = {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        userId: resolvedUserId,
        userText: text,
        inputMode: 'text',
        isVoiceReply: voiceReplyEnabled,
        rejected: Boolean(data.rejected),
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
      };

      setTurns((prev) => [...prev, item]);
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

  const sendVoiceBlob = async (blob: Blob, fallbackLabel = '語音訊息', clientTranscript = '') => {
    if (sending) return;
    const uid = Number.parseInt(userIdInput.trim(), 10);
    const resolvedUserId = Number.isFinite(uid) ? uid : 0;

    setSending(true);
    setSendingStage('音訊正規化 (ffmpeg WAV) → 語音辨識 (STT) → AI 回覆中...');
    setStatusError(null);
    setFailedRecordingUrl(null);
    setFailedVoicePayload(null);

    const userAudioUrl = URL.createObjectURL(blob);
    const controller = new AbortController();
    activeRequestAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 35000);

    try {
      const audioBase64 = await blobToBase64(blob);
      const mimeType = blob.type || 'audio/webm';

      const res = await fetch('/api/bot/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          userId: resolvedUserId,
          chatId: resolvedUserId || 123456,
          audioBase64,
          mimeType,
          clientTranscript,
          isVoice: voiceReplyEnabled,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        rejected?: boolean;
        reason?: string;
        transcript?: string;
        reply?: string;
        reqId?: string;
        sentences?: string[];
        audioBase64?: string | null;
        audioBytes?: number;
        sttMs?: number;
        llmMs?: number;
        ttsMs?: number;
        ffmpegMs?: number;
        ttsNote?: string | null;
        logs?: string[];
        elapsedMs?: number;
        error?: string;
      };

      if (!res.ok) {
        // Keep the user's recording playable & retryable so they don't lose their spoken message
        setFailedRecordingUrl(userAudioUrl);
        setFailedVoicePayload({ blob, label: fallbackLabel, transcript: clientTranscript });
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const audioUrl = data.audioBase64 ? `data:audio/mpeg;base64,${data.audioBase64}` : null;
      const item: ChatTurnItem = {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        userId: resolvedUserId,
        userText: data.transcript || clientTranscript || fallbackLabel,
        inputMode: 'voice',
        userAudioUrl,
        isVoiceReply: voiceReplyEnabled,
        rejected: Boolean(data.rejected),
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
      };

      setTurns((prev) => [...prev, item]);
      if (Array.isArray(data.logs) && data.logs.length > 0) {
        setLiveLogs((prev) => [...data.logs!, ...prev].slice(0, 120));
      }
      maybeAutoPlay(audioUrl);
      void fetchStatus();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setFailedRecordingUrl(userAudioUrl);
        setFailedVoicePayload({ blob, label: fallbackLabel, transcript: clientTranscript });
        setStatusError('語音處理等待超時或已取消，你可以直接按下方「重試送出」不需重錄。');
      } else {
        setStatusError(err instanceof Error ? err.message : '語音處理失敗。');
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

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatusError('目前瀏覽器不支援麥克風錄音，請使用右側「上傳音訊檔」按鈕測試語音問答。');
      return;
    }

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

      // Refresh mic device labels now that permission has been granted
      void loadMicDevices();

      // Start real-time Web Audio AnalyserNode for live volume meter
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const timeData = new Uint8Array(analyser.fftSize);

        const updateMeter = () => {
          analyser.getByteTimeDomainData(timeData);
          let sumSq = 0;
          for (let i = 0; i < timeData.length; i += 1) {
            const norm = (timeData[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.sqrt(sumSq / timeData.length);
          const pct = Math.min(100, Math.round(rms * 350));
          setMicLevel(pct);
          setPeakMicLevel((prev) => Math.max(prev, pct));
          rafRef.current = window.requestAnimationFrame(updateMeter);
        };
        rafRef.current = window.requestAnimationFrame(updateMeter);
      }

      // Start optional browser live speech captioning in parallel (gives immediate visual feedback + fallback)
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
                finalized += part;
              } else {
                interim += part;
              }
            }
            const combined = (finalized + interim).trim();
            liveTranscriptRef.current = combined;
            setLiveTranscript(combined);
          };
          rec.onerror = () => {
            // Silently ignore; server-side ffmpeg + Gemini STT handles transcription independently
          };
          rec.start();
          speechRecRef.current = rec;
        } catch {
          // Ignore if browser blocks SpeechRecognition in iframe
        }
      }

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      audioChunksRef.current = [];
      cancelRecordingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const capturedTranscript = liveTranscriptRef.current.trim();
        cleanupRecordingResources();
        setIsRecording(false);
        setRecordingSeconds(0);
        setMicLevel(0);

        if (cancelRecordingRef.current) {
          audioChunksRef.current = [];
          setLiveTranscript('');
          return;
        }

        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        audioChunksRef.current = [];
        setLiveTranscript('');

        if (blob.size > 0) {
          void sendVoiceBlob(blob, '語音錄音', capturedTranscript);
        } else if (capturedTranscript) {
          void sendBotMessage(capturedTranscript);
        } else {
          setStatusError('錄音內容為空，請至少說話 1 秒後再點擊「停止並送出語音」。');
        }
      };

      mediaRecorderRef.current = recorder;
      // 250ms timeslice ensures short utterances always emit audio chunks before stop()
      recorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
      cleanupRecordingResources();
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
      try {
        mediaRecorderRef.current.requestData();
      } catch {
        // ignore if unsupported
      }
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
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configForm),
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
      const res = await fetch('/api/bot/run-tests', { method: 'POST' });
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

    const staticUrl = `${window.location.origin}/web-voice-bot-complete.zip`;
    try {
      let res = await fetch('/api/download/complete-zip', { cache: 'no-store' });
      if (!res.ok) {
        res = await fetch('/web-voice-bot-complete.zip', { cache: 'no-store' });
      }
      if (!res.ok) {
        throw new Error(`下載失敗（HTTP ${res.status}）`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = 'web-voice-bot-complete.zip';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setDownloadNotice({
        sizeLabel: formatKb(blob.size),
        url: staticUrl,
      });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : '無法下載壓縮檔，請稍後再試。');
    } finally {
      setDownloadingZip(false);
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
              免 Telegram 與 BotFather Token——直接在網頁中使用我們開發的 Python 語音機器人核心（麥克風語音辨識、多輪對話記憶、Edge-TTS 語音合成與{' '}
              <code className="text-xs">ffmpeg -threads 1</code>）。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
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
            <span>Python {status.pythonVersion}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>Branch {status.gitBranch} ({status.gitCommit})</span>
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
                  支援麥克風即時收音（音量表＋即時字幕）、音訊檔上傳、文字與指令
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
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
                    <div className="max-w-[92%] px-4 py-3 rounded-2xl rounded-tl-sm bg-white border border-slate-200 text-sm text-slate-800 space-y-2.5">
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
                      {formatDuration(recordingSeconds)}
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

                {recordingSeconds >= 2 && peakMicLevel < 5 && (
                  <p className="text-xs text-red-700">
                    提醒：目前音量條維持在 0%，麥克風可能處於靜音或選錯輸入裝置，請檢查上方「麥克風裝置」選單。
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={handleChatSubmit} className="flex items-center gap-2">
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
                onClick={() => setRightTab('config')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  rightTab === 'config' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Dynamic Config</span>
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
            </form>
          )}

          {rightTab === 'logs' && (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Formatted by TokenRedactingFormatter + RequestIdFilter</span>
                {liveLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setLiveLogs([])}
                    className="text-blue-700 hover:underline cursor-pointer"
                  >
                    Clear
                  </button>
                )}
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
            </div>
          )}

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
    </div>
  );
}
