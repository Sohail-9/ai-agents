import express, { Router } from "express";
import multer from "multer";
import {
  workspaceService,
  messageService,
  deploymentService,
  imageService,
  screenshotService,
} from "../services";
import { getGithubAccount } from "../services/githubService";
import { githubConnectQueue } from "../queue/queues";
import {
  Deployment,
  DeploymentStatus,
  DeploymentType,
} from "../../generated/prisma";
import { Sandbox } from "@e2b/code-interpreter";
import { readSandboxFiles } from "../utils/readSandboxFiles";
import { githubSyncQueue } from "../queue/queues";
import { createAppAuth } from "@octokit/auth-app";
import { ai } from "../brain/ai";
import { ImageRef } from "../brain/types";
import { workspaceDatabaseExplorerService } from "../services/workspaceDatabaseExplorerService";
import { QueryIntentResolver } from "../brain/suggestionModeClassifier";
import { logOpsEvent } from "../lib/opsLog";
import { checkWorkspaceDeployRateLimit } from "../lib/deployRateLimit";
import IORedis from "ioredis";
import { prisma } from "../lib/prisma";
import { normalizeEnvStore, EnvTarget } from "../skills/env/env_manager";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
});

// POST /api/workspaces — Create a new workspace (from landing page).
// Accepts both multipart/form-data (with optional image files) and plain JSON.
// Multer parses multipart and exposes text fields on req.body, files on req.files.
router.post("/", upload.array("images", 5), async (req, res) => {
  try {
    const userId = res.locals.userId as string | undefined;
    const { idea, framework } = req.body;

    if (!userId || !idea) {
      return res.status(400).json({ error: "userId and idea are required" });
    }

    // PRIORITY 1: Check if this is a "suggestion mode" query
    // These are queries about building suggestion/idea platforms
    // They should show conversational suggestions first, not jump to implementation
    const intentResolver = await QueryIntentResolver(idea);
    if (intentResolver.type !== "NORMAL") {
      if (intentResolver.type === "SUGGESTION_MODE") {
        return res.json({
          requiresSuggestion: true,
          status: "suggestion_mode",
          suggestions: intentResolver.data?.suggestions,
          message: intentResolver.data?.message,
        });
      } else {
        return res.json({
          requiresClarification: true,
          status: "clarification_required",
          clarificationQuestions: intentResolver.data?.clarificationQuestions,
          message: intentResolver.data?.message,
        });
      }
    }

    // Bootstrap workspace with GENERATING status first (we need workspace.id to scope image uploads)
    const workspace = await workspaceService.createWorkspace({
      userId,
      name: "untitled",
      idea,
      framework: framework || "Next.js",
      language: "TypeScript",
      database: "None",
      summary: idea.substring(0, 80),
      status: "GENERATING",
    });

    // Upload any attached images in parallel, then load them as ImageRef for the namer.
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageIds: string[] = [];
    const imageRefs: ImageRef[] = [];
    if (files.length > 0) {
      const uploadResults = await Promise.all(
        files.map(async (file) => {
          const validationError = imageService.validateFile(file);
          if (validationError) {
            console.warn(`[REST] Skipping invalid image: ${validationError}`);
            return null;
          }
          try {
            const stored = await imageService.processAndStore(workspace.id, file);
            const bytes = await imageService.getBytes(stored.id);
            return bytes ? { id: stored.id, mimeType: bytes.mimeType, base64Data: bytes.buffer.toString("base64") } : { id: stored.id, mimeType: null, base64Data: null };
          } catch (err: any) {
            console.error("[REST] Image upload during workspace create failed:", err.message);
            return null;
          }
        }),
      );
      for (const r of uploadResults) {
        if (!r) continue;
        imageIds.push(r.id);
        if (r.base64Data) imageRefs.push({ mimeType: r.mimeType!, base64Data: r.base64Data });
      }
    }

    // Generate metadata synchronously before returning to frontend
    let finalWorkspace = workspace;
    try {
      const metadata = await ai.generateProjectMetadata(
        idea,
        userId,
        imageRefs.length ? imageRefs : undefined,
      );

      // Update workspace with generated metadata
      await Promise.all([
        workspaceService.updateName(workspace.id, metadata.name),
        workspaceService.updateSummary(workspace.id, metadata.summary),
      ]);

      // Update workspace status to READY
      finalWorkspace = await workspaceService.updateStatus(workspace.id, "READY");

      console.log(
        `[REST] Workspace created and ready: ${workspace.id} (name=${metadata.name}, images=${imageIds.length})`,
      );
    } catch (err: any) {
      console.error(`[REST] Metadata generation failed for workspace ${workspace.id}:`, err.message);
      // Mark workspace as FAILED and return error
      await workspaceService.updateStatus(workspace.id, "FAILED");
      return res.status(500).json({
        error: "Failed to generate project metadata. Please try again.",
        workspaceId: workspace.id,
      });
    }

    res.json({
      id: finalWorkspace.id,
      name: finalWorkspace.name,
      summary: finalWorkspace.summary,
      status: finalWorkspace.status,
      imageIds,
    });
  } catch (err) {
    console.error("[REST] Failed to create workspace:", err);
    res.status(500).json({ error: "Failed to create workspace" });
  }
});

