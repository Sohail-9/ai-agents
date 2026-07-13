import { Sandbox } from "@e2b/code-interpreter";
import { ExecuteShellParams, ToolResult } from "../types";

export async function execute_shell(params: ExecuteShellParams, signal?: AbortSignal): Promise<ToolResult> {
  const { command: rawCommand, sandboxId, timeout_seconds = 120, background = false } = params;
  
  if (signal?.aborted) {
    return { success: false, error: "Command aborted by user." };
  }
  
  // Sanitize command: Agent often hallucinates --timeout 600 in the shell string
  const command = rawCommand.replace(/\s--timeout\s+\d+/g, '').trim();

  console.log(`[execute_shell] sandbox=${sandboxId} cmd=${command} bg=${background}`);

  try {
    const sandbox = await Sandbox.connect(sandboxId);

    if (background) {
      const proc = await sandbox.commands.run(command, {
        background: true,
        cwd: "/workspace"
      });
      console.log(`[execute_shell] background proc started. pid=${proc.pid}`);

      // Wait 8s — Next.js/Vite need 8-15s to fully initialize and open their port.
      // 2s was too short: the process appeared "ALIVE" but had not bound its port yet.
      await new Promise(r => setTimeout(r, 8000));
      const checkAlive = await sandbox.commands.run(`if kill -0 ${proc.pid} 2>/dev/null; then echo "ALIVE"; else echo "DEAD"; fi`);
      const isAlive = checkAlive.stdout.trim() === "ALIVE";

      if (!isAlive) {
        console.warn(`[execute_shell] background proc ${proc.pid} crashed after startup.`);
        // Collect startup logs from multiple possible locations
        const fallbackLogs = await sandbox.commands.run(
          `tail -n 30 /tmp/server-${proc.pid}.log 2>/dev/null || ` +
          `tail -n 20 ~/.npm/_logs/*-debug-0.log 2>/dev/null || ` +
          `echo "No startup logs found. Process exited during initialization."`
        );
        return {
          success: true, // true so LLM reads & acts on the output
          output: `Command failed! The background process crashed during startup.\n[Crash Details]:\n${fallbackLogs.stdout?.trim() || 'Unknown error'}\n[action]: Read the error, fix the issue, and restart the server.`
        };
      }

      return {
        success: true,
        output: `Command started successfully in background. pid: ${proc.pid}\n[note]: Server had 8s to initialize. Call check_health to verify it is actually listening on the expected port.`
      };
    }

    const result = await sandbox.commands.run(command, {
      timeoutMs: timeout_seconds * 1000,
      cwd: "/workspace"
    });

    const exit_code = result.exitCode ?? 0;
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();

    // Build a clear output for the LLM
    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n" : "") + `[stderr]: ${stderr}`;
    if (!output) output = exit_code === 0 ? "Done." : `Command exited with code ${exit_code}`;
    output += `\n[exit_code]: ${exit_code}`;

    console.log(`[execute_shell] exit_code=${exit_code}`);

    // Return success: true for all sandbox-executed commands.
    // Non-zero exit codes are normal (grep no match, test -f, etc.)
    // The LLM reads exit_code from output to decide next steps.
    return { success: true, output };
  } catch (err: any) {
    // E2B throws CommandExitError for non-zero exit codes
    if (err.name === 'CommandExitError' || err.exitCode !== undefined) {
      const exit_code = err.exitCode ?? 1;
      const stdout = (err.stdout ?? "").trim();
      const stderr = (err.stderr ?? "").trim();

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + `[stderr]: ${stderr}`;
      if (!output) output = `Command exited with code ${exit_code}`;
      output += `\n[exit_code]: ${exit_code}`;

      console.log(`[execute_shell] caught CommandExitError exit_code=${exit_code}`);
      return { success: true, output };
    }

    // Only actual infrastructure failures (sandbox down, timeout exception, network)
    console.error(`[execute_shell] infra error:`, err.message);
    const finalError = err.message;
    if (finalError.includes("deadline_exceeded")) {
      return { 
        success: false, 
        error: `Infrastructure Timeout: The command took too long (> ${timeout_seconds}s). 
IMPORTANT: For long-running processes like 'npm install' or 'npm run dev', you MUST use 'background: true' or increase 'timeout_seconds' (max 600). Do NOT use shell '&' for backgrounding; use the 'background: true' parameter instead.` 
      };
    }
    return { success: false, error: finalError };
  }
}
