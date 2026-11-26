/**
 * Tunable thresholds / TTLs, signing-secret resolution and the enable switch.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import crypto from 'crypto';

export const MAX_TRACKED_IPS = 2000;

export const MAX_ACTIVE_CHALLENGES = 2000;

export const MAX_RECENT_EVENTS = 25;

export const CHALLENGE_THRESHOLD = 50;

export const BLOCK_THRESHOLD = 90;

export const QUARANTINE_BASE_SEC = 180;

export const CHALLENGE_TTL_MS = 120_000;

export const HUMAN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (short-lived)

export const BROWSER_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes (short-lived)

export const BURST_WINDOW_MS = 15_000;

export const BURST_MAX_HITS = 6;

export const DUPLICATE_WINDOW_MS = 30_000;

export const DUPLICATE_MAX_HITS = 3;

export const DEFAULT_POW_DIFFICULTY = 12; // ~4,096 SHA-256 hashes (~10-25ms in browser SubtleCrypto)

// Per-process ephemeral fallback when BOT_GUARD_SECRET is unset in dev/preview;
// never hardcoded or written to disk.
export const PROCESS_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

export const AUTOMATED_UA_RE =
  /(?:python-requests|python-urllib|aiohttp|httpx|curl\/|wget\/|scrapy|headlesschrome|playwright|puppeteer|selenium|phantomjs|go-http-client|axios\/|node-fetch|undici|httpie|insomnia|postmanruntime|libwww-perl|apache-httpclient|okhttp|java\/|\b(?:bot|crawler|spider|scraper|slurp|archiver)\b)/i;

export function isBotGuardEnabled(): boolean {
  const raw = (process.env.BOT_GUARD_ENABLED || 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

export function getConfiguredBotGuardSecret(): string {
  return (process.env.BOT_GUARD_SECRET || '').trim();
}

export function getSigningSecret(): string {
  return getConfiguredBotGuardSecret() || PROCESS_FALLBACK_SECRET;
}
