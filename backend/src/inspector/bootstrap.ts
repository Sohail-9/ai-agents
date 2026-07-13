import type { Sandbox } from "@e2b/code-interpreter";
import { INSPECTOR_CLIENT_TEMPLATE } from "./inspector-client.template";

const INSPECTOR_VERSION = "15";

const ROOT_LAYOUT_CANDIDATES = [
  "/workspace/frontend/src/app/layout.tsx",
  "/workspace/frontend/app/layout.tsx",
  "/workspace/src/app/layout.tsx",
  "/workspace/app/layout.tsx",
];

const SCRIPT_FILENAME = `inspector-client.v${INSPECTOR_VERSION}.js`;
const SCRIPT_URL = `/.pf/${SCRIPT_FILENAME}`;
const SCRIPT_TAG = `<script src="${SCRIPT_URL}" defer></script>`;
// Match any prior versioned tag so we can replace it on a version bump.
const EXISTING_TAG_RE = /<script src="\/\.pf\/inspector-client(?:\.v\d+)?\.js" defer><\/script>/g;

function validateParentOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`bootstrapInspector: parentOrigin is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`bootstrapInspector: parentOrigin must be http(s): ${value}`);
  }
  // origin omits any path/query/hash even if the user passed extra
  return parsed.origin;
}

function buildClientScript(parentOrigin: string): string {
  // The placeholder sits inside a JS string literal (var X = "__PF_PARENT_ORIGIN__";).
  // Validate as a URL origin and inject as a JSON-quoted string so the literal is
  // closed safely. The template's surrounding quotes get replaced together with the
  // placeholder by using a wrapping pattern that includes them.
  const safeOrigin = validateParentOrigin(parentOrigin);
  const jsonOrigin = JSON.stringify(safeOrigin);
  return INSPECTOR_CLIENT_TEMPLATE.replace(/"__PF_PARENT_ORIGIN__"/g, jsonOrigin).replace(
    /"__PF_INSPECTOR_VERSION__"/g,
    JSON.stringify(INSPECTOR_VERSION),
  );
}

async function pathExistsInSandbox(sandbox: Sandbox, p: string): Promise<boolean> {
  try {
    await sandbox.files.read(p);
    return true;
  } catch {
    return false;
  }
}

async function findFirstExisting(sandbox: Sandbox, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExistsInSandbox(sandbox, candidate)) return candidate;
  }
  return null;
}

async function ensureScriptWritten(sandbox: Sandbox, content: string): Promise<string> {
  // Pick the public/ directory that exists; default to the frontend convention.
  const possibleDirs = ["/workspace/frontend/public", "/workspace/public"];
  let chosenDir: string | null = null;
  for (const dir of possibleDirs) {
    if (await pathExistsInSandbox(sandbox, dir)) {
      chosenDir = dir;
      break;
    }
  }
  if (!chosenDir) chosenDir = possibleDirs[0]; // create under frontend/public by default
  const target = `${chosenDir}/.pf/${SCRIPT_FILENAME}`;
  await sandbox.files.write(target, content);
  return target;
}

async function ensureLayoutPatched(sandbox: Sandbox): Promise<void> {
  const layoutPath = await findFirstExisting(sandbox, ROOT_LAYOUT_CANDIDATES);
  if (!layoutPath) {
    console.warn("[inspector/bootstrap] no root layout found in known locations");
    return;
  }
  let layoutContent: string;
  try {
    layoutContent = await sandbox.files.read(layoutPath);
  } catch (err) {
    console.warn(`[inspector/bootstrap] could not read ${layoutPath}:`, err);
    return;
  }
  // If the current versioned tag is already present, no-op.
  if (layoutContent.includes(SCRIPT_TAG)) return;

  // If an older versioned tag exists, replace it in place.
  if (EXISTING_TAG_RE.test(layoutContent)) {
    EXISTING_TAG_RE.lastIndex = 0;
    const next = layoutContent.replace(EXISTING_TAG_RE, SCRIPT_TAG);
    await sandbox.files.write(layoutPath, next);
    return;
  }

  // Otherwise insert before </head> if there's an explicit <head>; else before </body>.
  const headIdx = layoutContent.indexOf("</head>");
  const bodyIdx = layoutContent.indexOf("</body>");
  let next: string;
  if (headIdx !== -1) {
    next =
      layoutContent.slice(0, headIdx) +
      `        ${SCRIPT_TAG}\n        ` +
      layoutContent.slice(headIdx);
  } else if (bodyIdx !== -1) {
    next =
      layoutContent.slice(0, bodyIdx) +
      `        ${SCRIPT_TAG}\n        ` +
      layoutContent.slice(bodyIdx);
  } else {
    console.warn(
      `[inspector/bootstrap] ${layoutPath} has no </head> or </body> — leaving unmodified.`,
    );
    return;
  }
  await sandbox.files.write(layoutPath, next);
}

export interface BootstrapInspectorOptions {
  sandbox: Sandbox;
  parentOrigin: string;
}

function markerPathFor(parentOrigin: string): string {
  // Origin is part of the marker so a parent-origin change re-runs bootstrap once.
  return `/workspace/.pf/bootstrap-done-v${INSPECTOR_VERSION}-${encodeURIComponent(parentOrigin)}`;
}

/**
 * Idempotent: writes the inspector client script into the sandbox public directory
 * and patches the root layout to include <script src="/.pf/inspector-client.js" defer>.
 *
 * Safe to call on every workspace start. A marker file is dropped on first
 * successful bootstrap; subsequent calls short-circuit on marker presence.
 */
export async function bootstrapInspector(opts: BootstrapInspectorOptions): Promise<void> {
  const { sandbox, parentOrigin } = opts;
  if (!parentOrigin) throw new Error("bootstrapInspector requires parentOrigin");
  const safeOrigin = validateParentOrigin(parentOrigin);
  const marker = markerPathFor(safeOrigin);
  if (await pathExistsInSandbox(sandbox, marker)) return;
  const content = buildClientScript(safeOrigin);
  await Promise.all([
    ensureScriptWritten(sandbox, content),
    ensureLayoutPatched(sandbox),
  ]);
  try {
    await sandbox.files.write(marker, INSPECTOR_VERSION);
  } catch {
    // marker write failure is non-fatal; next call just re-runs bootstrap
  }
}
