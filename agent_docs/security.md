# Security Model — Bicameral

> Referenced by CLAUDE.md via `@agent_docs/security.md`. Read before implementing auth, admin, or preview routes.
> **Pipeline integration:** Each of the 4 agents has specific security constraints.

## Threat Model

### Surface Area

1. **API endpoints** (56 routes) — exposed to internet, require auth
2. **Pipeline endpoints** (5 routes) — manage the 4-agent workflow, highest credit cost
3. **Cohere proxy** — passes user prompts to Cohere API, must prevent prompt injection
4. **Pipeline agents** — 4 agents with different model access and tools, must prevent cross-agent contamination
5. **Preview sandbox** — runs user-generated code in containers, must prevent escape
6. **Blueprint approval gate** — must prevent bypass (only the owner can approve)
7. **Virtual keys** — UUID-based API keys, must prevent brute force
8. **Admin panel** — high-value target, requires permission tier check
9. **D1 database** — stores user data, credit balances, pipeline outputs, must prevent SQL injection
10. **WebSocket connections** — lattice updates + pipeline SSE, must authenticate

## Defenses

### API Security

- **Auth:** Better Auth session cookies, validated on every request
- **Virtual Key:** UUID v4 (122 bits of randomness), stored hashed in D1
- **Rate Limiting:** Sliding window in D1, per-key tracking
  - Free: 100 req/hr, Pro: 1000, Team: 5000
  - 429 + Retry-After header when exceeded
- **Input Validation:** Zod schemas on all request bodies
- **CORS:** Whitelist specific origins (not `*`)
- **Headers:** `X-Request-Id` for tracing, `X-Rate-Limit-Remaining`, `X-Credits-Remaining`

### Pipeline Security (4-Agent Specific)

- **Model routing is server-side only:** Users cannot override which model an agent uses. The `selectModel(step, complexity)` function runs in the GenerationOrchestrator DO.
- **Cross-agent isolation:** Each agent gets its own context window. Agent 1's brief is passed to Agent 2 as structured JSON, not as raw conversation history. This prevents prompt injection from propagating across agents.
- **Blueprint gate security:** The `POST /api/pipeline/:id/approve` route checks that the requesting user owns the pipeline run. Only the owner can approve or reject the blueprint.
- **Pipeline credit pre-check:** Before starting a pipeline, the system checks if the user has enough credits for a full run (estimated 50-200 credits based on complexity). Credits are debited per step.
- **Coder agent sandboxing:** The Coder agent's `write_file` tool can only write within the project's sandbox directory. It cannot access D1, KV, or other Workers bindings.
- **Researcher agent rate limiting:** The Researcher agent's web search tool respects the user's tier-based research query caps (Free: 10/mo, Pro: 50/mo, Team: 200/mo).
- **Pipeline abuse detection:** If a user starts > 5 concurrent pipelines, flag as `pipeline_abuse` in security_events. Admin can ban the user (-write+) or cancel pipelines.
- **Error feedback loop safety:** Coder iterations are capped at 5. If 5 iterations don't produce working code, the pipeline fails gracefully with a partial deployment + error report.

### Cohere Proxy Security

- **Prompt injection defense:** System prompt is prepended server-side, not user-controlled
- **API key isolation:** Cohere key stored as Wrangler secret, never exposed to client
- **OpenRouter key isolation:** OpenRouter key (for North Mini Code) stored as separate Wrangler secret
- **Model routing:** Server-side only, user cannot override which model is used
- **Token counting:** Track input/output tokens per request, debit from credit ledger per pipeline step
- **Content filtering:** Cohere's built-in safety classifier + custom blocklist

### Preview Sandbox Security

- **Tier 1 (Babel):** Sandboxed iframe with `sandbox="allow-scripts allow-modules"` (no same-origin)
- **Tier 2 (esbuild):** Web Worker (isolated thread), iframe srcdoc (no same-origin)
- **Tier 3 (Sandbox):** Cloudflare Sandbox container (isolated Linux namespace)
  - No access to D1, KV, or other Workers bindings
  - No network access except the dev server port
  - Auto-destroy after 10 min idle
  - Per-user isolation (Durable Object per user+project)
  - **Coder agent writes here:** The Coder agent's `write_file` and `run_preview` tools operate on this sandbox
