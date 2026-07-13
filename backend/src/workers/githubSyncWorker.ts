import "../env";
import { Worker, Job } from "bullmq";
import { createRedisConnection, redisConnection } from "../queue/connection";
import { GitHubSyncPayload, GitHubConnectPayload } from "../queue/jobTypes";
import { createRepoWithUserToken, pushCommit, bulkPushHistory } from "../services/githubSyncService";
import { prisma } from "../lib/prisma";

export const githubSyncWorkerConnection = createRedisConnection("github-sync-worker");
export const githubConnectWorkerConnection = createRedisConnection("github-connect-worker");



// ── Sync worker (OPT-3: batch all unsynced snapshots per workspace) ──────────

async function processSyncJob(job: Job<GitHubSyncPayload>) {
  const { workspaceId } = job.data;

  const lockKey = `github-lock:${workspaceId}`;

  const locked = await redisConnection.set(lockKey, "1", "EX", 300, "NX");
  if (!locked) {
    await job.moveToDelayed(Date.now() + 10_000);
    return;
  }

  try {
    // Lookup user's GitHub access token
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { userId: true },
    });
    if (!ws?.userId) return;

    const account = await prisma.githubAccount.findUnique({
      where: { clerkUserId: ws.userId },
      select: { accessToken: true },
    });

    if (!account?.accessToken) return;

    const accessToken = account.accessToken;

    const snapshots = await prisma.snapshot.findMany({
      where: { workspaceId, githubSha: null },
      orderBy: { createdAt: "asc" },
    });

    if (snapshots.length === 0) return;

    // Filter out empty snapshots and mark them as "EMPTY" so we don't retry forever
    const emptySnaps = snapshots.filter(s => (s.files as any[]).length === 0);
    const validSnaps = snapshots.filter(s => (s.files as any[]).length > 0);

    if (emptySnaps.length > 0) {
      await prisma.snapshot.updateMany({
        where: { id: { in: emptySnaps.map(s => s.id) } },
        data: { githubSha: "EMPTY" },
      });
    }

    if (validSnaps.length === 0) return;

    // Merge files: replay oldest-first, latest write per path wins
    const fileMap = new Map<string, string | null>();
    for (const snap of validSnaps) {
      const files = snap.files as Array<{ path: string; content: string | null }>;
      for (const f of files) {
        fileMap.set(f.path, f.content);
      }
    }

    const mergedFiles = Array.from(fileMap.entries()).map(([path, content]) => ({
      path,
      content,
    }));
    const commitMessage =
      validSnaps.length === 1
        ? validSnaps[0].commitMessage
        : `Batch sync: ${validSnaps.map((s) => s.id).join(", ")}`;

    const sha = await pushCommit(workspaceId, { files: mergedFiles, commitMessage }, accessToken);

    if (sha) {
      await prisma.snapshot.updateMany({
        where: { id: { in: validSnaps.map((s) => s.id) } },
        data: { githubSha: sha },
      });
      console.log(`[GitHubSync] ✅ Synced ${validSnaps.length} snapshots`);
    }
  } catch (err: any) {
    console.error(`[GitHubSync] Sync failed:`, err.message);
  } finally {
    await redisConnection.del(lockKey).catch(() => {});
  }
}

// ── Connect worker (bulk push on first GitHub connect) ───────────────────────

async function processConnectJob(job: Job<GitHubConnectPayload>) {
  const { workspaceId, repoName, accessToken } = job.data;

  try {
    // 1. Create repo
    let owner: string;
    try {
      const result = await createRepoWithUserToken(accessToken, repoName);
      owner = result.owner;
    } catch (err: any) {
      console.error(`[GitHubConnect] Failed to create repo:`, err.message);
      throw err;
    }

    // 2. Save owner/repo
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { githubOwner: owner, githubRepo: repoName },
    });

    await job.updateProgress(10);

    // 3. Bulk push snapshots
    const snapshots = await prisma.snapshot.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });

    let headSha: string | null = null;
    let treeSha: string | null = null;

    if (snapshots.length > 0) {
      const result = await bulkPushHistory(workspaceId, snapshots, accessToken);
      if (!result) throw new Error("Failed to push snapshots to GitHub");

      headSha = result.headSha;
      treeSha = result.treeSha;

      await prisma.snapshot.updateMany({
        where: { id: { in: snapshots.map((s) => s.id) } },
        data: { githubSha: headSha },
      });
    }

    await job.updateProgress(90);

    // 4. Mark workspace connected
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        githubConnected: true,
        githubHeadSha: headSha,
        githubTreeSha: treeSha,
        config: {
          lastGithubError: null,
          lastGithubErrorAt: null,
        } as any,
      },
    });

    await job.updateProgress(100);
    console.log(`[GitHubConnect] ✅ Workspace ${workspaceId} connected to ${owner}/${repoName}`);
  } catch (err: any) {
    console.error(`[GitHubConnect] Job failed:`, err.message);

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        githubConnected: false,
        config: {
          lastGithubError: err.message,
          lastGithubErrorAt: new Date().toISOString(),
        } as any,
      },
    }).catch(() => {});

    throw err;
  }
}

// ── Worker registrations ─────────────────────────────────────────────────────

export const githubSyncWorker = new Worker<GitHubSyncPayload>(
  "github-sync",
  processSyncJob,
  {
    connection: githubSyncWorkerConnection,
    concurrency: 5,
    lockDuration: 5 * 60 * 1_000,
    settings: {
      stalledInterval: 500,
      guardInterval: 1_000,
      maxStalledCount: 2,
    } as any,
  },
);

export const githubConnectWorker = new Worker<GitHubConnectPayload>(
  "github-connect",
  processConnectJob,
  {
    connection: githubConnectWorkerConnection,
    concurrency: 2,
    lockDuration: 15 * 60 * 1_000,
    settings: {
      stalledInterval: 500,
      guardInterval: 1_000,
      maxStalledCount: 1,
    } as any,
  },
);

githubSyncWorker.on("failed", (job, err) =>
  console.error(`[GitHubSyncWorker] Job ${job?.id} failed:`, err.message),
);
githubSyncWorker.on("error", (err) =>
  console.error("[GitHubSyncWorker] Worker error:", err.message),
);
githubConnectWorker.on("failed", (job, err) =>
  console.error(`[GitHubConnectWorker] Job ${job?.id} failed:`, err.message),
);
githubConnectWorker.on("error", (err) =>
  console.error("[GitHubConnectWorker] Worker error:", err.message),
);

console.log(
  `[GitHubSyncWorker] Listening on "github-sync" (concurrency=5) + "github-connect" (concurrency=2)`,
);
