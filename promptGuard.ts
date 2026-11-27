/**
 * Multi-layer Prompt Injection, Input Sanitization, Output Redaction, and Rate-Limit Guardrails.
 * Protects both text chat and voice-transcribed speech before reaching Gemini or ConversationStore.
 */

export const MAX_USER_MESSAGE_CHARS = 2000;
export const MAX_TRANSCRIPT_CHARS = 1000;
export const MAX_BOT_REPLY_CHARS = 4000;

export interface InjectionCheckResult {
  blocked: boolean;
  category?: 'instruction_override' | 'prompt_exfiltration' | 'role_spoofing' | 'secret_extraction';
  reason?: string;
}

// Strip invisible zero-width, bidi-override, and ASCII control characters used in prompt smuggling
const INVISIBLE_SMUGGLING_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeUserInput(raw: string, maxChars = MAX_USER_MESSAGE_CHARS): string {
  const cleaned = String(raw ?? '')
    .replace(INVISIBLE_SMUGGLING_RE, '')
    .replace(CONTROL_CHARS_RE, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars);
}

interface DetectionRule {
  category: NonNullable<InjectionCheckResult['category']>;
  reason: string;
  pattern: RegExp;
}

const INJECTION_RULES: DetectionRule[] = [
  // 1. Instruction override & jailbreak (English)
  {
    category: 'instruction_override',
    reason: '偵測到指令覆寫企圖（Instruction Override）',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|original|system|safety)\s+(?:instructions?|prompts?|rules?|directives?|constraints?)\b/i,
  },
  {
    category: 'instruction_override',
    reason: '偵測到越獄或模式切換企圖（Jailbreak / Mode Override）',
    pattern:
      /\b(?:you\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbreak|unrestricted|god\s+mode)|enter\s+(?:developer|god|jailbreak|unrestricted|admin)\s+mode|pretend\s+(?:to\s+be|you\s+are)\s+(?:an?\s+)?(?:unrestricted|jailbroken|evil)\s+(?:ai|model|assistant))\b/i,
  },
  // 1b. Instruction override & jailbreak (Traditional / Simplified Chinese)
  {
    category: 'instruction_override',
    reason: '偵測到中文指令覆寫或越獄企圖',
    pattern:
      /(?:忽略|無視|无视|忘記|忘记|覆蓋|覆盖|跳過|跳过|取消|捨棄|舍弃)(?:以上|先前|之前|前面|所有|全部|原先|上述)(?:的)?(?:所有|全部)?(?:系統|系统)?(?:指令|規則|规则|設定|设定|提示詞|提示词|限制|約束|约束)|(?:進入|进入|開啟|开启|切換到|切换到)(?:開發者模式|开发者模式|越獄模式|越狱模式|無限制模式|无限制模式|上帝模式|DAN\s*模式)|(?:解除|突破)(?:所有|全部)?(?:安全)?(?:限制|防護|防护)/i,
  },
  // 2. System prompt exfiltration (English & Chinese)
  {
    category: 'prompt_exfiltration',
    reason: '偵測到系統提示詞套取企圖（System Prompt Extraction）',
    pattern:
      /\b(?:reveal|show|print|dump|leak|output|display|repeat|give\s+me|tell\s+me)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:exact\s+|full\s+|complete\s+|original\s+|hidden\s+|internal\s+)?(?:system\s+prompt|system\s+instructions?|developer\s+prompt|initial\s+instructions?|hidden\s+rules?)\b/i,
  },
  {
    category: 'prompt_exfiltration',
    reason: '偵測到系統提示詞套取企圖',
    pattern:
      /(?:顯示|显示|輸出|输出|告訴我|告诉我|印出|打印|揭露|給我|给我|貼出|贴出|完整列出|複述|复述)(?:你|系統|系统)?(?:的)?(?:完整|原始|隱藏|隐藏|內部|内部|全部)?(?:系統提示詞|系统提示词|系統指令|系统指令|內部規則|内部规则|底層設定|底层设定|system\s*prompt)/i,
  },
  // 3. Direct secret / env extraction targeting server credentials
  {
    category: 'secret_extraction',
    reason: '偵測到敏感環境變數或 API 金鑰套取企圖',
    pattern:
      /(?:reveal|show|print|dump|output|leak|read|cat|echo|display|give\s+me|tell\s+me|顯示|显示|輸出|输出|告訴我|告诉我|印出|打印|讀取|读取|洩漏|泄露|給我|给我)[^\n]{0,40}(?:GEMINI_API_KEY|TELEGRAM_BOT_TOKEN|ADMIN_API_TOKEN|ZEN_API_KEY|WHISPER_API_KEY|TTS_API_KEY|process\.env\b|\.env\b)/i,
  },
  // 4. Chat-template / role-boundary spoofing
  {
    category: 'role_spoofing',
    reason: '偵測到偽造系統角色標籤（Role Boundary Spoofing）',
    pattern:
      /(?:<\|im_start\|>|<\|im_end\|>|<\|system\|>|<<SYS>>|\[SYSTEM(?:\s+OVERRIDE|\s+PROMPT|\s+INSTRUCTION)?\]|<\/?user_message>|^\s*###\s*(?:SYSTEM|DEVELOPER|OVERRIDE)\s*:)/im,
  },
];

