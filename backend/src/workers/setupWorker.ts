/**
 * setupWorker.ts
 *
 * Processes "workspace-setup" jobs:
 *   1. AI analysis → ai-agents.md
 *   2. Create E2B sandbox
 *   3. Write ai-agents.md to sandbox
 *   4. Update workspace in DB
 *   5. Create todos
 *   6. Enqueue an "agent-run" job (job chaining — no tight coupling)
 *
 * Events are published to Redis pub/sub so the WS relay forwards them live.
 */

import "../env";
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/connection";
import { agentQueue } from "../queue/queues";
import { publishWsEvent } from "../queue/eventRelay";
import { WorkspaceSetupPayload } from "../queue/jobTypes";
import { ai } from "../brain/ai";
import { ImageRef } from "../brain/types";
import { ContextBuilder } from "../context/contextBuilder";
import { SandboxManager } from "../sandbox/sandboxManager";
import { workspaceService, todoService, imageService, sandboxLifecycleService, sandboxPrewarmService, agentLockService } from "../services";
import { resolveProvider } from "../services/providerResolver";
import { createEvent } from "../ws/protocol";
import { provisionWorkspaceDatabase } from "../services/databaseService";
import { readSandboxFiles } from "../utils/readSandboxFiles";
import { prisma } from "../lib/prisma";

const CONCURRENCY = parseInt(process.env.SETUP_WORKER_CONCURRENCY || "20", 10);
export const setupWorkerConnection = createRedisConnection("setup-worker");

function parseTodosFromContext(
  context: string,
): Array<{ title: string; description: string; deps: number[] }> {
  const todos: Array<{ title: string; description: string; deps: number[] }> = [];
  const lines = context.split("\n");
  let inTodos = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === "TODOS" || line.startsWith("TODOS")) {
      inTodos = true;
      continue;
    }

    if (inTodos) {
      const titleMatch =
        line.match(/^\[(\d+)\]\s*TITLE:\s*(.+)/i) ||
        line.match(/^\[(\d+)\]\s*(.+)/i) ||
        line.match(/^(\d+)\.\s*TITLE:\s*(.+)/i) ||
        line.match(/^(\d+)\.\s*(.+)/i);

      if (titleMatch) {
        const title = (titleMatch[2] || titleMatch[1] || "").trim();
        if (!title) continue;

        let description = title;
        let deps: number[] = [];
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const next = lines[j].trim();

          if (
            next === next.toUpperCase() &&
            next.length > 3 &&
            !next.startsWith("TITLE:") &&
            !next.startsWith("DESC:") &&
            !next.startsWith("DEPS:")
          ) {
            break;
          }

          const descMatch = next.match(/^(DESC|DESCRIPTION):\s*(.+)/i);
          if (descMatch) {
            description = descMatch[2].trim();
            i = j;
            continue;
          }

          const depsMatch = next.match(/^DEPS:\s*\[([^\]]*)\]/i);
          if (depsMatch) {
            const inner = depsMatch[1].trim();
            deps = inner
              ? inner.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
              : [];
            i = j;
            continue;
          }

          if (/^\[(\d+)\]\s*/.test(next) || /^(\d+)\.\s*/.test(next)) break;
        }

        if (title.length > 3) todos.push({ title, description, deps });
        continue;
      }

      // Stop at next all-caps section header
      if (
        line &&
        !line.startsWith("[") &&
        !line.startsWith("DESC:") &&
        !line.startsWith("DEPS:") &&
        !/^(\d+)\./.test(line) &&
        line === line.toUpperCase() &&
        line.length > 3
      ) {
        inTodos = false;
      }
    }
  }

  return todos;
}

