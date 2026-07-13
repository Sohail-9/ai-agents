"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search, Home, Database, Globe, ChevronDown, MessageSquare, Settings, PanelLeftClose, PanelLeftOpen, ExternalLink, LogOut, KeyRound, BarChart3 } from 'lucide-react';
import { useUser, useClerk, useAuth } from "@/lib/auth-client";
import { Workspace } from '@/lib/types';
import { SearchPalette } from '@/components/SearchPalette';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

const DURATION = 'duration-[320ms]';
const EASE = 'ease-[cubic-bezier(0.25,0.46,0.45,0.94)]';

const INITIAL_CREDITS = 10_000;

function getCreditRingColor(credits: number) {
  if (credits > 5000) return '#34d399';
  if (credits > 1000) return '#f59e0b';
  return '#f87171';
}


interface SidebarProps {
  defaultCollapsed?: boolean;
  systems?: Workspace[];
  systemsLoading?: boolean;
  onCollapse?: () => void;
}

export default function Sidebar({ defaultCollapsed = false, systems: systemsProp, systemsLoading: systemsLoadingProp, onCollapse }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, bottom: 0, width: 0 });
  const { user } = useUser();
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const pathname = usePathname();
  const userRowRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback(() => {
    if (userRowRef.current) {
      const r = userRowRef.current.getBoundingClientRect();
      setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 8, width: r.width });
    }
    setUserMenuOpen(true);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setUserMenuOpen(false);
    };
    if (userMenuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [selfSystems, setSelfSystems] = useState<Workspace[]>([]);
  const [selfLoading, setSelfLoading] = useState(false);

  useEffect(() => {
    if (systemsProp !== undefined || !user?.id) return;
    setSelfLoading(true);
    getToken().then(token =>
      fetch(`${API_URL}/api/workspaces/${user.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
      .then(r => r.ok ? r.json() : [])
      .then(data => setSelfSystems(Array.isArray(data) ? data : data.workspaces ?? []))
      .catch(() => {})
      .finally(() => setSelfLoading(false));
  }, [user?.id, systemsProp, getToken]);

  // Fetch credits on user change
  useEffect(() => {
    if (!user?.id) return;
    getToken().then(token =>
      fetch(`${API_URL}/api/user/credits`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
      .then(r => r.json())
      .then(d => { setCredits(d.availableCredits ?? null); setPlan(d.plan ?? null); })
      .catch(() => {});
  }, [user?.id, getToken]);

  // Listen for credits refresh event (fired by WebSocket hook after agent completes)
  useEffect(() => {
    const handleCreditsRefresh = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // If event has newBalance (from BILLING_FINALIZED), use it directly
      if (detail?.newBalance !== undefined) {
        setCredits(Math.max(0, detail.newBalance));
        return;
      }
      // Fallback: re-fetch from server (e.g., on user?.id change or manual trigger)
      if (!user?.id) return;
      getToken().then(token =>
        fetch(`${API_URL}/api/user/credits`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
        .then(r => r.json())
        .then(d => setCredits(d.availableCredits ?? null))
        .catch(() => {});
    };
    window.addEventListener('ai-agents:credits-refresh', handleCreditsRefresh);
    return () => window.removeEventListener('ai-agents:credits-refresh', handleCreditsRefresh);
  }, [user?.id, getToken]);

  const systems = systemsProp ?? selfSystems;
  const systemsLoading = systemsLoadingProp ?? selfLoading;

  return (
    <>
    <aside
      className={`flex flex-col h-screen bg-bg-sidebar border-r border-border-subtle overflow-hidden transition-[width] ${DURATION} ${EASE} ${isCollapsed ? 'w-16' : 'w-60'}`}
    >
      {/* ── Header ── */}
      <div className="relative flex items-center h-[52px] shrink-0 border-b border-white/5">
        {/* Expanded state */}
        <div className={`absolute inset-0 flex items-center pl-[22px] pr-3 justify-between transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
          <div className="relative w-[105px] h-6 shrink-0">
            <Image src="/logos/logoname_dark.svg" alt="AI Agents Logo" fill className="object-contain object-left" />
          </div>
          <button
            onClick={() => onCollapse ? onCollapse() : setIsCollapsed(true)}
            className="p-1.5 rounded-[12px] hover:bg-white/5 text-gray-400 hover:text-white transition-colors shrink-0 cursor-pointer"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        {/* Collapsed state */}
        <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <button
            onClick={() => setIsCollapsed(false)}
            className="group relative w-10 h-10 flex items-center justify-center rounded-[12px] hover:bg-white/5 transition-colors cursor-pointer"
          >
            <img src="/logos/logo.svg" alt="Logo" className="w-6 h-6 transition-opacity duration-150 group-hover:opacity-0" />
            <PanelLeftOpen size={18} className="absolute text-gray-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
          </button>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="relative flex items-center justify-center h-14 shrink-0 border-b border-white/5">
        {/* Expanded */}
        <div className={`absolute inset-0 flex items-center px-2 transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
          <button
            onClick={() => setSearchOpen(true)}
            className="relative w-full flex items-center h-8 bg-bg-input border border-white/5 rounded-[12px] pl-9 pr-2.5 hover:border-white/10 hover:bg-white/5 transition-colors cursor-pointer group"
          >
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 group-hover:text-gray-300 transition-colors" size={14} />
            <span className="text-xs text-gray-500 group-hover:text-gray-400 transition-colors">Search</span>
            <kbd className="ml-auto text-[9px] text-white/15 font-mono tracking-tight">⌘K</kbd>
          </button>
        </div>
        {/* Collapsed */}
        <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <button
            onClick={() => setSearchOpen(true)}
            className="w-8 h-8 rounded-[10px] hover:bg-white/5 text-gray-400 hover:text-white transition-colors flex items-center justify-center shrink-0 cursor-pointer"
          >
            <Search size={16} />
          </button>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 flex flex-col gap-1">
        <NavItem icon={<Home size={16} />} label="Home" href="/" isActive={pathname === '/'} isCollapsed={isCollapsed} />
        <NavItem icon={<Database size={16} />} label="Databases" href="/databases" isActive={pathname.startsWith('/databases')} isCollapsed={isCollapsed} />
        <NavItem icon={<Globe size={16} />} label="Deployments" href="/deployments" isActive={pathname.startsWith('/deployments')} isCollapsed={isCollapsed} />

        {/* Router section */}
        <div className={`mt-5 mb-1.5 pl-3.5 pr-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wider select-none transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-0 pointer-events-none h-0 my-0 overflow-hidden' : 'opacity-100'}`}>
          <span>Router</span>
        </div>
        <NavItem icon={<KeyRound size={16} />} label="API Keys" href="/dashboard/keys" isActive={pathname.startsWith('/dashboard/keys')} isCollapsed={isCollapsed} />
        <NavItem icon={<BarChart3 size={16} />} label="Usage" href="/dashboard/usage" isActive={pathname.startsWith('/dashboard/usage')} isCollapsed={isCollapsed} />

        {/* All Projects header */}
        <div
          onClick={() => !isCollapsed && setIsProjectsExpanded(!isProjectsExpanded)}
          className={`mt-5 mb-1.5 pl-3.5 pr-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between cursor-pointer select-none hover:text-gray-300 transition-opacity ${DURATION} ${EASE} ${isCollapsed ? 'opacity-0 pointer-events-none h-0 my-0 overflow-hidden' : 'opacity-100'}`}
        >
          <span>All Projects</span>
          <ChevronDown size={12} className={`transition-transform duration-200 ${isProjectsExpanded ? 'rotate-180' : ''}`} />
        </div>

        <div className={`flex flex-col gap-0.5 overflow-hidden transition-all ${DURATION} ${EASE} ${isProjectsExpanded && !isCollapsed ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0 pointer-events-none'}`}>
          {systemsLoading ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 pl-3.5 pr-3.5">
                <div className="w-1.5 h-1.5 rounded-full bg-white/10 shrink-0" />
                <div className="h-2.5 rounded-md bg-white/10 animate-pulse" style={{ width: `${[60, 80, 50][i - 1]}%` }} />
              </div>
            ))
          ) : systems.length === 0 ? (
            <p className="text-[11px] text-gray-600 pl-3.5 py-1">No projects yet</p>
          ) : (
            systems.slice(0, 8).map((ws, i) => (
              <ProjectItem key={ws._id || (ws as any).id || i} label={ws.name} id={ws._id || (ws as any).id} isCollapsed={isCollapsed} isActive={pathname === `/system/${ws._id || (ws as any).id}`} />
            ))
          )}
        </div>
      </nav>

      {/* ── Bottom Actions ── */}
      <div className="flex flex-col gap-1 border-t border-border-subtle/30 py-2.5">
        <NavItem icon={<MessageSquare size={16} />} label="Support" href="/support" isActive={pathname.startsWith('/support')} isCollapsed={isCollapsed} />
        <NavItem icon={<Settings size={16} />} label="Settings" href="/settings" isActive={pathname.startsWith('/settings')} isCollapsed={isCollapsed} />
      </div>

      {/* ── User Footer ── */}
      <div className="border-t border-border-subtle/30 mt-auto shrink-0 px-2 py-3">

        {/* Clickable user row */}
        <button
          ref={userRowRef}
          onClick={() => isCollapsed ? setIsCollapsed(false) : openMenu()}
          className={`w-full flex items-center rounded-[12px] hover:bg-white/[0.05] transition-colors cursor-pointer py-1.5 ${isCollapsed ? 'justify-center px-0 gap-0' : 'px-2 gap-3'}`}
        >
          {/* Avatar + ring */}
          <div className="relative shrink-0 flex items-center justify-center" style={{ width: 34, height: 34 }}>
            {credits !== null && (
              <svg
                width="34" height="34" viewBox="0 0 34 34"
                className="absolute inset-0"
                style={{ transform: 'rotate(-90deg)' }}
              >
                <circle cx="17" cy="17" r="15" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.75" />
                <circle
                  cx="17" cy="17" r="15"
                  fill="none"
                  stroke={getCreditRingColor(credits)}
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 15}
                  strokeDashoffset={2 * Math.PI * 15 * (1 - Math.min(1, credits / INITIAL_CREDITS))}
                  style={{ opacity: 0.75, transition: 'stroke-dashoffset 0.7s ease' }}
                />
              </svg>
            )}
            {user?.imageUrl ? (
              <img src={user.imageUrl} alt="avatar" className="w-6 h-6 rounded-full object-cover" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-semibold text-white/60">
                {(user?.fullName ?? user?.username ?? 'U')[0].toUpperCase()}
              </div>
            )}
          </div>

          {/* Name + email */}
          <div className={`flex flex-col overflow-hidden whitespace-nowrap transition-[max-width,opacity] ${DURATION} ${EASE} ${isCollapsed ? 'max-w-0 opacity-0' : 'max-w-[160px] opacity-100'}`}>
            <span className="text-[12.5px] font-semibold text-white leading-tight truncate text-left">
              {user?.fullName ?? user?.username ?? 'User'}
            </span>
            <span className="text-[10px] text-gray-500 leading-tight truncate text-left">
              {user?.primaryEmailAddress?.emailAddress ?? ''}
            </span>
          </div>
        </button>
      </div>
    </aside>

    <SearchPalette
      open={searchOpen}
      onClose={() => setSearchOpen(false)}
      projects={systems.map(ws => ({ id: ws._id || (ws as any).id, name: ws.name }))}
    />

    {/* User menu portal — rendered outside sidebar so overflow:hidden doesn't clip it */}
    {userMenuOpen && typeof document !== 'undefined' && createPortal(
      <div
        className="fixed z-[200] bg-[#2A2A2D] rounded-[18px] p-1.5 shadow-2xl"
        style={{ left: menuPos.left, bottom: menuPos.bottom, width: Math.max(menuPos.width, 200) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {credits !== null && (
          <div className="px-2.5 pt-2.5 pb-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-gray-400">Credits remaining</span>
              <div className="flex items-center gap-1.5">
                {plan && (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={
                      plan === "PRO"
                        ? { color: "#FF15DC", border: "1px solid rgba(255,21,220,0.4)", background: "rgba(255,21,220,0.08)" }
                        : plan === "STANDARD"
                        ? { color: "#a78bfa", border: "1px solid rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.08)" }
                        : { color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.15)", background: "transparent" }
                    }
                  >
                    {plan === "PRO" ? "Pro" : plan === "STANDARD" ? "Standard" : "Free"}
                  </span>
                )}
                <span className="text-[11px] font-semibold tabular-nums" style={{ color: "#FF15DC" }}>{credits.toLocaleString()}</span>
              </div>
            </div>
            <div className="h-[3px] w-full bg-white/[0.08] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(100, (credits / INITIAL_CREDITS) * 100)}%`,
                  background: "linear-gradient(90deg, #FF15DC 0%, #FF6EE7 100%)",
                }}
              />
            </div>
            <div className="h-px bg-white/10 mt-2.5" />
          </div>
        )}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => { window.location.href = "/settings"; setUserMenuOpen(false); }}
          className="w-full flex items-center gap-2.5 cursor-pointer rounded-[12px] py-2 px-2.5 outline-none hover:bg-white/10 transition-colors text-left"
        >
          <ExternalLink size={13} className="text-gray-400 shrink-0" />
          <span className="text-[12px] font-semibold text-gray-100">Control panel</span>
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => { signOut(); setUserMenuOpen(false); }}
          className="w-full flex items-center gap-2.5 cursor-pointer rounded-[12px] py-2 px-2.5 outline-none hover:bg-white/10 transition-colors text-left mt-0.5 group"
        >
          <LogOut size={13} className="text-red-400/80 group-hover:text-red-400 shrink-0" />
          <span className="text-[12px] font-semibold text-red-400/80 group-hover:text-red-400">Log out</span>
        </button>
      </div>,
      document.body
    )}
    </>
  );
}