// PATCH /api/workspaces/:id — Rename a workspace
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const updated = await workspaceService.updateName(id, name.trim());
    return res.json({ success: true, name: updated.name });
  } catch (err: any) {
    console.error("[REST] Failed to rename workspace:", err);
    return res.status(500).json({ error: err.message || "Failed to update workspace" });
  }
});

// DELETE /api/workspaces/:id — Soft-delete a workspace
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await workspaceService.softDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error("[REST] Failed to soft-delete workspace:", err);
    res.status(500).json({ error: "Failed to delete workspace" });
  }
});

// GET /api/workspaces/detail/:id — Get single workspace by ID
router.get("/detail/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const workspace = await workspaceService.getWorkspace(id);

    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const config = workspace.config as any;

    const [messagesCount, database] = await Promise.all([
      prisma.message.count({ where: { workspaceId: id } }),
      prisma.database.findUnique({ where: { workspaceId: id }, select: { id: true } }),
    ]);

    const spentAgg = await prisma.creditLedger.aggregate({
      where: { userId: workspace.userId, delta: { lt: 0 } },
      _sum: { delta: true },
    }).catch(() => null);
    const creditsUsed = Math.abs(spentAgg?._sum?.delta ?? 0);

    res.json({
      id: workspace.id,
      name: workspace.name,
      sandboxId: workspace.sandboxId,
      port: workspace.port,
      backendPort: workspace.backendPort,
      status: workspace.status,
      summary: workspace.summary,
      idea: config?.idea || "",
      framework: config?.framework || "Next.js",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      messagesCount,
      hasDatabase: !!(workspace.databaseUrl || database),
      creditsUsed,
      subdomain: workspace.name,
    });
  } catch (err) {
    console.error("[REST] Failed to get workspace:", err);
    res.status(500).json({ error: "Failed to fetch workspace" });
  }
});

// GET /api/workspaces/history/:id — Get chat history for a workspace
router.get("/history/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await messageService.getByWorkspace(id);
    res.json(messages);
  } catch (err) {
    console.error("[REST] Failed to get chat history:", err);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

// GET /api/workspaces/databases — List all databases for the authenticated user
router.get("/databases", async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const databases = await prisma.database.findMany({
      where: { userId },
      include: {
        workspace: {
          select: { id: true, name: true, createdAt: true, updatedAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json({
      success: true,
      databases: databases.map((db) => ({
        id: db.id,
        workspaceId: db.workspaceId,
        workspaceName: db.workspace?.name ?? db.workspaceId,
        maskedUrl: db.url.replace(/:([^:@]+)@/, ":****@"),
        createdAt: db.createdAt,
        updatedAt: db.updatedAt,
      })),
    });
  } catch (err) {
    console.error("[REST] Failed to list user databases:", err);
    return res.status(500).json({ error: "Failed to fetch databases" });
  }
});

// GET /api/workspaces/:id/deployments — Get deployments for a workspace
router.get("/:id/deployments", async (req, res) => {
  try {
    const { id } = req.params;

    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const deployments = await deploymentService.getDeploymentsByWorkspace(id);
    const deploymentsWithJobId = deployments.map((deployment: Deployment) => {
      const config =
        deployment.config && typeof deployment.config === "object"
          ? (deployment.config as Record<string, unknown>)
          : {};
      const jobId =
        (typeof config.deployJobId === "string" && config.deployJobId) ||
        (typeof config.jobId === "string" && config.jobId) ||
        null;

      return { ...deployment, jobId };
    });
    return res.json({ success: true, deployments: deploymentsWithJobId });
  } catch (err: any) {
    console.error("[REST] Failed to get deployments:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to fetch deployments" });
  }
});

// GET /api/workspaces/deployments/:deploymentId/logs — Return persisted logs from DB as JSON
// Live SSE logs (for active deployments) go directly: client → deploy service
router.get("/deployments/:deploymentId/logs", async (req, res) => {
  try {
    const { deploymentId } = req.params;

    const deployment = await deploymentService.getDeployment(deploymentId);
    if (!deployment) {
      return res
        .status(404)
        .json({ success: false, error: "Deployment not found" });
    }

    const logs = await deploymentService.getDeploymentLogs(deployment.id);

    return res.json({
      success: true,
      deploymentId: deployment.id,
      status: deployment.status,
      logs,
      updatedAt: deployment.updatedAt,
    });
  } catch (err: any) {
    console.error("[REST] Failed to get deployment logs:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to fetch deployment logs",
    });
  }
});

// GET /api/workspaces/:id/database/stats — Database usage stats (storage, connections, cache, tables)
router.get("/:id/database/stats", async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await workspaceDatabaseExplorerService.getStats(id);

    if (!stats) {
      return res.status(404).json({ error: "Workspace database not found" });
    }

    return res.json({ success: true, ...stats });
  } catch (err: any) {
    console.error("[REST] Failed to fetch database stats:", err);
    return res.status(500).json({ error: err?.message || "Failed to fetch database stats" });
  }
});

