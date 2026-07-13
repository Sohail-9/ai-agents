/**
 * Shared utilities for planning mode — extracted from WSManager.
 * Used by both WSManager and agentWorker for building planning context and parsing todos.
 */

export interface PlanningInput {
  workspaceId: string;
  framework: string;
  mode: "new" | "update" | "import" | "import-update";
  sandboxId?: string;
  clonePath?: string;
}

export interface TodoInput {
  title: string;
  description: string;
  deps: number[];
}

export function buildPlanningEnvironmentContext(input: PlanningInput): string {
  const lines = [
    "ENV_CONTEXT",
    `WORKSPACE_ID: ${input.workspaceId}`,
    `MODE: ${input.mode}`,
    `FRAMEWORK: ${input.framework}`,
    "WORKSPACE_ROOT: /workspace",
    "FRONTEND_PATH: /workspace/frontend",
    "BACKEND_PATH: /workspace/backend",
    "IMPORT_REPO_PATH: /workspace/repo",
    "FRONTEND_PORT: 3000",
    "BACKEND_PORT: 8000",
    "RUNTIME: e2b sandbox",
    "NOTE: prefer small high-level todos; the agent will execute details.",
    "NOTE: include env/API setup todos only when request requires backend API integration.",
  ];

  if (input.sandboxId) lines.push(`SANDBOX_ID: ${input.sandboxId}`);
  if (input.clonePath) lines.push(`CLONE_PATH: ${input.clonePath}`);

  return lines.join("\n");
}

export function parseTodosFromContext(contextMd: string): TodoInput[] {
  const todos: TodoInput[] = [];
  const lines = contextMd.split("\n");
  let inTodos = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === "TODOS" || line.startsWith("TODOS")) {
      inTodos = true;
      continue;
    }

    if (inTodos) {
      // Support multiple list styles:
      // [1] TITLE: ...
      // [1] ...
      // 1. TITLE: ...
      // - TITLE: ...
      const titleMatch =
        line.match(/^\[(\d+)\]\s*TITLE:\s*(.+)/i) ||
        line.match(/^\[(\d+)\]\s*(.+)/i) ||
        line.match(/^(\d+)\.\s*TITLE:\s*(.+)/i) ||
        line.match(/^(\d+)\.\s*(.+)/i) ||
        line.match(/^-+\s*TITLE:\s*(.+)/i) ||
        line.match(/^-+\s*(.+)/i);

      if (titleMatch) {
        const title = (titleMatch[2] || titleMatch[1] || "").trim();
        if (!title) continue;

        // ⚠️ STRICTURE: Hyphenated lists are only TODOs if they look like tasks,
        // not just feature bullet points, UNLESS they are in a very specific TODOS block.
        if (
          line.startsWith("-") &&
          !line.includes("TITLE:") &&
          !line.includes("[ ]")
        ) {
          // If it's just a bullet point, only take it if it sounds like a task (starts with verb)
          const taskVerbs =
            /^(build|implement|create|add|setup|configure|fix|update|remove|delete|test|ensure|validate)/i;
          if (!taskVerbs.test(title)) continue;
        }

        // Look for DESC and DEPS on subsequent lines
        let description = title;
        let deps: number[] = [];
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const next = lines[j].trim();

          // Stop if we hit a new section header
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

          // Parse DEPS: [1, 2] or DEPS: []
          const depsMatch = next.match(/^DEPS:\s*\[([^\]]*)\]/i);
          if (depsMatch) {
            const inner = depsMatch[1].trim();
            deps = inner
              ? inner
                  .split(",")
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => !isNaN(n) && n > 0)
              : [];
            i = j;
            continue;
          }

          // Stop scanning if we reached the next todo item
          if (
            /^\[(\d+)\]\s*/.test(next) ||
            /^(\d+)\.\s*/.test(next) ||
            /^-+\s*TITLE:/.test(next)
          ) {
            break;
          }
        }

        // Drop low-signal generic titles
        const normalizedTitle = title.toLowerCase();
        if (
          normalizedTitle === "build the application" ||
          normalizedTitle === "build app" ||
          normalizedTitle === "implement feature"
        ) {
          continue;
        }

        todos.push({ title, description, deps });
        continue;
      }

      // Stop parsing if we hit another section header (no indent, all caps)
      if (
        line &&
        !line.startsWith("[") &&
        !line.startsWith("DESC:") &&
        !line.startsWith("DESCRIPTION:") &&
        !line.startsWith("DEPS:") &&
        !/^(\d+)\./.test(line) &&
        !line.startsWith("-") &&
        line === line.toUpperCase() &&
        line.length > 3
      ) {
        inTodos = false;
        continue;
      }
    }
  }

  const deduped = todos.filter(
    (todo, idx, arr) =>
      arr.findIndex(
        (t) => t.title.toLowerCase() === todo.title.toLowerCase(),
      ) === idx,
  );

  if (deduped.length === 0) {
    return [
      {
        title: "Implement requested scope",
        description:
          "Use current workspace and environment context to implement the request end-to-end.",
        deps: [],
      },
    ];
  }

  // Keep plan concise and high-level.
  return deduped.slice(0, 4);
}

export function buildUpdateContext(workspace: {
  aiAgentsMd?: string | null;
  config?: any;
  sandboxId?: string | null;
  id: string;
}): string {
  const framework = (workspace.config as any)?.framework || "Next.js";
  const sandboxId = workspace.sandboxId || undefined;

  return [
    workspace.aiAgentsMd || "",
    "",
    buildPlanningEnvironmentContext({
      workspaceId: workspace.id,
      framework,
      sandboxId,
      mode: "update",
    }),
  ].join("\n");
}
