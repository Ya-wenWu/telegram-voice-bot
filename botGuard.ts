/**
 * Web API Anti-Malicious-Bot Middleware, Fingerprinting, Honeypot & BOT_GUARD_SECRET Challenge Engine.
 *
 * Defense layers:
 * 1. Express middleware (`createBotGuardMiddleware`) mounted on `/api/bot/*` validating every request
 *    against `BOT_GUARD_SECRET` (returning HTTP 403 Forbidden if a valid token/secret is missing or
 *    the challenge fails).
 * 2. Honeypot trap (`_hp` / `website_url` / `X-Honeypot`) -> instant IP quarantine (403 Forbidden).
 * 3. Automated / headless client signature detection (`User-Agent` + browser integrity headers).
 * 4. Bounded-LRU behavioral velocity, low-jitter robotic cadence, and duplicate payload flood scoring.
 * 5. Single-use HMAC-SHA256 challenge-response (`GET /api/bot/challenge`, `POST /api/bot/challenge/verify`)
 *    supporting both browser SHA-256 Proof-of-Work attestation (`browser` scope) and interactive
 *    human arithmetic verification (`human` scope), issuing IP-bound tokens signed with
 *    `BOT_GUARD_SECRET` and verified via `crypto.timingSafeEqual`.
 */

import crypto from 'crypto';
import type express from 'express';

const MAX_TRACKED_IPS = 2000;
const MAX_ACTIVE_CHALLENGES = 2000;
const MAX_RECENT_EVENTS = 25;

const CHALLENGE_THRESHOLD = 50;
const BLOCK_THRESHOLD = 90;
const QUARANTINE_BASE_SEC = 180;
const CHALLENGE_TTL_MS = 120_000;
const HUMAN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (short-lived)
const BROWSER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes (short-lived)
const BURST_WINDOW_MS = 15_000;
const BURST_MAX_HITS = 6;
const DUPLICATE_WINDOW_MS = 30_000;
const DUPLICATE_MAX_HITS = 3;
const DEFAULT_POW_DIFFICULTY = 12; // ~4,096 SHA-256 hashes (~10-25ms in browser SubtleCrypto)

// Per-process ephemeral fallback when BOT_GUARD_SECRET is unset in dev/preview;
// never hardcoded or written to disk.
const PROCESS_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

const AUTOMATED_UA_RE =
  /(?:python-requests|python-urllib|aiohttp|httpx|curl\/|wget\/|scrapy|headlesschrome|playwright|puppeteer|selenium|phantomjs|go-http-client|axios\/|node-fetch|undici|httpie|insomnia|postmanruntime|libwww-perl|apache-httpclient|okhttp|java\/|\b(?:bot|crawler|spider|scraper|slurp|archiver)\b)/i;

export type BotGuardTokenScope = 'human' | 'browser';
export type ChallengeMode = 'pow' | 'human';

export interface IssuedChallenge {
  challengeId: string;
  question: string;
  powNonce: string;
  powDifficulty: number;
  challengeSignature: string;
  expiresAt: string;
  expiresInSec: number;
}

export interface WebBotVerdict {
  allowed: boolean;
  action: 'allow' | 'challenge' | 'block';
  challengeMode?: ChallengeMode;
  riskScore: number;
  reasons: string[];
  message?: string;
  retryAfterSec?: number;
  challenge?: IssuedChallenge;
}

export interface BotGuardEvent {
  timestamp: string;
  action: 'block' | 'challenge' | 'verified';
  maskedIp: string;
  path: string;
  riskScore: number;
  reasons: string[];
}

interface IpBehaviorState {
  timestamps: number[];
  payloadHashes: Array<{ ts: number; hash: string }>;
  strikes: number;
  quarantineUntil: number;
  lastSeen: number;
}

interface StoredChallenge {
  challengeId: string;
  ip: string;
  expectedAnswer: number;
  question: string;
  powNonce: string;
  powDifficulty: number;
  challengeSignature: string;
  expiresAt: number;
  attempts: number;
}

const ipStates = new Map<string, IpBehaviorState>();
const activeChallenges = new Map<string, StoredChallenge>();
const recentEvents: BotGuardEvent[] = [];

const counters = {
  blockedTotal: 0,
  challengedTotal: 0,
  verifiedHumansTotal: 0,
  verifiedBrowsersTotal: 0,
  secretAuthTotal: 0,
  honeypotHitsTotal: 0,
};

