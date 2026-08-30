# Gap Analysis: 5 Deterministic Bots → discomplemented.com

## Cost Summary

### Per Pipeline Run (1 app generation)

- **Cohere API cost (trial key)**: $0.00 (free until rate limits)
- **Cohere API cost (production, North Mini Code = free)**: $0.04
- **Cohere API cost (worst case, Command A for all agents)**: $0.10
- **Internal credits**: 10 per pipeline run
- **API calls per run**: 4-7 chat + 1 rerank + 4 embed = 9-12 Cohere calls

### 5 Bots Creating 1 App Each

| Scenario                | Cost  |
| ----------------------- | ----- |
| Trial key (free)        | $0.00 |
| Production + free coder | $0.21 |
| Production + worst case | $0.51 |
| Internal credits        | 50    |

### 5 Bots × Full Conversations (avg 11 turns)

| Scenario                | Cost  |
| ----------------------- | ----- |
| Trial key (free)        | $0.00 |
| Production + free coder | $2.26 |
| Production + worst case | $5.56 |
| Internal credits        | 550   |

### 5 Bots × 5000 Turns (extreme stress test)

| Scenario                | Cost    |
| ----------------------- | ------- |
| Production + free coder | ~$1,028 |
| Production + worst case | ~$2,529 |
| Internal credits        | 250,000 |

## Gap Analysis

### BLOCKERS (must fix for bots to run)

#### GAP-1: Authentication — bots need virtual keys

- **Problem**: Every /api/pipeline call requires auth via Bearer token (virtual key) or session cookie.
- **Fix**: Create 5 virtual keys in D1 (one per bot) with trial tier + sufficient credits.
- **Code path**: `apps/web/src/lib/require-auth.ts` → `resolveVirtualKey()` → D1 users table

#### GAP-2: Approval gate — pipeline blocks on human approval

- **Problem**: After Designer produces blueprint, pipeline enters 'awaiting_approval'. Blocks until human POSTs to /api/pipeline/:id/approve.
- **Fix**: Add auto-approve mode for simulation runs. Bot polls GET /api/pipeline/:id, detects 'awaiting_approval', POSTs approve.
- **Code path**: `apps/web/src/durable-objects/GenerationOrchestrator.ts` → `runDesignerStep()` → awaiting_approval → `resolveGate()`

### HIGH (degrades simulation quality)

#### GAP-4: No real preview/deployment

- **Problem**: Coder writes files to R2. run-preview does static lint only. No real deployment.
- **Fix**: Phase 6 work — Cloudflare Pages integration or sandbox container.
- **For simulation**: Files ARE real TypeScript/SQL/TSX in R2. Bots can evaluate file count, structure, code quality.

#### GAP-7: Bot polling loop not implemented

- **Problem**: Pipeline is async. POST returns immediately. Bot needs to poll status.
- **Fix**: Add poll-and-act loop to browser_simulation.py:
  1. POST prompt → get run ID
  2. Poll GET /api/pipeline/:id every 2s
  3. If 'awaiting_approval' → POST /:id/approve
  4. Wait for 'deployed' or 'error'
  5. Evaluate result
  6. Optionally iterate with POST /:id/iterate

### MEDIUM (functional but suboptimal)

#### GAP-5: Web search is synthetic

- **Problem**: Researcher generates candidates from model knowledge, not real web search.
- **Fix**: Wire You.com API (YDC_API_KEY already set) into tools/web-search.ts.

#### GAP-6: Lattice enrichment is fire-and-forget

- **Problem**: LATTICE_DO is a stub. findSimilarPatterns returns empty results.
- **Fix**: Implement real Cohere embed + similarity search in LatticeManager DO.

#### GAP-8: Iterate endpoint not wired to bots

- **Problem**: Bot follow-up prompts aren't structured as iterate requests.
- **Fix**: Map bot follow-ups to POST /api/pipeline/:id/iterate with {prompt: followUp}.

### PARTIAL (works but needs config)

#### GAP-3: Security gate needs GitHub Actions config

- **Problem**: Dispatches GitHub Actions workflow. Needs GITHUB_ACTIONS_TOKEN + GITHUB_REPO.
- **Fix**: Set env vars in wrangler.toml. Workflow already exists in .github/workflows/security-gate.yml.
- **Fallback**: If token is missing, pipeline continues with warning (non-blocking).

## Architecture: Two-Layer Simulation

```
Layer 1 (Deterministic — $0, unlimited):
  BotPersonality.from_seed() → generate_prompt() → evaluate_response()
  No LLM calls. Runs 5000+ turns on a laptop.

Layer 2 (Real API — $0.04-$0.10 per run):
  POST /api/pipeline → Cohere Command A (architect)
                    → Cohere R7B (researcher) + Cohere Rerank
                    → Cohere Command A (designer)
                    → Cohere North Mini Code (coder, free)
                    → GitHub Actions (security gate)
                    → R2 (file storage)
  Real Cohere credits consumed. Real files generated.

The simulation is an expanded Monte Carlo:
  - Deterministic bots provide controlled variation (personalities)
  - Real pipeline provides real costs and real failure modes
  - Gap analysis shows exactly what code needs writing
```
