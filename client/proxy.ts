import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Next 16 middleware lives in proxy.ts. Replaces the previous Clerk gating.
const PUBLIC = [
  "/sign-in",
  "/sign-up",
  "/verify",
  "/reset-password",
  "/forgot-password",
  "/auth/oauth-landing",
  "/pf-auth", // same-origin proxy to the auth service (signin/signup/google/refresh/…)
];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!req.auth && !isPublic) {
    const url = new URL("/sign-in", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next.js internals, static files, and NextAuth's own API routes
    "/((?!_next|api/auth|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