export function isBotGuardEnabled(): boolean {
  const raw = (process.env.BOT_GUARD_ENABLED || 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

export function getConfiguredBotGuardSecret(): string {
  return (process.env.BOT_GUARD_SECRET || '').trim();
}

function getSigningSecret(): string {
  return getConfiguredBotGuardSecret() || PROCESS_FALLBACK_SECRET;
}

function constantTimeHashEquals(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf-8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf-8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function maskClientIp(rawIp: string): string {
  const cleaned = String(rawIp || 'unknown')
    .trim()
    .replace(/^::ffff:/i, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleaned)) {
    const parts = cleaned.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
  }
  if (cleaned.includes(':')) {
    const groups = cleaned.split(':').filter(Boolean);
    return `${groups.slice(0, 2).join(':') || 'ipv6'}:****`;
  }
  return 'unknown';
}

export function isAutomatedUserAgent(uaRaw: unknown): boolean {
  const ua = String(uaRaw || '').trim();
  return !ua || ua.length < 12 || AUTOMATED_UA_RE.test(ua);
}

function recordEvent(event: BotGuardEvent): void {
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.pop();
  }
}

function getOrCreateIpState(ip: string, now: number): IpBehaviorState {
  const existing = ipStates.get(ip);
  if (existing) {
    // Refresh LRU order
    ipStates.delete(ip);
    existing.lastSeen = now;
    ipStates.set(ip, existing);
    return existing;
  }

  // Evict oldest entry to keep RAM strictly bounded
  if (ipStates.size >= MAX_TRACKED_IPS) {
    const oldestKey = ipStates.keys().next().value;
    if (oldestKey !== undefined) {
      ipStates.delete(oldestKey);
    }
  }

  const state: IpBehaviorState = {
    timestamps: [],
    payloadHashes: [],
    strikes: 0,
    quarantineUntil: 0,
    lastSeen: now,
  };
  ipStates.set(ip, state);
  return state;
}

function hashPayloadFingerprint(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized || normalized.startsWith('/')) return null;
  return crypto
    .createHash('sha256')
    .update(normalized.slice(0, 512), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function signChallengePayload(
  challengeId: string,
  ip: string,
  powNonce: string,
  expiresAt: number
): string {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(`challenge|${challengeId}|${ip}|${powNonce}|${expiresAt}`, 'utf-8')
    .digest('hex');
}

function deriveAesGcmKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(`botguard-aes-256-gcm-v2:${getSigningSecret()}`, 'utf-8')
    .digest();
}

function hashBinding(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Encrypts a short-lived X-Bot-Guard-Token payload with AES-256-GCM using a key derived from
 * BOT_GUARD_SECRET, a fresh 96-bit CSPRNG IV, and IP-bound Additional Authenticated Data (AAD).
 * Format: v2.<iv_b64url>.<ciphertext_b64url>.<authTag_b64url>
 */
export function encryptBotGuardToken(
  scope: BotGuardTokenScope,
  ip: string,
  userAgent: string,
  issuedAt: number,
  expiresAt: number,
  nonce: string
): string {
  const key = deriveAesGcmKey();
  const iv = crypto.randomBytes(12);
  const ipHash = hashBinding(ip);
  const uaHash = hashBinding(userAgent.trim());
  const aad = Buffer.from(`v2|${ipHash}`, 'utf-8');
  const payload = JSON.stringify({
    s: scope,
    i: issuedAt,
    e: expiresAt,
    n: nonce,
    ip: ipHash,
    ua: uaHash,
  });

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `v2.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${authTag.toString('base64url')}`;
}

export function verifyBotGuardToken(
  tokenRaw: unknown,
  ip: string,
  userAgent?: string
): { valid: boolean; scope?: BotGuardTokenScope; encrypted?: boolean; reason?: string } {
  if (typeof tokenRaw !== 'string') return { valid: false, reason: 'missing_token' };
  const token = tokenRaw.trim();
  if (!token || token.length > 512) return { valid: false, reason: 'malformed_token' };

  const parts = token.split('.');

  // Primary format: AES-256-GCM encrypted token (v2.<iv>.<ciphertext>.<authTag>)
  if (parts.length === 4 && parts[0] === 'v2') {
    const [, ivB64, ctB64, tagB64] = parts;
    if (
      !/^[A-Za-z0-9_-]{16,24}$/.test(ivB64) ||
      !/^[A-Za-z0-9_-]{24,360}$/.test(ctB64) ||
      !/^[A-Za-z0-9_-]{20,24}$/.test(tagB64)
    ) {
      return { valid: false, reason: 'malformed_encrypted_token' };
    }
    try {
      const key = deriveAesGcmKey();
      const iv = Buffer.from(ivB64, 'base64url');
      const ct = Buffer.from(ctB64, 'base64url');
      const authTag = Buffer.from(tagB64, 'base64url');
      if (iv.length !== 12 || authTag.length !== 16 || ct.length === 0) {
        return { valid: false, reason: 'malformed_encrypted_token' };
      }

      const ipHash = hashBinding(ip);
      const aad = Buffer.from(`v2|${ipHash}`, 'utf-8');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
      const parsed = JSON.parse(decrypted) as {
        s?: unknown;
        i?: unknown;
        e?: unknown;
        n?: unknown;
        ip?: unknown;
        ua?: unknown;
      };

      const scope = parsed.s;
      const issuedAt = typeof parsed.i === 'number' ? parsed.i : Number.NaN;
      const expiresAt = typeof parsed.e === 'number' ? parsed.e : Number.NaN;
      const now = Date.now();

      if (scope !== 'human' && scope !== 'browser') {
        return { valid: false, reason: 'invalid_scope' };
      }
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
        return { valid: false, reason: 'malformed_timestamp' };
      }
      if (expiresAt <= now) {
        return { valid: false, reason: 'expired_token' };
      }
      if (issuedAt > now + 5_000) {
        return { valid: false, reason: 'future_token' };
      }
      if (typeof parsed.ip !== 'string' || !constantTimeHashEquals(parsed.ip, ipHash)) {
        return { valid: false, reason: 'ip_mismatch' };
      }
      if (
        scope === 'browser' &&
        typeof userAgent === 'string' &&
        typeof parsed.ua === 'string' &&
        !constantTimeHashEquals(parsed.ua, hashBinding(userAgent.trim()))
      ) {
        return { valid: false, reason: 'ua_mismatch' };
      }
      return { valid: true, scope, encrypted: true };
    } catch {
      return { valid: false, reason: 'decryption_failed' };
    }
  }

  // Legacy HMAC fallback for in-flight clients
  let scope: BotGuardTokenScope;
  let issuedStr: string;
  let expiresStr: string;
  let nonce: string;
  let macHex: string;
  let hmacInput: string;

  if (parts.length === 5) {
    const [scopeRaw, iStr, eStr, n, m] = parts;
    if (scopeRaw !== 'human' && scopeRaw !== 'browser') {
      return { valid: false, reason: 'invalid_scope' };
    }
    scope = scopeRaw;
    issuedStr = iStr;
    expiresStr = eStr;
    nonce = n;
    macHex = m;
    hmacInput = `${scope}|${ip}|${issuedStr}|${expiresStr}|${nonce}`;
  } else if (parts.length === 4) {
    scope = 'human';
    [issuedStr, expiresStr, nonce, macHex] = parts;
    hmacInput = `${ip}|${issuedStr}|${expiresStr}|${nonce}`;
  } else {
    return { valid: false, reason: 'malformed_token' };
  }

  if (!/^\d+$/.test(issuedStr) || !/^\d+$/.test(expiresStr)) {
    return { valid: false, reason: 'malformed_timestamp' };
  }
  if (!/^[0-9a-f]{16,64}$/i.test(nonce) || !/^[0-9a-f]{64}$/i.test(macHex)) {
    return { valid: false, reason: 'malformed_signature' };
  }

  const issuedAt = Number.parseInt(issuedStr, 10);
  const expiresAt = Number.parseInt(expiresStr, 10);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: 'malformed_timestamp' };
  }
  if (expiresAt <= now) {
    return { valid: false, reason: 'expired_token' };
  }
  if (issuedAt > now + 5_000) {
    return { valid: false, reason: 'future_token' };
  }

  const expectedMac = crypto
    .createHmac('sha256', getSigningSecret())
    .update(hmacInput, 'utf-8')
    .digest();
  const providedMac = Buffer.from(macHex, 'hex');
  if (expectedMac.length !== providedMac.length) {
    return { valid: false, reason: 'invalid_signature' };
  }
  if (!crypto.timingSafeEqual(expectedMac, providedMac)) {
    return { valid: false, reason: 'invalid_signature' };
  }
  return { valid: true, scope, encrypted: false };
}

