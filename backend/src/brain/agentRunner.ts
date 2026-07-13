import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@e2b/code-interpreter";
import { getSystemPrompt, getPlanModePrompt, hasTemplate, FOLLOWUP_MODE_RULES, buildActiveSkillBlock, buildSkillsMenuBlock } from "./systemPrompt";
import { selectSkillForTask, shouldRoute } from "./skillRouter";
import { loadSkillPersona } from "../skills/skillLoader";
import { discoverSkills } from "../skills/skillDiscovery";
import type { ActiveSkillContext } from "../skills/types";
import { SandboxNormalizer } from "../sandbox/sandboxNormalizer";
import { executeSkill, TOOL_SCHEMAS } from "../skills";
import { redisConnection } from "../queue/connection";
import { ToolName } from "../skills/types";
import type { UsageEntry } from "../billing/types";
import {
  messageService,
  todoService,
  workspaceService,
  agentRunService,
  workspaceMemoryService,
} from "../services";
import { buildMemoryBlock } from "../memory/buildMemoryBlock";
import { retrieveRelevantMemory } from "../memory/memoryRetriever";
import { summarizeDroppedMessages, formatDigestAsMessage } from "../memory/conversationSummarizer";
import {
  buildPrettiMemoryProfileQuery,
  createRunFactMemories,
  fetchErrorFixHint,
  fetchMidWaveContext,
  fetchProfileContextBlock,
  ingestTodoCompletion,
  ingestWaveCompletion,
  isPrettiMemoryEnabled,
  latestUserMessageContent,
} from "../memory/prettiMemoryAgent";
import { getModelConfigForAgent, ModelConfig } from "./modelSelector";
import {
  DEFAULT_PROVIDER,
  normalizeProvider as normalizeResolvedProvider,
  resolveProvider,
} from "../services/providerResolver";
import { redactSensitive } from "../security/piiGuard";
import { getAzureConfig } from "./tiers";

const MAX_ITERATIONS = 20;
const TOKEN_LIMIT = 100_000;

type MessageRole = "system" | "user" | "assistant" | "tool";

interface ImageRef {
  mimeType: string;
  base64Data: string;
}

interface DbMessage {
  role: MessageRole;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
  toolName?: string;
  images?: ImageRef[];
}

interface UnifiedToolCall {
  id: string;
  function: { name: ToolName; arguments: string };
}

interface UnifiedAssistantMessage {
  content: string;
  tool_calls?: UnifiedToolCall[];
}

interface UnifiedLLMResponse {
  assistantMsg: UnifiedAssistantMessage;
  finishReason?: string;
  usage?: { prompt?: number; completion?: number; total?: number };
}

export interface AgentRunnerContext {
  workspaceId: string;
  sandboxId: string;
  todoId: string;
  framework?: string;
  templateId?: string;
  projectIdea?: string;
  overrideSystemPrompt?: string;
  provider?: "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";
  userId?: string;
  planMode?: boolean;
  isInitialSetup?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: { type: string; message: string; data?: any }) => void;
  usageAccumulator?: UsageEntry[];
}

const normalizeProvider = (
  p?: string | null,
): "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI" => {
  return normalizeResolvedProvider(p) as any;
};

type ProviderName = "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";

function getEnvKey(p: ProviderName): string | null {
  if (p === "OPENAI") return process.env.OPENAI_API_KEY || null;
  if (p === "QWEN_DASHSCOPE")
    return process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE || null;
  if (p === "GROQ") return process.env.GROQ_API_KEY || null;
  if (p === "ANTHROPIC") return process.env.ANTHROPIC_API_KEY || null;
  if (p === "GEMINI") return process.env.GEMINI_API_KEY || null;
  return null;
}

async function resolveLLMConfig(opts: {
  userId?: string;
  workspaceId?: string;
  provider?: ProviderName;
}): Promise<{ provider: ProviderName; apiKey: string; source: "user" | "env" }> {
  const preferred = (await resolveProvider({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    preferredProvider: opts.provider,
  })) as ProviderName;

  const preferredEnvKey = getEnvKey(preferred);
  if (preferredEnvKey) {
    console.log(
      `[AgentRunner] LLM config resolved provider=${preferred} source=env_key workspace=${opts.workspaceId ?? "n/a"} user=${opts.userId ? `${opts.userId.slice(0, 6)}...` : "none"}`,
    );
    return { provider: preferred, apiKey: preferredEnvKey, source: "env" };
  }

  const envFallbackOrder: ProviderName[] = [
    DEFAULT_PROVIDER as ProviderName,
    "GROQ",
    "OPENAI",
    "ANTHROPIC",
    "GEMINI",
  ];
  for (const p of envFallbackOrder) {
    const key = getEnvKey(p);
    if (key) {
      console.log(
        `[AgentRunner] LLM config fallback provider=${p} source=env_key workspace=${opts.workspaceId ?? "n/a"} user=${opts.userId ? `${opts.userId.slice(0, 6)}...` : "none"}`,
      );
      return { provider: p, apiKey: key, source: "env" };
    }
  }

  throw new Error("No LLM API key configured. Set env vars for at least one provider.");
}

async function createLLMClient(opts: {
  userId?: string;
  workspaceId?: string;
  provider?: ProviderName;
}): Promise<
  | { kind: "openai"; client: OpenAI; meta: { provider: ProviderName; source: "user" | "env" } }
  | {
      kind: "anthropic";
      client: Anthropic;
      meta: { provider: ProviderName; source: "user" | "env" };
    }
  | { kind: "unsupported" }
> {
  // Azure takes priority for code agent when configured
  const azure = getAzureConfig();
  if (azure) {
    console.log(
      `[AgentRunner] LLM client provider=AZURE_OPENAI model=${azure.model} source=azure workspace=${opts.workspaceId ?? "n/a"}`,
    );
    return {
      kind: "openai",
      client: new OpenAI({
        apiKey: azure.apiKey,
        baseURL: azure.baseURL,
        defaultQuery: azure.defaultQuery,
        defaultHeaders: azure.defaultHeaders,
      }),
      meta: { provider: "OPENAI", source: "env" },
    };
  }

  const { apiKey, provider, source } = await resolveLLMConfig(opts);

  // OpenAI-compatible providers
  if (provider === "OPENAI" || provider === "QWEN_DASHSCOPE" || provider === "GROQ") {
    const baseURL =
      provider === "OPENAI"
        ? process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
        : provider === "QWEN_DASHSCOPE"
          ? process.env.DASHSCOPE_BASE_URL ||
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
          : process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

    return { kind: "openai", client: new OpenAI({ apiKey, baseURL }), meta: { provider, source } };
  }

  if (provider === "ANTHROPIC") {
    return { kind: "anthropic", client: new Anthropic({ apiKey }), meta: { provider, source } };
  }

  // Gemini not yet wired for agent tool-calling
  return { kind: "unsupported" };
}

/** Wraps llm.chat.completions.create with:
 *  1. enable_thinking=false  — prevents Qwen3 from emitting ONLY a <think> block
 *     which DashScope strips, producing the fatal empty-output error.
 *  2. Up to MAX_LLM_RETRIES retries with back-off for that specific transient error.
 */
const MAX_LLM_RETRIES = 3;
async function callLLMWithRetryStream(
  llm: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  provider?: ProviderName,
  signal?: AbortSignal,
): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  const options: any = { signal };
  const requestParams = { ...params } as any;

  if (provider === "QWEN_DASHSCOPE") {
    requestParams.extra_body = { enable_thinking: false, ...((params as any).extra_body ?? {}) };
  }

  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    try {
      return (await llm.chat.completions.create(
        requestParams,
        options,
      )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (err: any) {
      const isEmptyOutputError =
        typeof err?.message === "string" &&
        err.message.toLowerCase().includes("model output must contain");

      if (isEmptyOutputError && attempt < MAX_LLM_RETRIES) {
        const delay = attempt * 1500; // 1.5 s, 3 s …
        console.warn(
          `[AgentRunner] ⚠️  Empty model output (attempt ${attempt}/${MAX_LLM_RETRIES}). Retrying in ${delay}ms…`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err; // re-throw non-retryable or exhausted retries
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error("[AgentRunner] LLM retry exhausted");
}

function estimateTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  let baseTokens = 0;

  // Create a copy of messages without base64 data for length calculation
  const strippedMessages = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const cleanContent = msg.content.map((part) => {
      if (part.type === "image_url") {
        baseTokens += 1000; // ~1000 tokens per image
        return { type: "image_url", image_url: { url: "data:image/jpeg;base64,[STRIPPED]" } };
      }
      return part;
    });
    return { ...msg, content: cleanContent } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  });

  const raw = JSON.stringify(strippedMessages);
  baseTokens += Math.ceil(raw.length / 4);
  return baseTokens;
}

function truncateOutput(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]`;
}

function tryRepairJson(raw: string): Record<string, any> | null {
  try {
    // Fix 1: trailing commas before } or ]
    let fixed = raw.replace(/,\s*([}\]])/g, "$1");
    // Fix 2: unescaped newlines/tabs inside JSON string values only
    fixed = fixed.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
      match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"),
    );
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * Remove orphaned DbMessages: tool messages whose matching assistant
 * tool_call was already trimmed. Prevents re-dropping the same orphans
 * every iteration and keeps context coherent for the LLM.
 */
function sanitizeDbMessages(msgs: DbMessage[]): DbMessage[] {
  const assistantCallIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.toolCalls) {
      try {
        const calls = JSON.parse(m.toolCalls);
        const arr = Array.isArray(calls) ? calls : [calls];
        for (const c of arr) {
          const id = c?.id || c?.tool_call_id;
          if (id) assistantCallIds.add(id);
        }
      } catch {
        /* skip unparseable */
      }
    }
  }

  return msgs.filter((m) => {
    if (m.role === "tool" && m.toolCallId && !assistantCallIds.has(m.toolCallId)) {
      return false;
    }
    return true;
  });
}

function buildOpenAIMessages(
  dbMessages: DbMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return dbMessages.map((m) => {
    if (m.role === "assistant" && m.toolCalls) {
      try {
        const rawCalls = JSON.parse(m.toolCalls);
        const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls];

        const validCalls = calls
          .map((c: any) => {
            // Robustly clinical structural correction for OpenAI format
            const name = c?.function?.name || c?.name;
            const args =
              typeof c?.function?.arguments === "string"
                ? c.function.arguments
                : JSON.stringify(c?.function?.arguments || c?.arguments || c?.input || {});

            if (!name) return null;

            return {
              id: c.id || `call_${Math.random().toString(36).slice(2, 9)}`,
              type: "function",
              function: { name, arguments: args },
            };
          })
          .filter(Boolean);

        if (validCalls.length > 0) {
          return {
            role: "assistant",
            content: m.content ? redactSensitive(m.content) : null,
            tool_calls: validCalls,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        }

        // Fallback: if no valid calls found, treat as plain assistant message
        return {
          role: "assistant",
          content: redactSensitive(m.content || "Continuing analysis..."),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      } catch (err) {
        console.warn(
          `[AgentRunner] Failed to parse tool_calls for message, falling back to text:`,
          err,
        );
        return {
          role: "assistant",
          content: redactSensitive(m.content || "Continuing analysis..."),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
    }

    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId || "unknown_call",
        content: redactSensitive(m.content),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }

    // User messages with images → multimodal content
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          ...m.images.map((img) => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` },
          })),
          { type: "text" as const, text: redactSensitive(m.content) },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }

    return {
      role: m.role,
      content: redactSensitive(m.content),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  });
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function buildAnthropicMessages(dbMessages: DbMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: any }>;
} {
  let system = "";
  const messages: Array<{ role: "user" | "assistant"; content: any }> = [];

  for (const m of dbMessages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }

    if (m.role === "user") {
      if (m.images?.length) {
        messages.push({
          role: "user",
          content: [
            ...m.images.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: img.base64Data,
              },
            })),
            { type: "text" as const, text: redactSensitive(m.content) },
          ],
        });
      } else {
        messages.push({ role: "user", content: redactSensitive(m.content) });
      }
      continue;
    }

    if (m.role === "assistant") {
      if (m.toolCalls) {
        const calls = safeJsonParse<any[]>(m.toolCalls, []);
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: redactSensitive(m.content) });

        for (const c of calls) {
          const name = (c?.function?.name || c?.name) as ToolName | undefined;
          if (!name) continue;
          const id =
            (c?.id as string | undefined) || `tool_${Math.random().toString(36).slice(2, 10)}`;
          const input =
            typeof c?.function?.arguments === "string"
              ? safeJsonParse<Record<string, unknown>>(c.function.arguments, {})
              : ((c?.input as Record<string, unknown> | undefined) ?? {});
          blocks.push({ type: "tool_use", id, name, input });
        }

        messages.push({ role: "assistant", content: blocks.length ? blocks : redactSensitive(m.content) });
      } else {
        messages.push({ role: "assistant", content: redactSensitive(m.content) });
      }
      continue;
    }

    if (m.role === "tool") {
      const parsed = safeJsonParse<{ success?: boolean; data?: string; error?: string }>(
        m.content,
        {},
      );
      const success = parsed.success !== false;
      const resultText = parsed.data ?? parsed.error ?? m.content;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId || "unknown_tool_call",
            content: resultText,
            is_error: !success,
          },
        ],
      });
    }
  }

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: "Start by analyzing the task and call tools as needed.",
    });
  }

  return { system, messages };
}

/**
 * Anthropic requires all tool_result blocks for one assistant turn to be in a SINGLE
 * user message. Because we store one tool result per DB row, buildAnthropicMessages
 * produces multiple consecutive user messages each with one tool_result block.
 * Merge them, then strip any tool_result whose tool_use_id has no matching tool_use
 * in the preceding assistant message (avoids the "unexpected tool_use_id" 400 error).
 * Also converts orphaned assistant tool_use blocks to plain text so the conversation
 * stays well-formed when context is trimmed.
 */
