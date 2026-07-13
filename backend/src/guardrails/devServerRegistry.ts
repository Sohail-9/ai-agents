/**
 * Dev server port registry backed by Redis.
 * Tracks which ports have dev servers running across agent runs.
 * Survives agent restarts within same workspace.
 */

import { createRedisConnection } from "../queue/connection";

const redis = createRedisConnection("devserver");

function portSetKey(workspaceId: string): string {
  return `devserver:ports:${workspaceId}`;
}

export async function registerPort(workspaceId: string, port: number): Promise<void> {
  try {
    const key = portSetKey(workspaceId);
    await redis.sadd(key, port.toString());
    await redis.expire(key, 86400); // 24h TTL
    console.log(`[DevServerRegistry] Registered port ${port} for workspace ${workspaceId}`);
  } catch (err: any) {
    console.warn(`[DevServerRegistry] Failed to register port: ${err.message}`);
  }
}

export async function isPortRegistered(workspaceId: string, port: number): Promise<boolean> {
  try {
    const key = portSetKey(workspaceId);
    const isMember = await redis.sismember(key, port.toString());
    return isMember === 1;
  } catch (err: any) {
    console.warn(`[DevServerRegistry] Failed to check port: ${err.message}`);
    return false;
  }
}

export async function loadRegisteredPorts(workspaceId: string): Promise<Set<number>> {
  try {
    const key = portSetKey(workspaceId);
    const ports = await redis.smembers(key);
    return new Set(ports.map(p => parseInt(p, 10)));
  } catch (err: any) {
    console.warn(`[DevServerRegistry] Failed to load ports: ${err.message}`);
    return new Set();
  }
}

export async function clearPorts(workspaceId: string): Promise<void> {
  try {
    const key = portSetKey(workspaceId);
    await redis.del(key);
    console.log(`[DevServerRegistry] Cleared all ports for workspace ${workspaceId}`);
  } catch (err: any) {
    console.warn(`[DevServerRegistry] Failed to clear ports: ${err.message}`);
  }
}
