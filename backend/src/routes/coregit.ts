import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();
const TREE_CACHE_TTL_MS = 5 * 60 * 1000;
const DIFF_CACHE_TTL_MS = 60 * 1000;
const DIFF_FILE_CACHE_TTL_MS = 2 * 60 * 1000;
const treeCache = new Map<string, { expiresAt: number; items: any[] }>();
const inflightTreeRequests = new Map<string, Promise<any[]>>();
const diffCache = new Map<string, { expiresAt: number; data: any }>();
const inflightDiffRequests = new Map<string, Promise<any>>();
const diffFileCache = new Map<string, { expiresAt: number; patch: string }>();
const inflightDiffFileRequests = new Map<string, Promise<string>>();

function makeTreeCacheKey(slug: string, sha: string): string {
  return `${slug}:${sha}`;
}

function makeDiffCacheKey(slug: string, base: string, head: string): string {
  return `${slug}:${base}:${head}`;
}

function makeDiffFileCacheKey(slug: string, base: string, head: string, path: string): string {
  return `${slug}:${base}:${head}:${path}`;
}

function buildTreeFromManifestPaths(paths: string[]): any[] {
  type MutableNode = {
    name: string;
    path: string;
    type: "directory" | "file";
    children?: Map<string, MutableNode>;
  };

  const root = new Map<string, MutableNode>();

  for (const rawPath of paths) {
    const clean = rawPath.replace(/^\/+/, "").replace(/\/+/g, "/").trim();
    if (!clean || clean === ".prettiflow-manifest.json") continue;

    const parts = clean.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let cursor = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      const existing = cursor.get(part);

      if (!existing) {
        cursor.set(part, {
          name: part,
          path: currentPath,
          type: isLeaf ? "file" : "directory",
          children: isLeaf ? undefined : new Map<string, MutableNode>(),
        });
      }

      const next = cursor.get(part)!;
      if (!isLeaf) {
        if (!next.children) next.children = new Map<string, MutableNode>();
        cursor = next.children;
      }
    }
  }

  const toArray = (map: Map<string, MutableNode>): any[] =>
    [...map.values()]
      .map((node) =>
        node.type === "directory"
          ? {
              name: node.name,
              path: node.path,
              type: node.type,
              children: toArray(node.children || new Map()),
            }
          : { name: node.name, path: node.path, type: node.type },
      )
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.path.localeCompare(b.path);
      });

  return toArray(root);
}

function buildUnifiedPatch(
  path: string,
  oldText: string | null,
  newText: string | null,
): string {
  type Op = { type: " " | "+" | "-"; line: string };
  const MAX_LINES = 700;
  const CONTEXT = 3;

  const fullOldLines = (oldText ?? "").split("\n");
  const fullNewLines = (newText ?? "").split("\n");
  const oldLines = fullOldLines.slice(0, MAX_LINES);
  const newLines = fullNewLines.slice(0, MAX_LINES);

  const n = oldLines.length;
  const m = newLines.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: " ", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "+", line: newLines[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "-", line: oldLines[i] }); i++; }
  while (j < m) { ops.push({ type: "+", line: newLines[j] }); j++; }

  const patchLines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const isChanged = ops.some((op) => op.type !== " ");
  if (!isChanged) return patchLines.join("\n");

  const countOldInSlice = (start: number, end: number) =>
    ops.slice(start, end).reduce((acc, op) => acc + (op.type !== "+" ? 1 : 0), 0);
  const countNewInSlice = (start: number, end: number) =>
    ops.slice(start, end).reduce((acc, op) => acc + (op.type !== "-" ? 1 : 0), 0);

  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === " ") index++;
    if (index >= ops.length) break;

    const hunkStart = Math.max(0, index - CONTEXT);
    let hunkEnd = index;
    let trailingContext = 0;

    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].type === " ") trailingContext++;
      else trailingContext = 0;
      hunkEnd++;
      if (trailingContext >= CONTEXT) break;
    }

    if (trailingContext >= CONTEXT) hunkEnd -= CONTEXT;
    hunkEnd = Math.min(ops.length, hunkEnd + CONTEXT);

    const oldStart = countOldInSlice(0, hunkStart) + 1;
    const newStart = countNewInSlice(0, hunkStart) + 1;
    const oldCount = countOldInSlice(hunkStart, hunkEnd);
    const newCount = countNewInSlice(hunkStart, hunkEnd);
    patchLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (const op of ops.slice(hunkStart, hunkEnd)) {
      patchLines.push(`${op.type}${op.line}`);
    }

    index = hunkEnd;
  }

  if (fullOldLines.length > MAX_LINES || fullNewLines.length > MAX_LINES) {
    patchLines.push("\\ No newline (patch truncated for large file)");
  }

  return patchLines.join("\n");
}

