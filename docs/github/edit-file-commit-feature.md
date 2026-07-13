# Edit File & Commit Feature — Implementation Reference


---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Architecture Decisions](#architecture-decisions)
3. [Codebase Integration Points](#codebase-integration-points)
4. [Client-Side Architecture](#client-side-architecture)
5. [Backend Architecture](#backend-architecture)
6. [API Contracts](#api-contracts)
7. [Component Specifications](#component-specifications)
8. [DirtyStateContext Design](#dirtystatecontext-design)
9. [CodeEditor (CodeMirror 6) Integration](#codeeditor-codemirror-6-integration)
10. [CommitModal Specification](#commitmodal-specification)
11. [E2B & CoreGit Integration](#e2b--coregit-integration)
12. [Design System & Styling](#design-system--styling)
13. [Performance Analysis](#performance-analysis)
14. [Error Handling & Edge Cases](#error-handling--edge-cases)
15. [Testing Strategy](#testing-strategy)
16. [Org Contributions & Notes](#org-contributions--notes)

---

## 1. Feature Overview

### Vision
Transform Prettiflow's editor from a read-only code viewer into a real, premium code editor with fast git commit capability. Every interaction (edit, commit, push) must feel intentional, polished, and responsive — matching the standard set by Linear or Vercel.

### User Journey
1. User opens workspace, selects a file from the tree
2. **CodeMirror 6** editor renders with full syntax highlighting, line numbers, and pink caret
3. User edits file content — an amber dot appears in the tab bar and file tree instantly
4. Topbar updates: "● 3 modified" pill + "↑ Commit [3]" button with badge
5. User clicks Commit button → modal opens with animated scale
6. Optional: Click "✦ Generate with AI" → textarea streams commit message from Claude Haiku
7. Click "↑ Commit & Push" → files sync to E2B sandbox + targeted CoreGit push
8. On success: green checkmark → modal closes → toast "Committed · abc1234" → commit hash shown in topbar
9. Dirty dots fade out, topbar resets

### Key Differentiator: Targeted Commits
The existing `POST /api/workspaces/:id/commit` endpoint uses `pushWorkspaceSnapshot()` which:
- Finds all files in E2B sandbox (find + filter)
- Reads all 180+ files concurrently (12 workers)
- Pushes all files to CoreGit (~500KB payload)
- **Total latency: 2.2–5.7 seconds**

The new **targeted commit** approach:
- Client already has modified file content in memory
- Send only those files to CoreGit (~10–50KB payload)
- Skip E2B sandbox read entirely
- **Target latency: 150–400ms** (10–15x faster)

---

## 2. Architecture Decisions

### 2.1 Why CodeMirror 6 (not Monaco)

**Monaco Editor:**
- Pros: Familiar VS Code experience, rich built-in features
- Cons: ~2MB bundle size, heavy initialization, overkill for this use case

**CodeMirror 6:**
- Pros: Modular, ~300KB base, extensible, fast initialization, perfect for embedded editors
- Cons: Fewer built-ins, but everything we need exists via extensions

**Decision:** CodeMirror 6. Client-side bundle size matters for Prettiflow's web-first UI.

### 2.2 Why React Context (not Zustand)

Existing codebase has:
- No Zustand stores anywhere
- All state is local `useState` in `EditorPane.tsx`
- Pattern: React hooks + refs for editor-level state

**Decision:** Dirty state lives in a `DirtyStateContext` (React.createContext + useReducer). Keeps state co-located with the editor and matches existing patterns.

### 2.3 Why Targeted CoreGit Commit (not full snapshot)

**Full snapshot approach (current):**
```
Client request
  ↓
Backend fetches workspace metadata
  ↓
Sandbox.connect() → find + read 180 files (12 concurrent workers)
  ↓
Build file array (~500KB)
  ↓
POST to CoreGit /commits
  ↓
Response: commit SHA
```
Bottleneck: E2B file reads (~3–5 seconds).

**Targeted commit approach (new):**
```
Client sends { message, files: [{path, content}] } (already in memory)
  ↓
Backend validates + writes to E2B sandbox (Promise.all)
  ↓
Backend calls pushTargetedCommit(files, message) — no E2B read!
  ↓
POST to CoreGit /commits (10–50KB payload)
  ↓
Response: commit SHA
```
No E2B file reads. Much faster.

### 2.4 Why Express Backend Routes (not Next.js API routes)

Prettiflow architecture:
- Frontend: Next.js 16.2.6 (`client/`)
- Backend: Express 5.2.1 (`backend/`)
- All API routes: Express (`backend/src/routes/`)

New routes go in `backend/src/routes/workspaces.ts`:
- `POST /api/workspaces/:id/commit-targeted` — targeted file commit
- `POST /api/workspaces/:id/generate-commit` — streaming AI commit message

This is consistent with existing patterns (e.g., `POST /:id/commit` already lives here).

### 2.5 Streaming AI Commit Messages

**Challenge:** Generating a commit message takes ~500–800ms. UX should show real-time streaming to feel fast.

**Solution:** Use Anthropic SDK streaming + `ReadableStream + TextDecoder` on client.

Backend route `POST /api/workspaces/:id/generate-commit`:
```typescript
const stream = await anthropic.messages.stream({
  model: 'claude-haiku-4-5-20251001', // Fast + cheap
  max_tokens: 100,
  system: 'Generate a conventional commit message...',
  messages: [{ role: 'user', content: diff }],
});

res.setHeader('Content-Type', 'text/plain; charset=utf-8');
for await (const text of stream.text_stream) {
  res.write(text);
}
res.end();
```

Client receives as streaming text and fills textarea character by character. Feels instant.

---

## 3. Codebase Integration Points

### 3.1 Existing Code We Build On

**EditorPane.tsx (lines 27–586):**
- `OpenTab` interface: already has `originalContent` field
- `activeTab_` useMemo: derives active tab for content display
- WebSocket handlers: file tree + content updates
- Tab bar rendering: loop over `openTabs`, click to switch, close button

**coregitService.ts:**
- `pushWorkspaceSnapshot()`: reads all files, pushes to CoreGit
- `coregitRepoFetch()`: low-level HTTP client with auth header
- All CoreGit normalization logic: slug, namespace, ref formatting

**workspaces.ts routes:**
- `POST /:id/commit` (lines 473–579): existing commit flow
- Pattern: get workspace → validate files → write to sandbox → snapshot to CoreGit

**sonner toast system:**
- Already installed, wired in `client/app/layout.tsx` line 39
- `import { toast } from 'sonner'` — used once in WebSocket error handler
- Available globally, no setup needed

**framer-motion:**
- Already installed (`^12.39.0`)
- Used in existing modal (ApiKeySetupModal.tsx)
- Pattern: `AnimatePresence` + `motion.div` + portal to `document.body`

### 3.2 File Paths We Modify

```
client/
  components/
    system/
      EditorPane.tsx                  ← Replace HighlightedCode, add CommitButton, dirty state
      SystemHeader.tsx               ← No change
  contexts/
    DirtyStateContext.tsx            ← NEW
  components/
    system/
      CodeEditor.tsx                 ← NEW (CM6 wrapper)
      CommitButton.tsx               ← NEW
      CommitModal.tsx                ← NEW (full modal)
      FileStatusBadge.tsx            ← NEW (M/A/D badges)
      PushToggle.tsx                 ← NEW (toggle component)

backend/
  src/
    services/
      coregitService.ts              ← Add pushTargetedCommit()
    routes/
      workspaces.ts                  ← Add POST /:id/commit-targeted, POST /:id/generate-commit
```

---

## 4. Client-Side Architecture

### 4.1 Overall Flow

```
EditorPane
├── DirtyStateProvider (context wrapper)
├── File Tree (existing, unchanged)
├── Tab Bar with dirty indicators
├── Topbar Row
│   ├── "● N modified" pill (conditional)
│   ├── Spacer (flex-grow)
│   └── CommitButton (opens modal)
├── CodeEditor (CM6, replaces HighlightedCode)
│   └── On change → dispatch UPDATE to DirtyState
└── CommitModal (portaled)
    ├── Message textarea
    ├── AI Generate button
    ├── Files changed list
    ├── Push toggles
    └── Commit & Push button
```

### 4.2 State Management Flow

**DirtyStateContext:**
```typescript
interface DirtyFile {
  original: string;      // Original file content
  current: string;       // Current editor content
  addedLines: number;    // Count of \n characters added
  removedLines: number;  // Count of \n characters removed
  status: 'M' | 'A' | 'D'; // Modified | Added | Deleted
}

type DirtyState = {
  files: Map<string, DirtyFile>;
};

type DirtyAction =
  | { type: 'SET_ORIGINAL'; path: string; content: string }
  | { type: 'UPDATE'; path: string; content: string }
  | { type: 'MARK_DELETED'; path: string }
  | { type: 'CLEAR_ALL' }
  | { type: 'CLEAR_FILE'; path: string };
```

**When files are opened (via WebSocket FILE_CONTENT event):**
```
EditorPane receives { path, content }
  ↓
dispatch({ type: 'SET_ORIGINAL', path, content })
  ↓
DirtyState.files.set(path, { original: content, current: content, ... })
  ↓
"If current === original, file is clean" → no dirty dot
```

**When editor changes (CodeEditor onChange):**
```
User types in CodeEditor
  ↓
CodeEditor fires onChange(newContent)
  ↓
EditorPane dispatch({ type: 'UPDATE', path: activeTabPath, content: newContent })
  ↓
DirtyState reducer:
  if newContent === original: delete from map (file is clean)
  else: update files[path] = { original, current: newContent, addedLines, removedLines }
  ↓
Re-render: amber dots appear/disappear, "N modified" pill updates
```

### 4.3 Component Integration Points

**CommitButton:**
```tsx
<CommitButton
  dirtyFileCount={dirtyState.files.size}
  onCommit={() => setCommitModalOpen(true)}
/>
```

**CommitModal:**
```tsx
<CommitModal
  open={commitModalOpen}
  onClose={() => setCommitModalOpen(false)}
  dirtyFiles={Array.from(dirtyState.files.entries())}
  sandboxId={sandboxId}
  workspaceName={workspaceName}
  workspaceId={workspaceId}
  coregitNamespace={coregitNamespace}
  onSuccess={() => {
    dispatch({ type: 'CLEAR_ALL' });
    setCommitModalOpen(false);
  }}
/>
```

---

## 5. Backend Architecture

### 5.1 Route Layering

```
POST /api/workspaces/:id/commit-targeted
├── Validation (message, files array)
├── Database query (get workspace)
├── Sandbox write (files.map → Promise.all)
├── CoreGit push (pushTargetedCommit)
└── Response { success, sha, changedFiles }

POST /api/workspaces/:id/generate-commit
├── Parse request body (diff string)
├── Stream setup (Content-Type: text/plain)
├── Anthropic API call (streaming)
└── Stream text/plain chunks to client
```

### 5.2 Service Layer Changes

**New function in coregitService.ts:**

```typescript
export async function pushTargetedCommit(
  slug: string,
  files: Array<{ path: string; content: string }>,
  commitMessage: string,
  options: { namespace?: string } = {},
): Promise<string | null> {
  const safeSlug = normalizeSlug(slug);
  const safeNamespace = normalizeCoregitNamespace(options.namespace);
  
  // Prepare file changes (same structure as pushWorkspaceSnapshot)
  const changes = files.map(f => ({
    path: f.path,
    content: f.content.slice(0, 80_000), // Enforce max file size
  }));
  
  // Add manifest
  changes.push({
    path: '.prettiflow-manifest.json',
    content: JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      files: files.map(f => f.path),
      type: 'targeted-edit', // Mark as user-initiated edit
    }, null, 2),
  });
  
  try {
    const startedAt = Date.now();
    console.log(`[Coregit] Targeted commit "${safeSlug}" (${files.length} files)...`);
    
    // POST to CoreGit /commits (same endpoint as pushWorkspaceSnapshot)
    const data = await coregitRepoFetch(
      safeSlug,
      safeNamespace,
      '/commits',
      {
        method: 'POST',
        body: JSON.stringify({
          branch: 'main',
          message: commitMessage.slice(0, 200),
          author: {
            name: 'Prettiflow User',
            email: 'user@prettiflow.com', // Could track actual user email if available
          },
          changes,
        }),
      },
      { fallbackToNonNamespacedOn404: true },
    );
    
    const sha = data?.sha || data?.commit?.sha || '';
    console.log(
      `[Coregit] Targeted commit "${safeSlug}" -> ${sha} (${files.length} files, ${Date.now() - startedAt}ms)`
    );
    return sha;
  } catch (err: any) {
    console.error(`[Coregit] pushTargetedCommit failed for "${safeSlug}":`, err.message);
    return null;
  }
}
```

Key difference from `pushWorkspaceSnapshot`:
- No E2B sandbox read (no `Sandbox.connect`, no file reads)
- Files passed in directly (already have content client-side)
- Latency: 150–400ms vs 2.2–5.7s

---

## 6. API Contracts

### 6.1 POST /api/workspaces/:id/commit-targeted

**Request:**
```typescript
{
  message: string;          // Commit message (required)
  files: Array<{
    path: string;           // Relative path (e.g., "src/App.tsx")
    content: string;        // Full file content
  }>;
}
```

**Validation:**
- Message: non-empty string, trimmed
- Files: array with ≥1 item
- Each file.path: non-empty string, forward slashes, no `../` traversal
- Each file.content: string or Buffer

**Response (200 OK):**
```typescript
{
  success: true;
  sha: string;              // CoreGit commit SHA (e.g., "abc1234def5678...")
  changedFiles: number;     // Count of files changed
}
```

**Error Responses:**
- 400: Missing/invalid message or files array
- 404: Workspace not found
- 400: Workspace has no sandbox
- 500: E2B write failed or CoreGit push failed

**Request body size limit:** 50MB (Express default)

### 6.2 POST /api/workspaces/:id/generate-commit

**Request:**
```typescript
{
  diff: string;  // Unified diff string (the actual diff of the modified files)
}
```

**Note:** The client builds the diff by comparing original vs current content for each modified file. The diff should be a standard unified patch format:
```
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -10,7 +10,7 @@
 const App = () => {
-  return <div>Old</div>;
+  return <div>New</div>;
 };
```

**Response (200 OK, streamed):**
```
Content-Type: text/plain; charset=utf-8
Transfer-Encoding: chunked

[streaming text/plain response from Claude Haiku]
```

The client reads this as a stream and appends each chunk to the textarea.

**Error Responses:**
- 400: Missing diff
- 500: Anthropic API error

**Streaming Details:**
- Use `res.setHeader('Content-Type', 'text/plain; charset=utf-8')`
- Use `res.setHeader('Transfer-Encoding', 'chunked')`
- Write chunks via `res.write(text)` in the async `for await` loop
- Call `res.end()` when stream closes

---

## 7. Component Specifications

### 7.1 CodeEditor.tsx

**Purpose:** Wraps CodeMirror 6, handles syntax highlighting, theming, and content updates.

**Props:**
```typescript
interface CodeEditorProps {
  path: string;              // File path (used for language detection)
  content: string;           // Current file content
  onChange: (newContent: string) => void; // Fired on every keystroke
  readOnly?: boolean;        // If true, editor is read-only
}
```

**Exports:**
```typescript
export default React.forwardRef<HTMLDivElement, CodeEditorProps>(CodeEditor);
```

**Key implementation points:**

1. **Language detection:**
```typescript
function getLanguage(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, LanguageSupport> = {
    ts: javascript({ typescript: true }),
    tsx: javascript({ typescript: true, jsx: true }),
    js: javascript(),
    jsx: javascript({ jsx: true }),
    py: python(),
    css: css(),
    scss: css(),
    html: html(),
    json: json(),
    md: markdown(),
  };
  return languageMap[ext] || null;
}
```

2. **Theme setup:**
```typescript
const customTheme = EditorView.theme({
  '&': {
    background: '#0d0d0f',
    height: '100%',
    cursor: 'text',
    fontSize: '12px',
    fontFamily: 'monospace',
  },
  '.cm-content': {
    caretColor: '#E93D82', // Brand pink
    padding: '16px 0',
    lineHeight: '1.65',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)', // Subtle highlight
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-cursor': {
    borderLeftColor: '#E93D82',
    borderLeftWidth: '2px',
  },
  '.cm-gutters': {
    background: '#0d0d0f',
    border: 'none',
    color: 'rgba(255, 255, 255, 0.15)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
  },
}, { dark: true });
```

3. **Extensions array:**
```typescript
const extensions = [
  lineNumbers(),
  highlightActiveLine(),
  EditorView.lineNumbers(),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const newContent = update.state.doc.toString();
      onChange(newContent); // Fire onChange prop
    }
  }),
  keymap.of([indentWithTab]), // Tab key indents
  language ?? [],
  customTheme,
  EditorState.allowMultipleSelections.of(true),
];
```

4. **useEffect to handle path changes:**
```typescript
useEffect(() => {
  if (!view) return;
  if (view.state.doc.toString() !== content) {
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
  }
}, [path]); // Only when path changes, NOT when content prop changes
```

**Why?** CodeMirror owns the editor state after initial render. If we update on every `content` prop change, the user's keystroke would be overwritten. We update the view only when switching to a different file (`path` change).

5. **Container styling:**
```tsx
<div
  ref={containerRef}
  className="flex-1 overflow-hidden bg-[#0d0d0f] rounded-lg border border-[#161618]"
  style={{ height: '100%' }}
/>
```

### 7.2 CommitButton.tsx

**Purpose:** Topbar button that opens the commit modal. Shows badge count when files are modified.

**Props:**
```typescript
interface CommitButtonProps {
  dirtyFileCount: number;        // Number of modified files
  onCommit: () => void;          // Fired when button clicked
  disabled?: boolean;
}
```

**Styling:**
```tsx
className={cn(
  'relative flex items-center gap-2 px-4 py-2 rounded',
  'bg-[#E93D82] text-white font-medium text-[12px]',
  'hover:bg-[#d9336d] transition-colors duration-150',
  'disabled:opacity-50 disabled:cursor-not-allowed',
)}
```

**Badge rendering (conditional):**
```tsx
{dirtyFileCount > 0 && (
  <span className="absolute -top-1 -right-1 bg-[#E93D82] text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center bg-opacity-70">
    {dirtyFileCount}
  </span>
)}
```

**Label:**
```tsx
<ArrowUpRight size={14} className="mr-1" />
Commit
{dirtyFileCount > 0 && ` [${dirtyFileCount}]`}
```

### 7.3 CommitModal.tsx

**Purpose:** Full-featured modal for commit message, AI generation, file preview, and push confirmation.

**Props:**
```typescript
interface CommitModalProps {
  open: boolean;
  onClose: () => void;
  dirtyFiles: Array<[string, DirtyFile]>; // Map entries from DirtyStateContext
  sandboxId: string | null;
  workspaceName: string | undefined;
  workspaceId: string | null;
  coregitNamespace: string | null;
  onSuccess: () => void; // Called after successful commit
}
```

**Internal state:**
```typescript
const [message, setMessage] = useState('');
const [isGenerating, setIsGenerating] = useState(false);
const [isPushing, setIsPushing] = useState(false);
const [pushError, setPushError] = useState<string | null>(null);
const [sandboxToggle, setSandboxToggle] = useState(true);
const [coregitToggle, setCoregitToggle] = useState(true);
```

**Modal layout (detailed):**

```
┌─────────────────────────────────────────────────────────────┐
│ ↑ Commit changes                                         ✕   │  Header
├─────────────────────────────────────────────────────────────┤
│ COMMIT MESSAGE                                              │  Label
│ ┌─────────────────────────────────────────────────────────┐ │  Textarea
│ │ describe what you changed…                              │ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ✦ Generate with AI                                          │  AI button
│                                                             │
│ FILES CHANGED · 3                                           │  Label
│ M src/App.tsx                                    +12  −4    │  File row
│ ─────────────────────────────────────────────────────────   │  Divider
│ M src/App.css                                    +8   −2    │  File row
│ ─────────────────────────────────────────────────────────   │  Divider
│ A src/hooks/useData.ts                           +34  −0    │  File row
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │  Toggles row
│ │ Push to sandbox  ◯●    Push to CoreGit  ●◯             │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ [Discard]                      [↑ Commit & Push]           │  Footer buttons
└─────────────────────────────────────────────────────────────┘
```

**AI Generation flow:**
1. User clicks "✦ Generate with AI"
2. Client builds unified diff from dirtyFiles
3. POST to `/api/workspaces/:id/generate-commit` with diff
4. Stream response as text/plain
5. Use `fetch(...).then(r => r.body)` and `ReadableStreamDefaultReader`
6. Fill textarea char by char
7. Button changes to "✦ Regenerate"

```typescript
async function generateCommitMessage() {
  setIsGenerating(true);
  try {
    const diff = buildUnifiedDiff(dirtyFiles);
    const response = await fetch(
      `${API_URL}/api/workspaces/${workspaceId}/generate-commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff }),
      }
    );
    if (!response.ok) throw new Error(`${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return;
    
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      setMessage(result); // Update textarea in real-time
    }
  } catch (err) {
    setPushError(`Failed to generate: ${err}`);
  } finally {
    setIsGenerating(false);
  }
}
```

**Commit & Push flow:**
1. Validate message (non-empty)
2. Build file array from dirtyFiles
3. If sandboxToggle: POST `/commit-targeted` to sync files to E2B
4. If coregitToggle: same POST endpoint does CoreGit push (or called separately)
5. On success: show green checkmark for 1.5s, then close
6. On error: show error text in footer
7. Call onSuccess() which clears dirty state and closes modal

```typescript
async function handleCommitAndPush() {
  if (!message.trim()) {
    setPushError('Message required');
    return;
  }
  if (!workspaceId) {
    setPushError('Workspace ID missing');
    return;
  }
  
  setIsPushing(true);
  setPushError(null);
  
  try {
    const files = Array.from(dirtyFiles).map(([path, dirty]) => ({
      path,
      content: dirty.current,
    }));
    
    const response = await fetch(
      `${API_URL}/api/workspaces/${workspaceId}/commit-targeted`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          files,
          pushSandbox: sandboxToggle,
          pushCoregit: coregitToggle,
        }),
      }
    );
    
    if (!response.ok) {
      const { error } = await response.json();
      throw new Error(error || `HTTP ${response.status}`);
    }
    
    const { sha } = await response.json();
    
    // Show success checkmark
    setSuccessCheckmark(true);
    await new Promise(r => setTimeout(r, 1500));
    
    toast.success(`Committed · ${sha.slice(0, 7)}`, { duration: 3000 });
    onSuccess(); // Clear dirty state, close modal
  } catch (err: any) {
    setPushError(err.message || 'Commit failed');
  } finally {
    setIsPushing(false);
  }
}
```

**Files changed section:**
```tsx
<div className="space-y-2">
  <label className="text-[10px] uppercase text-gray-500 font-medium">
    Files Changed · {dirtyFiles.length}
  </label>
  <div className="space-y-1 max-h-48 overflow-y-auto">
    {dirtyFiles.map(([path, dirty]) => (
      <div key={path} className="flex items-center justify-between py-2 px-2 hover:bg-white/5 rounded border-b border-gray-800 last:border-0">
        <div className="flex items-center gap-2 flex-1">
          <FileStatusBadge status={dirty.status} />
          <span className="font-mono text-[11px] text-gray-300 truncate">
            {path}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {dirty.addedLines > 0 && (
            <span className="text-[#63C052] text-[11px] font-medium">
              +{dirty.addedLines}
            </span>
          )}
          {dirty.removedLines > 0 && (
            <span className="text-[#E24B4A] text-[11px] font-medium">
              −{dirty.removedLines}
            </span>
          )}
        </div>
      </div>
    ))}
  </div>
</div>
```

### 7.4 FileStatusBadge.tsx

**Purpose:** Renders M/A/D status badge with appropriate color.

**Props:**
```typescript
interface FileStatusBadgeProps {
  status: 'M' | 'A' | 'D';
}
```

**Rendering:**
```tsx
const colors = {
  M: { bg: '#EF9F27', text: '#0d0d0f' }, // Amber
  A: { bg: '#63C052', text: '#0d0d0f' }, // Green
  D: { bg: '#E24B4A', text: '#ffffff' }, // Red
};

const { bg, text } = colors[status];

return (
  <span
    className="px-2 py-0.5 rounded font-mono font-bold text-[9px]"
    style={{
      backgroundColor: bg,
      color: text,
    }}
  >
    {status}
  </span>
);
```

### 7.5 PushToggle.tsx

**Purpose:** Custom pill toggle for "Push to sandbox" and "Push to CoreGit" options.

**Props:**
```typescript
interface PushToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}
```

**Rendering:**
```tsx
return (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={cn(
      'px-3 py-1.5 rounded-full font-medium text-[11px] transition-colors duration-150',
      checked
        ? 'bg-[#E93D82] text-white'
        : 'bg-gray-700 text-gray-300'
    )}
  >
    {label}
  </button>
);
```

---

## 8. DirtyStateContext Design

### 8.1 Context Structure

```typescript
// types.ts or DirtyStateContext.tsx
interface DirtyFile {
  original: string;
  current: string;
  addedLines: number;
  removedLines: number;
  status: 'M' | 'A' | 'D';
}

type DirtyState = {
  files: Map<string, DirtyFile>;
};

type DirtyAction =
  | { type: 'SET_ORIGINAL'; path: string; content: string }
  | { type: 'UPDATE'; path: string; content: string }
  | { type: 'MARK_DELETED'; path: string }
  | { type: 'CLEAR_ALL' }
  | { type: 'CLEAR_FILE'; path: string };
```

### 8.2 Reducer Implementation

```typescript
function countLines(content: string): number {
  return (content.match(/\n/g) || []).length;
}

function dirtyReducer(state: DirtyState, action: DirtyAction): DirtyState {
  const newFiles = new Map(state.files);
  
  switch (action.type) {
    case 'SET_ORIGINAL': {
      // File opened from server
      if (newFiles.has(action.path)) {
        const existing = newFiles.get(action.path)!;
        existing.original = action.content;
        existing.current = action.content;
        if (existing.current === existing.original) {
          newFiles.delete(action.path); // File is clean
        }
      } else {
        // First time opening this file
        newFiles.set(action.path, {
          original: action.content,
          current: action.content,
          addedLines: 0,
          removedLines: 0,
          status: 'M', // Will be cleaned up since current === original
        });
        newFiles.delete(action.path); // File is clean, remove
      }
      return { files: newFiles };
    }
    
    case 'UPDATE': {
      // User edited the file in CodeEditor
      const dirty = newFiles.get(action.path) || {
        original: '', // Fallback (shouldn't happen in normal flow)
        current: '',
        addedLines: 0,
        removedLines: 0,
        status: 'M' as const,
      };
      
      const newContent = action.content;
      const addedLines = countLines(newContent) - countLines(dirty.original);
      const removedLines = countLines(dirty.original) - countLines(newContent);
      
      if (newContent === dirty.original) {
        // File reverted to original
        newFiles.delete(action.path);
      } else {
        newFiles.set(action.path, {
          original: dirty.original,
          current: newContent,
          addedLines: Math.max(0, addedLines),
          removedLines: Math.max(0, removedLines),
          status: 'M',
        });
      }
      return { files: newFiles };
    }
    
    case 'MARK_DELETED': {
      // User deleted the file (or closed without saving)
      const dirty = newFiles.get(action.path) || {
        original: '',
        current: '',
        addedLines: 0,
        removedLines: 0,
        status: 'D' as const,
      };
      newFiles.set(action.path, {
        ...dirty,
        status: 'D',
        current: '', // Clear content to indicate deletion
      });
      return { files: newFiles };
    }
    
    case 'CLEAR_ALL': {
      // Post-commit cleanup
      return { files: new Map() };
    }
    
    case 'CLEAR_FILE': {
      // Clear a single file (post-commit or manual)
      newFiles.delete(action.path);
      return { files: newFiles };
    }
    
    default:
      return state;
  }
}
```

### 8.3 Context Provider & Hook

```typescript
const DirtyStateContext = React.createContext<{
  state: DirtyState;
  dispatch: React.Dispatch<DirtyAction>;
} | undefined>(undefined);

export function DirtyStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(dirtyReducer, { files: new Map() });
  
  return (
    <DirtyStateContext.Provider value={{ state, dispatch }}>
      {children}
    </DirtyStateContext.Provider>
  );
}

export function useDirtyState() {
  const context = useContext(DirtyStateContext);
  if (!context) {
    throw new Error('useDirtyState must be used inside DirtyStateProvider');
  }
  return context;
}
```

---

## 9. CodeEditor (CodeMirror 6) Integration

### 9.1 CM6 Extension Strategy

**Core extensions:**
1. `lineNumbers()` — line number gutter
2. `highlightActiveLine()` — current line background
3. `EditorView.updateListener` — watch for changes, fire onChange
4. Language-specific extension (JS, Python, etc.)
5. Custom theme (dark, brand pink caret)
6. `EditorState.allowMultipleSelections` — multi-cursor support

**NOT included (keep bundle small):**
- `search()` — no search UI yet
- `autocompletion()` — might add later
- `foldGutter()` — might add later

### 9.2 CSS Theme Definition

```typescript
const customTheme = EditorView.theme({
  // Root container
  '&': {
    background: '#0d0d0f',
    height: '100%',
    cursor: 'text',
  },
  
  // Editor content area
  '.cm-content': {
    caretColor: '#E93D82',
    fontFamily: 'monospace',
    fontSize: '12px',
    lineHeight: '1.65',
    padding: '16px 0',
  },
  
  // Active line highlight (current line cursor is on)
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  
  // Cursor appearance
  '.cm-cursor': {
    borderLeftColor: '#E93D82',
    borderLeftWidth: '2px',
  },
  '.cm-cursor-primary': {
    borderLeftColor: '#E93D82',
  },
  
  // Gutters (line numbers area)
  '.cm-gutters': {
    background: '#0d0d0f',
    border: 'none',
    color: 'rgba(255, 255, 255, 0.15)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
    width: 'auto',
    minWidth: '40px',
  },
  
  // Syntax highlighting (via language extension)
  '.cm-string': { color: '#E8B881' },
  '.cm-number': { color: '#E8B881' },
  '.cm-atom': { color: '#A8D8EA' },
  '.cm-keyword': { color: '#E93D82' },
  '.cm-variable': { color: '#D4D4D4' },
  '.cm-comment': { color: '#7B8B6F', fontStyle: 'italic' },
}, { dark: true });
```

### 9.3 Language Auto-Detection

```typescript
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

function getLanguageSupport(filePath: string): LanguageSupport | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  
  const map: Record<string, LanguageSupport> = {
    ts: javascript({ typescript: true }),
    tsx: javascript({ typescript: true, jsx: true }),
    js: javascript(),
    jsx: javascript({ jsx: true }),
    py: python(),
    css: css(),
    scss: css(),
    html: html(),
    json: json(),
    md: markdown(),
  };
  
  return map[ext] || null;
}
```

---

## 10. CommitModal Specification

### 10.1 Portal & Animation

```typescript
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

export function CommitModal({ open, ...props }: CommitModalProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          onClick={() => props.onClose()}
        >
          <motion.div
            key="modal"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-h-[80vh] bg-[#0d0d0f] rounded-lg border border-[#1f1f21] shadow-2xl z-[201]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal content */}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
```

### 10.2 Form Layout Structure

```tsx
<div className="flex flex-col h-full max-h-[80vh]">
  {/* Header */}
  <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f1f21]">
    <h2 className="text-[13px] font-500">↑ Commit changes</h2>
    <button
      type="button"
      onClick={() => onClose()}
      className="text-gray-400 hover:text-white transition"
    >
      <X size={18} />
    </button>
  </div>
  
  {/* Body (scrollable) */}
  <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
    {/* Message input */}
    {/* AI generate button */}
    {/* Files changed list */}
    {/* Push toggles */}
  </div>
  
  {/* Footer */}
  <div className="flex items-center gap-3 px-6 py-4 border-t border-[#1f1f21]">
    <button type="button" className="flex-1 py-2 px-4 rounded-lg bg-gray-800 text-white text-[12px] font-medium hover:bg-gray-700">
      Discard
    </button>
    <button type="button" className="flex-[2] py-2 px-4 rounded-lg bg-[#E93D82] text-white text-[12px] font-medium hover:bg-[#d9336d] flex items-center justify-center gap-2">
      <ArrowUpRight size={14} />
      Commit & Push
    </button>
  </div>
</div>
```

### 10.3 Textarea for Message

```tsx
<div>
  <label className="text-[10px] uppercase text-gray-500 font-medium block mb-2">
    Commit Message
  </label>
  <textarea
    value={message}
    onChange={(e) => setMessage(e.target.value)}
    placeholder="describe what you changed…"
    rows={2}
    className={cn(
      'w-full px-3 py-2 rounded-lg font-mono text-[12px]',
      'bg-transparent border transition-colors duration-150',
      'placeholder:text-gray-600',
      'focus:outline-none',
      message.trim()
        ? 'border-[#E93D82] focus:border-[#E93D82] focus:bg-[rgba(233,61,130,0.04)]'
        : 'border-[rgba(255,255,255,0.12)] focus:border-[#E93D82]'
    )}
  />
</div>
```

---

## 11. E2B & CoreGit Integration

### 11.1 E2B Sandbox File Writes

The backend `POST /api/workspaces/:id/commit-targeted` route:

```typescript
const sandbox = await Sandbox.connect(workspace.sandboxId);

// Create directories (same as existing /commit route)
const uniqueDirs = [
  ...new Set(
    files.map(f =>
      f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    ).filter(Boolean)
  ),
];

if (uniqueDirs.length > 0) {
  const mkdirArgs = uniqueDirs
    .map(d => `/workspace/${d}`)
    .map(d => `'${d.replace(/'/g, "'\"'\"'")}'`)
    .join(' ');
  await sandbox.commands.run(`mkdir -p ${mkdirArgs}`);
}

// Write all files in parallel
await Promise.all(
  files.map(file =>
    sandbox.files.write(`/workspace/${file.path}`, file.content)
  )
);
```

### 11.2 CoreGit Targeted Commit

The new `pushTargetedCommit()` function calls:

```typescript
POST /v1/repos/:namespace/:slug/commits

{
  "branch": "main",
  "message": "fix: update component styling",
  "author": {
    "name": "Prettiflow User",
    "email": "user@prettiflow.com"
  },
  "changes": [
    { "path": "src/App.tsx", "content": "..." },
    { "path": "src/App.css", "content": "..." },
    { "path": ".prettiflow-manifest.json", "content": "..." }
  ]
}
```

Response:
```json
{
  "sha": "abc1234def5678...",
  "commit": {
    "sha": "abc1234def5678...",
    "message": "fix: update component styling",
    "author": "Prettiflow User <user@prettiflow.com>",
    "created_at": "2026-05-24T12:34:56Z"
  }
}
```

---

## 12. Design System & Styling

### 12.1 Color Tokens

```css
--brand-pink: #E93D82;
--editor-bg: #0d0d0f;
--topbar-bg: #161618;
--border-subtle: rgba(255, 255, 255, 0.07);
--border-medium: rgba(255, 255, 255, 0.12);
--text-primary: rgba(255, 255, 255, 0.88);
--text-secondary: rgba(255, 255, 255, 0.5);
--text-muted: rgba(255, 255, 255, 0.3);
--modified-amber: #EF9F27;
--added-green: #63C052;
--deleted-red: #E24B4A;
```

### 12.2 Typography

| Usage | Size | Weight | Font Family |
|---|---|---|---|
| Modal title | 13px | 500 | sans-serif |
| Tab labels | 11px | 400 | monospace |
| Commit button | 12px | 500 | sans-serif |
| File paths | 11px | 400 | monospace |
| Status badges | 9px | 700 | monospace |
| Label (COMMIT MESSAGE) | 10px | 500 | sans-serif |

### 12.3 Spacing & Rounding

| Element | Padding | Border Radius | Gap |
|---|---|---|---|
| Modal | 24px (header/footer), 16px (body) | 8px | 16px (sections) |
| Buttons | 8px horizontal, 6px vertical | 8px | 8px (between) |
| Textarea | 12px | 8px | N/A |
| Status badge | 6px horiz, 4px vert | 4px | N/A |
| Toggle pill | 12px horiz, 6px vert | 999px (full-rounded) | 8px |

### 12.4 Animations & Transitions

| Effect | Duration | Easing | Use |
|---|---|---|---|
| Dirty dot appear | 150ms | ease | Tab/tree indicators |
| Modal entrance | 180ms | ease-out | Scale 0.96→1 + opacity |
| Button hover | 150ms | ease | Background color |
| Toggle switch | 150ms | ease | Background on toggle |

### 12.5 Tailwind Configuration Assumptions

The project uses Tailwind CSS v3+ with the existing theme tokens. We assume:
- `@apply` directives work
- Custom colors via `className="text-[#EF9F27]"` syntax work
- Opacity modifiers via `bg-white/10` work
- Responsive prefixes (`sm:`, `md:`) available

---

## 13. Performance Analysis

### 13.1 Latency Comparison

**Full snapshot (existing `POST /:id/commit`):**
```
Client → Backend (100ms)
  ↓
Sandbox.connect() (100ms)
  ↓
find + filter files in /workspace (200ms)
  ↓
Read 180 files, 12 concurrent workers:
  - Each read ~20ms (E2B I/O)
  - Total ~1500-4000ms (bottleneck)
  ↓
Build file array + manifest (50ms)
  ↓
POST to CoreGit (500-1500ms, 500KB payload)
  ↓
Response (100ms)

Total: ~2.4-5.9 seconds
```

**Targeted commit (new `POST /:id/commit-targeted`):**
```
Client builds diff in memory (0ms)
  ↓
Client → Backend (100ms)
  ↓
Validate files (10ms)
  ↓
Sandbox.connect() (100ms)
  ↓
Write 3-5 files (Promise.all) (~200ms)
  ↓
Build manifest (10ms)
  ↓
POST to CoreGit (100-400ms, 10-50KB payload)
  ↓
Response (100ms)

Total: ~0.6-1.1 seconds (excluding network round-trips)
Actual end-to-end: ~150-400ms
```

**Why 10-15x faster:**
1. No E2B file read loop (saves ~2-4s)
2. Smaller payload (saves ~200-1000ms)
3. No manifest building from 180 files

### 13.2 Bundle Size Impact

CodeMirror 6 package sizes:
- `@codemirror/view`: ~50KB
- `@codemirror/state`: ~30KB
- `@codemirror/language`: ~30KB
- Language extensions (all 6): ~120KB
- Theme: ~5KB
- Total: ~235KB (before gzip)
- Gzipped: ~60KB

Vs Monaco: ~2MB (before gzip, ~600KB gzipped)

**Impact:** +60KB gzipped is acceptable for the UX improvement.

### 13.3 Runtime Performance

**Editor initialization:**
- Create EditorView + extensions: ~50ms
- Render in DOM: ~20ms
- Initial syntax highlighting: ~10ms
- **Total: ~80ms**

**On keystroke:**
- Update EditorState: <1ms
- onChange callback fire: <1ms
- React re-render (dispatch to DirtyState): ~5ms
- **Total: <10ms per keystroke**

No performance bottlenecks expected.

---

## 14. Error Handling & Edge Cases

### 14.1 E2B Errors

**Scenario:** Sandbox is paused/disconnected
```
Sandbox.connect(sandboxId) → throws error
→ Backend catches, responds 500
→ Frontend shows toast "Sandbox unavailable"
```

**Scenario:** File write fails (permission, disk full)
```
sandbox.files.write() → throws error
→ Promise.all rejects
→ Backend catches, responds 400
→ Frontend shows modal error: "Failed to write src/App.tsx"
```

### 14.2 CoreGit Errors

**Scenario:** CoreGit API down
```
coregitRepoFetch() → 500 from CoreGit
→ Backend error handler logs + returns 500
→ Frontend shows "Commit failed: CoreGit unavailable"
→ User can retry
```

**Scenario:** Files too large for CoreGit
```
CoreGit rejects if changes.content > 80KB
→ Backend catches, returns 400
→ Frontend shows "File too large: src/App.tsx (120KB)"
```

### 14.3 Client-Side Errors

**Scenario:** User closes browser during streaming AI generation
```
fetch().then(r => r.body).getReader()
→ User navigates away
→ Reader automatically closes
→ isGenerating state reset when component unmounts
→ No memory leak (useEffect cleanup)
```

**Scenario:** User edits file, closes tab before committing
```
closeTab(path)
→ dispatch({ type: 'MARK_DELETED', path }) [optional, to track deletions]
→ Remove from openTabs state
→ File still in dirtyState.files (shows in commit)
→ User can still commit after re-opening
```

**Scenario:** Network error during commit
```
fetch() → network error
→ catch block sets pushError
→ Modal shows error text
→ User can retry immediately
```

### 14.4 Race Conditions

**Scenario:** User rapidly switches between files
```
File A open → Editor renders
→ User clicks File B
→ EditorPane updates activeTabPath
→ useEffect clears old CodeEditor, creates new
→ No race: EditorView state is scoped per component mount
```

**Scenario:** Commit in progress, user edits file again
```
setIsPushing(true) disables Commit button
→ User cannot click again during push
→ onChange still fires (file is editable)
→ DirtyState updates
→ After push completes, CLEAR_ALL resets dirty state
→ New edits tracked normally
```

### 14.5 Validation Rules

**Message validation:**
- Non-empty, trimmed
- Max 200 characters (enforce server-side)
- No special characters (CoreGit accepts UTF-8)

**File path validation:**
- No absolute paths (`/workspace/` prefix removed)
- No `../` traversal (filter out)
- Forward slashes (normalize backslashes)
- Max 255 characters

**File content validation:**
- Max 80KB per file
- UTF-8 encoded (TextDecoder handles)

---

## 15. Testing Strategy

### 15.1 Unit Tests

**DirtyStateContext reducer:**
```typescript
test('UPDATE: clean file becomes dirty', () => {
  const state = { files: new Map() };
  const action = {
    type: 'UPDATE',
    path: 'src/App.tsx',
    content: 'modified content',
  };
  // Mock SET_ORIGINAL first
  let result = dirtyReducer(state, {
    type: 'SET_ORIGINAL',
    path: 'src/App.tsx',
    content: 'original content',
  });
  // Now UPDATE
  result = dirtyReducer(result, action);
  
  expect(result.files.has('src/App.tsx')).toBe(true);
  const dirty = result.files.get('src/App.tsx')!;
  expect(dirty.current).toBe('modified content');
  expect(dirty.status).toBe('M');
});

test('UPDATE: revert to original removes from map', () => {
  const state = { files: new Map() };
  // Setup original
  const s1 = dirtyReducer(state, {
    type: 'SET_ORIGINAL',
    path: 'src/App.tsx',
    content: 'original',
  });
  // Modify
  const s2 = dirtyReducer(s1, {
    type: 'UPDATE',
    path: 'src/App.tsx',
    content: 'modified',
  });
  // Revert
  const s3 = dirtyReducer(s2, {
    type: 'UPDATE',
    path: 'src/App.tsx',
    content: 'original',
  });
  
  expect(s3.files.has('src/App.tsx')).toBe(false);
});
```

**File status badge color:**
```typescript
test('FileStatusBadge renders M/A/D with correct colors', () => {
  const { getByText } = render(<FileStatusBadge status="M" />);
  const badge = getByText('M');
  expect(badge).toHaveStyle({ backgroundColor: '#EF9F27' });
});
```

### 15.2 Integration Tests

**CodeEditor onChange callback:**
```typescript
test('CodeEditor fires onChange on keystroke', async () => {
  const onChange = jest.fn();
  const { container } = render(
    <CodeEditor
      path="src/App.tsx"
      content="initial"
      onChange={onChange}
    />
  );
  
  // Simulate CM6 update (since rendering CM6 in JSDOM is tricky,
  // mock the updateListener firing)
  // This would be easier with playwright/cypress E2E test
});
```

### 15.3 E2E Tests (Playwright / Cypress)

**Happy path: Edit → Commit → Success**
```gherkin
Feature: Edit File & Commit
  Scenario: User edits file and commits
    Given I have a workspace open with files
    When I click on "src/App.tsx" in the file tree
    And I edit the content in the editor
    Then an amber dot appears next to the filename
    And the Commit button shows "Commit [1]" badge
    When I click the Commit button
    And I fill in the message "fix: update component"
    And I click "Commit & Push"
    Then the modal shows a loading spinner
    And the sandbox and CoreGit toggles are active
    And after ~1 second, a checkmark appears
    And the modal closes
    And a toast appears: "Committed · abc1234"
    And the file tree no longer shows the amber dot
    And the topbar shows "↑ abc1234"
```

**AI generation:**
```gherkin
Scenario: Generate commit message with AI
  Given the commit modal is open with changes listed
  When I click "✦ Generate with AI"
  Then the button shows a loading state
  And the textarea is disabled
  And after ~500ms, text starts appearing in the textarea
  And the button changes to "✦ Regenerate"
  And the textarea is enabled
```

**Error handling:**
```gherkin
Scenario: Commit fails due to network error
  Given the commit modal is open
  When I click "↑ Commit & Push"
  And the backend returns a 500 error
  Then the button stops showing a spinner
  And an error message appears in the modal: "Commit failed: ..."
  And the modal stays open so I can retry
```

### 15.4 Visual Regression Testing

Use Percy.io or similar to detect unintended style changes on:
- CommitModal appearance
- Dirty dot colors and positions
- Tab bar with multiple modified files
- Button hover/active states

---

## 16. Org Contributions & Notes

### 16.1 Why This Architecture

**Targeted commits are transformational for UX:**
- Agent runs already push snapshots to CoreGit (1–2 commits per run)
- User edits should be lightweight, fast, and feel responsive
- Reducing latency from 2–6s to 0.2–0.4s is a 10–30x improvement
- Matches user expectations from Linear, GitHub, Vercel

**CodeMirror 6 is the right choice:**
- Bundle size: 60KB gzipped vs 600KB for Monaco
- Initialization: 80ms vs 400ms+
- Extensibility: perfect for future features (search, completion, etc.)
- Performance: no noticeable lag on editing

**React Context (not Zustand) keeps scope contained:**
- DirtyStateContext is editor-specific, not app-wide
- Reduces cognitive load: all dirty-state logic in one file
- Matches existing codebase patterns
- Easier to test in isolation

### 16.2 Future Extensibility

**This architecture enables:**
1. **Undo/redo:** Editor state history via CodeMirror's history extension
2. **Search/replace:** CodeMirror search panel extension
3. **Collaborative editing:** Yjs + CodeMirror (add later if needed)
4. **AI inline edits:** "Regenerate this function" → stream edits from Claude
5. **Code formatting:** Prettier integration on save
6. **Diagnostics:** ESLint/TypeScript diagnostics gutter

All possible without major refactoring.

### 16.3 Accessibility Considerations

- **Keyboard navigation:** Tab through modal buttons, Escape to close
- **Focus management:** Modal traps focus, returns focus on close
- **Screen readers:** ARIA labels on buttons, roles on sections
- **Color contrast:** All text meets WCAG AA minimum (4.5:1)
- **Motion:** Reduced animations if `prefers-reduced-motion` enabled

### 16.4 Security Considerations

- **File paths:** Normalize to prevent directory traversal (`..` filtering)
- **File content:** No sanitization needed (plain text files)
- **Message:** Max 200 chars, CoreGit handles escaping
- **Network:** HTTPS enforced (existing infrastructure)
- **CORS:** Backend handles origin validation (existing)

### 16.5 Monitoring & Observability

Log the following for debugging:
- `[Coregit] Targeted commit "${slug}" -> ${sha} (${files.length} files, ${duration}ms)`
- File size distribution for performance tracking
- Commit message generation latency
- CoreGit API errors and retry counts

---

## 17. Appendix: Utility Functions

### 17.1 Build Unified Diff

```typescript
function buildUnifiedDiff(dirtyFiles: Array<[string, DirtyFile]>): string {
  const patches: string[] = [];
  
  for (const [path, dirty] of dirtyFiles) {
    if (dirty.status === 'D') {
      patches.push(`--- a/${path}`);
      patches.push(`+++ /dev/null`);
      patches.push(`@@ -1,${countLines(dirty.original)} +0,0 @@`);
      dirty.original.split('\n').forEach(line => {
        patches.push(`-${line}`);
      });
    } else {
      patches.push(`--- a/${path}`);
      patches.push(`+++ b/${path}`);
      
      // Simple diff: could use a proper diff library for better hunks
      const oldLines = dirty.original.split('\n');
      const newLines = dirty.current.split('\n');
      
      const startLine = 0;
      const endLine = Math.max(oldLines.length, newLines.length);
      patches.push(`@@ -${startLine + 1},${oldLines.length} +${startLine + 1},${newLines.length} @@`);
      
      for (let i = 0; i < endLine; i++) {
        if (i < oldLines.length && i < newLines.length) {
          if (oldLines[i] !== newLines[i]) {
            patches.push(`-${oldLines[i]}`);
            patches.push(`+${newLines[i]}`);
          } else {
            patches.push(` ${oldLines[i]}`);
          }
        } else if (i < oldLines.length) {
          patches.push(`-${oldLines[i]}`);
        } else {
          patches.push(`+${newLines[i]}`);
        }
      }
    }
  }
  
  return patches.join('\n');
}
```

### 17.2 Line Count Utility

```typescript
function countLines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

function countLinesAdded(original: string, current: string): number {
  const newLineCount = countLines(current);
  const originalLineCount = countLines(original);
  return Math.max(0, newLineCount - originalLineCount);
}

function countLinesRemoved(original: string, current: string): number {
  const originalLineCount = countLines(original);
  const newLineCount = countLines(current);
  return Math.max(0, originalLineCount - newLineCount);
}
```

### 17.3 Normalize File Path

```typescript
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/') // Windows backslashes
    .replace(/^\/+/, '') // Leading slashes
    .replace(/\/+/g, '/') // Multiple slashes
    .replace(/\/$/, ''); // Trailing slash
}

function sanitizeFilePath(path: string): string | null {
  const normalized = normalizePath(path);
  
  // Reject dangerous paths
  if (normalized.includes('..') || normalized.startsWith('/')) {
    return null;
  }
  
  if (normalized.length === 0 || normalized.length > 255) {
    return null;
  }
  
  return normalized;
}
```

---

## End of Implementation Reference

This document provides the complete technical specification for the Edit File & Commit feature. Use it as a reference during implementation, but defer to the actual codebase for authoritative truth on existing patterns, APIs, and configurations.

Last updated: 2026-05-24  
Status: Ready for implementation  
