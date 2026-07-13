/**
 * Integration test for the Anthropic-native /api/v1/messages endpoint.
 *
 * Exercises the full Claude Code adapter surface against a RUNNING server:
 *   - auth via x-api-key AND Authorization: Bearer
 *   - model resolution by RouterModel id (anthropic/opus-4.8) and native
 *     upstream name (claude-opus-4-8)
 *   - non-streaming response shape (content[], usage, id)
 *   - streaming native Anthropic SSE frames (message_start … message_stop)
 *   - error paths (401 no key, 400 unknown model)
 *
 * Usage:
 *   PF_KEY=sk-pf-… npm run test:v1-messages
 *   PF_KEY=sk-pf-… BASE_URL=https://api.ai-agents.com npm run test:v1-messages
 *
 * Requires: server up, RouterModel seeded, an ANTHROPIC model enabled, the key's
 * wallet funded, and Azure Claude creds configured server-side.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8000";
const PF_KEY = process.env.PF_KEY || "";
const URL = `${BASE_URL}/api/v1/messages`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function body(model: string, stream = false) {
  return JSON.stringify({
    model,
    max_tokens: 32,
    stream,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
}

async function testNonStream(name: string, model: string, authHeader: Record<string, string>) {
  console.log(`\n${name} (model=${model})`);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: body(model, false),
    });
    check("HTTP 200", res.status === 200, `got ${res.status}`);
    if (res.status !== 200) { console.log("    ", (await res.text()).slice(0, 200)); return; }
    const data: any = await res.json();
    check("has id", typeof data.id === "string");
    check("role=assistant", data.role === "assistant");
    check("content is array", Array.isArray(data.content));
    const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    check("non-empty text", text.trim().length > 0, JSON.stringify(text));
    check("usage.input_tokens > 0", (data.usage?.input_tokens ?? 0) > 0);
    check("usage.output_tokens > 0", (data.usage?.output_tokens ?? 0) > 0);
    check("echoes client model id", data.model === model, `got ${data.model}`);
  } catch (e: any) {
    check("request completed", false, e?.message ?? String(e));
  }
}

async function testStream(name: string, model: string) {
  console.log(`\n${name} (model=${model}, stream)`);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": PF_KEY },
      body: body(model, true),
    });
    check("HTTP 200", res.status === 200, `got ${res.status}`);
    check("content-type is SSE", (res.headers.get("content-type") ?? "").includes("text/event-stream"));
    if (res.status !== 200 || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    const events = raw.split("\n\n").filter(Boolean).map((f) => f.match(/^event: (\w+)/)?.[1]).filter(Boolean);
    check("saw message_start", events.includes("message_start"), events.join(","));
    check("saw content_block_delta", events.includes("content_block_delta"));
    check("saw message_stop", events.includes("message_stop"));
    // Reassemble streamed text from content_block_delta frames.
    const text = raw.split("\n\n").filter((f) => f.includes("content_block_delta")).map((f) => {
      const d = f.match(/data: (.+)/)?.[1];
      try { return JSON.parse(d as string)?.delta?.text ?? ""; } catch { return ""; }
    }).join("");
    check("streamed non-empty text", text.trim().length > 0, JSON.stringify(text));
  } catch (e: any) {
    check("stream completed", false, e?.message ?? String(e));
  }
}

async function testErrors() {
  console.log("\nError paths");
  // No key → 401
  try {
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: body("anthropic/opus-4.8") });
    check("401 without key", res.status === 401, `got ${res.status}`);
  } catch (e: any) { check("401 without key", false, e?.message); }
  // Unknown model → 400
  try {
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": PF_KEY }, body: body("does/not-exist") });
    check("400 unknown model", res.status === 400, `got ${res.status}`);
  } catch (e: any) { check("400 unknown model", false, e?.message); }
}

// Compat alias: Anthropic SDK with base=…/api/v1 appends /v1/messages, landing
// on /api/v1/v1/messages. Must resolve to the same handler.
async function testCompatMount() {
  console.log("\nCompat mount /api/v1/v1/messages");
  try {
    const res = await fetch(`${BASE_URL}/api/v1/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": PF_KEY },
      body: body("claude-opus-4-8", false),
    });
    check("HTTP 200", res.status === 200, `got ${res.status}`);
    if (res.status === 200) {
      const data: any = await res.json();
      check("content is array", Array.isArray(data.content));
    }
  } catch (e: any) {
    check("compat request completed", false, e?.message ?? String(e));
  }
}

async function main() {
  console.log(`\n=== /api/v1/messages integration test ===\nendpoint: ${URL}`);
  if (!PF_KEY) { console.error("\nPF_KEY env var required (an sk-pf-… key). Aborting."); process.exit(2); }

  // Native model name via Anthropic SDK's x-api-key header (Claude Code path).
  await testNonStream("x-api-key + native id", "claude-opus-4-8", { "x-api-key": PF_KEY });
  // RouterModel id via Authorization: Bearer (OpenAI-style header).
  await testNonStream("Bearer + router id", "anthropic/opus-4.8", { Authorization: `Bearer ${PF_KEY}` });
  // Streaming.
  await testStream("stream native id", "claude-opus-4-8");
  // Compat alias mount.
  await testCompatMount();
  // Errors.
  await testErrors();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
