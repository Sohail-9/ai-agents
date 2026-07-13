import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { verifyServiceToken } from "../lib/serviceToken";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);

  // Service-to-service JWT (infra callbacks)
  const infraSecret = process.env.INFRA_JWT_SECRET;
  if (infraSecret) {
    try {
      jwt.verify(token, infraSecret);
      res.locals.userId = "infra-service";
      return next();
    } catch {
      // Not an infra token — fall through to service verify
    }
  }

  // AI Agents auth service access token (RS256, verified via JWKS).
  const identity = await verifyServiceToken(token);
  if (identity) {
    res.locals.userId = identity.userId;
    res.locals.sessionId = identity.sessionId;
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}
