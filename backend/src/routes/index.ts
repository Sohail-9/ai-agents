import { Router } from "express";
import workspacesRouter from "./workspaces";
import githubRouter from "./github";
import coregitRouter from "./coregit";
import apiKeysRouter from "./apiKeys";
import userSettingsRouter from "./userSettings";
import imagesRouter from "./images";
import inspectorRouter from "./inspector";
import sandboxRouter from "./sandbox";
import demoAccessRouter from "./demoAccess";
import userRouter from "./user";
import adminCreditsRouter from "./adminCredits";
import paymentsRouter from "./payments";
import supportRouter from "./support";
import cliRouter from "./cli";
import cliLlmRouter from "./cliLlm";
import v1KeysRouter from "./v1/keys";
import v1UsageRouter from "./v1/usage";
import { requireAuth } from "../middleware/requireAuth";
import { loadUser } from "../middleware/loadUser";

const router = Router();

// Skip JWT auth for: GitHub OAuth callback (browser redirect) and admin routes (use x-admin-token)
router.use((req, res, next) => {
  if (req.path === "/github/callback") return next();
  if (req.path.startsWith("/demo-access/admin")) return next();
  if (req.path.startsWith("/credits/admin")) return next();
  // CLI LLM gateway authenticates itself (token arrives via x-api-key, not
  // Authorization). See routes/cliLlm.ts.
  if (req.path.startsWith("/cli/llm")) return next();
  return requireAuth(req, res, next);
});

// Lazily provision the local User from the auth service after authentication.
router.use((req, res, next) => {
  if (req.path === "/github/callback") return next();
  if (req.path.startsWith("/demo-access/admin")) return next();
  if (req.path.startsWith("/credits/admin")) return next();
  if (req.path.startsWith("/cli/llm")) return next();
  return loadUser(req, res, next);
});

router.use("/workspaces", workspacesRouter);
router.use("/github", githubRouter);
router.use("/coregit", coregitRouter);
router.use("/keys", apiKeysRouter);
router.use("/user", userRouter);
router.use("/user/preference", userSettingsRouter);
// Image upload: POST /api/workspaces/:workspaceId/images
router.use("/workspaces", imagesRouter);
// Image serve: GET /api/images/:id
router.use("/images", imagesRouter);
// Element inspector AI delta: POST /api/inspector/instruct
router.use("/inspector", inspectorRouter);
// Sandbox lifecycle (sleep/wake/status): /api/sandbox/*
router.use("/sandbox", sandboxRouter);
// Demo access (status/claim): /api/demo-access/*
router.use("/demo-access", demoAccessRouter);
// Admin credits management: /api/credits/admin/*
router.use("/credits", adminCreditsRouter);
// Payments: /api/payments/*
router.use("/payments", paymentsRouter);
// Support cases + agent: /api/support/*
router.use("/support", supportRouter);
// CLI LLM gateway (Phase 1, observe-only): POST /api/cli/llm/v1/messages.
// Mounted before /cli so it owns the /cli/llm subtree. Global requireAuth +
// loadUser above already authenticated the request. Always on; kill-switch via CLI_LLM_DISABLED.
router.use("/cli/llm", cliLlmRouter);
// CLI provider config: GET /api/cli/env — requires Authorization: Bearer <token>
router.use("/cli", requireAuth, cliRouter);
// Router (LLM gateway) key management + usage dashboard — JWT (inference plane
// lives in server.ts behind apiKeyAuth, mounted before this router).
router.use("/v1/keys", v1KeysRouter);
router.use("/v1/usage", v1UsageRouter);

export default router;
