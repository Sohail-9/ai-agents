import { DefaultSession } from "next-auth";

// Tokens minted by the PrettiFlow auth service, carried through NextAuth.
interface ServiceTokens {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number;
  error?: "RefreshError";
}

declare module "next-auth" {
  interface Session extends ServiceTokens {
    user: {
      id: string;
    } & DefaultSession["user"];
  }

  // Returned from the Credentials `authorize` callbacks.
  interface User extends ServiceTokens {
    id?: string;
  }
}

// JWT interface is declared in @auth/core/jwt (next-auth/jwt just re-exports it),
// so augment there for the merge to take effect.
declare module "@auth/core/jwt" {
  interface JWT extends ServiceTokens {
    sub?: string;
  }
}
