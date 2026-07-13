import { prisma } from '../lib/prisma';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';

// ── Token Exchange ─────────────────────────────────────────────────────────────

/**
 * Exchange a one-time GitHub OAuth code for a persistent access token.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange request failed with HTTP ${response.status}`);
  }

  const data = await response.json() as { access_token?: string; error?: string };
  const { access_token, error } = data;

  if (error || !access_token) {
    throw new Error(`GitHub token exchange failed: ${error ?? 'no access_token returned'}`);
  }

  return access_token;
}

// ── GitHub API ─────────────────────────────────────────────────────────────────

/**
 * Fetch the authenticated GitHub user's profile.
 */
export async function getGithubUser(accessToken: string): Promise<{ login: string; id: number }> {
  const response = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<{ login: string; id: number }>;
}

// ── Database ───────────────────────────────────────────────────────────────────

/**
 * Upsert a GithubAccount record for the given Clerk user.
 * Ensures the User record exists first (creates if missing).
 */
export async function saveGithubAccount(
  clerkUserId: string,
  accessToken: string,
  username: string
) {
  // Ensure the User record exists (sync from Clerk if needed)
  await prisma.user.upsert({
    where: { clerkId: clerkUserId },
    update: {},
    create: { clerkId: clerkUserId },
  });

  // Now safely upsert the GithubAccount
  return prisma.githubAccount.upsert({
    where: { clerkUserId },
    update: { accessToken, username },
    create: { clerkUserId, accessToken, username },
  });
}

/**
 * Return the stored GithubAccount for the given Clerk user, or null if not connected.
 */
export async function getGithubAccount(clerkUserId: string) {
  return prisma.githubAccount.findUnique({
    where: { clerkUserId },
  });
}

/**
 * Remove the stored GithubAccount for the given Clerk user.
 */
export async function deleteGithubAccount(clerkUserId: string) {
  try {
    await prisma.githubAccount.delete({
      where: { clerkUserId },
    });
  } catch {
    // Already deleted or never existed — that's fine
  }
}

/**
 * Fetch the authenticated user's repositories from GitHub.
 */
export async function listRepositories(accessToken: string) {
  const response = await fetch(`${GITHUB_API_URL}/user/repos?sort=updated&per_page=100`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    console.error(`GitHub Repos API error: ${response.status} - ${errorDetails}`);
    throw new Error(`GitHub Repos API request failed with HTTP ${response.status}`);
  }

  const repos = await response.json() as any[];
  return repos.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    cloneUrl: repo.clone_url,
    owner: repo.owner?.login,
    defaultBranch: repo.default_branch,
    private: repo.private,
    language: repo.language,
  }));
}

// ── Import Flow ────────────────────────────────────────────────────────────────

export interface RepoMeta {
  private: boolean;
  defaultBranch: string;
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
  language: string | null;
  description: string | null;
}

/**
 * Confirm the token has at minimum read access to the given repo.
 * Returns basic repo metadata used by the import flow.
 */
export async function validateRepoAccess(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<RepoMeta> {
  const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (response.status === 404) {
    throw new Error(
      `Repository ${owner}/${repo} not found or the connected GitHub account does not have access. ` +
      `Please ensure the repository exists and your GitHub connection has repo scope.`,
    );
  }

  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status} when checking repo access.`);
  }

  const data = await response.json() as any;

  return {
    private: data.private ?? false,
    defaultBranch: data.default_branch ?? 'main',
    permissions: data.permissions ?? null,
    language: data.language ?? null,
    description: data.description ?? null,
  };
}
