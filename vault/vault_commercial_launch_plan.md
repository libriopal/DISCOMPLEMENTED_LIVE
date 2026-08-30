# Commercial Launch Plan — Gap Audit & Implementation-Ready Spec

**Status:** APPROVED FOR IMPLEMENTATION 2026-08-11. Verified against direct repo reads (`vault/bootstrap/01-07`, live grep of `apps/web/src/lib/auth.ts`, repo-root search for legal docs — none exist). Supersedes nothing; extends `vault_saas_blueprint_v4_implementation_plan.md` (infra/cost track) with the commercial-readiness track (auth, legal, UX completeness, security verification).

**Execution mode (user-approved 2026-08-11):** Fully unattended multi-agent loop. Constraints: (1) every diff touching auth, secrets, deploy config, payment code, or legal-doc-adjacent routes gets a `bitoreview --prompt-only` pass before being treated as done, per the standing BitoReview protocol; (2) UI/UX work must reference `design/01-07*.html` (canonical, per `CLAUDE.md`) and `vault/html.zip`'s lattice-spec drafts where relevant, not invented from scratch; (3) genuinely irreversible real-world actions — going live with real Stripe keys, buying a domain, spending beyond a free tier, publishing legal docs as final/binding — remain **hard stops** requiring the user's explicit go-ahead, consistent with the standing zero-budget constraint. The loop drafts and prepares all of these but does not flip them live.

---

## 1. Competitive framing

Bicameral's real differentiator against Bolt.new/Lovable/v0 is already architectural, not aspirational: those three lean entirely on Supabase and client-side/edge preview with no persistent server-side execution of their own. Bicameral already has a real 4-agent research→design→code pipeline with a human gate, a real Cloudflare Workers/D1/R2/Vectorize backend, and (per `vault_saas_blueprint_v6_addendum_free-trials.md` §2, approved) a Phase-2 stateful sandbox layer (Freestyle/E2B) queued in. That's the Replit-Agent-class claim — a persistent backend, not just a rendered preview.

What's missing isn't architecture. It's the unglamorous commercial-readiness layer: accounts that don't require GitHub, legal documents, and closing the gap between "routes exist" and "a paying stranger can use this end-to-end without hitting a stub." That's this document's scope.

## 2. Gap audit — what's real vs. what's needed

| Area              | Current state (verified)                                                                                                        | Gap                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | Better Auth, GitHub OAuth only (`apps/web/src/lib/auth.ts`) — `socialProviders: { github }`, no `emailAndPassword` block        | No email/username/password path at all. Founders without (or unwilling to use) GitHub can't sign up.                                                                                                                                                                                                                       |
| Legal             | Zero files matching `*terms*`, `*privacy*`, `*consent*` anywhere in the repo (confirmed by direct search)                       | No ToS, Privacy Policy, Cookie notice, or Acceptable Use Policy exist. Nothing gates signup on consent.                                                                                                                                                                                                                    |
| Billing           | `STRIPE_PUBLISHABLE_KEY`/`STRIPE_SECRET_KEY` provisioned in `env.ts`, **no routes wired** (confirmed, `vault/bootstrap/07`)     | Can't actually charge anyone. Free trial credits (`trial_expires_at`, 30 days) are the only monetization primitive that currently functions.                                                                                                                                                                               |
| Tier-3 preview    | `PREVIEW_SANDBOX` DO wired, no backing container image anywhere (`vault/bootstrap/04`)                                          | Full-stack preview claim is aspirational until Phase-2 hybrid (§2.8 of the implementation plan) ships.                                                                                                                                                                                                                     |
| Security scanning | GitHub-Actions Semgrep gate live and wired (`security-scan-gh.ts`, `security-gate-webhook.ts`)                                  | Real and functioning — but the CI/CD hardening from `vault_saas_blueprint_v6_addendum_free-trials.md` §6 (job separation, minimal `permissions:`, SHA-pinned Actions) isn't applied to `security-gate.yml` yet — becomes higher-stakes once real user code + real deploy credentials are involved in a commercial setting. |
| Admin panel       | Full: metrics, security, bottlenecks, recommendations, user management (`vault/bootstrap/05` route table)                       | Functionally complete; no gap for launch.                                                                                                                                                                                                                                                                                  |
| Doc accuracy      | `CLAUDE.md`'s "Current State" paragraph and `agent_docs/database-schema.md` are stale (`vault/bootstrap/07`, doc-drift pattern) | Low priority, real but cosmetic; not a blocker to commercial launch.                                                                                                                                                                                                                                                       |