export function verifyHumanToken(tokenRaw: unknown, ip: string): boolean {
  const res = verifyBotGuardToken(tokenRaw, ip);
  return res.valid && res.scope === 'human';
}

function verifyBotGuardSecretHeader(
  req: express.Request
): 'valid' | 'invalid' | 'missing' {
  const configuredSecret = getConfiguredBotGuardSecret();
  const secretHeader =
    typeof req.headers['x-bot-guard-secret'] === 'string'
      ? req.headers['x-bot-guard-secret'].trim()
      : '';
  const authHeader =
    typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const authBotGuard = authHeader.startsWith('BotGuard ')
    ? authHeader.slice('BotGuard '.length).trim()
    : '';
  const candidate = secretHeader || authBotGuard;
  if (!candidate) {
    return 'missing';
  }
  if (!configuredSecret) {
    return 'invalid';
  }
  return constantTimeHashEquals(candidate, configuredSecret) ? 'valid' : 'invalid';
}

function extractPresentedToken(req: express.Request): string | null {
  const guardToken = req.headers['x-bot-guard-token'];
  if (typeof guardToken === 'string' && guardToken.trim()) {
    return guardToken.trim();
  }
  const humanToken = req.headers['x-human-token'];
  if (typeof humanToken === 'string' && humanToken.trim()) {
    return humanToken.trim();
  }
  return null;
}

