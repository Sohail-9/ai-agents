import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { SkillManifest } from "./types";

const _cache = new Map<string, string>();

export async function loadSkillPersona(manifest: SkillManifest, planMode?: boolean): Promise<string> {
  const cacheKey = planMode ? `${manifest.name}:plan` : manifest.name;
  const hit = _cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const raw = await fs.readFile(manifest.skillMdPath, "utf8");
  const { content } = matter(raw);
  let persona = content.trim();

  if (planMode) {
    persona = `<plan_mode_skill>\n${persona}\n\n---\nPLAN MODE CONSTRAINT:\nYou are in plan mode. Use this skill to STRUCTURE your planning, not to implement. Focus on architectural decisions, component design, data flow design, trade-off analysis, and strategic choices.\n\nDO NOT write code. DO NOT use implementation tools (edit_file, execute_shell, etc).\nYour output should be a markdown plan document with clear sections, decisions, and rationale.\n</plan_mode_skill>`;
  }

  const sizeKb = (Buffer.byteLength(persona, "utf8") / 1024).toFixed(1);
  console.log(`[SKILL] loading persona: skills/${path.basename(manifest.directory)}/SKILL.md (${sizeKb}kb)${planMode ? " [plan mode]" : ""}`);

  _cache.set(cacheKey, persona);
  return persona;
}

export function clearPersonaCache(): void {
  _cache.clear();
}