// GET /api/workspaces/:id/database/meta — Workspace database metadata for Cloud tab
router.get("/:id/database/meta", async (req, res) => {
  try {
    const { id } = req.params;
    const metadata = await workspaceDatabaseExplorerService.getMeta(id);

    if (!metadata) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    return res.json({
      success: true,
      hasDatabase: metadata.hasDatabase,
      maskedUrl: metadata.maskedUrl,
      tables: metadata.tables,
    });
  } catch (err: any) {
    console.error("[REST] Failed to fetch workspace database metadata:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to fetch database metadata" });
  }
});

// GET /api/workspaces/:id/database/table?table=<name>&page=<n>&pageSize=<n>
router.get("/:id/database/table", async (req, res) => {
  try {
    const { id } = req.params;
    const table = String(req.query.table || "").trim();
    if (!table) {
      return res.status(400).json({ error: "Query param 'table' is required" });
    }

    const data = await workspaceDatabaseExplorerService.getTableData(
      id,
      table,
      req.query.page,
      req.query.pageSize,
    );
    if (!data) {
      return res.status(404).json({ error: "Workspace database not found" });
    }

    return res.json({
      success: true,
      table: data.table,
      columns: data.columns,
      rows: data.rows,
      totalRows: data.totalRows,
      page: data.page,
      pageSize: data.pageSize,
      rowIdField: data.rowIdField,
    });
  } catch (err: any) {
    const message = err?.message || "Failed to fetch table data";
    const isNotFound =
      typeof message === "string" && message.includes("does not exist");
    console.error("[REST] Failed to fetch workspace table data:", err);
    return res.status(isNotFound ? 404 : 500).json({ error: message });
  }
});

// PATCH /api/workspaces/:id/database/table/cell
router.patch("/:id/database/table/cell", async (req, res) => {
  try {
    const { id } = req.params;
    const { table, rowId, column, value } = req.body as {
      table?: string;
      rowId?: string;
      column?: string;
      value?: unknown;
    };

    if (!table || !rowId || !column) {
      return res
        .status(400)
        .json({ error: "table, rowId and column are required" });
    }

    const result = await workspaceDatabaseExplorerService.updateCell({
      workspaceId: id,
      table,
      rowId,
      column,
      value,
    });

    if (!result) {
      return res.status(404).json({ error: "Workspace database not found" });
    }

    return res.json({
      success: true,
      row: result.row,
      rowIdField: result.rowIdField,
    });
  } catch (err: any) {
    console.error("[REST] Failed to update database cell:", err);
    return res
      .status(400)
      .json({ error: err?.message || "Failed to update database cell" });
  }
});

// GET /api/workspaces/:id/env — List all env vars (keys + targets, no values)
router.get("/:id/env", async (req, res) => {
  try {
    const { id } = req.params;
    const ws = await prisma.workspace.findUnique({ where: { id }, select: { env: true } });
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    const store = normalizeEnvStore(ws.env);
    const vars = Object.entries(store).map(([key, entry]) => ({
      key,
      frontend: entry.frontend,
      backend: entry.backend,
      environment: entry.frontend && entry.backend
        ? "All Environments"
        : entry.frontend ? "Frontend" : "Backend",
    }));
    return res.json({ vars });
  } catch (err: any) {
    console.error("[REST] Failed to get env vars:", err);
    return res.status(500).json({ error: err.message || "Failed to get env vars" });
  }
});

// GET /api/workspaces/:id/env/:key/value — Reveal actual value for a key
router.get("/:id/env/:key/value", async (req, res) => {
  try {
    const { id, key } = req.params;
    const ws = await prisma.workspace.findUnique({ where: { id }, select: { env: true } });
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    const store = normalizeEnvStore(ws.env);
    const entry = store[key];
    if (!entry) return res.status(404).json({ error: "Env var not found" });
    return res.json({ value: entry.value });
  } catch (err: any) {
    console.error("[REST] Failed to reveal env var:", err);
    return res.status(500).json({ error: err.message || "Failed to reveal env var" });
  }
});

// POST /api/workspaces/:id/env — Add or update an env var
router.post("/:id/env", async (req, res) => {
  try {
    const { id } = req.params;
    const { key, value, target = "both" } = req.body as { key?: string; value?: string; target?: string };
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "key is required" });
    }
    if (value === undefined || value === null) {
      return res.status(400).json({ error: "value is required" });
    }
    if (!["frontend", "backend", "both"].includes(target)) {
      return res.status(400).json({ error: "target must be frontend, backend, or both" });
    }
    await workspaceService.setEnv(id, { [key.trim()]: String(value) }, target as EnvTarget);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[REST] Failed to set env var:", err);
    return res.status(500).json({ error: err.message || "Failed to set env var" });
  }
});

// DELETE /api/workspaces/:id/env/:key — Delete an env var
router.delete("/:id/env/:key", async (req, res) => {
  try {
    const { id, key } = req.params;
    const ws = await prisma.workspace.findUnique({ where: { id }, select: { env: true } });
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    const store = normalizeEnvStore(ws.env);
    if (!(key in store)) return res.status(404).json({ error: "Env var not found" });
    delete store[key];
    await prisma.workspace.update({ where: { id }, data: { env: store as any } });
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[REST] Failed to delete env var:", err);
    return res.status(500).json({ error: err.message || "Failed to delete env var" });
  }
});