function hasLeadingZeroBits(digest: Buffer, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (digest[i] !== 0) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((digest[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

function pruneExpiredChallenges(now: number): void {
  for (const [id, ch] of activeChallenges.entries()) {
    if (ch.expiresAt <= now) {
      activeChallenges.delete(id);
    }
  }
  while (activeChallenges.size >= MAX_ACTIVE_CHALLENGES) {
    const oldest = activeChallenges.keys().next().value;
    if (oldest === undefined) break;
    activeChallenges.delete(oldest);
  }
}

export function issueHumanChallenge(ip: string): IssuedChallenge {
  const now = Date.now();
  pruneExpiredChallenges(now);

  // Prevent a single IP from flooding activeChallenges and evicting other users' challenges
  const sameIpIds: string[] = [];
  for (const [id, ch] of activeChallenges.entries()) {
    if (ch.ip === ip) sameIpIds.push(id);
  }
  while (sameIpIds.length >= 5) {
    const oldestForIp = sameIpIds.shift();
    if (oldestForIp) activeChallenges.delete(oldestForIp);
  }

  const a = crypto.randomInt(4, 22);
  const b = crypto.randomInt(3, 17);
  const useAdd = crypto.randomInt(0, 2) === 0;
  let answer: number;
  let question: string;
  if (useAdd) {
    answer = a + b;
    question = `${a} + ${b} = ?`;
  } else {
    const hi = Math.max(a, b) + 2;
    const lo = Math.min(a, b);
    answer = hi - lo;
    question = `${hi} - ${lo} = ?`;
  }

  const challengeId = crypto.randomBytes(12).toString('hex');
  const powNonce = crypto.randomBytes(12).toString('hex');
  const expiresAt = now + CHALLENGE_TTL_MS;
  const challengeSignature = signChallengePayload(challengeId, ip, powNonce, expiresAt);

  activeChallenges.set(challengeId, {
    challengeId,
    ip,
    expectedAnswer: answer,
    question,
    powNonce,
    powDifficulty: DEFAULT_POW_DIFFICULTY,
    challengeSignature,
    expiresAt,
    attempts: 0,
  });

  return {
    challengeId,
    question,
    powNonce,
    powDifficulty: DEFAULT_POW_DIFFICULTY,
    challengeSignature,
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSec: Math.round(CHALLENGE_TTL_MS / 1000),
  };
}

export function verifyHumanChallenge(
  ip: string,
  challengeIdRaw: unknown,
  answerRaw: unknown,
  options: {
    mode?: unknown;
    powSolution?: unknown;
    challengeSignature?: unknown;
    userAgent?: unknown;
  } = {}
): {
  ok: boolean;
  forbidden?: boolean;
  scope?: BotGuardTokenScope;
  humanToken?: string;
  encrypted?: boolean;
  algorithm?: 'aes-256-gcm';
  expiresAt?: string;
  expiresInSec?: number;
  error?: string;
  remainingAttempts?: number;
} {
  const now = Date.now();
  const state = getOrCreateIpState(ip, now);

  if (state.quarantineUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((state.quarantineUntil - now) / 1000));
    counters.blockedTotal += 1;
    return {
      ok: false,
      forbidden: true,
      error: `此來源因異常機器人行為暫時遭到封鎖，請於 ${retryAfterSec} 秒後再試。`,
      remainingAttempts: 0,
    };
  }

  const challengeId = typeof challengeIdRaw === 'string' ? challengeIdRaw.trim() : '';
  if (!/^[0-9a-f]{16,40}$/.test(challengeId)) {
    return { ok: false, forbidden: true, error: '驗證題目編號無效，請重新取得驗證題目。' };
  }

  const stored = activeChallenges.get(challengeId);
  if (!stored) {
    return { ok: false, forbidden: true, error: '驗證題目不存在或已使用，請重新取得驗證題目。' };
  }
  if (stored.expiresAt <= now) {
    activeChallenges.delete(challengeId);
    return { ok: false, forbidden: true, error: '驗證題目已逾時，請重新取得驗證題目。' };
  }
  if (stored.ip !== ip) {
    return { ok: false, forbidden: true, error: '驗證來源不一致，請重新整理後再試。' };
  }

  // Mode 1: Browser Proof-of-Work attestation (issues `browser` scope token signed by BOT_GUARD_SECRET)
  const mode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : 'human';
  if (mode === 'pow') {
    if (isAutomatedUserAgent(options.userAgent)) {
      activeChallenges.delete(challengeId);
      counters.blockedTotal += 1;
      recordEvent({
        timestamp: new Date(now).toISOString(),
        action: 'block',
        maskedIp: maskClientIp(ip),
        path: '/api/bot/challenge/verify',
        riskScore: 85,
        reasons: ['pow_rejected_automated_ua'],
      });
      return {
        ok: false,
        forbidden: true,
        error: '偵測到自動化用戶端特徵，無法通過瀏覽器自動驗證，請使用合法憑證或完成人機驗證。',
        remainingAttempts: 0,
      };
    }

    const providedSig =
      typeof options.challengeSignature === 'string' ? options.challengeSignature.trim() : '';
    if (!providedSig || !constantTimeHashEquals(providedSig, stored.challengeSignature)) {
      activeChallenges.delete(challengeId);
      counters.blockedTotal += 1;
      recordEvent({
        timestamp: new Date(now).toISOString(),
        action: 'block',
        maskedIp: maskClientIp(ip),
        path: '/api/bot/challenge/verify',
        riskScore: 90,
        reasons: ['invalid_challenge_signature'],
      });
      return {
        ok: false,
        forbidden: true,
        error: '挑戰簽章驗證失敗，請求已拒絕。',
        remainingAttempts: 0,
      };
    }

    const solution = String(options.powSolution ?? '').trim();
    if (!solution || solution.length > 64) {
      return {
        ok: false,
        forbidden: true,
        error: '缺少有效的 Proof-of-Work 驗證解。',
      };
    }

    const digest = crypto
      .createHash('sha256')
      .update(`${stored.challengeId}:${stored.powNonce}:${solution}`, 'utf-8')
      .digest();
    if (!hasLeadingZeroBits(digest, stored.powDifficulty)) {
      stored.attempts += 1;
      if (stored.attempts >= 3) {
        activeChallenges.delete(challengeId);
        counters.blockedTotal += 1;
      }
      return {
        ok: false,
        forbidden: true,
        error: '瀏覽器挑戰驗證失敗（雜湊難度不符）。',
        remainingAttempts: Math.max(0, 3 - stored.attempts),
      };
    }

    activeChallenges.delete(challengeId);
    const nonce = crypto.randomBytes(12).toString('hex');
    const expiresAt = now + BROWSER_TOKEN_TTL_MS;
    const uaStr = String(options.userAgent ?? '');
    const token = encryptBotGuardToken('browser', ip, uaStr, now, expiresAt, nonce);

    counters.verifiedBrowsersTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'verified',
      maskedIp: maskClientIp(ip),
      path: '/api/bot/challenge',
      riskScore: 0,
      reasons: ['browser_pow_verified'],
    });

    return {
      ok: true,
      scope: 'browser',
      humanToken: token,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSec: Math.round(BROWSER_TOKEN_TTL_MS / 1000),
    };
  }

  // Mode 2: Interactive Human Arithmetic Challenge (issues encrypted `human` scope token)
  const answerStr = String(answerRaw ?? '').trim();
  if (!/^-?\d{1,4}$/.test(answerStr)) {
    return { ok: false, forbidden: true, error: '請輸入整數驗證答案。' };
  }
  const submitted = Number.parseInt(answerStr, 10);

  if (submitted === stored.expectedAnswer) {
    activeChallenges.delete(challengeId);
    state.strikes = 0;
    state.quarantineUntil = 0;
    state.timestamps = [];
    state.payloadHashes = [];

    const nonce = crypto.randomBytes(12).toString('hex');
    const expiresAt = now + HUMAN_TOKEN_TTL_MS;
    const uaStr = String(options.userAgent ?? '');
    const humanToken = encryptBotGuardToken('human', ip, uaStr, now, expiresAt, nonce);

    counters.verifiedHumansTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'verified',
      maskedIp: maskClientIp(ip),
      path: '/api/bot/challenge',
      riskScore: 0,
      reasons: ['human_challenge_passed'],
    });

    return {
      ok: true,
      scope: 'human',
      humanToken,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSec: Math.round(HUMAN_TOKEN_TTL_MS / 1000),
    };
  }

  stored.attempts += 1;
  if (stored.attempts >= 3) {
    activeChallenges.delete(challengeId);
    state.strikes += 1;
    const quarantineSec = Math.min(QUARANTINE_BASE_SEC * state.strikes, 3600);
    state.quarantineUntil = now + quarantineSec * 1000;
    counters.blockedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'block',
      maskedIp: maskClientIp(ip),
      path: '/api/bot/challenge/verify',
      riskScore: 100,
      reasons: ['challenge_failed_max_attempts'],
    });
    return {
      ok: false,
      forbidden: true,
      error: `驗證連續錯誤次數過多，系統已暫時封鎖來源 ${quarantineSec} 秒。`,
      remainingAttempts: 0,
    };
  }

  const remaining = 3 - stored.attempts;
  return {
    ok: false,
    forbidden: true,
    error: `答案不正確，尚餘 ${remaining} 次嘗試機會。`,
    remainingAttempts: remaining,
  };
}

