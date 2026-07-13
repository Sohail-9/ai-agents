import type { Sandbox } from "@e2b/code-interpreter";
import { qwen } from "../brain/providers/qwen";
import { persistTypographyOverrides, type TypographyOverridesInput } from "./persist";

export interface TailwindApplyInput {
  sandbox: Sandbox;
  clerkUserId: string;
  selector: string;
  tagName: string;
  cssChanges: Record<string, string>;
  elementClasses: string[];
  newText?: string;
  currentText?: string;
  newSrc?: string;
  currentSrc?: string;
}

export interface TailwindApplyResult {
  method: "tailwind" | "css-fallback";
  file?: string;
  classesAdded?: string[];
  classesRemoved?: string[];
}

// Generic single-char or ubiquitous Tailwind classes that offer no uniqueness for file search
const GENERIC_CLASSES = new Set([
  "flex", "block", "inline", "grid", "hidden", "relative", "absolute", "fixed", "sticky",
  "w-full", "h-full", "w-screen", "h-screen", "min-h-screen", "min-w-full",
  "overflow-hidden", "overflow-auto", "overflow-scroll",
  "items-center", "items-start", "items-end", "justify-center", "justify-between",
  "justify-start", "justify-end", "flex-col", "flex-row", "flex-1", "flex-wrap",
  "text-white", "text-black", "text-sm", "text-base", "text-lg", "text-xl",
  "bg-white", "bg-black", "bg-transparent",
  "p-0", "m-0", "gap-0",
  "container", "mx-auto", "font-sans", "font-mono",
  "cursor-pointer", "cursor-default",
  "rounded", "border", "shadow",
  "transition", "duration-200", "duration-300",
]);

function pickUniqueClasses(classes: string[], maxCount = 3): string[] {
  const filtered = classes.filter((c) => !GENERIC_CLASSES.has(c) && c.length > 3);
  // Prefer longer, more specific classes
  filtered.sort((a, b) => b.length - a.length);
  return filtered.slice(0, maxCount);
}

function applyClassDelta(existing: string, toAdd: string[], toRemove: string[]): string {
  const current = new Set(existing.split(/\s+/).filter(Boolean));
  toRemove.forEach((c) => current.delete(c));
  toAdd.forEach((c) => current.add(c));
  return Array.from(current).join(" ");
}

const TAILWIND_SYSTEM_PROMPT = `You translate CSS property changes into Tailwind CSS v3 class changes.
Return ONLY a JSON object, no prose: { "classesToAdd": [...], "classesToRemove": [...] }

Rules:
- Only remove existing classes that directly conflict with the new CSS values
- Use Tailwind v3 arbitrary values like text-[#ff0000] or p-[20px] when no standard class fits
- Keep all existing classes that don't conflict
- For colors: prefer named Tailwind colors (red-500, blue-600) when the hex is close; otherwise use [#rrggbb]
- For font-size: 12px→text-xs, 14px→text-sm, 16px→text-base, 18px→text-lg, 20px→text-xl, 24px→text-2xl, etc.
- For font-weight: 400→font-normal, 500→font-medium, 600→font-semibold, 700→font-bold, 800→font-extrabold
- For border-radius: 0→rounded-none, 4px→rounded, 6px→rounded-md, 8px→rounded-lg, 12px→rounded-xl, 16px→rounded-2xl, 9999px→rounded-full
- For opacity: 0→opacity-0, 0.5→opacity-50, 1→opacity-100, etc.
- For text-align: left→text-left, center→text-center, right→text-right, justify→text-justify`;