## 3. Auth: email/username/password (user-approved: Better Auth built-in provider)

Add to `apps/web/src/lib/auth.ts`'s `betterAuth({...})` config:

```typescript
emailAndPassword: {
  enabled: true,
  requireEmailVerification: true,   // gates first login until verified — see 3.1
  minPasswordLength: 12,
  autoSignIn: false,                 // don't sign in before verification completes
  sendResetPassword: async ({ user, url }) => { /* 3.2 */ },
},
emailVerification: {
  sendVerificationEmail: async ({ user, url }) => { /* 3.1 */ },
  sendOnSignUp: true,
},
```

**3.1 — Verification email delivery.** No transactional email provider exists in the repo today (`env.ts` has no `RESEND_API_KEY`/`SENDGRID_API_KEY`/etc.). This is a genuine new dependency, not configuration. Cloudflare has no built-in outbound email primitive usable here. Recommendation: Resend (free tier: 3,000 emails/mo, 100/day, no card required — verify against `resend.com/pricing` before implementing) via `fetch()`, matching the project's existing direct-fetch pattern for Cohere (no SDK). This is a new **secret** (`RESEND_API_KEY`) and a new **non-secret var** (verified sender domain) — flag to user before first live send, since verifying a sender domain requires DNS access the agent doesn't have.

**3.2 — Password reset.** Same email primitive, same `sendResetPassword` hook. Better Auth issues the token/URL; no new table needed (`verifications` already exists per migration 002).

**3.3 — Schema impact.** None beyond what migration 002 already created (`users.email_verified` column already exists — confirmed, `vault/bootstrap/03`). `emailAndPassword` uses the same `users`/`accounts`/`sessions` tables Better Auth already manages.

**3.4 — Rate limiting.** Better Auth's own `rateLimit: { window: 60, max: 5 }` already throttles the auth endpoint generally; email/password adds brute-force surface (login attempts) that GitHub OAuth doesn't have. Verify Better Auth's per-route rate-limit granularity covers `/sign-in/email` specifically before shipping — if not, add an explicit limit on that route.

**3.5 — Frontend.** `LoginScreen.tsx` currently renders GitHub-only. Needs an email/password form (sign up, sign in, forgot password) added alongside the existing GitHub button — reference `design/04-component-library.html` for form/input/button specs, not a new pattern.

## 4. Legal documents (drafted now, flagged for real review before going live — per user decision)

Four documents, grounded in what the app actually does (not generic boilerplate): collects email + optional GitHub identity, stores generated project code in R2, uses Cohere's API (third-party processor) to process prompts, uses OpenRouter for the free-tier model, issues virtual API keys, tracks usage/credits, and (once wired) will process payments via Stripe.

1. **Terms of Service** — account eligibility, acceptable use (no illegal-content generation via the pipeline), IP ownership of generated code (user owns their output), service-level disclaimers (beta/no uptime SLA), credit/billing terms, termination.
2. **Privacy Policy** — what's collected (email, GitHub profile if linked, prompts, generated code, usage telemetry via Analytics Engine), third-party processors named explicitly (Cohere, OpenRouter, GitHub OAuth, Stripe once live, Resend for transactional email), retention, user rights (export/delete — map to existing `admin.ts` `GET /export` route and a new self-service delete path), no sale of data.
3. **Cookie / consent notice** — session cookie (Better Auth) is functionally required, not optional; disclose it plainly rather than a full cookie-consent-banner apparatus (no third-party ad/tracking cookies exist today, so this is short).
4. **Acceptable Use Policy** — folded into ToS or kept separate; explicitly bars using the pipeline to generate malware, credential-harvesting tools, or content that violates Cohere's own usage policies (inherits obligations from being a Cohere API consumer).

Signup flow gate: a required, unchecked-by-default checkbox ("I agree to the Terms of Service and Privacy Policy") on both the new email/password form and the GitHub OAuth first-login completion step — GitHub OAuth today has no consent capture at all, which is itself a gap independent of the new auth method.

**Explicit flag, not a formality:** these are real drafts an engineer can ship behind a consent checkbox, but they are not a substitute for actual legal review before the app accepts non-trial users or real payments. Do not represent them as legally reviewed.

## 5. Full user-facing functionality audit

Walking the founder's actual path end-to-end against the real route table (`vault/bootstrap/05`):

