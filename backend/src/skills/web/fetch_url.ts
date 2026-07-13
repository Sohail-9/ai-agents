import { FetchUrlParams, ToolResult } from "../types";

const MAX_CHARS = 8_000;
const FETCH_TIMEOUT_MS = 15_000;

function htmlToText(html: string): string {
  return html
    // Remove <script> and <style> blocks entirely
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|blockquote|pre|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetch_url(params: FetchUrlParams): Promise<ToolResult> {
  const { url, max_chars = MAX_CHARS } = params;

  console.log(`[fetch_url] Fetching: ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AI AgentsBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status} ${res.statusText} for ${url}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();

    let text: string;
    if (contentType.includes("html")) {
      text = htmlToText(raw);
    } else {
      // JSON, plain text, markdown — return as-is (already readable)
      text = raw.replace(/[ \t]+/g, " ").trim();
    }

    const truncated = text.length > max_chars
      ? text.slice(0, max_chars) + `\n\n...[truncated — ${text.length - max_chars} chars omitted]`
      : text;

    console.log(`[fetch_url] Done. content-type=${contentType} chars=${truncated.length}`);
    return { success: true, output: truncated };
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err.name === "AbortError" ? `Timeout after ${FETCH_TIMEOUT_MS}ms` : err.message;
    console.error(`[fetch_url] Error for ${url}: ${msg}`);
    return { success: false, error: msg };
  }
}
