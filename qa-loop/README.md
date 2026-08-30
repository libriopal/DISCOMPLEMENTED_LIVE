# qa-loop

A standing QA-loop test harness for Bicameral. It answers one question, on
demand: **if a real founder used this right now, end-to-end, would we know
before they told us?**

This is v1 — session-run-only. It is **not** wired into CI or a cron job.
Run it by hand whenever you want a current read on the platform.

## What it checks

1. **Deployment health** — parses `apps/web/wrangler.toml` for what's
   actually bound (D1, R2, Vectorize, KV, Analytics Engine, 3 Durable
   Objects, the Tier-3 container) vs. just declared; does a read-only GET
   against `discomplemented.com` to confirm it resolves; hits local
   `wrangler dev` routes to confirm auth-gated routes 401/403 with no key
   and public routes don't 500.
2. **Functional checklist** — derives the actual promised-feature list by
   regex-scanning the real route files (`apps/web/src/routes/*.ts`) at
   run time, grouped by feature area. This list is **derived, not
   assumed** — if a route is added or removed, the next run picks it up
   automatically. Cross-checks (soft signal only) against live marketing
   copy keywords if the live site is reachable.
3. **Pipeline simulation** — ONE synthetic founder run through the real
   4-agent pipeline (Architect → Researcher → Designer → human gate,
   scripted approval → Coder) via local `wrangler dev`, using a dedicated
   QA-loop test tenant/virtual key. Makes real Cohere/OpenRouter API
   calls. Polls `pipeline_steps.tokens_in/tokens_out` in local D1 against
   published per-model pricing and cancels the run mid-flight if estimated
   spend would exceed the per-run cap.
4. **Security regression** — checks every `.github/workflows/*.yml` for
   floating-tag `uses:` (not SHA-pinned), missing explicit `permissions:`
   blocks, and jobs that share scope between untrusted-content-reading
   steps and deploy-secret-holding steps. Reports violations by
   `file:line`.
5. **Support / escalation** — reads `routes/chat.ts` and `lib/fluxychat.ts`
   to check whether there's any explicit escalation logic keyed on
   security/privacy/billing/legal keywords (vs. every message just
   logging through to the same support-AI room), and does a read-only
   round-trip probe of `POST /api/chat/token` using the test tenant.
6. **Mobile / responsive** — the one check that can't be fully automated
   without a browser. Compares the breakpoint-adaptation rules documented
   in `design/06-hifi-responsive-layouts.html` against what actually
   exists in `apps/web/src/` (any `@media` query beyond dark-mode
   preference, any `useMediaQuery`/`matchMedia` usage). Reports rendered
   layout / touch-target / interaction behavior as unverifiable — that
   needs a real browser-driven follow-up.

## Hard boundaries (enforced by the code, not just convention)

- **Never touches production data or real payment flows.** Every check
  that needs a user uses a dedicated test tenant created directly in
  local D1 (`src/testTenant.ts`), reusing the exact same SHA-256
  virtual-key hashing scheme as `apps/web/src/lib/virtual-key.ts` — not a
  parallel system. The tenant is deleted at the end of every run (and any
  orphans from a prior interrupted run are swept at the start of the
  next one).
- **Never runs against `discomplemented.com` or the real staging URL**
  except a single read-only, unauthenticated GET to confirm the live site
  resolves (check 1). Everything else targets `http://127.0.0.1:8787`
  (local `wrangler dev`) only — see `src/config.ts`'s `LOCAL_API_BASE_URL`.
- **Budget-capped real spend.** `$1.00` cap per pipeline-simulation run,
  `$5.00` cap total per invocation (`src/config.ts`'s `BUDGET`). The
  pipeline-simulation check polls actual token usage from D1 against
  `agent_docs/cohere-integration.md`'s published per-model $/token rates
  and cancels the run (not the whole harness) if it would exceed the cap,
  logging "budget-capped, partial" in the report.
- **Never deploys anything.** No `wrangler deploy` anywhere in this
  directory.
- **Never modifies the frozen architecture** (D1–D12 in the root
  `CLAUDE.md`). Architectural problems are report findings, not patches.
- **Refuses to write a report that looks like it contains a secret** —
  `src/report.ts` scans the rendered Markdown for API-key/token shapes
  before writing and throws instead of writing if it finds one.

## Running it

```bash
# 1. In one terminal, start local wrangler dev (apps/web):
cd apps/web
pnpm dev:api          # or: wrangler dev

# 2. In another terminal, from the repo root:
node qa-loop/src/run.ts
```

Requires Node 24+ (uses Node's native TypeScript support — no `tsx`/
`ts-node` dependency needed; plain `.ts` files with explicit `.ts` import
extensions run directly via `node`).

The script checks that local `wrangler dev` is reachable at startup and
exits immediately with an error if it isn't — it never tries to start or
stop `wrangler dev` itself. That's a deliberate choice for v1: a harness
that can kill your dev server out from under you mid-debug is more
annoying than useful when you're running this by hand.

`.dev.vars` (repo root and `apps/web/`, both gitignored) must have real
`COHERE_API_KEY` / `OPENROUTER_API_KEY` values for check 3
(pipeline simulation) to make real model calls — same file `wrangler dev`
already reads.

## Output

Each run writes one timestamped Markdown file to `qa-loop/reports/`
(gitignored — these are run artifacts, not source, and may contain a test
virtual key or similar). The report leads with a "NEEDS HUMAN ATTENTION"
section for anything critical, then a summary table of all 6 checks, then
full findings per check with severity and `file:line` locations where
applicable.

## What v1 deliberately does not do

- No CI wiring, no cron/scheduled job — session-run-only, per explicit
  decision for this version.
- No 30-synthetic-founder test matrix — one pipeline-simulation run per
  invocation, both for budget reasons and because v1 scope is a single
  representative run, not a fleet.
- No browser automation — check 6 (mobile/responsive) is source-level
  only; a Playwright-driven follow-up is a known, explicitly-flagged gap,
  not something this version silently claims to cover.
