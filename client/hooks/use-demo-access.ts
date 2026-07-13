import { useEffect, useState } from 'react';
import { useUser, useAuth } from "@/lib/auth-client";
import { useRouter } from 'next/navigation';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

interface DemoAccessStatus {
  hasAccess: boolean;
  demoKey?: {
    id: string;
    claimedAt: string | null;
  } | null;
}

export function useDemoAccess() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const [accessStatus, setAccessStatus] = useState<DemoAccessStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    if (!isLoaded || !user) {
      setIsChecking(false);
      return;
    }

    const checkAccess = async () => {
      try {
        const token = await getToken();
        const res = await fetch(`${BACKEND_URL}/api/demo-access/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as DemoAccessStatus;
        setAccessStatus(data);
      } catch (error) {
        console.error('[useDemoAccess] Failed to check access:', error);
        setAccessStatus({ hasAccess: false });
      } finally {
        setIsChecking(false);
      }
    };

    checkAccess();
    // depend on the stable id, not the user object, so this fires once per
    // signed-in user — not on every render.
  }, [user?.id, isLoaded]);

  return { accessStatus, isChecking, hasAccess: accessStatus?.hasAccess ?? false };
}

export function useDemoAccessGuard(requiredPath = '/access') {
  const { user, isLoaded } = useUser();
  const router = useRouter();
  const { accessStatus, isChecking } = useDemoAccess();

  useEffect(() => {
    if (!isLoaded) return;

    if (!user) {
      router.replace('/sign-in');
      return;
    }

    if (!isChecking && !accessStatus?.hasAccess) {
      router.replace(requiredPath);
    }
  }, [user, isLoaded, accessStatus, isChecking, router, requiredPath]);

  return { isAccessGranted: accessStatus?.hasAccess ?? false, isLoading: !isLoaded || isChecking };
}

export async function claimDemoKey(token: string, key: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/demo-access/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key }),
    });

    if (!res.ok) {
      const error = (await res.json()) as { error: string };
      return { success: false, error: error.error };
    }

    return { success: true };
  } catch (error) {
    console.error('[claimDemoKey] Failed:', error);
    return { success: false, error: 'Failed to claim key. Please try again.' };
  }
}
