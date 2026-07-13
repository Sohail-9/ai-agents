# Prettiflow AI Backend

A starter Node.js + TypeScript project scaffolded to host AI workflows for the Prettiflow backend. It currently contains a simple pipeline stub that echoes prompts, making it easy to plug in real model calls later. An Express server and WebSocket bridge are also provided to surface contributor rules and accept lightweight signals.

## Scripts

- `npm run build` — compile the TypeScript sources to `dist/`.
- `npm start` — execute the AI pipeline directly with `ts-node` for quick iteration (this now also starts the HTTP/WebSocket server).

## Structure

- `src/index.ts` — entry point that launches the Express/WebSocket server.
- `src/server.ts` — Express configuration and WebSocket bridge; it serves `GET /rules` by streaming `rules/rules.md`.
- `rules/` — instructions (`instructions.md`) and contribution requirements (`rules.md`) referenced by the Express WS bridge.

## Server behavior

- `GET /` — simple health response pointing to `/rules`.
- `GET /rules` — returns the current contents of `rules/rules.md`, so policy changes stay in sync.
- WebSockets — connect to the HTTP server; `WebSocketManager` now takes the Express HTTP server (`src/websocketManager.ts:1`), creates its own `ws` listener, tracks connections, broadcasts notices, and responds to the `rules` message with the same guidance that `rules/rules.md` provides.

## Database env split

- Host backend:
  - `DATABASE_URL` for the backend's own Prisma connection.
  - `NEON_API_KEY` for org-level Neon provisioning.
  - `NEON_ORG_ID` to select a Neon organization when provisioning databases.
  - `NEON_PROJECT_ID` optional override for a specific Neon project.
  - `NEON_BRANCH_ID` optional override for a specific branch.
  - `NEON_ROLE_NAME` for the role used when building workspace connection URLs. Defaults to `neondb_owner`.
- Sandbox/backend for each workspace:
  - `DATABASE_URL` only.
  - No admin credentials are required inside the sandbox.
