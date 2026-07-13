/**
 * @module importService
 * @description Orchestrates the GitHub repo import flow:
 *   1. Resolves the GitHub access token from the DB
 *   2. Validates repo access via the GitHub API
 *   3. Provisions an E2B sandbox with the hybrid-import template
 *   4. Clones the repo into the sandbox — token passed as env var, never printed
 *   5. Returns sandboxId + clonePath
 */

import { Sandbox } from '@e2b/code-interpreter';
import { getGithubAccount, validateRepoAccess } from './githubService';
import { scrubTokens } from '../utils/tokenScrubber';

const HYBRID_IMPORT_TEMPLATE = process.env.E2B_HYBRID_IMPORT_TEMPLATE_ID || 'o8iy834vb29xbqwsojyl';
const CLONE_BASE = '/workspace/repo';

export interface ImportInput {
  clerkUserId: string;
  owner: string;
  repo: string;
  branch?: string;
}

export interface ImportResult {
  sandboxId: string;
  clonePath: string;
  repoMeta: {
    owner: string;
    repo: string;
    branch: string;
    private: boolean;
    defaultBranch: string;
  };
}

/**
 * Provision a sandbox and clone the given GitHub repo into it.
 * The GitHub token is injected as an environment variable so it
 * does not appear in any command string, log, or streamed output.
 */
export async function provisionAndClone(input: ImportInput): Promise<ImportResult> {
  const { clerkUserId, owner, repo, branch } = input;

  // 1. Resolve token from DB
  const account = await getGithubAccount(clerkUserId);
  if (!account || !account.accessToken) {
    throw new Error('GitHub account not connected. Please connect GitHub in Settings first.');
  }

  const token = account.accessToken;

  // 2. Validate access + get metadata
  const meta = await validateRepoAccess(token, owner, repo);
  const targetBranch = branch || meta.defaultBranch;

  console.log(`[ImportService] Validated access to ${owner}/${repo} (branch: ${targetBranch}, private: ${meta.private})`);

  // 3. Provision sandbox — token is injected as env var, NEVER in command strings
  console.log(`[ImportService] Creating sandbox with template: ${HYBRID_IMPORT_TEMPLATE}`);
  const sandbox = await Sandbox.create(HYBRID_IMPORT_TEMPLATE, {
    timeoutMs: 30 * 60 * 1000, // 30 minutes for import sessions
    lifecycle: { onTimeout: 'pause' },
    envs: {
      // Token injected only as env — used by git credential helper
      GITHUB_TOKEN: token,
      REPO_OWNER: owner,
      REPO_NAME: repo,
      REPO_BRANCH: targetBranch,
    },
  });

  const sandboxId = sandbox.sandboxId;
  console.log(`[ImportService] Sandbox created: ${sandboxId}`);

  // 4. Configure git credential helper so the token is never in the clone URL
  const gitConfigResult = await sandbox.commands.run(
    `git config --global credential.helper store && ` +
    `echo "https://${owner}:${token}@github.com" > ~/.git-credentials`,
    { timeoutMs: 15_000 },
  );

  if (gitConfigResult.exitCode !== 0) {
    const err = scrubTokens(gitConfigResult.stderr || 'unknown error');
    throw new Error(`Failed to configure git credentials: ${err}`);
  }

  // 5. Clone using credential helper (token not in URL string visible in process list)
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  console.log(`[ImportService] Cloning ${cloneUrl} → ${CLONE_BASE}`);

  // Remove any pre-existing directory the template may have created so
  // git clone doesn't refuse a non-empty / already-existing destination.
  await sandbox.commands.run(`rm -rf ${CLONE_BASE}`, { timeoutMs: 10_000 });

  const cloneResult = await sandbox.commands.run(
    `git clone --depth=50 --branch ${targetBranch} ${cloneUrl} ${CLONE_BASE}`,
    { timeoutMs: 120_000 },
  );

  if (cloneResult.exitCode !== 0) {
    const err = scrubTokens(cloneResult.stderr || 'Clone failed with no output');
    throw new Error(`Git clone failed: ${err}`);
  }

  console.log(`[ImportService] Clone complete for ${owner}/${repo} in sandbox ${sandboxId}`);

  // 6. Clean up credentials from disk immediately after clone
  await sandbox.commands.run('rm -f ~/.git-credentials && git config --global --unset credential.helper || true');

  return {
    sandboxId,
    clonePath: CLONE_BASE,
    repoMeta: {
      owner,
      repo,
      branch: targetBranch,
      private: meta.private,
      defaultBranch: meta.defaultBranch,
    },
  };
}
