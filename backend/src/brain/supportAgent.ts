import OpenAI from 'openai';
import '../env';
import { prisma } from '../lib/prisma';
import { workspaceService } from '../services/workspaceService';
import { supportCaseService } from '../services/supportCaseService';
import { escalationService } from '../services/escalationService';
import { SupportMessageRole } from '../../generated/prisma';

const MAX_TOOL_ROUNDS = 8;

const DOCS_KB: Record<string, string> = {
  sandbox:
    'Sandboxes are E2B cloud environments. If not starting: try regenerating the workspace or contact support. Timeouts usually resolve on retry.',
  billing:
    'Credits are consumed per agent run. View usage in Settings > Credits. Refills are available via the billing page.',
  github:
    'GitHub sync requires connecting your account in Settings > GitHub. Ensure the repo exists and your access token has the correct permissions.',
  deployment:
    'Deployments use Vercel/AWS. Check the Deployments tab for logs. Common fixes: ensure env vars are set, check build output for errors.',
  database:
    'Databases are provisioned per workspace. If failing, try creating a new workspace. Check the database status in the workspace settings.',
  'code generation':
    'If code generation fails, check the request log for error details. Re-prompting with more specifics usually resolves it.',
  credits:
    'Credits are consumed per LLM call. You can view your balance and top up in Settings > Credits.',
};

export type SupportWsEmitter = (event: Record<string, unknown>) => Promise<void> | void;

interface SupportLLMConfig {
  client: OpenAI;
  model: string;
}

function createSupportLLMConfig(): SupportLLMConfig {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
  const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o-mini';

  // 1. Azure OpenAI (primary)
  if (apiKey && endpoint) {
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';
    const isNewStyle = endpoint.endsWith('/openai/v1') || endpoint.endsWith('/v1');
    if (isNewStyle) {
      console.log(`[SupportAgent] Using Azure OpenAI (new-style) model=${deployment}`);
      return { client: new OpenAI({ apiKey, baseURL: endpoint }), model: deployment };
    }
    const baseURL = `${endpoint}/openai/deployments/${deployment}`;
    console.log(`[SupportAgent] Using Azure OpenAI (traditional) model=${deployment}`);
    return {
      client: new OpenAI({
        apiKey,
        baseURL,
        defaultQuery: { 'api-version': apiVersion },
        defaultHeaders: { 'api-key': apiKey },
      }),
      model: deployment,
    };
  }

  // 2. Direct OpenAI fallback
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    console.log('[SupportAgent] Using direct OpenAI model=gpt-4.1-mini');
    return { client: new OpenAI({ apiKey: openaiKey }), model: 'gpt-4.1-mini' };
  }

  // 3. Groq fallback
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    console.log('[SupportAgent] Using Groq fallback');
    return {
      client: new OpenAI({
        apiKey: groqKey,
        baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      }),
      model: 'llama-3.3-70b-versatile',
    };
  }

  throw new Error('[SupportAgent] No LLM API key available. Set AZURE_OPENAI_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY.');
}

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getUserWorkspaces',
      description: "List all workspaces/projects owned by the current user. ALWAYS call this first when the user mentions a workspace or project name — it returns the IDs you must use for getWorkspaceDetails.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWorkspaceDetails',
      description: 'Get detailed info about a specific workspace: config, recent requests, and recent messages. You MUST pass the workspace ID (from getUserWorkspaces), not the workspace name.',
      parameters: {
        type: 'object',
        properties: { workspaceId: { type: 'string', description: 'The workspace ID returned by getUserWorkspaces (a cuid like clxxxxxxxx). Do NOT pass a workspace name here.' } },
        required: ['workspaceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getRequestDetails',
      description: 'Get details of a specific code generation request — status, prompt, result, errors.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string', description: 'The request ID' } },
        required: ['requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSandboxLogs',
      description: 'Fetch recent execution logs from a workspace E2B sandbox.',
      parameters: {
        type: 'object',
        properties: { workspaceId: { type: 'string', description: 'The workspace ID' } },
        required: ['workspaceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchDocs',
      description: 'Search AI Agents documentation by keyword.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolveCase',
      description: 'Mark the support case as RESOLVED. Call when you have fully answered the issue.',
      parameters: {
        type: 'object',
        properties: { resolutionSummary: { type: 'string', description: 'Clear summary of how the issue was resolved' } },
        required: ['resolutionSummary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalateCase',
      description: 'Escalate to human support. Call for platform bugs, billing disputes, or when you cannot resolve after attempts.',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'Your classification of the issue' },
          possibleSolution: { type: 'string', description: 'Your best suggested fix or next step' },
          priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
        },
        required: ['issue', 'possibleSolution', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reopenCase',
      description: 'Reopen a previously resolved case because the solution did not work.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why the case is being reopened' } },
        required: ['reason'],
      },
    },
  },
];

