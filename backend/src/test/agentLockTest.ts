/**
 * agentLockTest.ts
 *
 *   npm run test:agent-lock
 *
 * Validates the distributed agent lock that replaces the colliding
 * `agent-${workspaceId}` BullMQ jobId. Pure Redis-state, no E2B, ~3s.
 *
 * What's tested
 * ─────────────
 *   1. acquire on free lock                  → success
 *   2. acquire while held by another         → fail + correct currentOwner
 *   3. release with correct owner            → success, lock gone
 *   4. release with WRONG owner              → fail, lock STAYS held
 *   5. generateJobId uniqueness              → no collisions across 1000 calls
 *   6. isLocked / getOwner reflect state
 *   7. forceRelease drops the lock unconditionally
 *   8. TTL expiry — short-TTL acquire eventually frees
 *   9. Race: N concurrent acquires           → EXACTLY ONE wins
 */

import "../env";
import { redisConnection } from "../queue/connection";
import { agentLockService } from "../services/agentLockService";

const TEST_WS = `ws-lock-test-${Date.now()}`;
const lockKey = `lock:agent:${TEST_WS}`;

let failures = 0;
function expect(label: string, condition: boolean, detail = "") {
  const tag = condition ? "✅" : "❌";
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function cleanup() {
  await redisConnection.del(lockKey);
}

async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  Agent lock test");
  console.log(`  workspace = ${TEST_WS}`);
  console.log("══════════════════════════════════════════════════════");

  await cleanup();

  // ── [1] Acquire on free lock ─────────────────────────────────────
  console.log("\n[1] Acquire on free lock");
  const owner1 = agentLockService.generateJobId(TEST_WS);
  const r1 = await agentLockService.acquire(TEST_WS, owner1);
  expect("acquired = true", r1.acquired === true);
  expect("ownerKey returned", r1.acquired && r1.ownerKey === owner1);
  expect("isLocked() = true", (await agentLockService.isLocked(TEST_WS)) === true);
  expect("getOwner() = owner1", (await agentLockService.getOwner(TEST_WS)) === owner1);

  // ── [2] Acquire while held ───────────────────────────────────────
  console.log("\n[2] Acquire while held by another caller");
  const owner2 = agentLockService.generateJobId(TEST_WS);
  const r2 = await agentLockService.acquire(TEST_WS, owner2);
  expect("acquired = false", r2.acquired === false);
  expect(
    "currentOwner = owner1",
    !r2.acquired && r2.currentOwner === owner1,
    `got ${(r2 as any).currentOwner}`,
  );

  // ── [3] Release with wrong owner ─────────────────────────────────
  console.log("\n[3] Release with WRONG owner (should be no-op)");
  const wrongRelease = await agentLockService.release(TEST_WS, owner2);
  expect("release(wrong) = false", wrongRelease === false);
  expect("lock still held", (await agentLockService.isLocked(TEST_WS)) === true);
  expect("owner still owner1", (await agentLockService.getOwner(TEST_WS)) === owner1);

  // ── [4] Release with correct owner ───────────────────────────────
  console.log("\n[4] Release with correct owner");
  const correctRelease = await agentLockService.release(TEST_WS, owner1);
  expect("release(correct) = true", correctRelease === true);
  expect("isLocked() = false", (await agentLockService.isLocked(TEST_WS)) === false);
  expect("getOwner() = null", (await agentLockService.getOwner(TEST_WS)) === null);

  // ── [5] generateJobId uniqueness ─────────────────────────────────
  console.log("\n[5] generateJobId uniqueness (1000 calls)");
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    ids.add(agentLockService.generateJobId(TEST_WS));
  }
  expect("1000 unique ids", ids.size === 1000, `got ${ids.size}`);

  // ── [6] forceRelease ─────────────────────────────────────────────
  console.log("\n[6] forceRelease drops the lock unconditionally");
  const ownerF = agentLockService.generateJobId(TEST_WS);
  await agentLockService.acquire(TEST_WS, ownerF);
  const forced = await agentLockService.forceRelease(TEST_WS);
  expect("forceRelease = true", forced === true);
  expect("lock gone after force", (await agentLockService.isLocked(TEST_WS)) === false);

  // ── [7] TTL expiry ───────────────────────────────────────────────
  console.log("\n[7] TTL expiry — 1s TTL acquire");
  const ownerT = agentLockService.generateJobId(TEST_WS);
  await agentLockService.acquire(TEST_WS, ownerT, 1);
  expect("locked immediately after acquire", (await agentLockService.isLocked(TEST_WS)) === true);
  console.log("  (waiting 1.5s for TTL to expire…)");
  await new Promise((r) => setTimeout(r, 1500));
  expect("lock auto-released after TTL", (await agentLockService.isLocked(TEST_WS)) === false);

  // ── [8] Concurrent race — exactly one winner ─────────────────────
  console.log("\n[8] Concurrent race — 20 callers, exactly ONE should win");
  const owners = Array.from({ length: 20 }, () => agentLockService.generateJobId(TEST_WS));
  const results = await Promise.all(
    owners.map((o) => agentLockService.acquire(TEST_WS, o)),
  );
  const winners = results.filter((r) => r.acquired);
  const losers = results.filter((r) => !r.acquired);
  expect("exactly 1 winner", winners.length === 1, `got ${winners.length}`);
  expect("19 losers", losers.length === 19, `got ${losers.length}`);
  if (winners.length === 1 && winners[0].acquired) {
    const winnerOwner = winners[0].ownerKey;
    const allLosersAgree = losers.every(
      (r) => !r.acquired && r.currentOwner === winnerOwner,
    );
    expect("all losers see the same currentOwner", allLosersAgree);
  }

  // ── Cleanup ──────────────────────────────────────────────────────
  await cleanup();

  console.log("\n══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log(" ✅ ALL CHECKS PASSED — agent lock is rocksolid");
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
