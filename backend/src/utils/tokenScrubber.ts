/**
 * @module tokenScrubber
 * @description Strips GitHub tokens and similar secrets from any string
 * before it is streamed to the frontend or written to logs.
 *
 * Patterns handled:
 *  - Fine-grained personal access tokens:  github_pat_*
 *  - Classic PATs:                          ghp_*
 *  - OAuth tokens:                          gho_*
 *  - GitHub App installation tokens:        ghs_*
 *  - Refresh tokens:                        ghr_*
 *  - 40-char lowercase hex (git credentials inside clone URLs)
 *  - x-access-token:TOKEN inside clone URLs
 */

const TOKEN_PATTERNS: RegExp[] = [
  // Fine-grained PAT
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Classic PAT / OAuth / App tokens
  /gh[opsr]_[A-Za-z0-9]{20,}/g,
  // 40-char hex (classic OAuth tokens embedded in URLs)
  /(?<=x-access-token:)[0-9a-f]{40}/g,
  // Raw 40-char hex strings that look like tokens in URLs
  /https:\/\/[^:]+:[0-9a-f]{40}@github\.com/g,
  // Bearer tokens in headers
  /Bearer\s+gh[opsr]_[A-Za-z0-9]{20,}/g,
];

const REPLACEMENT = '[REDACTED]';
const URL_REPLACEMENT = 'https://[REDACTED]@github.com';

/**
 * Remove all known token patterns from a string.
 * Safe to call on any log line or streamed text before it reaches the client.
 */
export function scrubTokens(text: string): string {
  if (!text) return text;

  let scrubbed = text;

  // Handle full clone URLs first (replace entire sensitive URL)
  scrubbed = scrubbed.replace(
    /https:\/\/[^:]+:[0-9a-f]{40}@github\.com/g,
    URL_REPLACEMENT,
  );
  scrubbed = scrubbed.replace(
    /https:\/\/x-access-token:[^@]+@github\.com/g,
    URL_REPLACEMENT,
  );

  // Generic token patterns
  scrubbed = scrubbed.replace(/github_pat_[A-Za-z0-9_]{20,}/g, REPLACEMENT);
  scrubbed = scrubbed.replace(/gh[opsr]_[A-Za-z0-9]{20,}/g, REPLACEMENT);

  return scrubbed;
}
