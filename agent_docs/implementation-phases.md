# Implementation Phases — Bicameral

> **Credit optimization for Claude Code Pro plan:** Each phase is designed to be completed in a single Claude Code session (~30-45 min of credits). Start a new session for each phase by running `claude` and saying "Implement Phase N — see @agent_docs/implementation-phases.md". Run verification between phases.

---

## Phase 1: Monorepo Scaffold + Shared Package
**Estimated credits:** 1 session (~15-20 min)
**Files to create:** ~8

### Tasks:
1. Create root `package.json` with pnpm workspaces config
2. Create `pnpm-workspace.yaml` pointing to `packages/*` and `apps/*`
3. Create `packages/shared/src/index.ts` — shared types, Zod schemas, error handling
   - Include pipeline types: `ProjectBrief`, `ResearchFindings`, `SystemBlueprint`, `PipelineState`, `AgentRole`
4. Create `packages/cohere/src/index.ts` — Cohere API wrapper (direct fetch to v2 endpoints)
   - Include OpenRouter client for North Mini Code (free tier)
5. Create `packages/admin/src/index.ts` — admin types (export-ignore in .gitattributes)
6. Create `packages/admin-stub/src/index.ts` — public fallback
7. Create `apps/web/package.json` with all dependencies
8. Create `apps/web/tsconfig.json` with path aliases

### Pipeline dependency:
Phase 1 creates the shared types that ALL 4 agents use for inter-agent communication. `ProjectBrief`, `ResearchFindings`, `SystemBlueprint` are the structured outputs passed between agents.

### Verification:
```bash
pnpm install && pnpm --filter @bicameral/shared build && pnpm --filter @bicameral/cohere build
```

---

## Phase 2: Auth + D1 Schema + Virtual Key Proxy
**Estimated credits:** 1 session (~25-35 min)
**Files to create:** ~6

### Tasks:
1. Create `apps/web/src/lib/auth.ts` — Better Auth config with GitHub OAuth (dual prod/dev)
2. Create `apps/web/src/lib/auth-client.ts` — Frontend auth client
3. Create `apps/web/src/routes/auth.ts` — Auth routes (mount Better Auth)
4. Create `apps/web/src/hooks/useAuth.ts` — React auth hook
5. Create D1 migration with ALL tables:
   - **7 core tables:** users, projects, generations, lattice_nodes, lattice_edges, research_queries, credit_ledger
   - **3 pipeline tables:** pipeline_runs, pipeline_steps, blueprints (see `@agent_docs/database-schema.md`)
   - **1 admin table:** security_events
6. Create Virtual Key Proxy: UUID key generation, D1 mapping, tier-based rate limits, credit tracking, auto trial expiration (30 days)

### Pipeline dependency:
Phase 2 creates the `pipeline_runs` and `pipeline_steps` tables that track the 4-agent pipeline state. Each agent's output is stored as a pipeline step record. The `blueprints` table stores the output of Agent 3 (Designer) for founder review and Coder input.

### Verification:
```bash
pnpm --filter @bicameral/web typecheck
```

---

## Phase 3: Core API Routes (28 routes + 5 pipeline routes = 33 total)
**Estimated credits:** 1 session (~35-45 min)
**Files to create:** ~8

### Tasks:
1. `apps/web/src/routes/generate.ts` — 4 routes: POST /generate (SSE streaming), POST /generate/project, GET /generate/:id, POST /generate/:id/cancel
2. `apps/web/src/routes/pipeline.ts` — 5 NEW routes for the 4-agent pipeline:
   - `POST /api/pipeline` — Start a new pipeline run (body: `{ prompt, projectId? }`)
   - `GET /api/pipeline/:id` — Get pipeline status (SSE stream of step events)
   - `POST /api/pipeline/:id/approve` — Approve blueprint gate (body: `{ approved, feedback? }`)
   - `POST /api/pipeline/:id/cancel` — Cancel running pipeline
   - `GET /api/pipeline/:id/blueprint` — Get the current blueprint for review
