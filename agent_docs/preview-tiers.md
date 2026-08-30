# Preview Tiers Spec — Bicameral

> Referenced by CLAUDE.md via `@agent_docs/preview-tiers.md`. Read before Phase 6.
> **Pipeline integration:** The preview system is Agent 4 (Coder)'s sandbox — where it writes code, runs it, and collects errors for the feedback loop.

## Three-Tier Progressive Enhancement

The preview system guarantees that users ALWAYS get a preview, regardless of what they generated or what tier they're on. It tries the highest tier first and falls back progressively.

```
Sandbox (Pro/Team + backend code)
  ↓ if fails or unavailable
esbuild-wasm (multi-file + imports)
  ↓ if fails
Babel standalone (always works)
```

### Pipeline Integration

During Step 4 (Architecture Implemented), the Coder agent calls `run_preview` with the files it has generated. The preview strategy selects the tier based on the blueprint's complexity:
- Simple (single page, no backend) → Tier 1 (Babel)
- Moderate (multi-file frontend, no backend) → Tier 2 (esbuild-wasm)
- Complex (frontend + backend/API) → Tier 3 (CF Sandbox)

When the preview runs, errors are collected via `read_logs` and fed back to the Coder agent for the next iteration of the error feedback loop (max 5 iterations).

```
Coder agent writes files (via write_file tool)
     ↓
run_preview tool calls preview-strategy.ts
     ↓
Preview tier selected based on blueprint complexity
     ↓
Code renders in PreviewFrame
     ↓
read_logs tool collects any errors
     ↓
Errors fed back to Coder agent as context
     ↓
Coder fixes the code
     ↓
Repeat until clean or max 5 iterations
```

## Tier 1 — Babel Standalone (Free, Instant)

- **How:** Loads `@babel/standalone` from unpkg CDN inside a sandboxed iframe
- **Input:** Single TSX file
- **Output:** Transpiled JSX rendered in React 19 (from CDN as UMD globals)
- **Limitations:** Can't resolve imports (strips them), single-file only
- **Fallback:** None — this is the floor
- **Pipeline use:** Coder agent uses this for simple blueprints (complexity: 'simple')
- **Files:** `PreviewFrame.tsx` → `buildBabelHTML()` function

## Tier 2 — esbuild-wasm (Free, ~1-2s)

- **How:** Web Worker runs esbuild-wasm with a virtual filesystem plugin
- **Input:** Multiple TSX/TS/JSX/JS/CSS files with cross-file imports
- **Output:** Single bundled HTML document with inline JS + CSS + import map
- **Process:**
  1. `useEsbuild` hook spawns Web Worker on mount
  2. Worker initializes esbuild-wasm from CDN (~500ms one-time)
  3. Hook sends `{ files, entry }` to Worker via postMessage
  4. Worker creates virtual FS plugin mapping paths → content
  5. Worker runs `esbuild.build()` with virtual FS
  6. External imports (react, react-dom, lucide-react) → CDN via import map
  7. Worker returns bundled HTML + duration
  8. PreviewFrame sets `iframe.srcdoc = html`
- **Fallback:** If bundling fails → Tier 1 (Babel)
- **Pipeline use:** Coder agent uses this for moderate blueprints (multi-file, no backend)
- **Files:** `esbuild.worker.ts`, `useEsbuild.ts`, `preview-strategy.ts`, `PreviewFrame.tsx`

## Tier 3 — Cloudflare Sandboxes (Pro/Team, ~5-10s, Full-Stack)

- **How:** Full Linux container runs `npm install && npm run dev`
- **Input:** Any project (frontend + backend + API routes)
- **Output:** Public HTTPS preview URL loaded in iframe
- **Process:**
  1. Strategy detects backend files (server.ts, api/, worker.ts)
  2. `useSandboxPreview` hook POSTs files to `/api/preview/:projectId`
  3. Worker writes files to `/workspace/` in container
  4. Worker runs `npm install` (60s timeout)
  5. Worker starts dev server: `npm run dev`
  6. Worker exposes port 5173 via `sandbox.exposePort()`
  7. Returns public HTTPS preview URL
  8. PreviewFrame sets `iframe.src = previewUrl`
- **Fallback:** If sandbox fails → Tier 2 (esbuild) → Tier 1 (Babel)
- **Cost:** ~$0.0003 per session, free tier: 750 sessions/month
- **Pipeline use:** Coder agent uses this for complex blueprints (frontend + backend)
- **Error collection:** `GET /api/preview/:projectId/logs` (SSE stream) provides real-time error output for the Coder agent
- **Files:** `Dockerfile.preview`, `routes/preview.ts`, `useSandboxPreview.ts`, `wrangler.toml`

## Strategy Selector Logic

```typescript
function selectPreviewTier({ userTier, files, hasSandboxAccess, blueprintComplexity }): PreviewTier {
  // If called by Coder agent, use blueprint complexity
  if (blueprintComplexity === 'simple') {
    return { tier: 'babel', reason: 'Simple blueprint — single file' };
  }

  // Check for backend code → needs sandbox
  const hasBackend = files.some(f =>
    f.path.includes('server.ts') ||
    f.path.includes('api/') ||
    f.path.includes('worker.ts') ||
    f.path.includes('package.json')
  );

  if (hasBackend && hasSandboxAccess && userTier !== 'free') {
    return { tier: 'sandbox', reason: 'Backend code detected' };
  }

  // Check for multi-file with imports → needs esbuild
  const hasImports = files.some(f =>
    f.content.includes("from './") ||
    f.content.includes('import {')
  );

  if (files.length > 1 && hasImports) {
    return { tier: 'esbuild', reason: 'Multi-file with imports' };
  }

  // Default: Babel (always works)
  return { tier: 'babel', reason: 'Single-file preview' };
}
```

## Wrangler Config (wrangler.toml)

```toml
[durable_objects]
bindings = [
  { name = "GENERATION_DO", class_name = "GenerationOrchestrator" },
  { name = "LATTICE_DO", class_name = "LatticeManager" },
  { name = "PREVIEW_SANDBOX", class_name = "Sandbox" }
]

[[containers]]
class_name = "Sandbox"
image = "./Dockerfile.preview"
instance_type = "lite"
max_instances = 10
```

## Vite Config (for Web Worker support)

```typescript
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['esbuild-wasm'] },
});
```
