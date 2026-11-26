/**
 * Express middleware wiring and the stats snapshot.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import type express from 'express';
import { QUARANTINE_BASE_SEC, HUMAN_TOKEN_TTL_MS, BROWSER_TOKEN_TTL_MS, isBotGuardEnabled, getConfiguredBotGuardSecret } from './config.js';
import type { WebBotVerdict } from './types.js';
import { ipStates, activeChallenges, recentEvents, counters } from './state.js';
import { pruneExpiredChallenges } from './challenge.js';
import { evaluateWebBotRequest } from './evaluate.js';

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
