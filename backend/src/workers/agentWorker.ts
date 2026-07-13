/**
 * agentWorker.ts
 *
 * Processes "agent-run" jobs off the BullMQ queue.
 * Each job runs the full runAgent() loop inside an E2B sandbox and streams
 * events back to the WS server via Redis pub/sub (publishWsEvent).
 *
 * Abort mechanism:
 *   - STOP_AGENT (from WSManager) sets the Redis key  abort:{workspaceId}
 *   - We poll it every iteration via signal.abort()
 */

import "../env";
import { randomUUID } from "crypto";
import { Worker, Job } from "bullmq";
import { Sandbox } from "@e2b/code-interpreter";
import { createRedisConnection, redisConnection } from "../queue/connection";
import { publishWsEvent } from "../queue/eventRelay";
import { AgentJobPayload } from "../queue/jobTypes";
import { runOrchestrator } from "../brain/agents/orchestratorRunner";
import { ai } from "../brain/ai";
import { workspaceService, agentRunService, workspaceMemoryService, messageService, agentLockService, todoService } from "../services";
import { buildUpdateContext, parseTodosFromContext } from "../brain/planningUtils";
import { prisma } from "../lib/prisma";
import { githubSyncQueue } from "../queue/queues";
import { extractErrorPatterns } from "../memory/errorExtractor";
import { updateProjectContext } from "../memory/projectContextUpdater";
import { isPrettiMemoryEnabled } from "../memory/prettiMemoryAgent";
import OpenAI from "openai";
import { createEvent } from "../ws/protocol";
import type { EventType } from "../ws/protocol";
import { resolveProvider } from "../services/providerResolver";
import { prewarmPool } from "../sandbox/prewarmPool";
import { billingService } from "../billing/billingService";
import { billingQueue } from "../queue/queues";
import { UsageEntry, BillingJobPayload } from "../billing/types";
import { CREDIT_RESERVATION_BUFFER, MODE_BURN_RATES, PROVIDER_MULTIPLIERS } from "../billing/constants";

// Helper so workers can call createEvent with dynamic string names
const emitEvent = (eventName: string, payload: Record<string, unknown>, meta: unknown) =>
  createEvent(eventName as EventType, payload, meta as any);

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "50", 10);
export const agentWorkerConnection = createRedisConnection("agent-worker");

/** Lightweight LLM call for fire-and-forget memory tasks (error extraction, aiAgentsMd update). */
function createInternalLLMCall(): ((systemPrompt: string, userContent: string) => Promise<string>) | null {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE || null;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    timeout: 30_000,
  });

  return async (systemPrompt: string, userContent: string): Promise<string> => {
    const resp = await client.chat.completions.create({
      model: "qwen-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
    });
    return resp.choices[0].message.content?.trim() || "";
  };
}

/** Checks Redis for an abort signal set by STOP_AGENT in WSManager */
async function isAbortRequested(workspaceId: string): Promise<boolean> {
  const val = await redisConnection.get(`abort:${workspaceId}`);
  return val === "1";
}

/** Builds an AbortSignal that polls Redis every 2 s */
function buildRedisAbortSignal(workspaceId: string): AbortController {
  const controller = new AbortController();

  const interval = setInterval(async () => {
    if (await isAbortRequested(workspaceId)) {
      console.log(`[AgentWorker] 🛑 Abort signal detected for workspace ${workspaceId}`);
      controller.abort();
      clearInterval(interval);
    }
  }, 2_000);

  // Clean up interval when signal fires for any reason
  controller.signal.addEventListener("abort", () => clearInterval(interval), { once: true });

  return controller;
}

