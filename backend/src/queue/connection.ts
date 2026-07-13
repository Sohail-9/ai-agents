import "../env";
import IORedis from "ioredis";

// Factory — every BullMQ Worker / EventRelay / blocking consumer must own its
// IORedis client. BullMQ's BRPOPLPUSH puts the connection in blocking mode,
// which would serialize fetches across consumers if shared (the root cause of
// the "job sits in queue before pickup" symptom).
export function createRedisConnection(label = "redis"): IORedis {
  const client = new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,       // Upstash does not support PING on boot
    tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
    lazyConnect: true,
  });
  client.on("connect", () => console.log(`[Redis:${label}] Connected`));
  client.on("error",   (e) => console.error(`[Redis:${label}] Error:`, e.message));
  return client;
}

// Singleton used only for non-blocking commands: queue.add (LPUSH),
// publishWsEvent (PUBLISH), abort-flag get/del. Never used by a Worker.
export const redisConnection = createRedisConnection("shared");
