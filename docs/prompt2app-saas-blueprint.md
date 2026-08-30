# Prompt2App SaaS — Architectural Blueprint & Baseline Implementation Plan

**North Star (the one metric everything serves):**

> _Know when a user is not getting what they are paying for — and catch it before they tell you, and before it is too late._

Every subsystem below is justified only by how it feeds that sentence. If a component does not
produce a signal, a correction, or a refund/credit decision for that sentence, it is optional.

Scope note: the uploaded archive `Comperator-main.zip` (crawl → classify → summarize → LLM
comparative gap analysis, Streamlit UI) is used two ways in this blueprint: (1) as the **market
baseline engine** that continuously benchmarks the reference set below, and (2) as the structural
template for the **Value Assurance** loop (crawl your own product's runtime the way it crawls a
competitor's site). The second upload, _Payments for SaaS Platforms For Dummies_ (NMI Special
Edition, Wiley 2025), grounds §6: partner-enabled embedded payments now, hybrid/ISO-plus-SaaS at
scale, PayFac deferred — with its post-integration metrics folded into Value Assurance.

---

## 1. The reference field and what it establishes

| Reference                   | What it proved is _table stakes_                                         | What it proved is _differentiator_                 | What it leaves open                                      |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| Lovable.dev                 | Chat→app, live preview, managed backend, publish, one-click integrations | Design-system-first generation; visible file diffs | Little runtime proof the app _works_ for the paying user |
| Replit Agent                | Full VM, real shell, package installs, deploys, DB                       | Agent that can run/verify its own work             | Cost opacity; long runs burn credits invisibly           |
| Base44                      | All-in-one backend (auth/db/storage/email) with zero config              | Non-technical completion rate                      | Ceiling on control/escape hatch                          |
| Bolt.new                    | Instant WebContainer preview, fast iteration                             | Zero-latency feedback loop                         | No server-side runtime truth                             |
| Emergent.sh                 | Long-horizon autonomous agent runs                                       | Task decomposition + self-testing                  | Trust gap during opaque long runs                        |
| Tasker/Vulk-class           | Task/agent orchestration, background workers                             | Multi-agent division of labor                      | Hand-offs invisible to the user                          |
| Claude Code + Claude Design | Terminal-native agency, plan mode, subagents; design→code fidelity       | _Plan approval_ as a control surface               | Not a hosted product with billing/value proof            |

**Synthesized baseline for this field (the "normal"):**

1. Prompt → running app in < 60s to first visible pixel.
2. Live client preview + file tree + diffs.
3. Managed auth, DB, storage, server functions with no external account.
4. Publish to a URL; custom domain.
5. Credit-metered LLM usage with a visible balance.
6. Error capture from the preview fed back into the agent.
7. Git-backed history and rollback.

**What is missing across the whole field (the gaps this product is built on):**

1. **No backend preview.** Everyone shows the UI; nobody shows the engine — queries running, rows changing, function logs, auth state, RLS decisions, latency, cost per request — live, next to the code.
2. **No value assurance.** Nobody proactively detects "this user paid and got nothing."
3. **No memory of _this_ user's intent.** Every session restarts the model's understanding.
4. **Single opaque agent.** A "mechanic" you describe symptoms to, rather than an instrumented engine bay.
5. **Rigid, non-embedded payments.** Seat/credit plans that misprice bad outcomes and can't refund at the failure granularity.

---

## 2. System architecture (six planes)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ PLANE 6 — VALUE ASSURANCE (north star)                                    │
│  Outcome Ledger · Entitlement Diff · Pre-emptive Credit/Refund · Escalate  │
└───────▲───────────────────────────────────────────────────────────────────┘
        │ every event carries {intent_id, spend, outcome_state}
┌───────┴───────────────────────────────────────────────────────────────────┐
│ PLANE 5 — COMMERCE   Embedded checkout (MoR) · metering · entitlements     │
├───────────────────────────────────────────────────────────────────────────┤
│ PLANE 4 — GLASS ENGINE (backend preview)                                   │
│  live SQL tape · fn logs · auth/RLS trace · latency+cost HUD · schema map   │
├───────────────────────────────────────────────────────────────────────────┤
│ PLANE 3 — AGENT MESH  Architect · Schema · Server · UI · Verifier · Cost    │
│                       coordinated by a Sovereign-Intent contract            │
├───────────────────────────────────────────────────────────────────────────┤
│ PLANE 2 — MEMORY LATTICE (Cohere embed v3 + rerank)                         │
│  Intent space · Code space · Design-dialectic space · Outcome space          │
├───────────────────────────────────────────────────────────────────────────┤
│ PLANE 1 — SUBSTRATE  Postgres+RLS · object store · edge runtime · git · VM  │
└───────────────────────────────────────────────────────────────────────────┘
        ▲
   MARKET BASELINE ENGINE (Comperator-derived, offline cadence) ─────────────┘