function computeStdev(values: number[]): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function evaluateWebBotRequest(
  req: express.Request,
  ip: string,
  options: {
    honeypotValue?: unknown;
    payloadFingerprint?: string;
    authenticatedByApiToken?: boolean;
    requireToken?: boolean;
  } = {}
): WebBotVerdict {
  if (!isBotGuardEnabled()) {
    return { allowed: true, action: 'allow', riskScore: 0, reasons: [] };
  }

  const now = Date.now();
  const state = getOrCreateIpState(ip, now);
  const reqPath = req.originalUrl || req.path || '/api/bot';
  const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());

  // 1. Honeypot trap (hidden field that only automated form-fillers / scrapers populate)
  const hpHeader = typeof req.headers['x-honeypot'] === 'string' ? req.headers['x-honeypot'] : '';
  const hpVal =
    (typeof options.honeypotValue === 'string' ? options.honeypotValue.trim() : '') ||
    hpHeader.trim();
  if (hpVal.length > 0) {
    state.strikes += 1;
    const quarantineSec = Math.min(QUARANTINE_BASE_SEC * state.strikes, 3600);
    state.quarantineUntil = now + quarantineSec * 1000;
    counters.honeypotHitsTotal += 1;
    counters.blockedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'block',
      maskedIp: maskClientIp(ip),
      path: reqPath,
      riskScore: 100,
      reasons: ['honeypot_triggered'],
    });
    return {
      allowed: false,
      action: 'block',
      riskScore: 100,
      reasons: ['honeypot_triggered'],
      retryAfterSec: quarantineSec,
      message: `偵測到自動化惡意機器人行為（誘捕陷阱觸發），來源已暫時封鎖 ${quarantineSec} 秒。`,
    };
  }

  // 2. Active IP quarantine check
  if (state.quarantineUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((state.quarantineUntil - now) / 1000));
    counters.blockedTotal += 1;
    return {
      allowed: false,
      action: 'block',
      riskScore: 100,
      reasons: ['ip_quarantined'],
      retryAfterSec,
      message: `此來源因異常機器人行為暫時遭到封鎖，請於 ${retryAfterSec} 秒後再試。`,
    };
  }

  // 3. Direct BOT_GUARD_SECRET server-to-server validation (constant-time SHA-256 comparison)
  const secretCheck = verifyBotGuardSecretHeader(req);
  if (secretCheck === 'valid') {
    counters.secretAuthTotal += 1;
    return { allowed: true, action: 'allow', riskScore: 0, reasons: ['bot_guard_secret_verified'] };
  }
  if (secretCheck === 'invalid') {
    state.strikes += 1;
    counters.blockedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'block',
      maskedIp: maskClientIp(ip),
      path: reqPath,
      riskScore: 95,
      reasons: ['invalid_bot_guard_secret'],
    });
    return {
      allowed: false,
      action: 'block',
      riskScore: 95,
      reasons: ['invalid_bot_guard_secret'],
      retryAfterSec: QUARANTINE_BASE_SEC,
      message: '無效的 BOT_GUARD_SECRET 驗證憑證，請求已被拒絕（403 Forbidden）。',
    };
  }

  // 4. Record behavioral window for mutating requests (prevents benign UI polling from tripping burst)
  if (isMutating) {
    state.timestamps = state.timestamps.filter((ts) => now - ts <= BURST_WINDOW_MS);
    state.timestamps.push(now);

    const payloadHash = hashPayloadFingerprint(options.payloadFingerprint);
    state.payloadHashes = state.payloadHashes.filter((p) => now - p.ts <= DUPLICATE_WINDOW_MS);
    if (payloadHash) {
      state.payloadHashes.push({ ts: now, hash: payloadHash });
    }
  }

  // 5. Validate BOT_GUARD_SECRET-signed token (X-Bot-Guard-Token / X-Human-Token)
  const presentedToken = extractPresentedToken(req);
  const configuredSecret = getConfiguredBotGuardSecret();
  let tokenScope: BotGuardTokenScope | null = null;

  if (presentedToken) {
    // Allow direct BOT_GUARD_SECRET in X-Bot-Guard-Token ONLY when BOT_GUARD_SECRET is configured
    if (
      configuredSecret &&
      !presentedToken.includes('.') &&
      constantTimeHashEquals(presentedToken, configuredSecret)
    ) {
      counters.secretAuthTotal += 1;
      return {
        allowed: true,
        action: 'allow',
        riskScore: 0,
        reasons: ['bot_guard_secret_verified'],
      };
    }

    const tokenResult = verifyBotGuardToken(
      presentedToken,
      ip,
      String(req.headers['user-agent'] ?? '')
    );
    if (!tokenResult.valid) {
      const challenge = issueHumanChallenge(ip);
      const automatedUa = isAutomatedUserAgent(req.headers['user-agent']);
      counters.challengedTotal += 1;
      recordEvent({
        timestamp: new Date(now).toISOString(),
        action: 'challenge',
        maskedIp: maskClientIp(ip),
        path: reqPath,
        riskScore: 80,
        reasons: [`invalid_bot_guard_token:${tokenResult.reason || 'invalid'}`],
      });
      return {
        allowed: false,
        action: 'challenge',
        challengeMode: automatedUa ? 'human' : 'pow',
        riskScore: 80,
        reasons: [`invalid_bot_guard_token:${tokenResult.reason || 'invalid'}`],
        challenge,
        message: 'BotGuard 驗證權杖無效或已過期，請重新完成驗證後再試（403 Forbidden）。',
      };
    }
    tokenScope = tokenResult.scope ?? 'browser';
  }

  // 6. Human-verified token bypass (still protected against extreme flooding)
  if (tokenScope === 'human') {
    if (isMutating && state.timestamps.length >= BURST_MAX_HITS * 3) {
      state.strikes += 1;
      const quarantineSec = Math.min(QUARANTINE_BASE_SEC * state.strikes, 3600);
      state.quarantineUntil = now + quarantineSec * 1000;
      counters.blockedTotal += 1;
      recordEvent({
        timestamp: new Date(now).toISOString(),
        action: 'block',
        maskedIp: maskClientIp(ip),
        path: reqPath,
        riskScore: 100,
        reasons: ['extreme_burst_flood'],
      });
      return {
        allowed: false,
        action: 'block',
        riskScore: 100,
        reasons: ['extreme_burst_flood'],
        retryAfterSec: quarantineSec,
        message: `請求頻率異常過高，系統已暫時限制存取 ${quarantineSec} 秒。`,
      };
    }
    return { allowed: true, action: 'allow', riskScore: 0, reasons: ['human_token_verified'] };
  }

  // 7. Strict middleware enforcement: missing BOT_GUARD_SECRET-signed token -> 403 Forbidden
  if (options.requireToken && !tokenScope) {
    const automatedUa = !options.authenticatedByApiToken && isAutomatedUserAgent(req.headers['user-agent']);
    const reasons = ['missing_bot_guard_token'];
    let riskScore = 60;
    if (automatedUa) {
      reasons.push('automated_user_agent');
      riskScore += 30;
    }

    if (automatedUa && state.strikes >= 2) {
      state.strikes += 1;
      const quarantineSec = Math.min(QUARANTINE_BASE_SEC * state.strikes, 3600);
      state.quarantineUntil = now + quarantineSec * 1000;
      counters.blockedTotal += 1;
      recordEvent({
        timestamp: new Date(now).toISOString(),
        action: 'block',
        maskedIp: maskClientIp(ip),
        path: reqPath,
        riskScore: 95,
        reasons,
      });
      return {
        allowed: false,
        action: 'block',
        riskScore: 95,
        reasons,
        retryAfterSec: quarantineSec,
        message: `偵測到未授權自動化機器人流量，已暫時封鎖來源 ${quarantineSec} 秒（403 Forbidden）。`,
      };
    }

    if (automatedUa) {
      state.strikes += 1;
    }
    const challenge = issueHumanChallenge(ip);
    counters.challengedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'challenge',
      maskedIp: maskClientIp(ip),
      path: reqPath,
      riskScore,
      reasons,
    });
    return {
      allowed: false,
      action: 'challenge',
      challengeMode: automatedUa ? 'human' : 'pow',
      riskScore,
      reasons,
      challenge,
      message: automatedUa
        ? '偵測到自動化機器人流量且缺少有效的 BotGuard 驗證權杖（403 Forbidden）。'
        : '缺少有效的 BotGuard 驗證權杖，請完成安全挑戰驗證以取得存取權限（403 Forbidden）。',
    };
  }

  // 8. Behavioral & client-fingerprint checks (for `browser`-scoped tokens and non-strict routes)
  let riskScore = 0;
  const reasons: string[] = [];

  if (!options.authenticatedByApiToken) {
    if (isAutomatedUserAgent(req.headers['user-agent'])) {
      riskScore += 55;
      reasons.push('automated_user_agent');
    }

    const hasAcceptLang = Boolean(String(req.headers['accept-language'] || '').trim());
    const hasSecFetch = Boolean(
      req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode'] || req.headers['sec-ch-ua']
    );
    const hasUiInteraction = String(req.headers['x-client-interaction'] || '').trim() === '1';
    if (!hasAcceptLang && !hasSecFetch && !hasUiInteraction) {
      riskScore += 20;
      reasons.push('missing_browser_headers');
    }
  }

  if (isMutating) {
    // Burst velocity & low-jitter robotic cadence
    if (state.timestamps.length >= BURST_MAX_HITS + 4) {
      riskScore += 90;
      reasons.push('severe_burst_flood');
    } else if (state.timestamps.length >= BURST_MAX_HITS) {
      riskScore += 45;
      reasons.push('burst_velocity');
    }

    if (state.timestamps.length >= 5) {
      const intervals: number[] = [];
      for (let i = 1; i < state.timestamps.length; i += 1) {
        intervals.push(state.timestamps[i] - state.timestamps[i - 1]);
      }
      const meanMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const stdevMs = computeStdev(intervals);
      if (meanMs <= 3000 && stdevMs < 120) {
        riskScore += 40;
        reasons.push('robotic_cadence');
      }
    }

    // Duplicate payload flood
    const payloadHash = hashPayloadFingerprint(options.payloadFingerprint);
    if (payloadHash) {
      const sameCount = state.payloadHashes.filter((p) => p.hash === payloadHash).length;
      if (sameCount >= DUPLICATE_MAX_HITS + 2) {
        riskScore += 90;
        reasons.push('severe_duplicate_flood');
      } else if (sameCount >= DUPLICATE_MAX_HITS) {
        riskScore += 50;
        reasons.push('duplicate_payload_flood');
      }
    }
  }

  // Repeat-offender escalation
  if (state.strikes > 0 && riskScore > 0) {
    riskScore += Math.min(35, state.strikes * 20);
    reasons.push('repeat_offender');
  }

  if (riskScore >= BLOCK_THRESHOLD) {
    state.strikes += 1;
    const quarantineSec = Math.min(QUARANTINE_BASE_SEC * state.strikes, 3600);
    state.quarantineUntil = now + quarantineSec * 1000;
    counters.blockedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'block',
      maskedIp: maskClientIp(ip),
      path: reqPath,
      riskScore,
      reasons,
    });
    return {
      allowed: false,
      action: 'block',
      riskScore,
      reasons,
      retryAfterSec: quarantineSec,
      message: `偵測到惡意機器人或高頻洗版行為，系統已暫時封鎖此來源 ${quarantineSec} 秒。`,
    };
  }

  if (riskScore >= CHALLENGE_THRESHOLD) {
    const challenge = issueHumanChallenge(ip);
    counters.challengedTotal += 1;
    recordEvent({
      timestamp: new Date(now).toISOString(),
      action: 'challenge',
      maskedIp: maskClientIp(ip),
      path: reqPath,
      riskScore,
      reasons,
    });
    return {
      allowed: false,
      action: 'challenge',
      challengeMode: 'human',
      riskScore,
      reasons,
      challenge,
      message: '系統偵測到疑似自動化機器人存取特徵，請完成人機驗證以繼續操作。',
    };
  }

  return {
    allowed: true,
    action: 'allow',
    riskScore,
    reasons: tokenScope ? ['browser_token_verified'] : reasons,
  };
}