// GET /api/workspaces/:userId — List all workspaces for a user
router.get("/:userId", async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const workspaces = await workspaceService.listByUser(userId);
    res.json(workspaces);
  } catch (err) {
    console.error("[REST] Failed to list workspaces:", err);
    res.status(500).json({ error: "Failed to fetch workspaces" });
  }
});

// POST /api/workspaces/resume/:id — Resume a paused sandbox
router.post("/resume/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const workspace = await workspaceService.getWorkspace(id);

    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    if (!workspace.sandboxId) {
      return res
        .status(400)
        .json({ error: "Workspace has no sandbox to resume" });
    }

    console.log(
      `[REST] Resuming sandbox for workspace: ${id} (${workspace.sandboxId})`,
    );

    // Use SandboxManager to resume (it handles Sandbox.connect internally)
    const { SandboxManager } = await import("../sandbox/sandboxManager");
    const { getSystemPrompt } = await import("../brain/systemPrompt");

    const config = workspace.config as any;
    const idea = config?.idea || workspace.summary || "Continued development";
    const framework = config?.framework || "Next.js";

    // We recreate the AI Agents.md content if needed, but openAndInit also refreshes the timeout
    const result = await SandboxManager.getInstance().openAndInit({
      sandboxId: workspace.sandboxId,
      framework: framework,
    });

    res.json({
      success: true,
      sandboxId: result.sandboxId,
      message: "Sandbox resumed successfully",
    });
  } catch (err: any) {
    console.error("[REST] Failed to resume sandbox:", err);
    res.status(500).json({ error: err.message || "Failed to resume sandbox" });
  }
});

// POST /api/workspaces/:id/commit — write edited files to sandbox and create DB snapshot
router.post("/:id/commit", async (req, res) => {
  try {
    const { id } = req.params;
    const { message, files } = req.body as {
      message?: string;
      files?: Array<{ path: string; content: string }>;
    };

    if (
      !message ||
      typeof message !== "string" ||
      message.trim().length === 0
    ) {
      return res.status(400).json({ error: "Commit message is required" });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one changed file is required" });
    }

    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace)
      return res.status(404).json({ error: "Workspace not found" });
    if (!workspace.sandboxId)
      return res
        .status(400)
        .json({ error: "Workspace sandbox is not available" });

    const sanitizedFiles = files
      .filter(
        (f) => typeof f?.path === "string" && typeof f?.content === "string",
      )
      .map((f) => ({
        path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""),
        content: f.content,
      }))
      .filter((f) => f.path.length > 0);

    if (sanitizedFiles.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid changed files were provided" });
    }

    const sandbox = await Sandbox.connect(workspace.sandboxId);

    const uniqueDirs = [
      ...new Set(
        sanitizedFiles
          .map((f) =>
            f.path.includes("/")
              ? f.path.slice(0, f.path.lastIndexOf("/"))
              : "",
          )
          .filter(Boolean),
      ),
    ];
    if (uniqueDirs.length > 0) {
      const mkdirArgs = uniqueDirs
        .map((d) => `/workspace/${d}`)
        .map((d) => `'${d.replace(/'/g, "'\"'\"'")}'`)
        .join(" ");
      await sandbox.commands.run(`mkdir -p ${mkdirArgs}`);
    }

    for (const file of sanitizedFiles) {
      const absPath = `/workspace/${file.path}`;
      await sandbox.files.write(absPath, file.content);
    }

    const config = (workspace.config || {}) as any;
    const isGithubImport = config?.source === "github";
    const commitMsg = await ai.generateCommitMessage(message.trim());

    const snapshotCount = await prisma.snapshot.count({ where: { workspaceId: workspace.id } });
    const isFirst = snapshotCount === 0;

    const snapshotFiles = await readSandboxFiles(workspace.sandboxId, {
      rootPath: "/workspace",
      ...(isGithubImport ? { rootPath: "/workspace/repo", pathPrefix: "repo" } : {}),
      forceFull: isFirst,
    }).catch(() => sanitizedFiles);

    const snapshot = await prisma.snapshot.create({
      data: {
        workspaceId: workspace.id,
        files: snapshotFiles as any,
        commitMessage: commitMsg,
      },
    });

    if ((workspace as any).githubConnected) {
      githubSyncQueue.add(
        "sync",
        { workspaceId: workspace.id, triggeredAt: Date.now() },
        { jobId: `github-sync-${workspace.id}`, delay: 30_000 },
      ).catch(() => { });
    }

    return res.json({
      success: true,
      sha: snapshot.id,
      changedFiles: snapshotFiles.length,
    });
  } catch (err: any) {
    console.error("[REST] Manual commit failed:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Manual commit failed" });
  }
});

