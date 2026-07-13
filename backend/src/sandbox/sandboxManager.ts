/**
 * @module sandboxManager
 * @description Singleton that opens an e2b sandbox with the correct template
 *              based on the selected framework and writes the ai-agents.md
 *              context file into it.
 *
 * The sandbox uses lifecycle: { onTimeout: 'pause' }
 * so it pauses instead of being killed and can be resumed automatically.
 */

import { Sandbox } from "@e2b/code-interpreter";
import { getTemplateId, hasTemplate } from "../brain/systemPrompt";
import { workspaceService } from "../services/workspaceService";
import { bootstrapInspector } from "../inspector/bootstrap";
import { SandboxNormalizer } from "./sandboxNormalizer";

export interface OpenSandboxInput {
  aiAgentsMd?: string;
  framework?: string;
  templateId?: string;
  sandboxId?: string;
  /** When provided, DATABASE_URL is stored in the DB env column (source of truth) before syncing to sandbox. */
  workspaceId?: string;
  databaseUrl?: string;
  databaseName?: string;
}

export interface SandboxResult {
  sandboxId: string;
  templateId: string;
}

const SANDBOX_HEALTH_TTL_MS = 30_000;
const sandboxHealthCache = new Map<string, { sandbox: Sandbox; expires: number }>();

export class SandboxManager {
  private static instance: SandboxManager;

  private constructor() {}

  static getInstance(): SandboxManager {
    if (!SandboxManager.instance) {
      SandboxManager.instance = new SandboxManager();
    }
    return SandboxManager.instance;
  }

  private resolveTemplate(input: OpenSandboxInput): string {
    // 1. Explicit templateId always wins
    if (input.templateId) return input.templateId;

    // 2. Framework-based lookup
    if (input.framework) {
      const mapped = getTemplateId(input.framework);
      if (mapped) return mapped;
    }

    // 3. Env fallback
    return process.env.E2B_TEMPLATE_ID || "base";
  }