function sanitizeAnthropicMessages(
  messages: Array<{ role: "user" | "assistant"; content: any }>,
): Array<{ role: "user" | "assistant"; content: any }> {
  // Pass 1: merge consecutive tool_result-only user messages
  const merged: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (const msg of messages) {
    const isToolResultOnly =
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((c: any) => c.type === "tool_result");

    if (isToolResultOnly) {
      const prev = merged[merged.length - 1];
      const prevIsToolResultOnly =
        prev?.role === "user" &&
        Array.isArray(prev.content) &&
        prev.content.every((c: any) => c.type === "tool_result");

      if (prevIsToolResultOnly) {
        prev.content = [...prev.content, ...msg.content];
        continue;
      }
    }
    merged.push(msg);
  }

  // Pass 2: strip tool_result blocks whose id has no match in the preceding assistant
  const validated: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (const msg of merged) {
    if (
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool_result")
    ) {
      const prev = validated[validated.length - 1];
      const prevToolUseIds = new Set<string>(
        Array.isArray(prev?.content)
          ? prev.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.id as string)
          : [],
      );
      const nonResults = msg.content.filter((c: any) => c.type !== "tool_result");
      const validResults =
        prevToolUseIds.size > 0
          ? msg.content.filter(
              (c: any) => c.type !== "tool_result" || prevToolUseIds.has(c.tool_use_id),
            )
          : nonResults; // no preceding tool_use → drop all tool_results
      if (validResults.length === 0) continue;
      validated.push({ ...msg, content: validResults });
      continue;
    }
    validated.push(msg);
  }

  // Pass 3: convert assistant tool_use blocks that have no matching tool_result in the
  // immediately following user message into plain text (happens after context trimming)
  const final: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (let i = 0; i < validated.length; i++) {
    const msg = validated[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolUses = msg.content.filter((c: any) => c.type === "tool_use");
      if (toolUses.length > 0) {
        const next = validated[i + 1];
        const nextResultIds = new Set<string>(
          Array.isArray(next?.content)
            ? next.content
                .filter((c: any) => c.type === "tool_result")
                .map((c: any) => c.tool_use_id as string)
            : [],
        );
        const unpaired = toolUses.filter((c: any) => !nextResultIds.has(c.id));
        if (unpaired.length > 0) {
          const text =
            msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("") || "I processed the previous step.";
          final.push({ role: "assistant", content: text });
          continue;
        }
      }
    }
    final.push(msg);
  }

  return final;
}

/**
 * OpenAI: every role="tool" message must follow an assistant message with tool_calls
 * that contains a matching tool_call_id. Strip orphaned tool messages (most common
 * after context trimming) and convert orphaned assistant tool_calls to plain text.
 */
function sanitizeOpenAIMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // Pass 1: remove tool messages with no matching tool_call_id in the nearest preceding
  // assistant. Must scan backward past other tool messages to find that assistant —
  // a naive "check pass1[last]" breaks for the 2nd+ tool message in a multi-tool turn.
  const pass1: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      let precedingAssistant: any = null;
      for (let j = pass1.length - 1; j >= 0; j--) {
        if (pass1[j].role === "tool") continue;
        if (pass1[j].role === "assistant") precedingAssistant = pass1[j];
        break;
      }
      const validIds = new Set<string>(
        (precedingAssistant?.tool_calls ?? []).map((tc: any) => tc.id as string),
      );
      if (!validIds.has((msg as any).tool_call_id)) {
        console.warn(
          `[AgentRunner] Dropping orphaned tool message: tool_call_id=${(msg as any).tool_call_id}`,
        );
        continue;
      }
    }
    pass1.push(msg);
  }

  // Pass 2: every tool_call_id in an assistant message must have a following tool response.
  // If any are missing, convert the entire assistant+tool group to plain text so OpenAI
  // doesn't error with "tool_call_ids did not have response messages".
  const pass2: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let i = 0;
  while (i < pass1.length) {
    const msg = pass1[i];
    if (msg.role === "assistant" && (msg as any).tool_calls?.length > 0) {
      const requiredIds = new Set<string>(
        ((msg as any).tool_calls as any[]).map((tc: any) => tc.id as string),
      );
      const toolMsgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      let j = i + 1;
      while (j < pass1.length && pass1[j].role === "tool") {
        requiredIds.delete((pass1[j] as any).tool_call_id);
        toolMsgs.push(pass1[j]);
        j++;
      }
      if (requiredIds.size > 0) {
        // At least one tool_call_id has no response — convert to plain text, drop tool group
        const content = (msg as any).content || "I processed the previous step.";
        pass2.push({ role: "assistant", content: content || "I processed the previous step." });
        i = j;
        continue;
      }
      pass2.push(msg);
      pass2.push(...toolMsgs);
      i = j;
      continue;
    }
    pass2.push(msg);
    i++;
  }

  return pass2;
}

/**
 * Scrub old tool results before sending to Azure to prevent content filter triggers.
 * Strategy:
 *   - Last `keepRecentGroups` groups: kept fully intact.
 *   - Older groups: read_file results → stripped entirely (file content is the main filter trigger).
 *                   Other tool results (edit_file, execute_shell, etc.) → truncated to 80 chars.
 */
function truncateOldToolResults(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  keepRecentGroups = 2,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // Build a map of toolCallId → tool name from assistant messages
  const toolCallNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const tc of (msg as any).tool_calls ?? []) {
        toolCallNames.set(tc.id, tc.function?.name ?? "");
      }
    }
  }

  const groupBoundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" && (messages[i] as any).tool_calls?.length) {
      groupBoundaries.push(i);
    }
  }
  const cutoffGroup = groupBoundaries.length - keepRecentGroups;
  if (cutoffGroup <= 0) return messages;

  const cutoffIndex = groupBoundaries[cutoffGroup];
  return messages.map((msg, idx) => {
    if (idx >= cutoffIndex) return msg;
    if (msg.role === "tool") {
      const toolName = toolCallNames.get((msg as any).tool_call_id ?? "") ?? "";
      // read_file results are the #1 content filter trigger — strip entirely
      if (toolName === "read_file") {
        return { ...msg, content: "[file content stripped — already processed]" };
      }
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const truncated = content.length > 80 ? content.slice(0, 80) + "…[truncated]" : content;
      return { ...msg, content: truncated };
    }
    return msg;
  });
}

const ANTHROPIC_TOOLS = TOOL_SCHEMAS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

type WaveTodo = { id: string; title: string; description: string; order: number };

function buildInitialWaveMessage(
  wave: WaveTodo[],
  sandboxId: string,
  workspaceId: string,
  framework?: string,
): string {
  const envBlock = [
    `## Environment Context`,
    `- Sandbox ID: ${sandboxId}`,
    `- Working directory: /workspace`,
    `- Project Framework: ${framework || "Not specified"}`,
    `- Knowledge Base: Read /workspace/ai-agents.md ONCE for the full spec. Then go straight to writing code — do NOT read other files before editing them.`,
  ].join("\n");

  if (wave.length === 1) {
    const todo = wave[0];
    return [
      `## Your Task`,
      `**Task Order:** ${todo.order}`,
      `**Workspace ID:** ${workspaceId}`,
      `**Title:** ${todo.title}`,
      `**Description:**`,
      todo.description,
      ``,
      envBlock,
      ``,
      `DO NOT call todo_manager mark_todo_complete — outputting FINAL ANSWER automatically marks the todo complete.`,
      `When done: FINAL ANSWER TASK=${todo.order} [FRONTEND=<port>] [BACKEND=<port>]`,
    ].join("\n");
  }

  const taskList = wave
    .map((t) => `**[TASK ${t.order}] ${t.title}**\n${t.description}`)
    .join("\n\n");

  return [
    `## Your Tasks (${wave.length} tasks — complete all of them)`,
    `**Workspace ID:** ${workspaceId}`,
    ``,
    taskList,
    ``,
    envBlock,
    ``,
    `## Completion Protocol`,
    `DO NOT call todo_manager mark_todo_complete — outputting FINAL ANSWER automatically marks each todo complete.`,
    `Signal each finished task with: FINAL ANSWER TASK=<order> [FRONTEND=<port>] [BACKEND=<port>]`,
    `Example (task ${wave[0].order} with server): FINAL ANSWER TASK=${wave[0].order} FRONTEND=3000`,
    `Example (task with no server): FINAL ANSWER TASK=${wave[wave.length - 1].order}`,
    `Complete and signal each task before moving to the next.`,
  ].join("\n");
}

function buildNextWaveMessage(
  wave: WaveTodo[],
  modifiedFiles?: Set<string>,
  ports?: { frontend?: number | null; backend?: number | null },
): string {
  const filesNote = modifiedFiles && modifiedFiles.size > 0
    ? `\n\n**Files already written in previous tasks:** ${Array.from(modifiedFiles).join(", ")}. Use edit_file with operation=replace for targeted changes — do NOT rewrite entire files from scratch. If this task's feature is already fully implemented, mark it complete immediately.`
    : "";

  const portParts = [
    ports?.frontend ? `frontend=:${ports.frontend}` : null,
    ports?.backend ? `backend=:${ports.backend}` : null,
  ].filter(Boolean);
  const portNote = portParts.length > 0
    ? `Servers already confirmed running: ${portParts.join(", ")}. DO NOT call check_health.`
    : "";

  if (wave.length === 1) {
    const todo = wave[0];
    return [
      `## Next Task`,
      `The previous task is done. Now work on this NEW task:`,
      ``,
      `**[TASK ${todo.order}] ${todo.title}**`,
      todo.description,
      filesNote,
      ``,
      portNote,
      `IMPORTANT: If reading the relevant file shows this feature is already implemented, output FINAL ANSWER TASK=${todo.order} immediately — do NOT rewrite working code.`,
      `DO NOT call todo_manager mark_todo_complete — outputting FINAL ANSWER automatically marks the todo complete.`,
      `When done: FINAL ANSWER TASK=${todo.order} [FRONTEND=<port>] [BACKEND=<port>]`,
    ].filter(Boolean).join("\n");
  }

  const taskList = wave
    .map((t) => `**[TASK ${t.order}] ${t.title}**\n${t.description}`)
    .join("\n\n");

  return [
    `## Next Wave (${wave.length} tasks)`,
    `New tasks are ready. Complete all of them:`,
    ``,
    taskList,
    ``,
    portNote,
    `DO NOT call todo_manager mark_todo_complete — outputting FINAL ANSWER automatically marks each todo complete.`,
    `Signal each with: FINAL ANSWER TASK=<order> [FRONTEND=<port>] [BACKEND=<port>]`,
  ].filter(Boolean).join("\n");
}

/**
 * Extract the most-recently-edited file paths from prior-run message history
 * (assistant tool_calls). Used on follow-up runs to pre-load those files so the
 * agent edits directly instead of searching/reading to rediscover them.
 * Returns most-recent-first, deduped, capped at `max`.
 */
function extractRecentEditedPaths(dbMessages: DbMessage[], max = 3): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = dbMessages.length - 1; i >= 0 && paths.length < max; i--) {
    const m = dbMessages[i];
    if (m.role !== "assistant" || !m.toolCalls) continue;
    let calls: UnifiedToolCall[];
    try {
      calls = JSON.parse(m.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (c?.function?.name !== "edit_file") continue;
      try {
        const args = JSON.parse(c.function.arguments || "{}");
        const p = typeof args?.path === "string" ? args.path : null;
        if (p && !seen.has(p)) {
          seen.add(p);
          paths.push(p);
          if (paths.length >= max) break;
        }
      } catch {
        // malformed args — skip
      }
    }
  }
  return paths;
}

