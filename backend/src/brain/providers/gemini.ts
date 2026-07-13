import { AIProvider, IntentResult, ClarificationQuestion, ImageRef } from "../types";
import { GoogleGenAI } from "@google/genai";
import "../../env";

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

class GeminiProvider implements AIProvider {
  private static instance: GeminiProvider;

  private constructor() {}

  public static getInstance(): GeminiProvider {
    if (!GeminiProvider.instance) {
      GeminiProvider.instance = new GeminiProvider();
    }
    return GeminiProvider.instance;
  }

  private async getClient(_userId?: string): Promise<GoogleGenAI> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("No Gemini API key. Set GEMINI_API_KEY env var.");
    console.log(`[Gemini] Client ready (keySource=env)`);
    return new GoogleGenAI({ apiKey });
  }

  public async analyzeIntent(prompt: string, userId?: string, images?: ImageRef[]): Promise<IntentResult> {
    console.log("[Gemini] Analyzing intent for prompt:", prompt);

    try {
      const client = await this.getClient(userId);
      // Build multimodal contents when images are present
      const contents: any = images?.length
        ? [
            ...images.map((img) => ({
              inlineData: { mimeType: img.mimeType, data: img.base64Data },
            })),
            { text: prompt },
          ]
        : prompt;

      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents,
        config: {
          systemInstruction: INTENT_SYSTEM_PROMPT,
          responseMimeType: "application/json",
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error("No text returned from Gemini");
      }

      const result: IntentResult = JSON.parse(extractJsonObject(text));
      return result;
    } catch (error) {
      console.error("[Gemini] Error analyzing intent:", error);
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

  public async buildContext(prompt: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[Gemini] Building context for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { CONTEXT_BUILDER_PROMPT, GITHUB_IMPORT_CONTEXT_PROMPT } = await import("../prompts");
      const systemInstruction = mode === 'github-import' ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt,
        config: { systemInstruction },
      });

      const text = response.text;
      if (!text) throw new Error("No text returned from Gemini");
      return text;
    } catch (error) {
      console.error("[Gemini] Error building context:", error);
      return "ERROR: Could not build context.";
    }
  }

  public async planUpdate(prompt: string, currentContext: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[Gemini] Planning update for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { UPDATE_PLANNER_PROMPT, GITHUB_IMPORT_UPDATE_PROMPT } = await import("../prompts");
      const systemInstruction = mode === 'github-import' ? GITHUB_IMPORT_UPDATE_PROMPT : UPDATE_PLANNER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `CURRENT CONTEXT:\n${currentContext}\n\nUSER REQUEST:\n${prompt}`,
        config: { systemInstruction },
      });

      const text = response.text;
      if (!text) throw new Error("No text returned from Gemini");
      return text;
    } catch (error) {
      console.error("[Gemini] Error planning update:", error);
      return "ERROR: Could not plan update.";
    }
  }
  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    console.log(`[Gemini] Generating project metadata for: ${prompt.substring(0, 50)} (images=${images?.length ?? 0})`);
    try {
      const { PROJECT_METADATA_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
      const parts: any[] = [];
      if (images?.length) {
        for (const img of images) {
          parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
        }
      }
      parts.push({ text: prompt });
      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents: [{ role: "user", parts }] as any,
        config: {
          systemInstruction: PROJECT_METADATA_PROMPT,
          responseMimeType: "application/json",
        },
      });

      const text = response.text;
      if (!text) throw new Error("No text returned");
      const parsed = JSON.parse(extractJsonObject(text));
      return { name: parsed.name || "my-awesome-project", summary: parsed.summary || prompt.substring(0, 80) };
    } catch (error) {
      console.error("[Gemini] Error generating project metadata:", error);
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    }
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    console.log("[Gemini] Generating commit message for:", prompt.substring(0, 50));
    try {
      const { COMMIT_MESSAGE_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt,
        config: { systemInstruction: COMMIT_MESSAGE_PROMPT },
      });

      let text = response.text?.trim();
      if (!text) throw new Error("No text returned");
      text = text.replace(/^["'](.*?)["']$/, '$1');
      return text;
    } catch (error) {
      console.error("[Gemini] Error generating commit message:", error);
      return prompt.substring(0, 60) + "...";
    }
  }
}

export const gemini = GeminiProvider.getInstance();
