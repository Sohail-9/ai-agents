# Workspace Creation Flow Refactor: AI Metadata Generation Before Redirect

## Overview

Refactored the workspace creation flow to ensure AI metadata generation completes **before** the frontend redirects to `/system/:id`. This eliminates title flicker, URL desync, and the need for placeholder names.

## Problem Solved

**Previous behavior:**
- `POST /api/workspaces` returned immediately with `name: "untitled"`
- Frontend redirected to `/system/:id?name=untitled&idea=...&framework=...`
- AI metadata generation ran in background (fire-and-forget)
- Database updated later; frontend never saw it without refresh
- Result: Title flicker, URL query param clutter, potential desync

**New behavior:**
- `POST /api/workspaces` **awaits** metadata generation before responding
- Frontend receives `{ id, name, summary, status: "READY", imageIds }`
- Frontend redirects to clean URL `/system/:id` with no query params
- Database already contains final name/summary
- Result: No flicker, clean URLs, synchronized state

## Files Modified

### Backend

#### 1. `backend/prisma/schema.prisma`
- Added `GENERATING` and `READY` states to `WorkspaceStatus` enum
- States: `GENERATING | READY | ACTIVE | ARCHIVED | FAILED`

**Migration file:** `backend/prisma/migrations/20260521000000_add_workspace_generation_statuses/migration.sql`

#### 2. `backend/src/services/workspaceService.ts`
- Updated `createWorkspace()` to accept optional `status` parameter
- Defaults to `ACTIVE` if not provided (backward compatible)
- Used to set initial status to `GENERATING` during workspace creation

#### 3. `backend/src/routes/workspaces.ts`
- **POST /api/workspaces** (lines 72–182):
  1. Create workspace with `status: "GENERATING"`
  2. Upload images in parallel
  3. **Await** `ai.generateProjectMetadata()` (no longer fire-and-forget)
  4. Update workspace name and summary with generated metadata
  5. Update status to `READY`
  6. Return response: `{ id, name, summary, status: "READY", imageIds }`
  7. On error: set status to `FAILED`, return 500 with `workspaceId` for retry UI

- Response contract:
  ```json
  {
    "id": "cuid...",
    "name": "somecoolapp",
    "summary": "A brief description",
    "status": "READY",
    "imageIds": []
  }
  ```

### Frontend

#### 4. `frontend/src/hooks/use-workspace-manager.ts`
- **initiateWorkspace()** (lines 46–127):
  1. Show loading state immediately
  2. POST to `/api/workspaces` with FormData
  3. **Await** response (don't redirect early)
  4. Check response status:
     - `status: "FAILED"` → show error UI with message
     - `status: "READY"` → extract `id` and redirect
     - Other status → log warning, still redirect (graceful degradation)
  5. Redirect to **clean URL**: `/system/{id}` (no query params)

- Error handling:
  - Catches AI generation failures
  - Shows user-friendly error message
  - Allows retry via same UI

#### 5. `frontend/src/app/system/[id]/page.tsx`
- Removed bootstrap params latching from URL query string
- Removed automatic URL cleanup (`router.replace()`)
- **workspaceName** now only uses `workspace?.name` (from DB fetch)
- **initialIdea** only set from `workspace?.idea` (never from URL params)
- **initialImageIds** always empty array (no longer passed via URL)
- useSystemWebSocket call simplified:
  - Removed `bootstrapParams.framework` fallback
  - Uses `workspace?.framework` directly

### Client (Mobile/Alternative UI)

#### 6. `client/hooks/use-workspace-manager.ts`
- Same changes as frontend hook
- Status checking, clean URL redirect, error handling

#### 7. `client/app/system/[id]/page.tsx`
- Same changes as frontend page
- Removed bootstrap params latching and cleanup

## Backward Compatibility

- **Workspace creation**: Existing code calling `createWorkspace()` still works (status defaults to `ACTIVE`)
- **Workspace detail endpoint**: No changes to response schema
- **Message handling**: Suggestion/clarification modes unaffected
- **Coregit integration**: Still runs as background task (fire-and-forget) after response sent

## Testing

### Test Files Created

1. **`backend/src/routes/__tests__/workspaces.test.ts`**
   - Tests POST /api/workspaces workflow
   - Verifies GENERATING → READY state transition
   - Tests error handling (metadata generation failure)
   - Ensures "untitled" never returned to frontend

2. **`frontend/src/hooks/__tests__/use-workspace-manager.test.tsx`**
   - Tests awaiting metadata generation before redirect
   - Tests FAILED status handling
   - Verifies clean URL redirect (no query params)
   - Tests loading state management

### Manual Testing Checklist

After deployment:
1. Submit workspace creation with valid idea
   - Observe loading state (spinner, "Generating project name...")
   - Wait for response
   - Redirect to `/system/{id}` (observe URL is clean)

2. Network throttle simulation
   - Slow down API to ~3-5 seconds response time
   - Verify loading state persists until response arrives
   - Verify redirect only happens after response

3. Verify no flicker
   - Workspace navbar/title always shows generated name
   - No "untitled" → "real-name" transition

4. Verify URL is clean
   - No query params in `/system/{id}` redirect
   - Refresh page → name loads from DB (not URL)

5. Error scenario
   - Test with network error during metadata generation
   - Verify error message shown
   - Verify workspace marked as FAILED in DB
   - Verify no redirect occurs

## Preserved

- ✓ `resolveUniqueName()` centralization in workspaceService
- ✓ `ai.generateProjectMetadata()` pipeline (Qwen provider, PROJECT_METADATA_PROMPT)
- ✓ Existing error handling in `providerResolver`
- ✓ Workspace model relationships (user, images, config, etc.)
- ✓ All other workspace routes/logic (deployments, history, resume, etc.)
- ✓ Suggestion mode and clarification mode detection
- ✓ Image upload and processing
- ✓ Coregit namespace derivation and repo creation

## Database Migration

Run the migration to add new enum values:
```bash
cd backend
npx prisma migrate deploy
```

Or in dev:
```bash
npx prisma migrate dev
```

The migration adds `GENERATING` and `READY` to the PostgreSQL `WorkspaceStatus` enum safely (non-breaking change).

## Performance Implications

- **Backend**: Metadata generation latency now blocks the POST response (~2-5 seconds typically)
  - **Trade-off**: Frontend never shows stale data; better UX
  - **Mitigation**: Consider caching/batching metadata generation if latency becomes issue

- **Frontend**: Loading state visible for metadata generation duration
  - **UX**: Expected behavior; shows user work is happening
  - **No regression**: Previously happened invisibly; frontend didn't wait

## Rollback Plan

If issues arise:
1. Revert commits to the 7 modified files
2. Revert Prisma schema and migration
3. Reset database if needed: `npx prisma migrate reset`

Old behavior will resume: fire-and-forget metadata generation, query param passing.

## Future Improvements

- Consider adding progress indicators for slow metadata generation (e.g., "Generating... 50%")
- Add retry button for FAILED workspace status
- Cache generated metadata to avoid re-generating on retry
- Consider streaming metadata generation updates to frontend via WebSocket
- Add timeout handling (e.g., if metadata generation takes >30 seconds)
