"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useUser, useAuth } from "@/lib/auth-client";
import Sidebar from "@/components/Sidebar";
import SystemHeader from "@/components/system/SystemHeader";
import ChatPane from "@/components/system/ChatPane";
import EditorPane from "@/components/system/EditorPane";
import { SetupLoading } from "./_components/setup-loading";
import { useSystemWebSocket } from "./_hooks/use-system-websocket";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface WorkspaceData {
  id: string;
  name: string;
  sandboxId: string | null;
  port: number | null;
  backendPort: number | null;
  status: string;
  idea: string;
  framework: string;
  coregitNamespace?: string | null;
}

export default function WorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useUser();
  const { getToken, accessToken } = useAuth();
  const systemId = params.id as string;

  // Workspace metadata
  const [workspace, setWorkspace] = React.useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isResuming, setIsResuming] = React.useState(false);

  React.useEffect(() => {
    async function resumeSession(id: string) {
      setIsResuming(true);
      try {
        const token = await getToken();
        const res = await fetch(`${API_URL}/api/workspaces/resume/${id}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Resumption failed");
      } catch {
        // silent — preview will still attempt to load
      } finally {
        setIsResuming(false);
      }
    }

    async function loadWorkspace() {
      try {
        const token = await getToken();
        const res = await fetch(`${API_URL}/api/workspaces/detail/${systemId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 404) { setLoadError("Workspace not found"); setIsLoading(false); return; }
        if (!res.ok) throw new Error("Failed to load workspace");
        const data = await res.json();
        setWorkspace(data);
        if (data.sandboxId) resumeSession(data.id);
      } catch (err: any) {
        setLoadError(err.message || "Failed to load workspace");
      } finally {
        setIsLoading(false);
      }
    }
    loadWorkspace();
  }, [systemId, getToken]);

  const workspaceName = workspace?.name || "My System";
  const isNewWorkspace = workspace ? !workspace.sandboxId : false;
  const initialIdea = isNewWorkspace ? (workspace?.idea || "") : null;
  const initialImageIds: string[] = [];

  const {
    messages,
    todos,
    isAgentRunning,
    activeSandboxId,
    activePort,
    isInitializing,
    isSettingUp,
    setupStatus,
    hasMoreHistory,
    isLoadingHistory,
    loadMoreHistory,
    sendUserMessage,
    stopAgent,
    isPlanMode,
    setIsPlanMode,
    isMultiAgentEnabled,
    setIsMultiAgentEnabled,
    planQuestions,
    setPlanQuestions,
    planReady,
    setPlanReady,
    sendPlanAnswers,
    wsRef,
    subAgentStates,
    subAgentIsLive,
    sessionStats,
    agentStartedAt,
  } = useSystemWebSocket({
    systemId,
    initialSandboxId: workspace?.sandboxId || null,
    initialIdea: initialIdea || null,
    initialImageIds: initialImageIds,
    framework: workspace?.framework || undefined,
    enabled: !isLoading && !loadError,
    userId: user?.id ?? null,
    accessToken: accessToken ?? null,
    initialPlanMode: true,
  });

  const [viewMode, setViewMode] = React.useState<"chat" | "split" | "preview">("chat");
  const prevViewModeRef = React.useRef<"chat" | "split" | "preview">("chat");

  // Auto-switch to split when preview becomes available
  React.useEffect(() => {
    const port = activePort || workspace?.port;
    if (port && viewMode === "chat") setViewMode("split");
  }, [activePort, workspace?.port]);

  // Visual editor: expand to full preview on open, restore on close
  React.useEffect(() => {
    const onChanged = (e: Event) => {
      const active = (e as CustomEvent<{ active: boolean }>).detail.active;
      if (active) {
        prevViewModeRef.current = viewMode;
        setViewMode("preview");
      } else {
        setViewMode(prevViewModeRef.current === "preview" ? "split" : prevViewModeRef.current);
      }
    };
    window.addEventListener('pf:visual-edit-changed', onChanged);
    return () => window.removeEventListener('pf:visual-edit-changed', onChanged);
  }, [viewMode]);

  const domain = process.env.NEXT_PUBLIC_E2B_SANDBOX_DOMAIN || "e2b.app";
  const previewUrl = activeSandboxId && activePort
    ? `https://${activePort}-${activeSandboxId}.${domain}`
    : workspace?.sandboxId && workspace?.port
    ? `https://${workspace.port}-${workspace.sandboxId}.${domain}`
    : undefined;

  const handleSendMessage = React.useCallback((text: string, images?: import('./_types/system').ChatImage[]) => {
    sendUserMessage(text, isPlanMode, isMultiAgentEnabled, images);
  }, [sendUserMessage, isPlanMode, isMultiAgentEnabled]);

  const handlePlanModeChange = React.useCallback((mode: boolean) => {
    setIsPlanMode(mode);
    localStorage.setItem("ai-agents:planMode", String(mode));
  }, [setIsPlanMode]);

  const handleMultiAgentChange = React.useCallback((v: boolean) => {
    setIsMultiAgentEnabled(v);
    localStorage.setItem("pf:multiAgent", String(v));
  }, [setIsMultiAgentEnabled]);

  const handlePlanAnswer = React.useCallback((answers: Record<string, string>, questionsData?: typeof planQuestions) => {
    sendPlanAnswers(answers, questionsData ?? planQuestions);
  }, [sendPlanAnswers, planQuestions]);

  // Turn off plan mode when plan is ready (but don't change view)
  React.useEffect(() => {
    if (planReady) {
      setIsPlanMode(false);
      localStorage.setItem("ai-agents:planMode", "false");
    }
  }, [planReady, setIsPlanMode]);

  const handleBuildPlan = React.useCallback((msg: string) => {
    setIsPlanMode(false);
    localStorage.setItem("ai-agents:planMode", "false");
    setPlanReady(null);
    setViewMode("split");
    sendUserMessage(msg, false, isMultiAgentEnabled);
  }, [setIsPlanMode, setPlanReady, sendUserMessage, isMultiAgentEnabled]);

  // Show calm rotating logo until workspace is fetched AND WS has finished loading history.
  // Skip for new workspaces — they go straight into SetupLoading overlay.
  if (isLoading || (isInitializing && !isSettingUp)) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0d0d0e]">
        <img
          src="/logos/logo.svg"
          alt="Loading"
          className="w-9 h-9"
          style={{ animation: "spin 3.8s linear infinite" }}
        />
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Error state
  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg-main text-white">
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl">⚠</div>
          <h2 className="text-lg font-semibold">{loadError}</h2>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-sm transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-main text-white font-sans selection:bg-brand-pink/30">
      <Sidebar defaultCollapsed={true} />

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <SystemHeader
          viewMode={viewMode}
          setViewMode={setViewMode}
          projectName={workspaceName}
          workspaceId={systemId}
          workspaceName={workspaceName}
        />

        <div className="flex-1 flex overflow-hidden">
          <ChatPane
            viewMode={viewMode}
            wsMessages={messages}
            isAgentRunning={isAgentRunning}
            onRealSubmit={handleSendMessage}
            onStop={stopAgent}
            isPlanMode={isPlanMode}
            onPlanModeChange={handlePlanModeChange}
            isMultiAgent={isMultiAgentEnabled}
            onMultiAgentChange={handleMultiAgentChange}
            planQuestions={planQuestions}
            onPlanAnswer={handlePlanAnswer}
            planReady={planReady}
            onBuildPlan={handleBuildPlan}
            isLoadingHistory={isLoadingHistory}
            hasMoreHistory={hasMoreHistory}
            onLoadMore={loadMoreHistory}
            todos={todos}
            subAgentStates={subAgentStates}
            subAgentIsLive={subAgentIsLive}
            wsRef={wsRef}
            sandboxId={activeSandboxId}
            sessionStats={sessionStats}
            agentStartedAt={agentStartedAt}
            workspaceId={systemId}
          />
          <EditorPane
            viewMode={viewMode}
            previewUrl={previewUrl}
            wsRef={wsRef}
            sandboxId={activeSandboxId}
            workspaceName={workspaceName}
            coregitNamespace={workspace?.coregitNamespace ?? null}
            workspaceId={systemId}
            isResuming={isResuming}
          />
        </div>
      </main>

      {/* Setup loading overlay — only for new workspaces being provisioned */}
      {isSettingUp && (
        <SetupLoading
          status={setupStatus}
          projectName={workspaceName}
        />
      )}
    </div>
  );
}
