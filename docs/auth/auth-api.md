# Prettiflow Auth — API Reference

Test-ready reference for every auth route. Base URL (dev): `http://localhost:8000`

- All JSON routes accept/return `application/json`.
- Errors always look like: `{ "error": { "message": "...", "status": <code> } }`
- Protected routes need header: `Authorization: Bearer <accessToken>`
- The refresh token is also set as an httpOnly cookie named `pf_session`.
- Access token lives ~15 min. Refresh token / session lives ~30 days.
- `devVerifyLink` / `devOtp` fields only appear when `NODE_ENV != production`.

---

## Auth — mounted at `/api/auth`

### POST /api/auth/signup

Create a user, email an OTP verification magic-link.

Body:
| field | type | required |
|-------|------|----------|
| email | string (email) | yes |
| password | string (min 8) | yes |
| firstName | string (min 1) | no |
| lastName | string (min 1) | no |

`201` response:

```json
{
  "userId": "uuid",
  "message": "Account created. Verify your email",
  "devVerifyLink": "http://localhost:8000/api/auth/verify?token=...  (dev only)"
}
```

Errors: `409` email already registered. `400` bad body.

---

### GET /api/auth/verify?token=...

Magic-link click target. Consumes token, marks email verified, then **redirects** (302) the browser to the app.

Query: `token` (string, from the email link).

Response: `302` redirect to `VERIFY_REDIRECT_URL` with `?verified=1` (ok) or `?verified=0&error=invalid_or_expired_link` (bad/expired). No JSON.

---

### POST /api/auth/signin

Authenticate with email + password, create session, return tokens.

Body:
| field | type | required |
|-------|------|----------|
| email | string (email) | yes |
| password | string (min 1) | yes |

`200` response:

```json
{
  "userId": "uuid",
  "sessionId": "uuid",
  "accessToken": "jwt",
  "refreshToken": "opaque"
}
```

Also sets `pf_session` cookie. Errors: `401` invalid credentials (same message whether email missing or password wrong). `403` email not verified.

---

### POST /api/auth/forgot-password

Issue a 6-digit reset OTP by email. Always `200` (no account enumeration).

Body: `{ "email": "string (email)" }`

`200` response:

```json
{
  "message": "If the account exists, a reset code has been sent.",
  "devOtp": "123456  (dev only, only if account exists)"
}
```

---

### POST /api/auth/reset-password

Verify reset OTP, set new password.

Body:
| field | type | required |
|-------|------|----------|
| email | string (email) | yes |
| code | string (exactly 6 chars) | yes |
| password | string (min 8) | yes |

`200` response: `{ "reset": true }`
Errors: `400` invalid or expired code.

---

### GET /api/auth/google

Start web Google OAuth. **Redirects** (302) to Google consent.

Query: `redirectTo` (optional, must be a same-site path starting with `/`; otherwise ignored). No JSON.

### GET /api/auth/google/callback?code&state

Google redirects here. Resolves user, creates session, sets `pf_session` cookie, then `302` redirects to app. On failure redirects with `?error=oauth_failed`. No JSON. (Not called directly in tests — driven by Google.)

---

## Session + User — also mounted at `/api/auth`

### POST /api/auth/refresh

Rotate refresh token, mint new access token. Takes refresh token from body **or** `pf_session` cookie.

Body (optional): `{ "refreshToken": "string" }`

`200` response:

```json
{
  "sessionId": "uuid",
  "accessToken": "jwt",
  "refreshToken": "opaque"
}
```

Sets new `pf_session` cookie. Errors: `401` missing / invalid / expired / revoked refresh token, or session no longer active.

---

### POST /api/auth/logout

Revoke current session. **Auth required.**

Header: `Authorization: Bearer <accessToken>`. No body.

`200` response: `{ "loggedOut": true }`. Clears cookie. Errors: `401` missing/invalid token.

---

### GET /api/auth/sessions

List this user's active sessions (devices). **Auth required.**

`200` response:

```json
{
  "sessions": [
    {
      "id": "uuid",
      "userAgent": "string|null",
      "ipAddress": "string|null",
      "createdAt": "ISO date",
      "lastActiveAt": "ISO date",
      "expiresAt": "ISO date"
    }
  ]
}
```

---

### DELETE /api/auth/sessions/:id

Revoke a specific session (remote logout). **Auth required.**

Path param: `id` = session id.

`200` response: `{ "revoked": true }`. Errors: `404` session not found / not owned by you.

---

### GET /api/auth/me

Current user profile. **Auth required.**

`200` response:

```json
{
  "user": {
    "id": "uuid",
    "email": "string",
    "emailVerified": true,
    "emailVerifiedAt": "ISO date|null",
    "phone": "string|null",
    "phoneVerified": false,
    "phoneVerifiedAt": null,
    "firstName": "string|null",
    "lastName": "string|null",
    "createdAt": "ISO date",
    "updatedAt": "ISO date"
  }
}
```

(no `passwordHash`.) Errors: `401` no token, `404` user not found.

---

### PATCH /api/auth/me

Update profile. **Auth required.**

Body:
| field | type | required |
|-------|------|----------|
| firstName | string (min 1) | no |
| lastName | string (min 1) | no |

`200` response: `{ "user": { ...same shape as GET /me } }`

---

### DELETE /api/auth/me

Delete the account. **Auth required.**

No body. `200` response: `{ "deleted": true }`. Clears cookie.

---

## CLI Google OAuth — mounted at `/api/oauth`

Browser-based login for CLIs. No localhost callback server. Flow: start → open authUrl in browser → poll status until `completed`.

### POST /api/oauth/google/cli/start

Begin a CLI login. No body.

`201` response:

```json
{
  "loginId": "uuid",
  "authUrl": "http://localhost:8000/api/oauth/google/authorize?state=..."
}
```

Open `authUrl` in a browser, then poll status with `loginId`.

### GET /api/oauth/google/authorize?state=...

Bounces browser to Google consent. `302` redirect. Driven by the browser, not the CLI.

### GET /api/oauth/google/callback?code&state

Google redirects here. Returns an HTML page (`200` success / `400` failure). Driven by Google.

### GET /api/oauth/google/cli/status/:loginId

Poll login status. Tokens returned **exactly once** — first successful poll gets them, then status flips to `consumed`.

Path param: `loginId`.

Responses (`200`):

```json
{ "status": "pending" }
{ "status": "expired" }
{ "status": "consumed" }
{
  "status": "completed",
  "accessToken": "jwt",
  "refreshToken": "opaque",
  "user": { "id": "uuid", "email": "string" }
}
```

Errors: `404` unknown loginId.

---

## Public keys

### GET /.well-known/jwks.json

Public RS256 keys for verifying access-token JWTs. No prefix, no auth.

`200` response: standard JWKS `{ "keys": [ ... ] }`.

---

## Health

### GET /api/health

`200` response: `{ "status": "ok", "uptime": <seconds> }`

---

## Quick test flow (password)

```bash
BASE=http://localhost:8000

# 1. signup (grab devVerifyLink from response in dev)
curl -s $BASE/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"password123"}'

# 2. verify — open the devVerifyLink in a browser (or curl -i it)

# 3. signin — grab accessToken
curl -s $BASE/api/auth/signin -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"password123"}'

# 4. call protected route
curl -s $BASE/api/auth/me -H "Authorization: Bearer <accessToken>"

# 5. refresh
curl -s $BASE/api/auth/refresh -H 'content-type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
```
