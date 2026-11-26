/**
 * Shared types for the bot guard.
 * (Split out of the former single-file botGuard.ts; logic is unchanged.)
 */

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

export interface IpBehaviorState {
  timestamps: number[];
  payloadHashes: Array<{ ts: number; hash: string }>;
  strikes: number;
  quarantineUntil: number;
  lastSeen: number;
}

export interface StoredChallenge {
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
