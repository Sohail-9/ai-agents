import { promises as fs } from "fs";
import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import { executeSkill as executeTool } from "../skills";
import { SandboxManager } from "../sandbox/sandboxManager";

const SANDBOX_TEMP_FILE = "/workspace/__tool_test_temp__.txt";
const SANDBOX_TEMP_DIR = "/workspace/__tool_test_dir__";
const GREEN = "\x1b[32m✔\x1b[0m";
const RED = "\x1b[31m✘\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
let sandboxId: string | null = process.env.E2B_TEST_SANDBOX_ID ?? null;

async function ensureSandbox(): Promise<string | null> {
  if (sandboxId) return sandboxId;
  if (!process.env.E2B_API_KEY) {
    console.log("  (skipping sandbox tool tests: missing E2B_API_KEY)");
    return null;
  }
  const created = await SandboxManager.getInstance().openAndInit({
    prettiflowMd: "# Tool tests",
  });
  sandboxId = created.sandboxId;
  return sandboxId;
}

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
  await fn();
}

async function cleanup() {
  try {
    await fs.unlink(path.join(process.cwd(), ".ai_context.json"));
  } catch {}
}

async function run() {
  await cleanup();

  await section("read_file", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const sandbox = await Sandbox.connect(id);
    await sandbox.files.write(SANDBOX_TEMP_FILE, "hello prettiflow");

    const ok = await executeTool({
      tool: "read_file",
      params: { path: SANDBOX_TEMP_FILE, sandboxId: id },
    });
    assert("reads existing file", ok.success && ok.output === "hello prettiflow", ok.error);

    const bad = await executeTool({
      tool: "read_file",
      params: { path: "/workspace/__nonexistent__.txt", sandboxId: id },
    });
    assert("returns error for missing file", !bad.success && !!bad.error);
  });

  await section("edit_file — overwrite", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const r = await executeTool({
      tool: "edit_file",
      params: {
        path: SANDBOX_TEMP_FILE,
        operation: "overwrite",
        content: "line1\nline2",
        sandboxId: id,
      },
    });
    assert("reports success", r.success, r.error);

    const sandbox = await Sandbox.connect(id);
    const content = await sandbox.files.read(SANDBOX_TEMP_FILE);
    assert("file content matches", content === "line1\nline2", JSON.stringify(content));
  });

  await section("edit_file — append", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const r = await executeTool({
      tool: "edit_file",
      params: {
        path: SANDBOX_TEMP_FILE,
        operation: "append",
        content: "\nline3",
        sandboxId: id,
      },
    });
    assert("reports success", r.success, r.error);

    const sandbox = await Sandbox.connect(id);
    const content = await sandbox.files.read(SANDBOX_TEMP_FILE);
    assert("appended correctly", content === "line1\nline2\nline3", JSON.stringify(content));
  });

  await section("edit_file — replace", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const r = await executeTool({
      tool: "edit_file",
      params: {
        path: SANDBOX_TEMP_FILE,
        operation: "replace",
        find: "line2",
        replace: "LINE_TWO",
        sandboxId: id,
      },
    });
    assert("reports success", r.success, r.error);
    assert("mentions occurrence count", r.output?.includes("1 occurrence") ?? false, r.output);

    const sandbox = await Sandbox.connect(id);
    const content = await sandbox.files.read(SANDBOX_TEMP_FILE);
    assert("replaced correctly", content.includes("LINE_TWO"), JSON.stringify(content));

    const notFound = await executeTool({
      tool: "edit_file",
      params: {
        path: SANDBOX_TEMP_FILE,
        operation: "replace",
        find: "DOES_NOT_EXIST",
        replace: "x",
        sandboxId: id,
      },
    });
    assert("errors when pattern not found", !notFound.success, notFound.output);
  });

  await section("edit_file — missing params", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const r = await executeTool({
      tool: "edit_file",
      params: { path: SANDBOX_TEMP_FILE, operation: "overwrite", sandboxId: id },
    });
    assert("errors when content missing for overwrite", !r.success, r.output);
  });

  await section("search_code", async () => {
    const id = await ensureSandbox();
    if (!id) return;

    const sandbox = await Sandbox.connect(id);
    await sandbox.commands.run(`mkdir -p '${SANDBOX_TEMP_DIR}'`);
    await sandbox.files.write(
      `${SANDBOX_TEMP_DIR}/sample.txt`,
      "const PORT = 8000;\nconst HOST = 'localhost';",
    );

    const r = await executeTool({
      tool: "search_code",
      params: { query: "PORT", directory: SANDBOX_TEMP_DIR, sandboxId: id },
    });
    assert(
      "finds match",
      r.success && (r.output?.includes("PORT") ?? false),
      r.output?.slice(0, 120),
    );

    // Search isolated dir for a string that genuinely doesn't exist there.
    const noMatch = await executeTool({
      tool: "search_code",
      params: { query: "NO_SUCH_TOKEN_HERE", directory: SANDBOX_TEMP_DIR, sandboxId: id },
    });
    assert(
      "returns no matches message",
      noMatch.success && noMatch.output === "No matches found.",
      noMatch.output,
    );

    const regex = await executeTool({
      tool: "search_code",
      params: { query: "^const", directory: SANDBOX_TEMP_DIR, isRegex: true, sandboxId: id },
    });
    assert(
      "regex search works",
      regex.success && (regex.output?.includes("const") ?? false),
      regex.output?.slice(0, 120),
    );
  });

  await section("context_save", async () => {
    const save = await executeTool({
      tool: "context_save",
      params: { key: "test_key", data: "some important value" },
    });
    assert("saves successfully", save.success, save.error);
    assert("confirms key in output", save.output?.includes("test_key") ?? false, save.output);

    const raw = await fs.readFile(path.join(process.cwd(), ".ai_context.json"), "utf8");
    const store = JSON.parse(raw);
    assert("value persisted to disk", store["test_key"] === "some important value");

    const overwrite = await executeTool({
      tool: "context_save",
      params: { key: "test_key", data: "updated value" },
    });
    assert("overwrites existing key", overwrite.success);

    const raw2 = JSON.parse(
      await fs.readFile(path.join(process.cwd(), ".ai_context.json"), "utf8"),
    );
    assert("verifies overwrite", raw2["test_key"] === "updated value");
  });

  await section("dispatcher — unknown tool", async () => {
    const r = await executeTool({ tool: "nonexistent" as any, params: {} as any });
    assert(
      "returns error for unknown tool",
      !r.success && (r.error?.includes("Unknown tool") ?? false),
    );
  });

  await cleanup();

  console.log(`\n${BOLD}Results: ${passed} passed, ${failed} failed${RESET}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
