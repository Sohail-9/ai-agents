/**
 * @module sandboxNormalizer
 * @description Ensures sandbox files have correct ownership/permissions before agent execution.
 *
 * Problem: Sandbox files are often owned by root, but agent runs as unprivileged user.
 * This causes EACCES errors on npm install, file writes, dependency updates.
 *
 * Solution: Run normalization once per sandbox resumption to fix ownership.
 */

import { Sandbox } from "@e2b/code-interpreter";

interface NormalizeResult {
  success: boolean;
  message: string;
  fixedCount?: number;
}

export class SandboxNormalizer {
  /**
   * Normalize sandbox file ownership to current user.
   * Detects current user, then chowns all /workspace files to that user.
   */
  static async normalizeOwnership(sandbox: Sandbox): Promise<NormalizeResult> {
    try {
      console.log(`[SandboxNormalizer] Checking file ownership in sandbox...`);

      // Single round trip: detect user + owner, fix only if needed.
      // Excludes node_modules from chown — those files only need read access
      // and chown-ing thousands of npm files adds 5-15s of unnecessary latency.
      const result = await sandbox.commands.run(
        `U=$(whoami); O=$(stat -c %U /workspace 2>/dev/null || stat -f %Su /workspace 2>/dev/null); ` +
        `if [ "$U" = "$O" ]; then echo "ok:$U"; else ` +
        `sudo chown "$U:$U" /workspace /workspace/frontend /workspace/backend /workspace/Prettiflow.md 2>/dev/null; ` +
        `sudo chown -R "$U:$U" /workspace/frontend/app /workspace/frontend/components /workspace/frontend/lib /workspace/frontend/public /workspace/frontend/.next 2>/dev/null; ` +
        `sudo chown -R "$U:$U" /workspace/backend/src /workspace/backend/prisma 2>/dev/null; ` +
        `echo "fixed:$U"; fi; ` +
        `sudo chown "$U:$U" /workspace/frontend/next-env.d.ts 2>/dev/null; true`,
        { timeoutMs: 15_000 },
      );

      const out = result.stdout.trim();
      if (out.startsWith("ok:")) {
        const user = out.slice(3);
        console.log(`[SandboxNormalizer] ✅ /workspace already owned by ${user}. Skipping.`);
        return { success: true, message: `Already owned by ${user}` };
      }
      if (out.startsWith("fixed:")) {
        const user = out.slice(6);
        console.log(`[SandboxNormalizer] ✅ Fixed ownership to ${user}`);
        return { success: true, message: `Fixed ownership to ${user}` };
      }

      console.warn(`[SandboxNormalizer] ⚠️ Unexpected output: ${out}. stderr: ${result.stderr}`);
      return { success: false, message: `Unexpected output: ${out}` };
    } catch (err: any) {
      console.error(`[SandboxNormalizer] Normalization failed:`, err.message);
      return { success: false, message: `Normalization error: ${err.message}` };
    }
  }

  /**
   * Verify that /workspace is writable by current user.
   * Useful for debugging permission issues.
   */
  static async verifyWriteAccess(sandbox: Sandbox): Promise<boolean> {
    try {
      const testResult = await sandbox.commands.run(
        `touch /workspace/.write-test-$RANDOM && rm /workspace/.write-test-* 2>/dev/null; echo "ok"`,
      );
      return testResult.stdout.includes("ok");
    } catch {
      return false;
    }
  }
}
