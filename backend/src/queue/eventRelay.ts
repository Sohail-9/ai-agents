/**
 * eventRelay.ts
 *
 * Subscribes to the Redis pub/sub channel pattern `ws-events:*`.
 * Workers publish serialised WS events here; this relay forwards them
 * to every WebSocket connection associated with that workspaceId.
 *
 * Usage:
 *   const relay = new EventRelay(broadcastFn);
 *   await relay.start();
 *   // later on shutdown:
 *   await relay.stop();
 */

import IORedis from "ioredis";

export type BroadcastFn = (workspaceId: string, event: unknown) => void;

export class EventRelay {
  private subscriber: IORedis;
  private broadcast: BroadcastFn;
  private started = false;

  constructor(broadcast: BroadcastFn) {
    // Dedicated subscriber connection — psubscribe() puts the connection
    // into subscriber mode so it cannot be shared with queue commands.
    this.subscriber = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
      lazyConnect: true,
    });
    this.broadcast = broadcast;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    await this.subscriber.connect();

    // Channel pattern: ws-events:{workspaceId}
    await this.subscriber.psubscribe("ws-events:*");

    this.subscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        // channel = "ws-events:{workspaceId}"
        const workspaceId = channel.slice("ws-events:".length);
        if (!workspaceId) return;

        const event = JSON.parse(message);
        this.broadcast(workspaceId, event);
      } catch (err) {
        console.error("[EventRelay] Failed to relay message:", err);
      }
    });

    console.log("[EventRelay] Subscribed to ws-events:* channel pattern");
  }

  async stop() {
    await this.subscriber.punsubscribe("ws-events:*");
    await this.subscriber.quit();
    console.log("[EventRelay] Stopped.");
  }
}

// ── Helper used by workers to publish events ──────────────────────────────
import { redisConnection } from "./connection";

/**
 * Workers call this instead of socket.send() — the relay picks it up
 * and forwards it to every connected client for the workspace.
 */
export async function publishWsEvent(workspaceId: string, event: unknown) {
  await redisConnection.publish(
    `ws-events:${workspaceId}`,
    JSON.stringify(event),
  );
}
