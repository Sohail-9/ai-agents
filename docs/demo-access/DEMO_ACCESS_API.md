# Demo Access API Documentation

## Overview

Demo Access is an invite-only feature that allows users to gain temporary or permanent access to PrettiFlow without requiring full account activation. Admins can generate demo access keys, and users can claim them to unlock functionality.

## Base URL

```
/api/demo-access
```

## Authentication

All endpoints require one of the following:

### User Endpoints
- **Header**: `x-clerk-user-id` (required for user endpoints)
- Should contain the authenticated user's Clerk user ID

### Admin Endpoints
- **Header**: `x-admin-token` (required for admin endpoints)
- Should contain the value of `DEMO_ADMIN_TOKEN` environment variable
- Returns `403 Unauthorized` if token is invalid or missing

---

## User Endpoints

### GET `/status`

Check if the current user has demo access.

**Headers:**
```
x-clerk-user-id: <clerk_user_id>
```

**Response (200 OK):**
```json
{
  "hasAccess": true,
  "claimedAt": "2026-05-22T10:30:00Z",
  "expiresAt": "2026-06-22T10:30:00Z"
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "Missing x-clerk-user-id header"
}
```

---

### POST `/claim`

Claim a demo access key to grant access to the user.

**Headers:**
```
x-clerk-user-id: <clerk_user_id>
Content-Type: application/json
```

**Request Body:**
```json
{
  "key": "DEMO_KEY_ABC123DEF456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Demo access granted",
  "demoKey": {
    "id": "uuid",
    "key": "DEMO_KEY_ABC123DEF456",
    "status": "CLAIMED",
    "claimedBy": "user_12345",
    "claimedAt": "2026-05-22T10:30:00Z"
  }
}
```

**Response (400 Bad Request - Invalid Key):**
```json
{
  "error": "Invalid demo access key"
}
```

**Response (400 Bad Request - Key Already Used):**
```json
{
  "error": "This demo access key has already been claimed or revoked"
}
```

**Response (400 Bad Request - User Already Has Access):**
```json
{
  "error": "User already has demo access"
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "Missing x-clerk-user-id header"
}
```

**Response (429 Too Many Requests):**
```json
{
  "error": "Too many claim attempts. Please try again later.",
  "retryAfter": 3600
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to claim demo access"
}
```

#### Rate Limiting

- Default: 10 claims per user per hour
- Configured via environment variables:
  - `DEMO_CLAIM_RATE_LIMIT_PER_USER` (default: 10)
  - `DEMO_CLAIM_RATE_LIMIT_WINDOW_SECONDS` (default: 3600)
- Uses Redis for tracking (fails open if Redis unavailable)

---

## Admin Endpoints

### POST `/admin/generate`

Generate a single demo access key.

**Headers:**
```
x-admin-token: <admin_token>
Content-Type: application/json
```

**Response (200 OK):**
```json
{
  "id": "uuid",
  "key": "DEMO_KEY_ABC123DEF456",
  "status": "UNCLAIMED",
  "createdAt": "2026-05-22T10:30:00Z",
  "claimedBy": null,
  "claimedAt": null
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to generate demo key"
}
```

---

### POST `/admin/generate-bulk`

Generate multiple demo access keys in bulk.

**Headers:**
```
x-admin-token: <admin_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "count": 50
}
```

**Constraints:**
- `count` must be between 1 and 1000

**Response (200 OK):**
```json
{
  "created": 50,
  "message": "Generated 50 demo access keys"
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Invalid count: must be between 1 and 1000"
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to generate demo keys"
}
```

---

### GET `/admin/list`

List all demo keys with optional filtering.

**Headers:**
```
x-admin-token: <admin_token>
```

**Query Parameters:**
- `status` (optional): Filter by key status - `UNCLAIMED`, `CLAIMED`, or `REVOKED`
- `claimed` (optional): Filter by claimed status - `true` or `false`

**Examples:**
```
GET /api/demo-access/admin/list
GET /api/demo-access/admin/list?status=UNCLAIMED
GET /api/demo-access/admin/list?claimed=false
GET /api/demo-access/admin/list?status=CLAIMED&claimed=true
```