3. `apps/web/src/routes/research.ts` — 3 routes: POST /research, GET /research/:id, GET /research/history
4. `apps/web/src/routes/projects.ts` — 7 routes: full CRUD + list
5. `apps/web/src/routes/lattice.ts` — 5 routes: nodes CRUD + edges
6. `apps/web/src/routes/usage.ts` — 3 routes: GET /usage, GET /usage/credits, GET /usage/breakdown
7. `apps/web/src/lib/cohere.ts` — Cohere proxy with free-first routing (North Mini Code → R7B → Command A)
   - Include `callOpenRouter()` function for North Mini Code (free tier)
   - Include `callCohere()` function for R7B and Command A (Production keys)
   - Export model selector: `selectModel(step, complexity)` — maps pipeline step to optimal model
8. `apps/web/src/index.ts` — Mount all routes (including pipeline), configure CORS, logger, error handler

### Pipeline dependency:
Phase 3 creates the `/api/pipeline` routes that the frontend will call to start and monitor the 4-agent pipeline. The `cohere.ts` proxy now needs a `selectModel(step, complexity)` function that routes each agent to the right model:
- Agent 1 (Architect): always Command A (needs reasoning)
- Agent 2 (Researcher): always R7B (fast, cheap)
- Agent 3 (Designer): always Command A (needs reasoning)
- Agent 4 (Coder): free-first (North Mini Code → R7B → A, escalate on errors)

### Verification:
```bash
pnpm --filter @bicameral/web typecheck && pnpm --filter @bicameral/web build
```

---

## Phase 4: Durable Objects + Pipeline Orchestrator
**Estimated credits:** 1 session (~25-35 min)
**Files to create:** ~4

### Tasks:
1. `apps/web/src/durable-objects/GenerationOrchestrator.ts` — The pipeline state machine
   - State: `idle → ideating → researching → designing → [awaiting_approval] → implementing → deployed → error`
   - Methods: `runPipeline()`, `runArchitect()`, `runResearcher()`, `runDesigner()`, `runCoder()`, `waitForApproval()`
   - Broadcasts: `step:start`, `step:progress`, `step:complete`, `gate:awaiting_approval`, `iteration:complete`, `pipeline:complete`
   - Error feedback loop: `runCoder()` iterates up to 5 times (write → preview → errors → fix)
   - Memory Lattice enrichment: after each step, embed findings via `enrichLattice()`
2. `apps/web/src/durable-objects/LatticeManager.ts` — Lattice node/edge state, WebSocket connections for real-time updates
   - Method: `ingestAgentOutput(step, output)` — embeds agent output as lattice nodes
   - Method: `findSimilar(type, query)` — returns similar past patterns for agent context
3. `apps/web/src/pipeline/agents/architect.ts` — Agent 1: Prompt Companion
   - System prompt + tool definition for `generate_project_brief`
   - Uses Cohere Structured Outputs for JSON compliance
4. `apps/web/src/pipeline/agents/researcher.ts` — Agent 2: Research Discovered
   - System prompt + tool definition for `submit_research`
   - Uses R7B + Rerank + web search + Embed v4

### Pipeline dependency:
This IS the pipeline implementation phase. The GenerationOrchestrator DO becomes the "team lead" that coordinates all 4 agents. It stores the pipeline state in the `pipeline_runs` table and each agent's output in `pipeline_steps`. The `waitForApproval()` method implements the human gate between Step 3 (Design) and Step 4 (Implementation).

### Verification:
```bash
pnpm --filter @bicameral/web typecheck
```

---


