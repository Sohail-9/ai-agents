import { Sandbox } from "@e2b/code-interpreter";
import { SearchCodeParams, ToolResult } from "../types";

// Generated/build dirs that flood results and break edit find-strings — never searched.
const EXCLUDED_DIRS = [
  "node_modules", ".git", ".next", "dist", "build", ".turbo",
  "out", "coverage", ".cache", ".vercel", ".svelte-kit", ".nuxt",
];
const MAX_RESULT_LINES = 200; // cap total match lines returned to the model
const MAX_LINE_LENGTH = 400;  // cap per-line width (kills minified/sourcemap lines)

export async function search_code(params: SearchCodeParams): Promise<ToolResult> {
  const rootDir = params.directory ?? "/workspace";
  const { query, isRegex, sandboxId } = params;

  try {
    const sandbox = await Sandbox.connect(sandboxId);

    // Escaping single quotes in query for shell
    const escapedQuery = query.replace(/'/g, "'\\''");
    const grepFlag = isRegex ? "-E" : "-F";
    const excludes = EXCLUDED_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
    // -I skips binary files. Pipe caps line width then total lines so a broad query
    // in a big repo can't return a flood the model has to wade through.
    const cmd = `grep -rnI ${grepFlag} ${excludes} '${escapedQuery}' ${rootDir} 2>/dev/null | cut -c1-${MAX_LINE_LENGTH} | head -n ${MAX_RESULT_LINES}`;

    const result = await sandbox.commands.run(cmd);
    const output = (result.stdout ?? "").trim();

    // Empty output = no matches (grep errors are suppressed to /dev/null and also
    // surface as empty). Treating empty as "no matches" is shell-agnostic — no reliance
    // on a pipe exit code, which would reflect head/cut rather than grep.
    if (!output) {
      return { success: true, output: "No matches found." };
    }

    const lineCount = output.split("\n").length;
    const capped =
      lineCount >= MAX_RESULT_LINES
        ? `${output}\n\n[search_code: results capped at ${MAX_RESULT_LINES} lines. Narrow the query or pass a more specific 'directory' to see the rest — do NOT keep re-searching.]`
        : output;

    return { success: true, output: capped };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
