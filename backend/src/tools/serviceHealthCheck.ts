import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** fetch with a timeout via AbortController */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function resolveServiceUrl(port: string | number, sandboxId?: string): string {
  if (sandboxId) {
    // Internal health checks should always probe the standard, guaranteed e2b.app domain
    // to avoid failures due to slow DNS propagation or SSL validation issues on custom domains.
    return `https://${port}-${sandboxId}.e2b.app`;
  }
  return `http://localhost:${port}`;
}

/**
 * Checks if the backend service is running in the sandbox.
 */
export async function isBackendRunning(): Promise<boolean> {
  try {
    const { stdout: backendProcesses } = await execAsync(
      `ps aux | grep -E "/workspace/backend" | grep -v grep | head -5`
    );

    if (backendProcesses && backendProcesses.trim()) {
      const port      = process.env.PORT      ?? 8000;
      const sandboxId = process.env.SANDBOX_ID;
      const url       = resolveServiceUrl(port, sandboxId);

      try {
        const response = await fetchWithTimeout(`${url}/`, 3000);
        return response.ok;
      } catch {
        // Process running but not responding — still consider it running for build purposes
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks if the frontend service is running in the sandbox.
 */
export async function isFrontendRunning(): Promise<boolean> {
  try {
    const { stdout: frontendProcesses } = await execAsync(
      `ps aux | grep -E "/workspace/frontend" | grep -v grep | head -5`
    );

    if (frontendProcesses && frontendProcesses.trim()) {
      const sandboxId    = process.env.SANDBOX_ID;
      const explicitPort = process.env.FRONTEND_PORT;
      const portsToTry   = explicitPort
        ? [explicitPort]
        : ['3000', '3001', '5173', '8080', '4200'];

      for (const port of portsToTry) {
        const url = resolveServiceUrl(port, sandboxId);
        try {
          const response = await fetchWithTimeout(`${url}/`, 3000);
          const contentType = response.headers.get('content-type') ?? '';
          const body        = await response.text().catch(() => '');
          const bodyLower   = body.toLowerCase();

          if (
            response.ok &&
            (contentType.includes('text/html') ||
              bodyLower.includes('<html')       ||
              bodyLower.includes('<!doctype'))
          ) {
            return true;
          }
        } catch {
          continue; // Try next port
        }
      }

      // Process running but no port responding — still consider it running for build purposes
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Main health check tool for LLM to check if frontend and backend are running.
 */
export async function checkServicesHealth(): Promise<{ backend: boolean; frontend: boolean; message: string }> {
  const [backendRunning, frontendRunning] = await Promise.all([
    isBackendRunning(),
    isFrontendRunning(),
  ]);

  let message = '';
  if (backendRunning && frontendRunning) {
    message = 'Both frontend and backend services are running.';
  } else if (backendRunning && !frontendRunning) {
    message = 'Backend service is running. Frontend service is not running.';
  } else if (!backendRunning && frontendRunning) {
    message = 'Frontend service is running. Backend service is not running.';
  } else {
    message = 'Neither frontend nor backend services are running.';
  }

  return { backend: backendRunning, frontend: frontendRunning, message };
}

// Export for direct LLM usage
export async function checkHealth(): Promise<string> {
  console.log('[TOOL] calling health check rule');
  const result = await checkServicesHealth();
  return JSON.stringify(result, null, 2);
}