```

---

## 3. Plane 2 — The Cohere memory lattice (semantic positioning space)

**Cohere only.** `embed-v4` (or `embed-english-v3.0`/`embed-multilingual-v3.0`) with
`input_type=search_document | search_query | classification | clustering`, plus `rerank-v3.5` on
every retrieval, plus Cohere Chat/Command for in-lattice reasoning. No other model vendor in the
retrieval path — one vector geometry means all four spaces are mutually comparable.

### 3.1 Four co-embedded spaces

| Space                | Documents                                                                                                                           | input_type        | Purpose                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| **Intent**           | Every user prompt, plan approval, rejection, correction, "no, I meant…"                                                             | `search_document` | What the human actually wants, over time                     |
| **Code**             | Per-symbol chunks (file, export, route, migration, policy) + docstring                                                              | `search_document` | Where meaning lives in the repo                              |
| **Design dialectic** | For each design decision: the **literal form** (what was built) _and_ its **opposing view** (the deliberately generated antithesis) | `search_document` | Position decisions in a space with poles, not a single point |
| **Outcome**          | Runtime events: passed/failed verifications, errors, latency, user abandonment, refunds                                             | `clustering`      | Where value was actually delivered or lost                   |

### 3.2 The dialectic mechanic (the differentiating idea)

For every non-trivial decision the Architect agent emits a `decision` record:

```json
{
  "id": "dec_0142",
  "thesis": "Server-rendered dashboard, data fetched in route loader",
  "antithesis": "Client-side SPA fetch with optimistic cache",
  "axis_label": "control_vs_latency",
  "chosen": "thesis",
  "rationale": "…",
  "embeddings": {"thesis": [...], "antithesis": [...]},
  "user_position": 0.23
}
```

The **axis** is `normalize(E(thesis) − E(antithesis))`. Every later artifact (code chunk, prompt,
outcome) is projected onto every active axis: `proj = dot(E(artifact), axis)`. This yields, per
project, an interpretable coordinate system built from the user's _own_ dialectics.

Consequences:

- **Drift detection:** if new code projects to `−0.6` on an axis the user chose at `+0.8`, the
  system has silently reversed an architectural decision. Flag before merge.
- **Visual understanding:** the lattice renders as a 2-D UMAP map where axes are _labelled human
  decisions_, not anonymous dimensions. The user sees the engine, not a black box.
- **Personalization without fine-tuning:** the user's position vector is the profile.

### 3.3 Retrieval contract (every agent call)

1. Embed the task as `search_query`.
2. Fan out ANN over all four spaces (`k=120` total, quota'd per space).
3. `rerank-v3.5` down to `k=12` against the literal task text.
4. Attach the top 3 relevant `decision` axes + the user's position on each.
5. Hard budget: ≤ 8k tokens of retrieved context per agent step.

### 3.4 "Train-the-model-as-you-prompt2app" — without training a model

Learning is **retrieval-shaped**, not weight-shaped:

- Every accepted diff → positive pair `(intent_chunk, code_chunk)`.
- Every rejection/correction → negative pair, stored with the correction text.
- A per-project **preference matrix** `W` (learned by logistic regression on rerank scores vs.
  accept/reject labels) reweights rerank output. Cheap, online, auditable, per-tenant isolated.
- Nightly: cluster corrections; any cluster of size ≥ 3 is promoted into a **project rule** written
  to `mem://` and injected into every system prompt. This is the visible "the agent learned X."
- Cross-tenant learning only via anonymized rule text, opt-in, never embeddings.

### 3.5 Storage

Postgres + `pgvector` (HNSW, cosine), one schema per project, RLS by `project_id`.
Tables: `mem_doc`, `mem_chunk(embedding vector(1024))`, `decision`, `axis`, `pref_weight`,
`outcome_event`. Re-embed on model version change behind a `embedding_version` column.

