// Type definitions for health check results
export interface HealthCheckResult {
  service: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  details?: string;
  timestamp: Date;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'error';
  timestamp: Date;
  services: HealthCheckResult[];
  summary: string;
  message?: string;
  error?: string;
}