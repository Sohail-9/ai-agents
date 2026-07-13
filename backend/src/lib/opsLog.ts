/**
 * One-line JSON logs for dashboards / CloudWatch metric filters (Batch 1 observability).
 * Never pass secrets (tokens, env blobs, clone URLs with credentials).
 */
export function logOpsEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    svc: "prettiflow-core",
    event,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) payload[k] = v;
  }
  console.log(JSON.stringify(payload));
}