---

## 4. Plane 3 — The agent mesh (multiple agents, one sovereign human)

**Principle:** the user is the _architect_, not the dreamer. Agents never take an irreversible or
architecturally significant action without an approved contract.

| Agent         | Owns                                                                          | Cannot do                                      |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| **Architect** | Plan, decision records + antitheses, axis labels                              | Write code                                     |
| **Schema**    | Migrations, RLS policies, grants, seed data                                   | Touch UI                                       |
| **Server**    | Server functions, integrations, webhooks                                      | Change schema without Schema's migration       |
| **Interface** | Routes, components, design tokens                                             | Write server code                              |
| **Verifier**  | Runs the app, drives the browser, asserts outcomes, files defects             | Fix its own findings (no marking own homework) |
| **Steward**   | Credit/cost budgeting, kills runaway loops, reprioritizes spend to north star | Merge code                                     |

**Sovereign Intent Contract** — the hand-off artifact between the human and the mesh:

```yaml
intent_id: int_0007
goal: 'Paying users can export their report as PDF'
acceptance:
  - 'Verifier: signed-in user clicks Export → file downloads, >10KB, opens'
  - 'Cost: <= 40 credits'
  - 'No decision reversal on axes [control_vs_latency, managed_vs_explicit]'
budget: { credits: 40, wall_clock_min: 12 }
blast_radius: [src/routes/reports/*, migrations/*]
approved_by: human
```

Orchestration: a durable state machine (plan → contract approval → parallel build → verify →
value-check → merge). Every transition is an event on the Outcome Ledger. `stopWhen` step caps and
Steward budget kills prevent the "silent 45-minute burn" failure mode of the reference field.

---

## 5. Plane 4 — The Glass Engine (backend preview — the "see the engine" requirement)

A second preview pane, peer to the UI preview. Not logs-after-the-fact; a live tape.

| Panel              | Content                                                                 | Source                                          |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| **SQL tape**       | Every statement, params redacted, rows touched, ms, plan on demand      | `pg_stat_statements` + a logging pool wrapper   |
| **Function log**   | Per-invocation: input schema, output, duration, cold start, cost        | Server-function middleware                      |
| **Auth/RLS trace** | Who the request ran as, which policy allowed/denied, why                | `SET LOCAL` context capture + policy eval trace |
| **Schema map**     | Live ER diagram; new tables animate in as migrations apply              | Introspection on migration events               |
| **Cost HUD**       | Credits per request, per agent step, per feature; burn rate vs. budget  | Metering bus                                    |
| **Data table**     | Live rows, editable, with the RLS policy that governs each shown inline | Admin-scoped reads                              |
| **Lattice map**    | The 2-D memory lattice with decision axes; click a node → jump to code  | pgvector + UMAP worker                          |

Implementation: an event bus (`NOTIFY`/Redis stream) → SSE endpoint → preview client. Dev/preview
environments only; production surfaces an aggregated, PII-safe subset. Everything here doubles as
the raw feed for Plane 6 — the backend preview _is_ the instrumentation.

---

## 6. Plane 5 — Embedded payments

Grounded in _Payments for SaaS Platforms For Dummies_ (NMI Special Edition, Wiley 2025). The book's
core thesis maps directly onto this product: payments move from a cost center to a profit center,
and the platform keeps brand, UX, and data instead of handing them to a redirect.

### 6.1 Traditional vs. embedded — why redirect checkout is disqualified

| Dimension    | Redirect/traditional                 | Embedded (chosen)                         |
| ------------ | ------------------------------------ | ----------------------------------------- |
| UX           | Redirects, extra steps, context loss | Seamless, in-app, same session            |
| Data         | Siloed at the processor              | Rich and joinable with the Outcome Ledger |
| Revenue      | Minimal                              | Transaction fee sharing / markup          |
| Ops overhead | High                                 | Streamlined, one reconciliation surface   |
| Brand        | Low control                          | White-labeled end to end                  |

For this product the data column is decisive: a redirect breaks the join between _what the user
paid for_ and _what the agent delivered_, which is precisely the join the north star requires.

### 6.2 Business model choice

The book's five models: **referral**, **provider**, **hybrid/ISO-plus-SaaS**, **PayFac**,
**partner-enabled**.