async function processSetupJob(job: Job<WorkspaceSetupPayload>) {
  const {
    workspaceId,
    idea,
    framework,
    language,
    database,
    databaseName,
    databaseUrl,
    databaseRequired,
    planMode,
    multiAgent,
    userId,
    sessionId,
    imageIds,
    cachedAiResponse,
    meta,
  } = job.data;

  console.log(
    `[SetupWorker] ▶ Job ${job.id} | workspaceId=${workspaceId} | planMode=${planMode} | multiAgent=${multiAgent} | databaseRequired=${databaseRequired ?? false}`,
  );

  const emit = (eventName: string, payload: Record<string, unknown>) => {
    const evt = (createEvent as any)(eventName, payload, {
      ...meta,
      workspaceId,
    });
    publishWsEvent(workspaceId, evt).catch((e) =>
      console.error("[SetupWorker] publishWsEvent failed:", e.message),
    );
  };

  emit("REQUEST_ACCEPTED", {});

  try {
    let resolvedDatabaseName = databaseName;
    let resolvedDatabaseUrl = databaseUrl;

    // Auto-provision workspace DB when intent requires persistence and no URL exists yet.
    if (databaseRequired && !resolvedDatabaseUrl) {
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (workspace?.databaseUrl) {
        resolvedDatabaseUrl = workspace.databaseUrl;
        resolvedDatabaseName = resolvedDatabaseName || "existing";
        console.log(`[SetupWorker] Reusing existing workspace database for ${workspaceId}`);
      } else if (workspace) {
        emit("SETUP_PROGRESS", {
          message: "Creating your Neon database...",
          submessage: "This can take a few seconds.",
        });
        const provisioned = await provisionWorkspaceDatabase({
          workspaceId,
          workspaceName: workspace.name,
          userId: workspace.userId,
        });
        resolvedDatabaseName = provisioned.databaseName;
        resolvedDatabaseUrl = provisioned.databaseUrl;
        console.log(`[SetupWorker] Database provisioned for workspace ${workspaceId}: ${resolvedDatabaseName}`);
      }
    }

    // 1. AI → ai-agents.md (skip if WSManager already ran the analysis)
    let aiAgentsMd: string;
    if (cachedAiResponse?.contextContent) {
      aiAgentsMd = cachedAiResponse.contextContent;
    } else {
      const planningCtx = [
        `Framework: ${framework}`,
        `Language: ${language}`,
        `Database: ${database}${resolvedDatabaseName ? ` (${resolvedDatabaseName})` : ""}`,
      ].join("\n");
      const imageRefs: ImageRef[] = [];
      if (imageIds?.length) {
        const results = await Promise.all(imageIds.map((id) => imageService.getBytes(id)));
        results.forEach((bytes) => {
          if (bytes) imageRefs.push({ mimeType: bytes.mimeType, base64Data: bytes.buffer.toString("base64") });
        });
      }
      const aiResponse = await ai.processPrompt(
        `${idea}\n\n${planningCtx}`,
        userId,
        imageRefs.length ? imageRefs : undefined,
      );
      aiAgentsMd =
        aiResponse.contextContent ||
        ContextBuilder.getInstance().build({
          idea,
          framework,
          language,
          database,
          databaseName: resolvedDatabaseName,
        });
    }

    // 2. Spin up E2B sandbox — try the pre-warm pool first for instant attach.
    emit("AGENT_EVENT", {
      eventType: "SANDBOX_CREATING",
      message: "Creating your development sandbox…",
    });

    const warmId = await sandboxPrewarmService.acquire(framework).catch((err) => {
      console.warn(`[SetupWorker] Pool acquire failed (fallback to fresh create): ${err.message}`);
      return null;
    });
    if (warmId) {
      console.log(`[SetupWorker] Acquired warm sandbox ${warmId} for framework="${framework}"`);
    }

    let sandboxId: string;
    let resolvedTemplateId: string;
    try {
      const result = await SandboxManager.getInstance().openAndInit({
        aiAgentsMd,
        framework,
        databaseUrl: resolvedDatabaseUrl,
        databaseName: resolvedDatabaseName,
        workspaceId,
        sandboxId: warmId ?? undefined,
      });
      sandboxId = result.sandboxId;
      resolvedTemplateId = result.templateId;
    } catch (err: any) {
      // Warm sandbox unusable (likely expired/killed between release and acquire) — fall back to fresh.
      if (warmId) {
        console.warn(
          `[SetupWorker] Warm sandbox ${warmId} unusable, falling back to fresh create: ${err.message}`,
        );
        const fresh = await SandboxManager.getInstance().openAndInit({
          aiAgentsMd,
          framework,
          databaseUrl: resolvedDatabaseUrl,
          databaseName: resolvedDatabaseName,
          workspaceId,
        });
        sandboxId = fresh.sandboxId;
        resolvedTemplateId = fresh.templateId;
      } else {
        throw err;
      }
    }
    console.log(`[SetupWorker] Sandbox ready: ${sandboxId}${warmId === sandboxId ? " (warm)" : " (cold)"}`);

    // 3. Persist sandbox + ai-agents.md (and seed lifecycle state)
    await Promise.all([
      workspaceService.updateSandboxId(workspaceId, sandboxId),
      workspaceService.updateAiAgents(workspaceId, aiAgentsMd),
      workspaceService.linkSessionToWorkspace(sessionId, workspaceId),
      sandboxLifecycleService.markCreated(workspaceId),
    ]);
    // 4. Notify frontend
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

    // 5. Create initial snapshot in DB (full tree from scaffold)
    try {
      const initialFiles = await readSandboxFiles(sandboxId, {
        rootPath: "/workspace",
        forceFull: true,
      });
      if (initialFiles.length > 0) {
        await prisma.snapshot.create({
          data: {
            workspaceId,
            files: initialFiles as any,
            commitMessage: "feat: initial workspace scaffold",
          },
        });
        console.log(
          `[SetupWorker] Initial snapshot created (${initialFiles.length} files) for workspace ${workspaceId}`,
        );
      }
    } catch (err: any) {
      console.error("[SetupWorker] Initial snapshot failed:", err.message);
      // Non-fatal — agent will fall back to forceFull if needed
    }

    // 5b. Create todos
    const resolvedProvider = await resolveProvider({ userId, workspaceId });

    if (planMode) {
      // Plan mode: no todos created — agent runs read-only and produces plan.md only
      console.log(
        `[SetupWorker] Plan mode: skipping todo creation for workspace ${workspaceId}`,
      );

      const planOwnerKey = agentLockService.generateJobId(workspaceId);
      const planLock = await agentLockService.acquire(workspaceId, planOwnerKey);
      if (!planLock.acquired) {
        console.warn(
          `[SetupWorker] Agent already running for workspace ${workspaceId} (owner=${planLock.currentOwner}); skipping plan-mode chain`,
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
              framework,
              templateId: resolvedTemplateId,
              projectIdea: idea,
              commitMessage: idea,
              planMode: true,
              multiAgent: multiAgent ?? false,
              meta,
            },
            { jobId: planOwnerKey, attempts: 1 },
          );
        } catch (err) {
          await agentLockService.release(workspaceId, planOwnerKey);
          throw err;
        }
      }
    } else {
      // 5b. Create todos BEFORE enqueueing agent so the wave loop always finds them
      try {
        const todos = parseTodosFromContext(aiAgentsMd);
        await todoService.createTodosWithDeps(workspaceId, todos, 1);
        const allTodos = await todoService.listAllTodos(workspaceId);
        emit("TODO_LIST_RESULT", { todos: allTodos, workspaceId });
        console.log(
          `[SetupWorker] Created ${todos.length} todos for workspace ${workspaceId}`,
        );
      } catch (err: any) {
        console.error(
          `[SetupWorker] Todo creation failed for workspace ${workspaceId}:`,
          err.message,
        );
      }

      // 6. Chain → agent-run job (todos are guaranteed to exist now)
      const chainOwnerKey = agentLockService.generateJobId(workspaceId);
      const chainLock = await agentLockService.acquire(workspaceId, chainOwnerKey);
      if (!chainLock.acquired) {
        console.warn(
          `[SetupWorker] Agent already running for workspace ${workspaceId} (owner=${chainLock.currentOwner}); skipping initial agent chain`,
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
              framework,
              templateId: resolvedTemplateId,
              projectIdea: idea,
              commitMessage: idea,
              multiAgent: multiAgent ?? false,
              isInitialSetup: true,
              meta,
            },
            {
              jobId: chainOwnerKey,
              attempts: 3,
              backoff: { type: "exponential", delay: 250 },
            },
          );
        } catch (err) {
          await agentLockService.release(workspaceId, chainOwnerKey);
          throw err;
        }
      }
    }
    console.log(
      `[SetupWorker] ✅ Chained agent-run job for workspace ${workspaceId}`,
    );
  } catch (err: any) {
    console.error(`[SetupWorker] ❌ Job ${job.id} failed:`, err.message);
    emit("WORKSPACE_ERROR", {
      message: err.message || "Workspace setup failed",
    });
    throw err; // let BullMQ retry
  }
}

export const setupWorker = new Worker<WorkspaceSetupPayload>(
  "workspace-setup",
  processSetupJob,
  {
    connection: setupWorkerConnection,
    concurrency: CONCURRENCY,
    lockDuration: 15 * 60 * 1_000, // 15 min (sandbox creation can be slow)
    lockRenewTime: 3 * 60 * 1_000,
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

setupWorker.on("failed", (job, err) =>
  console.error(
    `[SetupWorker] Job ${job?.id} permanently failed:`,
    err.message,
  ),
);
setupWorker.on("error", (err) =>
  console.error("[SetupWorker] Worker error:", err.message),
);

console.log(
  `[SetupWorker] Listening on "workspace-setup" queue (concurrency=${CONCURRENCY})`,
);