async function resolveWorkspace(slug: string) {
  return prisma.workspace.findFirst({ where: { name: slug, isDeleted: false } });
}

// ── GET /:slug/commits ───────────────────────────────────────────────────────

router.get("/:slug/commits", async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const cursor = (req.query.cursor as string) || undefined;

    const ws = await resolveWorkspace(slug);
    if (!ws) return res.status(404).json({ error: "Workspace not found" });

    const snapshots = await prisma.snapshot.findMany({
      where: { workspaceId: ws.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const commits = snapshots.map((s) => ({
      sha: s.id,
      message: s.commitMessage,
      author: { name: "Prettiflow Agent", email: "agent@prettiflow.com" },
      timestamp: s.createdAt.toISOString(),
      githubSha: s.githubSha ?? null,
    }));

    const nextCursor =
      snapshots.length === limit ? snapshots[snapshots.length - 1].id : null;

    res.json({ commits, nextCursor });
  } catch (err: any) {
    console.error("[Coregit Route] getCommits failed:", err.message);
    res.status(500).json({ error: err.message || "Failed to fetch commits" });
  }
});

// ── GET /:slug/commits/:sha/tree ─────────────────────────────────────────────

router.get("/:slug/commits/:sha/tree", async (req, res) => {
  const { slug, sha } = req.params;
  const cacheKey = makeTreeCacheKey(slug, sha);

  try {
    const cached = treeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ items: cached.items });
    }

    const existingInflight = inflightTreeRequests.get(cacheKey);
    if (existingInflight) {
      const items = await existingInflight;
      return res.json({ items });
    }

    const buildTreePromise = (async () => {
      const snap = await prisma.snapshot.findUnique({ where: { id: sha } });
      if (!snap) throw Object.assign(new Error("Snapshot not found"), { status: 404 });

      const files = snap.files as Array<{ path: string; content: string }>;
      return buildTreeFromManifestPaths(files.map((f) => f.path));
    })();

    inflightTreeRequests.set(cacheKey, buildTreePromise);
    const tree = await buildTreePromise;
    treeCache.set(cacheKey, { items: tree, expiresAt: Date.now() + TREE_CACHE_TTL_MS });

    res.json({ items: tree });
  } catch (err: any) {
    console.error("[Coregit Route] getCommitFileTree failed:", err.message);
    res.status(err.status || 500).json({
      error: err.message || "Failed to fetch commit file tree",
    });
  } finally {
    inflightTreeRequests.delete(cacheKey);
  }
});

// ── GET /:slug/commits/:sha/files ────────────────────────────────────────────

router.get("/:slug/commits/:sha/files", async (req, res) => {
  try {
    const { sha } = req.params;
    const filePath = req.query.path as string;

    if (!filePath) {
      return res.status(400).json({ error: "File path query parameter is required" });
    }

    const snap = await prisma.snapshot.findUnique({ where: { id: sha } });
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });

    const files = snap.files as Array<{ path: string; content: string | null }>;
    const file = files.find((f) => f.path === filePath);
    if (!file) return res.status(404).json({ error: "File not found in snapshot" });

    if (file.content === null) {
      return res.json({
        path: file.path,
        content: "",
        encoding: "utf-8",
        sha,
        size: 0,
      });
    }

    res.json({
      path: file.path,
      content: file.content,
      encoding: "utf-8",
      sha,
      size: file.content.length,
    });
  } catch (err: any) {
    console.error("[Coregit Route] getFileFromCommit failed:", err.message);
    res.status(err.status || 500).json({
      error: err.message || "Failed to fetch file content",
    });
  }
});

// ── GET /:slug/commits/:sha/diff ─────────────────────────────────────────────

