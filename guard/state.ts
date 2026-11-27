/**
 * In-memory behavioural state (bounded LRU maps, counters, recent events) and small helpers over it.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import crypto from 'crypto';
import { MAX_TRACKED_IPS, MAX_RECENT_EVENTS, AUTOMATED_UA_RE } from './config.js';
import type { BotGuardEvent, IpBehaviorState, StoredChallenge } from './types.js';

export const ipStates = new Map<string, IpBehaviorState>();

export const activeChallenges = new Map<string, StoredChallenge>();

export const recentEvents: BotGuardEvent[] = [];

export const counters = {
  blockedTotal: 0,
  challengedTotal: 0,
  verifiedHumansTotal: 0,
  verifiedBrowsersTotal: 0,
  secretAuthTotal: 0,
  honeypotHitsTotal: 0,
};

export function constantTimeHashEquals(a: string, b: string): boolean {
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

export function recordEvent(event: BotGuardEvent): void {
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.pop();
  }
}

export function getOrCreateIpState(ip: string, now: number): IpBehaviorState {
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

export function hashPayloadFingerprint(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized || normalized.startsWith('/')) return null;
  return crypto
    .createHash('sha256')
    .update(normalized.slice(0, 512), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}
