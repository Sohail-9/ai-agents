/**
 * sandboxPrewarmTest.ts
 *
 *   npm run test:sandbox-prewarm
 *
 * Exercises every Redis operation in SandboxPrewarmService with fake
 * sandboxIds. Does not touch E2B — pure Redis state validation, ~3 seconds.
 *
 * What's tested
 * ─────────────
 *   1. size() on empty pool                     → 0
 *   2. acquire() on empty pool                  → null
 *   3. release() three sandboxes                → size=3
 *   4. acquire() returns oldest first (ZPOPMIN) → in order
 *   5. listExpired honours maxAgeMs cutoff      → returns only old ones
 *   6. evict removes ids from pool              → size reflects removal
 *   7. drain wipes the whole pool               → returns all, size=0
 *   8. Concurrent acquires return distinct ids  → no double-handout
 */

import "../env";
import { redisConnection } from "../queue/connection";
import { sandboxPrewarmService } from "../services/sandboxPrewarmService";

const FRAMEWORK = `__test__${Date.now()}`;
const k = `warm:pool:${FRAMEWORK}`;

let failures = 0;
function expect(label: string, condition: boolean, detail = "") {
  const tag = condition ? "✅" : "❌";
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function cleanup() {
  await redisConnection.del(k);
}

async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  Sandbox prewarm pool state test");
  console.log(`  framework = ${FRAMEWORK}`);
  console.log("══════════════════════════════════════════════════════");

  await cleanup();

  // ── [1] Empty pool size ───────────────────────────────────────────
  console.log("\n[1] Empty pool");
  const initSize = await sandboxPrewarmService.size(FRAMEWORK);
  expect("size() returns 0", initSize === 0, `got ${initSize}`);

  // ── [2] Acquire on empty pool ─────────────────────────────────────
  console.log("\n[2] Acquire on empty pool");
  const emptyAcquire = await sandboxPrewarmService.acquire(FRAMEWORK);
  expect("acquire() returns null", emptyAcquire === null, `got ${emptyAcquire}`);

  // ── [3] Release three sandboxes ───────────────────────────────────
  console.log("\n[3] Release three sandboxes (with distinct timestamps)");
  const t0 = Date.now();
  await sandboxPrewarmService.release(FRAMEWORK, "sb-1", t0 - 5000); // oldest
  await sandboxPrewarmService.release(FRAMEWORK, "sb-2", t0 - 1000);
  await sandboxPrewarmService.release(FRAMEWORK, "sb-3", t0);        // newest
  const sizeAfterRelease = await sandboxPrewarmService.size(FRAMEWORK);
  expect("size() = 3 after 3 releases", sizeAfterRelease === 3, `got ${sizeAfterRelease}`);

  // ── [4] Acquire returns oldest first ──────────────────────────────
  console.log("\n[4] Acquire returns oldest-first (ZPOPMIN ordering)");
  const a1 = await sandboxPrewarmService.acquire(FRAMEWORK);
  const a2 = await sandboxPrewarmService.acquire(FRAMEWORK);
  expect("first acquire = sb-1 (oldest)", a1 === "sb-1", `got ${a1}`);
  expect("second acquire = sb-2",         a2 === "sb-2", `got ${a2}`);
  const sizeAfterAcquire = await sandboxPrewarmService.size(FRAMEWORK);
  expect("size() = 1 after 2 acquires", sizeAfterAcquire === 1, `got ${sizeAfterAcquire}`);

  // Restore the pool for the next steps
  await sandboxPrewarmService.release(FRAMEWORK, "sb-1", t0 - 5000);
  await sandboxPrewarmService.release(FRAMEWORK, "sb-2", t0 - 1000);

  // ── [5] listExpired respects cutoff ───────────────────────────────
  console.log("\n[5] listExpired(maxAge=2000ms) — should match sb-1 (5s old)");
  const expired = await sandboxPrewarmService.listExpired(FRAMEWORK, 2000);
  expect("expired contains sb-1",          expired.includes("sb-1"));
  expect("expired does NOT contain sb-2",  !expired.includes("sb-2"));
  expect("expired does NOT contain sb-3",  !expired.includes("sb-3"));

  // ── [6] evict removes them ────────────────────────────────────────
  console.log("\n[6] evict(['sb-1'])");
  const evicted = await sandboxPrewarmService.evict(FRAMEWORK, ["sb-1"]);
  expect("evict returned 1",         evicted === 1, `got ${evicted}`);
  const sizeAfterEvict = await sandboxPrewarmService.size(FRAMEWORK);
  expect("size() = 2 after evict",   sizeAfterEvict === 2, `got ${sizeAfterEvict}`);
  const listAfterEvict = await sandboxPrewarmService.list(FRAMEWORK);
  expect("list does NOT contain sb-1", !listAfterEvict.includes("sb-1"));

  // ── [7] drain wipes the pool ──────────────────────────────────────
  console.log("\n[7] drain()");
  const drained = await sandboxPrewarmService.drain(FRAMEWORK);
  expect("drain returned 2 ids",  drained.length === 2, `got ${drained.length}`);
  const sizeAfterDrain = await sandboxPrewarmService.size(FRAMEWORK);
  expect("size() = 0 after drain", sizeAfterDrain === 0, `got ${sizeAfterDrain}`);

  // ── [8] Concurrent acquires return distinct ids ───────────────────
  console.log("\n[8] Concurrent acquires return distinct ids (atomicity)");
  const N = 20;
  for (let i = 0; i < N; i++) {
    await sandboxPrewarmService.release(FRAMEWORK, `sb-c-${i}`, Date.now() + i);
  }
  const results = await Promise.all(
    Array.from({ length: N }, () => sandboxPrewarmService.acquire(FRAMEWORK)),
  );
  const ids = results.filter((r): r is string => r !== null);
  const uniqueIds = new Set(ids);
  expect("got N ids",         ids.length === N,           `got ${ids.length}`);
  expect("all ids distinct",  uniqueIds.size === N,        `unique=${uniqueIds.size}`);
  const sizeAfterRace = await sandboxPrewarmService.size(FRAMEWORK);
  expect("pool empty after race", sizeAfterRace === 0, `got ${sizeAfterRace}`);

  // ── Cleanup ───────────────────────────────────────────────────────
  await cleanup();

  console.log("\n══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log(" ✅ ALL CHECKS PASSED — prewarm pool semantics are sound");
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
