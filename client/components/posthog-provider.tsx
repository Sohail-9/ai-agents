"use client";

import { useEffect, useRef, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useUser } from "@/lib/auth-client";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider, usePostHog } from "posthog-js/react";

let initialized = false;
if (typeof window !== "undefined" && !initialized) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key) {
    posthog.init(key, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ||
        `${window.location.origin}/ingest`,
      ui_host: "https://us.posthog.com",
      capture_pageview: false,
      capture_pageleave: true,
      person_profiles: "identified_only",
    });
    initialized = true;
  }
}

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ph = usePostHog();

  useEffect(() => {
    if (!pathname || !ph) return;
    let url = window.origin + pathname;
    const qs = searchParams?.toString();
    if (qs) url += `?${qs}`;
    ph.capture("$pageview", { $current_url: url });
  }, [pathname, searchParams, ph]);

  return null;
}

function PostHogIdentify() {
  const { isLoaded, isSignedIn, user } = useUser();
  const ph = usePostHog();
  const wasIdentified = useRef(false);

  useEffect(() => {
    if (!isLoaded || !ph) return;

    if (isSignedIn && user) {
      const email = user.primaryEmailAddress?.emailAddress;
      ph.identify(user.id, {
        email,
        name: user.fullName ?? undefined,
        username: user.username ?? undefined,
      });
      wasIdentified.current = true;
    } else if (wasIdentified.current) {
      ph.reset();
      wasIdentified.current = false;
    }
  }, [isLoaded, isSignedIn, user, ph]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return <>{children}</>;
  }

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      <PostHogIdentify />
      {children}
    </PHProvider>
  );
}
