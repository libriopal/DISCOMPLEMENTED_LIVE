# API Spec — Bicameral

> Referenced by CLAUDE.md via `@agent_docs/api-spec.md`. Read before Phase 3.

## All Routes: 28 core + 5 pipeline + 5 preview + 9 admin + 4 chat + 5 billing = 56 total

### Auth (1 route)

```
ALL /api/auth/* → Better Auth handler (login, logout, callback, session)
```

### Pipeline (5 routes — NEW, the 4-agent "CTO-in-a-Box" system)

```
POST /api/pipeline
  Body: { prompt: string, projectId?: string }
  Response: { pipelineId: string, status: "pending" }
  Auth: required, credits: 50-200 per full pipeline (model-dependent)
  Description: Starts the 4-agent pipeline. The GenerationOrchestrator DO
    runs: Architect (Step 1) → Researcher (Step 2) → Designer (Step 3) →
    [HUMAN GATE] → Coder (Step 4). Results stream via SSE.

GET /api/pipeline/:id
  Response: SSE stream (text/event-stream)
  Events:
    { type: "step:start", step: 1, agent: "architect", model: "command-a" }
    { type: "step:progress", step: 1, progress: 0.5, message: "Analyzing your vision..." }
    { type: "step:complete", step: 1, brief: { app_name, app_type, core_features, ... } }
    { type: "step:start", step: 2, agent: "researcher", model: "command-r7b" }
    { type: "step:complete", step: 2, research: { tech_stack, patterns, risks } }
    { type: "step:start", step: 3, agent: "designer", model: "command-a" }
    { type: "step:complete", step: 3, blueprint: { components, database, api_routes, ... } }
    { type: "gate:awaiting_approval", message: "Review your blueprint to continue" }
    { type: "step:start", step: 4, agent: "coder", model: "north-mini-code" }
    { type: "iteration:complete", iteration: 1, errors: 3, fixed: true }
    { type: "pipeline:complete", deploymentUrl: "https://..." }
    { type: "error", message: "...", step: 2 }
  Auth: required (owner only)

POST /api/pipeline/:id/approve
  Body: { approved: boolean, feedback?: string }
  Response: { status: "implementing" | "restarted" }
  Auth: required (owner only)
  Description: Approves the blueprint gate → Coder agent starts.
    If rejected with feedback, pipeline restarts from Step 1 with the feedback.

POST /api/pipeline/:id/cancel
  Response: { success: true, status: "cancelled" }
  Auth: required (owner only)

GET /api/pipeline/:id/blueprint
  Response: { id, components, database_schema, api_routes, auth_strategy, env_vars, deploy_config }
  Auth: required (owner only)
  Description: Get the current blueprint for founder review during the approval gate.
```

### Generate (4 routes — legacy direct generation, still available)

```
POST /api/generate
  Body: { prompt: string, projectId?: string }
  Response: SSE stream (text/event-stream)
  Events: { type: "plan", ... } | { type: "file", path, content } | { type: "step", ... } | { type: "complete" } | { type: "error" }
  Auth: required, credits: 1-50 per generation (model-dependent)
  Note: For the full 4-agent pipeline, use POST /api/pipeline instead.

POST /api/generate/project
  Body: { name: string, prompt: string }
  Response: { projectId: string }
  Auth: required

GET /api/generate/:id
  Response: { id, status, files, model, pipelineRunId, created_date }
  Auth: required (owner only)

POST /api/generate/:id/cancel
  Response: { success: true }
  Auth: required (owner only)
```

### Research (3 routes)

```
POST /api/research
  Body: { query: string, projectId?: string, pipelineRunId?: string }
  Response: { id, results: [{ title, content, score }] }
  Auth: required, credits: 5 per query, tier cap enforced
  Note: When called with pipelineRunId, results feed into Agent 2 (Researcher).

GET /api/research/:id
  Response: { id, query, results, pipelineRunId, created_date }
  Auth: required (owner only)

GET /api/research/history
  Query: ?limit=20&skip=0
  Response: [{ id, query, pipelineRunId, created_date }]
  Auth: required
```

### Projects (7 routes)

```
GET    /api/projects           — List user's projects
POST   /api/projects           — Create project
GET    /api/projects/:id       — Get project (includes pipelineRunIds if generated via pipeline)
PATCH  /api/projects/:id       — Update project
DELETE /api/projects/:id       — Delete project
GET    /api/projects/:id/files — Get all files for project
POST   /api/projects/:id/files — Save files to project
```

### Lattice (5 routes)

```
GET    /api/lattice/:projectId           — Get all nodes + edges
  Response includes: node.metadata.pipeline_step and node.metadata.agent_role
  for nodes created by the pipeline's lattice enrichment
POST   /api/lattice/:projectId/nodes     — Create node
PATCH  /api/lattice/nodes/:id            — Update node
DELETE /api/lattice/nodes/:id            — Delete node
POST   /api/lattice/:projectId/edges     — Create edge
```

### Usage (3 routes)