- **Phase 7 (launch): partner-enabled.** The payments provider handles merchant onboarding,
  underwriting, compliance, payouts, and infrastructure; we keep branding, UX, and revenue share.
  Correct choice for a small team — no 12–18 month, high-cost PayFac program.
- **At scale: hybrid / ISO-plus-SaaS.** Recurring subscription + per-transaction charges. This is
  already the shape of our pricing (base plan + metered credits), so it is a pricing change rather
  than an architecture change.
- **PayFac is explicitly deferred** — full risk, underwriting, audits, and 12–18 months of program
  work. Revisit only above sustained volume where the interchange spread justifies it.
- Pricing to merchants: start **flat rate** (simple, predictable, explainable). Move selected
  high-volume accounts to **interchange-plus** once residual reporting is automated.

### 6.3 Integration requirements (partner selection checklist, from Ch. 3)

Non-negotiables when choosing the provider:

- Modern APIs **plus** SDKs and low-code/no-code drop-ins, and a real developer sandbox.
- **White-label**: our logo from sign-up through checkout; no third-party brand mid-flow.
- **PCI DSS Level 1** certification (and P2PE where card-present ever applies); tokenization and
  end-to-end encryption so we never touch PAN data.
- Documented **uptime and SLAs**, proven spike handling, 24/7 support with proactive incident alerts.
- Contract review: lock-in term, exit terms, **customer data portability**, price-increase schedule.
- Look past headline rates — setup, support, and enhancement costs decide true cost.
- Roadmap fit: a clear path to the payment methods and geographies we will add.

### 6.4 Checkout and methods

- One embedded, responsive, touch-optimized checkout; autofill; fast load. Mobile is a distinct
  design target, not a shrunk desktop form.
- Launch methods: cards (card-not-present, so stronger controls), **digital wallets** (Apple/Google
  Pay — the biggest conversion lever), and **ACH/bank transfer** for annual/B2B plans at lower fees.
  BNPL, crypto, and QR/text-to-pay are deferred; each method adds integration and maintenance cost.
- Clear upfront costs, helpful error messages, and a billing descriptor that matches our brand
  (a mismatched descriptor is a leading cause of avoidable disputes).

### 6.5 Recurring billing (Ch. 2, "Establishing repeat billing")

- Full subscription lifecycle: trials, cycles, upgrades/downgrades, proration, cancellation.
- **Decline recovery is a first-class subsystem**: smart retry logic, account updater, and dunning
  communications. Failed recurring payments are the single largest silent revenue leak — and, in our
  model, a _paying user losing access they expected_, so every decline is a north-star event.
- **Tokenization** for repeat charges; never re-prompt for card data.
- **Variable/usage billing** support, since credits are metered.
- Compliance for negative-option billing: explicit opt-in consent, renewal reminders, one-click
  cancellation, receipts (FTC negative option rule, GDPR/PSD2 where applicable).

### 6.6 Outcome-linked billing (our extension of the book)

A credit is **provisionally consumed** at agent-spend time and **confirmed** only when the Verifier
marks the intent `delivered`. Provisional spend older than the SLA window is auto-credited back.
Metering events ride the same bus as the Cost HUD, so what the user is billed is literally what they
watched happen in the Glass Engine. The **entitlement service** is authoritative and server-side:
`entitlement(user, feature) → allow | deny | degrade`, cached ≤ 60s, never trusted from the client.

### 6.7 Post-integration operations (Ch. 4) — folded into Value Assurance

The book's monitoring metrics become tripwire inputs in §7, not a separate dashboard:
approval rate, decline rate + reason codes, average transaction value, time-to-first-transaction,
chargeback rate, refund rate, transaction volume, settlement time. Plus: daily automated
reconciliation of deposits vs. statements, flow-of-funds tracking, fee-structure modelling for
margin, and automated residual calculation if/when we revenue-share.

Fraud and disputes from day one, never bolted on later: AVS, CVV, velocity rules, 3-D Secure/SCA,
ML transaction scoring, risk-tiered treatment (low-risk transactions stay frictionless), and
evidence-gathering for chargeback defense. Webhooks land on a public, signature-verified route; all
secrets stay server-side.

### 6.8 The book's ten mistakes, as build gates