async function processAgentJob(job: Job<AgentJobPayload>) {
  const tJobReceived = Date.now();
  const { workspaceId, sandboxId, todoId, userId, provider, framework,
          templateId, projectIdea, commitMessage, planMode, multiAgent, isInitialSetup, meta, needsPlan } = job.data;

  console.log(`[TIMING] Job ${job.id} received at worker at t=${tJobReceived}`);

  /** Publish helper: emits a typed event to the WS relay */
  const emit = (eventName: string, payload: Record<string, unknown>) => {
    const evt = emitEvent(eventName, payload, { ...meta, workspaceId });
    publishWsEvent(workspaceId, evt).catch((e) =>
      console.error("[AgentWorker] publishWsEvent failed:", e.message),
    );
  };

  const tAgentStarted = Date.now();
  emit("AGENT_EVENT", { eventType: "AGENT_STARTED", message: "Agent run started." });
  console.log(`[TIMING] AGENT_STARTED emitted at t=${tAgentStarted} (delta: ${tAgentStarted - tJobReceived}ms)`);

  console.log(`[AgentWorker] ▶ Job ${job.id} | workspaceId=${workspaceId}`);

  // Fire DB row creation immediately; await the ID only after runOrchestrator finishes
  const agentRunPromise = agentRunService.create(workspaceId).catch((err: any) => {
    console.error("[AgentWorker] Failed to create AgentRun row:", err.message);
    return null;
  });
  let agentRun: Awaited<typeof agentRunPromise> = null;
  let abortCtrl: AbortController | null = null;

  // ── Billing context (must survive success/failure) ─────────────────────────
  // Use a deterministic per-attempt idempotency key so:
  // - retries don't double-charge the same attempt
  // - a failed attempt can still finalize (release reserved credits)
  const billingAttemptId =
    job.id != null ? `agent-run:${String(job.id)}:attempt:${job.attemptsMade}` : randomUUID();
  const usageAccumulator: UsageEntry[] = [];
  let reservationSucceeded = false;
  let reservedCreditsForAttempt = 0;

  try {
    // Provider already resolved in WSManager; use it directly (avoid duplicate 2.2s call)
    const resolvedProvider = provider || "QWEN_DASHSCOPE";

    // Clear stale abort flag
    await redisConnection.del(`abort:${workspaceId}`);

    // Build abort signal after del completes (Promise.all guarantees ordering)
    abortCtrl = buildRedisAbortSignal(workspaceId);

    // ── Credit reservation ────────────────────────────────────────────────────
    if (userId) {
      const reserved = await billingService.reserve(userId).catch((err) => {
        console.error("[AgentWorker] reserve failed:", err.message);
        return false; // reservation failed
      });
      if (!reserved) {
        emit("AGENT_EVENT", {
          eventType: "INSUFFICIENT_CREDITS",
          message: "You've run out of credits. Please top up to continue.",
        });
        emit("AGENT_DONE", { success: false, summary: "Insufficient credits.", sandboxId });
        return;
      }
      reservationSucceeded = true; // reservation succeeded
      reservedCreditsForAttempt = CREDIT_RESERVATION_BUFFER;
    }

    // ── Planning phase (non-plan mode only) ──────────────────────────────────
    const needsPlanFlag = needsPlan && !planMode;
    if (needsPlanFlag) {
      const tPlanStart = Date.now();
      emit("AGENT_EVENT", { eventType: "PLANNING_STARTED", message: "Planning tasks..." });

      const ws = await workspaceService.getWorkspace(workspaceId);
      if (!ws) throw new Error("Workspace not found for planning");

      const updateContext = buildUpdateContext(ws);
      const tPlanAI = Date.now();
      const planText = await ai.planUpdate(commitMessage || "", updateContext, undefined, userId);
      console.log(`[TIMING] ai.planUpdate: ${Date.now() - tPlanAI}ms`);

      const todos = parseTodosFromContext(planText);
      if (todos.length === 0) {
        emit("AGENT_EVENT", { eventType: "PLANNING_FAILED", message: "Could not generate tasks from this request." });
        throw new Error("Planning produced no tasks");
      }

      await todoService.createTodosWithDeps(workspaceId, todos, 1);

      const allTodos = await todoService.listAllTodos(workspaceId);
      emit("TODO_LIST_RESULT", { todos: allTodos, workspaceId });

      emit("AGENT_EVENT", { eventType: "PLANNING_DONE", message: `Created ${todos.length} tasks.` });
      console.log(`[TIMING] Planning phase total: ${Date.now() - tPlanStart}ms`);
    }

    const agentCtx = {
      workspaceId,
      sandboxId,
      todoId,
      userId,
      provider: resolvedProvider,
      framework,
      templateId,
      projectIdea,
      overrideSystemPrompt: job.data.overrideSystemPrompt,
      planMode: planMode ?? false,
      isInitialSetup: isInitialSetup ?? false,
      signal: abortCtrl.signal,
      usageAccumulator,
      onEvent: (e: { type: string; message: string; data?: any }) => {
        if (e.type === "ENV_REQUIRED") {
          emit("ENV_REQUIRED", {
            keys: e.data?.keys || [],
            reason: e.data?.reason || "Required",
          });
        } else if (e.type === "PLAN_QUESTIONS") {
          emit("PLAN_QUESTIONS", {
            questions: e.data?.questions || [],
            summary: e.data?.summary || "",
          });
        } else {
          emit("AGENT_EVENT", {
            eventType: e.type,
            message: e.message,
            data: e.data,
          });
        }
      },
    };

    const tOrchestratorStart = Date.now();
    const result = await runOrchestrator(agentCtx, multiAgent ?? false, emit);
    console.log(`[TIMING] runOrchestrator: ${Date.now() - tOrchestratorStart}ms`);

    // ── Mark agent run complete + update workspace memory ──────────
    agentRun = await agentRunPromise;
    const postRunWrites: Promise<unknown>[] = [];
    if (agentRun) {
      console.log(`[AgentWorker] AgentRun created: ${agentRun.id}`);
      postRunWrites.push(
        agentRunService.complete(agentRun.id, {
          status: result.success ? 'SUCCESS' : 'FAILED',
          summary: result.summary,
          port: result.port,
          backendPort: result.backendPort,
        }).catch((err: any) => console.error("[AgentWorker] Failed to complete AgentRun:", err.message)),
      );
    }
    if (result.success && (result.port || result.backendPort) && !isPrettiMemoryEnabled()) {
      console.log(`[AgentWorker] Storing port memory: frontend=${result.port}, backend=${result.backendPort}`);
      postRunWrites.push(
        workspaceMemoryService.upsert(workspaceId, {
          knownPorts: {
            ...(result.port ? { frontend: result.port } : {}),
            ...(result.backendPort ? { backend: result.backendPort } : {}),
          },
        }).catch((err: any) => console.error("[AgentWorker] Failed to update workspace memory:", err.message)),
      );
    }
    await Promise.all(postRunWrites);
    if (agentRun) console.log(`[AgentWorker] AgentRun ${agentRun.id} marked ${result.success ? 'SUCCESS' : 'FAILED'}`);

    // ── DB snapshot + optional GitHub sync ───────────────────────
    if (result.success && agentRun) {
      void (async () => {
        try {
          const ws = await workspaceService.getWorkspace(workspaceId);
          if (ws) {
            // Fire file-read and AI commit-msg generation in parallel to minimise latency
            const [snapshotFiles, aiCommitMsg] = await Promise.all([
              (async () => {
                // Read only files modified by agent (tracked via edit_file tool calls)
                const modifiedPaths = result.modifiedFiles ? [...result.modifiedFiles] : [];
                if (modifiedPaths.length === 0) return [];

                try {
                  const sandbox = await Sandbox.connect(sandboxId);
                  const files = (await Promise.all(
                    modifiedPaths.map(async (absPath) => {
                      const relPath = absPath.replace(/^\/workspace\//, "");
                      try {
                        const content = await sandbox.files.read(absPath);
                        const text = typeof content === "string"
                          ? content
                          : Buffer.from(content as any).toString("utf8");
                        return { path: relPath, content: text.slice(0, 80_000) };
                      } catch {
                        // File deleted by agent — include with null content
                        return { path: relPath, content: null as any };
                      }
                    })
                  )).filter(f => f !== null);
                  return files;
                } catch (err: any) {
                  console.error("[AgentWorker] Failed to read modified files from sandbox:", err.message);
                  return [];
                }
              })(),

              // Generate AI commit message — fast Qwen call, fire-and-forget-style
              (async (): Promise<string> => {
                // User-triggered run: generate a conventional commit from the prompt
                const prompt = (commitMessage || "").trim();
                console.log(`[AgentWorker] CommitMsg generation START: prompt="${prompt.slice(0, 100)}"`);
                if (!prompt) {
                  console.log(`[AgentWorker] CommitMsg: Empty prompt, returning fallback`);
                  return "chore: agent run completed";
                }

                const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
                if (!apiKey) {
                  console.log(`[AgentWorker] CommitMsg: No API key found, using fallback`);
                  const fallback = `feat: ${prompt.slice(0, 60)}`;
                  console.log(`[AgentWorker] CommitMsg fallback: "${fallback}"`);
                  return fallback;
                }
                console.log(`[AgentWorker] CommitMsg: API key found, calling Qwen...`);

                try {
                  console.log(`[AgentWorker] CommitMsg: Qwen request payload: model=qwen-turbo, prompt="${prompt.slice(0, 100)}..."`);
                  const res = await fetch(
                    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                      body: JSON.stringify({
                        model: "qwen-turbo",
                        temperature: 0.1,
                        max_tokens: 30,
                        messages: [
                          {
                            role: "system",
                            content:
                              "You are a git commit message generator. Reply with ONLY a single conventional commit message in the format `<type>(<scope>): <subject>` where type is one of feat|fix|chore|refactor|style|docs|test. Max 72 chars. No quotes, no explanation.",
                          },
                          {
                            role: "user",
                            content: `Generate a concise git commit message for: "${prompt.slice(0, 300)}"`,
                          },
                        ],
                      }),
                      signal: AbortSignal.timeout(4_000), // 4s hard cap
                    },
                  );
                  console.log(`[AgentWorker] CommitMsg: Qwen response status=${res.status}`);
                  if (res.ok) {
                    const data = await res.json();
                    const msg = (data.choices?.[0]?.message?.content || "").trim().split("\n")[0].slice(0, 72);
                    console.log(`[AgentWorker] CommitMsg: Qwen success, msg="${msg}"`);
                    if (msg) return msg;
                  } else {
                    console.log(`[AgentWorker] CommitMsg: Qwen HTTP error ${res.status}, falling back`);
                  }
                } catch (err) {
                  // Timeout or network issue — fall back silently
                  console.log(`[AgentWorker] CommitMsg: Qwen error: ${(err as Error).message}, falling back`);
                }
                // Fallback: derive a simple feat commit from the user prompt
                const slug = prompt.slice(0, 60).replace(/\s+/g, " ").toLowerCase();
                const fallback = `feat: ${slug}`;
                console.log(`[AgentWorker] CommitMsg fallback after Qwen error: "${fallback}"`);
                return fallback;
              })(),
            ]);

            // Guard empty snapshots — skip creating DB record if no files
            if (snapshotFiles.length === 0) {
              console.error("[AgentWorker] Snapshot skipped — 0 files returned from sandbox", {
                workspaceId,
                agentRunId: agentRun!.id,
              });
              return;
            }

            const finalCommitMsg = aiCommitMsg || commitMessage || "chore: agent run completed";

            const snapshot = await prisma.snapshot.create({
              data: {
                workspaceId,
                agentRunId: agentRun!.id,
                files: snapshotFiles as any,
                commitMessage: finalCommitMsg,
              },
            });

            if ((ws as any).githubConnected) {
              await githubSyncQueue
                .add(
                  "sync",
                  { workspaceId, triggeredAt: Date.now() },
                  { jobId: `github-sync-${workspaceId}`, delay: 30_000 },
                )
                .catch((err: any) => {
                  if (!err.message?.includes("duplicate")) {
                    console.error("[AgentWorker] githubSyncQueue enqueue failed:", err.message);
                  }
                });
            }

            console.log(
              `[AgentWorker] Snapshot ${snapshot.id} saved (${snapshotFiles.length} files) msg="${finalCommitMsg}"`,
            );
          }
        } catch (snapErr: any) {
          console.error("[AgentWorker] DB snapshot failed:", snapErr.message);
        }
      })();
    }

    // ── Plan mode: emit PLAN_READY with plan.md content ──────────
    if (planMode && result.success) {
      try {
        const planSandbox = await Sandbox.connect(sandboxId);
        const planPath = "/workspace/plan.md";
        const readResult = await planSandbox.commands.run(`cat "${planPath}" 2>/dev/null || echo ""`);
        const planContent = (readResult.stdout || "").trim();
        if (planContent) {
          const planReadyEvt = emitEvent("PLAN_READY", { content: planContent, path: planPath }, { ...meta, workspaceId });
          await publishWsEvent(workspaceId, planReadyEvt).catch((e: any) =>
            console.error("[AgentWorker] PLAN_READY publish failed:", e.message)
          );
          console.log(`[AgentWorker] 📋 PLAN_READY emitted (${planContent.length} chars)`);
        }
      } catch (planErr: any) {
        console.error("[AgentWorker] Failed to read plan.md:", planErr.message);
      }
    }

    emit("AGENT_DONE", {
      success: result.success,
      summary: result.summary,
      port: result.port,
      backendPort: result.backendPort,
      sandboxId,
      modifiedFiles: result.modifiedFiles,
    });

    // ── Post-run memory extraction (fire-and-forget — runs after AGENT_DONE) ─
    const llmCall = createInternalLLMCall();
    console.log(`[AgentWorker] Post-run memory: llmCall=${!!llmCall}, success=${result.success}, files=${result.modifiedFiles?.length ?? 0}`);
    if (llmCall) {
      void (async () => {
        // Phase 3: Extract error-resolution pairs — skipped when pretti-memory handles this automatically
        if (!isPrettiMemoryEnabled()) {
          try {
            const messages = await messageService.getByWorkspace(workspaceId, undefined, 200);
            const dbMessages = messages.reverse().map((m: any) => ({
              role: m.role as string,
              content: m.content as string,
              toolName: m.toolName as string | undefined,
            }));
            const patterns = await extractErrorPatterns(dbMessages, llmCall);
            if (patterns.length > 0) {
              await Promise.allSettled(patterns.map((p) => workspaceMemoryService.appendError(workspaceId, p)));
              console.log(`[AgentWorker] Stored ${patterns.length} error patterns for workspace ${workspaceId}`);
            }
          } catch (err) {
            console.error("[AgentWorker] Error extraction failed:", (err as Error).message);
          }
        }

        // Phase 4: Update aiAgentsMd after successful run
        if (result.success && result.modifiedFiles?.length) {
          try {
            const ws = await workspaceService.getWorkspace(workspaceId);
            if (ws?.aiAgentsMd) {
              const updated = await updateProjectContext(
                ws.aiAgentsMd,
                result.summary || '',
                result.modifiedFiles || [],
                llmCall,
              );
              if (updated) {
                await workspaceService.updateAI Agents(workspaceId, updated);
                console.log(`[AgentWorker] Updated aiAgentsMd for workspace ${workspaceId}`);
              }
            }
          } catch (err) {
            console.error("[AgentWorker] aiAgentsMd update failed:", (err as Error).message);
          }
        }
      })();
    }

    console.log(`[AgentWorker] ✅ Job ${job.id} done. success=${result.success}`);

  } catch (err: any) {
    console.error(`[AgentWorker] ❌ Job ${job.id} failed:`, err.message);

    if (agentRun) {
      await agentRunService.complete(agentRun.id, {
        status: 'FAILED',
        summary: err.message ?? 'Unknown error',
      }).catch((e: any) => console.error("[AgentWorker] Failed to mark AgentRun FAILED:", e.message));
    }

    emit("AGENT_DONE", {
      success: false,
      summary: err.message ?? "Unknown agent error",
      sandboxId,
    });

    // Re-throw so BullMQ marks the job as failed (triggers retry/DLQ)
    throw err;
  } finally {
    // Ensure abort controller is cancelled and Redis key cleaned up
    abortCtrl?.abort();
    await redisConnection.del(`abort:${workspaceId}`).catch(() => {});
    // Release the agent lock so subsequent USER_REQUESTs on this workspace can proceed.
    // job.id was issued by agentLockService.generateJobId() at enqueue time and matches
    // the lock's owner value. Compare-and-delete is owner-safe — wrong owner is a no-op.
    if (job.id) {
      await agentLockService
        .release(workspaceId, String(job.id))
        .catch((e: any) => console.warn(`[AgentWorker] lock release failed: ${e.message}`));
    }
    // Release sandbox back to pre-warm pool for reuse
    if (sandboxId && framework) {
      prewarmPool.releaseSandbox(sandboxId, framework);
      console.log(`[AgentWorker] Sandbox ${sandboxId} released to pool for ${framework}`);
    }

    // ── Async billing finalization (always runs for reserved attempts) ───────
    // Always enqueue even on thrown errors so reserved credits are released.
    if (userId && reservationSucceeded) {
      // Validate provider/mode to prevent unknown fallbacks (which cause under-billing)
      const validProviders = Object.keys(PROVIDER_MULTIPLIERS);
      const validModes = Object.keys(MODE_BURN_RATES);
      const invalidEntries = usageAccumulator.filter(
        (e) => !validProviders.includes(e.provider) || !validModes.includes(e.mode)
      );
      if (invalidEntries.length > 0) {
        console.warn(
          `[AgentWorker] Invalid provider/mode in ${invalidEntries.length} entries:`,
          invalidEntries.map((e) => `${e.provider}/${e.mode}`).join(", "),
        );
      }

      const payload: BillingJobPayload = {
        userId,
        agentRunId: billingAttemptId,
        workspaceId,
        entries: usageAccumulator,
        reservedCredits: reservedCreditsForAttempt,
      };

      try {
        await billingQueue.add("finalize", payload);
        console.log(
          `[AgentWorker] Billing finalize enqueued: attempt=${billingAttemptId} entries=${usageAccumulator.length}`,
        );
      } catch (enqueueErr: any) {
        console.error("[AgentWorker] billing enqueue failed:", enqueueErr.message);
      }
    }
  }
}

