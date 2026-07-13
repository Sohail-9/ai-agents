import { AIProvider, IntentResult, ImageRef } from "../types";
import OpenAI from "openai";
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

class GroqProvider implements AIProvider {
  private static instance: GroqProvider;

  private constructor() {}

  public static getInstance(): GroqProvider {
    if (!GroqProvider.instance) {
      GroqProvider.instance = new GroqProvider();
    }
    return GroqProvider.instance;
  }

  private async getClient(_userId?: string): Promise<OpenAI> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("No Groq API key. Set GROQ_API_KEY env var.");
    console.log(`[Groq] Client ready (keySource=env)`);
    return new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  }

  public async analyzeIntent(prompt: string, userId?: string, images?: ImageRef[]): Promise<IntentResult> {
    console.log("[Groq] Analyzing intent for prompt:", prompt);
    if (images?.length) {
      console.log(`[Groq] ${images.length} image(s) attached — Groq has no vision support, using text fallback`);
    }

    try {
      const client = await this.getClient(userId);
      // Groq doesn't support vision — append a text note when images are present
      const userContent = images?.length
        ? `${prompt}\n\n[${images.length} image(s) attached — not visible to this model]`
        : prompt;
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: INTENT_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });

      const text = response.choices[0].message.content;
      if (!text) {
        throw new Error("No text returned from Groq");
      }

      const result: IntentResult = JSON.parse(extractJsonObject(text));
      return result;
    } catch (error) {
      console.error("[Groq] Error analyzing intent:", error);
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
    console.log("[Groq] Building context for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { CONTEXT_BUILDER_PROMPT, GITHUB_IMPORT_CONTEXT_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
      });

      const text = response.choices[0].message.content;
      if (!text) {
        throw new Error("No text returned from Groq");
      }

      return text;
    } catch (error) {
      console.error("[Groq] Error building context:", error);
      return "ERROR: Could not build context.";
    }
  }

  public async planUpdate(prompt: string, currentContext: string, mode?: 'github-import', userId?: string): Promise<string> {
    console.log("[Groq] Planning update for prompt:", prompt, mode ? `(mode: ${mode})` : '');

    try {
      const { UPDATE_PLANNER_PROMPT, GITHUB_IMPORT_UPDATE_PROMPT } = await import("../prompts");
      const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_UPDATE_PROMPT : UPDATE_PLANNER_PROMPT;
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
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
      if (!text) {
        throw new Error("No text returned from Groq");
      }

      return text;
    } catch (error) {
      console.error("[Groq] Error planning update:", error);
      return "ERROR: Could not plan update.";
    }
  }

  public async generateProjectMetadata(
    prompt: string,
    userId?: string,
    images?: ImageRef[],
  ): Promise<{ name: string; summary: string }> {
    console.log(`[Groq] Generating project metadata for: ${prompt.substring(0, 50)} (images=${images?.length ?? 0})`);
    try {
      const { PROJECT_METADATA_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
      const userText = images?.length
        ? `${prompt}\n\n[${images.length} image(s) attached — Groq has no vision; use text intent only.]`
        : prompt;
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: PROJECT_METADATA_PROMPT },
          { role: "user", content: userText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      });
      const text = response.choices[0].message.content;
      if (!text) throw new Error("No text returned");
      const parsed = JSON.parse(extractJsonObject(text));
      return {
        name: parsed.name || "my-awesome-project",
        summary: parsed.summary || prompt.substring(0, 80)
      };
    } catch (error) {
      console.error("[Groq] Error generating project metadata:", error);
      return { name: "my-awesome-project", summary: prompt.substring(0, 80) };
    }
  }

  public async generateCommitMessage(prompt: string, userId?: string): Promise<string> {
    console.log("[Groq] Generating commit message for:", prompt.substring(0, 50));
    try {
      const { COMMIT_MESSAGE_PROMPT } = await import("../prompts");
      const client = await this.getClient(userId);
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: COMMIT_MESSAGE_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });
      let text = response.choices[0].message.content?.trim();
      if (!text) throw new Error("No text returned");
      // Remove surrounding quotes if they exist
      text = text.replace(/^["'](.*)["']$/, '$1');
      return text;
    } catch (error) {
      console.error("[Groq] Error generating commit message:", error);
      return prompt.substring(0, 60) + "...";
    }
  }
}

export const groq = GroqProvider.getInstance();
