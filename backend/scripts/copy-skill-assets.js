#!/usr/bin/env node
/**
 * copy-skill-assets.js
 *
 * Copies all SKILL.md files from src/skills/ into dist/src/skills/, preserving
 * the directory structure. This is required because `tsc` only emits .js files
 * and does NOT copy non-TypeScript assets.
 *
 * Why not `shx cp -r src/skills dist/src/skills`?
 * When dist/src/skills/ already exists, `cp -r src dst` copies the SOURCE
 * directory AS A CHILD of dst, producing dst/skills/architect/SKILL.md instead
 * of dst/architect/SKILL.md. This script copies files individually and is
 * therefore idempotent regardless of whether the destination exists.
 */

const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.join(__dirname, "..", "src", "skills");
const DST_ROOT = path.join(__dirname, "..", "dist", "src", "skills");
const ASSET_FILENAME = "SKILL.md";

let copied = 0;
let errors = 0;

function copySkillAssets(srcDir, dstDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      copySkillAssets(srcPath, dstPath);
    } else if (entry.name === ASSET_FILENAME) {
      try {
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        console.log(`  ✓ copied ${path.relative(path.join(__dirname, ".."), srcPath)}`);
        copied++;
      } catch (err) {
        console.error(`  ✗ failed to copy ${srcPath}: ${err.message}`);
        errors++;
      }
    }
  }
}

console.log(`[copy-skill-assets] Copying ${ASSET_FILENAME} files from src/ → dist/...`);
console.log(`  src: ${SRC_ROOT}`);
console.log(`  dst: ${DST_ROOT}`);

try {
  copySkillAssets(SRC_ROOT, DST_ROOT);
  console.log(`[copy-skill-assets] Done. Copied ${copied} file(s). Errors: ${errors}`);
  if (errors > 0) {
    process.exit(1);
  }
} catch (err) {
  console.error(`[copy-skill-assets] Fatal: ${err.message}`);
  process.exit(1);
}
