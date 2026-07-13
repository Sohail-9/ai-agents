import { AIProvider, IntentResult, ImageRef } from "../types";
import Anthropic from "@anthropic-ai/sdk";
import "../../env";

import { INTENT_SYSTEM_PROMPT, CONTEXT_BUILDER_PROMPT } from "../prompts";

function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  // Common case: model wraps JSON in ```json ... ```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();

  // Fallback: extract the first JSON object-looking block
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

function parseJsonObject<T>(text: string): T {
  return JSON.parse(extractJsonObject(text)) as T;
}

class AnthropicProvider implements AIProvider {
  private static instance: AnthropicProvider;

  private constructor() { }

  public static getInstance(): AnthropicProvider {
    if (!AnthropicProvider.instance) {
      AnthropicProvider.instance = new AnthropicProvider();
    }
    return AnthropicProvider.instance;
  }

  private async getClient(_userId?: string): Promise<Anthropic> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("No Anthropic API key. Set ANTHROPIC_API_KEY env var.");
    console.log(`[Anthropic] Client ready (keySource=env)`);
    return new Anthropic({ apiKey });
  }

  public async analyzeIntent(prompt: string, userId?: string, images?: ImageRef[]): Promise<IntentResult> {
    console.log("[Anthropic] Analyzing intent for prompt:", prompt);

    try {
      const client = await this.getClient(userId);
      const userContent: any = images?.length
        ? [
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mimeType, data: img.base64Data },
            })),
            { type: "text", text: prompt },
          ]
        : prompt;

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: INTENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        temperature: 0.2,
      });

      const textBlock = response.content.find(b => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : null;
      if (!text) throw new Error("No text returned from Anthropic");

      return parseJsonObject<IntentResult>(text);
    } catch (error) {
      console.error("[Anthropic] Error analyzing intent:", error);
      return {
        fullIntent: false,
        questions: [
          { key: "system_error", question: "I encountered an error understanding your request. Could you explain what you want to build in more detail?" },
          { key: "language", question: "What programming language do you prefer?" },
          { key: "framework", question: "Do you have a preferred framework like React or Vue?" },
        ],
      };
    }
  }

  public async buildContext(prompt: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[Anthropic] Building context for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const client = await this.getClient(userId);
      const { CONTEXT_BUILDER_PROMPT, GITHUB_IMPORT_CONTEXT_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT;
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      });

      const textBlock = response.content.find(b => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : null;
      if (!text) throw new Error("No text returned from Anthropic");
      return text;
    } catch (error) {
      console.error("[Anthropic] Error building context:", error);
      return "ERROR: Could not build context.";
    }
  }

  public async planUpdate(prompt: string, currentContext: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[Anthropic] Planning update for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const client = await this.getClient(userId);
      const { UPDATE_PLANNER_PROMPT, GITHUB_IMPORT_UPDATE_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_UPDATE_PROMPT : UPDATE_PLANNER_PROMPT;
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: `CURRENT CONTEXT:\n${currentContext}\n\nUSER REQUEST:\n${prompt}` }],
        temperature: 0.3,
      });

      const textBlock = response.content.find(b => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : null;
      if (!text) throw new Error("No text returned from Anthropic");
      return text;
    } catch (error) {
      console.error("[Anthropic] Error planning update:", error);
      return "ERROR: Could not plan update.";
    }
  }

  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    console.log(`[Anthropic] Generating project metadata for: ${prompt.substring(0, 50)} (images=${images?.length ?? 0})`);
    try {
      const client = await this.getClient(userId);
      const { PROJECT_METADATA_PROMPT } = await import("../prompts");
      const userContent: any[] = [];
      if (images?.length) {
        for (const img of images) {
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.base64Data },
          });
        }
      }
      userContent.push({ type: "text", text: prompt });
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: PROJECT_METADATA_PROMPT + " Respond ONLY with the JSON object.",
        messages: [{ role: "user", content: userContent }],
        temperature: 0.7,
      });
      const textBlock = response.content.find(b => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : null;
      if (!text) throw new Error("No text returned");
      const parsed = parseJsonObject<{ name?: string; summary?: string }>(text);
      return { name: parsed.name || "my-awesome-project", summary: parsed.summary || prompt.substring(0, 80) };
    } catch (error) {
      console.error("[Anthropic] Error generating project metadata:", error);
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    }
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    console.log("[Anthropic] Generating commit message for:", prompt.substring(0, 50));
    try {
      const client = await this.getClient(userId);
      const { COMMIT_MESSAGE_PROMPT } = await import("../prompts");
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 128,
        system: COMMIT_MESSAGE_PROMPT,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      });
      const textBlock = response.content.find(b => b.type === "text");
      let text = textBlock?.type === "text" ? textBlock.text?.trim() : null;
      if (!text) throw new Error("No text returned");
      text = text.replace(/^["'](.*?)["']$/, '$1');
      return text;
    } catch (error) {
      console.error("[Anthropic] Error generating commit message:", error);
      return prompt.substring(0, 60) + "...";
    }
  }
}

export const anthropic = AnthropicProvider.getInstance();
