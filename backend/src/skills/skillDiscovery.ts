import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { SkillManifest } from "./types";

const SKILLS_ROOT = path.join(__dirname);

// Cache: null = not yet scanned; [] = scanned but nothing found; [..] = populated.
// IMPORTANT: use `_cache !== null` checks, NOT `if (_cache)` — an empty array [] is
// truthy and would permanently lock out a retry when the first scan found nothing.
let _cache: SkillManifest[] | null = null;
let _scanPromise: Promise<SkillManifest[]> | null = null;

// Skills that exist only for tool/plumbing purposes and should never be
// surfaced to the LLM router as a selectable persona.
const NON_ROUTABLE_DIRS = new Set([
  "file_operations",
  "shell",
  "todo",
  "context",
  "database",
  "env",
  "memory",
  "package",
]);

export async function discoverSkills(): Promise<SkillManifest[]> {
  // Return cached result — but guard against the empty-array poisoning bug.
  // _cache !== null means "a scan completed". If it completed with [], that IS
  // the correct result (no skills deployed). Retry logic lives in clearSkillDiscoveryCache().
  if (_cache !== null) return _cache;

  // Deduplicate concurrent calls: return the in-flight scan promise.
  if (_scanPromise) return _scanPromise;

  _scanPromise = performDiscovery().catch((err) => {
    console.error(`[SKILL] discovery threw an unexpected error: ${err.message}`);
    return [] as SkillManifest[];
  }).finally(() => {
    _scanPromise = null;
  });

  return _scanPromise;
}

async function performDiscovery(): Promise<SkillManifest[]> {
  console.log(`[SKILL] discovery started. SKILLS_ROOT=${SKILLS_ROOT}`);

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (err: any) {
    console.error(`[SKILL] ❌ Cannot read SKILLS_ROOT (${SKILLS_ROOT}): ${err.message}`);
    console.error(`[SKILL] ❌ SKILL.md files may not have been copied to dist/. Run: npm run build`);
    _cache = [];
    return [];
  }

  console.log(`[SKILL] found ${entries.length} entries in SKILLS_ROOT`);

  const manifests: SkillManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip internal plumbing directories — they are not routable skill personas.
    if (NON_ROUTABLE_DIRS.has(entry.name)) {
      continue;
    }

    const skillMdPath = path.join(SKILLS_ROOT, entry.name, "SKILL.md");

    let raw: string;
    try {
      raw = await fs.readFile(skillMdPath, "utf8");
    } catch (err: any) {
      console.log(`[SKILL]   skip ${entry.name}: cannot read SKILL.md (${err.message})`);
      continue;
    }

    const { data, content } = matter(raw);

    if (!data.name || !data.description) {
      console.log(`[SKILL]   skip ${entry.name}: missing frontmatter name/description`);
      continue;
    }

    // Honor explicit routable: false in frontmatter metadata
    if (data.metadata?.routable === false) {
      console.log(`[SKILL]   skip ${entry.name}: marked as non-routable in frontmatter`);
      continue;
    }

    console.log(`[SKILL]   ✓ ${entry.name}: "${data.name}"`);
    manifests.push({
      name: data.name,
      description: data.description,
      directory: path.join(SKILLS_ROOT, entry.name),
      skillMdPath,
      metadata: data.metadata ?? undefined,
      hasPersona: content.trim().length > 0,
    });
  }

  if (manifests.length === 0) {
    console.error(
      `[SKILL] ❌ No skills discovered in ${SKILLS_ROOT}. ` +
      `Routable dirs checked: ${entries.filter(e => e.isDirectory() && !NON_ROUTABLE_DIRS.has(e.name)).map(e => e.name).join(", ")}. ` +
      `Ensure SKILL.md files are deployed to dist/ via npm run build.`
    );
  } else {
    console.log(`[SKILL] discovered ${manifests.length} skills: ${manifests.map((m) => m.name).join(", ")}`);
  }

  _cache = manifests;
  return manifests;
}

export function clearSkillDiscoveryCache(): void {
  _cache = null;
  _scanPromise = null;
}
