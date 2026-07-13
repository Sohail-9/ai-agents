// User API key storage removed — all LLM keys are server-side env vars only.
export type LlmProviderType = 'OPENAI' | 'ANTHROPIC' | 'QWEN_DASHSCOPE' | 'GROQ' | 'GEMINI';

export const userApiKeyService = {
  async upsertKey(_userId: string, _provider: LlmProviderType, _key: string) { return null; },
  async getKeys(_userId: string): Promise<Array<{ provider: LlmProviderType; lastFour: string | null }>> { return []; },
  async getKey(_userId: string, _provider: LlmProviderType): Promise<string | null> { return null; },
  async deleteKey(_userId: string, _provider: LlmProviderType): Promise<boolean> { return false; },
};
