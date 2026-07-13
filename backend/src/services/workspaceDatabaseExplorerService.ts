import { Pool } from "pg";
import { prisma } from "../lib/prisma";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type TableMeta = {
  name: string;
};

type WorkspaceDatabaseMeta = {
  workspaceId: string;
  hasDatabase: boolean;
  maskedUrl: string | null;
  tables: TableMeta[];
};

type WorkspaceDatabaseStats = {
  sizeBytes: number;
  sizeGB: number;
  maxSizeGB: number;
  activeConnections: number;
  maxConnections: number;
  cacheHitRatio: number;
  tableCount: number;
  totalRows: number;
};

type WorkspaceTableData = {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
  rowIdField: string;
};

function maskConnectionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    if (parsed.username) parsed.username = "****";
    return parsed.toString();
  } catch {
    return "masked";
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error("Invalid table identifier");
  }
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function normalizePage(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function normalizePageSize(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

async function getWorkspaceDatabaseUrl(workspaceId: string): Promise<string | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      databaseUrl: true,
      env: true,
      database: {
        select: { url: true },
      },
    },
  });

  if (!workspace) return null;

  // Check direct field, related model, then env store (set via env_manager)
  if (workspace.databaseUrl) return workspace.databaseUrl;
  if (workspace.database?.url) return workspace.database.url;

  const envStore = workspace.env as Record<string, { value?: string }> | null;
  const envDbUrl = envStore?.["DATABASE_URL"]?.value;
  if (envDbUrl && envDbUrl.startsWith("postgresql")) return envDbUrl;

  return null;
}

async function withWorkspacePool<T>(databaseUrl: string, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function listTables(pool: Pool): Promise<TableMeta[]> {
  const result = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `
  );

  return result.rows.map((row) => ({ name: row.table_name }));
}

type ColumnInfo = { name: string; dataType: string };

async function listColumns(pool: Pool, tableName: string): Promise<ColumnInfo[]> {
  const result = await pool.query<{ column_name: string; data_type: string }>(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName]
  );
  return result.rows.map((row) => ({ name: row.column_name, dataType: row.data_type }));
}

function parseValueByType(value: unknown, dataType: string): unknown {
  if (value === null) return null;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "null") return null;

  const numberTypes = new Set([
    "smallint",
    "integer",
    "bigint",
    "numeric",
    "real",
    "double precision",
    "decimal",
  ]);

  if (numberTypes.has(dataType)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${dataType}`);
    return n;
  }

  if (dataType === "boolean") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") return true;
    if (lc === "false" || lc === "0") return false;
    throw new Error("Invalid boolean value");
  }

  if (dataType.includes("json")) {
    return JSON.parse(value);
  }

  return value;
}

