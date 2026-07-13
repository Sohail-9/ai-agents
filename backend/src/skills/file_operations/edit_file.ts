import { Sandbox } from "@e2b/code-interpreter";
import path from "path";
import { EditFileParams, ToolResult } from "../types";

const normalizeLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Line-based, whitespace-normalized match of `find` within `existing`.
 * Handles the common failure where the model reproduces the right lines but
 * with different indentation/whitespace. Returns the matched line range in the
 * ORIGINAL file, or null if not exactly one normalized match.
 */
function findNormalizedLineRange(
  existing: string,
  find: string,
): { start: number; end: number } | null {
  const fileLines = existing.split("\n");
  const findLines = find.split("\n").map(normalizeLine);
  // Drop leading/trailing blank lines from the needle so stray newlines don't break it.
  while (findLines.length && findLines[0] === "") findLines.shift();
  while (findLines.length && findLines[findLines.length - 1] === "") findLines.pop();
  if (findLines.length === 0) return null;

  const matches: number[] = [];
  for (let i = 0; i + findLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < findLines.length; j++) {
      if (normalizeLine(fileLines[i + j]) !== findLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  if (matches.length !== 1) return null; // 0 = no match, >1 = ambiguous
  return { start: matches[0], end: matches[0] + findLines.length };
}

/**
 * On a failed match, return the region of the file most likely to be the intended
 * target (anchored on the most distinctive line of `find`), with line numbers, so
 * the model can copy the EXACT current text for its next find string.
 */
function nearestRegion(existing: string, find: string): string {
  const fileLines = existing.split("\n");
  const findLines = find.split("\n").map(normalizeLine).filter(Boolean);
  const anchor = [...findLines].sort((a, b) => b.length - a.length)[0] ?? "";
  let bestIdx = -1;
  if (anchor) {
    for (let i = 0; i < fileLines.length; i++) {
      const n = normalizeLine(fileLines[i]);
      if (n && (n.includes(anchor) || (anchor.includes(n) && n.length > 3))) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx === -1) {
      const token = anchor.split(" ").sort((a, b) => b.length - a.length)[0] ?? "";
      if (token.length > 2) bestIdx = fileLines.findIndex((l) => l.includes(token));
    }
  }
  if (bestIdx === -1) return "";
  const from = Math.max(0, bestIdx - 4);
  const to = Math.min(fileLines.length, bestIdx + 6);
  return fileLines
    .slice(from, to)
    .map((l, k) => `${from + k + 1}: ${l}`)
    .join("\n");
}

export async function edit_file(params: EditFileParams): Promise<ToolResult> {
  const { path: filePath, operation, content, find, replace, sandboxId } = params;

  try {
    const sandbox = await Sandbox.connect(sandboxId);
    // Ensure the directory exists
    await sandbox.commands.run(`mkdir -p "$(dirname '${filePath}')"`);

    if (operation === "overwrite") {
      if (content === undefined) {
        return { success: false, error: "'content' is required for overwrite." };
      }
      await sandbox.files.write(filePath, content);
      return { success: true, output: `Overwrote ${filePath}.` };
    }

    if (operation === "append") {
      if (content === undefined) {
        return { success: false, error: "'content' is required for append." };
      }
      let existing = "";
      try {
        existing = await sandbox.files.read(filePath);
      } catch (e) {
        // file doesn't exist, start fresh
      }
      await sandbox.files.write(filePath, existing + content);
      return { success: true, output: `Appended to ${filePath}.` };
    }

    if (operation === "replace") {
      if (find === undefined || replace === undefined) {
        return { success: false, error: "'find' and 'replace' are required for replace." };
      }
      let existing: string;
      try {
        existing = await sandbox.files.read(filePath);
      } catch (e) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      // 1) Exact match (fast path).
      const occurrences = existing.split(find).length - 1;
      if (occurrences > 0) {
        const updated = existing.split(find).join(replace);
        await sandbox.files.write(filePath, updated);
        return { success: true, output: `Replaced ${occurrences} occurrence(s) in ${filePath}.` };
      }

      // 2) Whitespace-normalized, line-based fallback (handles indentation/whitespace drift).
      const range = findNormalizedLineRange(existing, find);
      if (range) {
        const fileLines = existing.split("\n");
        const updatedLines = [
          ...fileLines.slice(0, range.start),
          ...replace.split("\n"),
          ...fileLines.slice(range.end),
        ];
        await sandbox.files.write(filePath, updatedLines.join("\n"));
        return {
          success: true,
          output: `Replaced 1 occurrence in ${filePath} (matched ignoring whitespace).`,
        };
      }

      // 3) Miss — return the nearest current content so the model copies exact text.
      const region = nearestRegion(existing, find);
      const hint = region
        ? `\nClosest current content (copy the EXACT text below — including punctuation like "&" and whitespace — for your find string):\n${region}`
        : ` The file does not contain text resembling your find string. Read the file to see its current content.`;
      return {
        success: false,
        error: `Pattern not found in ${filePath}.${hint}`,
      };
    }

    return { success: false, error: `Unknown operation: ${operation}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
