import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { prisma } from "../lib/prisma";

export function getOctokit(): Octokit {
  const appId = process.env.GITHUB_APP_ID!;
  const privateKey = (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const installationId = parseInt(process.env.GITHUB_APP_INSTALLATION_ID!, 10);

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });
}

/**
 * Create a repo under the authenticated user's personal account.
 * Always uses /user/repos endpoint to avoid org restrictions and permissions issues.
 * Returns both owner and repo name.
 */
export async function createRepoWithUserToken(
  userAccessToken: string,
  repoName: string,
): Promise<{ owner: string; repo: string }> {
  const headers = {
    Authorization: `Bearer ${userAccessToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ name: repoName, private: true, auto_init: true });

  const userRes = await fetch(`https://api.github.com/user/repos`, {
    method: "POST",
    headers,
    body,
  });

  if (userRes.ok) {
    const repoData = await userRes.json() as { owner: { login: string } };
    const owner = repoData.owner.login;
    console.log(`[GitHubSync] Repo created: ${owner}/${repoName}`);
    return { owner, repo: repoName };
  }

  if (userRes.status === 422) {
    // Repo exists — verify ownership
    const meRes = await fetch("https://api.github.com/user", { headers });
    if (!meRes.ok) throw new Error("Cannot verify token ownership");
    const me = await meRes.json() as { login: string };

    const getRes = await fetch(`https://api.github.com/repos/${me.login}/${repoName}`, { headers });
    if (getRes.ok) {
      console.log(`[GitHubSync] Repo already exists: ${me.login}/${repoName}`);
      return { owner: me.login, repo: repoName };
    }
    throw new Error(`Repo exists but not accessible to ${me.login}`);
  }

  if (userRes.status === 401) {
    throw new Error("GitHub token expired or invalid — reconnect your account");
  }
  if (userRes.status === 403) {
    throw new Error("GitHub permission denied — check account access");
  }

  const errBody = await userRes.text().catch(() => "");
  throw new Error(`GitHub API error ${userRes.status}: ${errBody}`);
}

/** @deprecated Use createRepoWithUserToken instead */
export async function createRepo(owner: string, repoName: string): Promise<void> {
  // Legacy: kept for backwards compat — routes through App Octokit which only works for orgs.
  const octokit = getOctokit();
  try {
    await octokit.repos.createInOrg({ org: owner, name: repoName, private: true, auto_init: true });
    console.log(`[GitHubSync] Repo created in org (app): ${owner}/${repoName}`);
  } catch (err: any) {
    if (err.status === 422) { return; }
    throw err;
  }
}

export async function pushCommit(
  workspaceId: string,
  snapshot: { files: Array<{ path: string; content: string | null }>; commitMessage: string },
  userAccessToken: string,
): Promise<string | null> {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        githubOwner: true,
        githubRepo: true,
        githubHeadSha: true,
        githubTreeSha: true,
      },
    });

    if (!ws?.githubOwner || !ws?.githubRepo) {
      console.warn(`[GitHubSync] Workspace ${workspaceId} missing githubOwner/githubRepo`);
      return null;
    }

    const octokit = new Octokit({ auth: userAccessToken });
    const owner = ws.githubOwner;
    const repo = ws.githubRepo;

    // OPT-1: use cached shas, fall back to API only if missing
    let headSha = ws.githubHeadSha;
    let baseTreeSha = ws.githubTreeSha;

    if (snapshot.files.length === 0) {
      console.warn(`[GitHubSync] Skipping empty snapshot for workspace ${workspaceId}`);
      return null;
    }

    if (!headSha || !baseTreeSha) {
      try {
        const ref = await octokit.git.getRef({ owner, repo, ref: "heads/main" });
        headSha = ref.data.object.sha;
      } catch (err: any) {
        if (err.status === 404) {
          try {
            const ref = await octokit.git.getRef({ owner, repo, ref: "heads/master" });
            headSha = ref.data.object.sha;
          } catch (masterErr) {
            throw new Error(`No main or master branch found for ${owner}/${repo}`);
          }
        } else {
          throw err;
        }
      }

      const commit = await octokit.git.getCommit({ owner, repo, commit_sha: headSha });
      baseTreeSha = commit.data.tree.sha;
    }

    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: snapshot.files.map((f) => {
        if (f.content === null) {
          return {
            path: f.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: null,
          };
        }
        return {
          path: f.path,
          mode: "100644" as const,
          type: "blob" as const,
          content: f.content,
        };
      }),
    });

    const newCommit = await octokit.git.createCommit({
      owner,
      repo,
      message: snapshot.commitMessage.slice(0, 200),
      tree: tree.data.sha,
      parents: [headSha],
      author: { name: "AI Agents Agent", email: "agent@ai-agents.com" },
    });

    // Update ref — try main first, fall back to master
    try {
      await octokit.git.updateRef({
        owner,
        repo,
        ref: "heads/main",
        sha: newCommit.data.sha,
      });
    } catch (err: any) {
      if (err.status === 422 || err.status === 404) {
        // main branch might not exist, try master
        await octokit.git.updateRef({
          owner,
          repo,
          ref: "heads/master",
          sha: newCommit.data.sha,
        });
      } else {
        throw err;
      }
    }

    // Cache new shas for OPT-1 on next push
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { githubHeadSha: newCommit.data.sha, githubTreeSha: tree.data.sha },
    });

    return newCommit.data.sha;
  } catch (err: any) {
    console.error(`[GitHubSync] pushCommit failed for workspace ${workspaceId}:`, err.message);
    return null;
  }
}

