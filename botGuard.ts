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

// Public API. Implementation lives in ./guard/*.ts; import paths used by server.ts are unchanged.
export type { BotGuardTokenScope, ChallengeMode, IssuedChallenge, WebBotVerdict, BotGuardEvent } from './guard/types.js';
export { isBotGuardEnabled, getConfiguredBotGuardSecret } from './guard/config.js';
export { maskClientIp, isAutomatedUserAgent } from './guard/state.js';
export { encryptBotGuardToken, verifyBotGuardToken, verifyHumanToken } from './guard/tokens.js';
export { issueHumanChallenge, verifyHumanChallenge } from './guard/challenge.js';
export { evaluateWebBotRequest } from './guard/evaluate.js';
export type { BotGuardMiddlewareOptions } from './guard/middleware.js';
export { createBotGuardMiddleware, getBotGuardStats } from './guard/middleware.js';