export const workspaceDatabaseExplorerService = {
  async getMeta(workspaceId: string): Promise<WorkspaceDatabaseMeta | null> {
    const databaseUrl = await getWorkspaceDatabaseUrl(workspaceId);
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) return null;

    if (!databaseUrl) {
      return {
        workspaceId,
        hasDatabase: false,
        maskedUrl: null,
        tables: [],
      };
    }

    const tables = await withWorkspacePool(databaseUrl, (pool) => listTables(pool));
    return {
      workspaceId,
      hasDatabase: true,
      maskedUrl: maskConnectionUrl(databaseUrl),
      tables,
    };
  },

  async getTableData(
    workspaceId: string,
    tableName: string,
    pageInput?: unknown,
    pageSizeInput?: unknown
  ): Promise<WorkspaceTableData | null> {
    const databaseUrl = await getWorkspaceDatabaseUrl(workspaceId);
    if (!databaseUrl) return null;

    const page = normalizePage(pageInput);
    const pageSize = normalizePageSize(pageSizeInput);
    const offset = (page - 1) * pageSize;

    return withWorkspacePool(databaseUrl, async (pool) => {
      const tables = await listTables(pool);
      const tableExists = tables.some((table) => table.name === tableName);
      if (!tableExists) {
        throw new Error(`Table "${tableName}" does not exist in workspace database`);
      }

      const quotedTable = quoteIdentifier(tableName);
      const columns = (await listColumns(pool, tableName)).map((row) => row.name);

      const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text as total FROM ${quotedTable}`
      );
      const totalRows = Number(countResult.rows[0]?.total || "0");

      const rowsResult = await pool.query<Record<string, unknown>>(
        `SELECT ctid::text AS "__row_id", * FROM ${quotedTable} LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      );

      return {
        table: tableName,
        columns,
        rows: rowsResult.rows,
        totalRows,
        page,
        pageSize,
        rowIdField: "__row_id",
      };
    });
  },

  async updateCell(input: {
    workspaceId: string;
    table: string;
    rowId: string;
    column: string;
    value: unknown;
  }): Promise<{ row: Record<string, unknown>; rowIdField: string } | null> {
    const databaseUrl = await getWorkspaceDatabaseUrl(input.workspaceId);
    if (!databaseUrl) return null;

    return withWorkspacePool(databaseUrl, async (pool) => {
      const tables = await listTables(pool);
      const tableExists = tables.some((table) => table.name === input.table);
      if (!tableExists) throw new Error(`Table "${input.table}" does not exist in workspace database`);

      const columns = await listColumns(pool, input.table);
      const colInfo = columns.find((column) => column.name === input.column);
      if (!colInfo) throw new Error(`Column "${input.column}" does not exist`);

      const parsedValue = parseValueByType(input.value, colInfo.dataType);
      const quotedTable = quoteIdentifier(input.table);
      const quotedColumn = quoteIdentifier(input.column);

      const result = await pool.query<Record<string, unknown>>(
        `UPDATE ${quotedTable} SET ${quotedColumn} = $1 WHERE ctid = $2::tid RETURNING ctid::text AS "__row_id", *`,
        [parsedValue, input.rowId]
      );
      if (!result.rows[0]) {
        throw new Error("Row not found for update");
      }

      return { row: result.rows[0], rowIdField: "__row_id" };
    });
  },

  async getStats(workspaceId: string): Promise<WorkspaceDatabaseStats | null> {
    const databaseUrl = await getWorkspaceDatabaseUrl(workspaceId);
    if (!databaseUrl) return null;

    return withWorkspacePool(databaseUrl, async (pool) => {
      const [sizeResult, cacheResult, connResult, tableResult] = await Promise.all([
        // Database size in bytes
        pool.query<{ size_bytes: string }>(
          `SELECT pg_database_size(current_database()) AS size_bytes`
        ),
        // Cache hit ratio from pg_stat_database
        pool.query<{ cache_hit_ratio: string }>(
          `SELECT
             CASE WHEN blks_hit + blks_read = 0 THEN 100
                  ELSE round(blks_hit::numeric * 100 / (blks_hit + blks_read), 1)
             END AS cache_hit_ratio
           FROM pg_stat_database
           WHERE datname = current_database()`
        ),
        // Active client connections vs max_connections
        pool.query<{ active_connections: string; max_connections: string }>(
          `SELECT
             count(*) FILTER (WHERE state != 'idle' AND backend_type = 'client backend') AS active_connections,
             (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections
           FROM pg_stat_activity
           WHERE datname = current_database()`
        ),
        // Table count and estimated total live rows
        pool.query<{ table_count: string; total_rows: string }>(
          `SELECT
             (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS table_count,
             COALESCE((SELECT sum(n_live_tup)::bigint FROM pg_stat_user_tables), 0) AS total_rows`
        ),
      ]);

      const sizeBytes = Number(sizeResult.rows[0]?.size_bytes ?? 0);
      const maxSizeGB = Number(process.env.DB_MAX_SIZE_GB ?? 0.5);

      return {
        sizeBytes,
        sizeGB: Math.round((sizeBytes / 1_073_741_824) * 1000) / 1000,
        maxSizeGB,
        activeConnections: Number(connResult.rows[0]?.active_connections ?? 0),
        maxConnections: Number(connResult.rows[0]?.max_connections ?? 100),
        cacheHitRatio: Number(cacheResult.rows[0]?.cache_hit_ratio ?? 0),
        tableCount: Number(tableResult.rows[0]?.table_count ?? 0),
        totalRows: Number(tableResult.rows[0]?.total_rows ?? 0),
      };
    });
  },
};
