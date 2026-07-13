import { AIProvider, ProviderType, ClarificationQuestion, IntentResult, ImageRef } from './types';
import { openai } from './providers/openai';
import { gemini } from './providers/gemini';
import { groq } from './providers/groq';
import { qwen } from './providers/qwen';
import { anthropic } from './providers/anthropic';
import { providerToBrain, resolveProvider } from '../services/providerResolver';
import { getAzureConfig } from './tiers';

const normalizeProvider = (p?: string): ProviderType | 'qwen' | 'anthropic' => {
  const valid = ['openai', 'gemini', 'groq', 'qwen', 'anthropic'];
  return p && valid.includes(p) ? (p as any) : 'qwen';
};

export class AIBrain {
  private currentProviderType: ProviderType | 'qwen' | 'anthropic';

  constructor(providerType: string = process.env.DEFAULT_LLM_PROVIDER?.toLowerCase() || 'qwen') {
    this.currentProviderType = normalizeProvider(providerType);
  }

  private resolveProviderByType(type: string): AIProvider {
    switch (type.toLowerCase()) {
      case 'groq': return groq;
      case 'openai': return openai;
      case 'qwen':
      case 'qwen_dashscope': return qwen;
      case 'anthropic': return anthropic;
      case 'gemini': default: return gemini;
    }
  }

  public setProvider(type: string) {
    const normalized = normalizeProvider(type);
    console.log(`[AIBrain] Switching provider from ${this.currentProviderType} to ${normalized}`);
    this.currentProviderType = normalized;
  }

  /**
   * Decision tasks (intent, context, planning) → Azure OpenAI when configured, else Qwen.
   * These are short, structured-output calls where GPT-4o-mini outperforms Qwen on JSON fidelity.
   */
  private getDecisionProvider(): AIProvider {
    const hasAzure = !!getAzureConfig();
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    if (hasAzure || hasOpenAI) {
      console.log(`[AIBrain] Decision provider → openai (azure=${hasAzure})`);
      return openai;
    }
    console.log("[AIBrain] Decision provider → qwen (no Azure/OpenAI key)");
    return qwen;
  }

  private async resolveProviderForRequest(userId?: string): Promise<AIProvider> {
    const provider = await resolveProvider({ userId });
    const brainProvider = providerToBrain(provider);
    console.log(
      `[AIBrain] Provider resolved provider=${provider} brainProvider=${brainProvider} user=${userId ? `${userId.slice(0, 6)}...` : "none"}`,
    );
    return this.resolveProviderByType(brainProvider);
  }

  private async runWithProvider<T>(op: string, provider: AIProvider, fn: (provider: AIProvider) => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    console.log(`[AIBrain] ${op} started`);
    try {
      const result = await fn(provider);
      console.log(`[AIBrain] ${op} completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return result;
    } catch (error) {
      console.error(`[AIBrain] ${op} failed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      throw error;
    }
  }

  private async runWithProviderLog<T>(op: string, userId: string | undefined, fn: (provider: AIProvider) => Promise<T>): Promise<T> {
    const provider = await this.resolveProviderForRequest(userId);
    return this.runWithProvider(op, provider, fn);
  }

  public async processPrompt(prompt: string, userId?: string, images?: ImageRef[]): Promise<IntentResult> {
    // Intent classification → Qwen turbo (fast; gpt-5.5 is overkill and slow for this task)
    const result = await this.runWithProvider(
      "processPrompt/analyzeIntent",
      qwen,
      (provider) => provider.analyzeIntent(prompt, userId, images),
    );

    if (result.fullIntent) {
      console.log("[AIBrain] Full intent detected. Checking for included context...");

      let contextContent = result.contextContent;
      const isValidPlan = contextContent && contextContent.includes("TYPE") && contextContent.includes("TODOS");
      if (!isValidPlan) {
        console.log("[AIBrain] contextContent missing or placeholder — calling generateContext...");
        contextContent = await this.generateContext(prompt, undefined, userId);
      } else {
        console.log("[AIBrain] Using contextContent from intent result.");
      }

      console.log("[AIBrain] Context ready (will be written to sandbox).");
      return { ...result, contextContent };
    } else {
      console.log("[AIBrain] Partial intent detected. Need clarification.");
    }

    return result;
  }

  public async generateContext(prompt: string, mode?: 'github-import', userId?: string): Promise<string> {
    return this.runWithProvider(
      "generateContext/buildContext",
      qwen,
      (provider) => provider.buildContext(prompt, mode, userId),
    );
  }

  public async planUpdate(prompt: string, currentContext: string, mode?: 'github-import', userId?: string): Promise<string> {
    return this.runWithProvider(
      "planUpdate",
      qwen,
      (provider) => provider.planUpdate(prompt, currentContext, mode, userId),
    );
  }

  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    // Execution task → user provider (Qwen by default)
    return await this.runWithProviderLog("generateProjectMetadata", userId, async (provider) => {
      if (provider.generateProjectMetadata) {
        return await provider.generateProjectMetadata(prompt, userId, images);
      }
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    });
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    // Execution task → user provider (Qwen by default)
    return await this.runWithProviderLog("generateCommitMessage", userId, async (provider) => {
      if (provider.generateCommitMessage) {
        return await provider.generateCommitMessage(prompt, userId);
      }
      return prompt.substring(0, 60) + "...";
    });
  }

}

export const ai = new AIBrain();
