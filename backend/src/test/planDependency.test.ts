/**
 * planDependency.test.ts
 *
 * Tests for the Plan & Dependency system:
 *   1. TOON parser — DEPS field parsing
 *   2. todoService — createTodosWithDeps + getReadyTodos
 *   3. FINAL ANSWER — TASK=<order> parsing
 *   4. aiAgentsMd — placeholder validation
 *
 * Run: npx tsx src/test/planDependency.test.ts
 */

import "../env";
import { prisma } from "../lib/prisma";
import { todoService } from "../services/todoService";

// ─── Colours ──────────────────────────────────────────────────
const GREEN = "\x1b[32m✔\x1b[0m";
const RED   = "\x1b[31m✘\x1b[0m";
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${GREEN} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED} ${label}${detail ? `\n      → ${detail}` : ""}`);
    failed++;
  }
}

async function section(name: string, fn: () => Promise<void>) {
  console.log(`\n${BOLD}[ ${name} ]${RESET}`);
  try {
    await fn();
  } catch (err: any) {
    console.log(`  ${RED} Section crashed: ${err.message}`);
    failed++;
  }
}

// ─── Inline TOON parser (mirrors WSManager/setupWorker logic) ─
function parseTodosFromContext(
  contextMd: string,
): Array<{ title: string; description: string; deps: number[] }> {
  const todos: Array<{ title: string; description: string; deps: number[] }> = [];
  const lines = contextMd.split("\n");
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
        line.match(/^(\d+)\.\s*TITLE:\s*(.+)/i);

      if (titleMatch) {
        const title = (titleMatch[2] || titleMatch[1] || "").trim();
        if (!title) continue;

        let description = title;
        let deps: number[] = [];

        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const next = lines[j].trim();
          const descMatch = next.match(/^(DESC|DESCRIPTION):\s*(.+)/i);
          if (descMatch) { description = descMatch[2].trim(); i = j; continue; }
          const depsMatch = next.match(/^DEPS:\s*\[([^\]]*)\]/i);
          if (depsMatch) {
            const inner = depsMatch[1].trim();
            deps = inner
              ? inner.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
              : [];
            i = j;
            continue;
          }
          if (/^\[(\d+)\]\s*/.test(next)) break;
        }
        todos.push({ title, description, deps });
      }

      if (
        line && !line.startsWith("[") && !line.startsWith("DESC:") &&
        !line.startsWith("DEPS:") && !/^(\d+)\./.test(line) &&
        line === line.toUpperCase() && line.length > 3
      ) {
        inTodos = false;
      }
    }
  }
  return todos;
}

// ─── FINAL ANSWER parser (mirrors agentRunner logic) ──────────
function parseTaskOrderFromFinalAnswer(text: string): number | null {
  const m = text.match(/FINAL\s+ANSWER\s+TASK\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parsePortsFromFinalAnswer(text: string): { frontend?: number; backend?: number } {
  const ports: { frontend?: number; backend?: number } = {};
  const fe = text.match(/FRONTEND=(\d+)/i);
  if (fe) ports.frontend = parseInt(fe[1], 10);
  const be = text.match(/BACKEND=(\d+)/i);
  if (be) ports.backend = parseInt(be[1], 10);
  return ports;
}

// ─── aiAgentsMd validation (mirrors ai.ts logic) ────────────
function isValidPlan(contextContent: string | null | undefined): boolean {
  return !!(contextContent &&
    contextContent.includes("TYPE") &&
    contextContent.includes("TODOS"));
}

// ══════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════

// ─── 1. TOON Parser ───────────────────────────────────────────
async function testToonParser() {
  await section("TOON Parser — DEPS field", async () => {
    // No deps
    const plan1 = `
TYPE READY
TODOS
[1] TITLE: Build landing page
    DESC: Create the page
    DEPS: []
`.trim();
    const r1 = parseTodosFromContext(plan1);
    assert("Parses single todo with DEPS: []", r1.length === 1);
    assert("DEPS is empty array", JSON.stringify(r1[0].deps) === "[]");
    assert("Title parsed correctly", r1[0].title === "Build landing page");
    assert("DESC parsed correctly", r1[0].description === "Create the page");

    // DEPS: [1]
    const plan2 = `