export interface BotGuardMiddlewareOptions {
  getClientIp: (req: express.Request) => string;
  isApiTokenAuthenticated?: (req: express.Request) => boolean;
  exemptPaths?: string[];
  requireToken?: boolean;
  onBlock?: (req: express.Request, ip: string, verdict: WebBotVerdict) => void;
  onChallenge?: (req: express.Request, ip: string, verdict: WebBotVerdict) => void;
}

/**
 * Express middleware enforcing BOT_GUARD_SECRET token validation, challenge verification,
 * honeypot traps, and automated bot detection across all mounted `/api/bot/*` endpoints.
 * Any request lacking a valid token or failing the challenge receives HTTP 403 Forbidden.
 */
export function createBotGuardMiddleware(
  options: BotGuardMiddlewareOptions
): express.RequestHandler {
  const exemptPaths = new Set(options.exemptPaths ?? ['/challenge', '/challenge/verify']);
  const requireToken = options.requireToken ?? true;

  return (req, res, next) => {
    if (!isBotGuardEnabled()) {
      next();
      return;
    }

    const ip = options.getClientIp(req);
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';

    // Exempt challenge endpoints from requiring an existing token, but still enforce IP quarantine
    if (exemptPaths.has(normalizedPath)) {
      const now = Date.now();
      const existing = ipStates.get(ip);
      if (existing && existing.quarantineUntil > now) {
        const retryAfterSec = Math.max(1, Math.ceil((existing.quarantineUntil - now) / 1000));
        counters.blockedTotal += 1;
        res.status(403).json({
          ok: false,
          botBlocked: true,
          error: `此來源因異常機器人行為暫時遭到封鎖，請於 ${retryAfterSec} 秒後再試。`,
          retryAfterSec,
        });
        return;
      }
      next();
      return;
    }

    const body =
      req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? (req.body as Record<string, unknown>)
        : undefined;
    const honeypotValue = body ? (body._hp ?? body.website_url) : undefined;
    let payloadFingerprint: string | undefined;
    if (body) {
      if (typeof body.text === 'string' && body.text.trim()) {
        payloadFingerprint = body.text;
      } else if (typeof body.audioBase64 === 'string' && body.audioBase64.length > 0) {
        payloadFingerprint = `voice-b64:${body.audioBase64.length}`;
      }
    } else if (normalizedPath === '/voice-stream') {
      const contentLen = req.headers['content-length'];
      if (typeof contentLen === 'string' && contentLen) {
        payloadFingerprint = `voice-stream:${contentLen}`;
      }
    }

    const verdict = evaluateWebBotRequest(req, ip, {
      honeypotValue,
      payloadFingerprint,
      authenticatedByApiToken: options.isApiTokenAuthenticated?.(req) ?? false,
      requireToken,
    });

    if (verdict.allowed) {
      next();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    if (verdict.action === 'block') {
      options.onBlock?.(req, ip, verdict);
      res.status(403).json({
        ok: false,
        botBlocked: true,
        botGuardRejected: true,
        error: verdict.message || '偵測到惡意機器人行為，請求已被封鎖（403 Forbidden）。',
        reason: verdict.message || '偵測到惡意機器人行為，請求已被封鎖（403 Forbidden）。',
        reasons: verdict.reasons,
        retryAfterSec: verdict.retryAfterSec ?? QUARANTINE_BASE_SEC,
      });
      return;
    }

    options.onChallenge?.(req, ip, verdict);
    res.status(403).json({
      ok: false,
      botGuardRejected: true,
      challengeRequired: true,
      challengeMode: verdict.challengeMode ?? 'human',
      error: verdict.message || '請先完成人機驗證以繼續操作（403 Forbidden）。',
      reason: verdict.message || '請先完成人機驗證以繼續操作（403 Forbidden）。',
      reasons: verdict.reasons,
      challenge: verdict.challenge,
    });
  };
}

export function getBotGuardStats() {
  const now = Date.now();
  let activeQuarantinedIps = 0;
  for (const state of ipStates.values()) {
    if (state.quarantineUntil > now) activeQuarantinedIps += 1;
  }
  pruneExpiredChallenges(now);
  return {
    enabled: isBotGuardEnabled(),
    middlewareActive: true,
    secretConfigured: Boolean(getConfiguredBotGuardSecret()),
    tokenEncryption: 'aes-256-gcm',
    browserTokenTtlSec: Math.round(BROWSER_TOKEN_TTL_MS / 1000),
    humanTokenTtlSec: Math.round(HUMAN_TOKEN_TTL_MS / 1000),
    blockedTotal: counters.blockedTotal,
    challengedTotal: counters.challengedTotal,
    verifiedHumansTotal: counters.verifiedHumansTotal,
    verifiedBrowsersTotal: counters.verifiedBrowsersTotal,
    secretAuthTotal: counters.secretAuthTotal,
    honeypotHitsTotal: counters.honeypotHitsTotal,
    activeQuarantinedIps,
    activeChallenges: activeChallenges.size,
    trackedIps: ipStates.size,
    recentEvents: [...recentEvents],
  };
}
