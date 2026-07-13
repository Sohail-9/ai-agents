# AI Agents CLI — Authentication API Reference

All authentication endpoints the CLI calls against the AI Agents auth service: email/password login, signup, token refresh, profile, sessions, and Google login. Backend/model-credential endpoints are intentionally excluded.

## Base URL & Configuration

| Environment Variable       | Purpose                              | Default                       | Source                                      |
| -------------------------- | ------------------------------------ | ----------------------------- | ------------------------------------------- |
| `AI_AGENTS_AUTH_BASE_URL` | Auth service host                    | `https://auth.ai-agents.com` | `packages/node-sdk/src/account/types.ts:12` |
| `AI_AGENTS_HOME`          | Storage directory for account tokens | `~/.ai-agents`               | (standard Node.js convention)               |

All endpoints below are served from `https://auth.ai-agents.com` (or `AI_AGENTS_AUTH_BASE_URL`).

---

## Account / Identity Endpoints

### Sign-up

**File:** `packages/node-sdk/src/account/client.ts:126-128`

| Field             | Value                                             |
| ----------------- | ------------------------------------------------- |
| Method            | `POST`                                            |
| Path              | `/api/auth/signup`                                |
| **Request Body**  |                                                   |
| `email`           | string (required)                                 |
| `password`        | string (required)                                 |
| `firstName`       | string (optional)                                 |
| `lastName`        | string (optional)                                 |
| **Response**      | 204 No Content (success); error object on failure |
| **Authorization** | None                                              |
| **Timeout**       | 30 seconds                                        |

---

### Sign-in (Email & Password)

**File:** `packages/node-sdk/src/account/client.ts:130-147`

| Field               | Value                             |
| ------------------- | --------------------------------- |
| Method              | `POST`                            |
| Path                | `/api/auth/signin`                |
| **Request Body**    |                                   |
| `email`             | string (required)                 |
| `password`          | string (required)                 |
| **Response Fields** |                                   |
| `userId`            | string                            |
| `sessionId`         | string                            |
| `accessToken`       | string (JWT, short-lived ~15 min) |
| `refreshToken`      | string (long-lived)               |
| **Authorization**   | None                              |
| **Timeout**         | 30 seconds                        |

---

### Refresh Access Token

**File:** `packages/node-sdk/src/account/client.ts:149-161`

| Field               | Value               |
| ------------------- | ------------------- |
| Method              | `POST`              |
| Path                | `/api/auth/refresh` |
| **Request Body**    |                     |
| `refreshToken`      | string (required)   |
| **Response Fields** |                     |
| `accessToken`       | string              |
| `refreshToken`      | string (rotated)    |
| **Authorization**   | None                |
| **Timeout**         | 30 seconds          |

---

### Get Current User Profile

**File:** `packages/node-sdk/src/account/client.ts:223-229`

| Field                                         | Value                             |
| --------------------------------------------- | --------------------------------- |
| Method                                        | `GET`                             |
| Path                                          | `/api/auth/me`                    |
| **Request Body**                              | (none)                            |
| **Response Fields** (nested in `user` object) |                                   |
| `id`                                          | string                            |
| `email`                                       | string                            |
| `emailVerified`                               | boolean                           |
| `emailVerifiedAt`                             | string \| null (ISO 8601)         |
| `phone`                                       | string \| null                    |
| `phoneVerified`                               | boolean                           |
| `phoneVerifiedAt`                             | string \| null (ISO 8601)         |
| `firstName`                                   | string \| null                    |
| `lastName`                                    | string \| null                    |
| `createdAt`                                   | string (ISO 8601)                 |
| `updatedAt`                                   | string (ISO 8601)                 |
| **Authorization**                             | `Bearer <accessToken>` (required) |
| **Timeout**                                   | 30 seconds                        |

---

### Update User Profile

**File:** `packages/node-sdk/src/account/client.ts:231-246`