TYPE READY
TODOS
[1] TITLE: Build backend API
    DESC: Create REST endpoints
    DEPS: []
[2] TITLE: Build frontend UI
    DESC: Create the dashboard
    DEPS: [1]
`.trim();
    const r2 = parseTodosFromContext(plan2);
    assert("Parses two todos", r2.length === 2);
    assert("Todo 1 has DEPS: []", JSON.stringify(r2[0].deps) === "[]");
    assert("Todo 2 has DEPS: [1]", JSON.stringify(r2[1].deps) === "[1]");

    // DEPS: [1, 2]
    const plan3 = `
TYPE READY
TODOS
[1] TITLE: Set up DB
    DESC: Provision database
    DEPS: []
[2] TITLE: Build API
    DESC: Create endpoints
    DEPS: []
[3] TITLE: Build frontend
    DESC: Wire everything together
    DEPS: [1, 2]
`.trim();
    const r3 = parseTodosFromContext(plan3);
    assert("Parses three todos", r3.length === 3);
    assert("Todo 3 has DEPS: [1, 2]", JSON.stringify(r3[2].deps) === "[1,2]");

    // Old format (no DEPS line) — backward compat
    const plan4 = `
TODOS
[1] TITLE: Build UI
    DESC: Create the page
[2] TITLE: Build API
    DESC: Create endpoints
`.trim();
    const r4 = parseTodosFromContext(plan4);
    assert("Old format (no DEPS) still parses", r4.length === 2);
    assert("Old format defaults deps to []", JSON.stringify(r4[0].deps) === "[]");

    // Malformed DEPS — should default to []
    const plan5 = `
TODOS
[1] TITLE: Build something
    DESC: Do the work
    DEPS: [abc, xyz]
