import { LlmProviderType } from "./userApiKeyService";

export { LlmProviderType };

export const SUPPORTED_PROVIDERS: LlmProviderType[] = [
  "OPENAI",
  "ANTHROPIC",
  "QWEN_DASHSCOPE",
  "GROQ",
  "GEMINI",
];

export const DEFAULT_PROVIDER: LlmProviderType = "QWEN_DASHSCOPE";

export function normalizeProvider(provider?: string | null): LlmProviderType {
  if (!provider) return DEFAULT_PROVIDER;
  return (
    SUPPORTED_PROVIDERS.includes(provider as LlmProviderType) ? provider : DEFAULT_PROVIDER
  ) as LlmProviderType;
}

export function invalidateProviderCache(_userId?: string): void {
  // No-op — cache removed along with per-user key lookup
}

export async function resolveProvider(input: {
  userId?: string;
  workspaceId?: string;
  preferredProvider?: string | null;
}): Promise<LlmProviderType> {
  // All provider resolution is now env-var based. Always return default.
  const preferred = normalizeProvider(input.preferredProvider ?? null);
  console.log(
    `[ProviderResolver] selected=${DEFAULT_PROVIDER} source=fallback_no_user_key user=${input.userId ? `${input.userId.slice(0, 6)}...` : "none"} workspace=${input.workspaceId ? `${input.workspaceId.slice(0, 6)}...` : "none"} preferred=${preferred}`,
  );
  return DEFAULT_PROVIDER;
}

export function providerToBrain(
  provider: LlmProviderType,
): "openai" | "gemini" | "groq" | "qwen" | "anthropic" {
  switch (provider) {
    case "OPENAI":
      return "openai";
    case "ANTHROPIC":
      return "anthropic";
    case "GROQ":
      return "groq";
    case "GEMINI":
      return "gemini";
    case "QWEN_DASHSCOPE":
    default:
      return "qwen";
  }
}
