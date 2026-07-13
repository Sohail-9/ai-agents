/**
 * Tier definitions and Azure config helper.
 *
 * FREE  → Azure OpenAI gpt-5.5 (code agent) + Qwen (intent, context, planning, sub-agents)
 * PAID  → scaffold only; not enabled yet (add Anthropic/Gemini models here later)
 *
 * All users route FREE. getTier() is the single gate to flip when PAID is ready.
 */

export type Tier = "FREE" | "PAID";

export function getTier(_userId?: string): Tier {
  return "FREE";
}

export interface AzureConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  defaultQuery?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
}

/**
 * Returns Azure OpenAI connection config when env vars are present, else null.
 * Supports both endpoint styles:
 *   New-style  → https://resource.openai.azure.com/openai/v1   (Bearer auth, standard SDK)
 *   Traditional→ https://resource.openai.azure.com             (api-key header + api-version)
 */
export function getAzureConfig(): AzureConfig | null {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
  if (!apiKey || !endpoint) return null;

  const model = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview";
  const isNewStyle = endpoint.endsWith("/openai/v1") || endpoint.endsWith("/v1");

  if (isNewStyle) {
    // Azure AI Foundry /openai/v1 — standard OpenAI SDK Bearer auth, no api-version needed
    console.log(`[AzureConfig] new-style endpoint — baseURL=${endpoint} model=${model}`);
    return { apiKey, baseURL: endpoint, model };
  }

  // Traditional Azure OpenAI: deployment in path, api-key header + api-version query
  const baseURL = `${endpoint}/openai/deployments/${model}`;
  console.log(`[AzureConfig] traditional endpoint — baseURL=${baseURL} model=${model} api-version=${apiVersion}`);
  return {
    apiKey,
    baseURL,
    model,
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: { "api-key": apiKey },
  };
}
