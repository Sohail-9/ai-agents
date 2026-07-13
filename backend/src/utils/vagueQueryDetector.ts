/**
 * Detects if a user query is vague/exploratory and requires clarification.
 * These are brainstorming queries, not implementation requests.
 *
 * STRATEGY:
 * 1. Use fast keyword matching for obviously vague queries (performance)
 * 2. For obvious implementation intent (verb + target), skip clarification
 * 3. For ambiguous queries, use lightweight AI classifier
 */

const IMPLEMENTATION_VERBS = [
  "build",
  "create",
  "develop",
  "make",
  "generate",
  "implement",
  "design",
  "add",
  "fix",
  "update",
  "modify",
  "refactor",
  "deploy",
  "architect",
  "setup",
];

const CONCRETE_TARGETS = [
  "website",
  "web app",
  "app",
  "application",
  "dashboard",
  "platform",
  "tool",
  "api",
  "service",
  "feature",
  "component",
  "page",
  "landing page",
  "form",
  "modal",
  "game",
  "bot",
  "chatbot",
  "plugin",
  "extension",
  "saas",
];

// Patterns for OBVIOUSLY vague queries - can skip AI check
const OBVIOUSLY_VAGUE_PATTERNS = [
  /^(what|suggest|ideas?|brainstorm|inspire me|help me)(\s|$)/,
  /\bwhat (should|can|could) (i|we) build\b/,
  /\bwhat to (build|create|make)\b/,
  /\bwhat (can i|should i) build (today|now)?\b/,
  /\bgive me (an? )?(idea|ideas|suggestion|suggestions?|project ideas?)\b/,
  /\bhelp me (decide|choose|pick)\b/,
  /\bnot sure what to (build|create|make)\b/,
  /\b(you decide|surprise me|anything goes)\b/,
  /\bwhat would you (build|create)\b/,
];

/**
 * Quick keyword-based check for obviously vague queries.
 * Returns null if inconclusive (requires AI check).
 */
export function quickVagueCheck(input: string): boolean | null {
  if (!input || input.trim().length === 0) return null;

  const lower = input.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // Check for OBVIOUSLY vague patterns
  if (OBVIOUSLY_VAGUE_PATTERNS.some((p) => p.test(lower))) {
    return true;
  }

  // Check for CLEAR implementation intent (verb + target)
  const hasImplementationIntent = IMPLEMENTATION_VERBS.some((verb) => lower.includes(verb));

  if (hasImplementationIntent) {
    const hasConcreteTarget = CONCRETE_TARGETS.some((target) => lower.includes(target));

    if (hasConcreteTarget) {
      // Clear implementation intent with concrete target → NOT vague
      return false;
    }
  }

  // Very short queries without concrete details are likely vague
  if (words.length < 4) {
    const hasConcreteContent =
      /\b(react|vue|angular|nextjs?|express|fastapi|django|rails|stripe|auth|database|api|dashboard|form|modal|website|app|saas|landing page)\b/.test(
        lower,
      );
    if (!hasConcreteContent) {
      return true;
    }
  }

  // Inconclusive - requires AI classification
  return null;
}

/**
 * Synchronous check using only keyword matching.
 * Use this for quick filtering.
 */
export function isVagueQuery(input: string): boolean {
  const quickResult = quickVagueCheck(input);
  // If inconclusive (null), assume NOT vague for performance
  return quickResult === true;
}

/**
 * Async check using AI classifier for ambiguous queries.
 * Use this in REST endpoint for better accuracy.
 */
export async function isVagueQueryWithAI(input: string, userId?: string): Promise<boolean> {
  try {
    // Quick check first (fast)
    const quickResult = quickVagueCheck(input);

    if (quickResult !== null) {
      // Obvious case - don't call AI
      return quickResult;
    }

    // Inconclusive - use AI classifier
    console.log(
      `[VagueQueryDetector] Inconclusive query, using AI: "${input.substring(0, 50)}..."`,
    );
    const { requiresClarificationByIntent } =
      await import("../brain/implementationIntentClassifier");
    return await requiresClarificationByIntent(input, userId);
  } catch (error) {
    console.error("[VagueQueryDetector] AI classification failed:", error);
    // On error, assume NOT vague (don't block execution)
    return false;
  }
}
