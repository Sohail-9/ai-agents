/**
 * Detects if a query is about building a "suggestion" or "idea" platform.
 * These queries should show conversational suggestions first, not jump to implementation.
 *
 * Examples:
 * - "build a project suggestion website"
 * - "create an app idea generator"
 * - "make a tool suggestion platform"
 * - "develop an idea board for productivity"
 *
 * These should show 3-4 example ideas FIRST before starting workspace creation.
 */

import { qwen } from "./providers/qwen";

// Only match explicit patterns for suggestion-mode platforms
// These are intentionally strict to avoid false positives from specific project ideas
// Key distinction: "build a [suggestion platform]" (suggestion-mode) vs "build a [specific app]" (normal)
// {
//       requiresSuggestion: true,
//       status: "suggestion_mode",
//       suggestions: ideas,
//       message:
//         "Since you're building a suggestion/idea platform, here are some inspiring examples. Pick one or suggest your own.",
// }

// {
//     requiresClarification: true,
//     status: "clarification_required",
//     clarificationQuestions,
//     message: "Help me understand what you want to build.",
//}

export type QueryIntentResolverType = "NORMAL" | "SUGGESTION_MODE" | "CLARIFICATION_MODE";
export const QueryIntentResolver = async (
  query: string,
): Promise<{
  type: QueryIntentResolverType;
  data?: {
    status: "clarification_required" | "suggestion_mode";
    suggestions?: string[];
    clarificationQuestions?: string[];
    message?: string;
  };
}> => {
  const getAIIntentResolver = await qwen.intentDetectionClassifier?.(query);

  if (!getAIIntentResolver) {
    return { type: "NORMAL" };
  }

  if (getAIIntentResolver.type === "SUGGESTION_MODE") {
    const suggestions = Array.isArray(getAIIntentResolver.data)
      ? getAIIntentResolver.data
      : (getAIIntentResolver.data as any)?.suggestions || [];
    return {
      type: "SUGGESTION_MODE",
      data: {
        status: "suggestion_mode",
        suggestions,
        message: "Here are some project ideas you can start with.",
      },
    };
  }

  if (getAIIntentResolver.type === "CLARIFICATION_MODE") {
    const questions = Array.isArray(getAIIntentResolver.data)
      ? getAIIntentResolver.data
      : (getAIIntentResolver.data as any)?.clarificationQuestions || [];
    return {
      type: "CLARIFICATION_MODE",
      data: {
        status: "clarification_required",
        clarificationQuestions: questions,
        message: "Need more details before starting.",
      },
    };
  }

  return { type: "NORMAL" };
};

/**
 * Generate conversational suggestions for suggestion-mode queries.
 * These are actual project ideas, not technical questions.
 */
export function generateSuggestionIdeas(query: string): string[] {
  // Detect what type of suggestions to show
  // Default suggestions for generic suggestion queries
  return [
    "Project idea curator - shows trending project ideas across categories",
    "AI-powered ideation tool - generates ideas in any category you choose",
    "Community suggestion board - crowdsourced ideas from developers",
    "Other idea or category",
  ];
}
