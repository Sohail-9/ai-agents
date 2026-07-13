import { PostHog } from "posthog-node";

/**
 * PostHog server-side analytics client.
 *
 * Configure with POSTHOG_API_KEY (project API key) and optional POSTHOG_HOST.
 * If POSTHOG_API_KEY is not set, analytics becomes a no-op so local/dev
 * environments continue to work without the key.
 */

const apiKey = process.env.POSTHOG_API_KEY;
const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

let client: PostHog | null = null;

if (apiKey) {
  client = new PostHog(apiKey, {
    host,
    // Batch events but don't sit too long — this is a long-running server.
    flushAt: 20,
    flushInterval: 10_000,
  });
  console.log(`[posthog] initialized (host=${host})`);
} else {
  console.log("[posthog] POSTHOG_API_KEY not set — server analytics disabled");
}

export const posthog = client;

type Properties = Record<string, unknown>;

/**
 * Capture a server-side event. Safe to call even when PostHog isn't configured.
 * Does not throw; logs errors and moves on.
 */
export function capture(params: {
  distinctId: string;
  event: string;
  properties?: Properties;
  groups?: Record<string, string>;
}): void {
  if (!client) return;
  try {
    client.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
      groups: params.groups,
    });
  } catch (err) {
    console.error("[posthog] capture failed:", err);
  }
}

/**
 * Identify / update a user's person properties from the server.
 */
export function identify(params: {
  distinctId: string;
  properties?: Properties;
}): void {
  if (!client) return;
  try {
    client.identify({
      distinctId: params.distinctId,
      properties: params.properties,
    });
  } catch (err) {
    console.error("[posthog] identify failed:", err);
  }
}

/**
 * Capture a server-side exception. Useful inside try/catch blocks.
 */
export function captureException(
  error: unknown,
  distinctId?: string,
  extra?: Properties
): void {
  if (!client) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    client.captureException(err, distinctId, extra);
  } catch (err) {
    console.error("[posthog] captureException failed:", err);
  }
}

/**
 * Flush pending events and shut down the client cleanly.
 * Call on SIGINT/SIGTERM and on server close.
 *
 * Note: posthog-node exposes the async implementation as `_shutdown()`
 * (returns Promise<void>). The `shutdown()` method on the IPostHog interface
 * is typed as void, so we use the async one here to guarantee events are
 * flushed before the process exits.
 */
export async function shutdownPostHog(): Promise<void> {
  if (!client) return;
  try {
    await client._shutdown();
  } catch (err) {
    console.error("[posthog] shutdown failed:", err);
  }
}