- **CSP:** Content-Security-Policy on preview iframe: `script-src 'self' 'unsafe-inline' unpkg.com`

### Admin Panel Security

- **Permission tiers:** -read, -write, -full checked by middleware on every admin route
- **Pipeline admin routes:** GET /api/admin/pipelines requires -read, POST /api/admin/pipelines/:id/cancel requires -write+
- **Emergency shutdown:** KV flag, sub-10ms read, blocks all non-admin routes, cancels all active pipelines
- **Audit log:** All admin actions logged to D1 with timestamp, admin ID, action, target
- **2FA recommendation:** Better Auth supports TOTP, should be required for -full access

### Credit System Security

- **Atomic debit:** Credit deduction uses D1 transaction (BEGIN...COMMIT)
- **Negative balance prevention:** Check balance before every Cohere call (per pipeline step)
- **Per-step tracking:** Each pipeline step debits credits individually — if Step 2 fails, Steps 3-4 don't run and don't cost credits
- **Tier-based caps:** Hard limits enforced server-side, not configurable by user
- **Trial expiration:** 30-day auto-expiry via D1 timestamp check on every request
- **Credit fraud prevention:** No way to add credits without admin action (-full tier)

## Known Exploit Vectors & Mitigations

| Vector                              | Risk                | Mitigation                                                 |
| ----------------------------------- | ------------------- | ---------------------------------------------------------- |
| Brute force virtual keys            | Low (122-bit UUID)  | Rate limit auth endpoint (5 attempts/min)                  |
| Prompt injection to Cohere          | Medium              | Server-side system prompt + content filter                 |
| Cross-agent prompt injection        | Medium              | Structured JSON between agents (not raw conversation)      |
| Blueprint gate bypass               | Low                 | Owner check on approve route + session validation          |
| Pipeline credit exhaustion          | Medium              | Pre-check credits before start + per-step debit            |
| Concurrent pipeline abuse           | Medium              | Max 5 concurrent pipelines per user + security_events flag |
| Sandbox escape (Tier 3)             | Low (CF isolation)  | Container has no binding access                            |
| SQL injection via D1                | Low (parameterized) | Hono uses prepared statements via D1 binding               |
| XSS in generated preview            | Medium (user code)  | Sandboxed iframe with strict CSP                           |
| Credit exhaustion attack            | Medium              | Rate limiting + credit caps + IP tracking                  |
| Admin panel privilege escalation    | Low                 | Permission tier checked on every admin request             |
| WebSocket hijacking                 | Low                 | Auth check on WS upgrade, per-project isolation            |
| Model routing bypass                | Low                 | Routing is server-side only, user input ignored            |
| Coder agent writing outside sandbox | Low                 | File tool restricted to project directory                  |

## Monitoring (via Admin Panel)

- Failed auth attempts → security_events table → admin panel Security tab
- Rate limit hits → Analytics Engine → admin panel Bottlenecks tab
- Credit depletion rate → D1 credit_ledger → admin panel Recommendations tab
- Pipeline step timing → Analytics Engine → admin panel Pipeline Monitor tab
- Pipeline failures → pipeline_runs.status = 'error' → admin panel Recommendations (R11)
- Coder iteration counts → pipeline_steps.iteration → admin panel Recommendations (R10)
- Sandbox resource usage → Analytics Engine → admin panel Health Metrics
- WAF events (if Cloudflare WAF enabled) → GraphQL Analytics API → admin panel Security tab

## Incident Response

1. **Detection:** Admin panel shows real-time security events with severity badges + pipeline status
2. **Assessment:** Recommendations engine suggests actions based on event patterns (including R9-R12 pipeline rules)
3. **Response:** Admin can ban IP, kill sandboxes, cancel pipelines, toggle maintenance mode, or emergency shutdown
4. **Recovery:** Clear KV flags, unban IPs, restart sandboxes, restart cancelled pipelines
5. **Post-mortem:** Export security events log + pipeline step history for analysis
