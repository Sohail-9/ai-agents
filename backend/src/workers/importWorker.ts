/**
 * importWorker.ts
 *
 * Processes "github-import" jobs:
 *   1. provisionAndClone — spin up sandbox + git clone
 *   2. AI generates TODO plan for the repo
 *   3. Write todos to DB
 *   4. Notify WS relay via Redis pub/sub
 *   5. Chain → agent-run job with GitHub import system prompt
 */

import "../env";
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/connection";
import { agentQueue } from "../queue/queues";
import { publishWsEvent } from "../queue/eventRelay";
import { GitHubImportPayload } from "../queue/jobTypes";
import { ai } from "../brain/ai";
import { workspaceService, todoService, sandboxLifecycleService, agentLockService } from "../services";
import { provisionAndClone } from "../services/importService";
import { createEvent } from "../ws/protocol";
import { scrubTokens } from "../utils/tokenScrubber";
import { Sandbox } from "@e2b/code-interpreter";
import { resolveProvider } from "../services/providerResolver";

const CONCURRENCY = parseInt(process.env.IMPORT_WORKER_CONCURRENCY || "15", 10);
export const importWorkerConnection = createRedisConnection("import-worker");

async function processImportJob(job: Job<GitHubImportPayload>) {
  const { workspaceId, userId, sessionId, userQuery, meta } = job.data;
  console.log(`[ImportWorker] ▶ Job ${job.id} | workspaceId=${workspaceId}`);

  const emit = (eventName: string, payload: Record<string, unknown>) => {
    const evt = (createEvent as any)(eventName, payload, {
      ...meta,
      workspaceId,
    });
    publishWsEvent(workspaceId, evt).catch((e) =>
      console.error("[ImportWorker] publishWsEvent failed:", e.message),
    );
  };

  emit("REQUEST_ACCEPTED", {});

  try {
    const workspace = await workspaceService.getWorkspace(workspaceId);
    if (!workspace) throw new Error("Workspace not found in DB");

    const config = workspace.config as any;
    const { owner, repo, branch, appPath } = config as {
      owner: string;
      repo: string;
      branch: string;
      appPath?: string;
    };
    const clerkUserId = workspace.userId;

    emit("AGENT_EVENT", {
      eventType: "CLONE_STARTED",
      message: `Cloning ${owner}/${repo} (branch: ${branch})…`,
    });

    // 1. Provision sandbox + clone
    const { sandboxId, clonePath } = await provisionAndClone({
      clerkUserId,
      owner,
      repo,
      branch,
    });
    // Update sandbox id, link session, and seed lifecycle state concurrently
    await Promise.all([
      workspaceService.updateSandboxId(workspaceId, sandboxId),
      workspaceService.linkSessionToWorkspace(sessionId, workspaceId),
      sandboxLifecycleService.markCreated(workspaceId),
    ]);

    emit("AGENT_EVENT", {
      eventType: "CLONE_COMPLETE",
      message: `Repository cloned at ${clonePath}`,
    });

    // 2. Create initial TODOs in parallel
    const todoInputs: Array<{ title: string; description: string; order: number }> = [
      {
        title: "Get the development server running",
        description: `Install dependencies and start the development server for ${owner}/${repo}. Detect the package manager (npm/yarn/pnpm), install packages, and run the dev server bound to 0.0.0.0.`,
        order: 1,
      },
    ];
    if (userQuery?.trim()) {
      todoInputs.push({ title: userQuery.slice(0, 100), description: userQuery, order: 2 });
    }
    const createdTodos = await Promise.all(
      todoInputs.map((t) => todoService.createTodo({ workspaceId, ...t })),
    );
    createdTodos.forEach((t) => console.log(`[ImportWorker] Created TODO: ${t.id} - "${t.title}"`));

    // Notify frontend of all TODOs
    const allTodos = await todoService.listAllTodos(workspaceId);
    emit("TODO_LIST_RESULT", { todos: allTodos, workspaceId });

    // 3. Notify workspace ready for agent
    emit("WORKSPACE_STATE", {
      workspaceId,
      sandboxId,
      port: null,
      status: "ACTIVE",
    });

    emit("WORKSPACE_READY", {
      workspaceId,
      sandboxId,
    });

    // 4. Chain → agent-run with import context
    // Agent will focus on: install deps → run app → handle user query
    const resolvedProvider = await resolveProvider({ userId, workspaceId });

    const importOwnerKey = agentLockService.generateJobId(workspaceId);
    const importLock = await agentLockService.acquire(workspaceId, importOwnerKey);
    if (!importLock.acquired) {
      console.warn(
        `[ImportWorker] Agent already running for workspace ${workspaceId} (owner=${importLock.currentOwner}); skipping chain`,
      );
    } else {
      try {
        await agentQueue.add(
          "agent-run",
          {
            workspaceId,
            sandboxId,
            todoId: "",
            userId,
            provider: resolvedProvider,
            framework: "github-import",
            templateId: "__github_import__",
            commitMessage: `GitHub import: ${owner}/${repo}`,
            meta,
          },
          {
            jobId: importOwnerKey,
            attempts: 3,
            backoff: { type: "exponential", delay: 2_000 },
          },
        );
      } catch (err) {
        await agentLockService.release(workspaceId, importOwnerKey);
        throw err;
      }
    }

    console.log(`[ImportWorker] ✅ Job ${job.id} done — agent-run chained`);
  } catch (err: any) {
    const safeMsg = scrubTokens(err.message || "Unknown import error");
    console.error(`[ImportWorker] ❌ Job ${job.id} failed:`, safeMsg);
    emit("WORKSPACE_ERROR", { message: safeMsg });
    throw err;
  }
}

export const importWorker = new Worker<GitHubImportPayload>(
  "github-import",
  processImportJob,
  {
    connection: importWorkerConnection,
    concurrency: CONCURRENCY,
    lockDuration: 20 * 60 * 1_000, // 20 min
    lockRenewTime: 4 * 60 * 1_000,
    settings: {
      // Poll queue every 500ms instead of default 5s to catch new jobs immediately
      stalledInterval: 500,
      // Check for new jobs frequently to minimize pickup latency
      guardInterval: 1000,
      // Reduce max stalled count to fail jobs faster if worker crashes
      maxStalledCount: 2,
    } as any,
  },
);

importWorker.on("failed", (job, err) =>
  console.error(
    `[ImportWorker] Job ${job?.id} permanently failed:`,
    err.message,
  ),
);
importWorker.on("error", (err) =>
  console.error("[ImportWorker] Worker error:", err.message),
);

console.log(
  `[ImportWorker] Listening on "github-import" queue (concurrency=${CONCURRENCY})`,
);