  async openAndInit(input: OpenSandboxInput): Promise<SandboxResult> {
    const templateId = this.resolveTemplate(input);
    const isPrebuilt = input.framework ? hasTemplate(input.framework) : false;

    let sandbox: Sandbox;

    // ---------------------------------------------------
    // Resume Existing Sandbox
    // ---------------------------------------------------

    if (input.sandboxId) {
      try {
        const cached = sandboxHealthCache.get(input.sandboxId);
        if (cached && Date.now() < cached.expires) {
          console.log(`[SandboxManager] Reusing cached sandbox: ${input.sandboxId}`);
          sandbox = cached.sandbox;
        } else {
          console.log(`[SandboxManager] Resuming sandbox: ${input.sandboxId}`);
          sandbox = await Sandbox.connect(input.sandboxId);
          sandboxHealthCache.set(input.sandboxId, {
            sandbox,
            expires: Date.now() + SANDBOX_HEALTH_TTL_MS,
          });
        }

        // Don't block on timeout refresh
        sandbox
          .setTimeout(15 * 60 * 1000)
          .catch((err) => console.warn("Failed to refresh timeout:", err.message));

        // Restart services only if required
        if (input.framework === "Next.js") {
          this.ensureServicesRunning(sandbox).catch((err) => {
            console.warn("[SandboxManager] Service recovery failed:", err.message);
          });
        }
      } catch (err: any) {
        sandboxHealthCache.delete(input.sandboxId);
        console.error(`[SandboxManager] Failed to resume sandbox ${input.sandboxId}:`, err.message);

        throw new Error(`Sandbox expired or unavailable. Start a new session.`);
      }
    } else {
      // ---------------------------------------------------
      // Create New Sandbox
      // ---------------------------------------------------

      console.log(`[SandboxManager] Creating sandbox: ${templateId}`);

      sandbox = await Sandbox.create(templateId, {
        timeoutMs: 15 * 60 * 1000,
        lifecycle: { onTimeout: "pause" },
      });
      sandboxHealthCache.set(sandbox.sandboxId, {
        sandbox,
        expires: Date.now() + SANDBOX_HEALTH_TTL_MS,
      });
    }

    // ---------------------------------------------------
    // Parallel File Operations
    // ---------------------------------------------------

    const fileWrites: Promise<any>[] = [];

    if (input.aiAgentsMd) {
      fileWrites.push(sandbox.files.write("/workspace/ai-agents.md", input.aiAgentsMd));
    }

    if (input.databaseUrl) {
      const backendEnvContent = [
        `DATABASE_URL=${input.databaseUrl}`,
        input.databaseName ? `DATABASE_NAME=${input.databaseName}` : "",
        "",
      ]
        .filter(Boolean)
        .join("\n");

      fileWrites.push(sandbox.files.write("/workspace/backend/.env", backendEnvContent));

      // DB sync should not block startup
      if (input.workspaceId) {
        workspaceService
          .setEnv(
            input.workspaceId,
            {
              DATABASE_URL: input.databaseUrl,
              ...(input.databaseName && { DATABASE_NAME: input.databaseName }),
            },
            "backend",
          )
          .catch((err) => console.warn("[SandboxManager] Failed DB env sync:", err.message));
      }
    }

    // Run all writes together
    await Promise.all(fileWrites);

    // ---------------------------------------------------
    // Fix File Ownership (CRITICAL for agent execution)
    // ---------------------------------------------------

    const normalizeResult = await SandboxNormalizer.normalizeOwnership(sandbox);
    if (!normalizeResult.success) {
      console.warn(`[SandboxManager] Ownership normalization warning:`, normalizeResult.message);
    }

    // ---------------------------------------------------
    // Initialize Git (Synchronous — all sandbox types)
    // ---------------------------------------------------

    // ALWAYS cleanup nested .git dirs (safe, idempotent)
    // This fixes prewarm sandboxes that reuse old state with template .git
    await sandbox.commands.run(
      `rm -rf /workspace/frontend/.git /workspace/backend/.git 2>/dev/null; true && ` +
      `find . -mindepth 2 -name ".git" -type d -exec rm -rf {} + 2>/dev/null; true`,
      { cwd: "/workspace" }
    ).catch(err => {
      console.warn(`[SandboxManager] Nested .git cleanup failed:`, err.message);
    });

    // Check if root /workspace/.git exists
    const gitCheckResult = await sandbox.commands.run(
      `test -d /workspace/.git && echo "exists" || echo "missing"`,
    ).catch(() => ({ stdout: "missing" }));

    const gitExists = gitCheckResult.stdout.trim() === "exists";

    // Only init if root .git is missing
    if (!gitExists) {
      try {
        await sandbox.commands.run(
          `rm -f .git/index.lock && git init && ` +
          `git config user.name "AI Agents" && ` +
          `git config user.email "bot@ai-agents.com" && ` +
          `git add . && git commit -m "feat: initial workspace scaffold"`,
          { cwd: "/workspace" }
        );
        console.log(`[SandboxManager] ✅ Git initialized for sandbox ${sandbox.sandboxId}`);
      } catch (err: any) {
        console.warn(`[SandboxManager] Git init failed:`, err.message);
      }
    }

    // ---------------------------------------------------
    // Non-Critical Background Operations
    // ---------------------------------------------------

    Promise.allSettled([
      this.runSanityChecks(sandbox, input.framework),

      bootstrapInspector({
        sandbox,
        parentOrigin: process.env.FRONTEND_URL || "http://localhost:3000",
      }),
    ]);

    return { sandboxId: sandbox.sandboxId, templateId };
  }
  private async ensureServicesRunning(sandbox: Sandbox) {
    const check = await sandbox.commands.run(`ss -tlpn | grep -E ':3000|:8000'`);

    const servicesAlive = check.stdout.trim().length > 0;

    if (servicesAlive) {
      console.log("[SandboxManager] Services already running");
      return;
    }

    console.log("[SandboxManager] Restarting services...");

    // Start both concurrently
    await Promise.all([
      sandbox.commands.run(`nohup npm run dev > /tmp/fe-dev.log 2>&1 &`, {
        cwd: "/workspace/frontend",
      }),

      sandbox.commands.run(`nohup npm run dev > /tmp/be-dev.log 2>&1 &`, {
        cwd: "/workspace/backend",
      }),
    ]);

    // Wait dynamically
    await Promise.all([this.waitForPort(sandbox, 3000), this.waitForPort(sandbox, 8000)]);

    console.log("[SandboxManager] Services recovered");
  }
  private async waitForPort(sandbox: Sandbox, port: number, timeoutMs = 8000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await sandbox.commands.run(`nc -z localhost ${port}`);

        if (result.exitCode === 0) {
          return true;
        }
      } catch {}

      await new Promise((r) => setTimeout(r, 250));
    }

    console.warn(`[SandboxManager] Port ${port} not ready after timeout`);

    return false;
  }
  private async runSanityChecks(sandbox: Sandbox, framework?: string) {
    try {
      const checks: Promise<any>[] = [sandbox.commands.run("node -v")];

      if (framework === "Next.js") {
        checks.push(
          sandbox.commands.run(
            "ls /workspace/frontend/package.json /workspace/backend/package.json",
          ),
        );
      }

      const results = await Promise.allSettled(checks);

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          console.log(`[SandboxManager] Sanity check ${index}:\n${result.value.stdout}`);
        } else {
          console.warn(`[SandboxManager] Sanity check ${index} failed:`, result.reason?.message);
        }
      });
    } catch (err: any) {
      console.warn("[SandboxManager] Sanity checks failed:", err.message);
    }
  }
}
