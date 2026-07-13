import { Sandbox } from "@e2b/code-interpreter";

export interface SandboxFile {
  path: string;
  content: string;
}

export interface ReadSandboxFilesOptions {
  rootPath?: string;
  pathPrefix?: string;
  maxFiles?: number;
  maxFileSize?: number;
  readConcurrency?: number;
  forceFull?: boolean;
}

export async function readSandboxFiles(
  sandboxId: string,
  opts: ReadSandboxFilesOptions = {},
): Promise<SandboxFile[]> {
  const rootPath = (opts.rootPath || "/workspace").replace(/\/+$/, "") || "/workspace";
  const pathPrefix = (opts.pathPrefix || "").replace(/^\/+|\/+$/g, "");
  const maxFiles = Math.max(1, opts.maxFiles ?? (opts.forceFull ? 1500 : 180));
  const maxFileSize = Math.max(1_000, opts.maxFileSize ?? 80_000);
  const readConcurrency = Math.max(1, Math.min(opts.readConcurrency ?? 12, 24));

  const sandbox = await Sandbox.connect(sandboxId);
  const safeRootPath = rootPath.replace(/'/g, "'\"'\"'");

  let modifiedOrAddedFiles: string[] = [];
  const deletedFiles: string[] = [];

  if (opts.forceFull) {
    // Use `find` to list every file from the filesystem directly.
    // This is 100% reliable regardless of git initialisation state — no race
    // condition with the background `git init` in sandboxManager.
    const IGNORE_FLAGS = [
      `-not -path '*/node_modules/*'`,
      `-not -path '*/.git/*'`,
      `-not -path '*/.next/*'`,
      `-not -path '*/dist/*'`,
      `-not -path '*/build/*'`,
      `-not -path '*/.cache/*'`,
      `-not -name '*.lock'`,
      `-not -name 'package-lock.json'`,
    ].join(" ");

    const findResult = await sandbox.commands.run(
      `find . -type f ${IGNORE_FLAGS}`,
      { cwd: safeRootPath },
    );

    modifiedOrAddedFiles = findResult.stdout
      .split("\n")
      .map(l => l.replace(/^\.\//,  "").trim())
      .filter(l => l.length > 0);
  } else {
    // Ensure git is tracking everything and get the diff
    const setupResult = await sandbox.commands.run(
      `rm -f .git/index.lock && ` +
      `git config --file=.gitmodules --remove-section submodule.frontend 2>/dev/null || true && ` +
      `git config --file=.gitmodules --remove-section submodule.backend 2>/dev/null || true && ` +
      `git rm --cached frontend 2>/dev/null || true && ` +
      `git rm --cached backend 2>/dev/null || true && ` +
      `rm -f .gitmodules && ` +
      `rm -rf /workspace/frontend/.git /workspace/backend/.git 2>/dev/null || true && ` +
      `find . -mindepth 2 -name ".git" -type d -exec rm -rf {} + 2>/dev/null || true && ` +
      `git init -q && ` +
      `git config user.name "AI Agents" && ` +
      `git config user.email "bot@ai-agents.com" && ` +
      `git add . && git status -s`,
      { cwd: safeRootPath }
    ).catch(err => {
      console.error("[readSandboxFiles] Git setup failed:", err.message);
      return null;
    });

    const diffResult = await sandbox.commands.run(
      `if git rev-parse HEAD >/dev/null 2>&1; then ` +
      `  git diff --cached --name-status HEAD; ` +
      `else ` +
      `  git diff --cached --name-status 4b825dc642cb6eb9a060e54bf8d69288fbee4904; ` +
      `fi`,
      { cwd: safeRootPath }
    ).catch(err => {
      console.error("[readSandboxFiles] Git diff failed:", err.message);
      return { stdout: "", stderr: err.message };
    });

    const lines = diffResult.stdout.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Process diff lines if there are any changes

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const status = parts[0];
        const relPath = parts[1];

        // Filter out ignored paths just in case they weren't in .gitignore
        if (relPath.includes('node_modules/') || relPath.includes('.git/') || relPath.includes('dist/') || relPath.includes('.next/') || relPath.includes('build/') || relPath.includes('.cache/') || relPath.endsWith('.lock')) {
          continue;
        }

        if (status.startsWith('D')) {
          deletedFiles.push(relPath);
        } else {
          modifiedOrAddedFiles.push(relPath);
        }
      }
    }

    // If delta found 0 files, fallback to full scan
    // This can happen if git treats subdirs as submodules (nested .git dirs)
    if (modifiedOrAddedFiles.length === 0 && deletedFiles.length === 0) {
      console.warn("[readSandboxFiles] Delta returned 0 files — falling back to full scan");
      return readSandboxFiles(sandboxId, { ...opts, forceFull: true });
    }
  }

  const files: SandboxFile[] = [];

  // Add deleted files immediately with content: null
  for (const delPath of deletedFiles) {
    const commitPath = pathPrefix ? `${pathPrefix}/${delPath}` : delPath;
    files.push({ path: commitPath, content: null as any });
  }

  let cursor = 0;
  const filePaths = modifiedOrAddedFiles.slice(0, maxFiles);

  const workers = Array.from({ length: readConcurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= filePaths.length) return;
      const relPath = filePaths[index];
      const absPath = `${rootPath}/${relPath}`;

      try {
        const content = await sandbox.files.read(absPath);
        const commitPath = pathPrefix ? `${pathPrefix}/${relPath}` : relPath;
        const text =
          typeof content === "string"
            ? content
            : Buffer.from(content as any).toString("utf8");

        files.push({ path: commitPath, content: text.slice(0, maxFileSize) });
      } catch {
        // Skip unreadable files (binary, permission issues, etc.)
      }
    }
  });

  await Promise.all(workers);

  // Commit to git so the next delta snapshot can `git diff HEAD` from here.
  if (opts.forceFull) {
    // First snapshot: initialise git, configure user, and commit
    await sandbox.commands.run(
      `rm -rf /workspace/frontend/.git /workspace/backend/.git 2>/dev/null; true && ` +
      `find . -mindepth 2 -name ".git" -type d -exec rm -rf {} + 2>/dev/null; true && ` +
      `rm -f .git/index.lock && git init && ` +
      `git config user.name "AI Agents" && ` +
      `git config user.email "bot@ai-agents.com" && ` +
      `git add . && git commit -m "snapshot" --allow-empty`,
      { cwd: safeRootPath },
    ).catch(err => console.error("[readSandboxFiles] Git forceFull commit failed:", err.message));
  } else {
    // Delta snapshot: files already staged by `git add .` in the diff command above.
    // NOTE: If no files changed, we wouldn't reach here (we returned [] earlier),
    // but if we did, we want to commit.
    await sandbox.commands.run(
      `rm -f .git/index.lock && git commit -m "snapshot" --allow-empty`,
      { cwd: safeRootPath }
    ).catch(err => console.error("[readSandboxFiles] Git delta commit failed:", err.message));
  }

  return files;
}