async function cssToTailwind(
  clerkUserId: string,
  tagName: string,
  existingClasses: string[],
  cssChanges: Record<string, string>,
): Promise<{ classesToAdd: string[]; classesToRemove: string[] }> {
  let client;
  try {
    client = await qwen.getClient(clerkUserId);
  } catch {
    return { classesToAdd: [], classesToRemove: [] };
  }

  const userMsg = JSON.stringify({
    tagName,
    existingClasses: existingClasses.join(" "),
    cssChanges,
  });

  try {
    const completion = await client.chat.completions.create({
      model: "qwen-turbo",
      max_completion_tokens: 300,
      temperature: 0.1,
      messages: [
        { role: "system", content: TAILWIND_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const jsonStr = fenced?.[1] ?? trimmed;
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first === -1 || last === -1) return { classesToAdd: [], classesToRemove: [] };

    const parsed = JSON.parse(jsonStr.slice(first, last + 1));
    const classesToAdd = Array.isArray(parsed.classesToAdd) ? parsed.classesToAdd.filter((c: unknown) => typeof c === "string") : [];
    const classesToRemove = Array.isArray(parsed.classesToRemove) ? parsed.classesToRemove.filter((c: unknown) => typeof c === "string") : [];
    return { classesToAdd, classesToRemove };
  } catch {
    return { classesToAdd: [], classesToRemove: [] };
  }
}

async function findAndPatchSourceFile(
  sandbox: Sandbox,
  elementClasses: string[],
  tagName: string,
  classesToAdd: string[],
  classesToRemove: string[],
): Promise<{ file: string } | null> {
  const uniqueClasses = pickUniqueClasses(elementClasses, 3);
  if (uniqueClasses.length === 0) return null;

  // Build grep pattern: all unique classes must be present (in any order) in the same className attr
  // Use a grep for the most unique class in tsx/jsx files
  const primaryClass = uniqueClasses[0];
  const safeClass = primaryClass.replace(/[[\]().*+?^${}|\\]/g, "\\$&");

  let grepOutput = "";
  try {
    const result = await sandbox.commands.run(
      `grep -rl "${safeClass}" /workspace/frontend --include="*.tsx" --include="*.jsx" --include="*.ts" --include="*.js" 2>/dev/null | head -5`,
      { timeoutMs: 8000 },
    );
    grepOutput = (result.stdout || "").trim();
  } catch {
    return null;
  }

  const candidates = grepOutput.split("\n").filter(Boolean);
  if (candidates.length === 0 || candidates.length > 3) return null;

  // If multiple unique classes, prefer the file that contains all of them
  let targetFile = candidates[0];
  if (candidates.length > 1 && uniqueClasses.length > 1) {
    for (const file of candidates) {
      try {
        const content = await sandbox.files.read(file);
        const allPresent = uniqueClasses.every((c) => content.includes(c));
        if (allPresent) { targetFile = file; break; }
      } catch { /* skip */ }
    }
  }

  let fileContent: string;
  try {
    fileContent = await sandbox.files.read(targetFile);
  } catch {
    return null;
  }

  // Find className attribute containing the primary class and apply delta
  // Regex: className="..." or className={`...`} or className={'...'}
  const classAttrRe = /className=(?:"([^"]*?)"|'([^']*?)'|`([^`]*?)`)/g;
  let match: RegExpExecArray | null;
  let patched = fileContent;
  let found = false;

  while ((match = classAttrRe.exec(fileContent)) !== null) {
    const rawVal = match[1] ?? match[2] ?? match[3] ?? "";
    // Check all unique classes are present in this className
    const allPresent = uniqueClasses.every((c) => rawVal.includes(c));
    if (!allPresent) continue;

    const newVal = applyClassDelta(rawVal, classesToAdd, classesToRemove);
    const originalAttr = match[0];
    let quote = '"';
    if (match[2] !== undefined) quote = "'";
    if (match[3] !== undefined) quote = "`";
    const newAttr = `className=${quote}${newVal}${quote}`;
    patched = patched.slice(0, match.index) + newAttr + patched.slice(match.index + originalAttr.length);
    found = true;
    break;
  }

  if (!found) return null;

  try {
    await sandbox.files.write(targetFile, patched);
    return { file: targetFile };
  } catch {
    return null;
  }
}

async function patchText(
  sandbox: Sandbox,
  elementClasses: string[],
  tagName: string,
  currentText: string,
  newText: string,
): Promise<void> {
  if (!currentText || !newText || currentText === newText) return;
  const uniqueClasses = pickUniqueClasses(elementClasses, 2);
  if (uniqueClasses.length === 0) return;

  const safeClass = uniqueClasses[0].replace(/[[\]().*+?^${}|\\]/g, "\\$&");
  let grepOutput = "";
  try {
    const result = await sandbox.commands.run(
      `grep -rl "${safeClass}" /workspace/frontend --include="*.tsx" --include="*.jsx" 2>/dev/null | head -3`,
      { timeoutMs: 6000 },
    );
    grepOutput = (result.stdout || "").trim();
  } catch { return; }

  const files = grepOutput.split("\n").filter(Boolean);
  for (const file of files) {
    try {
      const content = await sandbox.files.read(file);
      if (!content.includes(currentText)) continue;
      const patched = content.replace(currentText, newText);
      await sandbox.files.write(file, patched);
      return;
    } catch { /* next */ }
  }
}

async function patchImageSrc(
  sandbox: Sandbox,
  currentSrc: string,
  newSrc: string,
): Promise<void> {
  if (!currentSrc || !newSrc || currentSrc === newSrc) return;
  const safeSrc = currentSrc.replace(/[[\]().*+?^${}|\\]/g, "\\$&");
  let grepOutput = "";
  try {
    const result = await sandbox.commands.run(
      `grep -rl "${safeSrc}" /workspace/frontend --include="*.tsx" --include="*.jsx" 2>/dev/null | head -3`,
      { timeoutMs: 6000 },
    );
    grepOutput = (result.stdout || "").trim();
  } catch { return; }

  const files = grepOutput.split("\n").filter(Boolean);
  for (const file of files) {
    try {
      const content = await sandbox.files.read(file);
      if (!content.includes(currentSrc)) continue;
      const patched = content.replace(currentSrc, newSrc);
      await sandbox.files.write(file, patched);
      return;
    } catch { /* next */ }
  }
}

export async function applyTailwindChanges(input: TailwindApplyInput): Promise<TailwindApplyResult> {
  const {
    sandbox, clerkUserId, selector, tagName, cssChanges, elementClasses,
    newText, currentText, newSrc, currentSrc,
  } = input;

  // Handle text and src patches regardless of CSS changes
  if (newText && currentText && newText !== currentText) {
    await patchText(sandbox, elementClasses, tagName, currentText, newText);
  }
  if (newSrc && currentSrc && newSrc !== currentSrc) {
    await patchImageSrc(sandbox, currentSrc, newSrc);
  }

  // No CSS changes → done
  if (Object.keys(cssChanges).length === 0) {
    return { method: "tailwind" };
  }

  // Step 1: CSS → Tailwind class delta via Qwen
  const { classesToAdd, classesToRemove } = await cssToTailwind(
    clerkUserId, tagName, elementClasses, cssChanges,
  );

  // Step 2: Find source file and patch className
  if (elementClasses.length > 0 && (classesToAdd.length > 0 || classesToRemove.length > 0)) {
    const result = await findAndPatchSourceFile(
      sandbox, elementClasses, tagName, classesToAdd, classesToRemove,
    );
    if (result) {
      return { method: "tailwind", file: result.file, classesAdded: classesToAdd, classesRemoved: classesToRemove };
    }
  }

  // Fallback: write CSS override file
  const overrides: TypographyOverridesInput = { [selector]: cssChanges };
  await persistTypographyOverrides(sandbox, overrides);
  return { method: "css-fallback" };
}
