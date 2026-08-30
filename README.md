# COMPaNiON / Bicameral

The production repository behind **discomplemented.com** — a Cohere-native prompt-to-app platform on Cloudflare Workers. A multi-agent pipeline researches and designs an application before any code is written; a human approves the blueprint; only then does the coder agent build and deploy.

> **About this file.** It was previously an "Auditor Handoff Prompt" that asserted its own contents as verified fact and asked a reader to check boxes against them. Several of those claims were false against the repository (see [History](#history) at the bottom). It has been rewritten as an ordinary README describing what is actually on disk. Where a number is a simulation output rather than a measurement, it says so.

---

## Repository identity

|                    |                                                                           |
| ------------------ | ------------------------------------------------------------------------- |
| Package name       | `bicameral` (`package.json`)                                              |
| Domain             | `discomplemented.com` (`apps/web/wrangler.toml`)                          |
| Runtime            | Cloudflare Workers — `compatibility_date = "2026-08-01"`, `nodejs_compat` |
| Deploy entry point | `apps/web/src/index.ts` (the root `wrangler.toml` is a retired stub)      |
| D1 database        | `bicameral` (`24dd57ec-9c20-46df-aaa9-d4f99dc570bb`)                      |
| R2 bucket          | `bicameral-assets` (generated project files)                              |
| Vectorize index    | `bicameral-lattice`                                                       |
| Node / pnpm        | `>=22.0.0` / `>=9.0.0`                                                    |

## Stack

- **Frontend:** React 19, Vite, UnoCSS, Framer Motion, Three.js, Zustand
- **Backend:** Hono on Cloudflare Workers, D1, R2, Vectorize, Durable Objects
- **AI:** Cohere API v2 via direct `fetch()` — Command A Reasoning, Embed v4.0, Rerank v4.0
- **Auth:** Better Auth on D1 (email/password + GitHub OAuth)
- **Payments:** Stripe — see the caveat under [Pricing](#pricing-is-provisional)
- **Tooling:** pnpm workspaces, ESLint, Prettier, Husky + commitlint (Conventional Commits), Vitest, Playwright
- **CI:** GitHub Actions — `ci.yml`, `deploy.yml`, `security.yml`, `security-gate.yml`, `sanitize.yml`, `dependency-review.yml`

## Layout

```
apps/web/            # the deployed Worker + React SPA
  src/index.ts       # Hono app; mounts every /api/* route
  src/routes/        # route modules (see below)
  src/pipeline/      # agents, tools, gates, lattice enrichment
  src/durable-objects/  # GenerationOrchestrator, lattice manager, sandbox
  src/components/    # marketing/, LoginScreen, IDE, admin panel
  src/views/         # authenticated app views
packages/shared/     # types, schemas, constants
packages/cohere/     # Cohere + OpenRouter wrappers, model-router.ts
packages/admin-stub/ # admin surface; every op throws (real impl: DISCOMPLEMENTED_ADMIN)
migrations/          # D1 migrations, 001–024
simulation/          # offline Monte Carlo experiments (not production code)
```

## Public surface

`/` serves the marketing site to signed-out visitors (`components/marketing/MarketingSite.tsx`); `/signin` serves the auth form; `/legal/*` serves the legal documents; every other path falls through to the authenticated SPA. Static assets use `not_found_handling = "single-page-application"` with `run_worker_first = true`, so `/api/*` always reaches the Worker (this is what keeps the GitHub OAuth callback from being swallowed by the asset handler).

## API surface

`apps/web/src/index.ts` mounts **32** route groups. Webhook routes are mounted before the authenticated groups so they bypass session middleware:

`/api/auth` · `/api/chat/webhook` · `/api/security-gate` · `/api/billing` (webhook + authed) · `/api/eicca/webhook` · `/api/simulation/ingest` · `/apps` · `/api/genome` · `/api/deploy` · `/api/figma` · `/api/pipeline` · `/api/generate` · `/api/research` · `/api/projects` · `/api/lattice` · `/api/usage` · `/api/preview` · `/api/admin` · `/api/chat` · `/api/value` · `/api/cost-hud` · `/api/eicca` · `/api/glass-engine` · `/api/vdr` · `/api/entitlements` · `/api/tripwires` · `/api/dunning` · `/api/preferences` · `/api/health` · `/api/glaas` · `/api/user-events`

## D1 migrations

`migrations/` holds **24 SQL files, numbered 001–024** (015 is used once; there is no 015b):

```
001_init                 008_credit_ledger_ext    015_preference_matrix
002_auth_and_vkeys       009_health_scores        016_eicca
003_lattice_node_content 010_tripwire_events      017_tripwire_retry_column
004_security_gate        011_decisions            018_simulation_runs
005_billing              012_lattice_executions   019_user_roles
006_rate_limit_race_fix  013_cost_events          020_figma_integrations
007_entitlements         014_dunning_workflow     021_consensus_pipeline
                                                  022_iteration_loop_state
                                                  023_auth_rate_limit
                                                  024_user_events
```

The `015` collision is resolved: `015_user_events.sql` is now `024_user_events.sql`. It was safe to renumber — it and `015_preference_matrix.sql` create disjoint tables with `IF NOT EXISTS`, neither references the other, and no other migration references either table, so glob order between them never mattered. Nothing tracks applied migrations by number yet, but the numbers are now unique if something starts to.

The exact table count has not been re-derived file by file; treat any specific total as unverified until it is.

## The pipeline

Five roles, in order, with a human gate before code generation:

```
research → audit → verify → design → [HUMAN APPROVES BLUEPRINT] → code
                     ↖________________________________________↗  feedback loop
```

`packages/cohere/src/model-router.ts` is the single source of truth for dispatch. As of 2026-08-21 every non-enterprise role resolves to `command-a-reasoning-08-2025`; enterprise resolves to `command-a-plus-05-2026`. Reasoning is enabled for the auditor and verifier and disabled elsewhere to conserve output tokens. `PIPELINE_MODELS` in `packages/shared/src/constants.ts` is a display-only mirror — call `selectModel()` anywhere the answer must be authoritative.

An earlier `architect` role is retired; the researcher now produces the brief. The enum value survives in `AgentRole` for stored historical records, but it is not a current agent and should not appear in product copy.

## Pricing is provisional

`packages/shared/src/constants.ts` marks the $29 Pro / $99 Team tiers as **placeholder prices — no live Stripe account exists yet**. The marketing site therefore carries a mandatory "Early access — subject to change" badge. Remove the badge only when real Stripe pricing exists.

## Simulation results are simulations

`simulation/` contains offline Monte Carlo experiments (the "Butterfly" series) used to explore agent-topology parameters. Their outputs are **simulated predictions, never measurements of production traffic**, and they are not customer-facing:

- Butterfly v6 held-out fitness ≈ 56–57 across four population islands, with a negative overfit gap (held-out ≥ train).
- The reported VDR figures (~66–68%) come from that simulator, against a `target_vdr` parameter of 91.3.

That 91.3 figure is **an input constant, not a derived ceiling**. Nothing in the codebase derives it, and no quality or VDR percentage appears anywhere on the public site for that reason. Do not present it — or any simulator output — as a product quality metric.

## Development

```bash
pnpm install
pnpm dev                  # Vite + wrangler dev
pnpm lint                 # eslint apps/web/src packages/*/src
pnpm format               # prettier
pnpm test:unit            # vitest
pnpm test:integration     # vitest, integration config
pnpm test:security        # tests/security/
pnpm test:all             # unit + integration + security (no e2e — see below)
pnpm build                # vite build (apps/web)
pnpm predeploy            # the gate: types, lint, all tests, build, wrangler
                          #   dry-run against the production env, and a diff of
                          #   src/env.ts against the provisioned secrets
pnpm deploy               # predeploy gate, then build + deploy --env production
pnpm deploy:local         # same, plus --containers-rollout none for hosts whose
                          #   Docker has no buildx (wrangler's container image
                          #   build calls `docker build --load` and dies 125)
pnpm deploy:force         # skip the gate
pnpm db:migrate           # apply migrations/*.sql to the remote D1 database
```

Commits are gated by Husky: `pre-commit` runs lint-staged, `commit-msg` runs commitlint (Conventional Commits). Secrets go through `wrangler secret put` — never into the repository.

See `CLAUDE.md` and `agent_docs/` for architecture detail, and `design/` for the visual reference specs.

## Verified against production, 2026-08-25

Checked by running against the live Worker, not by reading code:

- `discomplemented.com` and `www.discomplemented.com` both serve 200;
  `/api/healthz` returns `{"status":"ok","environment":"production"}`;
  `/api/health` correctly returns 401 (it is the authenticated per-user
  health-score API, not the liveness probe).
- The shipped client bundle contains no "Architect", no `91.3`, and no quality
  percentage; the "Early access" pricing badge is present. (Every `%` in the
  bundle is a CSS value.)
- **Transactional email sends.** `RESEND_FROM_EMAIL` was the
  `onboarding@resend.dev` sandbox, which only delivers to the Resend account
  owner — so verification email for any real signup was dead on arrival. It is
  now `noreply@discomplemented.com`; discomplemented.com carries Resend's DNS
  record set in Cloudflare (DKIM at `resend._domainkey`, return-path MX + SPF
  on `send.discomplemented.com`). A live POST to
  `/api/auth/request-password-reset` returned 200 with no exception in
  `wrangler tail`, which means Resend accepted a send from the domain address —
  it would have rejected an unverified sender regardless of recipient.
- **Auth rate limiting now actually fires.** Two separate defects, both found
  by attacking the live endpoint: better-auth could not resolve a client IP
  under Workers and fell back to one shared per-path bucket (fixed with
  `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']` — Cloudflare sets
  that header at the edge and strips inbound copies, so it cannot be spoofed),
  and rate-limit state lived in a per-isolate in-memory `Map` that never
  accumulated (fixed with `rateLimit.storage: 'database'` +
  `migrations/023_auth_rate_limit.sql`). Before: eight wrong-password
  `/api/auth/sign-in/email` posts, all 401. After: 401, 401, 401, then 429 —
  matching better-auth's built-in `window=10s, max=3` rule for that path, with
  the counter row keyed `<ip>|/sign-in/email` in D1.
- `POST /api/auth/forget-password` is a 404 on this better-auth version; the
  path is `/api/auth/request-password-reset`.

## Known gaps

1. ~~**Duplicate migration number 015.**~~ Resolved — `015_user_events.sql` is now `024_user_events.sql` (above).
2. **`credit_ledger` has two incompatible schemas in the tree.** The live table is the one from `001_init.sql` (`type`, `description`, `created_date`). `packages/admin/src/billing/credits.ts` writes `created_at` and reads `users.credits` (the live column is `credits_remaining`), so those helpers would fail against the real database — they are exported from `packages/admin/src/billing/index.ts` but not imported anywhere in `apps/web`, so nothing calls them today. Reconcile them before wiring that package in. (`migrations/019_user_roles.sql` used to re-declare the table and index a `created_at` column that does not exist; that statement aborted any fresh migration run and has been removed.)
3. **Staging is still a simulator.** The staging validation path in the admin repo is a seeded PRNG, not the real pipeline, so no "validated in staging" claim is supportable today. What changed is that the code now refuses to pretend otherwise: `staging-worker` returns `simulated: true`, `bot-runner` will not aggregate a flagged run into ~2 without an explicit opt-in, and `evaluatePromotion` cannot return `approved: true` on a simulated ~2. The gap is unclosed; it just can no longer be closed by accident.
4. ~~**Merkle audit trail is broken by construction.**~~ Fixed — the admin compiler's `merkle-verify.ts` is now RFC 6962 (domain-separated `0x00`/`0x01` prefixes, positional siblings, audit-path verification over `(leaf, index, tree_size)`), the divergent second implementation in `deterministic-prng.ts` is deleted, and `tests/merkle.test.ts` pins that honest proofs verify and reordered traces do not. Tamper-evidence claims are supportable for the trace root; note that they say nothing about whether the _contents_ of a trace entry are true.
5. **Cohere embeddings are not deterministic** across identical requests on the hosted API — measured twice (800-call and 5-call live checks, both non-deterministic), and `packages/cohere/src/embed.ts` adds no caching or content-addressing layer. Nothing may depend on embedding output being stable: treat an embedding as an index into a content-addressed store, not as an identity.
6. **Non-enterprise dispatch is quota-exposed.** Every non-enterprise role routes to a self-serve, rate-limited Cohere model. (Enterprise dispatch previously did too, for a different reason: `callAgentModel` took no `tier`, so `selectModel`'s enterprise branch was unreachable and enterprise accounts silently got the pro model. The tier is now threaded through.)
7. **Security test scaffolding** in `packages/admin/tests/security/` still needs D1 mocking to assert anything real. (The `test:security` script used to point at `tests/security/`, a directory that does not exist; vitest treated the argument as a name filter and matched the admin suite by accident.)
8. **There is no e2e suite.** No Playwright config and no specs exist in this repo, so `pnpm test:e2e` now fails with a message saying so, and `test:all` no longer includes it. Do not cite e2e coverage.
9. **`SCITE_API_KEY` is provisioned; `FLUXYCHAT_API_KEY` is not.** Scite was
   wired against a live key on 2026-08-25, and the exercise found that the
   module had been written entirely against an imagined API: it called
   `POST /search`, which returns **404** because no such endpoint exists, and
   it read a citation field named `contrasting`, which Scite spells
   `contradicting` — so the one number that would signal "the literature
   disputes this" was structurally always zero. The real search endpoint,
   `GET /api_partner/search`, is partner-tier and returns 403 on this
   account, as does `POST /reference_check`. **Scite cannot search for us.**
   What it can do is answer questions about DOIs we already have, so the
   research engine now extracts DOIs from the You.com phase and enriches them
   via `POST /tallies` and `POST /papers` (both of which take a bare JSON
   array of DOI strings). See `lib/scite-research.ts` for the measured
   contract; its tests use response bodies captured from the live API.

   `FLUXYCHAT_API_KEY` is still unset, and the support chat is inert.
   `lib/fluxychat.ts` fails closed: `mintChatSession` and
   `provisionSupportAgent` throw a named error saying which secret is
   missing, `verifyToolWebhookSecret` rejects, and `POST /api/chat/token`
   answers 503 rather than 500. Beyond the key, **no FluxyChat Worker is
   deployed** at `FLUXYCHAT_WORKER_URL` — that host 404s — so there is no
   upstream to authenticate against even once a key exists. `pnpm predeploy`
   reports the unset secret as a warning on every run.

   Both keys are `?: string` in `env.ts`. They were `string`, which told
   every new call site they were guaranteed; the typechecker then found the
   path that sent `Authorization: Bearer ` to a third party on every research
   run, and the one that would have sent `X-Fluxy-Api-Key: undefined`.

10. **Deploys must pass `--env production`.** Named environments do not inherit top-level config in wrangler v4, and the top-level block defines no `[[routes]]` — deploying it would drop the custom domains. Both `deploy` scripts now pin the flag.

## History

The previous version of this file was a stale audit prompt from an earlier review round. It claimed migrations 006–012 were absent (they exist), claimed only `/api/health` was wired (32 route groups are mounted), listed migration table names under wrong numbers, and carried a "P0–P3 Remediation Status … FIXED" table that was never independently re-verified. Those claims are removed rather than corrected in place, because a document that declares itself authoritative and invites confirmation rather than verification is the wrong shape for a README. The commit history remains the record of what was fixed and when.
