"use client";

import { useState } from 'react';
import Sidebar from '@/components/Sidebar';
import SystemHeader from '@/components/system/SystemHeader';
import ChatPane from '@/components/system/ChatPane';
import EditorPane from '@/components/system/EditorPane';

export default function SystemPage() {
  const [viewMode, setViewMode] = useState<"chat" | "split" | "preview">("split");

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-main text-white font-sans selection:bg-brand-pink/30">
      <Sidebar defaultCollapsed={true} />
      
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <SystemHeader viewMode={viewMode} setViewMode={setViewMode} />
        
        <div className="flex-1 flex overflow-hidden">
          <ChatPane viewMode={viewMode} />
          <EditorPane viewMode={viewMode} />
        </div>
      </main>
    </div>
  );
}
