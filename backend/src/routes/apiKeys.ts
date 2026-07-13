import { Router } from "express";

const router = Router();

// API key management removed — all LLM keys are server-side env vars.
router.post("/", (_req, res) => res.status(410).json({ error: "User API keys are no longer supported." }));
router.get("/", (_req, res) => res.json({ keys: [] }));
router.delete("/", (_req, res) => res.status(410).json({ error: "User API keys are no longer supported." }));

export default router;
