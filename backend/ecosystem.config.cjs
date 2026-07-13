/**
 * PM2 process map for ai-agents-core.
 *
 *   pm2 start ecosystem.config.cjs
 *
 * Workers are split by WORKER_KIND so a stalled agent run cannot block
 * setup/import/coregit pickup. Concurrency stays per-process; total
 * concurrent agent runs = instances × WORKER_CONCURRENCY.
 *
 * Override per-env via PM2_*:
 *   PM2_AGENT_INSTANCES=8 pm2 start ecosystem.config.cjs
 */

const env = (k, fallback) => process.env[k] ?? fallback;

module.exports = {
  apps: [
    {
      name: "ai-agents-api",
      script: "dist/src/index.js",
      instances: Number(env("PM2_API_INSTANCES", 1)),
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        PG_POOL_MAX: env("PG_POOL_MAX_API", "30"),
      },
    },

    {
      name: "agent-worker",
      script: "dist/src/workers/index.js",
      instances: Number(env("PM2_AGENT_INSTANCES", 4)),
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "agent",
        WORKER_CONCURRENCY: env("WORKER_CONCURRENCY", "50"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "80"),
      },
    },

    {
      name: "setup-worker",
      script: "dist/src/workers/index.js",
      instances: Number(env("PM2_SETUP_INSTANCES", 2)),
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "setup",
        SETUP_WORKER_CONCURRENCY: env("SETUP_WORKER_CONCURRENCY", "20"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "80"),
      },
    },

    {
      name: "import-worker",
      script: "dist/src/workers/index.js",
      instances: Number(env("PM2_IMPORT_INSTANCES", 1)),
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "import",
        IMPORT_WORKER_CONCURRENCY: env("IMPORT_WORKER_CONCURRENCY", "15"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "80"),
      },
    },

    {
      name: "coregit-worker",
      script: "dist/src/workers/index.js",
      instances: Number(env("PM2_COREGIT_INSTANCES", 1)),
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "coregit",
        COREGIT_WORKER_CONCURRENCY: env("COREGIT_WORKER_CONCURRENCY", "25"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "80"),
      },
    },

    {
      name: "github-sync-worker",
      script: "dist/src/workers/index.js",
      instances: 1,
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "github-sync",
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "30"),
      },
    },

    {
      // Singleton — only one process should reap idle sandboxes
      name: "sandbox-reaper",
      script: "dist/src/workers/index.js",
      instances: 1,
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "reaper",
        SANDBOX_REAPER_INTERVAL_MS: env("SANDBOX_REAPER_INTERVAL_MS", String(15 * 60 * 1000)),
        SANDBOX_IDLE_TTL_SEC: env("SANDBOX_IDLE_TTL_SEC", String(60 * 60)),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "30"),
      },
    },

    {
      // Singleton — only one process should provision warm sandboxes
      name: "sandbox-prewarm",
      script: "dist/src/workers/index.js",
      instances: 1,
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "prewarm",
        PREWARM_INTERVAL_MS: env("PREWARM_INTERVAL_MS", "60000"),
        PREWARM_MIN_SIZE: env("PREWARM_MIN_SIZE", "3"),
        PREWARM_MAX_SIZE: env("PREWARM_MAX_SIZE", "10"),
        PREWARM_MAX_AGE_MS: env("PREWARM_MAX_AGE_MS", String(10 * 60 * 1000)),
        PREWARM_FRAMEWORKS: env("PREWARM_FRAMEWORKS", "Next.js"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "30"),
      },
    },

    {
      name: "support-worker",
      script: "dist/src/workers/index.js",
      instances: 1,
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "support",
        SUPPORT_WORKER_CONCURRENCY: env("SUPPORT_WORKER_CONCURRENCY", "10"),
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "30"),
      },
    },

    {
      // Singleton — handles credit finalization + reserve cleanup loop
      name: "billing-worker",
      script: "dist/src/workers/index.js",
      instances: 1,
      exec_mode: "cluster",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        WORKER_KIND: "billing",
        PG_POOL_MAX: env("PG_POOL_MAX_WORKER", "30"),
      },
    },
  ],
};
