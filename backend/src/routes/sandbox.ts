/**
 * /api/sandbox/* — sandbox lifecycle endpoints (sleep / wake / status).
 *
 * Used for:
 *   - frontend polling (GET /status/:workspaceId during cold-start UX)
 *   - manual debug / ops (POST /sleep, POST /wake)
 *
 * The wake flow inside USER_REQUEST is handled directly in WSManager — these
 * HTTP endpoints exist for everything else.
 */

import { Router, Request, Response } from "express";
import { workspaceService, sandboxLifecycleService } from "../services";

const router = Router();

async function resolveSandboxId(workspaceId: string): Promise<string | null> {
  const ws = await workspaceService.getWorkspace(workspaceId);
  return ws?.sandboxId ?? null;
}

router.get("/status/:workspaceId", async (req: Request, res: Response) => {
  try {
    const status = await sandboxLifecycleService.getStatus(String(req.params.workspaceId));
    res.json({ status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/sleep/:workspaceId", async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);
    const sandboxId = await resolveSandboxId(workspaceId);
    if (!sandboxId) {
      res.status(404).json({ error: "Workspace has no sandbox" });
      return;
    }
    await sandboxLifecycleService.sleep(workspaceId, sandboxId);
    const status = await sandboxLifecycleService.getStatus(workspaceId);
    res.json({ ok: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/wake/:workspaceId", async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);
    const sandboxId = await resolveSandboxId(workspaceId);
    if (!sandboxId) {
      res.status(404).json({ error: "Workspace has no sandbox" });
      return;
    }
    await sandboxLifecycleService.wakeIfNeeded(workspaceId, sandboxId);
    const status = await sandboxLifecycleService.getStatus(workspaceId);
    res.json({ ok: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
