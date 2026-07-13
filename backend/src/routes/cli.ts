import { Router } from "express";

const router = Router();

/**
 * CLI provider config.
 *
 * The CLI calls this on startup with `Authorization: Bearer <token>`. The token
 * is verified by requireAuth (mounted on /api/*). On success we return the
 * current LLM provider deployment config so the CLI can inject keys into
 * process.env — nothing is persisted in the CLI itself.
 *
 * GET /api/cli/env
 *   -> { config: { <provider>: configType }, success: "true" }
 *
 * Phase 5 (key handout removal): when CLI_ENV_OMIT_KEYS is set, we return an
 * EMPTY config — no provider keys or endpoints leave the server. Flip this only
 * once clients use the server-proxy provider (AI_AGENTS_USE_SERVER_PROXY), which
 * needs no local keys. Off by default, so existing direct-mode CLIs are
 * unaffected. The CLI tolerates an empty/partial config (see backend-env.ts).
 */

export type configType = {
  deploymentName: string;
  apiKey: string;
  apiEndpoint: string;
  displayName: string;
  maxOutputSize: string;
  maxContentSize: string;
  capabilities: string[];
};

router.get("/env", async (_req, res) => {
  try {
    // Phase 5: keys stay server-side; clients authenticate to /api/cli/llm with
    // their account token instead of holding provider keys.
    if (process.env.CLI_ENV_OMIT_KEYS) {
      return res.json({ config: {}, success: "true" });
    }

    const config: { [key: string]: configType } = {
      claude: {
        deploymentName: process.env.AZURE_CLAUDE_DEPLOYMENT!,
        apiKey: process.env.AZURE_CLAUDE_API_KEY!,
        apiEndpoint: process.env.AZURE_CLAUDE_ENDPOINT!,
        displayName: "Claude Opus 4.8",
        maxOutputSize: "128000",
        maxContentSize: "1000000",
        // CLI canonical capability tokens (see agent-core env-model /
        // open-platform): tool_use, image_in, video_in, thinking.
        capabilities: ["tool_use", "image_in", "thinking"],
      },
      openai: {
        deploymentName: process.env.AZURE_OPENAI_CLI_DEPLOYMENT!,
        apiKey: process.env.AZURE_OPENAI_API_KEY!,
        apiEndpoint: process.env.AZURE_OPENAI_ENDPOINT!,
        displayName: "gpt-5.3-codex",
        maxOutputSize: "16384",
        maxContentSize: "1000000",
        // GPT-5.3 Codex supports reasoning -> thinking.
        capabilities: ["tool_use", "image_in", "thinking"],
      },
    };
    return res.json({ config, success: "true" });
  } catch (err: any) {
    console.error("[REST] GET /cli/env failed:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to fetch env vars" });
  }
});

export default router;
