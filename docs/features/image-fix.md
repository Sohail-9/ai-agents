# Image Upload & Real-Time Handling — Fix Summary

## Problem
Previously, image upload flow was incomplete with no dedicated API routes or proper WebSocket integration for real-time agent communication involving images. Image handling was scattered across chat and project-level uploads without centralized storage or management.

## Solution

### 1. Image Management API (`/backend/src/routes/images.ts`)
- **POST `/api/workspaces/:workspaceId/images`** — Upload image with multer
  - Memory-based storage (5MB limit)
  - File type validation (PNG, JPEG, GIF, WebP)
  - Error handling for file size, type, and upload failures
  
- **GET `/api/images/:id`** — Serve uploaded images
  - Default: 307 redirect to short-lived Supabase signed URL (5min TTL)
  - Query param `?proxy=1` streams bytes through server (workaround for cross-origin clients)
  - Immutable cache headers for browser caching

### 2. Image Service (`/backend/src/services/imageService.ts`)
- **Validation** — File type & size checks before processing
- **Processing** — Image resizing via Sharp library
  - Anthropic-recommended max dimension: 1568px
  - Prevents oversized images from hitting API limits
- **Storage Abstraction** — Pluggable backend (Supabase by default)
  - Content-hash bucketing: `workspaces/{id}/{hash}.{ext}`
  - Deduplication via content hash
- **Database Tracking** — Records image metadata (dimensions, MIME, size)
- **Signed URL Generation** — Temporary access tokens for CDN redirect

### 3. WebSocket Manager Integration (`/backend/src/ws/WSManager.ts`)
- Real-time image metadata broadcast to connected agents
- Image ID propagation in agent message payloads
- Support for multi-image messages in chat flow
- Event handling for upload completion notifications

## Files Changed

### New Files
- `backend/src/routes/images.ts` — Image upload/serve routes
- `backend/src/services/imageService.ts` — Core image processing & storage
- `backend/src/services/storageService.ts` — Blob storage abstraction (Supabase)

### Modified Files
- `backend/src/ws/WSManager.ts` — Image event handling in WebSocket protocol
- `backend/src/index.ts` — Route registration
- `backend/package.json` — Added `sharp` dependency for image processing

## Key Features

✅ **Content-based deduplication** — Same image uploaded twice = one stored copy  
✅ **Anthropic-optimized sizing** — Auto-resize to prevent API errors  
✅ **CDN-friendly** — Signed URLs + browser caching for reduced bandwidth  
✅ **Real-time sync** — WebSocket broadcasts image metadata to agents  
✅ **Fallback proxy mode** — Works even if client can't follow redirects  
✅ **Workspace isolation** — Images scoped to workspace storage buckets  

## Usage Example

```bash
# Upload image to workspace
curl -F "image=@photo.jpg" \
  POST http://localhost:3000/api/workspaces/{workspaceId}/images

# Response
{
  "id": "img_abc123",
  "filename": "photo.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 245600,
  "width": 1600,
  "height": 1200
}

# Access image (redirects to signed URL)
GET http://localhost:3000/api/images/img_abc123

# Or proxy through server
GET http://localhost:3000/api/images/img_abc123?proxy=1
```

## Config Requirements

**Environment variables** (in `.env`):
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key
```

**Supabase setup**:
- Storage bucket: `images` (public read, authenticated write)
- Policies: Workspace isolation via RLS on image metadata table

## Testing

- File upload validation (size, type)
- Image processing & dimension scaling
- Signed URL generation and cache headers
- WebSocket event propagation
- Storage fallback (proxy mode)

## Performance Notes

- Sharp resize is async, non-blocking
- Signed URLs cached in memory (5min)
- Content hash deduplication reduces storage cost
- Direct browser→CDN flow via 307 redirect saves server bandwidth
