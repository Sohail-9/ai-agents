/**
 * Backfill snapshots for workspaces that have a sandboxId but no Snapshot records.
 *
 * Usage:
 *   npx tsx scripts/backfill-snapshots.ts
 *   npx tsx scripts/backfill-snapshots.ts --dry-run           # list only, no writes
 *   npx tsx scripts/backfill-snapshots.ts --workspace <id>    # single workspace
 *   npx tsx scripts/backfill-snapshots.ts --concurrency 10    # default: 8
 */

import "../src/env";
import { Sandbox } from "@e2b/code-interpreter";
import { prisma } from "../src/lib/prisma";
import { readSandboxFiles } from "../src/utils/readSandboxFiles";

const DRY_RUN = process.argv.includes("--dry-run");
const SINGLE_WS = (() => {
  const idx = process.argv.indexOf("--workspace");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();
const CONCURRENCY = (() => {
  const idx = process.argv.indexOf("--concurrency");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 8;
})();

async function processWorkspace(
  ws: { id: string; name: string; sandboxId: string | null },
  counters: { succeeded: number; skipped: number; failed: number },
  total: number,
  index: number,
) {
  const tag = `[${index + 1}/${total}][${ws.id}] "${ws.name}"`;

  if (DRY_RUN) {
    console.log(`${tag} → DRY_RUN: would snapshot sandbox=${ws.sandboxId}`);
    return;
  }

  // 1. Wake the sandbox
  try {
    await Sandbox.connect(ws.sandboxId!);
  } catch (err: any) {
    console.warn(`${tag} ✗ sandbox unreachable: ${err.message}`);
    counters.skipped++;
    return;
  }

  // 2. Read all files (full scan)
  let files: Awaited<ReturnType<typeof readSandboxFiles>>;
  try {
    files = await readSandboxFiles(ws.sandboxId!, {
      rootPath: "/workspace",
      forceFull: true,
      maxFiles: 1500,
      maxFileSize: 80_000,
    });
  } catch (err: any) {
    console.error(`${tag} ✗ read failed: ${err.message}`);
    counters.skipped++;
    return;
  }

  if (files.length === 0) {
    console.warn(`${tag} ✗ 0 files — skipping`);
    counters.skipped++;
    return;
  }

  // 3. Write Snapshot to DB
  try {
    const snapshot = await prisma.snapshot.create({
      data: {
        workspaceId: ws.id,
        files: files as any,
        commitMessage: "chore: backfill initial snapshot",
      },
    });
    console.log(`${tag} ✓ snapshot=${snapshot.id} files=${files.length}`);
    counters.succeeded++;
  } catch (err: any) {
    console.error(`${tag} ✗ DB write failed: ${err.message}`);
    counters.failed++;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function main() {
  console.log(
    `[backfill-snapshots] DRY_RUN=${DRY_RUN} CONCURRENCY=${CONCURRENCY} SINGLE_WS=${SINGLE_WS ?? "all"}`,
  );

  const workspaces = await prisma.workspace.findMany({
    where: {
      sandboxId: { not: null },
      isDeleted: false,
      ...(SINGLE_WS ? { id: SINGLE_WS } : {}),
    },
    select: {
      id: true,
      name: true,
      sandboxId: true,
      _count: { select: { snapshots: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const targets = workspaces.filter((w) => w._count.snapshots === 0);

  console.log(
    `[backfill-snapshots] ${workspaces.length} workspaces with sandboxId → ` +
    `${targets.length} missing snapshots`,
  );

  if (targets.length === 0) {
    console.log("[backfill-snapshots] Nothing to do.");
    return;
  }

  const counters = { succeeded: 0, skipped: 0, failed: 0 };
  const start = Date.now();

  await runWithConcurrency(targets, CONCURRENCY, (ws, i) =>
    processWorkspace(ws, counters, targets.length, i),
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n[backfill-snapshots] Done in ${elapsed}s — ` +
    `succeeded=${counters.succeeded} skipped=${counters.skipped} failed=${counters.failed}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-snapshots] Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
