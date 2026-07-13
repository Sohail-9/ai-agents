import { Router } from "express";

const router = Router();

// Provider preference removed — routing is server-side only.
router.get("/", (_req, res) => res.json({ resolvedProvider: "QWEN_DASHSCOPE" }));
router.put("/", (_req, res) => res.status(410).json({ error: "Provider preference no longer configurable per-user." }));

export default router;
