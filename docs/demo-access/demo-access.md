# Invite-Only Demo Access — High Level Tasks

## 1. Database Setup

- Add `DemoKey` model and `DemoAccessKeyStatus` enum in Prisma schema
- Create one-to-one relation between `User` and `DemoKey`
- Run Prisma migration
- Seed/generate demo access keys for testing

---

## 2. Backend Access Control APIs

### Access Status API

Create endpoint to:

- authenticate logged-in user via Clerk
- fetch user from database
- check whether user already has a claimed demo key
- return access status

### Claim Demo Key API

Create endpoint to:

- authenticate user
- validate submitted demo key
- reject invalid / deleted / already claimed keys
- reject if user already has access
- atomically claim key and link it to user

---

## 3. Frontend Route Protection

Implement route guard for protected pages.

Flow:

- if user not logged in → redirect to `/login`
- if logged in but no demo access → redirect to `/access`
- if logged in and has demo access → allow access to app

Apply this to:

- `/`
- dashboard/app protected routes
- websocket connection auth validation if required

---

## 4. Access Page UI

Create `/access` page with:

- invite/access key input
- submit button
- loading state
- invalid key error state
- success redirect to `/`

---

## 5. WebSocket Access Validation

Since app uses WebSocket:

- validate demo access during socket connection handshake
- reject unauthorized users
- send proper access denied error
- frontend should redirect to `/access` if rejected

---

## 6. Admin Demo Key Management

Create internal tooling for:

- generate single key
- generate bulk keys
- revoke/delete keys
- view claimed/unclaimed status

Optional:

- admin API endpoints
- CLI scripts

---

## 7. Security Hardening

- normalize keys (`trim + uppercase`)
- add rate limiting on claim endpoint
- prevent brute-force access key attempts
- ensure transactional DB updates to avoid race conditions
- prevent reuse of claimed keys

---

## 8. Performance Optimization

Avoid DB lookup on every request.

Future optimization:

- store `demoAccess=true` in redis
- middleware reads session metadata instead of hitting backend each request
