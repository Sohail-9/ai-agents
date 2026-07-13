import WebSocket from "ws";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Support both localhost (development) and E2B proxy URL (sandbox)
const baseUrl = process.env.WS_URL ?? (() => {
  const e2bSandboxId = process.env.E2B_SANDBOX_ID;
  const backendPort = process.env.BACKEND_PORT ?? "8000";
  const domain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
  return e2bSandboxId
    ? `wss://${backendPort}-${e2bSandboxId}.${domain}`
    : `ws://localhost:${backendPort}`;
})();
const url = baseUrl;
const workspaceId = process.env.WS_WORKSPACE_ID ?? "w_smoke";
const userId = process.env.WS_USER_ID ?? "u_smoke";

function send(ws: WebSocket, event: any) {
  ws.send(JSON.stringify(event));
}

function reqId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function main() {
  const ws = new WebSocket(url);
  let lastTodoId: string | null = null;

  ws.on("message", (data) => {
    const text = data.toString();
    try {
      const evt = JSON.parse(text);
      if (evt?.type === "TODO_CREATED" && evt?.payload?.todo?.id) {
        lastTodoId = evt.payload.todo.id;
      }
      console.log("<<", JSON.stringify(evt, null, 2));
    } catch {
      console.log("<<", text);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });

  send(ws, { type: "AUTH", payload: { userId, workspaceId }, meta: { requestId: reqId("auth") } });
  await sleep(100);

  send(ws, {
    type: "TODO_CREATE",
    payload: { title: "ws-smoke todo", priority: "high" },
    meta: { requestId: reqId("create") },
  });
  await sleep(250);

  send(ws, { type: "TODO_LIST", payload: {}, meta: { requestId: reqId("list1") } });
  await sleep(150);

  if (!lastTodoId) {
    throw new Error("Did not observe TODO_CREATED with todo.id; cannot continue smoke flow.");
  }

  send(ws, {
    type: "TODO_UPDATE",
    payload: { id: lastTodoId, title: "ws-smoke todo (updated)" },
    meta: { requestId: reqId("update") },
  });
  await sleep(150);

  send(ws, {
    type: "TODO_COMPLETE",
    payload: { id: lastTodoId, completed: true },
    meta: { requestId: reqId("complete") },
  });
  await sleep(150);

  send(ws, { type: "TODO_DELETE", payload: { id: lastTodoId }, meta: { requestId: reqId("delete") } });
  await sleep(150);

  send(ws, { type: "TODO_LIST", payload: {}, meta: { requestId: reqId("list2") } });
  await sleep(150);

  send(ws, { type: "PING", payload: {}, meta: { requestId: reqId("ping") } });

  await sleep(250);
  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
