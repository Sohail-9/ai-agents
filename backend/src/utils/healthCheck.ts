import { HealthCheckResult } from '../types/health';

/**
 * Resolves the base URL for a service.
 *
 * In an E2B sandbox every port is exposed at:
 *   https://{port}-{sandboxId}.e2b.app
 *
 * When SANDBOX_ID is not set (local dev) we fall back to:
 *   http://localhost:{port}
 */
function resolveServiceUrl(port: string | number, sandboxId?: string): string {
  if (sandboxId) {
    return `https://${port}-${sandboxId}.e2b.app`;
  }
  return `http://localhost:${port}`;
}

/** fetch with a timeout using AbortController */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the health of the backend service.
 *
 * Reads PORT (default 8000) and SANDBOX_ID from the environment, or accepts
 * them as explicit parameters so the caller can override if needed.
 */
export async function checkBackendHealth(
  port?: string | number,
  sandboxId?: string,
): Promise<HealthCheckResult> {
  const resolvedPort      = port      ?? process.env.PORT      ?? 8000;
  const resolvedSandboxId = sandboxId ?? process.env.SANDBOX_ID;

  const baseUrl = resolveServiceUrl(resolvedPort, resolvedSandboxId);

  try {
    const response = await fetchWithTimeout(`${baseUrl}/`, 7000);

    if (response.ok) {
      return {
        service: 'backend',
        status: 'healthy',
        details: `Backend is reachable at ${baseUrl} (port ${resolvedPort})`,
        timestamp: new Date(),
      };
    }

    return {
      service: 'backend',
      status: 'unhealthy',
      details: `Backend at ${baseUrl} responded with HTTP ${response.status}`,
      timestamp: new Date(),
    };
  } catch (error: any) {
    return {
      service: 'backend',
      status: 'unhealthy',
      details: `Backend at ${baseUrl} is not reachable: ${error.message}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Checks the health of the frontend service.
 *
 * Reads FRONTEND_PORT (default 3000) and SANDBOX_ID from the environment, or
 * accepts them as explicit parameters so the caller can override if needed.
 */
export async function checkFrontendHealth(
  port?: string | number,
  sandboxId?: string,
): Promise<HealthCheckResult> {
  const resolvedPort      = port      ?? process.env.FRONTEND_PORT ?? 3000;
  const resolvedSandboxId = sandboxId ?? process.env.SANDBOX_ID;

  const baseUrl = resolveServiceUrl(resolvedPort, resolvedSandboxId);

  try {
    const response = await fetchWithTimeout(`${baseUrl}/`, 7000);
    const contentType = response.headers.get('content-type') ?? '';
    const body        = await response.text().catch(() => '');
    const bodyLower   = body.toLowerCase();

    const isFrontend =
      contentType.includes('text/html') ||
      bodyLower.includes('<html')       ||
      bodyLower.includes('<!doctype')   ||
      bodyLower.includes('<head')       ||
      bodyLower.includes('<body')       ||
      bodyLower.includes('react')       ||
      bodyLower.includes('vue')         ||
      bodyLower.includes('angular')     ||
      bodyLower.includes('next');

    if (response.ok && isFrontend) {
      return {
        service: 'frontend',
        status: 'healthy',
        details: `Frontend is reachable at ${baseUrl} (port ${resolvedPort})`,
        timestamp: new Date(),
      };
    }

    return {
      service: 'frontend',
      status: 'unhealthy',
      details: `Frontend at ${baseUrl} responded with HTTP ${response.status} but content did not look like a frontend app`,
      timestamp: new Date(),
    };
  } catch (error: any) {
    return {
      service: 'frontend',
      status: 'unhealthy',
      details: `Frontend at ${baseUrl} is not reachable: ${error.message}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Runs a comprehensive health check for both backend and frontend.
 */
export async function checkOverallHealth(): Promise<HealthCheckResult[]> {
  const [backendResult, frontendResult] = await Promise.all([
    checkBackendHealth(),
    checkFrontendHealth(),
  ]);

  return [backendResult, frontendResult];
}

/**
 * Provides a human-readable summary of health check results.
 */
export function getHealthSummary(results: HealthCheckResult[]): string {
  const healthyCount   = results.filter(r => r.status === 'healthy').length;
  const unhealthyCount = results.filter(r => r.status === 'unhealthy').length;
  const unknownCount   = results.filter(r => r.status === 'unknown').length;

  let summary = `Health Check Summary:\n`;
  summary += `- Total services checked: ${results.length}\n`;
  summary += `- Healthy:   ${healthyCount}\n`;
  summary += `- Unhealthy: ${unhealthyCount}\n`;
  summary += `- Unknown:   ${unknownCount}\n\n`;

  for (const result of results) {
    summary += `${result.service}: ${result.status.toUpperCase()}${result.details ? ` — ${result.details}` : ''}\n`;
  }

  return summary;
}