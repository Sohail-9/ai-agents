import { IncomingMessage, Server, ServerResponse } from "http";
import { RawData, WebSocket, WebSocketServer } from "ws";
import {
  AuthEvent,
  BaseMeta,
  ClientToServerEvent,
  SystemErrorEvent,
  TodoCompleteEvent,
  TodoCreateEvent,
  TodoDeleteEvent,
  TodoListEvent,
  TodoUpdateEvent,
  UserRequestEvent,
  ClarificationResponseEvent,
  ConfirmationResponseEvent,
  createEvent,
  ensureMeta,
} from "./protocol";
import { TodoStore } from "./TodoStore";
import { ai } from "../brain/ai";
import { verifyServiceToken } from "../lib/serviceToken";
import { ContextBuilder } from "../context/contextBuilder";
import { SandboxManager } from "../sandbox/sandboxManager";
import { Sandbox } from "@e2b/code-interpreter";
import {
  workspaceService,
  messageService,
  requestService,
  todoService,
  resolveProvider,
  provisionWorkspaceDatabase,
  imageService,
  sandboxLifecycleService,
  agentLockService,
  demoAccessService,
} from "../services";
import { ImageRef } from "../brain/types";
import { runAgent } from "../brain/agentRunner";
import { provisionAndClone } from "../services/importService";
import { getGitHubImportPrompt, validateRequestAgainstWorkspaceStack, buildStackConflictMessage } from "../brain/systemPrompt";
import { scrubTokens } from "../utils/tokenScrubber";
import {
  classifyPlanIntent,
  answerConversationalQuery,
} from "../brain/planIntentClassifier";
import { buildPlanningEnvironmentContext, parseTodosFromContext } from "../brain/planningUtils";
// ─── Queue + relay imports ─────────────────────────────────────────────────
import {
  agentQueue,
  setupQueue,
  importQueue,
} from "../queue/queues";
import { EventRelay } from "../queue/eventRelay";
import { redisConnection } from "../queue/connection";
import { redactSensitive } from "../security/piiGuard";
import { prewarmPool } from "../sandbox/prewarmPool";

// ─── Random name generator ─────────────────────────────────────
const ADJECTIVES = [
  "amber",
  "brave",
  "calm",
  "deft",
  "eager",
  "fair",
  "glad",
  "hale",
  "iron",
  "jade",
  "keen",
  "lush",
  "mild",
  "neat",
  "opal",
  "pure",
  "quick",
  "rare",
  "sage",
  "true",
];
const NOUNS = [
  "arc",
  "bay",
  "core",
  "dawn",
  "edge",
  "flux",
  "grid",
  "haze",
  "isle",
  "jewel",
  "knot",
  "leaf",
  "moon",
  "nova",
  "orb",
  "peak",
  "quill",
  "reef",
  "star",
  "tree",
];

function randomProjectName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

// ─── Socket context ────────────────────────────────────────────

interface SocketContext {
  userId?: string;
  workspaceId?: string;
  projectIdea?: string;
  framework?: string;
  templateId?: string;
  provider?: "OPENAI" | "ANTHROPIC" | "QWEN_DASHSCOPE" | "GROQ" | "GEMINI";
  sessionId: string; // unique per connection, groups messages before workspace exists
  requestId?: string; // current request being processed
  planMode?: boolean; // whether the client has plan mode enabled
  multiAgentEnabled?: boolean; // whether the client has multi-agent mode enabled
  pendingSetup?: {
    idea: string;
    framework: string;
    language: string;
    database: string;
    databaseRequired: boolean;
    planMode?: boolean;
    multiAgent?: boolean;
  };
}

// ─── Manager ───────────────────────────────────────────────────

export class WebSocketManager {
  private readonly connections = new Set<WebSocket>();
  private readonly wss: WebSocketServer;
  private readonly todoStore = new TodoStore();
  private readonly ctxBySocket = new WeakMap<WebSocket, SocketContext>();
  private readonly messageQueueBySocket = new WeakMap<WebSocket, Promise<void>>();
  // ── Queue-based tracking: maps workspaceId → BullMQ jobId string ────────
  private readonly agentRunsByWorkspace = new Map<string, string>();
  // ── Workspace broadcast index: O(1) lookup instead of scanning all connections ──
  private readonly connectionsByWorkspace = new Map<string, Set<WebSocket>>();
  private readonly eventRelay: EventRelay;
  // ── Inline agent runs tracking for immediate abort ────────
  private readonly activeAbortControllers = new Map<string, AbortController>();

  // Per-request cache keyed by image id, lifetime = single USER_REQUEST handler call.
  // Avoids re-downloading the same image from the bucket if both the inline and
  // queued agent paths run in the same handler.
  private async loadImageRefs(
    imageIds?: string[],
    cache?: Map<string, ImageRef>,
  ): Promise<ImageRef[] | undefined> {
    if (!imageIds?.length) return undefined;
    const fetched = await Promise.all(
      imageIds.map(async (id): Promise<ImageRef | null> => {
        const cached = cache?.get(id);
        if (cached) return cached;
        const result = await imageService.getBytes(id);
        if (!result) return null;
        const ref: ImageRef = {
          mimeType: result.mimeType,
          base64Data: result.buffer.toString("base64"),
        };
        cache?.set(id, ref);
        return ref;
      }),
    );
    return fetched.filter((r): r is ImageRef => r !== null);
  }

  constructor(server: Server<typeof IncomingMessage, typeof ServerResponse>) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    this.wss.on("error", (error) => this.handleError(error));

