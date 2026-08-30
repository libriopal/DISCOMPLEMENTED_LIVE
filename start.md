# start.md — Master Execution Specification

## Purpose

This document is the master leading execution prompt for any downstream implementation agent or engineer. It provides the prerequisites, environment setup, and execution order for building Bicameral.

**Primary entry point:** Read `CLAUDE.md` first — it tells you what to build and where to find specs. Then follow `@agent_docs/implementation-phases.md` for the phased implementation plan.

---

## Prerequisites

Before starting implementation, the implementing agent MUST:

1. Read and understand the bootstrap files:
   - `CLAUDE.md` — Project instructions, tech stack, architecture decisions
   - `agent_docs/architecture.md` — Full system architecture (4-agent pipeline + infrastructure)
   - `agent_docs/autonomous-dev-team.md` — The 4-agent "CTO-in-a-Box" pipeline spec
   - `agent_docs/implementation-phases.md` — Phased plan (9 phases, one per Claude Code session)
   - `agent_docs/api-spec.md` — All 51 API routes including 5 pipeline routes
   - `agent_docs/database-schema.md` — D1 schema (11 tables: 7 core + 3 pipeline + 1 admin)
   - `agent_docs/cohere-integration.md` — Cohere proxy, model routing, credit costs per pipeline step
   - `agent_docs/preview-tiers.md` — Three-tier preview system (used by Coder agent)
   - `agent_docs/admin-panel.md` — Admin panel design (pipeline monitoring + R9-R12 rules)
   - `agent_docs/live-chat.md` — FluxyChat + Cohere (pipeline-aware support)
   - `agent_docs/security.md` — Security model with pipeline-specific defenses

2. Set up the development environment:
   - [ ] Node.js 22+ installed
   - [ ] pnpm installed (`npm install -g pnpm`)
   - [ ] Cloudflare account with Workers paid plan ($5/mo)
   - [ ] Wrangler CLI installed and authenticated (`npx wrangler login`)
   - [ ] Cohere account with Production API key (commercial use — NOT trial key)
   - [ ] OpenRouter account with API key (for free North Mini Code)
   - [ ] GitHub OAuth app created (dual prod/dev for Better Auth)

3. Create Cloudflare resources before first deploy:
   - [ ] D1 database: `wrangler d1 create bicameral`
   - [ ] Vectorize index: `wrangler vectorize create bicameral-lattice --dimensions 1536 --metric cosine`
   - [ ] KV namespace: `wrangler kv namespace create CONFIG_KV`
   - [ ] Analytics Engine: enabled automatically on Workers paid plan
   - [ ] Container class: registered in wrangler.toml

4. Set Cloudflare secrets:
   ```bash
   wrangler secret put COHERE_API_KEY        # Production key (paid)
   wrangler secret put OPENROUTER_API_KEY    # For free North Mini Code
   wrangler secret put BETTER_AUTH_SECRET    # Session encryption secret
   wrangler secret put GITHUB_OAUTH_CLIENT_ID
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   wrangler secret put FLUXYCHAT_API_KEY     # For live chat (Phase 8)
   ```

---

## Architecture Summary

Bicameral is a prompt-to-app platform built on Cloudflare Workers + Cohere AI. The core differentiator is a **4-agent autonomous pipeline** that acts as a "CTO-in-a-Box" for non-technical founders:

```
Founder Vision → Step 1: Architect (Command A) → structured project brief
  → Step 2: Researcher (R7B + Rerank) → validated tech stack + patterns + risks
  → Step 3: Designer (Command A) → system blueprint (components, schema, API)
  → [HUMAN GATE: Founder reviews and approves blueprint]
  → Step 4: Coder (North Mini Code → R7B → A) → deployed app with error feedback loop
```

Each agent has its own context window, model, and tools. The GenerationOrchestrator Durable Object coordinates them, stores state in D1 (pipeline_runs + pipeline_steps + blueprints), and broadcasts progress via SSE. The Coder agent uses a three-tier preview system (Babel → esbuild-wasm → Cloudflare Sandboxes) as its sandbox for the error feedback loop (write → run → errors → fix → repeat, max 5 iterations).

