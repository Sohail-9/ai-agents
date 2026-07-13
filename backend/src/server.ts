import express from "express";
import http from "http";
import apiRouter from "./routes";
import webhooksRouter from "./routes/webhooks";
import authProxyRouter from "./routes/authProxy";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { rateLimiter } from "./middleware/rateLimiter";
import { chatRouter, modelsRouter } from "./routes/v1/chat";
import { messagesRouter } from "./routes/v1/messages";
import { checkOverallHealth, getHealthSummary } from "./utils/healthCheck";
import cors from "cors";

export async function startServer(port = 8000) {
  const app = express();
  const server = http.createServer(app);

  // ── CORS ──
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    "https://demo.ai-agents.com",
  ].filter(Boolean) as string[];

  const isAllowedOrigin = (origin: string) => {
    const normalizedOrigin = origin.replace(/\/$/, "");

    if (
      allowedOrigins.some(
        (allowedOrigin) =>
          allowedOrigin.replace(/\/$/, "") === normalizedOrigin,
      )
    ) {
      return true;
    }

    try {
      const parsed = new URL(normalizedOrigin);
      const e2bDomain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
      return (
        parsed.protocol === "https:" &&
        (parsed.hostname.endsWith(".e2b.app") ||
          parsed.hostname.endsWith(`.${e2bDomain}`))
      );
    } catch {
      return false;
    }
  };

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps/curl)
        if (!origin) return callback(null, true);

        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          // For development, you might want to log this
          console.warn(`Origin ${origin} not allowed by CORS`);
          callback(new Error("Not allowed by CORS"));
        }
      },
      // credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-clerk-user-id",
        "x-admin-token",
      ],
    }),
  );

  // ── Webhooks (Must be before express.json() for raw body) ──
  app.use("/api/webhooks", webhooksRouter);

  // ── Body parsing ──
  // LLM inference plane accepts large bodies (Claude Code sends big system +
  // tools + history payloads). During /compact, Claude Code can serialize a
  // request larger than 32 MB before its media-stripping retry. Capping the
  // local adapter at exactly 32 MB makes both attempts fail in Express and the
  // client misleadingly reports "attached media exceeds size limits". Leave
  // headroom for that client-side representation; provider limits are enforced
  // by the upstream API. Everything else remains capped at 2 MB.
  const bigJson = express.json({ limit: "64mb" });
  app.use("/api/v1/chat", bigJson);
  app.use("/api/v1/messages", bigJson);
  app.use("/api/v1/v1/messages", bigJson);
  app.use(express.json({ limit: "2mb" }));

  // ── Health check ──
  app.get("/", (_, res) => {
    res.send("AI Agents backend is running.");
  });

  // ── Comprehensive health check ──
  app.get("/health", async (req, res) => {
    try {
      const results = await checkOverallHealth();
      const summary = getHealthSummary(results);

      // Return detailed results as JSON
      res.json({
        status: results.some((r) => r.status === "unhealthy")
          ? "unhealthy"
          : "healthy",
        timestamp: new Date(),
        services: results,
        summary,
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        message: "Health check failed",
        error: (error as Error).message,
      });
    }
  });

  // ── Auth passthrough proxy (CLI → backend → auth service) ──
  // Mounted before apiRouter so it bypasses the global requireAuth; auth
  // endpoints are mostly unauthenticated and the auth service does verification.
  app.use("/api/auth", authProxyRouter);
  // Google CLI login: start/status polling AND the browser legs (authorize +
  // callback). Proxying authorize+callback keeps the auth service private — the
  // browser and Google only ever reach this backend, which forwards upstream.
  // The auth service must set APP_BASE_URL to this backend's public URL so the
  // `authUrl` it mints (and Google's redirect_uri) point here, not at itself.
  app.use("/api/oauth/google/cli", authProxyRouter);
  app.use("/api/oauth/google/authorize", authProxyRouter);
  app.use("/api/oauth/google/callback", authProxyRouter);

  // ── Router inference plane (API-key auth, mounted BEFORE global requireAuth) ──
  // Scoped to the OpenAI-compatible inference paths only so it does NOT shadow
  // the JWT-protected /api/v1/keys and /api/v1/usage under apiRouter.
  app.use("/api/v1/chat", apiKeyAuth, rateLimiter, chatRouter);
  app.use("/api/v1/models", apiKeyAuth, rateLimiter, modelsRouter);
  // Anthropic-native Messages endpoint (Claude Code / Anthropic SDK drop-in).
  // The Anthropic SDK appends `/v1/messages` to ANTHROPIC_BASE_URL itself, so
  // the documented base is https://<host>/api (→ /api/v1/messages here). The
  // second mount is a compat alias for users who reuse the OpenAI base URL
  // (…/api/v1): the SDK then requests /api/v1/v1/messages, which lands here too.
  app.use("/api/v1/messages", apiKeyAuth, rateLimiter, messagesRouter);
  app.use("/api/v1/v1/messages", apiKeyAuth, rateLimiter, messagesRouter);

  // ── API routes ──
  app.use("/api", apiRouter);

  // Bind to 0.0.0.0 for E2B sandbox access. The server will be accessible at:
  // - http://localhost:{port} within the sandbox
  // - https://{port}-{sandbox_id}.e2b.app from outside the sandbox
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  const e2bSandboxId = process.env.E2B_SANDBOX_ID;
  const e2bDomain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
  const externalUrl = e2bSandboxId
    ? `https://${port}-${e2bSandboxId}.${e2bDomain}`
    : `http://localhost:${port}`;
  console.log(`Express server listening on ${externalUrl}`);

  return { app, server };
}