- Sign up → generate → approve blueprint → deployed app: **real**, all 4 pipeline steps + human gate wired.
- View/manage projects, files: **real** (`projects.ts`, 7 routes).
- Memory Lattice visualization: **real** (`lattice.ts` + `LatticeManager` DO, WebSocket-backed).
- Usage/credits view: **real** (`usage.ts`, 3 routes, backed by `credit_ledger`).
- Live chat support: **real** (`FluxyChatWidget`).
- **Pay for more credits when the 30-day trial ends: not real.** Stripe keys exist, no routes. This is the actual conversion-to-revenue gap, higher priority than it might look from the infra docs alone — a founder who exhausts trial credits today has no path to become a paying customer.
- **Full-stack (Tier-3) preview fidelity for backend-heavy apps: not real yet**, degrades to Tier-1/2 client-side preview. Phase-2 hybrid (already approved, `vault_saas_blueprint_v4_implementation_plan.md` §2.8) closes this.

Priority for commercial launch, in order: (1) auth breadth (§3), (2) legal gate (§4), (3) Stripe wiring — was previously deferred behind infra work, **this audit reprioritizes it above Phase-2 sandbox work**, because a user who can't pay is a harder blocker to "commercial" than preview fidelity is.

## 6. Security verification for commercial readiness

Beyond the CI/CD hardening already specified in `vault_saas_blueprint_v4_implementation_plan.md` §2.3.1 (job separation, minimal `permissions:`, SHA-pinned Actions — apply this to `security-gate.yml` as part of this plan, not deferred):

- Password hashing: confirm Better Auth's default (scrypt) is used as-is, no custom hashing — don't reinvent this.
- Session cookie flags: confirm `Secure`, `HttpOnly`, `SameSite` are set appropriately for the production domain once one exists (currently dev-only trusted origins per `vault/bootstrap/04`).
- Virtual key hashing: already SHA-256-hashed at rest, raw key shown once (`vault/bootstrap/04`) — correct pattern, no change needed.
- Rate limiting: existing 1-hour sliding window (`checkRateLimit`) covers API usage; confirm it also meaningfully covers auth endpoints (§3.4).
- Admin panel access: confirm `admin_level` gating is enforced on every `admin.ts` route, not just the UI — direct route-level check, since this panel can read/export user data.
- Secrets: no new pattern needed, `wrangler secret put` already the convention; the new `RESEND_API_KEY` follows it.

## 7. Implementation phases → subagent roles

Mirrors Bicameral's own pipeline shape (Architect/Researcher/Designer/Coder), applied to this meta-work:

| Phase | Scope                                                            | Subagent role                                                     | bitoreview gate?                           |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| A     | Email/password auth (§3), consent checkbox (§4 gate)             | Research (Better Auth docs + Resend terms) → Plan → Write → Audit | Yes — touches auth                         |
| B     | Legal doc drafts (§4)                                            | Write → Audit (internal consistency, not legal sign-off)          | No (no code diff)                          |
| C     | Stripe route wiring (checkout, webhook, credit top-up)           | Research (Stripe API) → Plan → Write → Audit                      | Yes — touches payments                     |
| D     | CI/CD hardening on `security-gate.yml` (§6, from v6-addendum §6) | Write → Audit                                                     | Yes — touches deploy credentials           |
| E     | Frontend: auth forms, consent checkbox, billing UI               | Write (reference `design/04`, `design/06`) → Audit                | Only if it touches auth/payment call sites |
| F     | Phase-2 stateful sandbox (already approved, separate doc)        | Unchanged, sequenced after A-E per implementation plan §4         | Yes                                        |

Loop mechanics: each phase runs as research→plan→write→audit sub-steps via the Agent tool, committed incrementally (never one giant commit), with `bitoreview review --prompt-only 2>&1 | tee <unique_temp_file>` run against any diff flagged in the table above before that phase is marked done, per the standing global BitoReview protocol. Real deploys, live Stripe mode, and publishing legal docs as binding remain hard stops for the user, not the loop.

## 8. Sequencing

1. Phase A (auth) and Phase B (legal drafts) in parallel — no shared files.
2. Phase D (CI/CD hardening) — small, mechanical, do early since it's a known finding already, not new research.
3. Phase C (Stripe) — depends on nothing above but is the highest-value gap; do after A/B/D land so the consent gate exists before payment collection does.
4. Phase E (frontend) — depends on A and C both having real endpoints to call.
5. Phase F (Phase-2 sandbox) — already sequenced in the implementation plan, unaffected by this document, runs after.
