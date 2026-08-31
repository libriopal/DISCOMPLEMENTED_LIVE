# Bicameral / COMPaNiON — Claude Code project instructions

**What this is.** The production repository behind **discomplemented.com**: a Cohere-native prompt-to-app platform running on Cloudflare Workers. A multi-agent pipeline researches, audits, verifies, and designs an application before any code is written; a human approves the blueprint; only then does the coder agent build it.

> **About this file.** It previously described a planned build — a four-agent `Architect → Researcher → Designer → Coder` pipeline, "56 API routes", "11 tables", a phased implementation plan to follow one phase per session, and an `apps/web` that did not exist yet. The application shipped, and the shape it shipped in differs from that plan in ways that matter for anyone editing it. This file now describes **what is on disk**, verified against the code. Where a statement is a caveat or a known defect rather than a design, it says so.

---

## Ground rules

1. **Verify before you assert.** Docs in this repo have drifted from the code before (this file included). If you are about to state a count, a model name, a column, or a route, read the source first. `agent_docs/` was written against the original plan and has **not** been re-verified — treat it as historical intent, not as a description of the system.
2. **No quality percentages in product copy.** No VDR figure, no "91.3%", no accuracy claim reaches a customer-facing surface. More precisely: no quality, stability, or confidence percentage may appear in user-facing copy, in a system prompt, or in an API response unless a reproducible derivation for it exists in this repo. See [Simulations are simulations](#simulations-are-simulations). `BASELINE.md` is what replaced the unfounded "90% stable" claim — a count of what actually passes, with the commands. Re-measure and update it in the same commit as anything that moves it.
3. **No "Architect" role in product copy or new code paths.** The role is retired (see [The pipeline](#the-pipeline)). The identifier survives in two places for compatibility only.
4. **Pricing is provisional.** The tiers in `packages/shared/src/constants.ts` are placeholders; no live Stripe account exists. The marketing site carries an "Early access — subject to change" badge, which stays until real pricing does.
5. **Never commit secrets.** `wrangler secret put` only. `[vars]` in `wrangler.toml` is for non-secret values.

## Repository identity

|             |                                                                          |
| ----------- | ------------------------------------------------------------------------ |
| Package     | `bicameral` (root), `@bicameral/web` (the deployed app)                  |
| Domain      | `discomplemented.com` + `www.discomplemented.com` (custom domains)       |
| Runtime     | Cloudflare Workers, `compatibility_date = "2026-08-01"`, `nodejs_compat` |
| Entry point | `apps/web/src/index.ts` (the root `wrangler.toml` is a retired stub)     |
| D1          | `bicameral` (`24dd57ec-9c20-46df-aaa9-d4f99dc570bb`)                     |
| R2          | `bicameral-assets` · Vectorize: `bicameral-lattice` · KV: `CONFIG_KV`    |
| Node / pnpm | `>=22.0.0` / `>=10.18.0` (pinned `pnpm@10.34.5` via `packageManager`)    |

## Stack (frozen — do not swap these out)

- **Runtime:** Hono v4 on Cloudflare Workers
- **Data:** D1 (SQLite at edge), R2, Vectorize, KV, Analytics Engine
- **Durable Objects:** `GenerationOrchestrator` (pipeline state machine), `LatticeManager`, `Sandbox` (preview container), `GlassEngineDO`
- **Auth:** Better Auth on D1 — email/password + GitHub OAuth
- **AI:** Cohere API v2 via **direct `fetch()`, never the `cohere-ai` SDK**. Embed v4.0 for embeddings, Rerank v4.0 for research.
- **Frontend:** React 19, Vite, UnoCSS, Framer Motion, Three.js (lattice), Zustand
- **Build:** pnpm workspaces — `@bicameral/shared`, `@bicameral/cohere`, `@bicameral/admin-stub` (the admin surface; the real `@bicameral/admin` lives in the private DISCOMPLEMENTED_ADMIN repo), `@bicameral/web`

## Layout

```
apps/web/src/
  index.ts            # Hono app; mounts every /api/* route, in order
  routes/             # 30 route modules
  pipeline/
    agents/           # researcher, auditor, verifier, designer, coder (+ architect.ts, see below)
    tools/            # write-file, run-preview, read-logs, web-search, security-scan{,-gh}
    gates.ts          # inter-agent + approval gate logic
  durable-objects/    # GenerationOrchestrator, LatticeManager, Sandbox
  lib/                # auth, cohere, stripe, email, telemetry, tripwires, virtual-key, …
  components/         # marketing/, LoginScreen, LegalDocScreen, IDELayout, admin/
  views/              # 10 authenticated views (Generation, Projects, Lattice, Admin, Billing, …)
  hooks/              # useAuth, usePipeline, useGenerationStream, useEsbuild, useSandboxPreview
migrations/           # D1 migrations, 001–027 (27 files, numbers now unique)
packages/             # shared, cohere, admin-stub
design/               # 7 reference HTML specs (read-only)
simulation/           # offline Monte Carlo experiments — NOT production code
```

## Routing and the public surface

`/` serves the marketing site to signed-out visitors (`components/marketing/MarketingSite.tsx`); `/signin` serves the auth form; `/legal/*` serves legal documents; every other path falls through to the authenticated SPA. Routing is **pathname-based in `App.tsx`** — there is no client-side router. Adding a public page means adding a branch there.

Two signed-out cases must reach `LoginScreen` even though no CTA sent them to
`/signin`, and `App.tsx` special-cases both: `/?verified=true` (the
email-verification landing, whose links are already in inboxes pointing at `/`)
and any non-`/` path (a deep link followed while signed out — asking for
credentials keeps the destination, bouncing to the landing page loses it).

Marketing copy lives in `components/marketing/copy.ts`, separate from
presentation, with `copy.test.ts` pinning the three constraints that are
load-bearing rather than stylistic: no quality/VDR percentage, no "Architect"
named as an agent, and the provisional-pricing badge. Reword copy there, not in
the JSX.

Static assets use `not_found_handling = "single-page-application"` with **`run_worker_first = true`**. Do not remove that flag: without it, Workers Assets intercepts real browser navigations before the Worker runs and serves the SPA shell, which silently breaks the GitHub OAuth callback (`/api/auth/callback/github` never reaches Better Auth, so no session is created).

`apps/web/src/index.ts` mounts **34 route groups**. Order is load-bearing: webhook routes and `/api/auth` are mounted **before** `app.use('/api/*', requireAuth)` so they bypass session middleware. A new authenticated route must go after that line; a new webhook must go before it.

Note `/api/healthz` (public liveness, registered before the auth middleware) is a different thing from `/api/health` (the authenticated per-user health-score API). They have been confused before, including by a test.

## The pipeline

Five roles, in order, with a human approval gate before code generation:

```
1 researcher → 2 auditor → 3 verifier → 4 designer → [HUMAN APPROVES BLUEPRINT] → 5 coder
                   ↖________________________________________________↗   feedback loop
```

`GenerationOrchestrator` is the state machine: `awaiting_approval → implementing → scanning → deployed → error`, with inter-agent gates between every step and execution modes `ask_first` (pause at every gate) and `auto_accept` (auto-advance, log everything). The approval gate sits between designer and coder because code generation is the expensive, hard-to-reverse step.

**On `dangerously_automated`.** A third mode used to be declared, commented
"auto-advance, no safety pauses, no logging". It did none of that:
`shouldPauseAtGate` is the whole gate decision and reads `mode === 'ask_first'`,
so every non-ask_first mode behaved identically. It is deleted, not
implemented — the only thing it promised beyond `auto_accept` was suppressing
the record, and a pipeline that automates itself without one is exactly what an
audit cannot reconstruct. `execution_mode` is an unconstrained TEXT column, so
read it through `normalizeExecutionMode` (in `@bicameral/shared/types`), never a
cast: it maps the retired string to `auto_accept` — what those runs actually
did — and anything unrecognised to `ask_first`.

**On `architect`.** The role is retired. Its brief-building function still runs, but folded into **step 1 under the researcher** (`runArchitect` is called from the researcher step, then `runResearcher` researches against that brief). The identifier survives in exactly two places, both deliberate: the `AgentRole` union in `@bicameral/shared` (stored historical records reference it) and a legacy `case 'architect'` in `model-router.ts`. It is not a current agent. It must not appear in product copy, in the admin panel's role list, or in any new pipeline step.

## Model routing

**`packages/cohere/src/model-router.ts` — `selectModel(step, complexity, tier)` — is the single source of truth for dispatch.** Anywhere the answer is persisted, displayed, or sent to Cohere, call it. Do not write a model string literal.

- Every non-enterprise role resolves to `command-a-03-2025` (`WORKHORSE_MODEL`) — reverted on 2026-08-27 from the 2026-08-21 switch to `command-a-reasoning-08-2025`. Cohere caps the newer chat variants at **1,000 calls a month even on a production key**, so every model the router handed out sat on the capped side of that line; `command-a-03-2025` costs the same per token, has a 256K context and the 8K output ceiling the coder's `maxTokens: 8192` already matches, and carries the full 500 req/min limit with no monthly cap.
- `tier === 'enterprise'` still resolves to `command-a-plus-05-2026`, which **is** capped — acceptable only because `chat()` now falls back (see below).
- Reasoning (`thinking`) is a property of the **model**, not the role. `getThinkingConfig(role, tier, model)` takes the dispatched model and returns `undefined` for anything outside `REASONING_MODELS`, and `chat()` drops the field before it reaches the wire for the same reason — every non-reasoning model answers a request carrying `thinking` with a 422, `{ type: 'disabled' }` included. Do not call `getThinkingConfig` without the model; `callAgentModel` sets `thinking` at the one place that knows it, so agents no longer pass their own.
- `command-r7b-12-2024` is **banned for the coder** — it emits 25-byte stub files instead of code. `selectModel` throws a circuit-breaker error rather than falling back.
- `PIPELINE_MODELS` in `packages/shared/src/constants.ts` is a **display-only mirror**. It has drifted from reality once already (finding M-19). Never dispatch from it.

`callAgentModel` in `apps/web/src/lib/cohere.ts` now takes an optional `tier` and forwards it to `selectModel`, so enterprise routing is reachable through the agents. It previously dropped the argument, and enterprise accounts were silently served the pro model. The tier had been threaded all the way down — `runAuditor`, `runVerifier` and `runDesigner` each take one, and researcher/coder read it off their context object for `getThinkingConfig` — and was discarded at the last hop. Pass it at any new call site; omitting it preserves the old behaviour for every tier except enterprise.

## Simulations are simulations

`simulation/` holds offline Monte Carlo experiments (the "Butterfly" series) exploring agent-topology parameters. Their outputs are **simulated predictions, never measurements of production traffic**.

**The 91.3 figure is gone from the code.** It was the simulator's `target_vdr`
input — what the operator typed in — not a bound anything computes, so
`vdrCeiling: 91.3` in `implementation-plan.ts`, the "67.7% of 91.3% ceiling"
line inside `NS3_SYSTEM_INSTRUCTION`, and the `vdr_gap: 23.6` derived from it
have all been removed. There was no defensible figure to put in their place —
no VDR has ever been measured against production traffic — so those passages
now state the simulated result and stop. `glaas/no-ceiling.test.ts` pins it,
asserting on the exported values and prompt strings rather than the source
text, because the source keeps one comment per site recording the removal.

Every other simulator output stays barred from customer-facing surfaces.

### The nightly Monte Carlo loop

`simulation/monte_carlo_engine.py` now runs on a schedule and its findings
reach a person. Five pieces, in the order the data moves:

1. `.github/workflows/simulation.yml` — 04:00 UTC daily. The Python cannot run
   in a Worker, and this is where it runs. A failure files (or comments on) one
   GitHub issue rather than opening a new one nightly.
2. The engine POSTs its report to `/api/simulation/ingest` (shared secret,
   mounted before `requireAuth`). It **used not to** — it wrote a JSON file and
   returned, which on a runner means the findings were deleted minutes later.
3. `0 6 * * *` in all three `crons` blocks → `handleSimulationWatchdog` reads
   the last two completed runs and calls `lib/simulation-watchdog.ts`, a pure
   module holding the four alert kinds and the three policy thresholds.
4. Alerts land in `simulation_alerts` (027) keyed on a UNIQUE `dedupe_key`, so
   a standing problem says so once a day and not once per tick.
5. The admin **Simulation** tab reads `/latest`, `/history` and `/alerts`.

Load-bearing:

- **The auto-apply boundary holds.** Nothing in this path writes production
  config, tripwires, knobs, or the engine's own parameters. `approved_by_admin`
  and `applied_to_architecture` are displayed as workflow states, never offered
  as buttons that do the applying. Remediation is a separate human-authored
  commit. `simulation-watchdog.test.ts` pins the copy that would start lying
  first if someone wired a remedy in.
- **The thresholds are policy, not measurement.** `VDR_REGRESSION_POINTS = 5`
  is a stated default with no measured noise band behind it, and the alert
  quotes both runs so the reader can disagree. Ground rule 2 covers the VDR
  figure itself: it is the engine's own per-turn classification over one
  night's bots, and it does not reach a customer surface.
- **Three files that never import each other are pinned against each other.**
  `cron-coverage.test.ts` reads `wrangler.toml` and `cron-handler.ts` as text —
  a cron with no `case` hits the `default:` branch, logs, and returns, which is
  a job that fires nightly and does nothing.
  `simulation-ingest-contract.test.ts` does the same for the Python payload and
  the route's `body.<key>` reads — a renamed key there stores NULL and answers 200.
- **Budget is explicit.** `--budget` lowers the engine's ceiling for a run and
  is **refused**, not clamped, above `TOTAL_CREDIT_BUDGET`. The workflow sets
  it. The spend is shown in the admin tab as `spent / budget`, read from the
  guard's own status inside the raw report.

Three defects were fixed at the root getting here, all of the same shape —
code that exists, looks finished, and does nothing: `simulationRoutes` was
imported by `index.ts` and never mounted; its handlers gated on
`c.get('isAdmin')`, which nothing in this codebase sets; and
`calculate_simulation_vdr` was defined _below_ the engine's `if __name__ ==
"__main__"` block, so it could not be called by the run it measures and
`vdr_percent` was NULL on every ingested row.

**Admin refusals are 403, not 401.** `lib/admin-middleware.ts` threw
`AuthError` (401) for both "no admin level" and "insufficient tier", which
tells an authenticated caller they are not signed in and invites a re-login
that cannot help. `packages/admin/tests/security/auth.test.ts` already stated
403 as the acceptance criterion; this middleware was the one place answering
otherwise.

**Correction:** this section used to say those two modules are "not imported by
`apps/web`; keep it that way." That was false. `routes/glaas.ts` imports
`glaas/lattice` and `routes/health.ts` imports `glaas/proactive-detection`,
both of which import `EVOLVED_GENOME` from `ns3-system-instruction.ts`, and
`index.ts` mounts both routes. What _was_ true is narrower and is why removing
the ceiling changed no behaviour: nothing anywhere imports
`NS3_SYSTEM_INSTRUCTION` or `POETIC_EQUATION_GAPS`.

## Development

```bash
pnpm install
pnpm dev                  # Vite dev server (apps/web)
pnpm --filter @bicameral/web dev:api   # wrangler dev (API only)
pnpm --filter @bicameral/web dev:all   # both
pnpm lint                 # eslint (flat config — no --ext flag; ESLint 9 rejects it)
pnpm format               # prettier
pnpm lint:migrations      # unique migration numbers, no gaps
pnpm test:unit            # vitest — 38 files, 530 tests
pnpm test:integration     # vitest + Miniflare, applies real migrations to a real D1
pnpm test:security        # tests/security/
pnpm test:e2e             # playwright, desktop + mobile projects
pnpm test:all             # lint:migrations + typecheck + unit + integration + security + e2e
pnpm build                # vite build (apps/web)
pnpm predeploy            # the deploy gate — see Deploying below
pnpm deploy               # gate, then build + wrangler deploy --env production
pnpm db:migrate           # apply migrations/*.sql to the REMOTE D1 — see the caveat below
```

Commits are gated by Husky: `pre-commit` runs lint-staged, `commit-msg` runs commitlint (Conventional Commits).

**`pnpm lint` currently reports 75 warnings and 0 errors.** The warnings are pre-existing (unused vars, `no-explicit-any`). Do not let the count grow; a new **error** must be fixed before commit.

**`pnpm test:integration` is the gate that matters** — it applies every migration to a real D1 inside Miniflare and exercises the real `requireAuth` middleware against the real routing stack. A broken migration fails here and nowhere else.

**There is an e2e suite as of the p0 safety-net merge.** `playwright.config.ts` defines
`desktop` and `mobile` projects and serves the built client through
`scripts/serve-client.mjs`; `tests/e2e/` holds the specs and `test:all` runs them.
This paragraph previously said no suite existed — that was true on main before the
merge and is no longer.

Note the specs target `/signin` for anything asserting a credential form. `/` serves
`MarketingSite` to signed-out visitors, so a sign-in assertion against the root
fails for a routing reason rather than a real one.

`test:security` runs **both** security suites. `tests/security/` (client-bundle,
headers) and `packages/admin/tests/security/` (admin auth) cover disjoint invariants;
a script naming only one silently drops the other.

## The independent auditor

The audit step runs on a **different provider's model** from everything it
audits. `selectModelInner()` used to return one model for every role, so the
audit stage was the researcher's own model grading the researcher's own output —
a second opinion from the same source, with the same blind spots, and nothing in
the logs able to tell that apart from a real audit.

`packages/cohere/src/auditor-model.ts` holds the pin
(`nvidia/nemotron-3-super-120b-a12b`, resolved against OpenRouter's live model
list on 2026-08-29 and re-resolved against NVIDIA's on 2026-08-30 — the header
records the comparison it came out of). It is called **directly at
`https://integrate.api.nvidia.com/v1`** on `NVIDIA_API_KEY`, not through
OpenRouter; `callModel` in `lib/cohere.ts` routes on the `nvidia/` vendor
prefix, so a pin that stopped carrying it would quietly go back out over the
OpenRouter key and 401.
`selectModel` resolves the auditor **before** the tier branch, because enterprise
used to short-circuit every role to Command A+ and would otherwise have put the
auditor back on Cohere for the accounts paying most for the gate.

- Override the model with the `AUDITOR_MODEL` var, not a code change.
  `resolveAuditorModel` throws on a slug without a `/` — that would route back
  through `chat()` and silently restore the self-audit.
- `auditor-independence.test.ts` fails if the auditor ever equals another role's
  model, at any complexity or tier. Do not "simplify" the `case 'auditor'` in
  `selectModelInner` back into the shared case; it is a throw on purpose.
- **No silent fallback.** If the auditor is unreachable the step throws and the
  run stops. It must never fall through to Cohere and report a pass.
- A **critical finding forces the gate even when the auditor reports
  `passed: true`**. Those are two independent fields of one model response and
  nothing reconciles them; only the severity is evidence.

### Auditing our own diffs

```bash
pnpm gate              # run the full gate, record .audit/gate-evidence.json
pnpm gate:quick        # typecheck + unit only; evidence is marked partial
pnpm audit:diff --task "what this change was for"
pnpm audit:calibrate   # prove the gate still catches a planted defect
pnpm audit:stats       # finding rate, calibration history, spend
```

`scripts/audit-diff.mjs` runs from the `commit-msg` hook — not `pre-commit`,
because the auditor needs to know what the change was _supposed_ to do and no
commit message exists yet at pre-commit. A HIGH finding aborts the commit.

The evidence file is stamped with the tree it was produced from and the audit
**refuses** if that stamp does not match: stale green test output is
indistinguishable from fresh green output by inspection, which is why it is
compared rather than trusted. A missing key, an unparseable response, or an
over-large diff are all refusals — never passes.

Requires `NVIDIA_API_KEY` **in the local environment**. The Worker having
the secret does not help; Cloudflare secrets are write-only.

Both scripts read the model, the endpoint and the key through
`scripts/auditor-provider.mjs`, which parses `auditor-model.ts` — the module
the Worker imports. They used to hold separate copies and had already drifted
(the commit gate read `AUDITOR_MODEL_DEV_FREE`, the system audit read
`AUDITOR_MODEL`), so the two gates audited on different models while both
reported "the pinned auditor".

**Audits are budgeted in tokens, not dollars.** `--budget-usd` is refused, not
ignored. NVIDIA Build publishes no per-token list price and the API returns no
rate, so a dollar ceiling would be enforced against a number this repo invented
— ground rule 2. `cost_usd` in a report is `null` (not `0`: "free" and "not
priced" are different claims) and carries a `cost_basis` saying why.

`AUDIT_SKIP=1 AUDIT_SKIP_REASON='…'` commits without the key, and records the
skip in `.audit/ledger.jsonl` so `pnpm audit:stats` counts it. Overruling a HIGH
is allowed and must be stated in the commit message; disappearing one is not.

### The self-healing loop

`scripts/self-heal.mjs` holds the §4C bounds — `MAX_ATTEMPTS = 3`, a convergence
check that stops a thrashing loop **even when attempts remain**, and
`check-fix`, a tripwire for fixes that only work by weakening the check
(skipped or deleted tests, `@ts-ignore`, `: any`, `|| true`, empty catches,
`continue-on-error`, deleted migrations, timeouts raised to hide a hang). Those
are escalations, never fixes. `scripts/self-heal.test.ts` pins both the patterns
and — as importantly — the legitimate shapes they must not catch, because a
tripwire that fires on correct code gets switched off.

Migration 025 holds `auditor_findings`, `auditor_runs` and
`self_healing_attempts`. Note `auditor_runs` records the _clean_ audits too:
"the auditor ran and found nothing" and "the auditor never ran" must not look
the same. Findings do **not** go in `audit_results` (019) — that table is
project-scoped and score-keyed for the admin governance auditor, and neither of
these has a project or a score.

## Deploying

```bash
pnpm deploy        # gate + wrangler deploy --env production
pnpm deploy:local  # same, + --containers-rollout none (hosts without docker buildx)
pnpm deploy:force  # skip the gate
```

`scripts/predeploy.sh` runs before every non-`:force` deploy: typecheck, lint,
unit + integration + security tests, build, `wrangler deploy --dry-run` against
the **production** environment, and a diff of `src/env.ts` against the secrets
actually provisioned on the Worker. Every check in it exists because something
here was once broken in a way a plain deploy did not catch. Unset secrets are a
warning, not a failure — the currently unset `FLUXYCHAT_API_KEY` degrades
rather than crashes. `SCITE_API_KEY`, `RESEND_API_KEY` and `TAVILY_API_KEY`
were provisioned on 2026-08-25.

- **Always deploy with `--env production`.** Named environments do not inherit top-level bindings or vars in wrangler v4, so `wrangler deploy` with no `--env` targets the top-level config — same worker name, different vars, **no `[[routes]]`**, which would drop the custom domains. The `deploy` scripts now pin `--env production` for this reason.
- The `[[containers]]` block builds `Dockerfile.preview`, which requires `docker buildx` (wrangler invokes `docker build --load`). On a machine without buildx, deploy the Worker alone with `--containers-rollout none`; the existing container image is left untouched.
- **`wrangler.toml` gotcha:** bare `key = value` lines placed _after_ a `[[table]]` header become fields of that table, not top-level vars. This has already happened once — five vars sat under `[[containers]]` and never reached the Worker. New vars go in a `[vars]` block, above the first `[[...]]` header.
- Named-environment blocks are **required duplicates**, not overrides. Adding a binding or var means adding it to `[vars]`, `[env.production.vars]`, and `[env.staging.vars]`.

## D1

`migrations/` holds 27 SQL files numbered 001–027 (`apps/web/migrations` is a
symlink to it, which is how `migrations_dir` in wrangler.toml resolves).

`pnpm db:migrate` is `scripts/migrate.mjs`, a thin wrapper over `wrangler d1
migrations apply`: it lints filenames first, prints what is pending, applies in
parsed-number order against the `d1_migrations` ledger, and **stops at the first
failure with a non-zero exit**. It defaults to `--local`; production needs an
explicit `--remote`.

It replaced a shell loop that tracked nothing and, worse, did not stop — `for`
ignores the body's exit status. Measured on a fresh local D1 with a deliberately
broken migration followed by a good one: the loop exited **0** and applied the
migration after the broken one; the runner exits **1** and applies nothing past
the failure.

Two consequences of the years under the loop are still live. The production
ledger records only `001_init.sql` (applied 2026-08-20), because nothing since
wrote to it — so the first `--remote` run will offer to apply 002–027 against a
database that already has them. They are written idempotently (`IF NOT EXISTS`,
guarded inserts) and all 27 apply cleanly to an empty local D1 and are a no-op
on a second run, but check the pending list before saying yes. Keep writing them
idempotently.

Named-environment `[[env.*.d1_databases]]` blocks now declare `migrations_dir`
explicitly. They inherit nothing from the top-level block, so it was previously
absent under `--env production` and only worked because wrangler's default
happens to be the same relative path.

**Known defects:**

1. ~~**Duplicate `015`**~~ — resolved: `015_user_events.sql` is now `024_user_events.sql`. The two files created disjoint tables with `IF NOT EXISTS` and neither referenced the other, so glob order between them never mattered and renumbering changed nothing that runs.
2. **Two incompatible `credit_ledger` schemas exist in the tree.** The live table is `001_init.sql`'s: `type`, `description`, `created_date`. `packages/admin/src/billing/credits.ts` writes `created_at` and reads `users.credits` (live column: `credits_remaining`) — it is exported but imported nowhere in `apps/web`, so nothing calls it. Reconcile before wiring that package in. When you write a ledger row, copy `lib/eicca.ts` or `lib/tripwires.ts`, which use the live columns.

## Auth (`apps/web/src/lib/auth.ts`)

Better Auth 1.6.26 on D1. Two settings here look optional and are not — both were verified broken against the live Worker on 2026-08-25, and reverting either silently disables brute-force protection:

- **`advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']`.** Without it better-auth cannot resolve a client IP on Workers and falls back to one shared per-path bucket (it logs exactly that). Use `cf-connecting-ip` specifically: Cloudflare sets it at the edge and strips inbound copies, so it cannot be spoofed — `x-forwarded-for` is caller-supplied and would let an attacker mint a fresh bucket per request.
- **`rateLimit.storage: 'database'`** (+ `modelName: 'auth_rate_limit'`, `migrations/023_auth_rate_limit.sql`). The default storage is a module-level `Map`, which on Workers is per-isolate and evictable, so counters never accumulate. `rateLimit.enabled: true` alone is not enough: with memory storage, eight back-to-back wrong-password `/api/auth/sign-in/email` posts all returned 401. With D1 storage: 401, 401, 401, 429.

Email goes through `lib/email.ts` → Resend. `RESEND_FROM_EMAIL` must be an address on `discomplemented.com` (the domain's Resend DNS lives in Cloudflare: DKIM at `resend._domainkey`, return-path MX + SPF on `send.discomplemented.com`). Do not put the `onboarding@resend.dev` sandbox back — it only delivers to the Resend account owner, so every real signup's verification email is dropped. User-facing email copy uses the public brand, **Discomplement**, matching `components/marketing/MarketingSite.tsx`.

The password-reset path on this version is `POST /api/auth/request-password-reset`. `/api/auth/forget-password` is a 404.

## Transcript verboseness

Three levels — `quiet` (gates and the result), `normal` (+ each agent's
conclusion), `verbose` (+ reasoning, tool invocations, and per-step model ids,
token counts and timings). `apps/web/src/lib/verboseness.ts` defines what each
one promises; the level is stored per user in `user_settings` (026) and read
through `normalizeVerboseness`, never a cast.

Four things about it are load-bearing:

- **The level is a projection, applied on read.** `GET /api/pipeline/:id/messages`
  re-reads the whole `agent_messages` history from D1 on every poll and filters
  it. That is what makes raising verbosity mid-run reveal what already happened
  instead of requiring a re-run. Filtering at write time would make a run
  recorded at `quiet` impossible to open up afterwards. Do not move it.
- **`stages` is returned at every level.** The panel derives each agent's status
  from `pipeline_steps`, not from the presence of that agent's `output` message
  — it used to do the latter, which meant a `quiet` run looked permanently
  stuck. A display preference must never change what the pipeline appears to
  have done. Only the telemetry _fields_ narrow with the level.
- **Redaction happens on the way out.** The stored record is the audit trail; a
  redacted copy is what reaches a browser. `redactSecrets` catches a
  credential-shaped key name and, separately, a credential-shaped _value_ under
  any key. Numbers and booleans under a secret-shaped key are exempt, because
  `tokensIn` matches the key pattern on the word "token" and is exactly what
  verbose mode exists to display.
- **An unclassified message type is `verbose`-only.** Add a type to
  `MINIMUM_LEVEL` when you add one; the default is deliberately the strict end,
  so forgetting over-hides rather than breaking quiet's promise.

`tests/security/client-bundle.test.ts` now guards both doors into a browser:
build-time inlining, and this runtime stream.

**On "tool calls" in verbose mode.** The agents make **no model-issued tool
calls**. `chat()` sends Cohere tool definitions purely as a structured-output
schema, and `chatWithToolLoop` has no call sites outside its own module. What
verbose shows is agent _code_ calling `pipeline/tools/` directly — `webSearch`
from the researcher, `writeFiles` and `runPreview` from the coder — recorded by
`lib/tool-record.ts` and labelled as that. Do not relabel these as model tool
calls; it would assert something false, that the model considered a tool.

## Pipeline legibility (the generation screen)

Everything the running screen says about a run comes from
`apps/web/src/lib/pipeline-legibility.ts` — the five stages and their reasons,
which stage is `done`/`active`/`gate`/`failed`/`pending`, the sentence naming
what the run is waiting on and what happens next, the elapsed-time format, the
error explanations, and the three preview tiers. It is a pure module with no
React import for one reason: `GenerationOrchestrator` drags in
`cloudflare:workers`, so nothing that touches the pipeline's own types can be
unit-tested from a node environment, and the sentences are the part worth
pinning. `PipelineStatus.tsx` and `ReviewGate.tsx` are layout over it. **Write
new user-facing pipeline copy there, not in the JSX** — the same rule as
`marketing/copy.ts`.

Four things are load-bearing:

- **`gate` is a status, not a flavour of `active`.** A stage that has stopped
  to ask a human is not a stage that is working, and a rail rendering both as
  "in progress" tells the founder to wait when the thing the run needs is
  them.
- **Nothing here formats a percentage.** Progress is "Stage 3 of 5", counted
  against the rail directly above it. This is the same constraint as ground
  rule 2 and a progress bar is the likeliest place to break it by accident;
  `pipeline-legibility.test.ts` asserts the absence of `%`.
- **The error's stage is captured in the reducer, at the moment the error
  arrives** (`usePipeline`'s `errorStep`), not read off live state at render
  time. `currentStep` keeps moving, and an error attributed to the wrong stage
  is worse than one attributed to none.
- **Signal colour, once.** Appendix B.2/B.7: magenta is the review gate's, and
  on this surface it is spent in exactly two rules — the `.review-gate` panel
  and `.pipe-rail__stage--gate`, which are the same gate said twice.
  `styles/gate-scarcity.test.ts` reads the stylesheet and fails on a third
  claimant. It ignores custom-property _aliases_ (`--mkt-signal:
var(--mkt-magenta)`) because declaring the token is not spending it.

**Step numbers are the orchestrator's.** `startStep` writes researcher 1 →
coder 5, and the SSE route sends `step.step_number`; the client derives the
agent name from that number and ignores the `agent` field beside it. The route
used to send a hard-coded `step: 4` for the Coder, so for the entire build the
UI reported the Designer as still working. `tests/integration/pipeline-stream.test.ts`
pins the two against each other. Do not write a step literal in that route.

`tests/e2e/pipeline-legibility.spec.ts` covers the two claims only a rendered
page can make — that the rail is on screen _during_ a run, and that the gate is
in the viewport without scrolling. It stubs `/api/**`, so it grades the UI
layer and not the backend; note that Playwright matches the **last** registered
route first, which is why the catch-all is registered before the specific ones.
`openRun` also waits for the status region once before returning: the view
boots a route chunk, a 2.9 MB Babel chunk and an iframe, and under load that
has taken longer than the 5s expect timeout — which then failed whichever
assertion came first and read as a missing gate. Assert against a mounted
surface, not against the boot.

## Coding conventions

- TypeScript strict mode. `pnpm --filter @bicameral/web typecheck` must stay clean.
- Hono routes return `c.json()` with `{ error: string, details?: string }` on failure.
- React components are functional with hooks — no class components.
- Styles use CSS custom properties (`styles/tokens.css`, `styles/theme.css`). Do not hardcode colors.
- Pipeline agents use Cohere structured outputs (tools) for JSON compliance between agents.
- Match the surrounding code's comment density. Comments in this repo tend to explain _why_ — especially where a non-obvious constraint (an OAuth callback, a token budget, a schema mismatch) drove the shape of the code. Keep that.

## Design reference (read-only)

`design/` holds 7 high-fidelity HTML specs — the canonical visual reference. **Do not modify them.** `design/README.md` explains usage.

| File                                 | What                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `01-ia-screen-inventory.html`        | Screen catalogue                                     |
| `02-user-flows.html`                 | Onboarding, pipeline, blueprint, deployment journeys |
| `03-design-system-tokens.html`       | Colors, typography, spacing, shadows → `tokens.css`  |
| `04-component-library.html`          | Component specs                                      |
| `05-memory-lattice-interaction.html` | 3D interaction model                                 |
| `06-hifi-responsive-layouts.html`    | Breakpoints, grids, sidebar collapse                 |
| `07-astroapp-concept.html`           | Theme system (Scorpio Dark / Libra Light)            |

The designer agent reads `01`–`04` for pattern matching; the coder agent references `04`.

## Other known gaps

- **Staging validation is still a simulator** — a seeded PRNG in the admin repo, not the real pipeline, so no "validated in staging" claim is supportable. The admin code now refuses to launder it: the staging worker returns `simulated: true`, `bot-runner` will not aggregate a flagged run into ~2 without an explicit opt-in, and `evaluatePromotion` cannot approve on a simulated ~2.
- ~~**The Merkle audit trail is broken by construction**~~ — fixed. The admin compiler's `merkle-verify.ts` is RFC 6962 (domain-separated `0x00`/`0x01` prefixes, positional siblings, audit-path verification over `(leaf, index, tree_size)`), the divergent duplicate in `deterministic-prng.ts` is gone, and a regression test pins that honest proofs verify and reordered traces do not. Tamper-evidence for the trace _root_ is supportable; it still says nothing about whether a trace entry's contents are true.
- **Scite cannot search.** `POST /search` does not exist (404), and the real
  `GET /api_partner/search` plus `POST /reference_check` are partner-tier and
  403 on this account. Do not write a query-by-text call against Scite without
  first confirming partner access. What works: `GET|POST /tallies`,
  `GET|POST /papers`, `/tallies/cited-by-sections/{doi}`,
  `/papers/resolve-pmid/{pmid}`, `/journal/{issn}/tallies`. The batch POSTs
  take a **bare JSON array of DOI strings**, not an object. The citation field
  is **`contradicting`**, not `contrasting` — reading the wrong name is how it
  silently returned 0 for a year. `lib/scite-research.ts` documents the
  measured contract; its fixtures are real captured responses.
- **Tavily is the second search backend** (`lib/tavily-research.ts`,
  research-engine phase 1b). Two calls per run: a general web search, and a
  search scoped to DOI-publishing domains at `advanced` depth whose only job
  is to feed Scite. Measured: the unscoped search yielded **0 DOIs** on a
  query where the scoped one yielded DOIs — since Scite cannot search, that
  scoped pass is the difference between phase 2 having input and having
  nothing. Validation runs **before** auth, so a 400 is not evidence the key
  is bad. `POST /research` (deep research) exists and is deliberately not
  wired up: the plan is 1,500 credits/month and `advanced` depth already
  costs more per call.
- **Cohere v2 has no connectors.** The v1 `connectors: [{id:"web-search"}]`
  mechanism does not exist on `/v2/chat`; tool use is the only grounding
  path. Five v2 wire-shape defects were fixed on 2026-08-25 — `chat()` was
  sending the v1 `citation_quality` (v2 answers **422** and fails the whole
  request), never parsing `message.citations`, dropping `toolCalls` and
  `toolCallId` from outgoing messages (**400 `tool_call_id is a required
field`**), and mapping only the plural `TOOL_CALLS` when v2 sends the
  singular `TOOL_CALL`. The last two were independently fatal:
  `chatWithToolLoop` had never completed a single tool call. Tool results
  must be sent as `{type:'document', document:{id, data}}` blocks — a plain
  JSON string is accepted but produces **no citations at all**. Set
  `document.id` to a source URL so citations resolve to something linkable.
  `citationMode: 'accurate'` 400s on every model this repo dispatches; only
  `'fast'` works.
- **Cohere embeddings are not deterministic** across identical requests on the hosted API (measured twice), and `packages/cohere/src/embed.ts` adds no caching or content-addressing. Treat an embedding as an index into a content-addressed store, never as an identity.
- ~~**Every tier is exposed to Cohere's 1,000-call _monthly_ cap**~~ — resolved
  on 2026-08-27 for every tier except enterprise, which now degrades instead of
  failing. The cap follows the **model variant**, not the key type: the account
  key is a production key and that never exempted it. Cohere applies the cap to
  trial keys and to prod keys on newer chat variants — `command-a-plus-05-2026`
  and `command-a-reasoning-08-2025` are both on that list, and until this date
  the router dispatched nothing else. Measured 2026-08-25: an enterprise run
  died at step 1 with `429 "You are past the per-month request limit for this
model"`. Non-enterprise roles now route to the uncapped `command-a-03-2025`.
  `cohereRequest` fails fast on that specific 429 rather than spending three
  retries against an exhausted quota (`COHERE_MONTHLY_QUOTA_EXHAUSTED`), and
  `chat()` catches it to retry once on `quotaFallbackModel(model)` with
  `thinking` stripped. **The enterprise fallback is Johnathan's product
  decision** (2026-08-27), reversing the previous note here that there
  deliberately was none: an enterprise run that stops at step 1 is worth less
  to the account holder than the same run completed on Command A. It is logged
  (`console.warn`) every time it fires, and it is not a substitute for a higher
  Cohere plan.
- ~~**`RESEND_FROM_EMAIL` is still Resend's shared sandbox domain**~~ — resolved; it is `noreply@discomplemented.com` and the domain's Resend DNS lives in Cloudflare. See the Auth section above.
- ~~**`COHERE_MODELS.pro` still points at the retired `command-a-03-2025`**~~ — fixed; it is now `command-a-reasoning-08-2025`, matching what `selectModel` resolves and what `PIPELINE_MODELS` already said. This map is genuinely dispatched (`routes/generate.ts:46` does `COHERE_MODELS[tier]`, `pipeline/consciousness.ts:370` passes `.pro` straight to `chat()`), so the retired id was reaching the Cohere API on every pro-tier call. The M-19 sweep corrected every other site and missed this one.

See `README.md` for the same ground truth in prose form.
