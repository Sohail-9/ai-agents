import "./env";

import { startServer } from "./server";
import { WebSocketManager } from "./ws/WSManager";
import { shutdownPostHog } from "./lib/posthog";
import { skillRegistry } from "./lib/skill-registry";

async function main() {
  const PORT = process.env.PORT || 8000;
  const { server } = await startServer(Number(PORT));
  const wsManager = new WebSocketManager(server);

  console.log("Express + WebSocket server ready.");

  // pretti-memory connection check
  const prettiMemoryUrl = process.env.PRETTI_MEMORY_BASE_URL || "http://localhost:8080";
  const prettiMemoryKey = process.env.PRETTI_MEMORY_API_KEY;
  const prettiMemoryEnabled = process.env.PRETTI_MEMORY_ENABLED?.toLowerCase();
  const isEnabled = prettiMemoryEnabled !== "false" && prettiMemoryEnabled !== "0" && !!prettiMemoryKey;

  if (!isEnabled) {
    console.log("[pretti-memory] ⚠️  disabled (PRETTI_MEMORY_ENABLED not set or no key)");
  } else {
    try {
      const res = await fetch(`${prettiMemoryUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[pretti-memory] ✅ connected → ${prettiMemoryUrl}`);
      } else {
        console.log(`[pretti-memory] ⚠️  reachable but returned ${res.status} → ${prettiMemoryUrl}`);
      }
    } catch (err) {
      console.error(`[pretti-memory] ❌ unreachable → ${prettiMemoryUrl} — ${(err as Error).message}`);
    }
  }

  console.log("[SKILL REGISTRY]");
  // Load Skills
  await skillRegistry.loadSkills();
  // Get Skills
  const skillArray = await skillRegistry.getAllSkills();

  server.on("close", () => {
    wsManager.closeBridge();
    console.log("Server shutdown complete.");
  });

  // Graceful shutdown — flush PostHog events before exit
  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      await shutdownPostHog();
    } finally {
      server.close(() => process.exit(0));
      // Fallback: hard exit if close hangs
      setTimeout(() => process.exit(0), 5_000).unref();
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Unexpected error while starting the server:", error);
  process.exit(1);
});