export class SupportAgent {
  private client: OpenAI;
  private model: string;

  constructor() {
    const config = createSupportLLMConfig();
    this.client = config.client;
    this.model = config.model;
  }

  async processMessage(caseId: string, emit: SupportWsEmitter): Promise<void> {
    const supportCase = await prisma.supportCase.findUnique({
      where: { id: caseId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        workspace: { select: { id: true, name: true } },
        user: { select: { clerkId: true, email: true, name: true } },
      },
    });

    if (!supportCase) {
      console.error(`[SupportAgent] Case ${caseId} not found`);
      return;
    }

    const userId = supportCase.userId;
    const userEmail = supportCase.user?.email || '';
    const userName = supportCase.user?.name || userId;
    const workspaceName = supportCase.workspace?.name;

    await emit({ type: 'SUPPORT_AGENT_START', payload: { caseId } });

    const systemPrompt = `You are the AI Agents Support Agent — an AI assistant helping users with their AI Agents projects.
AI Agents is an AI-powered platform that scaffolds and edits full-stack applications inside cloud sandboxes.

CURRENT USER:
- Name: ${userName}
- Email: ${userEmail}
- Workspace: ${workspaceName || 'General / Account question'}
- Case ID: ${caseId}
- Case #: ${supportCase.caseNumber}

TOOL USAGE RULES:
- When user mentions a workspace or project by name, ALWAYS call getUserWorkspaces first to get the list of IDs — then pass the correct ID to getWorkspaceDetails. Never pass a workspace name as the workspaceId.
- Always check the user's actual data before answering — never guess or assume workspace state
- Be concise — this is a live chat, not documentation
- Reference specific workspace names, request IDs, and error messages when available
- After 3 back-and-forth turns without resolution, proactively offer to escalate
- For platform bugs, billing disputes, or account-level issues, escalate immediately
- Never fabricate features — if unsure, say so and escalate
- When you fully resolve the issue, call resolveCase with a clear summary
- When you cannot resolve, call escalateCase with your diagnosis

RESPONSE FORMAT RULES — FOLLOW STRICTLY:
- Write like a support engineer talking to a developer. Conversational, direct, friendly.
- NO emojis anywhere in responses.
- NO markdown headers (never use # ## ###). If you need to organize info, use short paragraphs.
- NO "Would you like help with any of the following?" menus. Ask one focused question if you need clarification.
- Keep responses concise. 2-4 paragraphs is the target. If listing projects, list them inline or as a simple bullet list — never nested bullets.
- For project/workspace names referenced inline, just write the name in plain text. Do not use backtick code formatting for workspace names.
- Status indicators like READY, ERROR, OPEN should be written in plain text (e.g. "deployed and ready" not "READY" in caps).
- If you have data to share (list of projects, deployment status), lead with the data immediately. Don't say "I'll look into that" — just show what you found.
- After answering, either ask one specific follow-up question or call resolveCase if the issue is fully addressed. Never leave the user hanging.`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...supportCase.messages
        .filter((m) => m.role !== SupportMessageRole.SYSTEM)
        .map((m): OpenAI.ChatCompletionMessageParam => ({
          role: m.role === SupportMessageRole.USER ? 'user' : 'assistant',
          content: m.content,
        })),
    ];