Each becomes a checklist item that blocks the Phase 7 exit criterion: (1) security/PCI shortcuts,
(2) wrong processor / lock-in, (3) mobile treated as an afterthought, (4) untested edge cases —
declines, expired cards, duplicate payments, network timeouts, (5) cluttered checkout UX,
(6) misunderstood settlement timelines, (7) fraud tooling deferred, (8) no post-launch transaction
monitoring, (9) no international readiness (currencies, local methods, PSD2/PSD3, SCA, tax),
(10) rushing launch without reconciliation and support runbooks. Build for the strictest region
(EU: GDPR + PSD2/PSD3) first; global expansion then costs configuration, not rearchitecture.

---

## 7. Plane 6 — Value Assurance: catching it before they tell you

This is the untruncated answer to the closing question. Five layers, cheapest first.

### Layer 0 — Make value measurable

Nothing works until "what they paid for" is a machine-readable object. Every purchase creates
**entitlement rows**, and every intent creates an **acceptance contract** (§4). Value is then
`delivered_outcomes ÷ entitled_outcomes` over a window — not logins, not sessions.

### Layer 1 — The Outcome Ledger (append-only)

One row per meaningful event: `{tenant, user, intent_id, event, spend_credits, outcome_state,
latency_ms, error_class, ts}` where `outcome_state ∈ {pending, delivered, degraded, failed,
abandoned, refunded}`. Every plane writes here. This single table makes the rest possible.

### Layer 2 — Deterministic tripwires (real-time, no ML)

Fire within seconds; each has a defined automatic remedy.

| Tripwire                    | Condition                                                       | Automatic remedy                                                                       |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Spend without delivery**  | credits burned ≥ N on an intent with no `delivered`             | pause run, refund provisional credits, surface plan diff                               |
| **Silent failure**          | build/deploy green but Verifier assertions fail                 | block "done" state, open defect, notify                                                |
| **Loop burn**               | > 3 agent steps with no diff accepted, or same error class ×3   | Steward halts, escalates to human with the 3 candidate causes                          |
| **First-run cliff**         | new paid user, 0 `delivered` in first 24h                       | in-app rescue + human outreach queue                                                   |
| **Preview divergence**      | UI preview OK but Glass Engine shows 5xx / RLS denials          | flag "your app looks fine and is broken"                                               |
| **Entitlement drift**       | user on paid tier hitting `deny`/`degrade`                      | auto-grant + alert (never let billing block a payer)                                   |
| **Recurring decline**       | renewal declined (reason code captured)                         | retry ladder + account updater + dunning; access preserved through the grace window    |
| **Approval-rate dip**       | approval rate below 7-day baseline, or a decline reason spiking | route/rule review; treat as an outage, not a billing footnote                          |
| **Dispute precursor**       | refund request, chargeback, or unclear-descriptor complaint     | pull the full Outcome Ledger trace as dispute evidence; root-cause as a product defect |
| **Latency/cost regression** | p95 or credits-per-intent ↑ 2× vs 7-day baseline                | freeze, diff the causing commit                                                        |
| **Abandonment**             | session ends < 60s after a `failed` outcome                     | immediate credit-back + follow-up                                                      |

### Layer 3 — Semantic dissatisfaction detection (the lattice earns its keep)

- **Intent–outcome distance:** embed the original intent and the delivered artifact's description;
  cosine below the per-project accept threshold ⇒ _we shipped something else_. Rerank the delivered
  diff against the intent text for a calibrated score.
- **Frustration trajectory:** embed successive prompts in one session. Rising similarity (user
  restating the same thing) + falling politeness/rising imperative markers = the classic
  "about-to-churn" signature, detected before any support ticket.
- **Correction density:** corrections per accepted diff, per project, trending up.
- **Axis reversal:** delivered code projects opposite to the user's chosen position (§3.2) — the
  user _feels_ something is wrong before they can name it; the lattice names it for them.
- **Cohort anomaly:** cluster the Outcome space nightly; any cluster with refund/abandon rate 2σ
  above baseline becomes a product defect ticket, not a support ticket.

### Layer 4 — Act before they tell you

Automatic, in priority order:

1. **Refund/credit first, diagnose second.** Provisional credits auto-return; the user sees "we
   didn't deliver this, so we didn't charge you" before they compose a complaint.
2. **Repair attempt with a different agent path** (Verifier-authored contract, not the failing one).
3. **Honest surfacing:** a Value panel in the UI — what you paid, what was delivered, what failed,
   what we refunded. Making the ledger user-visible is the whole trust thesis.