    // Wire up Redis pub/sub relay — workers publish events here
    this.eventRelay = new EventRelay((workspaceId, event) => {
      this.broadcastToWorkspace(workspaceId, event);

      // Auto-clean agentRunsByWorkspace when AGENT_DONE arrives
      const evt = event as any;
      if (evt?.type === "AGENT_DONE") {
        this.agentRunsByWorkspace.delete(workspaceId);
        // Clean up abort key in Redis
        redisConnection.del(`abort:${workspaceId}`).catch(() => {});
      }
    });
    this.eventRelay
      .start()
      .catch((e) =>
        console.error("[WSManager] EventRelay failed to start:", e.message),
      );
  }

  private handleConnection(socket: WebSocket) {
    this.connections.add(socket);

    const sessionId = "ses_" + cryptoRandomId();
    this.ctxBySocket.set(socket, { sessionId });
    this.messageQueueBySocket.set(socket, Promise.resolve());

    console.log(`[WSManager] New connection. sessionId=${sessionId}`);

    socket.send(
      'Connected to AI Agents WebSocket bridge. Send "rules" for the contribution policy.',
    );

    // Save a system message noting the connection
    this.persistMessage(sessionId, "system", "Session started", undefined);

    socket.on("message", (message) => {
      const prev = this.messageQueueBySocket.get(socket) ?? Promise.resolve();
      const next = prev
        .then(() => this.handleMessage(socket, message))
        .catch((err) => {
          console.error("[WSManager] Unhandled message handler error:", err);
        });
      // Keep the queue alive even if a handler fails
      this.messageQueueBySocket.set(socket, next.then(() => undefined));
    });

    socket.on("close", () => {
      const closingCtx = this.ctxBySocket.get(socket);
      if (closingCtx?.workspaceId) {
        const wsSockets = this.connectionsByWorkspace.get(closingCtx.workspaceId);
        if (wsSockets) {
          wsSockets.delete(socket);
          if (wsSockets.size === 0) this.connectionsByWorkspace.delete(closingCtx.workspaceId);
        }
      }
      this.connections.delete(socket);
      this.ctxBySocket.delete(socket);
      this.messageQueueBySocket.delete(socket);
      console.log(
        "WebSocket client disconnected. Remaining:",
        this.connections.size,
      );
    });

    socket.on("error", (error) => {
      this.handleError(error, socket);
    });
  }

  // ─── Prisma helpers (fire-and-forget, never block WS) ──────

  private persistMessage(
    sessionId: string,
    role: "user" | "assistant" | "system",
    content: string,
    requestId?: string,
    workspaceId?: string,
    imageIds?: string[],
  ) {
    const promise = messageService
      .createMessage({ sessionId, role, content, requestId, workspaceId })
      .then(async (msg) => {
        if (imageIds?.length && workspaceId) {
          await imageService.linkToMessage(imageIds, msg.id, workspaceId);
        }
        return msg;
      })
      .catch((err) => console.error("[Prisma] createMessage failed:", err));
    return promise;
  }

  private persistRequest(
    sessionId: string,
    requestId: string,
    userId: string,
    originalMessage: string,
    state:
      | "INIT"
      | "NEEDS_CLARIFICATION"
      | "AWAITING_CONFIRMATION"
      | "CONFIRMED"
      | "RUNNING"
      | "COMPLETED",
  ) {
    requestService
      .createRequest({ sessionId, requestId, userId, originalMessage, state })
      .catch((err) => console.error("[Prisma] createRequest failed:", err));
  }

  private updateRequestState(
    requestId: string,
    state:
      | "INIT"
      | "NEEDS_CLARIFICATION"
      | "AWAITING_CONFIRMATION"
      | "CONFIRMED"
      | "RUNNING"
      | "COMPLETED",
    extra?: {
      answers?: Record<string, unknown>;
      resolvedIntent?: { summary: string; structured: Record<string, unknown> };
    },
  ) {
    requestService
      .updateState({ requestId, state, ...extra })
      .catch((err) =>
        console.error("[Prisma] updateRequestState failed:", err),
      );
  }

  private async fetchAndSendChatHistory(
    socket: WebSocket,
    workspaceId: string,
    cursorDate?: Date,
    limit: number = 50,
    meta?: any,
    isPagination: boolean = false,
  ) {
    const messages = await messageService.getByWorkspace(
      workspaceId,
      cursorDate,
      limit + 1,
      true,
    );

    // We fetch limit + 1 to mathematically detect if more exist beyond the current page
    const hasMore = messages.length > limit;
    const pageMessages = messages.slice(0, limit);

    // CRITICAL: DB returns ORDER BY createdAt DESC (newest first).
    // Reverse IMMEDIATELY to chronological (oldest first) BEFORE processing.
    // This ensures:
    //   1. Assistant rows are processed BEFORE their tool result rows,
    //      so the toolCallCommands map is populated correctly.
    //   2. Expanded sub-items (text → tool_started) maintain correct relative order.
    pageMessages.reverse();

    // Pre-collect tool results keyed by toolCallId so each assistant tool call
    // can be emitted directly as TOOL_COMPLETED in the history, preventing the
    // "Executing" ghost state that would appear if we emitted TOOL_STARTED first.
    const toolResults = new Map<
      string,
      { data: string; toolName: string | null; isShell: boolean }
    >();
    for (const m of pageMessages as any[]) {
      if (m.role !== "tool" || !m.toolCallId) continue;
      let data = m.content ?? "";
      try {
        const parsed =
          typeof m.content === "string" ? JSON.parse(m.content) : m.content;
        data = parsed.data || parsed.output || m.content;
      } catch {
        /* raw string */
      }
      toolResults.set(m.toolCallId, {
        data: String(data).substring(0, 500),
        toolName: m.toolName ?? null,
        isShell: m.toolName === "execute_shell",
      });
    }

    const structuredMsgs: any[] = [];

    for (const m of pageMessages as any[]) {
      if (m.role === "system") continue;
      // Tool result rows are merged into their parent assistant tool-call entries below.
      if (m.role === "tool") continue;

      // ── User messages ──
      if (m.role === "user") {
        if (m.content?.startsWith("[System]")) continue;
        const userMsg: any = {
          id: m.id,
          role: "user",
          content: m.content,
          createdAt: m.createdAt,
        };
        if (m.images?.length) {
          userMsg.images = m.images.map((img: any) => ({
            id: img.id,
            filename: img.filename,
            mimeType: img.mimeType,
            width: img.width,
            height: img.height,
          }));
        }
        structuredMsgs.push(userMsg);
        continue;
      }

      // ── Assistant messages ──
      if (m.role === "assistant") {
        if (m.content) {
          structuredMsgs.push({
            id: `${m.id}-text`,
            role: "agent",
            content: m.content,
            eventType: "AGENT_REASONING",
            thinking: m.content,
            createdAt: m.createdAt,
          });
        }

        if (m.toolCalls) {
          try {
            const calls =
              typeof m.toolCalls === "string"
                ? JSON.parse(m.toolCalls)
                : m.toolCalls;
            if (Array.isArray(calls) && calls.length > 0) {
              for (const tc of calls) {
                try {
                  const fn = tc.function?.name || "unknown_tool";
                  const args = tc.function?.arguments
                    ? typeof tc.function.arguments === "string"
                      ? JSON.parse(tc.function.arguments)
                      : tc.function.arguments
                    : {};
                  const toolCallId = tc.id;
                  const shellCmd = args.command || args.cmd;
                  const result = toolResults.get(toolCallId);

                  structuredMsgs.push({
                    id: `${m.id}-tc-${tc.id}`,
                    role: "agent",
                    // Always resolve to TOOL_COMPLETED in history; only show TOOL_STARTED
                    // if no result exists (e.g. agent was aborted mid-run).
                    content: result
                      ? `Tool ${fn} completed`
                      : `Executing tool: ${fn}`,
                    eventType: result ? "TOOL_COMPLETED" : "TOOL_STARTED",
                    toolCall: fn,
                    toolArgs: args,
                    commandExecution: result
                      ? { command: shellCmd || fn, output: result.data }
                      : fn === "execute_shell" && shellCmd
                        ? { command: shellCmd, output: "..." }
                        : undefined,
                    createdAt: m.createdAt,
                  });
                } catch (tcErr) {
                  console.warn(
                    `[WSManager] Skipping malformed tool call in message ${m.id}:`,
                    tcErr,
                  );
                }
              }
            }
          } catch (parseErr) {
            console.warn(
              `[WSManager] Failed to parse toolCalls for message ${m.id}:`,
              parseErr,
            );
          }
        }
        continue;
      }
    }

    // Fetch AgentLog groups and merge into the timeline by createdAt
    const agentGroups = await messageService
      .getAgentLogGroups(workspaceId, cursorDate)
      .catch(() => []);
    const merged = [...structuredMsgs, ...agentGroups].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    this.sendEvent(
      socket,
      createEvent(
        "CHAT_HISTORY",
        { messages: merged, workspaceId, hasMore, isPagination },
        meta || {},
      ),
    );
  }

  // ─── Message router ────────────────────────────────────────

  private async handleMessage(socket: WebSocket, message: RawData) {
    const raw = this.normalizeMessage(message).trim();
    if (!raw) return; // Ignore empty frames

    const signal = raw.toLowerCase();

    if (signal === "rules") {
      this.sendMessage(
        socket,
        [
          "WS protocol: send JSON events: { type, payload, meta }.",
          'Authenticate (optional for now): { "type":"AUTH","payload":{"userId":"u1","workspaceId":"w1"} }',
          "Todo CRUD: TODO_CREATE, TODO_UPDATE, TODO_COMPLETE, TODO_DELETE, TODO_LIST.",
          'Agent run: { "type":"AGENT_RUN","payload":{"workspaceId":"w1","sandboxId":"s1"},"meta":{"requestId":"req1"} }',
        ].join("\n"),
      );
      return;
    }

    let event: ClientToServerEvent | null = null;
    try {
      event = JSON.parse(raw);
    } catch {
      this.sendEvent(
        socket,
        this.systemError("INVALID_JSON", "Message must be valid JSON.", {
          raw,
        }),
      );
      return;
    }

    if (!event || typeof (event as any).type !== "string") {
      this.sendEvent(
        socket,
        this.systemError("INVALID_EVENT", "Missing event.type.", { event }),
      );
      return;
    }

    const requestId =
      (event as any).meta?.requestId ?? "req_" + cryptoRandomId();
    const meta = ensureMeta((event as any).meta, requestId);
    const ctx = this.ctxBySocket.get(socket) ?? { sessionId: "ses_unknown" };

    switch (event.type) {
      case "AUTH": {
        const auth = event as AuthEvent;

        // Derive userId from the verified service access token — never trust a
        // client-supplied payload.userId. Reject if a token is present but invalid.
        let userId = ctx.userId;
        if (auth.payload?.token) {
          const identity = await verifyServiceToken(auth.payload.token);
          if (!identity) {
            this.sendEvent(
              socket,
              createEvent(
                "SYSTEM_ERROR",
                { code: "AUTH_INVALID_TOKEN", message: "Invalid or expired access token." },
                meta,
              ),
            );
            socket.close(1008, "AUTH_INVALID_TOKEN");
            return;
          }
          userId = identity.userId;
        }

        // Check demo access if user is authenticated
        if (userId) {
          try {
            const accessStatus = await demoAccessService.getAccessStatus(userId);
            if (!accessStatus.hasAccess) {
              this.sendEvent(
                socket,
                createEvent(
                  "SYSTEM_ERROR",
                  {
                    code: "DEMO_ACCESS_DENIED",
                    message: "You do not have demo access. Please claim an access key.",
                  },
                  meta,
                ),
              );
              socket.close(1008, "DEMO_ACCESS_DENIED");
              return;
            }
          } catch (error) {
            console.error("[WSManager] Demo access check failed:", error);
            this.sendEvent(
              socket,
              createEvent(
                "SYSTEM_ERROR",
                {
                  code: "AUTH_CHECK_FAILED",
                  message: "Failed to verify access. Please try again.",
                },
                meta,
              ),
            );
            socket.close(1011, "AUTH_CHECK_FAILED");
            return;
          }
        }

        const nextCtx: SocketContext = {
          ...ctx,
          userId,
          workspaceId: auth.payload?.workspaceId ?? ctx.workspaceId,
          provider: (auth.payload as any)?.provider ?? ctx.provider,
        };
        this.ctxBySocket.set(socket, nextCtx);

        if (nextCtx.workspaceId) {
          // Remove from previous workspace index if the workspaceId changed
          if (ctx.workspaceId && ctx.workspaceId !== nextCtx.workspaceId) {
            const prev = this.connectionsByWorkspace.get(ctx.workspaceId);
            if (prev) {
              prev.delete(socket);
              if (prev.size === 0) this.connectionsByWorkspace.delete(ctx.workspaceId);
            }
          }
          if (!this.connectionsByWorkspace.has(nextCtx.workspaceId)) {
            this.connectionsByWorkspace.set(nextCtx.workspaceId, new Set());
          }
          this.connectionsByWorkspace.get(nextCtx.workspaceId)!.add(socket);
        }

        this.sendEvent(
          socket,
          createEvent(
            "AUTH_OK",
            { userId: nextCtx.userId, workspaceId: nextCtx.workspaceId },
            meta,
          ),
        );

        // 🚀 Fetch current workspace state and send to client
        if (nextCtx.workspaceId) {
          try {
            const workspace = await workspaceService.getWorkspace(
              nextCtx.workspaceId,
            );
            if (workspace) {
              // Restore framework and templateId from workspace config
              const config = workspace.config as any;
              this.ctxBySocket.set(socket, {
                ...nextCtx,
                framework:
                  (workspace as any).framework ||
                  config?.framework ||
                  nextCtx.framework,
                templateId: config?.templateId || nextCtx.templateId,
                projectIdea: config?.idea || nextCtx.projectIdea,
              });

              this.sendEvent(
                socket,
                createEvent(
                  "WORKSPACE_STATE",
                  {
                    workspaceId: nextCtx.workspaceId,
                    sandboxId: workspace.sandboxId,
                    port: workspace.port,
                    backendPort: workspace.backendPort,
                    status: workspace.status,
                  },
                  meta,
                ),
              );

              // Send current todo list
              try {
                const todos = await todoService.listAllTodos(
                  nextCtx.workspaceId,
                );
                this.sendEvent(
                  socket,
                  createEvent(
                    "TODO_LIST_RESULT",
                    {
                      // Only send latest 20 todos to keep payload light
                      todos: todos.slice(-20),
                      workspaceId: nextCtx.workspaceId,
                    },
                    meta,
                  ),
                );
              } catch {
                /* ignore */
              }

              // Send initial chat history with limits
              try {
                await this.fetchAndSendChatHistory(
                  socket,
                  nextCtx.workspaceId,
                  undefined,
                  50,
                  meta,
                );
              } catch (histErr: any) {
                console.error(
                  `[WSManager] Failed to fetch initial chat history: ${histErr.message}`,
                );
                // Always send a response so the frontend doesn't hang
                this.sendEvent(
                  socket,
                  createEvent(
                    "CHAT_HISTORY",
                    {
                      messages: [],
                      workspaceId: nextCtx.workspaceId,
                      hasMore: false,
                      isPagination: false,
                    },
                    meta,
                  ),
                );
              }
            }
          } catch (err: any) {
            console.error(
              `[WSManager] Failed to fetch workspace state: ${err.message}`,
            );
          }
        }
        return;
      }
      case "CHAT_HISTORY_REQUEST": {
        const payload = (event as any).payload ?? {};
        const workspaceId =
          payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) return;

        try {
          await this.fetchAndSendChatHistory(
            socket,
            workspaceId,
            payload.cursor ? new Date(payload.cursor) : undefined,
            payload.limit || 50,
            meta,
            true, // isPagination = true
          );
        } catch (err: any) {
          console.error(
            `[WSManager] Failed to fetch chat history page: ${err.message}`,
          );
          // Always send a response so the frontend doesn't hang
          this.sendEvent(
            socket,
            createEvent(
              "CHAT_HISTORY",
              { messages: [], workspaceId, hasMore: false, isPagination: true },
              meta,
            ),
          );
        }
        return;
      }
      case "PING": {
        this.sendEvent(socket, createEvent("PONG", {}, meta));
        return;
      }
      case "USER_REQUEST": {
        const t0 = Date.now();
        const e = event as UserRequestEvent;
        const userId = meta.userId || ctx.userId || "anonymous";
        const framework = (e.payload as any).framework || ctx.framework;
        const userPlanMode = (e.payload as any).planMode === true;
        const multiAgentEnabled = (e.payload as any).multiAgentEnabled === true;
        const planMode = userPlanMode;
        const workspaceIdFromClient =
          (e.payload as any)?.workspaceId ?? meta.workspaceId;
        const effectiveWorkspaceId = workspaceIdFromClient ?? ctx.workspaceId;

        // Harden against AUTH/USER_REQUEST reordering or concurrent handling:
        // if the client provided a workspaceId in meta/payload, bind it to the socket context.
        if (effectiveWorkspaceId && ctx.workspaceId !== effectiveWorkspaceId) {
          const nextCtx: SocketContext = { ...ctx, workspaceId: effectiveWorkspaceId };
          this.ctxBySocket.set(socket, nextCtx);

          // Maintain the workspace broadcast index.
          if (ctx.workspaceId) {
            const prev = this.connectionsByWorkspace.get(ctx.workspaceId);
            if (prev) {
              prev.delete(socket);
              if (prev.size === 0) this.connectionsByWorkspace.delete(ctx.workspaceId);
            }
          }
          if (!this.connectionsByWorkspace.has(effectiveWorkspaceId)) {
            this.connectionsByWorkspace.set(effectiveWorkspaceId, new Set());
          }
          this.connectionsByWorkspace.get(effectiveWorkspaceId)!.add(socket);
        }

        console.log(
          `[TIMING] USER_REQUEST received at t=${t0} planMode=${planMode} framework=${framework}`,
        );

        // Keep track of the idea, framework, and plan mode
        if (!ctx.projectIdea) {
          const nextCtx: SocketContext = {
            ...ctx,
            projectIdea: e.payload.message,
            requestId,
            framework,
            planMode,
            multiAgentEnabled,
            workspaceId: effectiveWorkspaceId ?? ctx.workspaceId,
          };
          this.ctxBySocket.set(socket, nextCtx);
        } else {
          const updates: Partial<SocketContext> = {
            planMode,
            multiAgentEnabled,
          };
          if (framework && !ctx.framework) updates.framework = framework;
          this.ctxBySocket.set(socket, { ...ctx, ...updates });
        }

        // 💾 Save user message to Prisma (with image linking if present).
        // Cap at 5 — same as the frontend, but enforced here so a malicious or
        // out-of-date client can't push more.
        let imageIds = e.payload.imageIds?.slice(0, 5) || [];
        
        // 🚀 URL Fetching Interceptor
        const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
        const foundUrls = e.payload.message.match(urlRegex) || [];
        if (foundUrls.length > 0 && effectiveWorkspaceId) {
          for (const url of foundUrls) {
            // Heuristic to detect image URLs (unsplash, imgur, or common extensions)
            if (url.match(/\.(png|jpe?g|webp|gif)(\?.*)?$/i) || url.includes("images.unsplash.com") || url.includes("imgur.com")) {
              try {
                console.log(`[WSManager] Fetching external image URL: ${url}`);
                const response = await fetch(url);
                if (response.ok) {
                  const contentType = response.headers.get("content-type");
                  if (contentType && contentType.startsWith("image/")) {
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const fileObj = {
                      buffer,
                      originalname: url.split("/").pop() || "external_image",
                      mimetype: contentType,
                    };
                    const stored = await imageService.processAndStore(effectiveWorkspaceId, fileObj);
                    imageIds.push(stored.id);
                  }
                }
              } catch (err) {
                console.warn(`[WSManager] Failed to fetch external image URL: ${url}`, err);
              }
            }
          }
          // Enforce a hard cap of 10 images total to avoid overwhelming the model
          imageIds = imageIds.slice(0, 10);
        }

        this.persistMessage(
          ctx.sessionId,
          "user",
          e.payload.message,
          requestId,
          effectiveWorkspaceId,
          imageIds.length > 0 ? imageIds : undefined,
        );

        // 💾 Create request record
        this.persistRequest(
          ctx.sessionId,
          requestId,
          userId,
          e.payload.message,
          "INIT",
        );

        const imageRefs = await this.loadImageRefs(imageIds);

        if (effectiveWorkspaceId) {
          // Check if workspace needs initial setup (no sandbox) or is an update
          const workspace = await workspaceService.getWorkspace(
            effectiveWorkspaceId,
          );
          if (workspace && !workspace.sandboxId) {
            const config = workspace.config as any;
            if (config?.source === "github") {
              // ── Enqueue GitHub import setup ─────────────────────────────
              console.log(
                `[WSManager] Enqueueing github-import job for workspace ${effectiveWorkspaceId}`,
              );
              const importJob = await importQueue.add(
                "github-import",
                {
                  workspaceId: effectiveWorkspaceId,
                  userId: ctx.userId,
                  sessionId: ctx.sessionId,
                  userQuery: e.payload.message, // ← USER MESSAGE: capture the user's request
                  meta: { ...meta, workspaceId: effectiveWorkspaceId },
                },
                { jobId: `import-${effectiveWorkspaceId}` },
              );
              console.log(`[WSManager] import job enqueued: ${importJob.id}`);
            } else {
              // ── Enqueue new workspace setup ─────────────────────────────
              const wsConfig = (workspace.config || {}) as any;
              const aiResponse = await ai.processPrompt(
                e.payload.message,
                ctx.userId,
                imageRefs,
              );

              // NOTE: Removed intent clarity blocking from WebSocket handler
              // Vague intents will be clarified inside the sandbox during build, not here
              // This allows faster workspace/sandbox setup
              const databaseRequired =
                aiResponse.contextPayload?.databaseRequired ?? false;
              const setupPayload = {
                workspaceId: effectiveWorkspaceId,
                idea: e.payload.message,
                framework: wsConfig.framework || ctx.framework || "Next.js",
                language: wsConfig.language || "TypeScript",
                database: wsConfig.database || "None",
                databaseRequired,
                planMode: planMode || false,
                multiAgent: multiAgentEnabled,
                userId: ctx.userId,
                sessionId: ctx.sessionId,
                requestId,
                imageIds,
                cachedAiResponse: {
                  contextContent: aiResponse.contextContent,
                  contextPayload: aiResponse.contextPayload as
                    | Record<string, unknown>
                    | undefined,
                },
                meta: { ...meta, workspaceId: effectiveWorkspaceId },
              };

              // NOTE: Removed database confirmation blocking step
              // Database setup (if needed) now happens as part of normal workspace setup
              // No user confirmation prompt - executes immediately for better UX
              // Database flag (databaseRequired) is passed to setup job for handling

              console.log(
                `[WSManager] Enqueueing workspace-setup job for workspace ${effectiveWorkspaceId}`,
              );
              const setupJob = await setupQueue.add(
                "workspace-setup",
                setupPayload,
                { jobId: `setup-${effectiveWorkspaceId}` },
              );
              console.log(`[WSManager] setup job enqueued: ${setupJob.id}`);
            }
            // Initial setup is handled asynchronously by the queue worker.
            // Do not fall through into the legacy "no workspace" AI flow.
            return;
          } else if (workspace?.sandboxId) {
            // ── Sandbox lifecycle: wake if paused, refresh idle TTL otherwise ─
            const tSandboxWake = Date.now();
            try {
              await sandboxLifecycleService.wakeIfNeeded(
                effectiveWorkspaceId,
                workspace.sandboxId,
                {
                  onResuming: () => {
                    this.broadcastToWorkspace(
                      effectiveWorkspaceId,
                      createEvent(
                        "SANDBOX_RESUMING",
                        { sandboxId: workspace.sandboxId },
                        { ...meta, workspaceId: effectiveWorkspaceId },
                      ),
                    );
                  },
                  onReady: () => {
                    this.broadcastToWorkspace(
                      effectiveWorkspaceId,
                      createEvent(
                        "SANDBOX_READY",
                        { sandboxId: workspace.sandboxId },
                        { ...meta, workspaceId: effectiveWorkspaceId },
                      ),
                    );
                  },
                },
              );
              console.log(`[TIMING] Sandbox wake completed in ${Date.now() - tSandboxWake}ms`);
            } catch (wakeErr: any) {
              console.error(
                `[WSManager] Sandbox wake failed for workspace ${effectiveWorkspaceId}:`,
                wakeErr.message,
              );
              this.sendEvent(
                socket,
                this.systemError(
                  "SANDBOX_WAKE_FAILED",
                  wakeErr.message ?? "Failed to resume sandbox",
                  { workspaceId: effectiveWorkspaceId },
                ),
              );
              return;
            }

            const config = workspace.config as any;
            if (config?.source === "github") {
              // Existing github-import workspace — inline update (lightweight: AI + todos)
              await this.handleGitHubImportUpdate(
                socket,
                meta,
                e.payload.message,
                effectiveWorkspaceId,
              );
            } else {
              // Existing workspace — inline update intent (lightweight: AI + todos)
              const tHandleUpdate = Date.now();
              await this.handleUpdateIntent(
                socket,
                meta,
                e.payload.message,
                effectiveWorkspaceId,
                planMode,
                multiAgentEnabled,
              );
              console.log(`[TIMING] handleUpdateIntent completed in ${Date.now() - tHandleUpdate}ms`);
            }
          }
          return;
        }

        const aiResponse = await ai.processPrompt(
          e.payload.message,
          ctx.userId,
          imageRefs,
        );

        if (aiResponse.fullIntent) {
          // Update request → CONFIRMED
          this.updateRequestState(requestId, "CONFIRMED", {
            resolvedIntent: {
              summary: aiResponse.contextPayload?.idea || e.payload.message,
              structured: (aiResponse.contextPayload ?? {}) as Record<
                string,
                unknown
              >,
            },
          });

          // Workspace should already exist in new flow — this is a fallback
          this.sendEvent(
            socket,
            this.systemError(
              "NO_WORKSPACE",
              "No workspace found. Please create a project first.",
              {},
            ),
          );
        } else {
          // Update request → NEEDS_CLARIFICATION
          this.updateRequestState(requestId, "NEEDS_CLARIFICATION");

          const questionsPayload = { questions: aiResponse.questions || [] };

          // 💾 Save assistant clarification as a message
          this.persistMessage(
            ctx.sessionId,
            "assistant",
            JSON.stringify(questionsPayload),
            requestId,
            ctx.workspaceId,
          );

          this.sendEvent(
            socket,
            createEvent("REQUEST_CLARIFICATION", questionsPayload, meta),
          );
        }
        return;
      }
      case "CLARIFICATION_RESPONSE": {
        const e = event as ClarificationResponseEvent;
        const answersStr = Object.entries(e.payload.answers)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");

        // 💾 Save user clarification answers as a message
        this.persistMessage(
          ctx.sessionId,
          "user",
          `Clarifications: ${answersStr}`,
          ctx.requestId,
          ctx.workspaceId,
        );

        // Update request with answers
        if (ctx.requestId) {
          this.updateRequestState(ctx.requestId, "AWAITING_CONFIRMATION", {
            answers: e.payload.answers as Record<string, unknown>,
          });
        }

        const combinedPrompt = `Original request: ${ctx.projectIdea || "Unknown project"}\nUser answered clarifications: ${answersStr}`;
        const aiResponse = await ai.processPrompt(combinedPrompt, ctx.userId);

        if (aiResponse.fullIntent) {
          if (ctx.requestId) {
            this.updateRequestState(ctx.requestId, "CONFIRMED", {
              resolvedIntent: {
                summary:
                  aiResponse.contextPayload?.idea ||
                  ctx.projectIdea ||
                  "New Project",
                structured: (aiResponse.contextPayload ?? {}) as Record<
                  string,
                  unknown
                >,
              },
            });
          }
          this.sendEvent(
            socket,
            this.systemError(
              "NO_WORKSPACE",
              "No workspace found. Please create a project first.",
              {},
            ),
          );
        } else {
          if (ctx.requestId) {
            this.updateRequestState(ctx.requestId, "NEEDS_CLARIFICATION");
          }

          const questionsPayload = { questions: aiResponse.questions || [] };
          this.persistMessage(
            ctx.sessionId,
            "assistant",
            JSON.stringify(questionsPayload),
            ctx.requestId,
            ctx.workspaceId,
          );

          this.sendEvent(
            socket,
            createEvent("REQUEST_CLARIFICATION", questionsPayload, meta),
          );
        }
        return;
      }
      case "CONFIRMATION_RESPONSE": {
        try {
          const e = event as ConfirmationResponseEvent;
          const currentCtx = this.ctxBySocket.get(socket);
          const pendingSetup = currentCtx?.pendingSetup;

          if (!pendingSetup) {
            this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));
            return;
          }

          const workspaceId = currentCtx?.workspaceId || meta.workspaceId;
          if (!workspaceId) {
            throw new Error("Missing workspaceId for setup confirmation.");
          }

          const workspace = await workspaceService.getWorkspace(workspaceId);
          if (!workspace) {
            throw new Error("Workspace not found.");
          }

          let databaseName: string | undefined;
          let databaseUrl: string | undefined;
          const setupDatabase = e.payload.confirmed ? "Neon" : "None";

          if (e.payload.confirmed) {
            this.sendEvent(
              socket,
              createEvent(
                "SETUP_PROGRESS",
                {
                  message: "Creating your Neon database...",
                  submessage: "This can take a few seconds.",
                },
                meta,
              ),
            );

            const provisioned = await provisionWorkspaceDatabase({
              workspaceId,
              workspaceName: workspace.name,
              userId: currentCtx?.userId || workspace.userId,
            });
            databaseName = provisioned.databaseName;
            databaseUrl = provisioned.databaseUrl;

            await workspaceService.updateConfig(workspaceId, {
              databaseRequired: true,
              databaseName,
            });
          } else {
            await workspaceService.updateConfig(workspaceId, {
              databaseRequired: false,
            });
          }

          if (currentCtx?.requestId) {
            this.updateRequestState(currentCtx.requestId, "CONFIRMED", {
              resolvedIntent: {
                summary: currentCtx.projectIdea || pendingSetup.idea,
                structured: {
                  idea: pendingSetup.idea,
                  framework: pendingSetup.framework,
                  language: pendingSetup.language,
                  databaseRequired: pendingSetup.databaseRequired,
                } as Record<string, unknown>,
              },
            });
          }

          if (currentCtx) {
            this.ctxBySocket.set(socket, {
              ...currentCtx,
              pendingSetup: undefined,
            });
          }

          this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));

          const setupJob = await setupQueue.add(
            "workspace-setup",
            {
              workspaceId,
              idea: pendingSetup.idea,
              framework: pendingSetup.framework,
              language: pendingSetup.language,
              database: setupDatabase,
              databaseName,
              databaseUrl,
              databaseRequired: e.payload.confirmed,
              planMode: pendingSetup.planMode ?? false,
              multiAgent: pendingSetup.multiAgent ?? false,
              userId: currentCtx?.userId,
              sessionId: currentCtx?.sessionId || "ses_unknown",
              requestId: currentCtx?.requestId,
              meta: { ...meta, workspaceId },
            },
            { jobId: `setup-${workspaceId}` },
          );
          console.log(
            `[WSManager] setup job enqueued after confirmation: ${setupJob.id}`,
          );
        } catch (err) {
          const safeMsg =
            err instanceof Error
              ? err.message
              : "Failed to handle database confirmation";
          console.error("[WSManager] Confirmation handling failed:", safeMsg);
          this.sendEvent(
            socket,
            this.systemError("DB_PROVISION_FAILED", safeMsg, {}),
          );
        }
        return;
      }
      case "AGENT_RUN": {
        const payload = (event as any).payload ?? {};
        const resolvedWorkspaceId =
          payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        const resolvedSandboxId = payload.sandboxId;
        const resolvedTodoId = payload.todoId ?? "";
        const resolvedMultiAgent = payload.multiAgent === true;

        if (!resolvedWorkspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required to run agent.",
              event,
            ),
          );
          return;
        }
        if (!resolvedSandboxId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_SANDBOX",
              "sandboxId is required to run agent.",
              event,
            ),
          );
          return;
        }

        if (this.agentRunsByWorkspace.has(resolvedWorkspaceId)) {
          this.sendEvent(
            socket,
            this.systemError(
              "AGENT_ALREADY_RUNNING",
              "An agent run is already in progress for this workspace.",
              { workspaceId: resolvedWorkspaceId },
            ),
          );
          return;
        }

        // ── Acquire distributed lock (replaces colliding `agent-${wsId}` jobId) ──
        const ownerKey = agentLockService.generateJobId(resolvedWorkspaceId);
        const lockRes = await agentLockService.acquire(resolvedWorkspaceId, ownerKey);
        if (!lockRes.acquired) {
          this.sendEvent(
            socket,
            this.systemError(
              "AGENT_ALREADY_RUNNING",
              "An agent run is already in progress for this workspace.",
              { workspaceId: resolvedWorkspaceId, currentOwner: lockRes.currentOwner },
            ),
          );
          return;
        }

        // ── Enqueue instead of running inline ────────────────────────────
        const resolvedProvider = await resolveProvider({
          userId: ctx.userId,
          workspaceId: resolvedWorkspaceId,
          preferredProvider: ctx.provider,
        });

        let job;
        try {
          job = await agentQueue.add(
            "agent-run",
            {
              workspaceId: resolvedWorkspaceId,
              sandboxId: resolvedSandboxId,
              todoId: resolvedTodoId,
              userId: ctx.userId,
              provider: resolvedProvider,
              framework: ctx.framework,
              templateId: ctx.templateId,
              projectIdea: ctx.projectIdea,
              commitMessage: ctx.projectIdea || "Agent run",
              multiAgent: resolvedMultiAgent,
              meta: { ...meta, workspaceId: resolvedWorkspaceId },
            },
            { jobId: ownerKey },
          );
        } catch (err) {
          await agentLockService.release(resolvedWorkspaceId, ownerKey).catch(() => {});
          throw err;
        }
        this.agentRunsByWorkspace.set(
          resolvedWorkspaceId,
          job.id ?? resolvedWorkspaceId,
        );
        console.log(
          `[WSManager] Enqueued agent-run job ${job.id} for workspace ${resolvedWorkspaceId}`,
        );
        return;
      }
      case "STOP_AGENT": {
        const stopPayload = (event as any).payload ?? {};
        const stopMeta = (event as any).meta ?? {};
        const stopWorkspaceId =
          stopPayload.workspaceId ?? stopMeta.workspaceId ?? ctx.workspaceId;
        console.log(
          `[WSManager] STOP_AGENT received. workspaceId=${stopWorkspaceId}`,
        );
        if (stopWorkspaceId) {
          // Optimistic immediate feedback before any possible yielding,
          // to ensure this arrives BEFORE an AGENT_DONE triggered by the abort
          this.broadcastToWorkspace(
            stopWorkspaceId,
            createEvent(
              "AGENT_EVENT",
              {
                eventType: "AGENT_STOPPING",
                message: "Stop signal sent to agent…",
              },
              { ...meta, workspaceId: stopWorkspaceId },
            ),
          );

          // ── Inline abort: trigger AbortController directly ──────────────
          const inlineCtrl = this.activeAbortControllers.get(stopWorkspaceId);
          if (inlineCtrl) {
            inlineCtrl.abort();
            console.log(
              `[WSManager] 🛑 Inline abort signal sent for workspace: ${stopWorkspaceId}`,
            );
          }

          // ── Distributed abort: set Redis key, worker polls it ───────────
          await redisConnection.set(`abort:${stopWorkspaceId}`, "1", "EX", 300);
          console.log(
            `[WSManager] ✅ Abort signal written to Redis for workspace: ${stopWorkspaceId}`,
          );
        } else {
          console.log(
            `[WSManager] ⚠️ STOP_AGENT received with no workspaceId.`,
          );
        }
        return;
      }
      case "PLAN_ANSWERS": {
        const answersPayload = (event as any).payload?.answers ?? {};
        const displayText = (event as any).payload?.displayText as
          | string
          | undefined;
        const planWorkspaceId = meta.workspaceId ?? ctx.workspaceId;
        if (planWorkspaceId) {
          const answersKey = `plan-answers:${planWorkspaceId}`;
          await redisConnection.set(
            answersKey,
            JSON.stringify(answersPayload),
            "EX",
            600,
          );
          console.log(
            `[WSManager] Plan answers stored for workspace ${planWorkspaceId}`,
          );

          // Persist Q&A as a user message so it survives reloads
          if (displayText) {
            const currentCtx = this.ctxBySocket.get(socket);
            this.persistMessage(
              currentCtx?.sessionId ?? "ses_unknown",
              "user",
              displayText,
              meta.requestId,
              planWorkspaceId,
            );
          }
        }
        return;
      }
      case "TODO_CREATE": {
        const e = event as TodoCreateEvent;
        const workspaceId =
          e.payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required.",
              e,
            ),
          );
          return;
        }
        if (!e.payload?.title?.trim()) {
          this.sendEvent(
            socket,
            this.systemError("INVALID_TODO", "title is required.", e),
          );
          return;
        }
        const todo = this.todoStore.create({
          workspaceId,
          title: e.payload.title.trim(),
          description: e.payload.description,
          priority: e.payload.priority,
          dueAt: e.payload.dueAt,
          userId: meta.userId ?? ctx.userId,
        });
        this.broadcastToWorkspace(
          workspaceId,
          createEvent("TODO_CREATED", { todo }, { ...meta, workspaceId }),
        );
        return;
      }
      case "TODO_UPDATE": {
        const e = event as TodoUpdateEvent;
        const workspaceId =
          e.payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required.",
              e,
            ),
          );
          return;
        }
        const updated = this.todoStore.update({
          workspaceId,
          id: e.payload.id,
          patch: {
            title: e.payload.title,
            description: e.payload.description,
            priority: e.payload.priority,
            dueAt: e.payload.dueAt,
          },
          userId: meta.userId ?? ctx.userId,
        });
        if (!updated) {
          this.sendEvent(
            socket,
            this.systemError("NOT_FOUND", "Todo not found.", e),
          );
          return;
        }
        this.broadcastToWorkspace(
          workspaceId,
          createEvent(
            "TODO_UPDATED",
            { todo: updated },
            { ...meta, workspaceId },
          ),
        );
        return;
      }
      case "TODO_COMPLETE": {
        const e = event as TodoCompleteEvent;
        const workspaceId =
          e.payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required.",
              e,
            ),
          );
          return;
        }
        const updated = this.todoStore.setCompleted({
          workspaceId,
          id: e.payload.id,
          completed: e.payload.completed,
          userId: meta.userId ?? ctx.userId,
        });
        if (!updated) {
          this.sendEvent(
            socket,
            this.systemError("NOT_FOUND", "Todo not found.", e),
          );
          return;
        }
        this.broadcastToWorkspace(
          workspaceId,
          createEvent(
            "TODO_UPDATED",
            { todo: updated },
            { ...meta, workspaceId },
          ),
        );
        return;
      }
      case "TODO_DELETE": {
        const e = event as TodoDeleteEvent;
        const workspaceId =
          e.payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required.",
              e,
            ),
          );
          return;
        }
        const ok = this.todoStore.delete({ workspaceId, id: e.payload.id });
        if (!ok) {
          this.sendEvent(
            socket,
            this.systemError("NOT_FOUND", "Todo not found.", e),
          );
          return;
        }
        this.broadcastToWorkspace(
          workspaceId,
          createEvent(
            "TODO_DELETED",
            { id: e.payload.id, workspaceId },
            { ...meta, workspaceId },
          ),
        );
        return;
      }
      case "TODO_LIST": {
        const e = event as TodoListEvent;
        const workspaceId =
          e.payload.workspaceId ?? meta.workspaceId ?? ctx.workspaceId;
        if (!workspaceId) {
          this.sendEvent(
            socket,
            this.systemError(
              "MISSING_WORKSPACE",
              "workspaceId is required.",
              e,
            ),
          );
          return;
        }
        const todos = this.todoStore.list({
          workspaceId,
          status: e.payload.status,
        });
        this.sendEvent(
          socket,
          createEvent(
            "TODO_LIST_RESULT",
            {
              // Only send latest 20 todos to keep payload light
              todos: todos.slice(-20),
              workspaceId,
            },
            { ...meta, workspaceId },
          ),
        );
        return;
      }
      case "FILE_TREE_REQUEST": {
        const e = event as any;
        const sandboxId = e.payload.sandboxId;
        const directory = e.payload.directory || "/workspace";
        if (!sandboxId) return;

        try {
          const sandbox = await Sandbox.connect(sandboxId);

          // Use find command to recursively get all files and directories, excluding node_modules/git
          const findResult = await sandbox.commands.run(
            `find "${directory}" -mindepth 1 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/build/*' -not -path '*/.cache/*' \\( -type f -o -type d \\) | head -1000 2>/dev/null`,
          );

          const paths = findResult.stdout
            .split("\n")
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

          // Build file objects from flat paths
          const files: any[] = [];
          const seen = new Set<string>();

          for (const path of paths) {
            if (seen.has(path)) continue;
            seen.add(path);

            const prefixLen = directory.endsWith("/")
              ? directory.length
              : directory.length + 1;
            const relativePath = path.substring(prefixLen);
            if (!relativePath) continue;

            const isDir = paths.some((p) => p.startsWith(path + "/"));

            files.push({
              path: relativePath,
              type: isDir ? "directory" : "file",
            });
          }

          this.sendEvent(
            socket,
            createEvent("FILE_TREE_RESPONSE", { files, directory }, meta),
          );
        } catch (err: any) {
          console.error("[WSManager] FILE_TREE_REQUEST failed:", err.message);
          this.sendEvent(
            socket,
            this.systemError("FILE_ERROR", "Failed to list files.", {
              message: err.message,
            }),
          );
        }
        return;
      }
      case "FILE_CONTENT_REQUEST": {
        const e = event as any;
        const sandboxId = e.payload.sandboxId;
        const path = e.payload.path;
        if (!sandboxId || !path) return;

        try {
          const sandbox = await Sandbox.connect(sandboxId);
          // If the path is relative, assume it is inside /workspace
          const absPath = path.startsWith("/") ? path : `/workspace/${path}`;
          const content = await sandbox.files.read(absPath);
          this.sendEvent(
            socket,
            createEvent("FILE_CONTENT_RESPONSE", { path, content }, meta),
          );
        } catch (err: any) {
          console.error(
            `[WSManager] FILE_CONTENT_REQUEST failed for ${path}:`,
            err.message,
          );
          this.sendEvent(
            socket,
            createEvent(
              "FILE_CONTENT_RESPONSE",
              { path, error: "Failed to read file", content: "" },
              meta,
            ),
          );
        }
        return;
      }
      default: {
        this.sendEvent(
          socket,
          this.systemError(
            "UNKNOWN_EVENT",
            `Unknown event type: ${(event as any).type}`,
            event,
          ),
        );
        return;
      }
    }
  }

  /**
   * New workspace setup flow (workspace already exists in DB from REST):
   *   1. Run AI analysis on the user's idea
   *   2. Build context (Prettiflow.md)
   *   3. Create e2b sandbox → write Prettiflow.md
   *   4. Update workspace in DB with sandboxId + prettiflowMd
   *   5. Create todos
   *   6. Auto-trigger agent run
   */
  private async handleNewWorkspaceSetup(
    socket: WebSocket,
    meta: BaseMeta,
    idea: string,
    workspaceId: string,
  ) {
    this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));

    const ctx = this.ctxBySocket.get(socket) ?? { sessionId: "ses_unknown" };

    try {
      // Fetch workspace to get framework from config
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      const config = workspace.config as any;
      const framework = config?.framework || ctx.framework || "Next.js";
      const language = config?.language || "TypeScript";
      const database = config?.database || "None";

      if (this.agentRunsByWorkspace.has(workspaceId)) {
        this.sendEvent(
          socket,
          this.systemError(
            "AGENT_ALREADY_RUNNING",
            "Initial setup is already running for this workspace.",
            { workspaceId },
          ),
        );
        return;
      }

      // Mark as running early to prevent concurrent setup calls
      const setupPromise = (async () => {
        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            { message: "Planning project architecture..." },
            meta,
          ),
        );

        const planningEnvContext = buildPlanningEnvironmentContext({
          workspaceId,
          framework,
          mode: "new",
        });
        const aiResponse = await ai.processPrompt(
          `${idea}\n\n${planningEnvContext}`,
          ctx.userId,
        );
        const prettiflowMd =
          aiResponse.contextContent ||
          ContextBuilder.getInstance().build({
            idea,
            framework,
            language,
            database,
          });

        // 2. Create sandbox
        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            {
              message: "Synthesizing project context...",
              submessage: "Optimizing structure for the cloud sandbox",
            },
            meta,
          ),
        );

        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            {
              message: "Provisioning cloud sandbox...",
              submessage: "Connecting to E2B compute node",
            },
            meta,
          ),
        );
        const { sandboxId, templateId: resolvedTemplateId } =
          await SandboxManager.getInstance().openAndInit({
            prettiflowMd,
            framework,
          });

        console.log(
          `[WSManager] Sandbox created for workspace ${workspaceId}: ${sandboxId}`,
        );

        // 3. Update workspace with sandbox info
        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            { message: "Finalizing technical environment..." },
            meta,
          ),
        );
        // run concurrently
        await Promise.all([
          workspaceService.updateSandboxId(workspaceId, sandboxId),
          workspaceService.updatePrettiflow(workspaceId, prettiflowMd),
          workspaceService.linkSessionToWorkspace(ctx.sessionId, workspaceId),
        ]);

        if (ctx.requestId) {
          this.updateRequestState(ctx.requestId, "COMPLETED");
        }

        // Update socket context
        this.ctxBySocket.set(socket, {
          ...ctx,
          framework,
          templateId: resolvedTemplateId,
        });

        // 4. Notify frontend of sandbox
        this.sendEvent(
          socket,
          createEvent(
            "WORKSPACE_STATE",
            { workspaceId, sandboxId, port: null, status: "ACTIVE" },
            meta,
          ),
        );

        // 5. Create todos from context
        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            { message: "Preparing project tasks..." },
            meta,
          ),
        );
        const todos = parseTodosFromContext(prettiflowMd);
        await todoService.createTodosWithDeps(workspaceId, todos, 1);
        console.log(
          `[WSManager] Created ${todos.length} todos for workspace ${workspaceId}`,
        );

        const allTodos = await todoService.listAllTodos(workspaceId);
        this.sendEvent(
          socket,
          createEvent(
            "TODO_LIST_RESULT",
            { todos: allTodos, workspaceId },
            meta,
          ),
        );

        // 6. Enqueue agent run instead of running locally
        this.sendEvent(
          socket,
          createEvent(
            "SETUP_PROGRESS",
            { message: "Summoning agent..." },
            meta,
          ),
        );
        console.log(
          `[WSManager] Enqueueing agent run for workspace ${workspaceId}`,
        );
        const resolvedProvider = await resolveProvider({
          userId: ctx.userId,
          workspaceId,
          preferredProvider: ctx.provider,
        });

        await agentQueue.add("agent-run", {
          workspaceId,
          sandboxId,
          todoId: "",
          userId: ctx.userId,
          provider: resolvedProvider,
          framework,
          templateId: resolvedTemplateId,
          commitMessage: idea,
          meta: { ...meta, workspaceId },
        });
      })();

      this.agentRunsByWorkspace.set(workspaceId, "setup-legacy");

      setupPromise
        .finally(() => {
          this.agentRunsByWorkspace.delete(workspaceId);
          // [Queue] abort cleanup via Redis
        })
        .catch((err) => {
          console.error("[WSManager] Setup promise failed:", err);
        });
    } catch (err) {
      console.error("[WSManager] New workspace setup failed:", err);

      this.persistMessage(
        ctx.sessionId,
        "system",
        `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        ctx.requestId,
      );

      this.sendEvent(
        socket,
        createEvent(
          "WORKSPACE_ERROR",
          { message: err instanceof Error ? err.message : "Unknown error" },
          meta,
        ),
      );
    }
  }

  /**
   * GitHub Import Setup flow:
   *   1. Provision hybrid-import sandbox + clone repo via importService
   *   2. Build import context (TODO plan) via AI
   *   3. Create todos
   *   4. Auto-trigger agent with getGitHubImportPrompt system prompt
   */
  private async handleGitHubImportSetup(
    socket: WebSocket,
    meta: BaseMeta,
    workspaceId: string,
  ) {
    this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));
    const ctx = this.ctxBySocket.get(socket) ?? { sessionId: "ses_unknown" };

    try {
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (!workspace) throw new Error("Workspace not found");
      const config = workspace.config as any;
      const { owner, repo, branch, appPath } = config as {
        owner: string;
        repo: string;
        branch: string;
        appPath?: string;
      };
      const clerkUserId = workspace.userId;

      if (ctx.requestId) this.updateRequestState(ctx.requestId, "RUNNING");

      // 1. Notify frontend we're starting the clone
      this.sendEvent(
        socket,
        createEvent(
          "AGENT_EVENT",
          {
            eventType: "CLONE_STARTED",
            message: `Cloning ${owner}/${repo} (branch: ${branch})…`,
          },
          { ...meta, workspaceId },
        ),
      );

      // 2. Provision sandbox and clone (token never appears in logs — passed as env var)
      const importResult = await provisionAndClone({
        clerkUserId,
        owner,
        repo,
        branch,
      });

      const { sandboxId, clonePath } = importResult;
      console.log(
        `[WSManager] Repo cloned for workspace ${workspaceId}: sandbox=${sandboxId}`,
      );
      // Update sandbox id and link session to workspace concurrently
      await Promise.all([
        // 3. Update workspace with sandbox ID
        workspaceService.updateSandboxId(workspaceId, sandboxId),
        // Link session messages
        workspaceService.linkSessionToWorkspace(ctx.sessionId, workspaceId),
      ]);

      this.sendEvent(
        socket,
        createEvent(
          "AGENT_EVENT",
          {
            eventType: "CLONE_COMPLETE",
            message: `Repository cloned successfully at ${clonePath}`,
          },
          { ...meta, workspaceId },
        ),
      );

      // 4. Create initial TODO for agent: "Get the app running"
      // This ensures agent has concrete work and will actually install deps + start server
      const startupTodo = await todoService.createTodo({
        workspaceId,
        title: "Get the development server running",
        description: `Set up and start the frontend for ${owner}/${repo}. First check the repo layout: if package.json is at the root, run it there; if a frontend/ subdirectory exists, run the frontend from there. Install dependencies and start the dev server bound to 0.0.0.0. Do NOT start any backend services.`,
        order: 1,
      });
      console.log(`[WSManager] Created startup TODO: ${startupTodo.id}`);

      // Notify frontend of the initial TODO
      const allTodos = await todoService.listAllTodos(workspaceId);
      this.sendEvent(
        socket,
        createEvent("TODO_LIST_RESULT", { todos: allTodos, workspaceId }, meta),
      );

      // 5. Notify frontend of sandbox ready
      this.sendEvent(
        socket,
        createEvent(
          "WORKSPACE_STATE",
          {
            workspaceId,
            sandboxId,
            port: null,
            status: "ACTIVE",
          },
          { ...meta, workspaceId },
        ),
      );

      if (ctx.requestId) this.updateRequestState(ctx.requestId, "COMPLETED");
      this.ctxBySocket.set(socket, { ...ctx, framework: "github-import" });

      // 6. Enqueue import agent run
      console.log(
        `[WSManager] Enqueueing import agent for workspace ${workspaceId}`,
      );

      const importSystemPrompt = getGitHubImportPrompt({
        owner,
        repo,
        branch,
        clonePath,
        sandboxId,
      });

      const resolvedProvider = await resolveProvider({
        userId: ctx.userId,
        workspaceId,
      });

      await agentQueue.add("agent-run", {
        workspaceId,
        sandboxId,
        todoId: "",
        userId: ctx.userId,
        provider: resolvedProvider,
        framework: "github-import",
        templateId: "__github_import__",
        overrideSystemPrompt: importSystemPrompt,
        meta: { ...meta, workspaceId },
      });
    } catch (err: any) {
      console.error("[WSManager] GitHub import setup failed:", err);
      const safeMsg = scrubTokens(
        err instanceof Error ? err.message : "Unknown error",
      );

      this.persistMessage(
        ctx.sessionId,
        "system",
        `Import Error: ${safeMsg}`,
        ctx.requestId,
      );
      this.sendEvent(
        socket,
        createEvent("WORKSPACE_ERROR", { message: safeMsg }, meta),
      );
    }
  }

  /**
   * GitHub Import Update flow — user sends a chat message on an existing import workspace.
   * Generates update TODOs and re-runs the agent.
   */
  private async handleGitHubImportUpdate(
    socket: WebSocket,
    meta: BaseMeta,
    message: string,
    workspaceId: string,
  ) {
    this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));
    const ctx = this.ctxBySocket.get(socket) ?? { sessionId: "ses_unknown" };

    if (ctx.requestId) this.updateRequestState(ctx.requestId, "RUNNING");

    try {
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (!workspace) throw new Error("Workspace not found");

      const config = workspace.config as any;
      const { owner, repo, branch } = config;

      // ─── Validate request against workspace stack ──────────
      const validation = validateRequestAgainstWorkspaceStack(message, {
        language: config?.language,
        framework: config?.framework,
      });
      if (!validation.valid) {
        const conflictMsg = buildStackConflictMessage(validation, {
          language: config?.language,
          framework: config?.framework,
        });
        console.log(`[WSManager] ❌ Stack conflict: ${validation.reason}`);
        this.sendEvent(socket, this.systemError("STACK_CONFLICT", conflictMsg, {}));
        if (ctx.requestId) this.updateRequestState(ctx.requestId, "COMPLETED");
        return;
      }

      // 💾 Clear ALL previous todos for a fresh run
      await todoService.deleteAllTodos(workspaceId);

      // Plan update todos via AI (using import update prompt)
      const updateContext = [
        workspace.prettiflowMd || `Repo: ${owner}/${repo}`,
        "",
        buildPlanningEnvironmentContext({
          workspaceId,
          framework: "github-import",
          sandboxId: workspace.sandboxId || undefined,
          clonePath: "/workspace/repo",
          mode: "import-update",
        }),
      ].join("\n");
      const updatePlanToon = await ai.planUpdate(
        message,
        updateContext,
        "github-import",
        ctx.userId,
      );

      const todos = parseTodosFromContext(updatePlanToon);
      if (todos.length === 0) {
        throw new Error(
          "AI could not generate actionable tasks. Try rephrasing your request.",
        );
      }

      const existingTodos = await todoService.listPendingTodos(workspaceId);
      const startOrder =
        existingTodos.length > 0
          ? Math.max(...existingTodos.map((t) => t.order)) + 1
          : 1;

      await todoService.createTodosWithDeps(workspaceId, todos, startOrder);

      const allTodos = await todoService.listAllTodos(workspaceId);
      this.broadcastToWorkspace(
        workspaceId,
        createEvent("TODO_LIST_RESULT", { todos: allTodos, workspaceId }, meta),
      );

      if (ctx.requestId) this.updateRequestState(ctx.requestId, "COMPLETED");

      if (this.agentRunsByWorkspace.has(workspaceId)) {
        this.sendEvent(
          socket,
          this.systemError(
            "AGENT_ALREADY_RUNNING",
            "An agent is already running. Please wait for it to finish.",
            { workspaceId },
          ),
        );
        return;
      }

      // 6. Enqueue import agent run
      console.log(
        `[WSManager] Enqueueing import agent for workspace ${workspaceId}`,
      );

      const importSystemPrompt = getGitHubImportPrompt({
        owner,
        repo,
        branch,
        clonePath: "/workspace/repo",
        sandboxId: workspace.sandboxId || "",
      });

      const resolvedProvider = await resolveProvider({
        userId: ctx.userId,
        workspaceId,
      });

      await agentQueue.add("agent-run", {
        workspaceId,
        sandboxId: workspace.sandboxId || "",
        todoId: "",
        userId: ctx.userId,
        provider: resolvedProvider,
        framework: "github-import",
        templateId: "__github_import__",
        overrideSystemPrompt: importSystemPrompt,
        meta: { ...meta, workspaceId },
      });
    } catch (err) {
      console.error("[WSManager] GitHub import update failed:", err);
      const safeMsg = scrubTokens(
        err instanceof Error ? err.message : "Unknown error",
      );
      this.persistMessage(
        ctx.sessionId,
        "system",
        `Update Error: ${safeMsg}`,
        ctx.requestId,
      );
      this.sendEvent(
        socket,
        createEvent("WORKSPACE_ERROR", { message: safeMsg }, meta),
      );
    }
  }

  /**
   * Update intent flow (for existing workspaces):
   *   1. Fetch current workspace context
   *   2. AI generates TOON update plan
   *   3. Append new TODOs to Prisma
   *   4. Auto-trigger agent run
   */
  private async handleUpdateIntent(
    socket: WebSocket,
    meta: BaseMeta,
    message: string,
    workspaceId: string,
    planMode = false,
    multiAgentEnabled = false,
  ) {
    const tStart = Date.now();
    console.log(`[TIMING] handleUpdateIntent START at t=${tStart}`);
    this.sendEvent(socket, createEvent("REQUEST_ACCEPTED", {}, meta));
    const ctx = this.ctxBySocket.get(socket) ?? { sessionId: "ses_unknown" };

    if (ctx.requestId) {
      this.updateRequestState(ctx.requestId, "RUNNING");
    }

    try {
      // 1. Fetch workspace context first (needed for both plan mode paths)
      const tGetWs = Date.now();
      const workspace = await workspaceService.getWorkspace(workspaceId);
      console.log(`[TIMING] getWorkspace: ${Date.now() - tGetWs}ms`);
      if (!workspace) throw new Error("Workspace not found");

      const wsConfig = workspace.config as any;
      const workspaceFramework =
        wsConfig?.framework || ctx.framework || "Next.js";

      // ─── Validate request against workspace stack ──────────
      const validation = validateRequestAgainstWorkspaceStack(message, {
        language: wsConfig?.language,
        framework: wsConfig?.framework,
      });
      if (!validation.valid) {
        const conflictMsg = buildStackConflictMessage(validation, {
          language: wsConfig?.language,
          framework: wsConfig?.framework,
        });
        console.log(`[WSManager] ❌ Stack conflict: ${validation.reason}`);
        this.sendEvent(socket, this.systemError("STACK_CONFLICT", conflictMsg, {}));
        if (ctx.requestId) this.updateRequestState(ctx.requestId, "COMPLETED");
        return;
      }

      // Get warm sandbox if workspace doesn't have one
      if (!workspace.sandboxId) {
        const tPrewarm = Date.now();
        workspace.sandboxId = await prewarmPool.getSandbox(workspaceFramework);
        await workspaceService.updateSandboxId(workspaceId, workspace.sandboxId);
        console.log(`[TIMING] prewarmPool.getSandbox: ${Date.now() - tPrewarm}ms → ${workspace.sandboxId}`);
      }

      // ── Plan mode: classify intent before doing anything else ─────────────────
      if (planMode) {
        const tClassify = Date.now();
        const intent = await classifyPlanIntent(message);
        console.log(
          `[TIMING] classifyPlanIntent: ${Date.now() - tClassify}ms → intent="${intent}"`,
        );

        if (intent === "conversational") {
          // STATE RETRIEVAL MODE — no agent, no todos, no plan UI
          // Read 1-3 targeted files from the sandbox for accurate context
          const fileContext = await this.retrieveRelevantFileContext(
            message,
            workspace.sandboxId || null,
          );
          const answer = await answerConversationalQuery(
            message,
            workspace.prettiflowMd || "",
            fileContext,
          );

          // Persist Q&A to chat history so it survives page reload
          void Promise.all([
            messageService.createMessage({ workspaceId, role: "user", content: message }),
            messageService.createMessage({ workspaceId, role: "assistant", content: answer }),
          ]).catch((err) => console.error("[WSManager] Failed to persist conversational Q&A:", err.message));

          // Show as a plain chat message — AGENT_DONE adds assistant bubble, no plan panel
          this.sendEvent(
            socket,
            createEvent(
              "AGENT_DONE",
              {
                success: true,
                summary: answer,
                sandboxId: workspace.sandboxId || "",
              } as any,
              meta,
            ),
          );
          if (ctx.requestId)
            this.updateRequestState(ctx.requestId, "COMPLETED");
          return;
        }

        // PLANNING / EXECUTION MODE — clear stale todos and run the planning agent
        await todoService.deleteAllTodos(workspaceId);
        const resolvedProvider = await resolveProvider({
          userId: ctx.userId,
          workspaceId,
          preferredProvider: ctx.provider,
        });
        await agentQueue.add(
          "agent-run",
          {
            workspaceId,
            sandboxId: workspace.sandboxId || "",
            todoId: "",
            userId: ctx.userId,
            provider: resolvedProvider,
            framework: workspaceFramework,
            planMode: true,
            multiAgent: multiAgentEnabled,
            commitMessage: message,
            meta: { ...meta, workspaceId },
          },
          { jobId: `agent-plan-${workspaceId}-${Date.now()}` },
        );
        console.log(
          `[WSManager] Enqueued plan-mode agent run for workspace ${workspaceId}`,
        );
        return;
      }

      // 💾 Clear ALL previous todos for a fresh non-plan run
      await todoService.deleteAllTodos(workspaceId);

      // Guard against concurrent agent runs
      if (this.agentRunsByWorkspace.has(workspaceId)) {
        this.sendEvent(
          socket,
          this.systemError(
            "AGENT_ALREADY_RUNNING",
            "An agent is already running for this workspace. Please wait for it to finish.",
            { workspaceId },
          ),
        );
        return;
      }

      // 🚀 Enqueue immediately — worker will run ai.planUpdate() as first step
      const tResolveProvider = Date.now();
      const resolvedProvider = await resolveProvider({
        userId: ctx.userId,
        workspaceId,
        preferredProvider: ctx.provider,
      });
      console.log(`[TIMING] resolveProvider: ${Date.now() - tResolveProvider}ms`);

      const tQueue = Date.now();
      await agentQueue.add("agent-run", {
        workspaceId,
        sandboxId: workspace.sandboxId || "",
        todoId: "",
        userId: ctx.userId,
        provider: resolvedProvider,
        framework: workspaceFramework,
        planMode: false,
        multiAgent: multiAgentEnabled,
        commitMessage: message,
        needsPlan: true,
        meta: { ...meta, workspaceId },
      });
      console.log(`[TIMING] agentQueue.add: ${Date.now() - tQueue}ms`);
      console.log(`[TIMING] handleUpdateIntent total: ${Date.now() - tStart}ms`);

      // Update request → PLANNING (worker will emit COMPLETED when done)
      if (ctx.requestId) {
        this.updateRequestState(ctx.requestId, "RUNNING");
      }
    } catch (err) {
      console.error("[WSManager] Update planning failed:", err);

      this.persistMessage(
        ctx.sessionId,
        "system",
        `Update Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        ctx.requestId,
      );

      this.sendEvent(
        socket,
        createEvent(
          "WORKSPACE_ERROR",
          {
            message:
              err instanceof Error ? err.message : "Update planning failed",
          },
          meta,
        ),
      );
    }
  }

  sendMessage(socket: WebSocket, payload: string) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload, (error) => {
        if (error) {
          this.handleError(error, socket);
        }
      });
    }
  }

  private sendEvent(socket: WebSocket, event: unknown) {
    this.sendMessage(socket, JSON.stringify(event));
  }

  broadcast(payload: string) {
    this.connections.forEach((socket) => this.sendMessage(socket, payload));
  }

  private broadcastToWorkspace(workspaceId: string, event: unknown) {
    const sockets = this.connectionsByWorkspace.get(workspaceId);
    if (!sockets?.size) return;
    const payload = JSON.stringify(event);
    const sanitized = this.selectiveRedactPayload(payload);
    for (const socket of sockets) {
      this.sendMessage(socket, sanitized);
    }
  }

  private selectiveRedactPayload(payload: string): string {
    try {
      const obj = JSON.parse(payload);

      const redactRecursive = (val: any): any => {
        if (typeof val === "string") return redactSensitive(val);
        if (Array.isArray(val)) return val.map(redactRecursive);
        if (val !== null && typeof val === "object") {
          const redacted: any = {};
          for (const [key, value] of Object.entries(val)) {
            redacted[key] = redactRecursive(value);
          }
          return redacted;
        }
        return val;
      };

      return JSON.stringify(redactRecursive(obj));
    } catch {
      // If JSON parsing fails, redact the whole payload
      return redactSensitive(payload);
    }
  }

  disconnect(socket: WebSocket) {
    if (this.connections.has(socket)) {
      socket.close();
    }
  }

  // closeBridge() is defined below as an async method that also stops the EventRelay

  private handleError(error: Error, socket?: WebSocket) {
    console.error(
      "WebSocket error",
      error,
      socket ? { readyState: socket.readyState } : undefined,
    );
  }

  private systemError(
    code: string,
    message: string,
    details?: unknown,
  ): SystemErrorEvent {
    const meta: BaseMeta = {
      requestId: "server_" + cryptoRandomId(),
      timestamp: Date.now(),
    };
    return createEvent("SYSTEM_ERROR", { code, message, details }, meta);
  }

  /**
   * Lightweight file retrieval for conversational queries.
   * Greps the sandbox for files matching the query's key terms, reads the top 2–3,
   * and returns their content as a single string. Falls back to "" on any error.
   */
  private async retrieveRelevantFileContext(
    query: string,
    sandboxId: string | null,
  ): Promise<string> {
    if (!sandboxId) return "";
    try {
      const { extractQueryKeywords } =
        await import("../brain/planIntentClassifier");
      const keywords = extractQueryKeywords(query);
      if (keywords.length === 0) return "";

      const sandbox = await Sandbox.connect(sandboxId);
      const pattern = keywords.slice(0, 2).join("\\|");

      // Find files that mention the keywords (bounded search, ignore node_modules/dist)
      const findCmd = [
        `grep -rl "${pattern}"`,
        `/workspace/src /workspace/frontend/src /workspace/app`,
        `--include="*.ts" --include="*.tsx" --include="*.css" --include="*.json"`,
        `2>/dev/null | grep -v node_modules | grep -v dist | head -4`,
      ].join(" ");

      const findResult = await sandbox.commands.run(findCmd);
      const filePaths = (findResult.stdout || "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 3);

      if (filePaths.length === 0) return "";

      const snippets: string[] = [];
      for (const fp of filePaths) {
        const readResult = await sandbox.commands.run(
          `head -100 "${fp}" 2>/dev/null`,
        );
        const content = (readResult.stdout || "").trim();
        if (content) snippets.push(`// ${fp}\n${content}`);
      }

      return snippets.join("\n\n");
    } catch (err) {
      console.warn(
        "[WSManager] retrieveRelevantFileContext failed:",
        (err as Error).message,
      );
      return "";
    }
  }


  private normalizeMessage(raw: RawData) {
    if (typeof raw === "string") {
      return raw;
    }

    if (Array.isArray(raw)) {
      return Buffer.concat(raw).toString();
    }

    return Buffer.from(raw as ArrayBufferLike).toString();
  }

  /** Called by index.ts on server shutdown */
  public async closeBridge() {
    await this.eventRelay.stop();
    this.wss.close();
    console.log("[WSManager] Bridge closed.");
  }
}

function cryptoRandomId() {
  // short id for logs/requestIds; cryptographic strength not required.
  return (
    Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  );
}