> **🎨 Design Reference Files:** Before building any UI in Phase 5, read the design specs in `design/`:
> - `design/03-design-system-tokens.html` — Extract CSS custom properties → `apps/web/src/styles/tokens.css`. Colors: Indigo (semantic) / Violet (implementation) / Pink (bridge). Typography: Inter (body), Space Grotesk (headings), Fira Code (monospace). Also includes spacing scale, border radius, shadows, animation timing.
> - `design/01-ia-screen-inventory.html` — 62 total screens catalogued, 24 MVP screens identified. Build only the 24 MVP screens in Phase 5.
> - `design/04-component-library.html` — Component specs for buttons, inputs, cards, modals, navigation, data tables, code editors, lattice controls, chat widgets, and pipeline progress indicators. Match these specs exactly.
> - `design/06-hifi-responsive-layouts.html` — Responsive breakpoints, layout grids, sidebar collapse behavior, lattice viewport sizing.
> - `design/07-astroapp-concept.html` — Overall look-and-feel reference. Implements Scorpio Dark theme (#0A070A base) and Libra Light theme (#FAFAF9 base).
> - `design/02-user-flows.html` — Navigation logic for onboarding, project creation, pipeline execution, blueprint review, and deployment flows.
> - `design/05-memory-lattice-interaction.html` — 3D interaction model for LatticeView: camera controls, node selection, hemisphere labels, bridge connections, real-time animations.
> - See `design/README.md` for the full file index and usage guide.
> These files are reference-only (non-destructive). Do not modify them — read and implement.

## Phase 5: Frontend Shell (6 Views + Pipeline UI)
**Estimated credits:** 2 sessions (~35-45 min each)
**Files to create:** ~17

### Session A (Views + Components):
1. `apps/web/src/main.tsx` — React 19 entry point
2. `apps/web/src/App.tsx` — Root component with routing + auth gate
3. `apps/web/src/components/Sidebar.tsx` — Navigation sidebar
4. `apps/web/src/components/LoginScreen.tsx` — GitHub OAuth login
5. `apps/web/src/styles/tokens.css` — Design tokens (Indigo/Violet/Pink spectrum)
6. `apps/web/src/views/GenerationView.tsx` — Prompt-to-app interface with SSE streaming
   - **Pipeline UI:** 4-step progress indicator (Prompt Companion → Research → Design → Implementation)
   - **Blueprint gate:** When Step 3 completes, show blueprint review card with approve/reject buttons
   - **Error iteration indicator:** During Step 4, show "Iteration 2/5 — fixing errors..."
   - **Step details:** Expandable cards showing each agent's output (brief, research, blueprint, code)
7. `apps/web/src/views/ProjectsView.tsx` — Project list + management
8. `apps/web/src/views/LatticeView.tsx` — Memory Lattice canvas (Three.js stub)

### Session B (Remaining views + hooks):
9. `apps/web/src/views/TokensView.tsx` — API token management
10. `apps/web/src/views/UsageView.tsx` — Usage stats + credit balance
11. `apps/web/src/views/ResponsiveView.tsx` — Breakpoint preview
12. `apps/web/src/hooks/useGenerationStream.ts` — SSE streaming hook (for pipeline events)
   - Listens for: `step:start`, `step:progress`, `step:complete`, `gate:awaiting_approval`, `iteration:complete`, `pipeline:complete`
13. `apps/web/src/hooks/usePipeline.ts` — NEW: Pipeline lifecycle hook
   - `startPipeline(prompt)` → calls POST /api/pipeline
   - `approveBlueprint(feedback?)` → calls POST /api/pipeline/:id/approve
   - `cancelPipeline()` → calls POST /api/pipeline/:id/cancel
   - `pipelineState` → reactive state object with current step, progress, agent outputs
14. `apps/web/index.html` — HTML entry
15. `apps/web/vite.config.ts` — Vite config with worker support
16. `apps/web/wrangler.toml` — Cloudflare config

### Pipeline dependency:
Phase 5 builds the UI that visualizes the 4-agent pipeline. The `usePipeline` hook manages the full lifecycle: start → monitor steps → approval gate → implementation iterations → deployed. The `useGenerationStream` hook handles SSE events from the pipeline, not just raw code streaming.

### Verification:
```bash
pnpm --filter @bicameral/web build
```

---

## Phase 5b: Complete Pipeline Agents + Tools
**Estimated credits:** 2 sessions (~30-40 min each)
**Files to create:** ~8

### Session A (Designer + Coder agents + pipeline tools):
1. `apps/web/src/pipeline/agents/designer.ts` — Agent 3: Design Coherent
   - System prompt + tool definition for `generate_blueprint`
   - Uses Cohere Structured Outputs for blueprint JSON
   - Input: project brief + research findings
   - Output: component tree, DB schema, API routes, auth strategy, deploy config
2. `apps/web/src/pipeline/agents/coder.ts` — Agent 4: Architecture Implemented
   - System prompt + tool definitions for file operations
   - Uses free-first model routing (North Mini Code → R7B → A)
   - Error feedback loop: write → run preview → collect errors → fix → repeat (max 5 iterations)
   - Reads blueprint from Agent 3, generates code in dependency order: config → schema → utils → api → components → pages
3. `apps/web/src/pipeline/tools/write-file.ts` — Tool: write file to sandbox/preview
4. `apps/web/src/pipeline/tools/read-logs.ts` — Tool: collect error logs from preview
5. `apps/web/src/pipeline/tools/run-preview.ts` — Tool: trigger preview tier (Babel → esbuild → sandbox)
6. `apps/web/src/pipeline/gates.ts` — Human approval gate logic
   - `waitForApproval(gateId, timeoutMs)` — blocks pipeline until founder approves
   - Auto-timeout after 24 hours → pipeline paused, not cancelled
   - Stores gate state in `pipeline_runs` table

### Session B (Web search + lattice enrichment):
7. `apps/web/src/pipeline/tools/web-search.ts` — Tool: CERL web search for Researcher agent
   - Uses Cohere Rerank to validate search results
   - Rate-limited per tier (Free: 10/mo, Pro: 50/mo, Team: 200/mo)
8. `apps/web/src/pipeline/lattice-enrich.ts` — Memory Lattice enrichment after each step
   - `enrichLattice(step, output)` — embeds agent output as Vectorize vectors
   - `findSimilarPatterns(type, query)` — retrieves similar past patterns for agent context
   - Step 2 research → semantic nodes (technologies, patterns, risks)
   - Step 3 blueprint → implementation nodes (component patterns, schema patterns)
   - Step 4 errors/fixes → bridge nodes (debugging patterns, common pitfalls)

### Pipeline dependency:
This phase completes the agent implementations started in Phase 4. The Coder agent uses the preview system from Phase 6 (but the tool interface is defined here). The lattice enrichment connects to the LatticeManager DO from Phase 4.

**See:** `@agent_docs/autonomous-dev-team.md` for full architecture spec

### Verification:
Submit a prompt ("build a dog park finder app"), verify all 4 steps execute, blueprint appears for approval, code generates and deploys.

---

## Phase 6: Three-Tier Preview System
**Estimated credits:** 2 sessions (~30-40 min each)
**Files to create:** ~8

### Session A (Tier 1 + 2):
1. `apps/web/src/components/PreviewFrame.tsx` — Unified preview component
   - **Pipeline integration:** PreviewFrame is used by Agent 4 (Coder) during the error feedback loop
   - When Coder calls `run_preview` tool, PreviewFrame renders the output
   - When errors are detected, they're collected and fed back to the Coder agent
2. `apps/web/src/lib/preview-strategy.ts` — Strategy selector (Babel/esbuild/sandbox)
   - **Pipeline integration:** The Coder agent calls this to determine which tier to use based on blueprint complexity
3. `apps/web/src/hooks/useEsbuild.ts` — esbuild-wasm Worker hook
4. `apps/web/src/workers/esbuild.worker.ts` — Web Worker with virtual FS plugin

### Session B (Tier 3):
5. `apps/web/Dockerfile.preview` — Sandbox container image
6. `apps/web/src/routes/preview.ts` — 5 routes for sandbox lifecycle
7. `apps/web/src/hooks/useSandboxPreview.ts` — Sandbox management hook
8. Update `apps/web/src/index.ts` — Export Sandbox DO, mount preview routes, proxyToSandbox
9. Update `apps/web/wrangler.toml` — Add Sandbox DO binding + container config

### Pipeline dependency:
The preview system is the Coder agent's "sandbox" — where it writes code, runs it, and collects errors. The error feedback loop (the secret sauce from the Lovable/Bolt research) depends on this preview system working. Without it, the Coder agent is writing blind.

### Verification:
```bash
pnpm --filter @bicameral/web build
```

---

## Phase 7: Admin Panel (Task Manager)
**Estimated credits:** 2 sessions (~35-45 min each)
**Files to create:** ~11

### Session A (Backend):
1. `apps/web/src/routes/admin.ts` — Admin API routes (metrics, security events, system status, kill switch)
2. `apps/web/src/lib/admin-middleware.ts` — Permission tiers: -read, -write, -full
3. Add Cloudflare KV binding for emergency shutdown flag
4. Add Workers Analytics Engine binding for telemetry
5. Telemetry middleware — log execution time, route, status to Analytics Engine

### Session B (Frontend):
6. `apps/web/src/views/AdminView.tsx` — Main admin dashboard
   - **Pipeline monitoring tab:** Active pipeline runs, current step, agent model used, time per step
   - **Pipeline metrics:** P95 time per step (ideation, research, design, implementation), success rate, avg iterations in Coder
7. `apps/web/src/components/admin/HealthMetrics.tsx` — Real-time system health (CPU time, D1 latency, HTTP status)
8. `apps/web/src/components/admin/SecurityPanel.tsx` — Security risks, WAF events, failed auth, exploit detection
9. `apps/web/src/components/admin/BottleneckPanel.tsx` — P95/P99 per route, hot routes, unbalanced load
   - **Pipeline bottleneck detection:** If Step 1 (Architect, Command A) is consistently slow, flag for investigation
   - If Coder agent iterations consistently hit max (5), flag blueprint quality issue
10. `apps/web/src/components/admin/EmergencyControls.tsx` — Kill switch, maintenance mode, user bans
    - **Pipeline kill:** Can cancel all active pipeline runs in emergency
11. `apps/web/src/components/admin/RecommendationsEngine.tsx` — Heuristic rules for recommended actions
    - **Pipeline rules:**
      - R9: If Architect agent (Command A) P95 > 30s → "Consider caching common project briefs"
      - R10: If Coder error iterations avg > 3 → "Blueprint quality may be low — review Designer agent prompts"
      - R11: If pipeline success rate < 80% → "Investigate common failure points in Step 4"

### Permission tiers:
- **-read:** View metrics, security events, bottlenecks, recommendations, pipeline status. All action buttons greyed out.
- **-write:** All of -read PLUS: ban users, toggle maintenance mode, kill sandbox sessions, cancel pipeline runs, clear cache
- **-full:** All of -write PLUS: emergency shutdown of entire app (kills all pipelines), config changes, data export, delete projects

### Pipeline dependency:
The admin panel monitors the 4-agent pipeline as a first-class system. Pipeline runs are visible in real-time with per-step breakdowns. The recommendations engine includes pipeline-specific heuristics (R9-R11) that detect when agent prompts need tuning or when blueprints are low quality.

### Verification:
```bash
pnpm --filter @bicameral/web typecheck && pnpm --filter @bicameral/web build
```

---

## Phase 8: Live Chat (FluxyChat + Cohere)
**Estimated credits:** 1 session (~20-30 min)
**Files to create:** ~5

### Tasks:
1. Install `@fluxy-chat/sdk` and `@fluxy-chat/react` as workspace dependencies
2. `apps/web/src/components/FluxyChatWidget.tsx` — Embed FluxyChat realtime chat widget using `@fluxy-chat/react` hooks
3. `apps/web/src/routes/chat.ts` — Mount FluxyChat Worker routes under `/api/chat/*` (WebSocket + REST)
4. Configure FluxyChat AI agent with Cohere as custom LLM provider (`provider: "custom"`, `llmBaseUrl: "https://api.cohere.com/v2"`, `model: "command-r7b-12-2024"`)
   - **Pipeline-aware support:** The AI agent can query the pipeline state to answer "where is my build?" questions
   - The agent knows: current step, progress, any errors, estimated time remaining
   - If a pipeline is stuck at the approval gate, the agent can prompt the user to review their blueprint
5. Configure HITL (Human-in-the-Loop) escalation: AI handles common questions, escalates to human queue on low confidence or "human" keyword
   - **Pipeline escalation:** If user reports a broken build, escalate to human with full pipeline step history attached

### Pipeline dependency:
The live chat AI agent is aware of the pipeline. When a founder asks "why is my app taking so long?", the agent can look up their pipeline run, see that it's on Step 2 (Research) and say "The Research agent is analyzing tech stacks for your project — this usually takes 30-60 seconds. You're at step 2 of 4."

### Verification:
```bash
pnpm --filter @bicameral/web typecheck
```

---

## Phase 9: CI/CD + Public Release
**Estimated credits:** 1 session (~20-30 min)
**Files to create:** ~4

### Tasks:
1. `.github/workflows/ci.yml` — Lint + typecheck + build on every PR
   - **Pipeline test:** Include a smoke test that starts a pipeline with a simple prompt and verifies Step 1 (Architect) produces valid JSON
2. `.github/workflows/deploy.yml` — Deploy to Cloudflare on main branch merge
   - **Pipeline verification:** Post-deploy, run a health check that starts a pipeline and confirms the DO state machine initializes
3. `.github/workflows/sanitize.yml` — git filter-repo to scrub admin package for public release
4. `.gitattributes` — `export-ignore` for packages/admin

### Pipeline dependency:
CI includes a pipeline smoke test — it verifies that the 4-agent orchestration at least initializes correctly. The post-deploy check ensures the GenerationOrchestrator DO can start a pipeline run.

### Verification:
```bash
pnpm --filter @bicameral/web build
```

---

## Phase Dependency Graph (Pipeline-Aware)

```
Phase 1 (Shared types: ProjectBrief, ResearchFindings, SystemBlueprint)
   ↓
Phase 2 (D1: pipeline_runs, pipeline_steps, blueprints tables)
   ↓
Phase 3 (API: /api/pipeline routes + selectModel(step, complexity))
   ↓
Phase 4 (DO: GenerationOrchestrator state machine + Architect + Researcher agents)
   ↓
Phase 5 (UI: pipeline progress + blueprint gate + usePipeline hook)
   ↓ ↓ (parallel)
Phase 5b (Agents: Designer + Coder + tools + gates)    Phase 6 (Preview: error feedback loop for Coder)
   ↓                                                      ↓
   ←─────────────────────────────────────────────────────←
   ↓
Phase 7 (Admin: pipeline monitoring + R9-R11 recommendations)
   ↓
Phase 8 (Chat: pipeline-aware support agent)
   ↓
Phase 9 (CI/CD: pipeline smoke test)
```

## Credit Optimization Tips for Claude Code Pro Plan

1. **One phase per session** — start fresh with `claude` each time
2. **Use Plan Mode first** — run `/plan` to let Claude analyze before writing code
3. **Reference specific docs** — say "Implement Phase 3, see @agent_docs/api-spec.md"
4. **Don't ask Claude to read all agent_docs at once** — reference only what's needed for the current phase
5. **Pipeline phases first** — Phases 4+5b are the core differentiator; prioritize them
6. **Verify between phases** — run `typecheck` and `build` to catch issues early
7. **Use the phase dependency graph** — don't skip phases, each one builds on the last