4. **Human escalation** with the full trace attached (tape + lattice position + contract).
5. **Feed the failure back**: every Layer 3 detection becomes a negative pair in §3.4, so the mesh
   measurably stops repeating that class of failure.

### Layer 5 — Governing metrics

- **Value Realization Rate** = delivered ÷ entitled outcomes (primary).
- **Silent Failure Rate** = failures we detected ÷ total failures (target > 90% detected by us, not
  reported by users). _This is the north star made numeric._
- **Time-to-detect** (spend → tripwire) target < 60s; **time-to-remedy** < 5 min.
- **Credits-per-delivered-outcome** — the honest efficiency number, shown to the user.

**Credit prioritization rule (as requested):** when budget is contested, spend order is
(1) Verifier assertions, (2) Value Assurance detection, (3) repair of a failed paid intent,
(4) new feature generation, (5) polish. Generation never outbids verification.

---

## 8. The Comperator-derived Market Baseline Engine

Reuse the uploaded pipeline (`crawler → classifier → summarizer → analyzer`) largely as-is, with
four upgrades, run on a weekly cadence against the reference set in §1:

1. Swap `app/llm.py`'s OpenAI client for **Cohere Command**; add `co.embed` on every extracted page
   and `co.rerank` before analysis so only the top-k genuinely comparative pages reach the LLM
   (kills the `MAX_TXT_LENGTH` truncation loss in `analyzer.py`).
2. Extend `ContentTypes` with `pricing_model`, `agent_capability`, `preview_capability`,
   `guarantee_or_sla` — and stop excluding `pricing_information`; pricing _is_ the signal here.
3. Emit a structured **capability matrix** (rows = features from §1, cols = competitors, cells =
   present/absent/partial + citation URL) instead of prose, into `feature_baseline` in Postgres.
4. Feed that matrix into the Intent space of the lattice, so "what is normal in this field" is
   retrievable by the Architect agent when it plans, and so a missing table-stakes feature is
   itself a Layer-2 tripwire.

Streamlit stays as the internal analyst view; the product surface reads from `feature_baseline`.

---

## 9. Build order (baseline implementation plan)

| Phase  | Deliverable                                                                                           | Exit criterion                                                       |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **0**  | Substrate: Postgres+RLS+pgvector, git-backed workspace, edge runtime, auth                            | A prompt produces a deployed hello-world                             |
| **1**  | Outcome Ledger + metering bus                                                                         | Every agent step and request writes a row with spend + outcome_state |
| **2**  | Cohere lattice v1: Intent + Code spaces, embed + rerank retrieval contract                            | Retrieval beats naive grep on a 20-task eval set                     |
| **3**  | Agent mesh v1: Architect + Schema + Server + Interface, Sovereign Intent Contract with human approval | No merge without an approved contract                                |
| **4**  | Glass Engine: SQL tape, function log, auth/RLS trace, cost HUD                                        | User can explain a failed request without asking support             |
| **5**  | Verifier agent + browser assertions                                                                   | `delivered` state is machine-decided, never self-declared            |
| **6**  | Value Assurance Layers 1–2 (ledger + tripwires + auto-credit)                                         | Silent Failure Rate measured; first auto-refund fires                |
| **7**  | Embedded MoR checkout + entitlements + outcome-linked billing                                         | Provisional credits confirm/return correctly                         |
| **8**  | Decision axes + dialectic UI + lattice map                                                            | Axis-reversal detection blocks a real regression                     |
| **9**  | Preference learning + nightly rule promotion (§3.4)                                                   | Correction density trends down over 30 days                          |
| **10** | Market Baseline Engine on cadence                                                                     | Weekly capability matrix; missing table-stakes raises a tripwire     |

Phases 1, 4, 5, 6 are the moat. Phases 0, 3, 7 are parity with the reference field. Ship parity
only as fast as needed to make the moat demonstrable.

---

## 10. Open decisions requiring the human architect

1. The embedded-payments PDF was not in the upload — MoR provider and its embedded-checkout
   constraints must be confirmed before Phase 7.
2. Does the runtime VM run per-project containers (Replit-class control, higher cost) or a shared
   edge runtime (cheaper, less shell fidelity)? This is the first decision axis and should be
   recorded as one.
3. Refund authority ceiling for automatic Layer-4 credits before human approval is required.
4. Cross-tenant rule sharing: opt-in default on or off.
