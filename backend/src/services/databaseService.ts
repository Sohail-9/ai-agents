import "../env";
import { prisma } from "../lib/prisma";
import { Pool } from "pg";

function sanitizeDatabaseName(input: string) {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = base.slice(0, 40);
  return trimmed.length > 0 ? trimmed : `app_db`;
}

// Connect to the default 'postgres' admin database to run CREATE DATABASE
function getAdminConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[DatabaseService] DATABASE_URL not set");
  // Swap the database name in the URL for 'postgres' (the admin/default db)
  return url.replace(/(\/\/[^/]+\/)([^?]+)/, "$1postgres");
}

function buildDatabaseUrl(dbName: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[DatabaseService] DATABASE_URL not set");
  return url.replace(/(\/\/[^/]+\/)([^?]+)/, `$1${dbName}`);
}

async function createDatabase(dbName: string): Promise<void> {
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error("[DatabaseService] Invalid database name");
  }

  const pool = new Pool({ connectionString: getAdminConnectionString() });
  try {
    const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rows.length > 0) {
      console.log(`[DatabaseService] Database ${dbName} already exists`);
      return;
    }
    // CREATE DATABASE cannot run inside a transaction — pg runs in autocommit by default
    await pool.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[DatabaseService] Database ${dbName} created on Azure PostgreSQL`);
  } finally {
    await pool.end();
  }
}

export async function provisionWorkspaceDatabase(input: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
}) {
  const shortId = input.workspaceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "workspace";
  const databaseName = sanitizeDatabaseName(`app_${shortId}`);

  await createDatabase(databaseName);
  const databaseUrl = buildDatabaseUrl(databaseName);

  await prisma.database.upsert({
    where: { workspaceId: input.workspaceId },
    update: { userId: input.userId, url: databaseUrl },
    create: { workspaceId: input.workspaceId, userId: input.userId, url: databaseUrl },
  });

  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: { databaseUrl },
  });

  return { databaseName, databaseUrl };
}
