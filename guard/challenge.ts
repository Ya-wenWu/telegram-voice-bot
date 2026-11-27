/**
 * Challenge issuing and verification (human arithmetic + browser SHA-256 Proof-of-Work).
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import crypto from 'crypto';
import { MAX_ACTIVE_CHALLENGES, QUARANTINE_BASE_SEC, CHALLENGE_TTL_MS, HUMAN_TOKEN_TTL_MS, BROWSER_TOKEN_TTL_MS, DEFAULT_POW_DIFFICULTY } from './config.js';
import type { BotGuardTokenScope, IssuedChallenge } from './types.js';
import { activeChallenges, counters, constantTimeHashEquals, maskClientIp, isAutomatedUserAgent, recordEvent, getOrCreateIpState } from './state.js';
import { signChallengePayload, encryptBotGuardToken } from './tokens.js';

export function hasLeadingZeroBits(digest: Buffer, bits: number): boolean {
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

export function pruneExpiredChallenges(now: number): void {
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