/** Extracts TASK=<n> order from a FINAL ANSWER line. Returns null if not present. */
function parseTaskOrderFromFinalAnswer(text: string): number | null {
  const m = text.match(/FINAL\s+ANSWER\s+TASK\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parses "FINAL ANSWER [FRONTEND=XXXX] [BACKEND=YYYY]" text and returns port numbers.
 */
interface DetectedPorts {
  frontend?: number;
  backend?: number;
}

function parsePortsFromFinalAnswer(text: string): DetectedPorts {
  const ports: DetectedPorts = {};

  // Support old format: "FINAL ANSWER 3000"
  const simpleMatch = text.match(/FINAL\s+ANSWER\s+(\d+)/i);
  if (simpleMatch && !text.includes("FRONTEND=")) {
    const p = parseInt(simpleMatch[1], 10);
    if (p > 0 && p < 65536) ports.frontend = p;
  }

  // Support new format: "FINAL ANSWER FRONTEND=3000 BACKEND=8000"
  const feMatch = text.match(/FRONTEND=(\d+)/i);
  if (feMatch) {
    const p = parseInt(feMatch[1], 10);
    if (p > 0 && p < 65536) ports.frontend = p;
  }

  const beMatch = text.match(/BACKEND=(\d+)/i);
  if (beMatch) {
    const p = parseInt(beMatch[1], 10);
    if (p > 0 && p < 65536) ports.backend = p;
  }

  return ports;
}

// Shell commands allowed in plan mode (read-only exploration)
const PLAN_MODE_ALLOWED_COMMANDS = [
  "ls",
  "find",
  "cat",
  "grep",
  "head",
  "tail",
  "wc",
  "echo",
  "pwd",
  "file",
  "stat",
  "tree",
];

function isPlanModeShellAllowed(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  // Allow if it starts with a known read-only command
  return PLAN_MODE_ALLOWED_COMMANDS.some(
    (allowed) => cmd === allowed || cmd.startsWith(allowed + " ") || cmd.startsWith(allowed + "\t"),
  );
}

function isDevServerCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  const blockedPatterns = [
    "npm run dev",
    "next dev",
    "npm start",
    "npx next dev",
    "yarn dev",
    "pnpm dev",
  ];
  return blockedPatterns.some((p) => cmd.includes(p));
}

function parseIntendedDevServerPort(command: string): number | null {
  const cmd = command.toLowerCase();

  const explicitPortMatch =
    cmd.match(/(?:^|\s)-p\s+(\d{2,5})(?:\s|$)/) ||
    cmd.match(/(?:^|\s)--port\s+(\d{2,5})(?:\s|$)/) ||
    cmd.match(/(?:^|\s)--port=(\d{2,5})(?:\s|$)/);
  if (explicitPortMatch) {
    const parsed = parseInt(explicitPortMatch[1], 10);
    if (parsed > 0 && parsed <= 65535) return parsed;
  }

  if (cmd.includes("next dev") || cmd.includes("npm run dev") || cmd.includes("npm start"))
    return 3000;
  if (cmd.includes("vite") || cmd.includes("pnpm dev") || cmd.includes("yarn dev")) return 5173;

  return null;
}

export async function runAgent(
  ctx: AgentRunnerContext,
): Promise<{
  success: boolean;
  summary: string;
  port?: number;
  backendPort?: number;
  modifiedFiles?: string[];
}> {
  const {
    workspaceId,
    sandboxId,
    framework,
    templateId,
    projectIdea,
    overrideSystemPrompt,
    onEvent,
    signal,
    provider,
    userId,
    planMode,
  } = ctx;

  // Load memory context (static inputs cached; smart retrieval refreshed per-todo)
  const [recentRuns, workspaceMemory, workspace] = await Promise.all([
    agentRunService.getRecent(workspaceId, 3).catch(() => []),
    workspaceMemoryService.get(workspaceId).catch(() => null),
    workspaceService.getWorkspace(workspaceId).catch(() => null),
  ]);
  const staticMemoryInput = { recentRuns, workspaceMemory };

  // Extract workspace stack config for guardrails
  const workspaceConfig = workspace?.config && typeof workspace.config === 'object' ? {
    language: (workspace.config as any)?.language,
    framework: (workspace.config as any)?.framework,
    database: (workspace.config as any)?.database,
  } : undefined;

  // A workspace with prior SUCCESSFUL runs is a follow-up: enable patch_file and targeted-read instructions.
  // FAILED/RUNNING rows don't count — they may not have written any files.
  const isFollowUp = !planMode && recentRuns.some((r: any) => r.status === 'SUCCESS');
  console.log(`[AgentRunner] isFollowUp=${isFollowUp} (recentRuns=${recentRuns.length})`);

  const baseSystemPrompt =
    overrideSystemPrompt ??
    (planMode
      ? getPlanModePrompt({ framework: framework || "Next.js", idea: projectIdea, workspaceConfig })
      : getSystemPrompt({ framework: framework || "Next.js", templateId, idea: projectIdea, workspaceConfig }));

  // Append follow-up mode rules when workspace has prior completed work.
  // This instructs the agent to use patch_file and targeted reads instead of rewriting files.
  const basePrompt = isFollowUp
    ? `${baseSystemPrompt}\n\n${FOLLOWUP_MODE_RULES}`
    : baseSystemPrompt;

  // Initial system prompt (refreshed per-todo with smart retrieval below)
  const staticBlock = buildMemoryBlock(staticMemoryInput);
  if (staticBlock) {
    console.log(
      `[AgentRunner] Memory block injected (${staticBlock.length} chars, ${recentRuns.length} recent runs)`,
    );
  } else {
    console.log(
      `[AgentRunner] No memory to inject (recentRuns=${recentRuns.length}, hasMemory=${!!workspaceMemory})`,
    );
  }
  let systemPrompt = staticBlock ? `${basePrompt}\n\n${staticBlock}` : basePrompt;
  const e2bDomain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
  systemPrompt = systemPrompt.replaceAll(".e2b.app", `.${e2bDomain}`);

  let llmWrapper: Awaited<ReturnType<typeof createLLMClient>>;
  let llmOpenAI: OpenAI | null = null;
  let llmAnthropic: Anthropic | null = null;
  let llmKind: "openai" | "anthropic" = "openai";
  let llmSource: "user" | "env" = "env";
  let currentProvider: ProviderName = normalizeProvider(provider ?? (DEFAULT_PROVIDER as any));
  if (planMode) {
    currentProvider = "QWEN_DASHSCOPE";
  }
  let retriedWithEnv = false;

  const emit = (type: string, message: string, data?: any) => {
    onEvent?.({ type, message, data });
  };

  // ── Plan mode: restrict tool schemas ─────────────────────────
  // In plan mode: only allow read_file, search_code, execute_shell (read-only at runtime),
  // edit_file (restricted to plan.md at runtime), and submit_plan_questions
  const PLAN_MODE_TOOLS = [
    "read_file",
    "search_code",
    "execute_shell",
    "edit_file",
    "submit_plan_questions",
  ];
  const activeToolSchemas = planMode
    ? TOOL_SCHEMAS.filter((t) => PLAN_MODE_TOOLS.includes(t.function.name as string))
    : TOOL_SCHEMAS.filter((t) => t.function.name !== "submit_plan_questions");

  const activeAnthropicTools = activeToolSchemas.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  try {
    llmWrapper = await createLLMClient({ userId, workspaceId, provider: currentProvider });
    if (llmWrapper.kind === "unsupported") {
      const msg =
        "Selected provider not yet supported for agent tool-calling. Use OpenAI/Groq/Qwen/Anthropic.";
      emit("ENV_REQUIRED", msg, { keys: ["DASHSCOPE_API_KEY"], reason: msg });
      return { success: false, summary: msg };
    }
    llmSource = llmWrapper.meta.source;
    currentProvider = llmWrapper.meta.provider;
    if (llmWrapper.kind === "openai") {
      llmKind = "openai";
      llmOpenAI = llmWrapper.client;
      llmAnthropic = null;
    } else {
      llmKind = "anthropic";
      llmAnthropic = llmWrapper.client;
      llmOpenAI = null;
    }
    emit(
      "LLM_CONFIG",
      llmSource === "user"
        ? `Using your ${currentProvider} API key for this run.`
        : `Using server ${currentProvider} API key for this run.`,
      { provider: currentProvider, source: llmSource },
    );
    console.log(
      `[AgentRunner] LLM runtime configured provider=${currentProvider} source=${llmSource} workspace=${workspaceId} user=${userId ? `${userId.slice(0, 6)}...` : "none"}`,
    );
  } catch (err: any) {
    emit("ENV_REQUIRED", err.message, {
      keys: ["DASHSCOPE_API_KEY"],
      reason: "No usable provider key configured",
    });
    return { success: false, summary: err.message };
  }

  let detectedFrontendPort: number | null = null;
  let detectedBackendPort: number | null = null;
  // B1: On a follow-up the dev servers are already running (resumed sandbox). Seed the
  // persisted ports so the wave prompt tells the agent NOT to call check_health, and so
  // AGENT_DONE carries the live preview port. Any port the agent emits in FINAL ANSWER is
  // still verified as normal — this only removes a needless check_health round-trip.
  if (isFollowUp) {
    try {
      const ws = await workspaceService.getWorkspace(workspaceId);
      if (ws?.port) detectedFrontendPort = ws.port;
      if (ws?.backendPort) detectedBackendPort = ws.backendPort;
    } catch {
      // non-fatal — fall back to agent-detected ports
    }
  }
  const startedServerPorts = new Set<number>(); // tracks ports where a dev server was allowed/started
  const isTemplateWorkspace = !!(templateId || hasTemplate(framework || ""));
  let devServerBlockCount = 0; // escalation counter for repeated blocked attempts
  let planExploreCount = 0; // tracks read-only tool calls in plan mode
  let planFileWritten = false; // true once plan.md is successfully written
  const PLAN_EXPLORE_LIMIT = 15; // max read-only tool calls before forcing question phase
  // Cumulative read-only tool calls (search/read/shell) since the last SUCCESSFUL edit_file.
  // Resets only on a successful edit so interleaved search→read→failed-edit loops still count.
  let readOnlyStreak = 0;
  const EXPLORE_SOFT_LIMIT = 4; // nudge: stop inspecting, read the file and edit
  const EXPLORE_HARD_LIMIT = 8; // hard: reject further search_code, force read_file + edit
  const failedReplaceByPath = new Map<string, number>(); // S3: failed edit_file attempts per path
  const injectedFilePaths = new Set<string>(); // S1: files already pre-loaded into context this run

  // Lazy sandbox cache — one connection reused for all sandbox operations in this run
  let sandboxCache: Sandbox | null = null;
  const getSandbox = async () => {
    if (!sandboxCache) sandboxCache = await Sandbox.connect(sandboxId);
    return sandboxCache;
  };

  console.log(`[AgentRunner] ── Starting run ──────────────────────────`);
  console.log(`[AgentRunner]   workspaceId = ${workspaceId}`);
  console.log(`[AgentRunner]   sandboxId   = ${sandboxId}`);
  console.log(`[AgentRunner]   planMode    = ${planMode ?? false}`);
  console.log(`[AgentRunner]   framework   = ${framework}`);

  // Verify write access before main loop
  let writeAccessVerified = false;
  try {
    const initialSandbox = await getSandbox();
    const hasAccess = await SandboxNormalizer.verifyWriteAccess(initialSandbox);
    if (!hasAccess) {
      console.warn(`[AgentRunner] ⚠️ Write access check failed. Attempting to normalize ownership...`);
      const normResult = await SandboxNormalizer.normalizeOwnership(initialSandbox);
      if (!normResult.success) {
        console.error(`[AgentRunner] ❌ Ownership normalization failed: ${normResult.message}`);
        emit("AGENT_ERROR", `Sandbox write access denied. Cannot proceed.`);
        return {
          success: false,
          summary: `Failed to obtain write access to /workspace. Reason: ${normResult.message}`,
        };
      }
    }
    writeAccessVerified = true;
    console.log(`[AgentRunner] ✅ Write access verified`);
  } catch (err: any) {
    console.error(`[AgentRunner] ❌ Write access verification failed:`, err.message);
    emit("AGENT_ERROR", `Write access check failed: ${err.message}`);
    return {
      success: false,
      summary: `Sandbox write access check failed: ${err.message}`,
    };
  }

  // Plan mode: nothing to pre-create — plan.md goes directly in /workspace/

  // ─── Load or seed conversation messages ────────────────────
  // First wave: load fewer messages for faster startup; later waves need more context
  const msgLimit = 10; // First wave uses only 10 messages for speed
  const tPrismaStart = Date.now();
  const prismaMessages = await messageService.getByWorkspace(
    workspaceId,
    undefined,
    msgLimit,
    false,
    true,
  );
  console.log(`[TIMING] messageService.getByWorkspace: ${Date.now() - tPrismaStart}ms (${prismaMessages.length} messages)`);

  let dbMessages: DbMessage[] = prismaMessages.map((msg: any) => ({
    role: msg.role as MessageRole,
    content: msg.content,
    toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
    toolCallId: msg.toolCallId || undefined,
    toolName: msg.toolName || undefined,
    images: msg.images?.length
      ? msg.images.map((img: any) => ({ mimeType: img.mimeType, base64Data: img.base64Data }))
      : undefined,
  }));

  // CRITICAL: DB returns DESC (newest first). Reverse to chronological for the agent.
  dbMessages.reverse();

  console.log(
    `[AgentRunner] Loaded ${dbMessages.length} existing agent messages from Prisma (chronological)`,
  );

  // ────────────────────────────────────────────────────────────
  // OUTER WAVE LOOP: each iteration picks all "ready" todos
  // (pending with satisfied deps) and runs them as a wave.
  // ────────────────────────────────────────────────────────────
  let totalIterations = 0;
  const MAX_TOTAL_ITERATIONS = 120; // safety cap across all waves
  let waveIndex = 0;
  const modifiedFiles = new Set<string>();
  let cachedDigest: DbMessage | null = null;
  // pretti-memory caches — reduce redundant API calls
  const midWaveCache = new Map<string, string | null>(); // mid-wave context per task
  const errorHintCache = new Map<string, string | null>(); // error fixes — prevents duplicate queries for same error
  const profileCache = new Map<string, string | null>(); // profile context per workspace+user (cross-wave)

  // pretti-memory metrics — track cache effectiveness
  const prettiMemoryMetrics = {
    profileCalls: 0,
    profileCacheHits: 0,
    midWaveCalls: 0,
    midWaveCacheHits: 0,
    errorHintCalls: 0,
    errorHintCacheHits: 0,
  };

  while (totalIterations < MAX_TOTAL_ITERATIONS) {
    if (signal?.aborted) {
      console.log(`[AgentRunner] 🛑 Run aborted by user (Outer Loop)`);
      return {
        success: false,
        summary: "Run aborted by user.",
        port: detectedFrontendPort ?? undefined,
        backendPort: detectedBackendPort ?? undefined,
      };
    }
    waveIndex++;
    cachedDigest = null; // reset digest for each new wave

    console.log(`[AgentRunner] ── Wave #${waveIndex} ──────────────────────────`);

    const rawWave = planMode ? [] : await todoService.getReadyTodos(workspaceId);

    if (rawWave.length === 0 && !planMode) {
      const allTodos = await todoService.listAllTodos(workspaceId);
      if (allTodos.length === 0) {
        console.warn(
          `[AgentRunner] ⚠️ WARNING: No todos found in workspace. Check if ai-agents.md was parsed correctly.`,
        );
        emit(
          "AGENT_EVENT",
          "No todos created. Verify ai-agents.md exists and has a TODOS section.",
          { workspaceId },
        );
      } else {
        console.log(`[AgentRunner] ✅ All ${allTodos.length} todos completed.`);
      }
      emit("ALL_TODOS_COMPLETE", "All todos have been completed.");
      break;
    }

    // Cap at 1 todo per wave — multi-task waves require LLM to emit multiple FINAL ANSWER
    // signals reliably which causes infinite loops. Single-task waves are stable.
    // True parallelism will be handled via per-todo BullMQ jobs in a future refactor.
    const cappedWave = rawWave.slice(0, 1);

    // In plan mode with no DB todos, use an ephemeral in-memory task
    const wave: WaveTodo[] =
      cappedWave.length > 0
        ? cappedWave.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            order: t.order,
          }))
        : [
            {
              id: "plan-mode-ephemeral",
              title: "Planning",
              description: projectIdea || "",
              order: 1,
            },
          ];

    const isDeadlocked = rawWave.length > 0 && (rawWave[0] as any).deadlocked === true;
    if (isDeadlocked) {
      console.warn(
        `[AgentRunner] ⚠️ Deadlock broken — force-running "${wave[0].title}" despite unsatisfied deps`,
      );
      emit("AGENT_EVENT", "Dependency deadlock detected — force-running next available task.", {
        todoId: wave[0].id,
      });
    }

    console.log(
      `[AgentRunner] 📝 Wave todos: [${wave.map((t) => `"${t.title}"(order=${t.order})`).join(", ")}]`,
    );

    // Mark all wave todos as in-progress (skipped in plan mode)
    if (!planMode) {
      await Promise.allSettled(wave.map((t) => todoService.markInProgress(t.id)));
    }

    // ── Refresh memory block: pretti-memory-first when enabled, else vector + static ──
    try {
      let combined: string;
      if (isPrettiMemoryEnabled() && userId) {
        const profileCacheKey = `${workspaceId}:${userId}`;
        let smRaw: string | null;

        if (profileCache.has(profileCacheKey)) {
          smRaw = profileCache.get(profileCacheKey) ?? null;
          prettiMemoryMetrics.profileCacheHits++;
          console.log(
            `[AgentRunner] pretti-memory profile cache hit (wave ${waveIndex})`,
          );
        } else {
          prettiMemoryMetrics.profileCalls++;
          const q = buildPrettiMemoryProfileQuery(
            wave[0].title,
            wave[0].description,
            framework || "Next.js",
            latestUserMessageContent(dbMessages),
          );
          const SM_TIMEOUT_MS = 6000;
          const timeout = <T>(p: Promise<T>) =>
            Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), SM_TIMEOUT_MS))]);
          smRaw = await timeout(
            fetchProfileContextBlock(workspaceId, userId, q, framework || "Next.js", wave[0].title),
          );
          profileCache.set(profileCacheKey, smRaw);
          console.log(
            `[AgentRunner] pretti-memory profile fetched and cached (wave ${waveIndex})`,
          );
        }
        combined = smRaw ? `### pretti-memory (profile + recall)\n${smRaw}` : "";
      } else {
        combined = await retrieveRelevantMemory(
          workspaceId,
          {
            currentTask: wave.map((t) => t.title).join(", "),
            framework: framework || "Next.js",
            recentErrors: [],
          },
          staticMemoryInput,
        );
      }
      systemPrompt = combined
        ? `${basePrompt}\n\n<memory_context>\n${combined}\n</memory_context>`
        : basePrompt;

      // ── Build skills menu (available in BUILD mode only) ────────────────
      const allSkills = await discoverSkills();
      if (allSkills.length === 0) {
        console.error(`[SKILL] ❌ FATAL: No skills discovered — check that SKILL.md files are deployed to dist/src/skills/. Run: npm run build`);
      }
      if (allSkills.length > 0 && !planMode) {
        const skillsMenu = buildSkillsMenuBlock(allSkills);
        systemPrompt = `${systemPrompt}\n\n${skillsMenu}`;
      }

      // ── Skill routing: select active persona based on current todo ────────
      // Plan mode: skill routing WITH guardrails (planning-focused persona wrapper)
      // Build mode: route COMPLEX tasks only (skip small tasks for speed)
      // ── Skill routing: Qwen-driven, semantic-based (90%+ accuracy) ────────────────
      let activeSkill: ActiveSkillContext | null = null;

      if (wave.length > 0) {
        const taskDesc = wave[0].description || wave[0].title;
        console.log(`[SKILL] ── semantic routing ────────────────────────────────────────`);
        console.log(`[SKILL] task: "${taskDesc.slice(0, 80)}${taskDesc.length > 80 ? "..." : ""}"`);

        // Decide if task needs routing (LLM-driven, not hardcoded wave rules)
        const needsRouting = await shouldRoute(taskDesc, planMode ? "plan" : "build");

        if (needsRouting) {
          console.log(`[SKILL] → ROUTING (Qwen classifier: qwen-plus for 90%+ accuracy)`);
          const manifest = await selectSkillForTask(taskDesc);
          if (manifest) {
            console.log(`[SKILL] ── loading ──────────────────────────────────────────────`);
            const persona = await loadSkillPersona(manifest, planMode);
            console.log(`[SKILL] ── injecting ────────────────────────────────────────────`);
            activeSkill = { manifest, persona };
            const skillBlock = buildActiveSkillBlock(persona, manifest.name);
            systemPrompt = `${systemPrompt}${skillBlock}`;
            const baseTokens = Math.round(basePrompt.length / 4);
            const skillTokens = Math.round(persona.length / 4);
            console.log(`[SKILL] system prompt: base(${baseTokens} tokens) + skill_persona(${skillTokens} tokens) = ${baseTokens + skillTokens} tokens`);
            console.log(`[SKILL] ── active ───────────────────────────────────────────────`);
            console.log(`[SKILL] persona "${manifest.name}" active for this task`);

            // ── Emit skill activation event to frontend ────────────────────
            emit("SKILL_ACTIVATED", `Using ${manifest.name} skill`, {
              skillName: manifest.name,
              skillDescription: manifest.description,
              taskDescription: taskDesc,
              waveIndex,
              todoId: wave[0].id,
              todoTitle: wave[0].title,
            });
          } else {
            console.log(`[SKILL] selectSkillForTask returned null (Qwen picked 'none' or no heuristic match)`);
          }
        } else {
          console.log(`[SKILL] → SKIP ROUTING (Qwen: task doesn't need specialized skill)`);
        }
      }

      const loopE2bDomain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
      systemPrompt = systemPrompt.replaceAll(".e2b.app", `.${loopE2bDomain}`);
    } catch (err) {
      console.warn(
        "[AgentRunner] Smart retrieval failed, using static memory:",
        (err as Error).message,
      );
    }

    if (dbMessages.length > 0 && dbMessages[0].role === "system") {
      dbMessages[0] = { ...dbMessages[0], content: systemPrompt };
    }

    // ── Ensure system prompt is ALWAYS present ──────────────────
    const hasSystemMsg = dbMessages.length > 0 && dbMessages[0].role === "system";

    if (!hasSystemMsg) {
      console.log(`[AgentRunner] No system prompt found — prepending system identity`);
      const systemMsg: DbMessage = { role: "system", content: systemPrompt };
      await messageService.createMessage({ workspaceId, ...systemMsg });
      dbMessages.unshift(systemMsg);
    }

    // Seed or inject the wave task message
    const isFirstWave = waveIndex === 1;
    const hasTaskMessage = dbMessages.some(
      (m) =>
        m.role === "user" &&
        (m.content.includes("## Your Task") || m.content.includes("## Your Tasks")),
    );

    // ── A1: On EVERY wave of a follow-up, pre-load the files most likely to be edited
    // (those written in prior runs AND earlier waves of this run) so the agent edits
    // directly instead of burning iterations searching/reading. Each file is injected at
    // most once per run (injectedFilePaths) to avoid re-bloating context every wave.
    let relevantFilesBlock = "";
    if (isFollowUp) {
      const editedPaths = extractRecentEditedPaths(dbMessages, 3).filter(
        (p) => !injectedFilePaths.has(p),
      );
      if (editedPaths.length > 0) {
        const PER_FILE_CHARS = 16000;
        const blocks: string[] = [];
        try {
          const sandbox = await getSandbox();
          for (const p of editedPaths) {
            try {
              const content = await sandbox.files.read(p);
              if (typeof content === "string" && content.trim()) {
                const body =
                  content.length > PER_FILE_CHARS
                    ? `${content.slice(0, PER_FILE_CHARS)}\n… [truncated — read_file for the rest if needed]`
                    : content;
                blocks.push(`### ${p}\n\`\`\`\n${body}\n\`\`\``);
                injectedFilePaths.add(p);
              }
            } catch {
              // file deleted/renamed since last run — skip
            }
          }
        } catch (e) {
          console.warn(`[AgentRunner] A1 pre-load skipped: ${(e as Error).message}`);
        }
        if (blocks.length > 0) {
          console.log(`[AgentRunner] A1 pre-loaded ${blocks.length} recent file(s) into seed`);
          relevantFilesBlock = [
            ``,
            ``,
            `## Relevant Files (current contents — edit these directly)`,
            `These files were written in the previous session and are the most likely targets for this change. Their FULL current content is below. Do NOT search_code or re-read them — call edit_file (operation=replace) directly, copying the exact find string from the content here.`,
            ``,
            blocks.join("\n\n"),
          ].join("\n");
        }
      }
    }

    if (isFirstWave && !hasTaskMessage) {
      console.log(`[AgentRunner] First wave — seeding initial task prompt`);
      const userMsg: DbMessage = {
        role: "user",
        content: buildInitialWaveMessage(wave, sandboxId, workspaceId, framework) + relevantFilesBlock,
      };
      await messageService.createMessage({ workspaceId, ...userMsg });
      dbMessages.push(userMsg);
    } else {
      console.log(`[AgentRunner] Injecting next-wave prompt`);
      const nextMsg: DbMessage = { role: "user", content: buildNextWaveMessage(wave, modifiedFiles, { frontend: detectedFrontendPort, backend: detectedBackendPort }) + relevantFilesBlock };
      await messageService.createMessage({ workspaceId, ...nextMsg });
      dbMessages.push(nextMsg);
    }

    // ── Inner iteration loop for this wave ────────────────────
    let shellFailCount = 0;
    const SHELL_FAIL_LIMIT = 6;
    // Budget scales with wave size so each task gets a fair share
    const waveBudget = MAX_ITERATIONS * wave.length;
    const completedOrders = new Set<number>(); // orders completed this wave

    for (let iteration = 0; iteration < waveBudget; iteration++) {
      if (signal?.aborted) {
        console.log(`[AgentRunner] 🛑 Run aborted by user (Inner Loop Iteration ${iteration})`);
        return {
          success: false,
          summary: "Run aborted by user.",
          port: detectedFrontendPort ?? undefined,
          backendPort: detectedBackendPort ?? undefined,
        };
      }
      totalIterations++;
      if (totalIterations >= MAX_TOTAL_ITERATIONS) {
        console.error(`[AgentRunner] ❌ Global iteration cap (${MAX_TOTAL_ITERATIONS}) reached.`);
        return {
          success: false,
          summary: "Global iteration cap reached.",
          port: detectedFrontendPort ?? undefined,
          backendPort: detectedBackendPort ?? undefined,
        };
      }

      console.log(
        `[AgentRunner] ── Wave #${waveIndex} · Iteration ${iteration + 1}/${waveBudget} ──────────────`,
      );

      // Mid-wave context: inject once on iteration 1 only; cache result for the run.
      if (isPrettiMemoryEnabled() && iteration === 1) {
        const latestContent = latestUserMessageContent(dbMessages);
        const cacheKey = wave[0].title;
        let midCtx: string | null = null;
        if (midWaveCache.has(cacheKey)) {
          midCtx = midWaveCache.get(cacheKey) ?? null;
          prettiMemoryMetrics.midWaveCacheHits++;
          console.log(`[AgentRunner] pretti-memory mid-wave cache hit (iteration ${iteration + 1}).`);
        } else if (userId) {
          prettiMemoryMetrics.midWaveCalls++;
          midCtx = await Promise.race([
            fetchMidWaveContext(workspaceId, userId, wave[0].title, latestContent, framework || "Next.js").catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 6000)),
          ]);
          midWaveCache.set(cacheKey, midCtx);
        }
        if (midCtx) {
          dbMessages.push({
            role: "user",
            content: `<pretti_memory_context>\n${midCtx}\n</pretti_memory_context>`,
          });
          console.log(`[AgentRunner] pretti-memory mid-wave context injected (iteration ${iteration + 1}).`);
        }
      }

      console.log(`[AgentRunner]   Total messages in context: ${dbMessages.length}`);

      let dbMessagesForRequest = sanitizeDbMessages(dbMessages);

      // Keep images only for the last 2 user messages that contain them to prevent massive payloads
      let imageMsgCount = 0;
      for (let i = dbMessagesForRequest.length - 1; i >= 0; i--) {
        const m = dbMessagesForRequest[i];
        if (m.role === "user" && m.images && m.images.length > 0) {
          imageMsgCount++;
          if (imageMsgCount > 2) {
            m.images = undefined;
            m.content = m.content + "\n[Images previously analyzed]";
          }
        }
      }

      const tokenCount = estimateTokens(buildOpenAIMessages(dbMessagesForRequest));
      console.log(`[AgentRunner]   Estimated tokens: ~${tokenCount} (limit: ${TOKEN_LIMIT})`);
      if (tokenCount > TOKEN_LIMIT * 0.7) {
        console.log(
          `[AgentRunner]   ⚠️ Token count high, trimming to system + user + last 50 messages`,
        );

        // Always preserve the identity (system prompt at index 0)
        // and the initial task goal (initial user message at index 1)
        const head = dbMessages.slice(0, 2);

        // Grab the most recent context
        let recent = dbMessages.slice(-50);

        // If recent overlaps with head, just use dbMessages
        if (dbMessages.length <= 52) {
          dbMessagesForRequest = dbMessages;
        } else {
          // Clean up recent to avoid starting with a tool result without its call
          while (recent.length > 0 && recent[0].role === "tool") recent.shift();

          // Summarize dropped messages (first trim only, then cache)
          if (!cachedDigest) {
            const droppedMessages = dbMessages.slice(2, -50);
            if (droppedMessages.length > 0 && llmOpenAI) {
              console.log(
                `[AgentRunner]   Summarizing ${droppedMessages.length} dropped messages...`,
              );
              const llmCall = async (sysPrompt: string, userContent: string) => {
                const resp = await llmOpenAI!.chat.completions.create({
                  model: "qwen3.6-plus",
                  messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: userContent },
                  ],
                  temperature: 0.3,
                });
                return resp.choices[0].message.content?.trim() || "";
              };
              const digest = await summarizeDroppedMessages(droppedMessages, llmCall).catch(
                (err) => {
                  console.warn(
                    `[AgentRunner]   Summarization failed, falling back to hard trim:`,
                    err.message,
                  );
                  return null;
                },
              );
              if (digest) {
                cachedDigest = formatDigestAsMessage(digest) as DbMessage;
                console.log(
                  `[AgentRunner]   Digest cached (${cachedDigest!.content.length} chars)`,
                );
              }
            }
          }

          dbMessagesForRequest = cachedDigest
            ? [...head, cachedDigest, ...recent]
            : [...head, ...recent];
        }

        console.log(
          `[AgentRunner]   After trim: ${dbMessagesForRequest.length} db messages, ~${estimateTokens(buildOpenAIMessages(dbMessagesForRequest))} tokens`,
        );
      }

      let llmResponse: UnifiedLLMResponse | null = null;
      const modelConfig: ModelConfig = getModelConfigForAgent({
        framework: framework || "Next.js",
        taskType: wave[0].title.toLowerCase(),
        description: wave[0].description?.toLowerCase(),
        provider: currentProvider || (DEFAULT_PROVIDER as ProviderName),
      });
      let fullContent = "";
      try {
        console.log(
          `[AgentRunner]   🤖 Sending LLM request to ${modelConfig.model} (provider=${currentProvider}, source=${llmSource})...`,
        );
        const llmStart = Date.now();
        if (llmKind === "openai") {
          if (!llmOpenAI) throw new Error("OpenAI client not initialized");
          const rawMessages = sanitizeOpenAIMessages(buildOpenAIMessages(dbMessagesForRequest));
          // Truncate old tool results for Azure to avoid content management policy triggers
          const messages = currentProvider === "QWEN_DASHSCOPE"
            ? rawMessages
            : truncateOldToolResults(rawMessages);

          const messageId = crypto.randomUUID();
          emit("AGENT_STREAM_START", "", { messageId });

          const stream = await callLLMWithRetryStream(
            llmOpenAI,
            {
              model: modelConfig.model,
              messages,
              tools: activeToolSchemas as any,
              tool_choice: "auto",
              ...(modelConfig.model.startsWith("gpt-5") ? {} : { temperature: modelConfig.temperature }),
              stream: true,
              stream_options: { include_usage: true },
            },
            currentProvider,
            signal,
          );

          const toolCallsMap: Record<number, any> = {};
          let finishReason: string | undefined = undefined;
          let usageInfo: any = {};

          for await (const chunk of stream) {
            if (signal?.aborted) throw new Error("Aborted");
            const choice = chunk.choices[0];
            const delta = choice?.delta;

            if (delta?.content) {
              fullContent += delta.content;
              process.stdout.write(delta.content); // Trace to terminal
              emit("AGENT_STREAM_CHUNK", "", { messageId, text: delta.content });
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                // process.stdout.write(" [tool_call] ");
                if (!toolCallsMap[tc.index]) {
                  toolCallsMap[tc.index] = {
                    id: tc.id,
                    type: "function",
                    function: { name: tc.function?.name || "", arguments: "" },
                  };
                  if (tc.id && tc.function?.name) {
                    emit("AGENT_TOOL_STREAM_START", "", {
                      messageId,
                      toolCallId: tc.id,
                      toolName: tc.function.name,
                    });
                  }
                }
                if (tc.function?.arguments) {
                  toolCallsMap[tc.index].function.arguments += tc.function.arguments;
                  const toolCallId = toolCallsMap[tc.index].id;
                  if (toolCallId) {
                    emit("AGENT_TOOL_STREAM_CHUNK", "", {
                      messageId,
                      toolCallId,
                      text: tc.function.arguments,
                    });
                  }
                }
              }
            }

            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            if ((chunk as any).usage) {
              usageInfo = (chunk as any).usage;
            }
          }

          const toolCalls = Object.values(toolCallsMap);

          llmResponse = {
            assistantMsg: {
              content: fullContent,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            },
            finishReason: finishReason,
            usage: {
              prompt: usageInfo?.prompt_tokens,
              completion: usageInfo?.completion_tokens,
              total: usageInfo?.total_tokens,
            },
          };
        } else {
          if (!llmAnthropic) throw new Error("Anthropic client not initialized");
          const { system, messages: rawAnthropicMessages } =
            buildAnthropicMessages(dbMessagesForRequest);
          const messages = sanitizeAnthropicMessages(rawAnthropicMessages);

          const messageId = crypto.randomUUID();
          emit("AGENT_STREAM_START", "", { messageId });

          const stream = llmAnthropic.messages.stream(
            {
              model: modelConfig.model,
              system,
              messages: messages as any,
              tools: activeAnthropicTools as any,
              tool_choice: { type: "auto" } as any,
              max_tokens: Math.max(4096, modelConfig.maxTokens || 4096),
              temperature: modelConfig.temperature,
            },
            { signal },
          );

          let currentToolCallId: string | null = null;

          for await (const event of stream) {
            if (signal?.aborted) throw new Error("Aborted");

            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              fullContent += event.delta.text;
              emit("AGENT_STREAM_CHUNK", "", { messageId, text: event.delta.text });
            } else if (
              event.type === "content_block_start" &&
              event.content_block.type === "tool_use"
            ) {
              currentToolCallId = event.content_block.id;
              emit("AGENT_TOOL_STREAM_START", "", {
                messageId,
                toolCallId: event.content_block.id,
                toolName: event.content_block.name,
              });
            } else if (
              event.type === "content_block_delta" &&
              event.delta.type === "input_json_delta"
            ) {
              if (currentToolCallId) {
                emit("AGENT_TOOL_STREAM_CHUNK", "", {
                  messageId,
                  toolCallId: currentToolCallId,
                  text: event.delta.partial_json,
                });
              }
            }
          }

          const finalMessage = await stream.finalMessage();
          // Use finalMessage.content directly — the SDK guarantees block.input is a valid
          // parsed object, avoiding partial_json concatenation issues with special chars.
          const toolCalls = finalMessage.content
            .filter((block: any) => block.type === "tool_use")
            .map((block: any) => ({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            }));

          llmResponse = {
            assistantMsg: {
              content: fullContent,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            },
            finishReason: finalMessage.stop_reason || undefined,
            usage: {
              prompt: finalMessage.usage?.input_tokens,
              completion: finalMessage.usage?.output_tokens,
              total:
                (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0),
            },
          };
        }
        const llmElapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
        console.log(`[AgentRunner]   🤖 LLM responded in ${llmElapsed}s`);
        emit("LLM_RESPONDED", `Agent responded in ${llmElapsed}s`);
        console.log(`[AgentRunner]       finish_reason: ${llmResponse.finishReason}`);
        console.log(
          `[AgentRunner]       usage: prompt=${llmResponse.usage?.prompt}, completion=${llmResponse.usage?.completion}, total=${llmResponse.usage?.total}`,
        );
        // Accumulate for billing (no DB write)
        if (ctx.usageAccumulator && llmResponse.usage?.total) {
          const mode = ctx.planMode
            ? "planning"
            : (llmResponse.assistantMsg.tool_calls?.length ? "tool_call" : "build");
          ctx.usageAccumulator.push({
            promptTokens: llmResponse.usage.prompt ?? 0,
            completionTokens: llmResponse.usage.completion ?? 0,
            totalTokens: llmResponse.usage.total,
            provider: currentProvider,
            mode,
          });
        }
      } catch (err: any) {
        if (signal?.aborted) {
          console.log(
            `[AgentRunner] 🛑 Abort detected in LLM stream loop. Saving partial content...`,
          );
          if (fullContent) {
            await messageService.createMessage({
              workspaceId,
              role: "assistant",
              content: fullContent,
            });
          }
          return {
            success: false,
            summary: "Run aborted by user.",
            port: detectedFrontendPort ?? undefined,
            backendPort: detectedBackendPort ?? undefined,
          };
        }

        console.error(`[AgentRunner] ❌ LLM error:`, err.message);
        const status = (err as any)?.status ?? (err as any)?.response?.status;
        const msg = (err as any)?.message || "";
        const isAuthErr =
          status === 401 ||
          /incorrect api key|invalid api key|authentication|unauthorized/i.test(msg);

        if (isAuthErr) {
          // First: if user key failed, try system default once
          if (llmSource === "user" && !retriedWithEnv) {
            retriedWithEnv = true;
            console.warn(
              "[AgentRunner] User key failed auth; falling back to system env key/default provider.",
            );
            emit(
              "LLM_CONFIG",
              "Your API key failed authentication. Falling back to server key/provider.",
              { provider: currentProvider, source: llmSource, fallback: "env" },
            );
            try {
              const fallbackProv = normalizeProvider(DEFAULT_PROVIDER as any);
              const fallback = await createLLMClient({ workspaceId, provider: fallbackProv });
              if (fallback.kind !== "unsupported") {
                llmKind = fallback.kind;
                llmSource = fallback.meta.source;
                currentProvider = fallback.meta.provider;
                if (fallback.kind === "openai") {
                  llmOpenAI = fallback.client;
                  llmAnthropic = null;
                } else {
                  llmAnthropic = fallback.client;
                  llmOpenAI = null;
                }
                emit(
                  "LLM_CONFIG",
                  `Fallback active: provider=${currentProvider}, source=${llmSource}.`,
                  { provider: currentProvider, source: llmSource, fallbackActive: true },
                );
                continue; // retry the iteration with fallback client
              }
            } catch (fallbackErr: any) {
              console.error("[AgentRunner] Fallback client build failed:", fallbackErr.message);
            }
          }
          // Second: if still failing and not already on DashScope, try DashScope/Qwen with same env key
          if (currentProvider !== "QWEN_DASHSCOPE") {
            console.warn("[AgentRunner] Auth still failing; attempting DashScope/Qwen fallback.");
            try {
              const dashFallback = await createLLMClient({
                workspaceId,
                provider: "QWEN_DASHSCOPE",
              });
              if (dashFallback.kind === "openai") {
                llmKind = "openai";
                llmOpenAI = dashFallback.client;
                llmAnthropic = null;
                llmSource = dashFallback.meta.source;
                currentProvider = dashFallback.meta.provider;
                continue; // retry with dashscope
              }
            } catch (dashErr: any) {
              console.error("[AgentRunner] DashScope fallback failed:", dashErr.message);
            }
          }
        }

        // For the empty-output error specifically, nudge the agent rather than
        // killing the whole run — it is transient and can be recovered from.
        const isEmptyOutputError =
          typeof err?.message === "string" &&
          err.message.toLowerCase().includes("model output must contain");
        if (isEmptyOutputError) {
          console.warn(
            `[AgentRunner] ⚠️  Qwen3 returned empty output after ${MAX_LLM_RETRIES} retries. Injecting nudge and continuing…`,
          );
          const nudge: DbMessage = {
            role: "user",
            content:
              "[System] The model returned an empty response. Please continue working on the current task by calling a tool or providing your next reasoning step.",
          };
          await messageService.createMessage({ workspaceId, ...nudge });
          dbMessages.push(nudge);
          continue; // retry the inner iteration loop
        }

        // Recover from DashScope rejecting malformed tool call JSON
        const isInvalidParamError =
          status === 400 && /InvalidParameter|function\.arguments.*JSON/i.test(msg);
        if (isInvalidParamError) {
          console.warn(
            `[AgentRunner] DashScope rejected malformed tool args. Injecting recovery nudge...`,
          );
          const nudge: DbMessage = {
            role: "user",
            content:
              "[System] Your previous tool call had malformed JSON arguments and was rejected by the API. This commonly happens with edit_file replace operations containing complex code. Use edit_file with operation='overwrite' instead — read the file first, then overwrite with the full updated content.",
          };
          await messageService.createMessage({ workspaceId, ...nudge });
          dbMessages.push(nudge);
          continue;
        }

        // Azure content filter — permanently switch to Qwen for this run
        const isContentFilter =
          status === 400 && /content management policy|content filter/i.test(msg);
        if (isContentFilter && currentProvider !== "QWEN_DASHSCOPE") {
          console.warn("[AgentRunner] Azure content filter — permanently switching to Qwen for this run.");
          const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
          if (qwenKey) {
            llmKind = "openai";
            llmOpenAI = new OpenAI({
              apiKey: qwenKey,
              baseURL: process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            });
            llmAnthropic = null;
            llmSource = "env";
            currentProvider = "QWEN_DASHSCOPE";
            emit("LLM_CONFIG", "Azure content filter — switched to Qwen for remainder of run.", { provider: "QWEN_DASHSCOPE", fallbackActive: true });

            // Inject state summary so Qwen doesn't re-read or re-verify completed work
            const filesSoFar = Array.from(modifiedFiles);
            const portInfo = [
              detectedFrontendPort ? `frontend=:${detectedFrontendPort}` : null,
              detectedBackendPort ? `backend=:${detectedBackendPort}` : null,
            ].filter(Boolean).join(", ");
            const stateSummary: DbMessage = {
              role: "user",
              content: [
                "[SYSTEM] Model switched to Qwen. Continue the current task from the exact point interrupted.",
                filesSoFar.length ? `Files already written: ${filesSoFar.join(", ")}.` : "",
                portInfo ? `Servers already confirmed running: ${portInfo}. DO NOT call check_health or restart servers.` : "",
                "DO NOT re-read files already processed. DO NOT re-check health. DO NOT call todo_manager to re-list. Pick up from where writing left off.",
              ].filter(Boolean).join(" "),
            };
            await messageService.createMessage({ workspaceId, ...stateSummary });
            dbMessages.push(stateSummary);
            continue;
          }
        }

        return {
          success: false,
          summary: `LLM failed: ${err.message}`,
          port: detectedFrontendPort ?? undefined,
          backendPort: detectedBackendPort ?? undefined,
        };
      }

      if (!llmResponse) {
        return {
          success: false,
          summary: "LLM did not return a response.",
          port: detectedFrontendPort ?? undefined,
          backendPort: detectedBackendPort ?? undefined,
        };
      }

      const assistantMsg = llmResponse.assistantMsg;
      const finishReason = llmResponse.finishReason;

      const assistantDbRow: DbMessage = {
        role: "assistant",
        content: assistantMsg.content || "",
        toolCalls: assistantMsg.tool_calls?.length
          ? JSON.stringify(assistantMsg.tool_calls)
          : undefined,
      };

      if (assistantMsg.content) {
        console.log(
          `[AgentRunner]   Assistant text: ${assistantMsg.content.slice(0, 200)}${assistantMsg.content.length > 200 ? "..." : ""}`,
        );
      }
      if (assistantMsg.tool_calls?.length) {
        console.log(
          `[AgentRunner]   Assistant requested ${assistantMsg.tool_calls.length} tool call(s)`,
        );
      }

      await messageService.createMessage({ workspaceId, ...assistantDbRow });

      dbMessages.push(assistantDbRow);

      if (assistantMsg.tool_calls?.length) {
        // If the LLM simultaneously output FINAL ANSWER text + tool calls, skip the tool calls.
        // Executing them causes redundant post-completion edits.
        if (!planMode && assistantMsg.content?.includes("FINAL ANSWER")) {
          console.log(`[AgentRunner]   FINAL ANSWER in content — skipping ${assistantMsg.tool_calls.length} tool call(s) to avoid redundant edits.`);
          assistantMsg.tool_calls = undefined;
        }
      }

      if (assistantMsg.tool_calls?.length) {
        for (const toolCall of assistantMsg.tool_calls) {
          if (signal?.aborted) {
            console.log(`[AgentRunner] 🛑 Run aborted by user (Tool Loop)`);
            return {
              success: false,
              summary: "Run aborted by user.",
              port: detectedFrontendPort ?? undefined,
              backendPort: detectedBackendPort ?? undefined,
            };
          }
          const fn = (toolCall as any).function;
          const toolName = fn.name as ToolName;
          let args: Record<string, any>;

          try {
            args = JSON.parse(fn.arguments);
          } catch {
            // Attempt lightweight JSON repair before giving up
            const repaired = tryRepairJson(fn.arguments);
            if (repaired !== null) {
              console.warn(`[AgentRunner]   Tool ${toolName}: repaired malformed JSON args`);
              args = repaired;
            } else {
              console.error(
                `[AgentRunner]   ❌ Tool ${toolName}: invalid JSON args (repair failed)`,
              );
              const errRow: DbMessage = {
                role: "tool",
                content: JSON.stringify({
                  success: false,
                  error: `Invalid JSON in tool arguments for ${toolName}. Your JSON was malformed (likely unescaped quotes or newlines in string values). If you were using edit_file with replace, switch to overwrite instead — read the full file first, then overwrite with your changes applied.`,
                }),
                toolCallId: toolCall.id,
                toolName,
              };
              await messageService.createMessage({ workspaceId, ...errRow });
              dbMessages.push(errRow);
              continue;
            }
          }

          // Inject sandboxId automatically for all applicable tools
          if (
            [
              "execute_shell",
              "read_file",
              "edit_file",
              "search_code",
              "context_save",
              "check_health",
            ].includes(toolName) &&
            !args.sandboxId
          ) {
            args.sandboxId = sandboxId;
          }

          // Auto-inject workspaceId for todo_manager so the LLM can't hallucinate it
          if (toolName === "todo_manager") {
            args.workspaceId = workspaceId;
          }

          // Auto-inject workspaceId + sandboxId for env_manager
          if (toolName === "env_manager") {
            args.workspaceId = workspaceId;
            args.sandboxId = sandboxId;
          }

          // Auto-inject workspaceId + sandboxId for provision_database
          if (toolName === "provision_database") {
            args.workspaceId = workspaceId;
            args.sandboxId = sandboxId;
          }

          // ── Break never-ending search/read inspection loops (any non-plan run) ──
          // The agent over-inspects existing files (search_code in circles, or paginating
          // reads via python3/cat/sed) and never writes. Count every read-only call since
          // the last edit; reset ONLY on edit_file so interleaved search↔read still counts.
          // Soft nudge first, then hard-reject further search_code to force a read+edit.
          if (!planMode) {
            // NOTE: readOnlyStreak resets on a SUCCESSFUL edit_file (handled post-execution),
            // not here — a failed edit must keep the streak climbing toward the hard cap.
            if (
              toolName === "search_code" ||
              toolName === "read_file" ||
              toolName === "execute_shell"
            ) {
              readOnlyStreak++;

              // HARD: refuse further search_code once over budget — it's line-based and
              // can't anchor a multi-line edit anyway. Skip execution, point to read_file.
              if (toolName === "search_code" && readOnlyStreak >= EXPLORE_HARD_LIMIT) {
                console.log(
                  `[AgentRunner] ⛔ search_code rejected (readOnlyStreak=${readOnlyStreak} ≥ ${EXPLORE_HARD_LIMIT}) — forcing read_file + edit`,
                );
                const blockRow: DbMessage = {
                  role: "tool",
                  content: JSON.stringify({
                    success: false,
                    error: `search_code is disabled after ${readOnlyStreak} inspection calls without an edit. You have enough context. Use read_file ONCE on the target file (it returns the COMPLETE file), then edit_file (operation=replace). Do NOT call search_code again.`,
                  }),
                  toolCallId: toolCall.id,
                  toolName,
                };
                await messageService.createMessage({ workspaceId, ...blockRow });
                dbMessages.push(blockRow);
                continue;
              }

              // SOFT: one nudge at the soft limit.
              if (readOnlyStreak === EXPLORE_SOFT_LIMIT) {
                console.log(
                  `[AgentRunner] 🔁 exploration soft cap (readOnlyStreak=${readOnlyStreak}) — nudging agent to edit`,
                );
                const exploreNudge: DbMessage = {
                  role: "user",
                  content: `SYSTEM: You have run ${readOnlyStreak} search/read/shell calls without editing a single file. Stop inspecting — you already have enough context. Use read_file ONCE on the target (it returns the WHOLE file — never read files via execute_shell/python/cat/sed/head), then make the change with edit_file (operation=replace). Do not search again unless an edit_file actually fails.`,
                };
                await messageService.createMessage({ workspaceId, ...exploreNudge });
                dbMessages.push(exploreNudge);
              }
            }
          }

          // ── PLAN MODE GUARDRAILS ────────────────────────────────────
          if (planMode) {
            // Block edit_file outside plan.md path
            if (toolName === "edit_file" && args.path) {
              const allowedPlanPath = "/workspace/plan.md";
              if (args.path !== allowedPlanPath) {
                console.log(`[AgentRunner] 🚫 PLAN MODE: Blocked edit_file to ${args.path}`);
                const blockRow: DbMessage = {
                  role: "tool",
                  content: JSON.stringify({
                    success: false,
                    error: `PLAN MODE: You may only write to /workspace/plan.md. Do not write any other files until the user confirms implementation.`,
                  }),
                  toolCallId: toolCall.id,
                  toolName,
                };
                await messageService.createMessage({ workspaceId, ...blockRow });
                dbMessages.push(blockRow);
                continue;
              }
            }

            // Block shell commands that are not read-only
            if (toolName === "execute_shell" && args.command) {
              if (!isPlanModeShellAllowed(args.command)) {
                console.log(`[AgentRunner] 🚫 PLAN MODE: Blocked shell command: ${args.command}`);
                const blockRow: DbMessage = {
                  role: "tool",
                  content: JSON.stringify({
                    success: false,
                    error: `PLAN MODE: Only read-only shell commands are allowed (ls, find, cat, grep, head, tail, wc). No builds, installs, or file modifications.`,
                  }),
                  toolCallId: toolCall.id,
                  toolName,
                };
                await messageService.createMessage({ workspaceId, ...blockRow });
                dbMessages.push(blockRow);
                continue;
              }
            }

            // Cap exploration: after N read-only calls, nudge LLM to ask questions
            if (["read_file", "search_code", "execute_shell"].includes(toolName)) {
              planExploreCount++;
              if (planExploreCount === PLAN_EXPLORE_LIMIT) {
                console.log(
                  `[AgentRunner] 📋 PLAN MODE: Exploration cap reached (${planExploreCount}/${PLAN_EXPLORE_LIMIT})`,
                );
                const capNudge: DbMessage = {
                  role: "user",
                  content: `SYSTEM: You have explored ${planExploreCount} files/commands. Stop exploring now. You have enough context. Call submit_plan_questions immediately with your clarifying questions.`,
                };
                await messageService.createMessage({ workspaceId, ...capNudge });
                dbMessages.push(capNudge);
              }
            }

            // Intercept submit_plan_questions: emit PLAN_QUESTIONS and wait for answers
            if (toolName === "submit_plan_questions") {
              console.log(`[AgentRunner] 📋 PLAN MODE: submit_plan_questions intercepted`);
              emit("PLAN_QUESTIONS", "Agent is asking clarifying questions", {
                questions: args.questions || [],
                summary: args.summary || "",
              });

              // Wait for answers via Redis polling (up to 10 minutes)
              const answersKey = `plan-answers:${workspaceId}`;
              const POLL_INTERVAL = 2000;
              const MAX_WAIT_MS = 10 * 60 * 1000;
              const startWait = Date.now();
              let rawAnswers: string | null = null;

              console.log(`[AgentRunner] ⏳ Waiting for plan answers (key: ${answersKey})...`);
              while (Date.now() - startWait < MAX_WAIT_MS) {
                if (signal?.aborted) {
                  return {
                    success: false,
                    summary: "Run aborted by user.",
                    port: detectedFrontendPort ?? undefined,
                    backendPort: detectedBackendPort ?? undefined,
                  };
                }
                rawAnswers = await redisConnection.get(answersKey);
                if (rawAnswers) {
                  await redisConnection.del(answersKey);
                  break;
                }
                await new Promise((r) => setTimeout(r, POLL_INTERVAL));
              }

              const answers = rawAnswers ? JSON.parse(rawAnswers) : {};
              const answersText =
                Object.entries(answers)
                  .map(([qId, ans]) => `- ${qId}: ${ans}`)
                  .join("\n") || "(no answers received)";

              const toolRow: DbMessage = {
                role: "tool",
                content: JSON.stringify({
                  success: true,
                  data: `User answered your questions:\n${answersText}\n\nNow write the plan to /workspace/plan.md and then output FINAL ANSWER.`,
                }),
                toolCallId: toolCall.id,
                toolName,
              };
              await messageService.createMessage({ workspaceId, ...toolRow });
              dbMessages.push(toolRow);
              emit("TOOL_COMPLETED", "Plan answers received", { tool: toolName, success: true });
              continue;
            }
          }

          // ── GUARDRAIL: Prevent duplicate dev-server restarts ─────────
          if (toolName === "execute_shell" && args.command && isDevServerCommand(args.command)) {
            const intendedPort = parseIntendedDevServerPort(args.command);
            let shouldBlock = false;

            // Fast path: already tracked locally as started
            if (intendedPort && startedServerPorts.has(intendedPort)) {
              shouldBlock = true;
              console.log(
                `[AgentRunner]   🚫 BLOCKED (in-memory): port ${intendedPort} already started this run`,
              );
            }

            // Check sandbox for running server (both template and non-template)
            if (!shouldBlock) {
              try {
                const guardSandbox = await getSandbox();
                const runningCheck = intendedPort
                  ? await guardSandbox.commands.run(`ss -tlpn | grep -E ':${intendedPort}\\b'`)
                  : await guardSandbox.commands.run(
                      `ss -tlpn | grep -E ':3000\\b|:5173\\b|:8000\\b'`,
                    );
                const hasRunningServer =
                  runningCheck.exitCode === 0 && !!runningCheck.stdout.trim();
                if (hasRunningServer) {
                  shouldBlock = true;
                  console.log(
                    `[AgentRunner]   🚫 BLOCKED (ss check): server already on port ${intendedPort ?? "known"}`,
                  );
                }
              } catch (guardErr: any) {
                // If we can't verify AND we already started a port this run, block defensively
                if (startedServerPorts.size > 0) {
                  shouldBlock = true;
                  console.warn(
                    `[AgentRunner]   🚫 BLOCKED (guard failed + ports known): ${guardErr.message}`,
                  );
                } else {
                  console.warn(
                    `[AgentRunner]   Server guard check failed, allowing first start: ${guardErr.message}`,
                  );
                }
              }
            }

            if (shouldBlock) {
              devServerBlockCount++;
              const escalated = devServerBlockCount >= 2;
              const blockMsg = escalated
                ? `CRITICAL STOP: You have attempted to start a dev server ${devServerBlockCount} times. This is BLOCKED every time. The dev server is ALREADY RUNNING and auto-reloads on file saves. You MUST NOT attempt this again. IMMEDIATELY continue with editing files using edit_file. Do NOT call execute_shell with any dev server command.`
                : `BLOCKED: A dev server is already running${intendedPort ? ` on port ${intendedPort}` : ""}. Do NOT restart or re-run dev servers. The server auto-reloads on file changes. Use check_health to verify, then continue with file edits.`;

              const blockRow: DbMessage = {
                role: "tool",
                content: JSON.stringify({ success: false, error: blockMsg }),
                toolCallId: toolCall.id,
                toolName,
              };
              await messageService.createMessage({ workspaceId, ...blockRow });
              dbMessages.push(blockRow);

              // After 2+ blocked attempts, inject a system-level nudge to break the loop
              if (escalated) {
                console.warn(
                  `[AgentRunner]   ⚠️ Dev server blocked ${devServerBlockCount}x — injecting system nudge`,
                );
                const nudge: DbMessage = {
                  role: "user",
                  content: `SYSTEM: Stop trying to start dev servers. The server is already running and auto-reloads. Focus on editing code files with edit_file. Do NOT run npm run dev, next dev, or any server start command again.`,
                };
                await messageService.createMessage({ workspaceId, ...nudge });
                dbMessages.push(nudge);
              }

              emit(
                "TOOL_COMPLETED",
                `Blocked dev server command (attempt #${devServerBlockCount}): ${args.command}`,
                {
                  tool: toolName,
                  success: false,
                  output: "Blocked: dev server already running.",
                  command: args.command,
                  args,
                },
              );
              continue;
            }

            // Port will be tracked AFTER successful execution (see post-execution block below)
            if (intendedPort) {
              console.log(
                `[AgentRunner]   Allowing dev server start attempt on port ${intendedPort}`,
              );
            }
          }

          // ── GUARDRAIL: Block direct .env writes via edit_file ──────────────
          if (toolName === "edit_file" && args.path) {
            const isEnvFile = /\.env(\.[^/]+)?$/.test(args.path);
            if (isEnvFile) {
              console.log(`[AgentRunner]   🚫 BLOCKED direct .env write to: ${args.path}`);
              const blockRow: DbMessage = {
                role: "tool",
                content: JSON.stringify({
                  success: false,
                  error: [
                    `BLOCKED: Direct writes to .env files are not allowed (path: ${args.path}).`,
                    `Use the env_manager tool instead:`,
                    `  1. Call env_manager with action=resolve_url, port=<port> to get the correct sandboxUrl.`,
                    `  2. Call env_manager with action=set_vars, vars={KEY: value} to store vars in the DB.`,
                    `  3. Call env_manager with action=sync_to_sandbox to write the DB env to the sandbox .env file.`,
                    `NEVER use localhost or 127.0.0.1 in any env value — always use the sandboxUrl from resolve_url.`,
                  ].join("\n"),
                }),
                toolCallId: toolCall.id,
                toolName,
              };
              await messageService.createMessage({ workspaceId, ...blockRow });
              dbMessages.push(blockRow);
              emit("TOOL_COMPLETED", `Blocked .env write to ${args.path}`, {
                tool: toolName,
                success: false,
                output: `Blocked direct .env write. Use env_manager tool.`,
                args,
              });
              continue;
            }
          }

          // ── GUARDRAIL: Reject localhost references in any file content ──────
          if (toolName === "edit_file" && args.content && typeof args.content === "string") {
            const LOCALHOST_RE = /localhost|127\.0\.0\.1/i;
            if (LOCALHOST_RE.test(args.content)) {
              console.log(
                `[AgentRunner]   🚫 BLOCKED localhost reference in edit_file content for: ${args.path}`,
              );
              const e2bDomain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
              const blockRow: DbMessage = {
                role: "tool",
                content: JSON.stringify({
                  success: false,
                  error: [
                    `BLOCKED: The content you are writing to ${args.path} contains a forbidden localhost or 127.0.0.1 reference.`,
                    `All internal service URLs MUST use the E2B sandbox URL format: https://<port>-<sandboxId>.${e2bDomain}`,
                    `To get the correct URL: call env_manager with action=resolve_url, port=<port>.`,
                    `Example: NEXT_PUBLIC_API_URL=https://8000-${sandboxId}.${e2bDomain}`,
                    `Fix the content and retry without any localhost references.`,
                  ].join("\n"),
                }),
                toolCallId: toolCall.id,
                toolName,
              };
              await messageService.createMessage({ workspaceId, ...blockRow });
              dbMessages.push(blockRow);
              emit("TOOL_COMPLETED", `Blocked localhost reference in ${args.path}`, {
                tool: toolName,
                success: false,
                output: `Blocked: localhost reference found. Use env_manager resolve_url instead.`,
                args,
              });
              continue;
            }
          }

          console.log(`[AgentRunner]   🔧 Executing tool: ${toolName}`);
          console.log(`[AgentRunner]       args: ${JSON.stringify(args).slice(0, 300)}`);

          if (signal?.aborted) {
            console.log(`[AgentRunner] 🛑 Run aborted before tool execution`);
            return {
              success: false,
              summary: "Run aborted by user.",
              port: detectedFrontendPort ?? undefined,
              backendPort: detectedBackendPort ?? undefined,
            };
          }

          emit("TOOL_STARTED", `Executing tool: ${toolName}`, {
            tool: toolName,
            args,
            toolCallId: toolCall.id,
          });

          const toolStart = Date.now();
          const result = await executeSkill({ tool: toolName, params: args as any }, signal);
          const toolElapsed = ((Date.now() - toolStart) / 1000).toFixed(1);

          console.log(`[AgentRunner]       result in ${toolElapsed}s: success=${result.success}`);

          emit("TOOL_COMPLETED", `Tool ${toolName} finished in ${toolElapsed}s`, {
            tool: toolName,
            toolCallId: toolCall.id,
            success: result.success,
            output: result.success
              ? truncateOutput(result.output || "Done.")
              : truncateOutput(result.error || "Unknown error."),
            command: args.command || args.cmd || args.script || toolName,
            args: args,
          });
          if (result.success) {
            console.log(`[AgentRunner]       output: ${(result.output || "Done.").slice(0, 200)}`);
          } else {
            console.log(
              `[AgentRunner]       error: ${(result.error || "Unknown error.").slice(0, 200)}`,
            );
          }

          // Persist the tool result IMMEDIATELY after the assistant's tool_call — BEFORE any
          // nudge/hint user-messages below. A user message between a tool_call and its result
          // makes the result an "orphaned tool message" that the sanitizer drops.
          const resultContent = result.success
            ? truncateOutput(result.output || "Done.")
            : truncateOutput(result.error || "Unknown error.");
          const toolRow: DbMessage = {
            role: "tool",
            content: JSON.stringify({ success: result.success, data: resultContent }),
            toolCallId: toolCall.id,
            toolName,
          };
          await messageService.createMessage({ workspaceId, ...toolRow });
          dbMessages.push(toolRow);

          // S2/S3: streak + failed-replace bookkeeping (after the result row is persisted).
          if (toolName === "edit_file") {
            if (result.success) {
              readOnlyStreak = 0;
              if (args.path) failedReplaceByPath.delete(String(args.path));
            } else if (args.path) {
              const p = String(args.path);
              const n = (failedReplaceByPath.get(p) ?? 0) + 1;
              failedReplaceByPath.set(p, n);
              // After repeated failed edits on the same file, hand the agent the full current
              // content so it can copy an exact find string instead of guessing.
              if (n === 2) {
                try {
                  const sb = await getSandbox();
                  const full = await sb.files.read(p);
                  if (typeof full === "string" && full.trim()) {
                    const PER = 16000;
                    const body =
                      full.length > PER ? `${full.slice(0, PER)}\n… [truncated]` : full;
                    console.log(
                      `[AgentRunner] 🩹 ${n} failed edits on ${p} — injecting full file content`,
                    );
                    const inject: DbMessage = {
                      role: "user",
                      content: `SYSTEM: Your edit_file calls on ${p} keep failing because the find string does not match the file. Below is the COMPLETE current content of ${p}. Copy the exact text — including whitespace and punctuation such as "&" — for your find string, then call edit_file once.\n\n\`\`\`\n${body}\n\`\`\``,
                    };
                    await messageService.createMessage({ workspaceId, ...inject });
                    dbMessages.push(inject);
                  }
                } catch {
                  // file unreadable — skip
                }
              }
            }
          }

          if (result.success && toolName === "edit_file") {
            if (args.path) modifiedFiles.add(args.path);
            if (args.file) modifiedFiles.add(args.file);
            if (args.filename) modifiedFiles.add(args.filename);

            // Auto-stop: plan.md written successfully — inject immediate FINAL ANSWER nudge
            if (planMode && args.path === "/workspace/plan.md" && !planFileWritten) {
              planFileWritten = true;
              console.log(`[AgentRunner] 📋 PLAN MODE: plan.md written — nudging for FINAL ANSWER`);
              const stopNudge: DbMessage = {
                role: "user",
                content: `SYSTEM: plan.md has been written successfully. Your work is done. Output FINAL ANSWER now. Do NOT read more files, do NOT explore further, do NOT call any more tools. Output FINAL ANSWER immediately.`,
              };
              await messageService.createMessage({ workspaceId, ...stopNudge });
              dbMessages.push(stopNudge);
            }
          }

          // Track dev server port AFTER successful execution (not before)
          if (
            result.success &&
            toolName === "execute_shell" &&
            args.command &&
            isDevServerCommand(args.command)
          ) {
            const successPort = parseIntendedDevServerPort(args.command);
            if (successPort) {
              startedServerPorts.add(successPort);
              console.log(
                `[AgentRunner]   ✅ Dev server started successfully on port ${successPort} — tracking`,
              );
            }
          }

          // Track consecutive shell infrastructure failures
          // Only count actual infra failures (success: false = sandbox connection issues)
          // Normal non-zero exit codes now come back as success: true with exit_code in output
          if (toolName === "execute_shell" && !result.success) {
            shellFailCount++;
            console.log(
              `[AgentRunner]   ⚠️ Shell infra failure #${shellFailCount}/${SHELL_FAIL_LIMIT}`,
            );
            // Error-triggered pretti-memory retrieval: surface known fix before LLM retries
            if (
              isPrettiMemoryEnabled() &&
              result.error &&
              result.error.length > 20
            ) {
              const errorCacheKey = `${result.error.slice(0, 100)}:${framework}`;
              let hint: string | null;

              if (errorHintCache.has(errorCacheKey)) {
                hint = errorHintCache.get(errorCacheKey) ?? null;
                prettiMemoryMetrics.errorHintCacheHits++;
                console.log("[AgentRunner] pretti-memory error hint cache hit.");
              } else if (userId) {
                prettiMemoryMetrics.errorHintCalls++;
                hint = await fetchErrorFixHint(
                  workspaceId,
                  userId,
                  result.error,
                  framework || "Next.js",
                ).catch(() => null);
                errorHintCache.set(errorCacheKey, hint);
                if (hint) {
                  console.log("[AgentRunner] pretti-memory error hint fetched and cached.");
                } else {
                  console.log("[AgentRunner] No error hint found for this error.");
                }
              } else {
                hint = null;
              }

              if (hint) {
                dbMessages.push({
                  role: "user",
                  content: `<pretti_memory_error_hint>\n${hint}\n</pretti_memory_error_hint>`,
                });
                console.log("[AgentRunner] pretti-memory error hint injected.");
              }
            }
          } else if (toolName === "execute_shell" && result.success) {
            shellFailCount = 0;
          }

          // ── GUARDRAIL: Intercept ENV_REQUIRED and bubble it up ──
          if (toolName === "request_env_vars") {
            console.log(`[AgentRunner]   ⚠️ Requesting ENV_VARS: ${args.keys?.join(", ")}`);
            emit("ENV_REQUIRED", `Requested environment variables: ${args.keys?.join(", ")}`, {
              keys: args.keys || [],
              reason: args.reason || "Required to continue.",
            });
            // We append a system nudge so the agent doesn't loop aggressively immediately
            const envNudge: DbMessage = {
              role: "user",
              content: `[System] The frontend has been notified to prompt the user for: ${args.keys?.join(", ")}. Wait for the user to provide them. You should output FINAL ANSWER specifying the ports you have running, or just wait for the user.`,
            };
            await messageService.createMessage({ workspaceId, ...envNudge });
            dbMessages.push(envNudge);
          }

          // ── AUTO-SYNC: After env_manager set_vars, ensure sandbox .env is current ──
          if (toolName === "env_manager" && args.action === "set_vars" && result.success) {
            // sandboxId is already injected — trigger a sync if it wasn't done inline
            // (env_manager auto-syncs when sandboxId is present, this is a safety net log)
            console.log(
              `[AgentRunner]   🔄 env_manager set_vars completed — DB env updated and synced to sandbox.`,
            );
            emit("AGENT_EVENT", "Env vars updated and synced to sandbox.", {
              eventType: "ENV_SYNCED",
              keys: args.vars ? Object.keys(args.vars) : [],
            });
          }
        }

        // ── GUARDRAIL: Suggest simpler build after repeated sandbox connection failures ──
        if (shellFailCount >= SHELL_FAIL_LIMIT) {
          console.log(
            `[AgentRunner]   🚨 ${SHELL_FAIL_LIMIT} consecutive sandbox failures — suggesting simpler build`,
          );
          emit("STRATEGY_CHANGE", "Sandbox connectivity issues, suggesting simpler approach...");
          const fallbackMsg: DbMessage = {
            role: "user",
            content: `WARNING: The sandbox has had ${shellFailCount} consecutive connection errors. The sandbox may be down. Try reconnecting with a simple command like \`echo ok\`. If that works, continue normally. If the sandbox is truly unreachable, simplify your build approach — use fewer dependencies, skip complex build steps, and focus on getting a working app.`,
          };
          await messageService.createMessage({ workspaceId, ...fallbackMsg });
          dbMessages.push(fallbackMsg);
          shellFailCount = 0;
        }

        console.log(`[AgentRunner]   All tool calls done. Continuing to next iteration...`);
        continue;
      }

      const text = assistantMsg.content || "";

      if (text.includes("FINAL ANSWER")) {
        // In plan mode, skip port verification and todo DB updates — no servers or DB records
        if (planMode) {
          console.log(
            `[AgentRunner] 📋 PLAN MODE: FINAL ANSWER accepted (no port verification needed)`,
          );
          completedOrders.add(wave[0].order);
          break;
        }

        // Determine which task is completing
        const parsedOrder = parseTaskOrderFromFinalAnswer(text);
        const remaining = wave.filter((t) => !completedOrders.has(t.order));
        const taskOrder =
          parsedOrder ??
          // Fallback 1: single-task wave — no TASK= needed
          (wave.length === 1 ? wave[0].order : null) ??
          // Fallback 2: multi-task wave, only one task remains — infer it
          (remaining.length === 1 ? remaining[0].order : null);

        if (taskOrder === null) {
          // Multi-task wave, multiple remaining tasks, no TASK= — nudge once then infer lowest
          const nudge: DbMessage = {
            role: "user",
            content: `Include TASK=<order> in your FINAL ANSWER to indicate which task is complete. Remaining: ${remaining.map((t) => `[TASK ${t.order}] ${t.title}`).join(", ")}`,
          };
          await messageService.createMessage({ workspaceId, ...nudge });
          dbMessages.push(nudge);
          continue;
        }

        const completingTodo = wave.find((t) => t.order === taskOrder);
        if (!completingTodo || completedOrders.has(taskOrder)) {
          // Already done or invalid order — ignore and continue
          continue;
        }

        const summary = text.split("FINAL ANSWER")[1]?.trim() || "Task completed.";
        const ports = parsePortsFromFinalAnswer(text);

        let allPortsValid = true;
        const portsToVerify = Object.entries(ports) as [keyof DetectedPorts, number][];

        for (const [type, p] of portsToVerify) {
          try {
            console.log(`[AgentRunner] Verifying ${type} port ${p} is actually open in sandbox...`);
            const sandbox = await getSandbox();
            const check = await sandbox.commands.run(
              `ss -tlpn | grep -E "0\\.0\\.0\\.0:${p}|\\*:${p}|\\[::\\]:${p}|:::${p}|0\\.0\\.0\\.0.*:${p}"`,
            );
            if (check.exitCode !== 0) {
              const anyCheck = await sandbox.commands.run(`ss -tlpn | grep ":${p} "`);
              if (anyCheck.exitCode !== 0) {
                throw new Error(
                  `Port ${p} has no service listening at all. The server likely failed to start.`,
                );
              }
              console.warn(
                `[AgentRunner] ⚠️  Port ${p} is listening but NOT on 0.0.0.0. E2B proxy may still work if IPv6 wildcard.`,
              );
            }
            console.log(`[AgentRunner] ✅ ${type} port ${p} verified open!`);
          } catch (e: any) {
            allPortsValid = false;
            console.log(
              `[AgentRunner] 🚨 ${type} port ${p} is NOT open. Rejecting FINAL ANSWER. (Reason: ${e.message})`,
            );
            const errMsg: DbMessage = {
              role: "user",
              content: `You output ${type} port ${p} in FINAL ANSWER TASK=${taskOrder}, but there is NO service listening on port ${p} in the sandbox. Fix the issue and verify it's active. Do NOT output FINAL ANSWER until the server is actually running.`,
            };
            await messageService.createMessage({ workspaceId, ...errMsg });
            dbMessages.push(errMsg);
            break;
          }
        }

        if (!allPortsValid) {
          console.log(`[AgentRunner] Continuing loop to force agent to fix the servers.`);
          continue;
        }

        if (ports.frontend) {
          detectedFrontendPort = ports.frontend;
          const feSandbox = await getSandbox();
          const frontendHost = feSandbox.getHost(detectedFrontendPort);
          console.log(
            `[AgentRunner]   🌐 Detected frontend port: ${detectedFrontendPort} → https://${frontendHost}`,
          );
          await workspaceService.updatePort(workspaceId, detectedFrontendPort);
        }
        if (ports.backend) {
          detectedBackendPort = ports.backend;
          const beSandbox = await getSandbox();
          const backendHost = beSandbox.getHost(detectedBackendPort);
          console.log(
            `[AgentRunner]   🌐 Detected backend port: ${detectedBackendPort} → https://${backendHost}`,
          );
          await workspaceService.updateBackendPort(workspaceId, detectedBackendPort);
        }

        console.log(`[AgentRunner] 🎉 FINAL ANSWER TASK=${taskOrder}: "${completingTodo.title}"`);
        emit("TODO_COMPLETED", `Todo "${completingTodo.title}" completed! ${summary}`, {
          todoId: completingTodo.id,
          port: detectedFrontendPort,
          backendPort: detectedBackendPort,
        });

        try {
          await todoService.markComplete(completingTodo.id, summary);
        } catch (err: any) {
          if (!err.message.includes("already completed")) {
            console.error(`[AgentRunner]   markComplete failed:`, err.message);
          }
        }

        if (isPrettiMemoryEnabled()) {
          ingestTodoCompletion({
            workspaceId,
            userId,
            todoId: completingTodo.id,
            todoTitle: completingTodo.title,
            todoDescription: completingTodo.description,
            framework: framework || "Next.js",
            finalSummary: summary,
            modifiedFiles: Array.from(modifiedFiles),
            ports: {
              frontend: detectedFrontendPort ?? undefined,
              backend: detectedBackendPort ?? undefined,
            },
            messages: dbMessages,
          }).catch((e: Error) => console.warn("[AgentRunner] ingestTodoCompletion failed:", e.message));

          ingestWaveCompletion({
            workspaceId,
            userId,
            todoTitle: completingTodo.title,
            framework: framework || "Next.js",
            summary: summary.slice(0, 400),
            filesChanged: Array.from(modifiedFiles),
            waveIndex,
          }).catch((e: Error) => console.warn("[AgentRunner] ingestWaveCompletion failed:", e.message));
        }

        completedOrders.add(taskOrder);

        if (completedOrders.size === wave.length) {
          break; // all wave tasks done — break inner loop
        }
        // else: more tasks remain in this wave — continue
        const stillRemaining = wave.filter((t) => !completedOrders.has(t.order));
        console.log(
          `[AgentRunner] Wave progress: ${completedOrders.size}/${wave.length} done. Remaining: [${stillRemaining.map((t) => t.title).join(", ")}]`,
        );
        continue;
      }

      if (finishReason === "stop") {
        console.log(
          `[AgentRunner]   ⚠️ LLM stopped without tool call or FINAL ANSWER — nudging...`,
        );
        const remaining = wave.filter((t) => !completedOrders.has(t.order));
        const nudge: DbMessage = {
          role: "user",
          content:
            remaining.length > 0
              ? `You stopped without finishing all tasks. Still pending: ${remaining.map((t) => `[TASK ${t.order}] ${t.title}`).join(", ")}. Continue working, or output FINAL ANSWER TASK=<order> for each completed task.`
              : "You stopped without calling a tool or producing FINAL ANSWER. If all tasks are done and verified, output FINAL ANSWER TASK=<order> for each. Otherwise continue working.",
        };
        await messageService.createMessage({ workspaceId, ...nudge });
        dbMessages.push(nudge);
      }
    }

    // Timeout any remaining incomplete tasks in this wave
    if (!planMode) {
      const timedOut = wave.filter((t) => !completedOrders.has(t.order));
      for (const t of timedOut) {
        console.error(
          `[AgentRunner] ❌ Timed out: "${t.title}" (order=${t.order}). Force-completing.`,
        );
        try {
          await todoService.markComplete(t.id, "Timed out — max iterations reached.");
        } catch {
          /* ignore */
        }
      }
    }

    // Plan mode only runs a single pass — exit the outer loop
    if (planMode) break;
  }

  // ── All todos done (or cap reached) ─────────────────────────

  // ── Port fallback: scan the sandbox for what's actually running ─────────────
  // Only needed when the agent never emitted a valid FINAL ANSWER with a port.
  // We ALWAYS scan regardless of framework — never hardcode port assumptions.
  const FALLBACK_SCAN_PORTS = [3000, 5173, 4000, 8080, 4173, 8000];

  if (!detectedFrontendPort && !planMode) {
    console.log(
      `[AgentRunner] Port fallback: scanning sandbox for active port among [${FALLBACK_SCAN_PORTS.join(", ")}]...`,
    );
    try {
      const scanSandbox = await getSandbox();
      const portPattern = FALLBACK_SCAN_PORTS.join("|");

      // One-shot scan for all candidates
      const scanResult = await scanSandbox.commands.run(`ss -tlpn | grep -E ':(${portPattern}) '`);
      const ssOutput = (scanResult.stdout || "").trim();
      const portMatch = ssOutput.match(/:([0-9]+)\s/);

      if (portMatch) {
        const scannedPort = parseInt(portMatch[1], 10);
        detectedFrontendPort = scannedPort;
        await workspaceService.updatePort(workspaceId, scannedPort).catch(() => {});
        console.log(`[AgentRunner] Port fallback: found active port ${scannedPort} in sandbox`);
      } else {
        // Nothing in one-shot — check each candidate individually
        for (const candidate of FALLBACK_SCAN_PORTS) {
          const check = await scanSandbox.commands.run(`ss -tlpn | grep ":${candidate} "`);
          if (check.exitCode === 0 && check.stdout.trim()) {
            detectedFrontendPort = candidate;
            await workspaceService.updatePort(workspaceId, candidate).catch(() => {});
            console.log(`[AgentRunner] Port fallback: individual scan found port ${candidate}`);
            break;
          }
        }
        if (!detectedFrontendPort) {
          console.warn(
            `[AgentRunner] Port fallback: no active port found in sandbox. Preview will not load.`,
          );
        }
      }
    } catch (scanErr: any) {
      console.error(`[AgentRunner] Port fallback scan failed:`, scanErr.message);
    }
  }

  const finalSummary = detectedFrontendPort
    ? `All todos completed. App running on port ${detectedFrontendPort}${detectedBackendPort ? ` (with backend on ${detectedBackendPort})` : ""}.`
    : "All todos completed.";

  console.log(`[AgentRunner] ── Run finished ──────────────────────────`);
  console.log(`[AgentRunner]   ${finalSummary}`);

  // 💾 Persist final answer to history
  await messageService
    .createMessage({ workspaceId, role: "assistant", content: finalSummary })
    .catch((err) => console.error(`[AgentRunner] Failed to persist final summary:`, err.message));

  if (isPrettiMemoryEnabled()) {
    // Log pretti-memory metrics — track optimization effectiveness
    const totalProfileOps = prettiMemoryMetrics.profileCalls + prettiMemoryMetrics.profileCacheHits;
    const totalMidWaveOps = prettiMemoryMetrics.midWaveCalls + prettiMemoryMetrics.midWaveCacheHits;
    const totalErrorOps = prettiMemoryMetrics.errorHintCalls + prettiMemoryMetrics.errorHintCacheHits;
    const totalCalls = prettiMemoryMetrics.profileCalls + prettiMemoryMetrics.midWaveCalls + prettiMemoryMetrics.errorHintCalls;
    const totalOps = totalProfileOps + totalMidWaveOps + totalErrorOps;

    console.log(`[AgentRunner] ── pretti-memory Metrics ──────────────────────────`);
    console.log(`[AgentRunner]   Total API calls: ${totalCalls}`);
    console.log(
      `[AgentRunner]   Profile: ${prettiMemoryMetrics.profileCalls} calls, ${prettiMemoryMetrics.profileCacheHits} cache hits (${totalProfileOps} total ops)`,
    );
    console.log(
      `[AgentRunner]   Mid-wave: ${prettiMemoryMetrics.midWaveCalls} calls, ${prettiMemoryMetrics.midWaveCacheHits} cache hits (${totalMidWaveOps} total ops)`,
    );
    console.log(
      `[AgentRunner]   Error hints: ${prettiMemoryMetrics.errorHintCalls} calls, ${prettiMemoryMetrics.errorHintCacheHits} cache hits (${totalErrorOps} total ops)`,
    );
    console.log(
      `[AgentRunner]   Cache hit rate: ${totalOps > 0 ? Math.round(((prettiMemoryMetrics.profileCacheHits + prettiMemoryMetrics.midWaveCacheHits + prettiMemoryMetrics.errorHintCacheHits) / totalOps) * 100) : 0}%`,
    );

    createRunFactMemories({
      workspaceId,
      userId,
      framework: framework || "Next.js",
      frontendPort: detectedFrontendPort ?? undefined,
      backendPort: detectedBackendPort ?? undefined,
      modifiedFiles: Array.from(modifiedFiles),
    }).catch((e: Error) => console.warn("[AgentRunner] createRunFactMemories failed:", e.message));
  }

  return {
    success: true,
    summary: finalSummary,
    port: detectedFrontendPort ?? undefined,
    backendPort: detectedBackendPort ?? undefined,
    modifiedFiles: Array.from(modifiedFiles),
  };
}