| Field                                     | Value                             |
| ----------------------------------------- | --------------------------------- |
| Method                                    | `PATCH`                           |
| Path                                      | `/api/auth/me`                    |
| **Request Body**                          | (partial update)                  |
| `firstName`                               | string (optional)                 |
| `lastName`                                | string (optional)                 |
| **Response Fields** (same as Get Profile) | See `/api/auth/me` GET above      |
| **Authorization**                         | `Bearer <accessToken>` (required) |
| **Timeout**                               | 30 seconds                        |

---

### Delete Account

**File:** `packages/node-sdk/src/account/client.ts:248-250`

| Field             | Value                             |
| ----------------- | --------------------------------- |
| Method            | `DELETE`                          |
| Path              | `/api/auth/me`                    |
| **Request Body**  | (none)                            |
| **Response**      | 204 No Content                    |
| **Authorization** | `Bearer <accessToken>` (required) |
| **Timeout**       | 30 seconds                        |

---

### Logout

**File:** `packages/node-sdk/src/account/client.ts:219-221`

| Field             | Value                             |
| ----------------- | --------------------------------- |
| Method            | `POST`                            |
| Path              | `/api/auth/logout`                |
| **Request Body**  | (none)                            |
| **Response**      | 204 No Content                    |
| **Authorization** | `Bearer <accessToken>` (required) |
| **Timeout**       | 30 seconds                        |

---

### Forgot Password

**File:** `packages/node-sdk/src/account/client.ts:163-165`

| Field             | Value                                      |
| ----------------- | ------------------------------------------ |
| Method            | `POST`                                     |
| Path              | `/api/auth/forgot-password`                |
| **Request Body**  |                                            |
| `email`           | string (required)                          |
| **Response**      | 204 No Content (success); error on failure |
| **Authorization** | None                                       |
| **Timeout**       | 30 seconds                                 |

---

### Reset Password

**File:** `packages/node-sdk/src/account/client.ts:167-169`

| Field             | Value                                      |
| ----------------- | ------------------------------------------ |
| Method            | `POST`                                     |
| Path              | `/api/auth/reset-password`                 |
| **Request Body**  |                                            |
| `email`           | string (required)                          |
| `code`            | string (from reset email, required)        |
| `password`        | string (required)                          |
| **Response**      | 204 No Content (success); error on failure |
| **Authorization** | None                                       |
| **Timeout**       | 30 seconds                                 |

---

### List Active Sessions

**File:** `packages/node-sdk/src/account/client.ts:252-259`

| Field                                   | Value                             |
| --------------------------------------- | --------------------------------- |
| Method                                  | `GET`                             |
| Path                                    | `/api/auth/sessions`              |
| **Request Body**                        | (none)                            |
| **Response Fields** (array of sessions) |                                   |
| `[].id`                                 | string                            |
| `[].current`                            | boolean                           |
| `[].createdAt`                          | string (optional, ISO 8601)       |
| `[].lastSeenAt`                         | string (optional, ISO 8601)       |
| `[].userAgent`                          | string (optional)                 |
| `[].ip`                                 | string (optional)                 |
| **Authorization**                       | `Bearer <accessToken>` (required) |
| **Timeout**                             | 30 seconds                        |

---

### Revoke Session

**File:** `packages/node-sdk/src/account/client.ts:261-267`

| Field               | Value                             |
| ------------------- | --------------------------------- |
| Method              | `DELETE`                          |
| Path                | `/api/auth/sessions/{id}`         |
| **Path Parameters** |                                   |
| `id`                | string (session ID, URL-encoded)  |
| **Request Body**    | (none)                            |
| **Response**        | 204 No Content                    |
| **Authorization**   | `Bearer <accessToken>` (required) |
| **Timeout**         | 30 seconds                        |

---

## Google Login Endpoints

### Start Google CLI Login

**File:** `packages/node-sdk/src/account/client.ts:176-183`