function ProjectItem({ label, id, isCollapsed, isActive }: { label: string; id?: string; isCollapsed: boolean; isActive?: boolean }) {
  return (
    <Link
      href={id ? `/system/${id}` : "/"}
      className={`flex items-center py-1.5 pl-3.5 transition-colors text-[12.5px] w-full text-left relative ml-2 ${
        isActive
          ? 'bg-gradient-to-r from-transparent to-brand-pink/20 text-white border-r-[3px] border-brand-pink pr-0 rounded-l'
          : 'text-gray-400 hover:text-white hover:bg-white/5 pr-3.5 mr-2 rounded'
      }`}
      title={isCollapsed ? label : undefined}
    >
      <div className="shrink-0 flex items-center justify-center w-5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-brand-pink' : 'bg-gray-500'}`} />
      </div>
      <span className={`font-medium truncate whitespace-nowrap overflow-hidden transition-[max-width,opacity,margin] ${DURATION} ${EASE} ${isCollapsed ? 'max-w-0 opacity-0 ml-0' : 'max-w-[160px] opacity-100 ml-3'}`}>
        {label}
      </span>
    </Link>
  );
}

function NavItem({
  icon,
  label,
  href,
  isActive,
  isCollapsed
}: {
  icon: React.ReactNode;
  label: string;
  href: string;
  isActive?: boolean;
  isCollapsed: boolean;
}) {
  return (
    <Link
      href={href}
      title={isCollapsed ? label : undefined}
      className={`
        group flex items-center py-2 pl-3.5 transition-colors text-[13px] w-full text-left relative cursor-pointer ml-2
        ${isActive
          ? 'bg-gradient-to-r from-transparent to-brand-pink/20 text-white border-r-[3px] border-brand-pink pr-0 rounded-l-[12px]'
          : 'text-gray-400 hover:text-white hover:bg-white/5 pr-3.5 mr-2 rounded-[12px]'
        }
      `}
    >
      <div className="shrink-0 flex items-center justify-center w-5">{icon}</div>
      <span className={`font-medium truncate whitespace-nowrap overflow-hidden transition-[max-width,opacity,margin] ${DURATION} ${EASE} ${isCollapsed ? 'max-w-0 opacity-0 ml-0' : 'max-w-[160px] opacity-100 ml-3'}`}>
        {label}
      </span>
    </Link>
  );
}