export async function bulkPushHistory(
  workspaceId: string,
  snapshots: Array<{ id: string; files: unknown; commitMessage: string; createdAt: Date }>,
  userAccessToken: string,
): Promise<{ headSha: string; treeSha: string } | null> {
  if (snapshots.length === 0) return null;

  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubOwner: true, githubRepo: true },
    });

    if (!ws?.githubOwner || !ws?.githubRepo) return null;

    const octokit = new Octokit({ auth: userAccessToken });
    const owner = ws.githubOwner;
    const repo = ws.githubRepo;

    // Get current HEAD — try main, fall back to master
    let currentSha: string;
    let currentTreeSha = "";
    let branchName = "main";

    try {
      const ref = await octokit.git.getRef({ owner, repo, ref: "heads/main" });
      currentSha = ref.data.object.sha;
    } catch (err: any) {
      if (err.status === 404) {
        try {
          const ref = await octokit.git.getRef({ owner, repo, ref: "heads/master" });
          currentSha = ref.data.object.sha;
          branchName = "master";
        } catch (masterErr: any) {
          if (masterErr.status === 404) {
            const tree = await octokit.git.createTree({
              owner,
              repo,
              tree: [{ path: ".gitkeep", content: "" }],
            });
            const commit = await octokit.git.createCommit({
              owner,
              repo,
              message: "Initial commit",
              tree: tree.data.sha,
              author: { name: "AI Agents", email: "agent@ai-agents.com" },
            });
            currentSha = commit.data.sha;
            currentTreeSha = tree.data.sha;

            await octokit.git.createRef({
              owner,
              repo,
              ref: "refs/heads/main",
              sha: currentSha,
            });
            branchName = "main";
          } else {
            throw masterErr;
          }
        }
      } else {
        throw err;
      }
    }

    // Get tree SHA if we didn't create initial commit
    if (!currentTreeSha) {
      const headCommit = await octokit.git.getCommit({ owner, repo, commit_sha: currentSha });
      currentTreeSha = headCommit.data.tree.sha;
    }

    // Process snapshots
    let finalTreeSha = currentTreeSha;
    for (const snap of snapshots) {
      // VALIDATE: Check files schema
      if (!Array.isArray(snap.files)) {
        console.error(`[GitHubSync] Snapshot ${snap.id} has invalid files (not array)`);
        return null;
      }

      const files = snap.files as any[];

      // Check each file has required shape
      for (const f of files) {
        if (typeof f !== 'object' || !('path' in f) || !('content' in f)) {
          console.error(`[GitHubSync] Snapshot ${snap.id} has invalid file shape`, f);
          return null;
        }
      }

      // Skip empty snapshots
      if (files.length === 0) {
        console.log(`[GitHubSync] Skipping empty snapshot ${snap.id}`);
        continue;
      }

      // Create tree
      const tree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: currentTreeSha,
        tree: files.map((f) => {
          if (f.content === null) {
            return {
              path: f.path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: null,
            };
          }
          return {
            path: f.path,
            mode: "100644" as const,
            type: "blob" as const,
            content: f.content,
          };
        }),
      });
      currentTreeSha = tree.data.sha;
      finalTreeSha = currentTreeSha;

      // Create commit
      const commit = await octokit.git.createCommit({
        owner,
        repo,
        message: snap.commitMessage.slice(0, 200),
        tree: currentTreeSha,
        parents: [currentSha],
        author: {
          name: "AI Agents Agent",
          email: "agent@ai-agents.com",
          date: snap.createdAt.toISOString(),
        },
      });
      currentSha = commit.data.sha;
    }

    // Update branch pointer
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
      sha: currentSha,
    });

    console.log(`[GitHubSync] ✅ Pushed ${snapshots.length} snapshots to ${owner}/${repo}`);
    return { headSha: currentSha, treeSha: finalTreeSha };

  } catch (err: any) {
    console.error(`[GitHubSync] bulkPushHistory failed for workspace ${workspaceId}:`, err.message);
    return null;
  }
}