// ── Worker registration ──────────────────────────────────────────────────────
export const agentWorker = new Worker<AgentJobPayload>(
  "agent-run",
  processAgentJob,
  {
    connection: agentWorkerConnection,
    concurrency: CONCURRENCY,
    // Lock duration must outlast the longest agent run (20 iterations × ~60s)
    lockDuration: 30 * 60 * 1_000, // 30 min
    lockRenewTime: 5 * 60 * 1_000, // renew every 5 min
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

agentWorker.on("failed", (job, err) => {
  console.error(`[AgentWorker] Job ${job?.id} permanently failed:`, err.message);
});

agentWorker.on("error", (err) => {
  console.error("[AgentWorker] Worker error:", err.message);
});

console.log(`[AgentWorker] Listening on "agent-run" queue (concurrency=${CONCURRENCY})`);

// ── Background maintenance of sandbox pre-warm pool ──────────────────────────
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const maintenanceInterval = setInterval(async () => {
  try {
    await prewarmPool.maintain();
    const stats = prewarmPool.getStats();
    console.log(`[PrewarmPool] Maintenance cycle complete:`, stats);
  } catch (err: any) {
    console.error("[PrewarmPool] Maintenance failed:", err.message);
  }
}, MAINTENANCE_INTERVAL_MS);

// Clean up on worker close
agentWorker.on("error", () => {
  clearInterval(maintenanceInterval);
});
