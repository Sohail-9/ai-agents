import { Router, Request, Response } from "express";

/**
 * Auth passthrough proxy.
 *
 * The CLI no longer talks to the auth service directly — it points its base URL
 * at this backend. We forward every request under `/api/auth/*` and
 * `/api/oauth/google/cli/*` to the auth service at `AUTH_SERVICE_URL`, verbatim
 * (method, path, query, body, Authorization), and stream the upstream status +
 * body straight back to the caller.
 *
 * Mounted BEFORE the global `requireAuth` (see server.ts) because most auth
 * endpoints (signin/signup/refresh/forgot/reset/google) are unauthenticated.
 * Token verification stays with the auth service — this proxy is transparent.
 */

const router = Router();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;

// Request headers worth forwarding upstream. Host / hop-by-hop headers are
// dropped so fetch sets them correctly for the upstream target.
const FORWARD_REQ_HEADERS = ["authorization", "content-type", "accept", "cookie"];

// Cap the upstream call so a hung auth service can't pin a backend connection
// open indefinitely. Kept under the CLI's own 30s account timeout so the CLI
// sees a clean 502 rather than its own abort.
const UPSTREAM_TIMEOUT_MS = 25_000;

async function forward(req: Request, res: Response) {
  if (!AUTH_SERVICE_URL) {
    return res
      .status(503)
      .json({ error: { message: "Auth service not configured" } });
  }

  // originalUrl preserves the full path + query the CLI called, e.g.
  // `/api/auth/signin` or `/api/oauth/google/cli/status/abc?x=1`, so paths map 1:1.
  const url = `${AUTH_SERVICE_URL}${req.originalUrl}`;

  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQ_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const sendBody = hasBody && req.body && Object.keys(req.body).length > 0;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      // Do NOT follow redirects. The Google OAuth legs (authorize/callback)
      // return 302s to accounts.google.com — those must reach the BROWSER so it
      // navigates to Google itself (correct origin + the user's Google cookies).
      // If fetch follows them, we'd fetch Google's HTML server-side and serve it
      // under our own origin, which breaks the login (Google sees no session).
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ...(sendBody ? { body: JSON.stringify(req.body) } : {}),
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.set("content-type", contentType);
    // Pass the redirect target through verbatim so the browser follows it.
    const location = upstream.headers.get("location");
    if (location) res.set("location", location);
    // Relay Set-Cookie verbatim so the auth service's httpOnly pf_session
    // cookie survives the hop (browser/web-client flows depend on it; the CLI
    // ignores it and uses the body tokens). getSetCookie() preserves multiples.
    const setCookie = upstream.headers.getSetCookie?.();
    if (setCookie && setCookie.length > 0) res.set("set-cookie", setCookie);

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err: any) {
    console.error("[authProxy] upstream request failed:", err);
    return res
      .status(502)
      .json({ error: { message: "Auth service unreachable" } });
  }
}

// Catch-all: every method + sub-path under the mount points hits `forward`.
router.use(forward);

export default router;
