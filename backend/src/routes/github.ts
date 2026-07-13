import { Router, Request, Response } from 'express';
import {
  exchangeCodeForToken,
  getGithubUser,
  saveGithubAccount,
  getGithubAccount,
  deleteGithubAccount,
  listRepositories,
  validateRepoAccess,
} from '../services/githubService';
import { workspaceService } from '../services/workspaceService';

const router = Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── GET /api/github/connect ────────────────────────────────────────────────────
// Kick off the OAuth flow. Reads the Clerk user ID from the request header and
// embeds it as the `state` parameter so we can identify the user on callback.
router.get('/connect', (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const returnTo = req.query.returnTo as string | undefined;
  const state = JSON.stringify({ userId: clerkUserId, returnTo: returnTo ?? null });

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? '',
    redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:8000'}/api/github/callback`,
    scope: 'repo read:user user:email',
    state,
  });

  res.json({ url: `${GITHUB_AUTHORIZE_URL}?${params.toString()}` });
});

// ── GET /api/github/callback ───────────────────────────────────────────────────
// GitHub redirects here with `?code=...&state=<clerkUserId>`.
// Exchange the code for a token, fetch the GitHub username, persist to DB,
// then redirect the browser back to the frontend settings page.
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.status(400).send('Missing code or state parameter from GitHub callback.');
    return;
  }

  let clerkUserId: string;
  let returnTo: string | null = null;
  try {
    const parsed = JSON.parse(state);
    clerkUserId = parsed.userId;
    returnTo = parsed.returnTo ?? null;
  } catch {
    // Legacy plain-string state (backwards compat)
    clerkUserId = state;
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const githubUser = await getGithubUser(accessToken);
    await saveGithubAccount(clerkUserId, accessToken, githubUser.login);

    console.log(`[GitHub OAuth] Connected @${githubUser.login} for user ${clerkUserId}`);

    const dest = returnTo ?? `${FRONTEND_URL}/settings?github=connected`;
    res.redirect(dest);
  } catch (error) {
    console.error('[GitHub OAuth] Callback error:', error);
    const errDest = returnTo
      ? `${returnTo}&github-oauth=error`
      : `${FRONTEND_URL}/settings?github=error`;
    res.redirect(errDest);
  }
});

// ── GET /api/github/status ────────────────────────────────────────────────────
// Returns { isConnected: boolean, username?: string } for the current user.
router.get('/status', async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    res.json({ isConnected: false });
    return;
  }

  try {
    const account = await getGithubAccount(clerkUserId);

    if (account) {
      res.json({ isConnected: true, username: account.username });
    } else {
      res.json({ isConnected: false });
    }
  } catch (error) {
    console.error('[GitHub OAuth] Status check error:', error);
    res.status(500).json({ error: 'Failed to check GitHub connection status' });
  }
});

// ── GET /api/github/repos ─────────────────────────────────────────────────────
// Returns an array of real repositories for the connected GitHub account.
router.get('/repos', async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const account = await getGithubAccount(clerkUserId);
    if (!account || !account.accessToken) {
      res.status(404).json({ error: 'GitHub account not connected' });
      return;
    }

    const repos = await listRepositories(account.accessToken);
    res.json(repos);
  } catch (error: any) {
    console.error('[GitHub API] Repos fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch repositories from GitHub' });
  }
});

// ── POST /api/github/import ────────────────────────────────────────────────────
// Creates a workspace record for a GitHub repo import, validates access,
// and returns workspaceId. Actual sandbox provisioning + clone happens
// asynchronously via the WebSocket handleGitHubImportSetup flow.
router.post('/import', async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { owner, repo, branch, appPath } = req.body as {
    owner?: string;
    repo?: string;
    branch?: string;
    appPath?: string;
  };

  if (!owner || !repo) {
    res.status(400).json({ error: 'owner and repo are required' });
    return;
  }

  try {
    // Resolve token
    const account = await getGithubAccount(clerkUserId);
    if (!account || !account.accessToken) {
      res.status(403).json({ error: 'GitHub account not connected. Connect GitHub in Settings first.' });
      return;
    }

    // Validate repo access (throws with a clear message on 404/403)
    const meta = await validateRepoAccess(account.accessToken, owner, repo);
    const targetBranch = branch || meta.defaultBranch;

    console.log(`[GitHub Import] ${clerkUserId} importing ${owner}/${repo}@${targetBranch}`);

    // Create workspace record — sandboxId left null; WS flow will populate it
    const workspace = await workspaceService.createWorkspace({
      userId: clerkUserId,
      name: repo,
      idea: `GitHub import: ${owner}/${repo}`,
      framework: 'github-import',
      language: meta.language || 'JavaScript',
      database: 'None',
      summary: meta.description || `Imported from github.com/${owner}/${repo}`,
    });

    // Embed github import metadata in config via a direct update
    // (createWorkspace stores idea/framework in config; we layer in source data)
    const { prisma } = await import('../lib/prisma');
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        config: {
          idea: `GitHub import: ${owner}/${repo}`,
          framework: 'github-import',
          language: meta.language || 'JavaScript',
          database: 'None',
          // Import-specific fields
          source: 'github',
          owner,
          repo,
          branch: targetBranch,
          appPath: appPath || null,
          defaultBranch: meta.defaultBranch,
          private: meta.private,
        },
      },
    });

    res.json({
      workspaceId: workspace.id,
      owner,
      repo,
      branch: targetBranch,
    });
  } catch (error: any) {
    console.error('[GitHub Import] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to create import workspace' });
  }
});

// ── POST /api/github/disconnect ────────────────────────────────────────────────
// Removes the stored access token from the database and clears workspace GitHub state.
router.post('/disconnect', async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Delete GitHub account
    await deleteGithubAccount(clerkUserId);

    // Clear GitHub state from all user's workspaces
    const { prisma } = await import('../lib/prisma');
    await prisma.workspace.updateMany({
      where: { user: { clerkId: clerkUserId } },
      data: {
        githubConnected: false,
        githubOwner: null,
        githubRepo: null,
        githubHeadSha: null,
        githubTreeSha: null,
        config: { lastGithubError: null } as any,
      },
    });

    console.log(`[GitHub OAuth] Disconnected GitHub for user ${clerkUserId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[GitHub OAuth] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect GitHub account' });
  }
});

export default router;
