/**
 * Durable Same-Day Conversation Persistence Repository & Retention Policy.
 *
 * Invariants:
 * 1. Same-day retention: Messages created on the current local calendar day (YYYY-MM-DD)
 *    survive tab switches, browser refreshes, backend restarts, and container recycles.
 * 2. Day-boundary rollover: Messages from any prior calendar day are purged automatically.
 * 3. Bounded round-trip window (MAX_DAILY_ROUND_TRIPS = 5):
 *    Up to 5 round-trip turns (1 user prompt + 1 bot reply = 1 turn) are kept intact.
 *    Once round-trips exceed 5 (> 5), the oldest turns are automatically evicted (FIFO)
 *    so storage, UI, and LLM context remain strictly bounded.
 */

export const MAX_DAILY_ROUND_TRIPS = 5;
const STORAGE_SCHEMA_VERSION = 1;
const STORAGE_KEY_PREFIX = 'web_voice_bot_daily_turns_v1:';
const MAX_PERSISTED_AUDIO_DATA_URI_BYTES = 180_000; // Prevent localStorage 5MB quota exhaustion

export interface PersistedChatTurn {
  id: string;
  userId: number;
  userText: string;
  inputMode: 'text' | 'voice';
  userAudioUrl?: string | null;
  isVoiceReply: boolean;
  rejected?: boolean;
  blocked?: boolean;
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
  dayKey: string;
  createdAt: string;
}

export interface ServerHistoryPair {
  role: 'user' | 'assistant';
  content: string;
}

interface StoredEnvelope {
  version: number;
  chatId: string;
  dayKey: string;
  updatedAt: string;
  turns: PersistedChatTurn[];
}

export interface RetentionResult<T> {
  retained: T[];
  evictedCount: number;
  dayRolloverCleared: boolean;
}

/**
 * Returns local calendar date string (YYYY-MM-DD) so day rollover aligns with user's day.
 */
export function getLocalDayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Enforces the Same-Day + Max 5 Round-Trips invariant deterministically.
 */
export function applyDailyRetentionPolicy<T extends { dayKey?: string }>(
  turns: readonly T[],
  todayKey: string = getLocalDayKey(),
  maxRoundTrips: number = MAX_DAILY_ROUND_TRIPS
): RetentionResult<T> {
  const cap = Math.max(1, maxRoundTrips);
  let dayRolloverCleared = false;

  const sameDayTurns = turns.filter((turn) => {
    const matches = !turn.dayKey || turn.dayKey === todayKey;
    if (!matches) dayRolloverCleared = true;
    return matches;
  });

  if (sameDayTurns.length <= cap) {
    return {
      retained: sameDayTurns,
      evictedCount: 0,
      dayRolloverCleared,
    };
  }

  const evictedCount = sameDayTurns.length - cap;
  return {
    retained: sameDayTurns.slice(-cap),
    evictedCount,
    dayRolloverCleared,
  };
}

/**
 * Strips ephemeral blob: URLs (which become invalid after reload) and oversized audio payloads
 * before serializing into localStorage.
 */
function sanitizeTurnForStorage(turn: PersistedChatTurn, todayKey: string): PersistedChatTurn {
  const safeAudioUrl =
    turn.audioUrl &&
    turn.audioUrl.startsWith('data:audio/') &&
    turn.audioUrl.length <= MAX_PERSISTED_AUDIO_DATA_URI_BYTES
      ? turn.audioUrl
      : null;

  return {
    ...turn,
    dayKey: turn.dayKey || todayKey,
    createdAt: turn.createdAt || new Date().toISOString(),
    // blob: URLs cannot survive page reloads; never persist them
    userAudioUrl: null,
    audioUrl: safeAudioUrl,
  };
}

function isValidPersistedTurn(candidate: unknown): candidate is PersistedChatTurn {
  if (!candidate || typeof candidate !== 'object') return false;
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.userId === 'number' &&
    typeof obj.userText === 'string' &&
    (obj.inputMode === 'text' || obj.inputMode === 'voice') &&
    typeof obj.reqId === 'string'
  );
}

function storageKeyFor(chatId: string): string {
  return `${STORAGE_KEY_PREFIX}${chatId}`;
}

/**
 * Converts flat server role/content pairs into UI turns when server has state that local lacks.
 */
export function synthesizeTurnsFromServerPairs(
  chatId: string,
  pairs: readonly ServerHistoryPair[],
  todayKey: string
): PersistedChatTurn[] {
  const numericUserId = Number.parseInt(chatId, 10);
  const resolvedUserId = Number.isFinite(numericUserId) ? numericUserId : 123456;
  const result: PersistedChatTurn[] = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < pairs.length - 1; i += 2) {
    const userMsg = pairs[i];
    const botMsg = pairs[i + 1];
    if (userMsg?.role !== 'user' || botMsg?.role !== 'assistant') continue;
    result.push({
      id: `server-hydrated-${todayKey}-${i / 2}`,
      userId: resolvedUserId,
      userText: userMsg.content,
      inputMode: 'text',
      userAudioUrl: null,
      isVoiceReply: false,
      reply: botMsg.content,
      reqId: 'restored',
      audioUrl: null,
      elapsedMs: 0,
      dayKey: todayKey,
      createdAt: nowIso,
    });
  }

  return applyDailyRetentionPolicy(result, todayKey).retained;
}

