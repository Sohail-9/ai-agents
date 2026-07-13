"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useUser, useAuth } from "@/lib/auth-client";
import type { GithubRepo } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export function useWorkspaceManager() {
  const router = useRouter();
  const { user, isLoaded: isUserLoaded } = useUser();
  const { getToken } = useAuth();
  const [systems, setSystems] = React.useState<any[]>([]);
  const [systemsLoading, setSystemsLoading] = React.useState(true);
  const [isCreating, setIsCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [clarificationQuestions, setClarificationQuestions] = React.useState<any[]>([]);
  const [suggestionIdeas, setSuggestionIdeas] = React.useState<string[]>([]);
  const [pendingWorkspaceRequest, setPendingWorkspaceRequest] = React.useState<{
    message: string;
    framework: string;
    files?: File[];
  } | null>(null);

  // Fetch existing workspaces
  React.useEffect(() => {
    if (!isUserLoaded || !user?.id) return;
    setSystemsLoading(true);
    getToken().then(token =>
      fetch(`${API_URL}/api/workspaces/${user.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const normalized = data.map((w: any) => ({
            ...w,
            _id: w._id || w.id,
            updatedAt: w.updatedAt ? new Date(w.updatedAt).getTime() : Date.now(),
          }));
          setSystems(normalized);
        }
      })
      .catch((err) => console.error("Failed to fetch systems:", err))
      .finally(() => setSystemsLoading(false));
  }, [user?.id, isUserLoaded, getToken]);

  const initiateWorkspace = async (
    pendingMessage: string,
    framework: string,
    files?: File[],
  ): Promise<
    | { requiresSuggestion: true; suggestions: string[]; message: string }
    | { requiresClarification: true; clarificationQuestions: string[]; message: string }
    | void
  > => {
    setIsCreating(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("idea", pendingMessage);
      formData.append("framework", framework);
      for (const file of files ?? []) {
        formData.append("images", file);
      }

      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const data = await res.json();

      if (data.requiresSuggestion || data.status === "suggestion_mode") {
        setSuggestionIdeas(data.suggestions || []);
        setPendingWorkspaceRequest({ message: pendingMessage, framework, files });
        setIsCreating(false);
        return {
          requiresSuggestion: true,
          suggestions: data.suggestions || [],
          message: data.message,
        };
      }

      if (data.requiresClarification || data.status === "clarification_required") {
        setClarificationQuestions(data.clarificationQuestions || []);
        setPendingWorkspaceRequest({ message: pendingMessage, framework, files });
        setIsCreating(false);
        return {
          requiresClarification: true,
          clarificationQuestions: data.clarificationQuestions || [],
          message: data.message,
        };
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to create workspace");
      }

      const { id, status } = data;

      // Check workspace status
      if (status === "FAILED") {
        throw new Error("Project name generation failed. Please try again.");
      }

      if (status !== "READY") {
        // Status should be READY before we redirect, but handle gracefully
        console.warn(`Failed to create workspace: Unexpected status: ${status}`);
      }

      // Redirect to clean URL without query params (name is now in DB)
      router.push(`/system/${id}`);
    } catch (err: any) {
      console.error("Failed to create workspace:", err);
      setError(err.message || "Failed to create workspace");
      setIsCreating(false);
    }
  };

  const refinedInitiateWorkspace = async (
    refinedMessage: string,
    framework?: string,
  ): Promise<
    | { requiresSuggestion: true; suggestions: string[]; message: string }
    | { requiresClarification: true; clarificationQuestions: string[]; message: string }
    | void
  > => {
    if (!pendingWorkspaceRequest) {
      setError("No pending workspace request");
      return;
    }
    setClarificationQuestions([]);
    setPendingWorkspaceRequest(null);
    return await initiateWorkspace(
      refinedMessage,
      framework || pendingWorkspaceRequest.framework,
      pendingWorkspaceRequest.files,
    );
  };

  const deleteWorkspace = async (id: string) => {
    const token = await getToken();
    await fetch(`${API_URL}/api/workspaces/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    setSystems((prev) => prev.filter((w) => w._id !== id));
  };

  const initiateRepoSetup = async (repo: GithubRepo, message?: string, branch?: string) => {
    setIsCreating(true);
    setError(null);

    try {
      const userId = user?.id ?? "anonymous";
      const owner = repo.owner || repo.fullName?.split("/")[0] || "";
      const repoName = repo.name;
      const targetBranch = branch || repo.defaultBranch || "main";

      const token = await getToken();
      const res = await fetch(`${API_URL}/api/github/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          owner,
          repo: repoName,
          branch: targetBranch,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start repository import");
      }

      const { workspaceId } = await res.json();

      const params = new URLSearchParams();
      params.set("name", repoName);
      if (message?.trim()) params.set("idea", message.trim());
      router.push(`/system/${workspaceId}?${params.toString()}`);
    } catch (err: any) {
      console.error("Failed to import repository:", err);
      setError(err.message || "Failed to import repository");
      setIsCreating(false);
    }
  };

  return {
    systems,
    systemsLoading,
    isCreating,
    error,
    setError,
    initiateWorkspace,
    refinedInitiateWorkspace,
    initiateRepoSetup,
    deleteWorkspace,
    clarificationQuestions,
    setClarificationQuestions,
    suggestionIdeas,
    setSuggestionIdeas,
    pendingWorkspaceRequest,
  };
}
