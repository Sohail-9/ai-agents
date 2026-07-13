import { Sandbox } from "@e2b/code-interpreter";
import { ToolResult } from "../types";

export interface CheckHealthParams {
  sandboxId: string;
  port: number;
  /** How long to wait for a TCP bind before giving up (ms). Default: 5000 */
  timeoutMs?: number;
  run_build?: boolean;
}

/**
 * check_health — verifies that a port is actually listening AND accessible
 * through the E2B proxy (i.e. bound to 0.0.0.0 or IPv6 wildcard).
 *
 * Returns detailed diagnostics so the agent can decide what to do next.
 */
export async function check_health(params: CheckHealthParams, _signal?: AbortSignal): Promise<ToolResult> {
  const { sandboxId, port, timeoutMs = 5000 } = params;

  if (!sandboxId) return { success: false, error: "sandboxId is required for check_health" };
  if (!port || port <= 0 || port > 65535) return { success: false, error: `Invalid port: ${port}` };

  try {
    const sandbox = await Sandbox.connect(sandboxId);

    // 1. Is anything listening on this port at all?
    const anyCheck = await sandbox.commands.run(`ss -tlpn | grep ":${port} "`);
    if (anyCheck.exitCode !== 0 || !anyCheck.stdout.trim()) {
      return {
        success: true,
        output: `HEALTH_FAIL: Nothing is listening on port ${port}. The server has not started yet or has crashed.\n[action]: Start the dev server once, then re-run check_health. Do NOT loop restarts.`
      };
    }

    const ssOutput = anyCheck.stdout.trim();

    // 2. Is it bound to a public interface (0.0.0.0 or IPv6 wildcard)?
    const publicCheck = await sandbox.commands.run(
      `ss -tlpn | grep -E "0\\.0\\.0\\.0:${port}|\\*:${port}|\\[::\\]:${port}|:::${port}"`
    );
    const isPublic = publicCheck.exitCode === 0 && publicCheck.stdout.trim().length > 0;

    if (!isPublic) {
      return {
        success: true,
        output: `HEALTH_FAIL: Port ${port} is listening but ONLY on localhost/127.0.0.1 — NOT on 0.0.0.0. The E2B proxy cannot reach it.\n[ss output]: ${ssOutput}\n[action]: Restart the server with -H 0.0.0.0 (Next.js) or --host 0.0.0.0 (Vite) to bind it to the public interface.`
      };
    }

    // 3. Quick HTTP reachability check via localhost
    const curlResult = await sandbox.commands.run(
      `curl -s -o /dev/null -w "%{http_code}" --max-time ${Math.ceil(timeoutMs / 1000)} http://localhost:${port}/`
    );
    const httpCode = curlResult.stdout.trim();
    const httpOk = /^[123]/.test(httpCode); // 1xx, 2xx, 3xx are fine

    if (!httpOk) {
      return {
        success: true,
        output: `HEALTH_PARTIAL: Port ${port} is listening on 0.0.0.0 but HTTP returned code "${httpCode || "timeout"}". The server may still be starting up.\n[ss output]: ${ssOutput}\n[action]: Wait a few more seconds and call check_health again.`
      };
    }

    const previewUrl = `https://${port}-${sandboxId}.e2b.app`;

    if (params.run_build) {
      const buildDir = port === 8000 ? "/workspace/backend" : "/workspace/frontend";

      // next dev regenerates next-env.d.ts as root after normalization runs.
      // Fix it here unconditionally so npm run build doesn't fail with EACCES.
      await sandbox.commands.run(
        `sudo chown "$(id -un):$(id -gn)" ${buildDir}/next-env.d.ts 2>/dev/null; exit 0`
      ).catch(() => {});

      let buildStdout = "";
      let buildExitCode = 0;

      try {
        const buildResult = await sandbox.commands.run(
          `cd ${buildDir} && npm run build 2>&1`,
          { timeoutMs: 180_000 }
        );
        buildStdout = (buildResult.stdout ?? "").trim();
        buildExitCode = buildResult.exitCode ?? 0;
      } catch (buildErr: any) {
        // E2B throws CommandExitError on non-zero exit — same pattern as execute_shell.ts
        if (buildErr.name === 'CommandExitError' || buildErr.exitCode !== undefined) {
          buildStdout = [(buildErr.stdout ?? "").trim(), (buildErr.stderr ?? "").trim()].filter(Boolean).join("\n");
          buildExitCode = buildErr.exitCode ?? 1;
        } else {
          throw buildErr; // real infra failure — let outer catch handle
        }
      }

      const errorLines = buildStdout
        .split("\n")
        .filter(l => /error(\s+TS\d+)?:|Error:/i.test(l))
        .join("\n")
        .trim();

      const buildOk = buildExitCode === 0;
      const buildErrorSummary = (errorLines || buildStdout).slice(0, 3000).trim();
      const buildSection = buildOk
        ? `BUILD_OK: No TypeScript or lint errors found.`
        : `BUILD_ERRORS:\n${buildErrorSummary}\n[action]: Fix the build errors above before marking this task complete.`;
      return {
        success: true,
        output: `HEALTH_OK: Port ${port} is UP, bound to 0.0.0.0, and responding HTTP ${httpCode}.\nPreview URL: ${previewUrl}\n${buildSection}\n[action]: ${buildOk ? `You may now output FINAL ANSWER FRONTEND=${port}` : "Fix TypeScript errors first, then output FINAL ANSWER."}`
      };
    }

    return {
      success: true,
      output: `HEALTH_OK: Port ${port} is UP, bound to 0.0.0.0, and responding HTTP ${httpCode}.\nPreview URL: ${previewUrl}\n[action]: You may now output FINAL ANSWER FRONTEND=${port}`
    };

  } catch (err: any) {
    console.error(`[check_health] Error:`, err.message);
    return { success: false, error: `check_health failed: ${err.message}` };
  }
}