/**
 * Bidirectional reconciliation between browser durable store and backend state:
 * - If server restarted/wiped (0 turns) while browser holds today's turns -> hydrate server.
 * - If server holds newer/more turns for today -> merge into browser store.
 * - Both sides always obey the Same-Day + Max 5 Round-Trips invariant.
 */
export function reconcileConversationTurns(
  localTurns: readonly PersistedChatTurn[],
  serverTurns: readonly PersistedChatTurn[],
  todayKey: string = getLocalDayKey()
): {
  merged: PersistedChatTurn[];
  shouldHydrateServer: boolean;
} {
  const cleanLocal = applyDailyRetentionPolicy(localTurns, todayKey).retained;
  const cleanServer = applyDailyRetentionPolicy(serverTurns, todayKey).retained;

  if (cleanLocal.length === 0 && cleanServer.length === 0) {
    return { merged: [], shouldHydrateServer: false };
  }

  // Server restarted or container cold-started: push local same-day turns back to server
  if (cleanServer.length === 0 && cleanLocal.length > 0) {
    return { merged: cleanLocal, shouldHydrateServer: true };
  }

  // Local empty (e.g., new browser tab / cleared storage) while server retained today's turns
  if (cleanLocal.length === 0 && cleanServer.length > 0) {
    return { merged: cleanServer, shouldHydrateServer: false };
  }

  // Prefer the richer set when counts diverge; deduplicate by id or (userText + reply)
  const seen = new Set<string>();
  const combined: PersistedChatTurn[] = [];
  const source = cleanServer.length > cleanLocal.length ? [...cleanLocal, ...cleanServer] : [...cleanServer, ...cleanLocal];

  for (const turn of source) {
    const fingerprint = `${turn.userText.trim()}::${(turn.reply ?? turn.reason ?? '').trim()}`;
    if (seen.has(turn.id) || seen.has(fingerprint)) continue;
    seen.add(turn.id);
    seen.add(fingerprint);
    combined.push(turn);
  }

  combined.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const bounded = applyDailyRetentionPolicy(combined, todayKey).retained;
  const shouldHydrateServer = bounded.length > cleanServer.length;

  return { merged: bounded, shouldHydrateServer };
}

export const ConversationRepository = {
  loadToday(chatId: string, todayKey: string = getLocalDayKey()): RetentionResult<PersistedChatTurn> {
    try {
      const raw = window.localStorage.getItem(storageKeyFor(chatId));
      if (!raw) {
        return { retained: [], evictedCount: 0, dayRolloverCleared: false };
      }
      const parsed = JSON.parse(raw) as Partial<StoredEnvelope>;
      if (parsed.version !== STORAGE_SCHEMA_VERSION || !Array.isArray(parsed.turns)) {
        window.localStorage.removeItem(storageKeyFor(chatId));
        return { retained: [], evictedCount: 0, dayRolloverCleared: false };
      }
      if (parsed.dayKey && parsed.dayKey !== todayKey) {
        // Day rolled over: purge yesterday's envelope immediately
        window.localStorage.removeItem(storageKeyFor(chatId));
        return { retained: [], evictedCount: 0, dayRolloverCleared: true };
      }
      const validTurns = parsed.turns.filter(isValidPersistedTurn);
      const enforced = applyDailyRetentionPolicy(validTurns, todayKey);
      if (enforced.evictedCount > 0 || enforced.dayRolloverCleared) {
        this.saveToday(chatId, enforced.retained, todayKey);
      }
      return enforced;
    } catch {
      return { retained: [], evictedCount: 0, dayRolloverCleared: false };
    }
  },

  saveToday(
    chatId: string,
    turns: readonly PersistedChatTurn[],
    todayKey: string = getLocalDayKey()
  ): RetentionResult<PersistedChatTurn> {
    const enforced = applyDailyRetentionPolicy(turns, todayKey);
    const sanitized = enforced.retained.map((t) => sanitizeTurnForStorage(t, todayKey));
    const envelope: StoredEnvelope = {
      version: STORAGE_SCHEMA_VERSION,
      chatId,
      dayKey: todayKey,
      updatedAt: new Date().toISOString(),
      turns: sanitized,
    };

    try {
      window.localStorage.setItem(storageKeyFor(chatId), JSON.stringify(envelope));
    } catch {
      // Quota fallback: strip all inline audio data URIs and retry text-only persistence
      try {
        const textOnlyEnvelope: StoredEnvelope = {
          ...envelope,
          turns: sanitized.map((t) => ({ ...t, audioUrl: null })),
        };
        window.localStorage.setItem(storageKeyFor(chatId), JSON.stringify(textOnlyEnvelope));
      } catch {
        // Storage unavailable (e.g., private mode disabled storage)
      }
    }
    return enforced;
  },

  clear(chatId: string): void {
    try {
      window.localStorage.removeItem(storageKeyFor(chatId));
    } catch {
      // ignore
    }
  },
};
