# Architecture Spec — Bicameral

> Referenced by CLAUDE.md via `@agent_docs/architecture.md`. Read this before implementing any phase.

## System Overview

Bicameral is a multi-tenant prompt-to-app platform that acts as an autonomous dev team for non-technical founders. The core is a 4-agent "CTO-in-a-Box" pipeline: a founder describes their vision, and four specialized AI agents (Architect → Researcher → Designer → Coder) take it from idea to deployed app through a gated, error-correcting workflow. The platform includes subscription tiers with credit-based usage, a Memory Lattice visualization, a three-tier preview system, an admin control panel, and live customer support chat powered by FluxyChat.

## Infrastructure

| Component | Technology | Binding Name |
|-----------|-----------|--------------|
| Compute | Cloudflare Workers (Hono v4.6) | — |
| Database | Cloudflare D1 (SQLite at edge) | `DB` |
| Vector Store | Cloudflare Vectorize (1536 dims) | `LATTICE_INDEX` |
| Pipeline Orchestration | Durable Object | `GENERATION_DO` |
| Lattice State | Durable Object | `LATTICE_DO` |
| Sandbox Management | Durable Object | `PREVIEW_SANDBOX` |
| Live Chat | Durable Object (FluxyChat) | `CHAT_DO` |
| Static Assets | Workers Static Assets | `ASSETS` |
| Kill Switch / Config | Cloudflare KV | `CONFIG_KV` |
| Telemetry | Workers Analytics Engine | `ANALYTICS_ENGINE` |

## The 4-Agent Pipeline (Core Architecture)

```
Founder Vision ("I want a dog park finder app")
     ↓
┌─────────────────────────────────────────────────────┐
│  STEP 1: PROMPT COMPANION (Ideation)                 │
│  Agent: Architect (Command A)                        │
│  Input: Natural language description                  │
│  Output: Structured project brief (JSON)              │
│  Tools: Cohere Structured Outputs, template matching  │
│  DB: pipeline_runs.brief, pipeline_steps[1]           │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  STEP 2: RESEARCH DISCOVERED (Validation)            │
│  Agent: Researcher (Command R7B + Rerank)           │
│  Input: Project brief from Step 1                    │
│  Output: Validated tech stack, patterns, risks       │
│  Tools: CERL research loop, web search, Embed v4     │
│  DB: pipeline_runs.research, pipeline_steps[2]       │
│  Lattice: Research findings embedded as semantic nodes│
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  STEP 3: DESIGN COHERENT (Blueprinting)               │
│  Agent: Designer (Command A)                          │
│  Input: Project brief + research findings             │
│  Output: System blueprint (components, schema, API)   │
│  Tools: Cohere Structured Outputs, template registry   │
│  DB: blueprints row, pipeline_runs.blueprint_id       │
│  Lattice: Blueprint patterns embedded as impl nodes   │
└──────────────────────┬──────────────────────────────┘
                       ↓
              ╔═══════════════════════╗
              ║  HUMAN GATE: Review   ║
              ║  Founder reviews the  ║
              ║  blueprint and either ║
              ║  approves or rejects  ║
              ║  with feedback        ║
              ╚════════┬══════════════╝
                       ↓ (approved)
┌─────────────────────────────────────────────────────┐
│  STEP 4: ARCHITECTURE IMPLEMENTED (Execution)         │
│  Agent: Coder (North Mini Code → R7B → Command A)    │
│  Input: System blueprint from Step 3                  │
│  Output: Deployed app + live preview URL              │
│  Tools: 3-tier preview, error feedback loop (5x max)  │
│  DB: generations row, pipeline_runs.deployment_url    │
│  Lattice: Error/fix patterns embedded as bridge nodes  │
└─────────────────────────────────────────────────────┘
```

### Orchestration (GenerationOrchestrator DO)

The GenerationOrchestrator Durable Object is the "team lead" that coordinates all 4 agents:

- **State machine:** `idle → ideating → researching → designing → [awaiting_approval] → implementing → deployed → error`
- **SSE broadcasting:** Real-time events to frontend (`step:start`, `step:progress`, `step:complete`, `gate:awaiting_approval`, `iteration:complete`, `pipeline:complete`)
- **Error feedback loop:** In Step 4, the Coder writes code → runs preview → collects errors → fixes → repeats (max 5 iterations)
- **Lattice enrichment:** After each step, agent output is embedded into Vectorize and linked to the Memory Lattice
- **Credit tracking:** All token costs per step are logged to `credit_ledger` with `pipeline_run_id`

