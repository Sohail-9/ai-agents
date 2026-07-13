import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// Route through the backend proxy, not the auth service directly — the auth
// service is private and reachable only by the backend. Backend forwards
// /api/auth/* upstream verbatim. e.g. https://api.ai-agents.com
const AUTH = process.env.BACKEND_URL!;
const SKEW = 30_000; // refresh 30s before expiry
const ACCESS_TTL = 15 * 60 * 1000; // service access token ~15m (opaque refresh, can't parse)

async function refresh(refreshToken: string) {
  const r = await fetch(`${AUTH}/api/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) throw new Error("refresh_failed");
  return r.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 }, // ≥ service refresh-token TTL
  pages: { signIn: "/sign-in" },
  providers: [
    // (A) password — delegates the credential check to the service
    Credentials({
      id: "password",
      name: "password",
      credentials: { email: {}, password: {} },
      async authorize(c) {
        const r = await fetch(`${AUTH}/api/auth/signin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: c.email, password: c.password }),
        });
        if (!r.ok) return null; // 401 invalid / 403 unverified → NextAuth error
        const d = await r.json(); // { userId, sessionId, accessToken, refreshToken }
        // fetch profile so name/email land in the session (parity with the bridge provider)
        const me = await fetch(`${AUTH}/api/auth/me`, {
          headers: { Authorization: `Bearer ${d.accessToken}` },
        });
        const { user } = me.ok ? await me.json() : { user: {} };
        return {
          id: d.userId,
          email: user.email,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
          accessToken: d.accessToken,
          refreshToken: d.refreshToken,
          accessTokenExpires: Date.now() + ACCESS_TTL,
        };
      },
    }),
    // (B) google-bridge — trusts tokens already minted by the service (see §5.2)
    Credentials({
      id: "bridge",
      name: "bridge",
      credentials: { accessToken: {}, refreshToken: {} },
      async authorize(c) {
        const me = await fetch(`${AUTH}/api/auth/me`, {
          headers: { Authorization: `Bearer ${c.accessToken}` },
        });
        if (!me.ok) return null; // reject forged tokens
        const { user } = await me.json();
        return {
          id: user.id,
          email: user.email,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
          accessToken: c.accessToken as string,
          refreshToken: c.refreshToken as string,
          accessTokenExpires: Date.now() + ACCESS_TTL,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // first sign-in: copy tokens into the JWE
        return {
          ...token,
          sub: user.id,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: user.accessTokenExpires,
        };
      }
      if (Date.now() < (token.accessTokenExpires ?? 0) - SKEW) return token;
      try {
        // expired → rotate via the service
        const t = await refresh(token.refreshToken!);
        return {
          ...token,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessTokenExpires: Date.now() + ACCESS_TTL,
        };
      } catch {
        return { ...token, error: "RefreshError" as const }; // surfaces → force re-login
      }
    },
    async session({ session, token }) {
      session.user.id = token.sub!;
      session.accessToken = token.accessToken;
      session.error = token.error;
      return session;
    },
  },
});