| Field               | Value                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Method              | `POST`                                                                                    |
| Path                | `/api/oauth/google/cli/start`                                                             |
| **Request Body**    | (none)                                                                                    |
| **Response Fields** |                                                                                           |
| `loginId`           | string (poll identifier)                                                                  |
| `authUrl`           | string (URL to open in browser)                                                           |
| **Authorization**   | None                                                                                      |
| **Timeout**         | 30 seconds                                                                                |
| **Details**         | Opens user's browser; CLI polls for completion every 2 seconds, times out after 5 minutes |

---

### Poll Google CLI Login Status

**File:** `packages/node-sdk/src/account/client.ts:186-215`

| Field                 | Value                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Method                | `GET`                                                                                                             |
| Path                  | `/api/oauth/google/cli/status/{loginId}`                                                                          |
| **Path Parameters**   |                                                                                                                   |
| `loginId`             | string (from start response, URL-encoded)                                                                         |
| **Request Body**      | (none)                                                                                                            |
| **Response Variants** |                                                                                                                   |
|                       | `{ "status": "pending" }`                                                                                         |
|                       | `{ "status": "expired" }`                                                                                         |
|                       | `{ "status": "completed", "accessToken": "...", "refreshToken": "...", "user": { "id": "...", "email": "..." } }` |
| **Authorization**     | None                                                                                                              |
| **Timeout**           | 30 seconds                                                                                                        |

---

### Legacy Google Redirect Flow

**File:** `packages/node-sdk/src/account/client.ts:172-174`

| Field             | Value                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Method            | Browser redirect (not HTTP call)                                                             |
| Path              | `/api/auth/google?redirectTo={encodedUrl}`                                                   |
| **Details**       | Constructs a redirect URL; user signs in via browser, browser redirects back to `redirectTo` |
| **Authorization** | None                                                                                         |

---

## Error Response Format

All endpoints return errors in a normalized shape:

```json
{
  "error": {
    "message": "Human-readable error message"
  }
}
```

HTTP status codes:

- **200** — Success
- **204** — Success (no content, e.g., logout)
- **400** — Invalid request (missing/malformed field)
- **401** — Unauthorized (invalid/expired token)
- **403** — Forbidden (permission denied)
- **429** — Rate limited (retryable)
- **5xx** — Server error (retryable)

---

## Request Headers

### Common Headers (All Requests)

```
Accept: application/json
Content-Type: application/json (if body present)
```

### Bearer Token (Protected Endpoints)

```
Authorization: Bearer {accessToken}
```

---

## Token Storage

Account tokens are stored locally at `~/.ai-agents/credentials/` (or `$AI_AGENTS_HOME/credentials/`):

| File                           | Contents                                                                     | Permissions                 |
| ------------------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| `ai-agents-account.json`      | `{ "access_token": "...", "refresh_token": "...", "expiresAt": 12345, ... }` | 0600 (user read/write only) |
| `ai-agents-account.meta.json` | `{ "sessionId": "...", "userId": "..." }`                                    | 0600                        |

---

## Session Lifecycle

1. **Sign-in:** `POST /api/auth/signin` → receive `accessToken` (~15 min) + `refreshToken` (long-lived)
2. **Auto-refresh:** Before access token expires, `POST /api/auth/refresh` with the refresh token
3. **Rotation:** Server returns new `accessToken` + new `refreshToken`; old refresh token revoked
4. **Rejection:** If refresh fails with 401/403, user is logged out and must re-sign-in
5. **Logout:** `POST /api/auth/logout` (best-effort), then delete local tokens

---

## Implementation Files

| Component                                   | File                                       | Key Responsibilities                                          |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Account client (sign-in, profile, sessions) | `packages/node-sdk/src/account/client.ts`  | HTTP wrappers for `/api/auth/*` and `/api/oauth/google/cli/*` |
| Account manager (token lifecycle)           | `packages/node-sdk/src/account/manager.ts` | Owns refresh flow, token storage, cross-process lock          |
| Auth facade (public API)                    | `packages/node-sdk/src/auth.ts`            | `AI AgentsAuthFacade` wraps manager for harness              |