### Model Routing Per Agent

```typescript
function selectModel(step: PipelineStep, complexity: string): string {
  switch (step) {
    case 'architect':   return 'command-a-03-2025';      // Always Command A (needs reasoning)
    case 'researcher':  return 'command-r7b-12-2024';     // Always R7B (fast, cheap)
    case 'designer':    return 'command-a-03-2025';      // Always Command A (needs reasoning)
    case 'coder':       // Free-first with escalation
      if (complexity === 'simple')    return 'cohere/north-mini-code:free';
      if (complexity === 'moderate')  return 'command-r7b-12-2024';
      return 'command-a-03-2025';
  }
}
```

**Critical:** Trial keys are free but CANNOT be used for commercial purposes. Bicameral uses Production keys (paid) + OpenRouter (free North Mini Code).

## Request Flow

```
User → Cloudflare Worker (Hono) → Auth Middleware (Better Auth)
  → Virtual Key Check (D1 lookup + rate limit + credit check)
  → Route Handler
    → /api/pipeline → GenerationOrchestrator DO → 4-agent pipeline
    → /api/generate → Direct Cohere call (legacy single-agent)
    → /api/research → Cohere Rerank + web search
    → /api/preview → Preview tier (Babel → esbuild → Sandbox)
    → /api/lattice → Vectorize + D1
  → Response (JSON or SSE stream or WebSocket upgrade)
```

## Authentication

