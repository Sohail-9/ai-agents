import { checkHealth as checkServicesHealth } from './serviceHealthCheck';

/**
 * Tool to check the health of both frontend and backend services
 * This replaces LLM-dependent executable commands with a dedicated health check tool
 */
export async function checkHealth(): Promise<string> {
  try {
    // Use the service-focused health check
    return await checkServicesHealth();
  } catch (error) {
    return `Health check failed: ${(error as Error).message}`;
  }
}

// If this script is run directly, execute the health check
if (require.main === module) {
  checkHealth()
    .then(result => {
      console.log(result);
    })
    .catch(error => {
      console.error('Health check error:', error);
    });
}