```
GET /api/usage            — { credits_remaining, credits_used, tier, rate_limit_remaining }
GET /api/usage/credits    — { balance, history: [{ amount, type, description, pipelineRunId, date }] }
GET /api/usage/breakdown — { by_model: { "command-r7b": { count, tokens } }, by_pipeline_step: { "architect": {...}, "researcher": {...}, ... } }
```

### Preview (5 routes)

```
POST   /api/preview/:projectId     — Create/update sandbox, start dev server
  Note: Called by Agent 4 (Coder) during the error feedback loop.
GET    /api/preview/:projectId     — Get sandbox status + preview URL
DELETE /api/preview/:projectId     — Destroy sandbox
GET    /api/preview/:projectId/logs — SSE stream of sandbox logs (used by Coder to collect errors)
ALL    /api/preview/* (proxy)     — proxyToSandbox for preview URL requests
```

### Admin (9 routes — new in Phase 7)

```
GET   /api/admin/metrics          — System health (CPU, D1, requests, errors, pipeline stats)
GET   /api/admin/security         — Security event log
GET   /api/admin/bottlenecks      — P95/P99 per route, hot routes, pipeline step timing
GET   /api/admin/recommendations  — Heuristic engine recommendations (includes R9-R11 pipeline rules)
GET   /api/admin/users            — All users with tiers + credits
PATCH /api/admin/users/:id        — Update user (ban, tier, credits)
POST  /api/admin/maintenance      — Toggle maintenance mode
POST  /api/admin/shutdown         — Emergency shutdown [-full only] (kills all active pipelines)
DELETE /api/admin/sandbox/:id     — Kill sandbox session [-write+]
```

### Admin Pipeline Routes (3 routes — extension of admin)

```
GET   /api/admin/pipelines          — List all active/recent pipeline runs across all users
GET   /api/admin/pipelines/:id      — Get detailed pipeline run with all step outputs
POST  /api/admin/pipelines/:id/cancel — Cancel any user's pipeline [-write+]
```

### Chat (4 routes — Phase 8)

```
ALL /api/chat/* (WebSocket upgrade)  — FluxyChat realtime connection
GET  /api/chat/health                — Chat service health check
POST /api/chat/agent/invoke          — Invoke AI agent in a room (pipeline-aware)
GET  /api/chat/rooms                 — List available chat rooms
```

### Billing (5 routes — Phase C of the commercial-launch plan, see

vault_commercial_launch_plan.md §5/§7. NOT YET LIVE — STRIPE_SECRET_KEY /
STRIPE_WEBHOOK_SECRET are unset, no real Stripe account exists.)

```
GET  /api/billing/packages              — Credit-pack + subscription-tier prices (no auth-specific data, just echoes constants.ts)
POST /api/billing/checkout/credits      — Body: { packId: "small"|"medium"|"large" } → { url } Stripe Checkout (mode: payment, one-time credit top-up)
POST /api/billing/checkout/subscription — Body: { tier: "pro"|"team" } → { url } Stripe Checkout (mode: subscription, tier upgrade)
GET  /api/billing/portal                — → { url } Stripe Billing Portal session (manage/cancel subscription, view invoices)
POST /api/billing/webhook               — Stripe-signed, unauthenticated (like /api/chat/webhook): checkout.session.completed credits the ledger or activates a subscription; customer.subscription.updated/deleted downgrade tier back to free
```

### WebSocket (1 route)

```
GET /ws/lattice/:projectId — Real-time lattice updates (WebSocket upgrade)
  Auth: required (session cookie)
  Messages: { type: "node_added", node: {...} } | { type: "edge_added", edge: {...} }
  Pipeline integration: LatticeManager DO broadcasts when pipeline agents enrich the lattice
```

## Error Format (all routes)

```json
{
  "error": "Human-readable error message",
  "details": "Optional technical details"
}
```

## Rate Limit Headers (all routes)

```
X-Rate-Limit-Remaining: 47
X-Credits-Remaining: 9847
X-Pipeline-Step: 4          (when inside a pipeline request)
X-Agent-Model: command-r7b   (when inside a pipeline request)
```

## Auth Middleware

All routes except `/api/auth/*` and `/api/health` require:

1. Valid Better Auth session cookie OR
2. `Authorization: Bearer {virtual_key}` header

## Pipeline Model Selection (server-side only)

```typescript
function selectModel(step: PipelineStep, complexity: string): string {
  switch (step) {
    case 'architect':
      return 'command-a-03-2025'; // Always Command A (needs reasoning)
    case 'researcher':
      return 'command-r7b-12-2024'; // Always R7B (fast, cheap)
    case 'designer':
      return 'command-a-03-2025'; // Always Command A (needs reasoning)
    case 'coder':
      if (complexity === 'simple') return 'cohere/north-mini-code:free'; // Free via OpenRouter
      if (complexity === 'moderate') return 'command-r7b-12-2024'; // $0.0375/1M
      return 'command-a-03-2025'; // $2.50/1M (complex)
    default:
      return 'command-r7b-12-2024';
  }
}
```
