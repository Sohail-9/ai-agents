export const MODE_BURN_RATES: Record<string, number> = {
  intent: 0.05,
  planning: 0.15,
  suggestion: 0.1,
  chat: 0.4,
  build: 0.75,
  tool_call: 1.0,
  deep_reasoning: 1.5,
};

export const PROVIDER_MULTIPLIERS: Record<string, number> = {
  QWEN_DASHSCOPE: 0.4,
  GROQ: 0.4,
  OPENAI: 1.35,
  ANTHROPIC: 3.0,
  GEMINI: 3.0,
};

export const CREDIT_RESERVATION_BUFFER = 500;
export const CREDITS_PER_1K_EFFECTIVE_TOKENS = 1;
export const INITIAL_CREDITS = 10_000;
export const DEFAULT_PROVIDER_MULTIPLIER = 1.35;