export function detectPromptInjection(text: string): InjectionCheckResult {
  const normalized = sanitizeUserInput(text, MAX_USER_MESSAGE_CHARS);
  if (!normalized) {
    return { blocked: false };
  }
  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        blocked: true,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }
  return { blocked: false };
}

/**
 * Wraps untrusted user text inside explicit delimiters and escapes any tag breakouts.
 */
export function wrapUntrustedUserMessage(text: string): string {
  const safe = text.replace(/<\/?user_message>/gi, '[escaped_tag]');
  return `<user_message>\n${safe}\n</user_message>`;
}

const OUTPUT_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{35}/g, '***REDACTED_API_KEY***'],
  [/ghp_[0-9A-Za-z]{36}/g, '***REDACTED_GH_TOKEN***'],
  [/github_pat_[0-9A-Za-z_]{20,}/g, '***REDACTED_GH_TOKEN***'],
  [/\bsk-[0-9A-Za-z_-]{20,}\b/g, '***REDACTED_SECRET***'],
  [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '***REDACTED_PRIVATE_KEY***',
  ],
];

// Internal marker present only in BOT_SYSTEM_INSTRUCTION to detect verbatim prompt leakage
export const SYSTEM_POLICY_SENTINEL = 'UNTRUSTED_USER_DATA_BOUNDARY';

export function sanitizeBotOutput(rawReply: string): string {
  let text = String(rawReply ?? '').trim();
  if (!text) return '';

  if (text.includes(SYSTEM_POLICY_SENTINEL)) {
    return '基於安全原則，我無法提供系統內部設定或提示詞內容。請問有其他可以協助你的問題嗎？';
  }

  for (const [pattern, replacement] of OUTPUT_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  if (text.length > MAX_BOT_REPLY_CHARS) {
    text = `${text.slice(0, MAX_BOT_REPLY_CHARS)}…（回覆過長已截斷）`;
  }
  return text;
}

// Lightweight sliding-window per-IP rate limiter to prevent quota/DoS abuse
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
const ipBuckets = new Map<string, number[]>();

export function checkRateLimit(clientKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;

  // Periodic cleanup if map grows
  if (ipBuckets.size > 500) {
    for (const [k, stamps] of ipBuckets.entries()) {
      const fresh = stamps.filter((t) => t > cutoff);
      if (fresh.length === 0) ipBuckets.delete(k);
      else ipBuckets.set(k, fresh);
    }
  }

  const recent = (ipBuckets.get(clientKey) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_MAX_REQUESTS) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
    ipBuckets.set(clientKey, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  ipBuckets.set(clientKey, recent);
  return { allowed: true, retryAfterSec: 0 };
}
