/**
 * Lightweight classifier: implementation request vs brainstorming/exploratory.
 * Uses Azure OpenAI when configured, falls back to Qwen.
 */

import OpenAI from "openai";
import { getAzureConfig } from "./tiers";

const INTENT_CLASSIFICATION_PROMPT = `Classify the user's query as either "implementation" or "brainstorming".

IMPLEMENTATION INTENT:
- User clearly wants to build/create/develop something specific
- Contains actionable instructions or a concrete target
- Examples: "build a website", "create a dashboard", "make a mobile app"

BRAINSTORMING INTENT:
- User is exploring ideas or asking for suggestions
- No concrete implementation target
- Examples: "what should I build?", "suggest something", "give me project ideas"

Query: "{query}"

Respond with ONLY a JSON object:
{
  "intent": "implementation" or "brainstorming",
  "confidence": 0.0 to 1.0,
  "reason": "brief explanation"
}`;

interface IntentClassificationResult {
  intent: "implementation" | "brainstorming";
  confidence: number;
  reason: string;
}

function getClassifierClient(): { client: OpenAI; model: string } {
  const azure = getAzureConfig();
  if (azure) {
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
  const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
  if (qwenKey) {
    return {
      client: new OpenAI({ apiKey: qwenKey, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }),
      model: "qwen-turbo",
    };
  }
  throw new Error("No API key for implementation intent classification");
}

export async function classifyImplementationIntent(
  query: string,
  userId?: string,
): Promise<IntentClassificationResult> {
  try {
    const { client, model } = getClassifierClient();
    const prompt = INTENT_CLASSIFICATION_PROMPT.replace("{query}", query);

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_completion_tokens: 200,
    });

    const text = response.choices[0]?.message?.content;
    if (!text) {
      return { intent: "brainstorming", confidence: 0.5, reason: "no response from provider" };
    }

    const parsed = JSON.parse(text) as IntentClassificationResult;
    console.log(
      `[ImplementationIntentClassifier] "${query.substring(0, 50)}..." → ${parsed.intent} (${parsed.confidence})`,
    );
    return parsed;
  } catch (error) {
    console.error("[ImplementationIntentClassifier] Classification failed:", error);
    return { intent: "brainstorming", confidence: 0.5, reason: "classification error" };
  }
}

/**
 * Returns true if the query is brainstorming/vague (requires clarification).
 */
export async function requiresClarificationByIntent(
  query: string,
  userId?: string,
): Promise<boolean> {
  try {
    const result = await classifyImplementationIntent(query, userId);
    if (result.intent === "brainstorming") return true;
    if (result.confidence < 0.6) return true;
    return false;
  } catch {
    return false;
  }
}
