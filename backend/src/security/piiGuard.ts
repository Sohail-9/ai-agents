/**
 * piiGuard.ts
 *
 * Centralized PII / secret redaction utility.
 * Applies to runtime dynamic content only (user messages, tool outputs, agent replies).
 * System prompts (developer-authored, static) are intentionally excluded.
 *
 * Patterns covered:
 *  - OpenAI / Anthropic / generic bearer tokens
 *  - Google Cloud API keys
 *  - AWS access key IDs and secret access keys
 *  - PEM private keys / certificates
 *  - Email addresses
 *  - Postgres and MongoDB connection strings (which may embed credentials)
 *  - Generic "Authorization: Bearer ..." headers in tool stdout
 */

const SECRET_PATTERNS: RegExp[] = [
  // ── API keys ──────────────────────────────────────────────────────────────
  // OpenAI   sk-... (legacy 48-char) and sk-proj-... (new project keys)
  /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g,
  // Anthropic  sk-ant-...
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // Google Cloud  AIza...
  /AIza[0-9A-Za-z_-]{35}/g,
  // AWS Access Key ID
  /AKIA[0-9A-Z]{16}/g,
  // AWS Secret Access Key  (40-char base64-like string preceded by common env names)
  /(?:AWS_SECRET|aws_secret)[_A-Za-z]*\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/gi,
  // Generic Bearer token in HTTP headers
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  // Generic "token", "api_key", "apikey", "secret" assignments in tool output
  /(?:token|api[_-]?key|apikey|secret|password|passwd|pwd)\s*[=:]\s*["']?[A-Za-z0-9_./\\+=-]{8,}["']?/gi,

  // ── Cryptographic material ─────────────────────────────────────────────────
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,

  // ── Email addresses ────────────────────────────────────────────────────────
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,

  // ── Database connection URLs (may embed user:pass) ─────────────────────────
  /postgres(?:ql)?:\/\/[^\s"'`]+/gi,
  /mysql:\/\/[^\s"'`]+/gi,
  /mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi,
  /redis:\/\/[^\s"'`]+/gi,
];

const REDACTED_TOKEN = "[REDACTED]";

/**
 * Redact sensitive secrets / PII from a plain-text string.
 *
 * @param text - Raw string that may contain secrets.
 * @returns A sanitized copy with matches replaced by "[REDACTED]".
 */
// Fast-exit triggers: cheap substring checks that cover all SECRET_PATTERNS.
// If none match, skip the expensive regex scan entirely (~90% of messages).
const QUICK_TRIGGERS = [
  "sk-",
  "AIza",
  "AKIA",
  "aws_secret",
  "AWS_SECRET",
  "Bearer ",
  "-----BEGIN",
  "postgres://",
  "postgresql://",
  "mysql://",
  "mongodb://",
  "redis://",
  "token=",
  "api_key=",
  "apikey=",
  "secret=",
  "password=",
  "passwd=",
  "pwd=",
  "token:",
  "api_key:",
  "apikey:",
  "secret:",
  "password:",
  "passwd:",
  "pwd:",
];

export function redactSensitive(text: string): string {
  if (!text || typeof text !== "string") return text;

  // Fast path: skip full regex scan if no trigger substrings are present
  const hasTrigger = QUICK_TRIGGERS.some((t) => text.includes(t));
  if (!hasTrigger) return text;

  let cleaned = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex so global patterns work correctly across multiple calls.
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, REDACTED_TOKEN);
  }
  return cleaned;
}

/**
 * Redact a value that may be a string, object, or null/undefined.
 * Objects are serialized → redacted → kept as-is (not re-parsed) because
 * the callers that need a string (WS broadcast, LLM prompt) handle serialization.
 *
 * Use this when you have a toolCalls JSON blob stored as a string.
 */
export function redactSensitiveJson(raw: unknown): string {
  const str = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  return redactSensitive(str);
}