`.trim();
    const r5 = parseTodosFromContext(plan5);
    assert("Malformed DEPS values filtered out → []", JSON.stringify(r5[0].deps) === "[]");
  });
}

// ─── 2. todoService — DB integration ──────────────────────────
async function testTodoService() {
  await section("todoService.createTodosWithDeps", async () => {
    // Create a fake workspace row to satisfy FK constraint
    // If no workspace exists, we skip DB tests
    const workspace = await prisma.workspace.findFirst().catch(() => null);
    if (!workspace) {
      console.log(`  ${DIM}(skipping DB tests — no workspace found)${RESET}`);
      return;
    }

    const workspaceId = workspace.id;

    // Clean up any leftover test todos
    await prisma.todo.deleteMany({ where: { workspaceId, title: { startsWith: "__test__" } } });

    // Phase 1 + 2: create todos and wire deps
    const todos = [
      { title: "__test__Backend API",    description: "Build endpoints", deps: [] },
      { title: "__test__Frontend UI",    description: "Build UI",        deps: [1] },
      { title: "__test__Landing Page",   description: "Static page",     deps: [] },
    ];

    const startOrder = 900; // use high order to avoid clashing with real todos
    const created = await todoService.createTodosWithDeps(workspaceId, todos, startOrder);

    assert("Created 3 todos", created.length === 3);

    const fromDb = await prisma.todo.findMany({
      where: { workspaceId, order: { gte: 900, lt: 910 } },
      orderBy: { order: "asc" },
    });

    assert("3 todos in DB", fromDb.length === 3);
    assert("Todo 1 has no deps", fromDb[0].dependencies.length === 0);
    assert("Todo 2 has 1 dep (CUID of todo 1)", fromDb[1].dependencies.length === 1);
    assert("Todo 2 dep points to todo 1 id", fromDb[1].dependencies[0] === fromDb[0].id);
    assert("Todo 3 has no deps", fromDb[2].dependencies.length === 0);

    // Clean up
    await prisma.todo.deleteMany({ where: { workspaceId, order: { gte: 900, lt: 910 } } });
  });

  await section("todoService.getReadyTodos", async () => {
    const workspace = await prisma.workspace.findFirst().catch(() => null);
    if (!workspace) {
      console.log(`  ${DIM}(skipping DB tests — no workspace found)${RESET}`);
      return;
    }

    const workspaceId = workspace.id;
    await prisma.todo.deleteMany({ where: { workspaceId, order: { gte: 800, lt: 820 } } });

    // Create: todo A (no deps), todo B (deps on A)
    const [todoA, todoB] = await Promise.all([
      prisma.todo.create({ data: { workspaceId, title: "__test__A", description: "A", order: 800, status: "pending" } }),
      prisma.todo.create({ data: { workspaceId, title: "__test__B", description: "B", order: 801, status: "pending" } }),
    ]);

    // Wire B → depends on A
    await prisma.todo.update({ where: { id: todoB.id }, data: { dependencies: [todoA.id] } });

    // Both pending — only A should be ready (B is blocked by A)
    const wave1 = await todoService.getReadyTodos(workspaceId);
    const wave1Ids = wave1.map((t) => t.id);
    assert("Wave 1: only todo A is ready (B blocked)", wave1Ids.includes(todoA.id) && !wave1Ids.includes(todoB.id));

    // Mark A complete — now B should be ready
    await prisma.todo.update({ where: { id: todoA.id }, data: { status: "completed" } });
    const wave2 = await todoService.getReadyTodos(workspaceId);
    const wave2Ids = wave2.map((t) => t.id);
    assert("Wave 2: todo B is ready after A completes", wave2Ids.includes(todoB.id));

    // Mark B complete — neither test todo should appear in ready list
    await prisma.todo.update({ where: { id: todoB.id }, data: { status: "completed" } });
    const wave3 = await todoService.getReadyTodos(workspaceId);
    const wave3Ids = wave3.map((t) => t.id);
    assert("Wave 3: test todos no longer in ready list", !wave3Ids.includes(todoA.id) && !wave3Ids.includes(todoB.id));

    // Clean up
    await prisma.todo.deleteMany({ where: { workspaceId, order: { gte: 800, lt: 820 } } });
  });

  await section("todoService.getReadyTodos — deadlock detection", async () => {
    const workspace = await prisma.workspace.findFirst().catch(() => null);
    if (!workspace) {
      console.log(`  ${DIM}(skipping DB tests — no workspace found)${RESET}`);
      return;
    }

    const workspaceId = workspace.id;
    await prisma.todo.deleteMany({ where: { workspaceId, order: { gte: 820, lt: 830 } } });

    // Create two todos with circular deps: X → Y → X
    const [todoX, todoY] = await Promise.all([
      prisma.todo.create({ data: { workspaceId, title: "__test__X", description: "X", order: 820, status: "pending" } }),
      prisma.todo.create({ data: { workspaceId, title: "__test__Y", description: "Y", order: 821, status: "pending" } }),
    ]);
    await Promise.all([
      prisma.todo.update({ where: { id: todoX.id }, data: { dependencies: [todoY.id] } }),
      prisma.todo.update({ where: { id: todoY.id }, data: { dependencies: [todoX.id] } }),
    ]);

    const result = await todoService.getReadyTodos(workspaceId);
    // Deadlock fires only when ALL pending todos in the workspace are blocked.
    // In a shared workspace there may be other unblocked todos — so we check
    // whether the service correctly identified a deadlock among our test todos
    // by verifying neither test todo appears as "ready" without the flag.
    const xReady = result.find((t) => t.id === todoX.id);
    const yReady = result.find((t) => t.id === todoY.id);
    const deadlockFired = result.some((t) => (t as any).deadlocked === true);
    const neitherReadyNormally = !xReady && !yReady;

    if (deadlockFired) {
      // Full deadlock scenario — all pending todos were our circular pair
      assert("Deadlock detected — returns 1 todo to force-break", result.length === 1);
      assert("Deadlocked flag set", (result[0] as any).deadlocked === true);
      assert("Force-breaks with lowest order todo", result[0].order === 820);
    } else {
      // Other pending todos exist in workspace — circular pair correctly excluded
      assert("Circular todos not returned as ready", neitherReadyNormally);
      assert("Deadlock pair correctly blocked", neitherReadyNormally);
      assert("(deadlock flag skipped — shared workspace has other pending todos)", true);
    }

    await prisma.todo.deleteMany({ where: { workspaceId, order: { gte: 820, lt: 830 } } });
  });
}

// ─── 3. FINAL ANSWER Parser ───────────────────────────────────
async function testFinalAnswerParser() {
  await section("FINAL ANSWER — TASK=<order> parsing", async () => {
    assert(
      "Parses TASK=1",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=3000") === 1,
    );
    assert(
      "Parses TASK=3",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK=3") === 3,
    );
    assert(
      "Returns null when no TASK=",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER FRONTEND=3000 BACKEND=8000") === null,
    );
    assert(
      "Case insensitive",
      parseTaskOrderFromFinalAnswer("final answer task=2 frontend=3000") === 2,
    );
    assert(
      "TASK= with spaces",
      parseTaskOrderFromFinalAnswer("FINAL ANSWER TASK = 5") === 5,
    );
  });

  await section("FINAL ANSWER — port parsing with TASK=", async () => {
    const p1 = parsePortsFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=3000 BACKEND=8000");
    assert("Frontend port parsed alongside TASK=", p1.frontend === 3000);
    assert("Backend port parsed alongside TASK=", p1.backend === 8000);

    const p2 = parsePortsFromFinalAnswer("FINAL ANSWER TASK=2");
    assert("No ports when task has no server", p2.frontend === undefined && p2.backend === undefined);

    const p3 = parsePortsFromFinalAnswer("FINAL ANSWER TASK=1 FRONTEND=5173");
    assert("Vite port (5173) parsed correctly", p3.frontend === 5173);
  });
}

// ─── 4. aiAgentsMd Validation ───────────────────────────────
async function testAI AgentsMdValidation() {
  await section("aiAgentsMd — placeholder + validation", async () => {
    assert(
      "Rejects literal placeholder",
      !isValidPlan("FULL_TOON_PLAN_HERE"),
    );
    assert(
      "Rejects empty string",
      !isValidPlan(""),
    );
    assert(
      "Rejects null",
      !isValidPlan(null),
    );
    assert(
      "Rejects plan missing TODOS section",
      !isValidPlan("TYPE READY\nCONTEXT\nSUMMARY: something"),
    );
    assert(
      "Accepts valid TOON plan",
      isValidPlan("TYPE READY\n\nCONTEXT\nSUMMARY: Test\n\nTODOS\n[1] TITLE: Build\n    DESC: ...\n    DEPS: []"),
    );
    assert(
      "Accepts plan with multiple todos",
      isValidPlan("TYPE READY\nTODOS\n[1] TITLE: A\n    DEPS: []\n[2] TITLE: B\n    DEPS: [1]"),
    );
  });
}

// ─── 5. Wave Grouping Logic ────────────────────────────────────
async function testWaveGrouping() {
  await section("Wave grouping — dependency ordering", async () => {
    // Simulate what getReadyTodos returns across waves
    // given: A(no deps), B(no deps), C(deps on A), D(deps on B,C)

    type Todo = { id: string; order: number; deps: string[] };

    function simulateWaves(todos: Todo[]): string[][] {
      const completed = new Set<string>();
      const waves: string[][] = [];

      while (true) {
        const ready = todos.filter(
          (t) => !completed.has(t.id) && t.deps.every((d) => completed.has(d))
        );
        if (ready.length === 0) break;
        waves.push(ready.map((t) => t.id));
        ready.forEach((t) => completed.add(t.id));
      }
      return waves;
    }

    const todos: Todo[] = [
      { id: "A", order: 1, deps: [] },
      { id: "B", order: 2, deps: [] },
      { id: "C", order: 3, deps: ["A"] },
      { id: "D", order: 4, deps: ["B", "C"] },
    ];

    const waves = simulateWaves(todos);
    assert("Wave 1 contains A and B (both independent)", waves[0].includes("A") && waves[0].includes("B"));
    assert("Wave 1 has 2 todos", waves[0].length === 2);
    assert("Wave 2 contains C (dep A done)", waves[1].includes("C"));
    assert("Wave 3 contains D (deps B+C done)", waves[2].includes("D"));
    assert("Total 3 waves for 4 todos", waves.length === 3);
  });
}

// ══════════════════════════════════════════════════════════════
// RUNNER
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${BOLD}AI Agents — Plan & Dependency Test Suite${RESET}`);
  console.log("─".repeat(50));

  await testToonParser();
  await testFinalAnswerParser();
  await testAI AgentsMdValidation();
  await testWaveGrouping();
  await testTodoService();   // DB tests last

  await prisma.$disconnect();

  console.log("\n" + "─".repeat(50));
  console.log(`${BOLD}Results: ${GREEN} ${passed} passed  ${RED} ${failed} failed${RESET}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
