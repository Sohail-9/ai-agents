import { AIProvider, IntentResult, ImageRef } from "../types";
import OpenAI from "openai";
import "../../env";
import { getAzureConfig } from "../tiers";

import { INTENT_SYSTEM_PROMPT, CONTEXT_BUILDER_PROMPT } from "../prompts";

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

class OpenAIProvider implements AIProvider {
  private static instance: OpenAIProvider;

  private constructor() { }

  public static getInstance(): OpenAIProvider {
    if (!OpenAIProvider.instance) {
      OpenAIProvider.instance = new OpenAIProvider();
    }
    return OpenAIProvider.instance;
  }

  /**
   * Resolve client. Priority:
   * 1. Azure OpenAI (AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT) — server-level
   * 2. User DB key (OPENAI)
   * 3. OPENAI_API_KEY env
   */
  public async getClient(_userId?: string): Promise<{ client: OpenAI; model: string }> {
    // Azure takes priority — server config only
    const azure = getAzureConfig();
    if (azure) {
      console.log("[OpenAI] Client ready (keySource=azure)");
      return {
        client: new OpenAI({
          apiKey: azure.apiKey,
          baseURL: azure.baseURL,
          defaultQuery: azure.defaultQuery,
          defaultHeaders: azure.defaultHeaders,
        }),
        model: azure.model,
      };
    }

    // Env fallback
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("No OpenAI/Azure API key available. Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY.");
    }

    console.log("[OpenAI] Client ready (keySource=env)");
    return {
      client: new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1" }),
      model: "gpt-4o-mini",
    };
  }

  public async analyzeIntent(prompt: string, userId?: string, images?: ImageRef[]): Promise<IntentResult> {
    console.log("[OpenAI] Analyzing intent for prompt:", prompt);

    try {
      const { client, model } = await this.getClient(userId);
      const userContent: any = images?.length
        ? [
            ...images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` },
            })),
            { type: "text", text: prompt },
          ]
        : prompt;

      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: INTENT_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from OpenAI");

      return JSON.parse(extractJsonObject(text)) as IntentResult;
    } catch (error: any) {
      // Azure/OpenAI failed — fall back to Qwen for intent so the run isn't blocked
      console.error("[OpenAI] Error analyzing intent, falling back to Qwen:", error?.message ?? error);
      try {
        const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
        if (qwenKey) {
          const qwenClient = new OpenAI({
            apiKey: qwenKey,
            baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          });
          const userContent: any = images?.length
            ? [...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` } })), { type: "text", text: prompt }]
            : prompt;
          const res = await qwenClient.chat.completions.create({
            model: "qwen-turbo",
            messages: [{ role: "system", content: INTENT_SYSTEM_PROMPT }, { role: "user", content: userContent }],
            response_format: { type: "json_object" },
            temperature: 0.2,
          });
          const text = res.choices[0].message.content;
          if (text) {
            console.log("[OpenAI] Intent fallback to Qwen succeeded");
            return JSON.parse(extractJsonObject(text)) as IntentResult;
          }
        }
      } catch (fallbackErr: any) {
        console.error("[OpenAI] Qwen fallback also failed:", fallbackErr?.message);
      }
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
    console.log("[OpenAI] Building context for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { client, model } = await this.getClient(userId);
      const { CONTEXT_BUILDER_PROMPT, GITHUB_IMPORT_CONTEXT_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT;
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from OpenAI");
      return text;
    } catch (error) {
      console.error("[OpenAI] Error building context:", error);
      return "ERROR: Could not build context.";
    }
  }

  public async planUpdate(prompt: string, currentContext: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[OpenAI] Planning update for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { client, model } = await this.getClient(userId);
      const { UPDATE_PLANNER_PROMPT, GITHUB_IMPORT_UPDATE_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_UPDATE_PROMPT : UPDATE_PLANNER_PROMPT;
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `CURRENT CONTEXT:\n${currentContext}\n\nUSER REQUEST:\n${prompt}` },
        ],
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from OpenAI");
      return text;
    } catch (error) {
      console.error("[OpenAI] Error planning update:", error);
      return "ERROR: Could not plan update.";
    }
  }

  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    console.log(`[OpenAI] Generating project metadata for: ${prompt.substring(0, 50)} (images=${images?.length ?? 0})`);
    try {
      const { PROJECT_METADATA_PROMPT } = await import("../prompts");
      const { client, model } = await this.getClient(userId);
      const userContent: any[] = [];
      if (images?.length) {
        for (const img of images) {
          userContent.push({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` },
          });
        }
      }
      userContent.push({ type: "text", text: prompt });
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: PROJECT_METADATA_PROMPT },
          { role: "user", content: userContent as any },
        ],
        response_format: { type: "json_object" },
      });
      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned");
      const parsed = JSON.parse(extractJsonObject(text));
      return { name: parsed.name || "my-awesome-project", summary: parsed.summary || prompt.substring(0, 80) };
    } catch (error) {
      console.error("[OpenAI] Error generating project metadata:", error);
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    }
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    console.log("[OpenAI] Generating commit message for:", prompt.substring(0, 50));
    try {
      const { COMMIT_MESSAGE_PROMPT } = await import("../prompts");
      const { client, model } = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: COMMIT_MESSAGE_PROMPT },
          { role: "user", content: prompt },
        ],
      });
      let text = response.choices[0].message.content?.trim();
      if (!text) throw new Error("No text returned");
      text = text.replace(/^["'](.*?)["']$/, '$1');
      return text;
    } catch (error) {
      console.error("[OpenAI] Error generating commit message:", error);
      return prompt.substring(0, 60) + "...";
    }
  }
}

export const openai = OpenAIProvider.getInstance();