router.get("/:slug/commits/:sha/diff", async (req, res) => {
  const { slug, sha } = req.params;
  const base = (req.query.base as string | undefined)?.trim();

  if (!base) {
    return res.status(400).json({ error: "base query parameter is required" });
  }

  const cacheKey = makeDiffCacheKey(slug, base, sha);

  try {
    const cached = diffCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const inflight = inflightDiffRequests.get(cacheKey);
    if (inflight) {
      const data = await inflight;
      return res.json(data);
    }

    const diffPromise = (async () => {
      const [baseSnap, headSnap] = await Promise.all([
        prisma.snapshot.findUnique({ where: { id: base } }),
        prisma.snapshot.findUnique({ where: { id: sha } }),
      ]);

      if (!baseSnap || !headSnap) {
        throw Object.assign(new Error("Snapshot not found"), { status: 404 });
      }

      // In-memory diff from snapshot files
      const baseFiles = baseSnap.files as Array<{ path: string; content: string | null }>;
      const headFiles = headSnap.files as Array<{ path: string; content: string | null }>;
      const baseSet = new Set(baseFiles.map((f) => f.path));

      const getContent = (snap: typeof baseSnap, p: string): string | null => {
        const files = snap.files as Array<{ path: string; content: string | null }>;
        return files.find((f) => f.path === p)?.content ?? null;
      };

      // Delta snapshot (agentRunId set): only contains files the agent modified.
      // Iterate head paths only — files absent from head are untouched, NOT deleted.
      // Full snapshot (no agentRunId): contains entire file tree.
      // Iterate union — files absent from head were actually deleted.
      const isDeltaHead = headSnap.agentRunId !== null;
      const headSet = new Set(headFiles.map((f) => f.path));
      const pathsToShow = isDeltaHead
        ? headFiles.map((f) => f.path)
        : [...new Set([...baseSet, ...headSet])];

      const PATCH_EAGER_LIMIT = 30;
      let eagerCount = 0;

      const files = pathsToShow
        .sort()
        .slice(0, 200)
        .map((path) => {
          const headContent = getContent(headSnap, path);
          const status = (
            headContent === null
              ? "deleted"
              : !baseSet.has(path)
              ? "added"
              : "modified"
          ) as "added" | "deleted" | "modified";

          let patch = "";
          if (eagerCount < PATCH_EAGER_LIMIT) {
            patch = buildUnifiedPatch(
              path,
              getContent(baseSnap, path),
              headContent,
            );
            eagerCount++;
          }

          return { path, status, patch };
        });

      return { files, meta: { fallback: true, base, head: sha } };
    })();

    inflightDiffRequests.set(cacheKey, diffPromise);
    const data = await diffPromise;
    diffCache.set(cacheKey, { data, expiresAt: Date.now() + DIFF_CACHE_TTL_MS });
    return res.json(data);
  } catch (err: any) {
    console.error("[Coregit Route] getDiffBetweenRefs failed:", err.message);
    res.status(err.status || 500).json({
      error: err.message || "Failed to fetch commit diff",
    });
  } finally {
    if (base) inflightDiffRequests.delete(cacheKey);
  }
});

// ── GET /:slug/commits/:sha/diff-file ────────────────────────────────────────

router.get("/:slug/commits/:sha/diff-file", async (req, res) => {
  const { slug, sha } = req.params;
  const base = (req.query.base as string | undefined)?.trim();
  const path = (req.query.path as string | undefined)?.trim();

  if (!base) return res.status(400).json({ error: "base query parameter is required" });
  if (!path) return res.status(400).json({ error: "path query parameter is required" });

  const cacheKey = makeDiffFileCacheKey(slug, base, sha, path);

  try {
    const cached = diffFileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ path, patch: cached.patch });
    }

    const inflight = inflightDiffFileRequests.get(cacheKey);
    if (inflight) {
      const patch = await inflight;
      return res.json({ path, patch });
    }

    const patchPromise = (async () => {
      const [baseSnap, headSnap] = await Promise.all([
        prisma.snapshot.findUnique({ where: { id: base } }),
        prisma.snapshot.findUnique({ where: { id: sha } }),
      ]);

      if (!baseSnap || !headSnap) {
        throw Object.assign(new Error("Snapshot not found"), { status: 404 });
      }

      const getContent = (snap: { files: unknown }, p: string): string | null => {
        const files = snap.files as Array<{ path: string; content: string }>;
        return files.find((f) => f.path === p)?.content ?? null;
      };

      return buildUnifiedPatch(path, getContent(baseSnap, path), getContent(headSnap, path));
    })();

    inflightDiffFileRequests.set(cacheKey, patchPromise);
    const patch = await patchPromise;
    diffFileCache.set(cacheKey, { patch, expiresAt: Date.now() + DIFF_FILE_CACHE_TTL_MS });

    return res.json({ path, patch });
  } catch (err: any) {
    console.error("[Coregit Route] diff-file failed:", err.message);
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch file diff" });
  } finally {
    inflightDiffFileRequests.delete(cacheKey);
  }
});

// ── GET /:slug/info ──────────────────────────────────────────────────────────

router.get("/:slug/info", async (req, res) => {
  const { slug } = req.params;
  const ws = await resolveWorkspace(slug);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  const wsa = ws as any;
  res.json({
    slug: ws.name,
    githubConnected: wsa.githubConnected ?? false,
    githubOwner: wsa.githubOwner ?? null,
    githubRepo: wsa.githubRepo ?? null,
    webUrl: wsa.githubOwner && wsa.githubRepo
      ? `https://github.com/${wsa.githubOwner}/${wsa.githubRepo}`
      : null,
  });
});

export default router;
