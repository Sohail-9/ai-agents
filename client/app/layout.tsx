import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { PostHogProvider } from "@/components/posthog-provider";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Agents - Making software development easy again",
  description: "A unified platform to build complete systems with AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      <html
        lang="en"
        suppressHydrationWarning
        className={`${geistSans.variable} ${inter.variable} h-full antialiased`}
        style={{ backgroundColor: "#1C1C1C" }}
      >
        <body style={{ backgroundColor: "#1C1C1C" }}>
          <PostHogProvider>
            {children}
            <Toaster richColors position="bottom-right" theme="dark" />
          </PostHogProvider>
        </body>
      </html>
    </SessionProvider>
  );
}
