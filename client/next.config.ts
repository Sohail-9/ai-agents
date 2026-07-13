import type { NextConfig } from "next";

// Backend origin (server-side env). The auth service is private — the web app
// reaches it ONLY through the backend proxy, same as the CLI. Browser-facing
// auth traffic goes through the same-origin /pf-auth/* proxy below → backend →
// auth service, so the pf_session cookie stays first-party and the Google OAuth
// redirect chain resolves back to this app's origin (Option A: same-origin).
const BACKEND = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins: ["192.168.56.1"],
  async rewrites() {
    return [
      // /pf-auth/<route> → <backend>/api/auth/<route> (backend forwards to auth)
      // Covers signin/signup/refresh/me/logout/google/google/callback/etc.
      { source: "/pf-auth/:path*", destination: `${BACKEND}/api/auth/:path*` },
    ];
  },
};

export default nextConfig;