### Tech Stack (Frozen)

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers (Hono v4.6) |
| Database | Cloudflare D1 (SQLite at edge) — 11 tables |
| Vector Store | Cloudflare Vectorize (1536 dims, cosine) |
| Durable Objects | GenerationOrchestrator, LatticeManager, Sandbox |
| Auth | Better Auth + GitHub OAuth (dual prod/dev) |
| AI | Cohere API v2 (direct fetch) + OpenRouter (free North Mini Code) |
| Frontend | React 19, Three.js, Zustand, TanStack Query |
| Preview | Babel (instant) → esbuild-wasm (~1-2s) → CF Sandboxes (full-stack) |
| Live Chat | FluxyChat (MIT, native CF Workers) |
| Build | pnpm workspaces monorepo |
| Deploy | wrangler deploy (Workers Static Assets for MVP) |

### Model Routing (Free-First)

| Agent | Model | Cost |
|-------|-------|------|
| Architect (Step 1) | Command A | ~$0.018/run |
| Researcher (Step 2) | Command R7B + Rerank | ~$0.012/run |
| Designer (Step 3) | Command A | ~$0.043/run |
| Coder (Step 4, simple) | North Mini Code (free) | $0 |
| Coder (Step 4, moderate) | Command R7B | ~$0.006 |
| Coder (Step 4, complex) | Command A x 5 iterations | ~$0.175 |
| **Total per pipeline (best case)** | | **~$0.073** |
| **Total per pipeline (complex)** | | **~$0.248** |

---

## Wrangler Configuration

```toml
name = "bicameral"
main = "src/server/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

# Static assets (generated frontend)
[assets]
directory = "./dist/client"
binding = "ASSETS"
not_found_handling = "single-page-application"

# D1 Database — 11 tables (7 core + 3 pipeline + 1 admin)
[[d1_databases]]
binding = "DB"
database_name = "bicameral"
database_id = "YOUR_D1_DATABASE_ID"

# Vectorize — Memory Lattice embeddings
[[vectorize]]
binding = "LATTICE_INDEX"
index_name = "bicameral-lattice"
dimensions = 1536
metric = "cosine"

# KV — Kill switch + maintenance mode + config flags
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "YOUR_KV_NAMESPACE_ID"

# Analytics Engine — Telemetry for admin panel
[analytics_engine_datasets]
binding = "ANALYTICS_ENGINE"
dataset = "bicameral_metrics"

# Durable Objects — Pipeline orchestration + lattice + preview sandboxes
[durable_objects]
bindings = [
  { name = "GENERATION_DO", class_name = "GenerationOrchestrator" },
  { name = "LATTICE_DO", class_name = "LatticeManager" },
  { name = "PREVIEW_SANDBOX", class_name = "Sandbox" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GenerationOrchestrator", "LatticeManager"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["Sandbox"]

# Container — For Tier 3 preview sandboxes (Coder agent)
[[containers]]
class_name = "Sandbox"
image = "./Dockerfile.preview"
instance_type = "lite"
max_instances = 10

# Non-secret env vars
[vars]
COHERE_BASE_URL = "https://api.cohere.com/v2"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
APP_URL = "https://discomplemented.com"
ENVIRONMENT = "production"

# ============ STAGING ============
[env.staging]
name = "bicameral-staging"

[env.staging.vars]
APP_URL = "https://bicameral-staging.workers.dev"
ENVIRONMENT = "development"
```

---

## Implementation Order

Follow `@agent_docs/implementation-phases.md` — implement one phase per Claude Code session to conserve credits. Each phase is self-contained and verifiable.

### Phase Dependency Graph

```
Phase 1 (Shared types: ProjectBrief, ResearchFindings, SystemBlueprint)
   ↓
Phase 2 (D1: 11 tables including pipeline_runs, pipeline_steps, blueprints)
   ↓
Phase 3 (API: 51 routes including 5 /api/pipeline routes + selectModel())
   ↓
Phase 4 (DO: GenerationOrchestrator state machine + Architect + Researcher agents)
   ↓
Phase 5 (UI: 6 views + 4-step pipeline progress + blueprint gate + usePipeline hook)
   ↓ ↓ (parallel)
Phase 5b (Agents: Designer + Coder + tools + gates)    Phase 6 (Preview: error feedback loop)
   ↓                                                      ↓
   ←─────────────────────────────────────────────────────←
   ↓
Phase 7 (Admin: pipeline monitoring + R9-R12 recommendations)
   ↓
Phase 8 (Chat: pipeline-aware FluxyChat support agent)
   ↓
Phase 9 (CI/CD: pipeline smoke test)
```

### Quick Reference: Phase → What It Builds

