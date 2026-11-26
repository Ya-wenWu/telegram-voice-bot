/**
 * BOT_GUARD_SECRET token primitives: HMAC challenge signatures, AES-256-GCM scoped tokens, header extraction.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

import crypto from 'crypto';
import type express from 'express';
import { getConfiguredBotGuardSecret, getSigningSecret } from './config.js';
import type { BotGuardTokenScope } from './types.js';
import { constantTimeHashEquals } from './state.js';

export function signChallengePayload(
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

export function deriveAesGcmKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(`botguard-aes-256-gcm-v2:${getSigningSecret()}`, 'utf-8')
    .digest();
}

export function hashBinding(value: string): string {
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

export function verifyBotGuardSecretHeader(
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

export function extractPresentedToken(req: express.Request): string | null {
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