// POST /api/workspaces/:id/commit-targeted - Targeted file commit (fast, user-initiated)
router.post("/:id/commit-targeted", async (req, res) => {
  try {
    const { id } = req.params;
    const { message, files, pushSandbox = true } = req.body as {
      message?: string;
      files?: Array<{ path: string; content: string }>;
      pushSandbox?: boolean;
    };

    console.log('[REST] commit-targeted:', { id, numFiles: files?.length, pushSandbox });

    if (
      !message ||
      typeof message !== 'string' ||
      message.trim().length === 0
    ) {
      return res.status(400).json({ error: 'Commit message is required' });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res
        .status(400)
        .json({ error: 'At least one changed file is required' });
    }

    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace)
      return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.sandboxId)
      return res
        .status(400)
        .json({ error: 'Workspace sandbox is not available' });

    const sanitizedFiles = files
      .filter(
        (f) => typeof f?.path === 'string' && typeof f?.content === 'string',
      )
      .map((f) => ({
        path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''),
        content: f.content,
      }))
      .filter((f) => f.path.length > 0 && !f.path.includes('..'));

    if (sanitizedFiles.length === 0) {
      return res
        .status(400)
        .json({ error: 'No valid changed files were provided' });
    }

    console.log('[REST] commit-targeted: sanitized', sanitizedFiles.length, 'files');

    // Write files to E2B sandbox
    if (pushSandbox) {
      console.log('[REST] commit-targeted: writing to E2B sandbox...');
      const sandbox = await Sandbox.connect(workspace.sandboxId);

      const uniqueDirs = [
        ...new Set(
          sanitizedFiles
            .map((f) =>
              f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
            )
            .filter(Boolean),
        ),
      ];

      if (uniqueDirs.length > 0) {
        const mkdirArgs = uniqueDirs
          .map((d) => `/workspace/${d}`)
          .map((d) => `'${d.replace(/'/g, "'\"'\"'")}'`)
          .join(' ');
        await sandbox.commands.run(`mkdir -p ${mkdirArgs}`);
      }

      await Promise.all(
        sanitizedFiles.map((file) =>
          sandbox.files.write(`/workspace/${file.path}`, file.content),
        ),
      );
      console.log('[REST] commit-targeted: E2B write complete');
    }

    const snapshotCount = await prisma.snapshot.count({ where: { workspaceId: workspace.id } });
    const isFirst = snapshotCount === 0;

    let snapshotFiles: any[] = sanitizedFiles;
    if (isFirst) {
      snapshotFiles = await readSandboxFiles(workspace.sandboxId, {
        rootPath: "/workspace",
        forceFull: true,
      }).catch(() => sanitizedFiles);
    }

    // Write targeted files to DB Snapshot
    const snapshot = await prisma.snapshot.create({
      data: {
        workspaceId: workspace.id,
        files: snapshotFiles as any,
        commitMessage: message.trim(),
      },
    });

    if ((workspace as any).githubConnected) {
      githubSyncQueue.add(
        "sync",
        { workspaceId: workspace.id, triggeredAt: Date.now() },
        { jobId: `github-sync-${workspace.id}`, delay: 30_000 },
      ).catch(() => { });
    }

    console.log('[REST] commit-targeted: success, snapshot:', snapshot.id);
    return res.json({
      success: true,
      sha: snapshot.id,
      changedFiles: sanitizedFiles.length,
    });
  } catch (err: any) {
    console.error('[REST] commit-targeted failed:', err.message || err);
    return res
      .status(500)
      .json({ error: err?.message || 'Targeted commit failed' });
  }
});

// POST /api/workspaces/:id/generate-commit - Generate commit message with AI (Qwen, non-streaming for now)
router.post("/:id/generate-commit", async (req, res) => {
  try {
    const userId = res.locals.userId as string | undefined;
    const { diff } = req.body as { diff?: string };

    if (!diff || typeof diff !== 'string' || diff.length === 0) {
      console.warn('[REST] generate-commit: invalid diff');
      return res.status(400).json({ error: 'Diff is required and must be non-empty' });
    }

    console.log('[REST] generate-commit: received diff of', diff.length, 'bytes');

    // Use existing AI brain which routes through Qwen by default
    const commitMessage = await ai.generateCommitMessage(diff, userId);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write(commitMessage);
    res.end();

    console.log('[REST] generate-commit: completed, message length:', commitMessage.length);
  } catch (err: any) {
    console.error('[REST] generate-commit failed:', err.message || err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: err?.message || 'Failed to generate commit message' });
    } else {
      res.end();
    }
  }
});