    let rounds = 0;
    let finalText = '';

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: TOOLS,
        stream: true,
      });

      let streamText = '';
      let finishReason: string | null = null;
      const toolCallAccumulators: Record<number, { id: string; name: string; args: string }> = {};

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;
        finishReason = choice.finish_reason || finishReason;

        if (delta.content) {
          streamText += delta.content;
          await emit({
            type: 'SUPPORT_AGENT_TOKEN',
            payload: { caseId, token: delta.content },
          });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccumulators[idx]) {
              toolCallAccumulators[idx] = { id: tc.id || '', name: tc.function?.name || '', args: '' };
            }
            if (tc.id) toolCallAccumulators[idx].id = tc.id;
            if (tc.function?.name) toolCallAccumulators[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallAccumulators[idx].args += tc.function.arguments;
          }
        }
      }

      if (streamText) finalText = streamText;

      const toolCalls = Object.values(toolCallAccumulators);

      if (finishReason === 'stop' || toolCalls.length === 0) {
        break;
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: streamText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      // Execute tools
      for (const tc of toolCalls) {
        await emit({
          type: 'SUPPORT_AGENT_TOOL_CALL',
          payload: { caseId, toolName: tc.name, status: 'calling' },
        });

        const MAX_TOOL_RESULT = 12_000;
        let result: string;
        try {
          const args = JSON.parse(tc.args || '{}');
          result = await this.executeTool(tc.name, args, {
            caseId,
            caseNumber: supportCase.caseNumber,
            userId,
            userEmail,
            userName,
            workspaceName,
            messages: supportCase.messages,
            emit,
          });
        } catch (err) {
          result = `Tool error: ${String(err)}`;
        }

        // Cap result size to prevent context overflow
        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + '\n…[result truncated to prevent context overflow]';
        }

        await emit({
          type: 'SUPPORT_AGENT_TOOL_CALL',
          payload: { caseId, toolName: tc.name, status: 'done' },
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    if (finalText) {
      await supportCaseService.addMessage(caseId, SupportMessageRole.AGENT, finalText);
    }

    await emit({ type: 'SUPPORT_AGENT_DONE', payload: { caseId } });
  }

  private async executeTool(
    name: string,
    input: Record<string, string>,
    ctx: {
      caseId: string;
      caseNumber: number;
      userId: string;
      userEmail: string;
      userName: string;
      workspaceName?: string;
      messages: { role: string; content: string }[];
      emit: SupportWsEmitter;
    },
  ): Promise<string> {
    switch (name) {
      case 'getUserWorkspaces': {
        const workspaces = await workspaceService.listByUser(ctx.userId);
        if (!workspaces?.length) return 'User has no workspaces.';
        return JSON.stringify(
          workspaces.map((w: any) => ({
            id: w.id,
            name: w.name,
            status: w.status,
            updatedAt: w.updatedAt,
          })),
        );
      }

      case 'getWorkspaceDetails': {
        let ws = await workspaceService.getWorkspace(input.workspaceId);
        // Fallback: agent may have passed a workspace name instead of ID
        if (!ws) {
          const all = await workspaceService.listByUser(ctx.userId);
          ws = (all as any[]).find(
            (w) => w.name?.toLowerCase() === (input.workspaceId || '').toLowerCase(),
          ) ?? null;
        }
        if (!ws) return 'Workspace not found. Call getUserWorkspaces to get the correct workspace IDs for this user.';
        if ((ws as any).userId !== ctx.userId) return 'Access denied — workspace does not belong to this user.';
        const recent = await prisma.request.findMany({
          where: { workspaceId: (ws as any).id },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, requestId: true, state: true, originalMessage: true, createdAt: true },
        });
        const msgs = await prisma.message.findMany({
          where: { workspaceId: (ws as any).id },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, role: true, content: true, createdAt: true },
        });
        // Truncate heavy fields to prevent context overflow
        const truncate = (s: string, max: number) =>
          s && s.length > max ? s.slice(0, max) + '…[truncated]' : s;
        const safeRequests = recent.map((r: any) => ({
          ...r,
          originalMessage: truncate(r.originalMessage || '', 200),
        }));
        const safeMsgs = msgs.map((m: any) => ({
          ...m,
          content: truncate(m.content || '', 400),
        }));
        // Include only essential workspace fields
        const safeWs = {
          id: (ws as any).id,
          name: (ws as any).name,
          status: (ws as any).status,
          updatedAt: (ws as any).updatedAt,
        };
        return JSON.stringify({ workspace: safeWs, recentRequests: safeRequests, recentMessages: safeMsgs });
      }

      case 'getRequestDetails': {
        const req = await prisma.request.findFirst({
          where: { requestId: input.requestId, userId: ctx.userId },
        });
        if (!req) return 'Request not found or access denied.';
        return JSON.stringify(req);
      }

      case 'getSandboxLogs': {
        return 'Sandbox log retrieval is not yet available via this tool. Advise the user to check the workspace activity tab or contact support.';
      }

      case 'searchDocs': {
        const q = (input.query || '').toLowerCase();
        const matches: string[] = [];
        for (const [key, val] of Object.entries(DOCS_KB)) {
          if (q.includes(key) || key.includes(q)) {
            matches.push(`[${key}]: ${val}`);
          }
        }
        return matches.length
          ? matches.join('\n\n')
          : 'No documentation found for that query. Advise the user to check ai-agents.com/docs or escalate.';
      }

      case 'resolveCase': {
        await supportCaseService.updateStatus(ctx.caseId, 'RESOLVED', {
          resolution: input.resolutionSummary,
        });
        await ctx.emit({
          type: 'SUPPORT_CASE_STATUS',
          payload: { caseId: ctx.caseId, status: 'RESOLVED' },
        });
        return 'Case marked as RESOLVED.';
      }

      case 'escalateCase': {
        await supportCaseService.updateStatus(ctx.caseId, 'ESCALATED', {
          escalationNote: input.issue,
          priority: input.priority,
        });

        const firstUserMsg = ctx.messages.find((m) => m.role === SupportMessageRole.USER);
        const historyText = ctx.messages
          .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');

        try {
          await escalationService.sendEscalationEmail({
            caseId: ctx.caseId,
            caseNumber: ctx.caseNumber,
            userId: ctx.userId,
            userEmail: ctx.userEmail,
            userName: ctx.userName,
            userQuery: firstUserMsg?.content || '',
            chatHistory: historyText,
            messages: ctx.messages.map((m) => ({
              role: m.role as 'USER' | 'AGENT' | 'SYSTEM',
              content: m.content,
            })),
            issue: input.issue,
            possibleSolution: input.possibleSolution,
            workspaceName: ctx.workspaceName,
          });
          await supportCaseService.markEmailSent(ctx.caseId);
        } catch (err) {
          console.error('[SupportAgent] Escalation email failed:', err);
        }

        await ctx.emit({
          type: 'SUPPORT_CASE_STATUS',
          payload: { caseId: ctx.caseId, status: 'ESCALATED' },
        });

        return 'Case escalated to human support. Email notification sent to the team.';
      }

      case 'reopenCase': {
        await supportCaseService.updateStatus(ctx.caseId, 'OPEN');
        await ctx.emit({
          type: 'SUPPORT_CASE_STATUS',
          payload: { caseId: ctx.caseId, status: 'OPEN' },
        });
        return 'Case reopened.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }
}
