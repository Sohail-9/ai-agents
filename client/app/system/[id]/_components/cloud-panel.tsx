"use client";

import * as React from "react";
import { Database, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { GlassButton } from "@/components/ui/glass-button";
import { DeploymentsTab } from "./deployments-tab";
import { DatabaseTab } from "./database-tab";

type CloudTab = "database" | "deployments";

interface CloudPanelProps {
  workspaceId: string;
}

const TABS: Array<{ id: CloudTab; label: string; icon: React.ComponentType<{ className?: string }>; description: string }> = [
  { id: "database", label: "Database", icon: Database, description: "Inspect tables and rows" },
  { id: "deployments", label: "Deployments", icon: Rocket, description: "View deploys and logs" },
];

export function CloudPanel({ workspaceId }: CloudPanelProps) {
  const [tab, setTab] = React.useState<CloudTab>("database");
  const activeMeta = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden bg-[#1a1a1c]">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-3 border-b border-white/[0.06] bg-[#1e1e20]">
        <div className="flex items-center gap-2.5 mr-auto min-w-0">
          <div className="flex flex-col min-w-0">
            <h2 className="text-[13px] font-semibold leading-tight tracking-tight text-white">Cloud</h2>
            <p className="text-[11px] leading-tight text-white/40 truncate">{activeMeta.description}</p>
          </div>
        </div>

        {/* Segmented tab switcher */}
        <div className="flex items-center gap-1 shrink-0">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            return (
              <GlassButton
                key={t.id}
                size="xs"
                onClick={() => setTab(t.id)}
                className={cn(
                  "gap-1.5",
                  !isActive && "opacity-50 hover:opacity-80"
                )}
              >
                <Icon className="w-3 h-3" />
                {t.label}
              </GlassButton>
            );
          })}
        </div>
      </div>

      {/* Content — always mount both, CSS toggle to preserve state */}
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
        <div className={cn("absolute inset-0 overflow-hidden", tab !== "database" && "opacity-0 pointer-events-none")}>
          <DatabaseTab workspaceId={workspaceId} />
        </div>
        <div className={cn("absolute inset-0 overflow-hidden", tab !== "deployments" && "opacity-0 pointer-events-none")}>
          <DeploymentsTab workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