// POST /api/workspaces/:id/deploy - Trigger a deployment for a workspace
router.post("/:id/deploy", async (req, res) => {
  const deployStartedAt = Date.now();
  try {
    const { id } = req.params;
    const { projectId, type: deployType = "frontend" } = req.body;

    if (
      deployType !== "frontend" &&
      deployType !== "backend" &&
      deployType !== "fullstack"
    ) {
      return res
        .status(400)
        .json({ error: "type must be 'frontend', 'backend', or 'fullstack'" });
    }

    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const rl = await checkWorkspaceDeployRateLimit(workspace.id);
    if (!rl.allowed) {
      const retryAfter = rl.retryAfterSeconds ?? 60;
      logOpsEvent("deploy_rate_limited", {
        workspaceId: workspace.id,
        deployType,
        retryAfterSeconds: retryAfter,
      });
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many deploy requests for this workspace. Try again later.",
        retryAfterSeconds: retryAfter,
      });
    }

    const deployServiceUrl = process.env.DEPLOY_SERVICE_URL;
    if (!deployServiceUrl) {
      return res
        .status(500)
        .json({ error: "DEPLOY_SERVICE_URL is not configured." });
    }

    // Fetch env vars from DB for this workspace
    const dbEnv = await workspaceService.getEnv(id, "backend");

    const config = (workspace.config || {}) as any;
    const wsa = workspace as any;

    let gitUrl: string;
    if (wsa.githubConnected && wsa.githubOwner && wsa.githubRepo) {
      // Use user's personal OAuth token — repo lives in their personal account
      const clerkUserId = res.locals.userId as string;
      const account = await getGithubAccount(clerkUserId);
      if (!account?.accessToken) {
        return res.status(400).json({ error: "GitHub account not connected. Connect GitHub in Settings first." });
      }
      gitUrl = `https://x-access-token:${account.accessToken}@github.com/${wsa.githubOwner}/${wsa.githubRepo}.git`;
    } else if (workspace.gitUrl) {
      // Fallback: use stored gitUrl (GitHub-imported repos or legacy)
      gitUrl = workspace.gitUrl;
    } else if (config?.source === "github" && config?.owner && config?.repo) {
      // GitHub-imported workspace without stored gitUrl
      gitUrl = `https://github.com/${config.owner}/${config.repo}.git`;
    } else {
      return res.status(400).json({
        error: "No deployable git source found. Connect GitHub in Settings first.",
      });
    }

    // Sanitize projectId to alphanumeric-only (same rules as workspace names).
    // Never trust client-supplied identifiers that become Redis routing keys.
    const sanitizedProjectId = projectId
      ? String(projectId)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 60)
      : "";
    const resolvedProjectId = sanitizedProjectId || workspace.name;

    const payload = {
      githubUrl: gitUrl,
      workspaceId: workspace.id,
      projectId: resolvedProjectId,
      type: deployType,
      env: dbEnv,
    };

    console.log(
      "[REST] Deploying workspace:",
      workspace.id,
      resolvedProjectId,
      deployType,
    );

    const deployResponse = await fetch(`${deployServiceUrl}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Consume the body exactly once
    let deployData: any = {};
    try {
      deployData = await deployResponse.json();
    } catch {
      deployData = {};
    }

    if (!deployResponse.ok) {
      console.error(
        `[Deploy] External service failed: ${deployResponse.status} -`,
        deployData,
      );
      logOpsEvent("deploy_infra_queue_failed", {
        workspaceId: workspace.id,
        projectId: resolvedProjectId,
        deployType,
        httpStatus: deployResponse.status,
        infraLatencyMs: Date.now() - deployStartedAt,
      });
      return res.status(502).json({
        success: false,
        error: "Deploy service failed to queue deployment",
      });
    }

    const jobId =
      typeof deployData?.jobId === "string" ? deployData.jobId.trim() : "";

    if (!jobId) {
      console.error(
        "[Deploy] Missing jobId in deploy service response:",
        deployData,
      );
      logOpsEvent("deploy_infra_missing_jobId", {
        workspaceId: workspace.id,
        projectId: resolvedProjectId,
        deployType,
        infraLatencyMs: Date.now() - deployStartedAt,
      });
      return res.status(502).json({
        success: false,
        error: "Deploy service did not return a valid jobId",
      });
    }

    // Create the deployment record(s) so deploy-callback can find them.
    // For "fullstack" we create TWO records (BACKEND + FRONTEND) because
    // fargate-entrypoint.sh fires deploy-backend.sh AND deploy-frontend.sh,
    // each of which sends its own callback. A single record would cause the
    // second callback to 404 (filter excludes SUCCESS/FAILED records).
    if (deployType === "fullstack") {
      await Promise.all([
        deploymentService.createDeployment({
          id: `${jobId}-backend`,
          workspaceId: workspace.id,
          type: DeploymentType.BACKEND,
          status: DeploymentStatus.QUEUED,
          env: dbEnv,
        }),
        deploymentService.createDeployment({
          id: `${jobId}-frontend`,
          workspaceId: workspace.id,
          type: DeploymentType.FRONTEND,
          status: DeploymentStatus.QUEUED,
          env: dbEnv,
        }),
      ]);
    } else {
      const dbType =
        deployType === "backend"
          ? DeploymentType.BACKEND
          : DeploymentType.FRONTEND;
      await deploymentService.createDeployment({
        id: jobId,
        workspaceId: workspace.id,
        type: dbType,
        status: DeploymentStatus.QUEUED,
        env: dbEnv,
      });
    }

    logOpsEvent("deploy_queued", {
      workspaceId: workspace.id,
      projectId: resolvedProjectId,
      deployType,
      jobId,
      infraLatencyMs: Date.now() - deployStartedAt,
    });

    const primaryDeploymentId =
      deployType === "fullstack" ? `${jobId}-frontend` : jobId;

    return res.json({
      success: true,
      deploymentId: primaryDeploymentId,
      jobId,
      message: deployData?.message || "Deployment queued successfully",
    });
  } catch (err: any) {
    console.error("[REST] Deploy failed:", err);
    return res.status(500).json({ error: err?.message || "Deploy failed" });
  }
});

// Dedicated connection to Upstash solely for Edge Routing so we don't spam it with BullMQ
const edgeRouterRedis = process.env.UPSTASH_REDIS_URL
  ? new IORedis(process.env.UPSTASH_REDIS_URL, {
    enableReadyCheck: false,
    tls: process.env.UPSTASH_REDIS_URL.startsWith("rediss://")
      ? {}
      : undefined,
    lazyConnect: true,
  })
  : null;

router.post("/deploy-callback", async (req, res) => {
  const secret = req.headers["x-deploy-secret"];
  if (!secret || secret !== process.env.DEPLOY_CALLBACK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    workspaceId,
    projectId,
    status,
    url,
    lambdaUrl,
    // Phase 2: containerIp is sent by deploy-backend.sh but we don't use it here.
    // Backend routing metadata (backend:{projectId}) is written directly by
    // deploy-backend.sh to Upstash REST API — core only handles DB + frontend routing.
    containerIp,
    // Legacy EC2 fields (kept for backwards-compat callback matching)
    ec2Ip,
    ec2Host,
    port,
    error,
    deploymentId,
  } = req.body;
  if (!workspaceId || !status) {
    return res.status(400).json({ error: "Missing workspaceId or status" });
  }

  try {
    const deployments =
      await deploymentService.getDeploymentsByWorkspace(workspaceId);

    // Match by deploymentId — but accept fullstack-suffixed variants too.
    // A "fullstack" deploy creates two DB rows (${jobId}-backend, ${jobId}-frontend)
    // while both shell scripts still callback with the bare jobId. The callback
    // shape (containerIp / ec2Host / ec2Ip+port → backend, lambdaUrl → frontend)
    // tells us which suffix to pick.
    const isBackendCallback = containerIp || ec2Host || (ec2Ip && port);
    const isFrontendCallback = lambdaUrl;
    const candidateIds: string[] = deploymentId
      ? [
        deploymentId,
        `${deploymentId}-backend`,
        `${deploymentId}-frontend`,
      ]
      : [];

    const active = deployments.find((d) => {
      if (
        d.status === DeploymentStatus.SUCCESS ||
        d.status === DeploymentStatus.FAILED
      )
        return false;
      if (candidateIds.length > 0) {
        if (!candidateIds.includes(d.id)) return false;
        // For fullstack the candidate set has 3 entries; disambiguate by type.
        if (isBackendCallback) return d.type === DeploymentType.BACKEND;
        if (isFrontendCallback) return d.type === DeploymentType.FRONTEND;
        return true;
      }
      if (isBackendCallback) return d.type === DeploymentType.BACKEND;
      if (isFrontendCallback) return d.type === DeploymentType.FRONTEND;
      return true; // fallback: first active
    });

    if (!active) {
      return res
        .status(404)
        .json({ error: "No active deployment found for workspace" });
    }

    const newStatus: DeploymentStatus =
      status === "success" ? DeploymentStatus.SUCCESS : DeploymentStatus.FAILED;

    await deploymentService.updateDeployment(active.id, {
      status: newStatus,
      previewUrl: url || undefined,
      completedAt: new Date(),
      config:
        newStatus === DeploymentStatus.FAILED && error ? { error } : undefined,
    });

    const durationMsQueuedToCallback = Math.max(
      0,
      Date.now() - active.createdAt.getTime(),
    );
    logOpsEvent("deploy_callback", {
      workspaceId,
      deploymentId: active.id,
      status: String(newStatus),
      projectId: projectId ? String(projectId) : "",
      callbackOutcome: status === "success" ? "success" : "failed",
      durationMsQueuedToCallback,
    });

    // Save routing info to Redis for the Edge Router if successful
    if (newStatus === DeploymentStatus.SUCCESS && projectId) {
      if (edgeRouterRedis) {
        const redisWrites: Promise<unknown>[] = [];
        if (lambdaUrl) {
          redisWrites.push(
            edgeRouterRedis
              .set(`router:${projectId}`, JSON.stringify({ workspaceId, lambdaUrl, deploymentId: active.id }))
              .then(() => console.log(`[Callback] Saved frontend routing for ${projectId} to Upstash Edge Router.`)),
          );
        }
        await Promise.all(redisWrites);
      } else {
        console.warn(
          `[Callback] UPSTASH_REDIS_URL is not set. Cloudflare will not know where to route ${projectId}!`,
        );
      }
    }

    console.log(`[Callback] Deployment ${active.id} marked ${newStatus}`);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[Callback] Failed to update deployment status:", err);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// POST /api/workspaces/deployments/:id/screenshot — receives base64 PNG from infra, stores in Supabase
router.post("/deployments/:id/screenshot", express.json({ limit: "2mb" }), async (req, res) => {
  const secret = req.headers["x-deploy-secret"];
  if (!secret || secret !== process.env.DEPLOY_CALLBACK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { id: deploymentId } = req.params;
  const { screenshot } = req.body;
  if (!screenshot) return res.status(400).json({ error: "Missing screenshot" });

  screenshotService.saveFromBase64(deploymentId, screenshot).catch(() => { });
  return res.json({ success: true });
});

// GET /api/workspaces/:id/analytics — proxies to infra server which queries ClickHouse
router.get("/:id/analytics", async (req, res) => {
  const { id: workspaceId } = req.params;
  const infraUrl = process.env.DEPLOY_SERVICE_URL;
  if (!infraUrl)
    return res.status(503).json({ error: "DEPLOY_SERVICE_URL not configured" });
  try {
    const period = req.query.period ? `?period=${req.query.period}` : "";
    const r = await fetch(`${infraUrl}/analytics/${workspaceId}${period}`);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err: any) {
    console.error("[Analytics] Proxy failed:", err);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// GET /api/workspaces/:id/request-logs — proxies to infra server which queries ClickHouse
router.get("/:id/request-logs", async (req, res) => {
  const { id: workspaceId } = req.params;
  const infraUrl = process.env.DEPLOY_SERVICE_URL;
  if (!infraUrl)
    return res.status(503).json({ error: "DEPLOY_SERVICE_URL not configured" });
  const params = new URLSearchParams();
  if (req.query.limit) params.set("limit", String(req.query.limit));
  if (req.query.before) params.set("before", String(req.query.before));
  if (req.query.after) params.set("after", String(req.query.after));
  try {
    const r = await fetch(`${infraUrl}/request-logs/${workspaceId}?${params}`);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err: any) {
    console.error("[RequestLogs] Proxy failed:", err);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// ── POST /api/workspaces/:id/connect-github ──────────────────────────────────
router.post("/:id/connect-github", async (req, res) => {
  const clerkUserId = res.locals.userId as string | undefined;
  if (!clerkUserId) return res.status(401).json({ error: "Unauthorized" });

  const workspace = await workspaceService.getWorkspace(req.params.id);
  if (!workspace || workspace.userId !== clerkUserId) {
    return res.status(404).json({ error: "Workspace not found" });
  }

  const account = await getGithubAccount(clerkUserId);
  if (!account?.accessToken) {
    return res.status(403).json({
      error: "GitHub account not connected. Visit Settings to connect GitHub first.",
    });
  }

  const repoName = workspace.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

  // Include timestamp so each attempt creates a fresh job (avoids BullMQ
  // deduplication against old failed jobs with the same workspace ID).
  const jobId = `connect-github-${workspace.id}-${Date.now()}`;
  await githubConnectQueue.add(
    "connect",
    {
      workspaceId: workspace.id,
      clerkUserId,
      repoName,
      accessToken: account.accessToken,
    },
    { jobId, attempts: 1 },
  );

  res.status(202).json({ jobId, status: "pending" });
});

// ── GET /api/workspaces/:id/connect-github/status ────────────────────────────
router.get("/:id/connect-github/status", async (req, res) => {
  const jobId = req.query.jobId as string | undefined;
  if (!jobId) return res.status(400).json({ error: "jobId query parameter is required" });

  try {
    const job = await githubConnectQueue.getJob(jobId);
    if (!job) {
      const syncJob = await githubSyncQueue.getJob(jobId);
      if (!syncJob) return res.status(404).json({ error: "Job not found" });
      const state = await syncJob.getState();
      res.json({ status: state, progress: syncJob.progress, failedReason: syncJob.failedReason ?? null });
      return;
    }
    const state = await job.getState();
    res.json({ status: state, progress: job.progress, failedReason: job.failedReason ?? null });
  } catch (err: any) {
    console.error(`[GitHubSync] Status check failed:`, err.message);
    res.status(500).json({ error: "Failed to get job status" });
  }
});

// ── POST /api/workspaces/:id/force-github-sync ───────────────────────────────
router.post("/:id/force-github-sync", async (req, res) => {
  const clerkUserId = res.locals.userId as string | undefined;
  if (!clerkUserId) return res.status(401).json({ error: "Unauthorized" });

  const workspace = await workspaceService.getWorkspace(req.params.id);
  if (!workspace || workspace.userId !== clerkUserId) {
    return res.status(404).json({ error: "Workspace not found" });
  }

  if (!workspace.githubConnected) {
    return res.status(400).json({ error: "Workspace not connected to GitHub" });
  }

  try {
    const jobId = `force-sync-${workspace.id}-${Date.now()}`;
    await githubSyncQueue.add("sync", { workspaceId: workspace.id, triggeredAt: Date.now() }, { jobId, priority: 10 });
    res.status(202).json({ jobId, status: "pending" });
  } catch (err: any) {
    console.error(`[GitHubSync] Force sync enqueue failed:`, err.message);
    res.status(500).json({ error: "Failed to enqueue sync job" });
  }
});

export default router;
