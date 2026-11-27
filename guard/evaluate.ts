/**
 * Per-request risk scoring: honeypot, quarantine, secret/token checks, velocity and duplicate-flood heuristics.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import type express from 'express';
import { CHALLENGE_THRESHOLD, BLOCK_THRESHOLD, QUARANTINE_BASE_SEC, BURST_WINDOW_MS, BURST_MAX_HITS, DUPLICATE_WINDOW_MS, DUPLICATE_MAX_HITS, isBotGuardEnabled, getConfiguredBotGuardSecret } from './config.js';
import type { BotGuardTokenScope, WebBotVerdict } from './types.js';
import { counters, constantTimeHashEquals, maskClientIp, isAutomatedUserAgent, recordEvent, getOrCreateIpState, hashPayloadFingerprint } from './state.js';
import { verifyBotGuardToken, verifyBotGuardSecretHeader, extractPresentedToken } from './tokens.js';
import { issueHumanChallenge } from './challenge.js';

export function computeStdev(values: number[]): number {
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
