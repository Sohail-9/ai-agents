import { Request, Response, NextFunction } from "express";
import { userService } from "../services/userService";

// Process-local cache of auth-service user IDs already provisioned this run, so
// we hit GET /me only once per user per process (not on every request).
const provisioned = new Set<string>();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;

/**
 * Lazily provision the local User row after requireAuth. The access token
 * carries only sub + sessionId (no email/name), so we fetch the profile from
 * the auth service's GET /api/auth/me on first sight, then provision + cache.
 *
 * Non-blocking on failure: a transient /me error must not 401 an authenticated
 * request. Infra tokens and (during dual-accept) Clerk tokens are skipped.
 */
export async function loadUser(req: Request, res: Response, next: NextFunction) {
  const userId = res.locals.userId as string | undefined;
  if (!userId || userId === "infra-service") return next();
  if (provisioned.has(userId)) return next();
  if (!AUTH_SERVICE_URL) return next();

  try {
    const token = req.headers.authorization?.slice(7);
    const r = await fetch(`${AUTH_SERVICE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const { user } = (await r.json()) as {
        user: { id: string; email?: string; firstName?: string; lastName?: string };
      };
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined;
      await userService.provisionUser({
        authUserId: userId,
        email: user.email,
        name,
      });
      provisioned.add(userId);
    }
  } catch (err) {
    console.error("[loadUser] provisioning skipped:", err);
  }
  return next();
}
