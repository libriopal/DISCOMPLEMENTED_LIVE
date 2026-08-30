# Cohere Integration Spec — Bicameral

> Referenced by CLAUDE.md via `@agent_docs/cohere-integration.md`. Read before Phase 3.
> **Pipeline integration:** Each of the 4 agents uses a different Cohere model and API pattern.

## CRITICAL: Trial Key vs Production Key

**Trial keys are FREE but CANNOT be used for production or commercial purposes.** Cohere's terms explicitly prohibit this. Bicameral is a commercial product, so it MUST use Production keys.

- **Trial key:** Free, rate-limited (100 calls/min, 1,000 calls/month), non-commercial only
- **Production key:** Pay-as-you-go, billed monthly or at $250 balance threshold, commercial use allowed

## Pipeline Model Routing Per Agent

The 4-agent pipeline uses a server-side `selectModel(step, complexity)` function to route each agent to the optimal Cohere model. Users cannot override this.

| Agent Step               | Model           | Why This Model                                                             | API                                             | Cost per Run      |
| ------------------------ | --------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| Step 1: Architect        | Command A       | Needs deep reasoning to parse vague founder visions into structured briefs | Cohere Production                               | ~$0.035           |
| Step 2: Researcher       | Command R7B     | Fast and cheap — research is pattern-matching, not deep reasoning          | Cohere Production                               | ~$0.0015          |
| Step 3: Designer         | Command A       | Needs reasoning for system design (components, schema, API routes)         | Cohere Production                               | ~$0.035           |
| Step 4: Coder (simple)   | North Mini Code | Free — simple code doesn't need expensive models                           | Cohere direct (not OpenRouter — see note below) | $0                |
| Step 4: Coder (moderate) | Command R7B     | Cheap — moderate complexity code generation                                | Cohere Production                               | ~$0.0015          |
| Step 4: Coder (complex)  | Command A       | Complex code needs reasoning, especially for error fixing                  | Cohere Production                               | ~$0.035/iteration |
| Lattice enrichment       | Embed v4        | Embeds agent outputs into the Memory Lattice                               | Cohere Production                               | ~$0.00006/node    |
| Research validation      | Rerank v4       | Validates web search results for the Researcher agent                      | Cohere Production                               | ~$0.01/search     |

**Note:** North Mini Code is called directly against Cohere's own `/v2/chat`, not via OpenRouter. `model-router.ts`'s own comment explains why: North Mini Code is free on Cohere's API "until rate limits are reached," and Phase 9 testing found OpenRouter's routing for this model never completed a realistic multi-file prompt (10+ min, no response) vs. ~2m45s calling Cohere directly. `openrouter.ts` is real, tested, and wired into the dispatcher, but no `selectModel()` output currently matches `isOpenRouterModel()`'s check (`model.includes('/') || model.endsWith(':free')`) — it's kept for future use, not on the active path today.

### selectModel() Implementation

```typescript
// packages/cohere/src/model-router.ts — confirmed verbatim as shipped
export function selectModel(
  step: AgentRole,
  complexity: PipelineComplexity = 'simple'
): string {
  switch (step) {
    case 'architect':
      return 'command-a-03-2025'; // always
    case 'researcher':
      return 'command-r7b-12-2024'; // always
    case 'designer':
      return 'command-a-03-2025'; // always
    case 'coder':
      if (complexity === 'simple') return 'north-mini-code-1-0'; // direct Cohere ID, not OpenRouter-style
      if (complexity === 'moderate') return 'command-r7b-12-2024';
      return 'command-a-03-2025'; // 'complex'
  }
}
```

### Coder Agent: fixed model per run, NOT per-iteration escalation

**Correction:** an earlier draft of this doc described the Coder as starting cheap and escalating models across iterations when errors persisted. That is not what's implemented. `complexity` is decided once by the Architect (`ProjectBrief.complexity: 'simple'|'moderate'|'complex'`), and `coder.ts` calls `selectModel('coder', complexity)` **once, before the loop**, reusing that single model for every iteration:

