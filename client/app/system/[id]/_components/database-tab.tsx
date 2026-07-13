"use client";

import * as React from "react";
import { useAuth } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { AlertCircle, ChevronLeft, ChevronRight, Eye, EyeOff, PanelLeft, PanelLeftClose, RefreshCcw } from "lucide-react";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

type DatabaseMetaResponse = {
  success: boolean;
  hasDatabase: boolean;
  maskedUrl: string | null;
  tables: Array<{ name: string }>;
};

type DatabaseTableResponse = {
  success: boolean;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
  rowIdField?: string;
};

interface DatabaseTabProps {
  workspaceId: string;
}

type EditingCell = {
  rowId: string;
  rowIndex: number;
  column: string;
  value: string;
  originalValue: string;
};

const MIN_DB_SIDEBAR = 200;
const MAX_DB_SIDEBAR = 420;

function LoadingTableSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 10 }).map((_, row) => (
        <div key={`row-skel-${row}`} className="h-8 rounded animate-pulse bg-white/[0.08]" />
      ))}
    </div>
  );
}

export function DatabaseTab({ workspaceId }: DatabaseTabProps) {
  const { getToken } = useAuth();
  const [isLoadingMeta, setIsLoadingMeta] = React.useState(true);
  const [metaError, setMetaError] = React.useState<string | null>(null);
  const [hasDatabase, setHasDatabase] = React.useState(false);
  const [maskedUrl, setMaskedUrl] = React.useState<string | null>(null);
  const [showDatabaseUrl, setShowDatabaseUrl] = React.useState(false);
  const [tables, setTables] = React.useState<Array<{ name: string }>>([]);

  const [selectedTable, setSelectedTable] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(25);
  const [isLoadingRows, setIsLoadingRows] = React.useState(false);
  const [rowsError, setRowsError] = React.useState<string | null>(null);
  const [columns, setColumns] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Record<string, unknown>[]>([]);
  const [totalRows, setTotalRows] = React.useState(0);
  const [rowIdField, setRowIdField] = React.useState("__row_id");

  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [sidebarWidth, setSidebarWidth] = React.useState(260);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const [editingCell, setEditingCell] = React.useState<EditingCell | null>(null);
  const [savingCellKey, setSavingCellKey] = React.useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  const fetchMeta = React.useCallback(async () => {
    if (!workspaceId) return;
    setIsLoadingMeta(true);
    setMetaError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/database/meta`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as DatabaseMetaResponse | { error?: string };
      if (!res.ok) {
        throw new Error("error" in data && typeof data.error === "string" ? data.error : "Failed to fetch database metadata");
      }
      if (!("success" in data) || !data.success) throw new Error("Failed to fetch database metadata");

      setHasDatabase(Boolean(data.hasDatabase));
      setMaskedUrl(data.maskedUrl);
      setTables(Array.isArray(data.tables) ? data.tables : []);
      setSelectedTable((prev) => (prev && data.tables.some((t) => t.name === prev) ? prev : data.tables[0]?.name ?? null));
      setPage(1);
    } catch (err: any) {
      setMetaError(err?.message || "Failed to fetch database metadata");
      setHasDatabase(false);
      setTables([]);
      setSelectedTable(null);
    } finally {
      setIsLoadingMeta(false);
    }
  }, [workspaceId]);

  const fetchRows = React.useCallback(async () => {
    if (!workspaceId || !selectedTable) return;
    setIsLoadingRows(true);
    setRowsError(null);
    setEditingCell(null);
    try {
      const params = new URLSearchParams({ table: selectedTable, page: String(page), pageSize: String(pageSize) });
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/database/table?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as DatabaseTableResponse | { error?: string };
      if (!res.ok) {
        throw new Error("error" in data && typeof data.error === "string" ? data.error : "Failed to fetch table data");
      }
      if (!("success" in data) || !data.success) throw new Error("Failed to fetch table data");

      setColumns(Array.isArray(data.columns) ? data.columns : []);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTotalRows(Number.isFinite(data.totalRows) ? data.totalRows : 0);
      setRowIdField(typeof data.rowIdField === "string" ? data.rowIdField : "__row_id");
    } catch (err: any) {
      setRowsError(err?.message || "Failed to fetch table data");
      setColumns([]);
      setRows([]);
      setTotalRows(0);
    } finally {
      setIsLoadingRows(false);
    }
  }, [page, pageSize, selectedTable, workspaceId]);

  const commitCellEdit = React.useCallback(async () => {
    if (!editingCell || !selectedTable) return;
    const nextValue = editingCell.value;
    const originalValue = editingCell.originalValue;
    const cellKey = `${editingCell.rowId}:${editingCell.column}`;

    if (nextValue === originalValue) { setEditingCell(null); return; }

    setSavingCellKey(cellKey);
    setRowsError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/database/table/cell`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ table: selectedTable, rowId: editingCell.rowId, column: editingCell.column, value: nextValue }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; row?: Record<string, unknown> };
      if (!res.ok || !data.success || !data.row) throw new Error(data.error || "Failed to update cell");

      setRows((prev) =>
        prev.map((row) => {
          if (String(row[rowIdField] ?? "") !== editingCell.rowId) return row;
          return data.row as Record<string, unknown>;
        })
      );
      setEditingCell(null);
    } catch (err: any) {
      setRowsError(err?.message || "Failed to update cell");
    } finally {
      setSavingCellKey(null);
    }
  }, [editingCell, rowIdField, selectedTable, workspaceId]);

  React.useEffect(() => { fetchMeta(); }, [fetchMeta]);
  React.useEffect(() => { fetchRows(); }, [fetchRows]);

  React.useEffect(() => {
    if (!isResizingSidebar) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSidebarWidth(Math.min(MAX_DB_SIDEBAR, Math.max(MIN_DB_SIDEBAR, e.clientX - rect.left)));
    };
    const onMouseUp = () => {
      setIsResizingSidebar(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingSidebar]);

  const canEdit = Boolean(selectedTable && rowIdField);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 overflow-hidden bg-[#161616]">
      {/* Sidebar */}
      <aside
        className="shrink-0 border-r border-white/[0.06] bg-[#1a1a1c] overflow-hidden transition-[width,opacity] duration-200"
        style={{ width: sidebarOpen ? sidebarWidth : 0, opacity: sidebarOpen ? 1 : 0 }}
      >
        <div className="h-full p-3 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-white/40">Database</p>
            <div className="flex items-center gap-1">
              {maskedUrl && (
                <GlassButton size="xs" onClick={() => setShowDatabaseUrl((prev) => !prev)}>
                  {showDatabaseUrl ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  DB URL
                </GlassButton>
              )}
              <GlassButton size="xs" onClick={fetchMeta}>
                <RefreshCcw className="w-3 h-3" />
                Refresh
              </GlassButton>
            </div>
          </div>

          {maskedUrl && showDatabaseUrl && (
            <div className="mb-3 flex items-start gap-2 rounded-md px-2 py-1 bg-white/[0.05] text-white/50">
              <p className="min-w-0 flex-1 break-all text-[10px]">{maskedUrl}</p>
            </div>
          )}

          {isLoadingMeta && (
            <div className="space-y-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={`table-skel-${i}`} className="h-8 rounded-md animate-pulse bg-white/[0.08]" />
              ))}
            </div>
          )}

          {!isLoadingMeta && metaError && (
            <div className="flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/[0.08] p-2">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-red-400">{metaError}</p>
            </div>
          )}

          {!isLoadingMeta && !metaError && !hasDatabase && (
            <p className="text-[11px] text-white/40">No database configured for this workspace.</p>
          )}

          {!isLoadingMeta && hasDatabase && tables.length === 0 && (
            <p className="text-[11px] text-white/40">No tables found.</p>
          )}

          {!isLoadingMeta && hasDatabase && tables.length > 0 && (
            <div className="space-y-1">
              {tables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  onClick={() => { setSelectedTable(table.name); setPage(1); }}
                  className={cn(
                    "w-full flex items-center rounded-lg px-2 py-2 text-left text-[12px] border transition-colors",
                    selectedTable === table.name
                      ? "bg-white/[0.12] border-white/20 text-white"
                      : "border-white/[0.06] text-white/60 hover:bg-white/[0.06] hover:text-white/90"
                  )}
                >
                  <span className="truncate">{table.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Resize handle */}
      {sidebarOpen && (
        <div
          onMouseDown={(e) => { e.preventDefault(); setIsResizingSidebar(true); }}
          className="w-1 shrink-0 cursor-col-resize border-l border-r border-white/[0.05] bg-transparent hover:bg-white/[0.08] transition-colors"
        />
      )}

      {/* Main content */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-11 border-b border-white/[0.06] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <GlassButton size="xs" onClick={() => setSidebarOpen((prev) => !prev)}>
              {sidebarOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}
              {sidebarOpen ? "Hide" : "Tables"}
            </GlassButton>
            <p className="text-[12px] font-medium text-white/70 truncate">
              {selectedTable ? `Table: ${selectedTable}` : "Select a table"}
            </p>
          </div>
          {selectedTable && (
            <p className="text-[11px] text-white/35 shrink-0">{totalRows} rows</p>
          )}
        </header>

        {/* Table area */}
        <div className="flex-1 min-h-0 overflow-auto scrollbar-thin scrollbar-thumb-white/10">
          {isLoadingRows && <LoadingTableSkeleton />}

          {!isLoadingRows && rowsError && (
            <div className="p-4">
              <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-400/[0.08] p-3">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-[12px] text-red-400">{rowsError}</p>
              </div>
            </div>
          )}

          {!isLoadingRows && !rowsError && selectedTable && columns.length > 0 && (
            <table className="w-full text-[12px] border-collapse">
              <thead className="sticky top-0 z-10 bg-[#161819]">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col}
                      className="px-3 py-2 text-left font-semibold text-white/60 border-b border-white/[0.08] whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const rowId = String(row[rowIdField] ?? "");
                  return (
                    <tr
                      key={`${selectedTable}-row-${rowId || index}`}
                      className="hover:bg-white/[0.03] transition-colors"
                    >
                      {columns.map((col) => {
                        const cellKey = `${rowId}:${col}`;
                        const rowValue = row[col];
                        const displayValue =
                          rowValue == null ? "null" : typeof rowValue === "object" ? JSON.stringify(rowValue) : String(rowValue);
                        const isEditing = editingCell?.rowId === rowId && editingCell?.column === col;
                        const isSaving = savingCellKey === cellKey;

                        return (
                          <td
                            key={`${selectedTable}-row-${rowId || index}-col-${col}`}
                            className="px-3 py-2 align-top max-w-[360px] border-b border-white/[0.05] text-white/70"
                            onDoubleClick={() => {
                              if (!canEdit || !rowId) return;
                              setEditingCell({ rowId, rowIndex: index, column: col, value: displayValue, originalValue: displayValue });
                            }}
                            title={displayValue}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editingCell.value}
                                onChange={(e) => setEditingCell((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); commitCellEdit(); }
                                  if (e.key === "Escape") setEditingCell(null);
                                }}
                                onBlur={() => { void commitCellEdit(); }}
                                className="w-full h-7 px-2 rounded-md border border-white/20 bg-white/[0.08] text-[11px] text-white outline-none focus:border-brand-pink/40 transition-colors"
                              />
                            ) : (
                              <span className={cn("block truncate", !canEdit ? "opacity-70" : "cursor-text", isSaving && "opacity-50")}>
                                {displayValue}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {!isLoadingRows && !rowsError && selectedTable && columns.length === 0 && (
            <div className="h-full flex items-center justify-center">
              <p className="text-[12px] text-white/35">No columns found.</p>
            </div>
          )}

          {!isLoadingRows && !rowsError && !selectedTable && (
            <div className="h-full flex items-center justify-center">
              <p className="text-[12px] text-white/35">Pick a table from the left.</p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {selectedTable && totalRows > 0 && (
          <footer className="h-12 border-t border-white/[0.06] px-4 flex items-center justify-between shrink-0">
            <p className="text-[11px] text-white/40">Page {page} of {totalPages}</p>
            <div className="flex items-center gap-2">
              <GlassButton size="xs" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                <ChevronLeft className="w-3 h-3" />
                Prev
              </GlassButton>
              <GlassButton size="xs" disabled={page >= totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
                Next
                <ChevronRight className="w-3 h-3" />
              </GlassButton>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
