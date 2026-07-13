import { Router } from "express";

const router = Router();

// The Clerk user-sync webhook (POST /clerk) was removed during the migration to
// the AI Agents auth service. Users are now provisioned lazily on first
// authenticated request (see middleware/loadUser.ts). This router is kept as the
// mount point for any future non-Clerk webhooks.

export default router;