```typescript
// coder.ts — model picked once, outside the loop
const model = selectModel('coder', complexity);
for (
  let iteration = 1;
  iteration <= PIPELINE_DEFAULTS.maxCoderIterations;
  iteration++
) {
  // ...same model, every iteration...
}
```

So for a `simple`-complexity run, all up to 5 iterations use North Mini Code; for `moderate`, all use Command R7B; for `complex`, all use Command A. There is no mid-run upgrade path. `PIPELINE_DEFAULTS.maxCoderIterations` is 5; if the loop exhausts all 5 iterations without a clean preview, the run reports failure with the last attempt's files and errors — it does not retry with a more expensive model.

## The $1,000 Credit Strategy

Cohere offers several credit/discount programs. Here's how to maximize them for Bicameral:

### 1. Free Developer Tier (Automatic)

- Replaced the old $75 free credit program
- Rate-limited trial key — useful for development/testing only
- NOT for production (Bicameral's actual traffic)
- **Value:** $0 (testing only)

### 2. Startup Discount Program (Apply)

- 25% discount on ALL Cohere models for 12 months
- Eligibility: Series B and earlier startups
- No equity required
- Application required via Cohere dashboard
- **Value:** ~$250/yr savings at moderate usage (25% off all API costs)

### 3. Research Grant Program (Apply)

- Free API access via Cohere Labs
- For research-oriented projects
- Application at https://cohere.com/research/grants/application
- **Value:** Variable (free API access for approved research use cases)

### 4. North Mini Code (Free)

- 30B MoE model with 3B active parameters, designed for agentic coding tasks
- Free on Cohere's own API "until rate limits are reached" — also available free on OpenRouter, but the pipeline calls Cohere directly (see note under the routing table above)
- **Pipeline use:** Primary model for Step 4 (Coder) on simple blueprints
- **Value:** $0 cost for most coding generations

### 5. Accumulated Credits Strategy

- Sign up at multiple providers that aggregate Cohere models
- OpenRouter offers North Mini Code free + Command R7B at cost
- AWS Bedrock, Azure, Oracle offer Cohere models with their own credit programs
- **Potential total:** $500-1,000+ in free credits across providers

## Model Routing (Free-First by Complexity Tier — CORRECTED)

The system picks the cheapest model that fits the Architect's declared complexity tier, once per run — it does not try cheap-then-escalate within a run (see the Coder section above).

| Complexity tier | Model           | Access                     | Cost (per 1M tokens)     | Commercial? |
| --------------- | --------------- | -------------------------- | ------------------------ | ----------- |
| simple          | North Mini Code | Cohere direct (`/v2/chat`) | $0 in / $0 out           | ✅ Yes      |
| moderate        | Command R7B     | Cohere Production          | $0.0375 in / $0.15 out   | ✅ Yes      |
| complex         | Command A       | Cohere Production          | $2.50 in / $10.00 out    | ✅ Yes      |
| Embed           | Embed v4        | Cohere Production          | ~$0.12 / 1M tokens       | ✅ Yes      |
| Rerank          | Rerank v4       | Cohere Production          | ~$2.00 / 1M search units | ✅ Yes      |

### Key Corrections from Previous Assumptions

- ❌ PREVIOUS: "Command R7B is free for coding" — WRONG. Trial keys are free but non-commercial.
- ✅ CORRECT: Command R7B costs $0.0375/1M in + $0.15/1M out on Production. Still very cheap.
- ✅ CORRECT: North Mini Code is the free coding model, called directly against Cohere's API (`north-mini-code-1-0`), not via OpenRouter.
- ✅ CORRECT: model selection is fixed once per Coder run by complexity tier, not escalated across iterations.
- ✅ NEW: Startup program gives 25% discount on all models for 12 months.

## API Calls (Direct fetch — NOT cohere-ai SDK)

### Chat (Code Generation) — Cohere Production

```typescript
const response = await fetch('https://api.cohere.com/v2/chat', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`, // Production key
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'command-r7b-12-2024',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: toolDefinitions,
    temperature: 0.7,
    stream: true,
  }),
});
```

### North Mini Code (Free via OpenRouter)

```typescript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${openRouterKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://bicameral.workers.dev',
    'X-Title': 'Bicameral',
  },
  body: JSON.stringify({
    model: 'cohere/north-mini-code:free',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    stream: true,
  }),
});
```

### Structured Outputs (Pipeline Agents 1 + 3)

The Architect and Designer agents use Cohere Structured Outputs (tools) to guarantee JSON compliance:

```typescript
// Architect agent — generate_project_brief tool
const response = await fetch('https://api.cohere.com/v2/chat', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'command-a-03-2025',
    messages: [
      { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
      { role: 'user', content: founderVision },
    ],
    tools: [
      {
        name: 'generate_project_brief',
        description:
          'Generate a structured project brief from a vision description',
        parameter_definition: {
          type: 'object',
          properties: {
            /* ... */
          },
        },
      },
    ],
    temperature: 0.3, // Low temperature for structured output
    stream: false, // Non-streaming for tool calls
  }),
});
```

### Embed (Lattice — after each pipeline step)

```typescript
// After each agent completes, enrich the Memory Lattice
const response = await fetch('https://api.cohere.com/v2/embed', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: 'embed-v4.0',
    texts: [agentOutput],
    input_type: 'search_document',
    embedding_types: ['float'],
  }),
});
// Store in Vectorize + D1 lattice_nodes with metadata: { pipeline_step, agent_role }
```

### Rerank (Research — Step 2)

```typescript
// Researcher agent validates web search results
const response = await fetch('https://api.cohere.com/v2/rerank', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: 'rerank-v4.0',
    query: researchQuery,
    documents: searchResults,
    top_n: 10,
  }),
});
// Results feed into Agent 3 (Designer) as context
```

## Credit Cost Per Pipeline Step

| Pipeline Step                           | Model                          | Avg Tokens In | Avg Tokens Out | Cost per Step              |
| --------------------------------------- | ------------------------------ | ------------- | -------------- | -------------------------- |
| Step 1: Architect                       | Command A                      | ~3000         | ~1000          | ~$0.018                    |
| Step 2: Researcher                      | R7B + Rerank                   | ~5000         | ~2000          | ~$0.0015 + $0.01 = ~$0.012 |
| Step 3: Designer                        | Command A                      | ~5000         | ~3000          | ~$0.043                    |
| Step 4: Coder (free path)               | North Mini Code x 2 iterations | ~8000         | ~6000          | $0                         |
| Step 4: Coder (paid path)               | R7B x 3 iterations             | ~12000        | ~9000          | ~$0.006                    |
| Step 4: Coder (complex)                 | Command A x 5 iterations       | ~20000        | ~15000         | ~$0.175                    |
| Lattice enrichment                      | Embed v4 x 4 steps             | ~2000         | 0              | ~$0.0002                   |
| **Total (best case: simple blueprint)** |                                |               |                | **~$0.073**                |
| **Total (moderate blueprint)**          |                                |               |                | **~$0.079**                |
| **Total (complex blueprint)**           |                                |               |                | **~$0.248**                |

## Tier Credit Allocation & Revenue Math (Corrected)

### Pricing Tiers

| Tier       | Monthly Price | Credits | Est. Pipeline Runs                | Est. Research Queries |
| ---------- | ------------- | ------- | --------------------------------- | --------------------- |
| Free       | $0            | 1,000   | ~2 (simple only, North Mini Code) | 10                    |
| Pro        | $29           | 10,000  | ~20 (mix of simple + moderate)    | 50                    |
| Team       | $99           | 50,000  | ~100 (includes complex)           | 200                   |
| Enterprise | Custom        | Custom  | Custom                            | Custom                |

### Cost Analysis — Pro Tier ($29/mo)

With the free-first routing and pipeline costs:

- 70% of pipelines use North Mini Code for Coder (free): ~$0.073 each -> 14 runs x $0.073 = $1.02
- 20% escalate to R7B for Coder: ~$0.079 each -> 4 runs x $0.079 = $0.32
- 10% escalate to Command A for Coder: ~$0.248 each -> 2 runs x $0.248 = $0.50
- 50 research queries x $0.01 = $0.50
- Embed costs (lattice enrichment): ~80 nodes x $0.00006 = $0.005
- **Total cost per Pro user: ~$2.35/mo**
- **Revenue per Pro user: $29/mo**
- **Margin: ~91.9%**

### Cost Analysis — Team Tier ($99/mo)

- 50% North Mini Code: 50 x $0.073 = $3.65
- 30% R7B: 30 x $0.079 = $2.37
- 20% Command A: 20 x $0.248 = $4.96
- 200 research queries x $0.01 = $2.00
- Embed costs: ~400 nodes x $0.00006 = $0.024
- **Total cost per Team user: ~$13.00/mo**
- **Revenue per Team user: $99/mo**
- **Margin: ~86.9%**

### With 25% Startup Discount Applied

- Pro tier cost drops to: ~$1.76/mo (margin: 93.9%)
- Team tier cost drops to: ~$9.75/mo (margin: 90.2%)

### Break-Even Analysis

**Pro user ($29/mo):** Would need ~400 complex pipeline runs/month to cost more than $29. Very unlikely at 20 runs/mo.

**Team user ($99/mo):** Would need ~400 complex pipeline runs/month. Possible only for heavy teams.

### Revenue Comparison vs Claude Pro ($20/mo)

| Factor              | Bicameral Pro ($29/mo)                           | Claude Pro ($20/mo)        |
| ------------------- | ------------------------------------------------ | -------------------------- |
| API cost per user   | ~$2.35/mo                                        | ~$20/mo (Anthropic's cost) |
| Margin              | ~91.9%                                           | ~0% (break-even)           |
| Value prop          | Full app generation + 4-agent pipeline + preview | Chat assistant             |
| Infrastructure cost | $0 (Cloudflare free tier)                        | High (Anthropic servers)   |

Bicameral charges MORE than Claude Pro while costing LESS to operate, because the 4-agent pipeline uses free-first routing (North Mini Code + cheap R7B) and only escalates to expensive models when needed.

## Implementation Notes

### Dual API Strategy

1. **OpenRouter** for North Mini Code (free coding model — Step 4 Coder)
   - Get API key at https://openrouter.ai
   - Store in Wrangler secrets (name not disclosed for security)
   - Use for free-tier users and simple code generation
2. **Cohere Production** for R7B, Command A, Embed, Rerank
   - Get Production key via Cohere dashboard
   - Store in Wrangler secrets (name not disclosed for security)
   - Use for Steps 1-3 (Architect, Researcher, Designer) and Coder escalation

### Pipeline Agent Prompts

Each agent has a system prompt that defines its role in the pipeline. These are stored in `src/pipeline/agents/*.ts` and loaded by the GenerationOrchestrator DO. See `@agent_docs/autonomous-dev-team.md` for full prompt definitions.

### Rate Limit Handling

- Cohere Trial: 20 RPM (Chat), 5 RPM (Embed) — dev only
- Cohere Production: 1,000 RPM — sufficient for production
- OpenRouter free: ~20 RPM — sufficient for free tier Coder
- Implement exponential backoff on 429 responses
- Per-pipeline-step: one model call at a time (sequential agents)

### Billing Triggers

- Cohere bills at end of month OR when balance hits $250
- Set up billing alerts in Cohere dashboard
- Track usage in D1 credit_ledger per user, per pipeline_run_id
- Alert admin (via admin panel) when aggregate API spend exceeds threshold
- Pipeline credit pre-check: estimate cost before starting (50-200 credits based on complexity)
