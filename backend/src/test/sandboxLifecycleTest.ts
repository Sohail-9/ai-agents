/**
 * sandboxLifecycleTest.ts
 *
 *   npm run test:sandbox-lifecycle
 *
 * Walks through the full state machine of SandboxLifecycleService using
 * a fake workspaceId. Validates Redis state transitions without needing
 * a real E2B sandbox (the actual Sandbox.connect / Sandbox.pause calls
 * are not exercised — they are a thin wrapper and are validated by real
 * USER_REQUEST traffic).
 *
 * What's tested
 * ─────────────
 *   1. markCreated()          → status=running, last_hit set with TTL
 *   2. getStatus()             → reads the state correctly
 *   3. recordHit()             → refreshes the TTL window
 *   4. listIdleCandidates()    → does NOT find the workspace while hot
 *   5. Manually expire TTL     → simulates 1h idle
 *   6. listIdleCandidates()    → DOES find the workspace now
 *   7. Cleanup                 → deletes all Redis keys
 */

import "../env";
import { redisConnection } from "../queue/connection";
import { sandboxLifecycleService } from "../services/sandboxLifecycleService";

const TEST_WORKSPACE = `ws-test-${Date.now()}`;

const k = {
  status:   `sandbox:status:${TEST_WORKSPACE}`,
  lastHit:  `sandbox:last_hit:${TEST_WORKSPACE}`,
  wakeLock: `sandbox:lock:wake:${TEST_WORKSPACE}`,
};

const log = (label: string, ok: boolean, detail = "") => {
  const tag = ok ? "✅" : "❌";
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ""}`);
};

let failures = 0;
function expect(label: string, condition: boolean, detail = "") {
  log(label, condition, detail);
  if (!condition) failures++;
}

async function cleanup() {
  await Promise.all([
    redisConnection.del(k.status),
    redisConnection.del(k.lastHit),
    redisConnection.del(k.wakeLock),
  ]);
}

async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  Sandbox lifecycle state-machine test");
  console.log(`  workspaceId = ${TEST_WORKSPACE}`);
  console.log("══════════════════════════════════════════════════════");

  // Ensure clean slate
  await cleanup();

  // ── Step 1 — markCreated ─────────────────────────────────────────────
  console.log("\n[1] markCreated()");
  await sandboxLifecycleService.markCreated(TEST_WORKSPACE);
  const [s1, lh1, ttl1] = await Promise.all([
    redisConnection.get(k.status),
    redisConnection.get(k.lastHit),
    redisConnection.ttl(k.lastHit),
  ]);
  expect("status = running",        s1 === "running",          `got "${s1}"`);
  expect("last_hit is set",         lh1 !== null,              `got "${lh1}"`);
  expect("last_hit TTL > 3500s",    ttl1 > 3500,               `ttl=${ttl1}s`);

  // ── Step 2 — getStatus ───────────────────────────────────────────────
  console.log("\n[2] getStatus()");
  const status2 = await sandboxLifecycleService.getStatus(TEST_WORKSPACE);
  expect("returns 'running'", status2 === "running", `got "${status2}"`);

  // ── Step 3 — recordHit refreshes the TTL ─────────────────────────────
  console.log("\n[3] recordHit() refreshes TTL");
  // Force a shorter TTL so we can observe the refresh
  await redisConnection.expire(k.lastHit, 10);
  const ttlBefore = await redisConnection.ttl(k.lastHit);
  await sandboxLifecycleService.recordHit(TEST_WORKSPACE);
  const ttlAfter = await redisConnection.ttl(k.lastHit);
  expect("TTL was 10s before recordHit", ttlBefore <= 10, `ttl=${ttlBefore}s`);
  expect("TTL refreshed back to ~3600s", ttlAfter > 3500,  `ttl=${ttlAfter}s`);

  // ── Step 4 — listIdleCandidates (hot path) ───────────────────────────
  console.log("\n[4] listIdleCandidates() — sandbox is hot, should NOT appear");
  const idleHot = await sandboxLifecycleService.listIdleCandidates();
  expect(
    "test workspace NOT in idle list",
    !idleHot.includes(TEST_WORKSPACE),
    `idle list length = ${idleHot.length}`,
  );

  // ── Step 5 — Force expiry: delete last_hit (simulates 1h idle) ───────
  console.log("\n[5] Simulating 1h idle — deleting last_hit");
  await redisConnection.del(k.lastHit);
  const lhAfterDelete = await redisConnection.get(k.lastHit);
  expect("last_hit is gone", lhAfterDelete === null);

  // ── Step 6 — listIdleCandidates (cold path) ──────────────────────────
  console.log("\n[6] listIdleCandidates() — sandbox is idle, SHOULD appear");
  const idleCold = await sandboxLifecycleService.listIdleCandidates();
  expect(
    "test workspace IS in idle list",
    idleCold.includes(TEST_WORKSPACE),
    `idle list = [${idleCold.slice(0, 5).join(", ")}${idleCold.length > 5 ? ", …" : ""}]`,
  );

  // ── Step 7 — Cleanup ────────────────────────────────────────────────
  console.log("\n[7] Cleanup");
  await cleanup();
  const [sEnd, lhEnd] = await Promise.all([
    redisConnection.get(k.status),
    redisConnection.get(k.lastHit),
  ]);
  expect("status key removed",   sEnd === null);
  expect("last_hit key removed", lhEnd === null);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log(" ✅ ALL CHECKS PASSED — sandbox lifecycle state machine is sound");
  } else {
    console.log(` ❌ ${failures} check(s) FAILED`);
  }
  console.log("══════════════════════════════════════════════════════");

  await redisConnection.quit();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await cleanup();
  await redisConnection.quit().catch(() => {});
  process.exit(1);
});