| Phase | What It Creates | Pipeline Connection |
|-------|----------------|---------------------|
| 1 | Monorepo scaffold + shared types | Types used by all 4 agents for inter-agent communication |
| 2 | D1 schema + auth + virtual keys | 3 pipeline tables track agent state + blueprint |
| 3 | 51 API routes + Cohere proxy | 5 pipeline routes + selectModel(step, complexity) |
| 4 | GenerationOrchestrator DO + Architect + Researcher | The DO IS the pipeline state machine |
| 5 | 6 React views + pipeline UI + hooks | Visualizes the 4-step pipeline + blueprint approval gate |
| 5b | Designer + Coder agents + tools + gates | Completes all 4 agents + error feedback loop |
| 6 | 3-tier preview system | The Coder agent's sandbox (write → run → errors → fix) |
| 7 | Admin panel with pipeline monitoring | Monitors active pipelines + R9-R12 recommendation rules |
| 8 | FluxyChat live chat | AI agent can tell founders which step their build is on |
| 9 | CI/CD + public release | Pipeline smoke test in CI |

---

## Verification (run after every phase)

```bash
pnpm install                           # Install workspace dependencies
pnpm --filter @bicameral/web typecheck  # TypeScript strict mode check
pnpm --filter @bicameral/web build      # Production build must succeed
```

---

## Deployment

### First Deploy

```bash
# 1. Create Cloudflare resources
wrangler d1 create bicameral
wrangler vectorize create bicameral-lattice --dimensions 1536 --metric cosine
wrangler kv namespace create CONFIG_KV

# 2. Update wrangler.toml with resource IDs from above

# 3. Set secrets
wrangler secret put COHERE_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET

# 4. Run D1 migrations
wrangler d1 execute bicameral --file=migrations/001_init.sql

# 5. Deploy
wrangler deploy
```

### Post-Deploy Smoke Test

1. Visit the app URL — login screen should appear
2. Sign in with GitHub OAuth
3. Enter a prompt: "Build a dog park finder app"
4. Watch the 4-step pipeline progress:
   - Step 1 (Architect): Should produce a project brief within ~10s
   - Step 2 (Researcher): Should validate tech stack within ~5s
   - Step 3 (Designer): Should produce a blueprint within ~15s
   - Blueprint gate: Should show approval card
   - Approve blueprint
   - Step 4 (Coder): Should generate code with preview within ~60s
5. Verify preview renders (Tier 1 Babel at minimum)
6. Check admin panel at `/admin` (if admin_level set)
7. Check Memory Lattice view for nodes

---

## Execution Rules

1. **Follow CLAUDE.md** — it is the source of truth for project structure and conventions
2. **One phase per session** — start fresh with `claude` for each phase
3. **Reference specific docs** — say "Implement Phase 3, see @agent_docs/api-spec.md"
4. **Don't reinterpret the architecture** — the decisions are locked (D1-D12 in CLAUDE.md)
5. **Verify between phases** — run typecheck and build to catch issues early
6. **Never commit secrets** — use `wrangler secret put` for all API keys
7. **Pipeline-first** — Phases 4 + 5b are the core differentiator; prioritize them
8. **The 4-agent pipeline is the product** — every phase connects to it

---

## Success Criteria

- [ ] User can sign in with GitHub OAuth
- [ ] User can submit a prompt and the 4-agent pipeline executes
- [ ] Step 1 (Architect) produces a valid project brief
- [ ] Step 2 (Researcher) produces validated tech stack findings
- [ ] Step 3 (Designer) produces a system blueprint
- [ ] Blueprint approval gate works (founder can approve/reject)
- [ ] Step 4 (Coder) generates code and renders a preview
- [ ] Error feedback loop iterates (up to 5x) on failed previews
- [ ] Three-tier preview system works (Babel → esbuild → sandbox fallback)
- [ ] Memory Lattice renders with pipeline-enriched nodes
- [ ] Admin panel shows pipeline monitoring + recommendations
- [ ] Live chat agent can answer "where is my build?"
- [ ] Credits are tracked per pipeline step in the credit ledger
- [ ] CI includes pipeline smoke test
- [ ] Production deployment successful with smoke tests passing

---

## Final Implementation Report

After completion, produce:
1. Summary of what was built (with pipeline as the centerpiece)
2. List of any deviations from the locked architecture decisions (D1-D12)
3. Test results (typecheck + build + pipeline smoke test)
4. Production URL
5. Known issues and limitations
6. Recommendations for v1.1