- Better Auth with GitHub OAuth (dual prod/dev OAuth apps)
- Session-based auth (cookies, not JWT)
- Admin role check for /api/admin/* routes
- Virtual Key system for API access (UUID-based, mapped to users in D1)

## Virtual Key Proxy

```
User creates account → D1 generates UUID virtual key
  → Key mapped to user_id + tier (free/pro/team/enterprise)
  → Rate limits: Free (100 req/hr), Pro (1000 req/hr), Team (5000 req/hr)
  → Credit ledger: Free (1000 credits/mo), Pro (10000), Team (50000)
  → Auto trial: 30-day trial key on signup, expires automatically
  → Pipeline costs: 50-200 credits per full pipeline (model-dependent)
```

## D1 Schema (11 tables)

See `@agent_docs/database-schema.md` for full SQL. Key pipeline tables:
- **pipeline_runs:** Top-level pipeline state, links all 4 steps, stores brief/research/blueprint_id/deployment_url
- **pipeline_steps:** Per-agent execution records with model, tokens, duration, iteration count
- **blueprints:** Agent 3 output (components, schema, routes, deploy config) stored for founder review + Coder input


## Design Reference (Non-Destructive)

The `design/` directory contains 7 high-fidelity HTML design specs that serve as the canonical visual reference for Bicameral's UI. These files are reference-only — do not modify them.

> **🎨 Files:**
> - `design/01-ia-screen-inventory.html` — 62 screens catalogued, 24 MVP identified
> - `design/02-user-flows.html` — User journeys (onboarding, pipeline, blueprint review, deployment)
> - `design/03-design-system-tokens.html` — Color palette (Indigo/Violet/Pink), typography (Inter/Space Grotesk/Fira Code), spacing, shadows, animations
> - `design/04-component-library.html` — Component specs (buttons, cards, modals, tables, editors, lattice controls, chat, pipeline progress)
> - `design/05-memory-lattice-interaction.html` — 3D interaction model (camera, selection, hemispheres, bridges, animations)
> - `design/06-hifi-responsive-layouts.html` — Responsive breakpoints, layout grids, sidebar collapse, lattice viewport sizing
> - `design/07-astroapp-concept.html` — Theme system: Scorpio Dark (#0A070A) / Libra Light (#FAFAF9)

**Phase 5** reads these to build `tokens.css`, component library, and LatticeView.
**Designer agent (Step 3)** reads these for pattern matching when creating the blueprint.
**Coder agent (Step 4)** references component specs when generating React components.
See `design/README.md` for the full usage guide.

## Memory Lattice + Pipeline Integration

The Memory Lattice is enriched by the pipeline at every step:
- **Step 2 (Research):** Findings → semantic nodes (technologies, patterns, risks)
- **Step 3 (Design):** Blueprint → implementation nodes (component patterns, schema patterns)
- **Step 4 (Implementation):** Errors and fixes → bridge nodes (debugging patterns, common pitfalls)

Over time, the lattice becomes a knowledge base that makes future generations faster. A founder building a "marketplace app" benefits from every previous marketplace app the system has helped build.

## Three-Tier Preview + Pipeline Integration

The preview system is the Coder agent's sandbox:
- **Tier 1 (Babel):** Instant, free, single-file — used for simple Coder iterations
- **Tier 2 (esbuild-wasm):** ~1-2s, multi-file — used for moderate Coder iterations
- **Tier 3 (CF Sandboxes):** ~5-10s, full-stack — used for complex Coder iterations with backend code

The Coder agent calls `run_preview` → preview strategy selects tier → code renders → errors collected → fed back to Coder. See `@agent_docs/preview-tiers.md`.

## Security Model

See `@agent_docs/security.md` for full details. Pipeline-specific security:
- Each agent has server-side model routing — users cannot override which model is used
- Blueprint approval gate prevents deploying unwanted architectures
- Pipeline credit costs are tracked per-step in credit_ledger
- Admin can cancel any pipeline run (-write+) or kill all pipelines (-full only)

### Rate Limiting (per virtual key)
- Tracked in D1 with sliding window
- Free: 100 req/hr, Pro: 1000 req/hr, Team: 5000 req/hr
- 429 response with Retry-After header when exceeded

### Credit Caps (per tier, monthly)
- Free: 1,000 credits, 10 research queries, ~2 pipeline runs
- Pro: 10,000 credits, 50 research queries, ~20 pipeline runs
- Team: 50,000 credits, 200 research queries, ~100 pipeline runs
- Enterprise: unlimited (custom)

### Admin Panel Permission Tiers
- **-read:** View-only metrics, security events, pipeline status, recommendations. All buttons greyed out.
- **-write:** All -read PLUS: ban users, maintenance mode, kill sandbox/pipeline sessions, manage virtual keys.
- **-full:** All -write PLUS: emergency shutdown (kills all pipelines), config changes, data export, delete projects.

### Emergency Kill Switch
- Stored in Cloudflare KV as `EMERGENCY_SHUTDOWN = true/false`
- Hono middleware checks KV on every request (sub-10ms read)
- When true: all non-admin routes return 503, all active pipelines are cancelled
- Admin routes remain accessible for recovery

## Live Chat Architecture (FluxyChat)

### FluxyChat (native Cloudflare Workers)
- Open source (MIT), runs on Cloudflare Workers + D1 + Durable Objects
- Zero additional infrastructure cost (uses existing Workers stack)
- WebSocket rooms with presence, SSE fallback
- Embeddable React widget via `@fluxy-chat/react` hooks
- AI agent support with custom LLM provider (Cohere)
- Built-in HITL (Human-in-the-Loop) escalation system
- **Pipeline-aware:** AI agent can query pipeline state to answer "where is my build?" questions

### AI Customer Service Flow
```
Customer message → FluxyChat WebSocket room (Durable Object)
  → FluxyChat AI agent invokes Cohere API (Command R7B, custom provider)
  → AI checks pipeline_runs table for user's active pipelines
  → If pipeline is running: "Your build is on Step 2 of 4 — Research agent is analyzing tech stacks."
  → If pipeline is stuck at gate: "Please review your blueprint to continue building."
  → If confidence high: auto-reply in room
  → If confidence low OR user types "human"/"agent":
      → HITL approval triggered
      → Message routed to human agent queue with pipeline step history attached
      → Human takes over the conversation
```

## Deployment

### Development
```bash
wrangler dev  # Local Workers + D1 dev
vite dev      # Frontend HMR
```

### Production
```bash
wrangler deploy  # Deploy Worker + DOs + Container
vite build       # Build static assets
```

### Public Release Sanitization
```bash
git filter-repo --path packages/admin --invert-submodules
# Removes admin package history for public release
# admin-stub remains as the public-facing fallback
```
