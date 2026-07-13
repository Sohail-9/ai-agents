import { AIProvider, IntentResult, ImageRef, IntentDetection } from "../types";
import OpenAI from "openai";
import "../../env";

import { INTENT_SYSTEM_PROMPT, CONTEXT_BUILDER_PROMPT } from "../prompts";
import { QueryIntentResolverType } from "../suggestionModeClassifier";
import { INTENT_DETECTION_PROMPT } from "../systemPrompt";

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

class QwenProvider implements AIProvider {
  private static instance: QwenProvider;

  private constructor() {}

  public static getInstance(): QwenProvider {
    if (!QwenProvider.instance) {
      QwenProvider.instance = new QwenProvider();
    }
    return QwenProvider.instance;
  }

  public async getClient(_userId?: string): Promise<OpenAI> {
    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
    if (!apiKey) throw new Error("No Qwen API key. Set DASHSCOPE_API_KEY env var.");
    console.log(`[Qwen] Client ready (keySource=env)`);
    return new OpenAI({ apiKey, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" });
  }

  public async analyzeIntent(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<IntentResult> {
    console.log("[Qwen] Analyzing intent for prompt:", prompt);

    try {
      const client = await this.getClient(userId);
      // Use vision model when images are present
      const model = images?.length ? "qwen-vl-max" : "qwen-turbo";
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
        temperature: 0.2,
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from Qwen");

      return JSON.parse(extractJsonObject(text)) as IntentResult;
    } catch (error) {
      console.error("[Qwen] Error analyzing intent:", error);
      return {
        fullIntent: false,
        questions: [
          {
            key: "system_error",
            question:
              "I encountered an error understanding your request. Could you explain what you want to build in more detail?",
          },
          { key: "language", question: "What programming language do you prefer?" },
          { key: "framework", question: "Do you have a preferred framework like React or Vue?" },
        ],
      };
    }
  }

  public async buildContext(
    prompt: string,
    mode?: "github-import",
    userId?: string,
  ): Promise<string> {
    console.log("[Qwen] Building context for prompt:", prompt);

    try {
      const { CONTEXT_BUILDER_PROMPT, GITHUB_IMPORT_CONTEXT_PROMPT } = await import("../prompts");
      const systemPrompt =
        mode === "github-import" ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "qwen-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from Qwen");
      return text;
    } catch (error) {
      console.error("[Qwen] Error building context:", error);
      return "ERROR: Could not build context.";
    }
  }

  public async planUpdate(
    prompt: string,
    currentContext: string,
    mode?: "github-import",
    userId?: string,
  ): Promise<string> {
    console.log("[Qwen] Planning update for prompt:", prompt);

    try {
      const { UPDATE_PLANNER_PROMPT, GITHUB_IMPORT_UPDATE_PROMPT } = await import("../prompts");
      const systemPrompt =
        mode === "github-import" ? GITHUB_IMPORT_UPDATE_PROMPT : UPDATE_PLANNER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "qwen-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `CURRENT CONTEXT:\n${currentContext}\n\nUSER REQUEST:\n${prompt}`,
          },
        ],
        temperature: 0.3,
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from Qwen");
      return text;
    } catch (error) {
      console.error("[Qwen] Error planning update:", error);
      return "ERROR: Could not plan update.";
    }
  }
  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    console.log(
      `[Qwen] Generating project metadata for: ${prompt.substring(0, 50)} (images=${images?.length ?? 0})`,
    );
    try {
      const { PROJECT_METADATA_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
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
        model: images?.length ? "qwen-vl-max" : "qwen-turbo",
        messages: [
          { role: "system", content: PROJECT_METADATA_PROMPT },
          { role: "user", content: userContent as any },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      });

      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned");
      const parsed = JSON.parse(extractJsonObject(text));
      return {
        name: parsed.name || "my-awesome-project",
        summary: parsed.summary || prompt.substring(0, 80),
      };
    } catch (error) {
      console.error("[Qwen] Error generating project metadata:", error);
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    }
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    console.log("[Qwen] Generating commit message for:", prompt.substring(0, 50));
    try {
      const { COMMIT_MESSAGE_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "qwen-turbo",
        messages: [
          { role: "system", content: COMMIT_MESSAGE_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });

      let text = response.choices[0].message.content?.trim();
      if (!text) throw new Error("No text returned");
      text = text.replace(/^["'](.*?)["']$/, "$1");
      return text;
    } catch (error) {
      console.error("[Qwen] Error generating commit message:", error);
      return prompt.substring(0, 60) + "...";
    }
  }
  public async intentDetectionClassifier?(
    prompt: string,
    userId?: string,
  ): Promise<{ type: QueryIntentResolverType; data?: string[] | { status: string; suggestions?: string[]; clarificationQuestions?: string[] } }> {
    try {
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "qwen-turbo",
        messages: [
          { role: "system", content: INTENT_DETECTION_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
      });
      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned from Qwen");
      return JSON.parse(extractJsonObject(text)) as IntentDetection;
    } catch (error) {
      console.error("[Qwen] Error analyzing intent:", error);
      return { type: "NORMAL" };
    }
  }
}

export const qwen = QwenProvider.getInstance();