**Response (200 OK):**
```json
[
  {
    "id": "uuid-1",
    "key": "DEMO_KEY_ABC123DEF456",
    "status": "CLAIMED",
    "createdAt": "2026-05-20T08:00:00Z",
    "claimedBy": "user_12345",
    "claimedAt": "2026-05-22T10:30:00Z"
  },
  {
    "id": "uuid-2",
    "key": "DEMO_KEY_XYZ789UVW012",
    "status": "UNCLAIMED",
    "createdAt": "2026-05-21T14:15:00Z",
    "claimedBy": null,
    "claimedAt": null
  }
]
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to list demo keys"
}
```

---

### DELETE `/admin/:id`

Delete or revoke a specific demo key.

**Headers:**
```
x-admin-token: <admin_token>
```

**Path Parameters:**
- `id`: The UUID of the demo key to delete

**Response (200 OK):**
```json
{
  "message": "Demo key deleted"
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized"
}
```

**Response (404 Not Found):**
```json
{
  "error": "Demo key not found"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to delete demo key"
}
```

---

### GET `/admin/stats`

Get statistics about demo keys.

**Headers:**
```
x-admin-token: <admin_token>
```

**Response (200 OK):**
```json
{
  "totalKeys": 150,
  "unclaimedKeys": 50,
  "claimedKeys": 95,
  "revokedKeys": 5,
  "claimRate": 0.63,
  "lastKeyGeneratedAt": "2026-05-22T09:45:00Z"
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Failed to get stats"
}
```

---

## Key Status Values

| Status | Description |
|--------|-------------|
| `UNCLAIMED` | Key has been generated but not yet claimed by a user |
| `CLAIMED` | Key has been successfully claimed by a user |
| `REVOKED` | Key has been revoked and is no longer valid |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_ADMIN_TOKEN` | (required) | Secret token for admin endpoint authentication |
| `DEMO_CLAIM_RATE_LIMIT_PER_USER` | 10 | Max demo claims per user |
| `DEMO_CLAIM_RATE_LIMIT_WINDOW_SECONDS` | 3600 | Time window for rate limit (1 hour) |
| `REDIS_URL` | (optional) | Redis connection URL for rate limiting |

---

## Error Handling

### Rate Limiting Behavior
- Rate limits are tracked per user in Redis
- If Redis is unavailable, requests are allowed to proceed (fail-open)
- Returns HTTP 429 with `retryAfter` field indicating seconds until next attempt

### User Creation
- Users claiming a demo key are automatically created in the database if they don't exist
- User record contains basic Clerk integration

### Validation
- Keys must be non-empty strings
- Bulk generation count must be between 1-1000
- Invalid requests return HTTP 400 with descriptive error messages

---

## Example Usage

### Claiming Demo Access (Frontend)

```javascript
async function claimDemoAccess(demoKey) {
  const response = await fetch('/api/demo-access/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-user-id': window.clerk.user.id,
    },
    body: JSON.stringify({ key: demoKey }),
  });

  if (response.status === 429) {
    const data = await response.json();
    console.log(`Please try again in ${data.retryAfter} seconds`);
    return;
  }

  const data = await response.json();
  if (response.ok) {
    console.log('Demo access granted!');
  } else {
    console.error('Error:', data.error);
  }
}
```

### Generating Demo Keys (Admin)

```bash
# Generate single key
curl -X POST http://localhost:3000/api/demo-access/admin/generate \
  -H "x-admin-token: your_admin_token" \
  -H "Content-Type: application/json"

# Generate 100 keys
curl -X POST http://localhost:3000/api/demo-access/admin/generate-bulk \
  -H "x-admin-token: your_admin_token" \
  -H "Content-Type: application/json" \
  -d '{"count": 100}'

# List unclaimed keys
curl http://localhost:3000/api/demo-access/admin/list?status=UNCLAIMED \
  -H "x-admin-token: your_admin_token"

# Get stats
curl http://localhost:3000/api/demo-access/admin/stats \
  -H "x-admin-token: your_admin_token"
```

---

## Database Schema

### DemoAccessKey Table

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `key` | String | Unique demo access key (immutable) |
| `status` | Enum | UNCLAIMED, CLAIMED, REVOKED |
| `createdAt` | DateTime | Timestamp when key was generated |
| `claimedBy` | String | Clerk user ID of user who claimed the key |
| `claimedAt` | DateTime | Timestamp when key was claimed |

---

## Related Resources

- [Demo Access Service](../backend/src/services/demoAccessService.ts)
- [Demo Access Routes](../backend/src/routes/demoAccess.ts)
