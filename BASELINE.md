# Measured baseline

**Commit** `0878819`+ (working tree) · **Measured** 2026-08-30T12:09Z · **Branch** `overhaul/w1-foundation`

This file exists to replace a sentence. The overhaul brief opened with _"the
current state of discomplemented.com is 90% stable"_, and that number had no
method behind it. It is not carried forward. What follows is what was actually
run, with the commands, so anyone can re-run it and get a number to disagree
with.

Re-measure with `pnpm test:all` and update this file in the same commit as any
change that moves it.

---

## What passes

Every leg of `pnpm test:all`, in the order the script runs them. Each row is one
command; run them individually to reproduce.

| Leg            | Command                 | Result                                     | Time  |
| -------------- | ----------------------- | ------------------------------------------ | ----- |
| Migration lint | `pnpm lint:migrations`  | pass — 27 migrations, no duplicate numbers | 1s    |
| Types          | `pnpm typecheck`        | pass — `tsc --noEmit`, no output           | 40s   |
| Unit           | `pnpm test:unit`        | pass — 38 files, 530 tests                 | 56s   |
| Integration    | `pnpm test:integration` | pass — 6 files, 50 tests                   | 107s  |
| Security       | `pnpm test:security`    | pass — 3 files, 32 tests                   | 2s    |
| E2E            | `pnpm test:e2e`         | pass — 82 tests (41 × desktop, mobile)     | 2m30s |

`pnpm lint`: 0 errors, 75 warnings. The warnings are pre-existing (unused vars,
`no-explicit-any`). The count fell by one this round, and the one it lost is
worth naming: `'simulationRoutes' is defined but never used` in
`apps/web/src/index.ts`. The router was imported and never mounted, so
`/api/simulation/latest` and `/history` answered 404 — and that warning was the
only thing in the repository that knew.

**Totals: 694 automated assertions across 6 legs, all green, from a clean
checkout with no network access to any provider.**

That is the honest headline, and it is a count, not a percentage. A percentage
would need a denominator — how much of the system _could_ be covered — and no
such denominator has been measured. 694 passing tests over the **157
non-test source files** in `apps/web/src` is a real statement; "90% stable" was
not.

> The file count is measured, and was wrong here before. This paragraph used to
> read "156 source files" with no command recorded, which is the same defect the
> rest of this document exists to retire — a number nobody can reproduce. It is
> now:
>
> ```bash
> find apps/web/src \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | wc -l
> ```

### Bundle, measured properly

`pnpm build`: exit 0. The previous revision of this file said "1.1 MB client,
944 KB of JavaScript". That figure is withdrawn — `du` over
`apps/web/dist/client` reports **16 MB**, and the discrepancy is not a
regression in this change, it is the earlier number having been taken from
something other than the build output. The breakdown, since one total hides the
thing worth knowing:

| Asset                 | Size    | When it is fetched                    |
| --------------------- | ------- | ------------------------------------- |
| `esbuild-*.wasm`      | 12.0 MB | only when a Tier 2 preview bundles    |
| `babel-*.js`          | 2.9 MB  | only when a Tier 1 preview transforms |
| `LatticeView-*.js`    | 472 KB  | on opening the Lattice view           |
| `index-*.js`          | 310 KB  | every page load                       |
| `GenerationView-*.js` | 139 KB  | on opening the Generation view        |

Both of the large ones are lazy on purpose, and that is new here. Making
`PreviewFrame` reachable (see below) put `@babel/standalone` into
GenerationView's chunk — **120 KB → 3.0 MB**, measured by building both
revisions — and started esbuild's worker, and its 12 MB wasm download, on every
visit to the view including the Tier 3 projects that never bundle. Babel is now
behind a cached dynamic `import()` in the Tier 1 branch, and `useEsbuild(enabled)`
only starts its worker for Tier 2. GenerationView's chunk is back to 139 KB —
128 KB when that was written, and the 11 KB since is this change's own:
`PipelineStatus`, `ReviewGate` and the legibility module.

## What the number does not cover

Every leg above runs offline. None of it touches Cohere, Stripe, Resend, a
container, or the production database. The following are unverified, and
listing them is the point — a green suite that hides its own edges is how "90%"
happens:

- **No production deploy has been exercised.** `scripts/predeploy.sh` runs a
  `--dry-run`; nothing here proves a real deploy succeeds.
- **No end-to-end authentication.** The integration suite exercises the real
  `requireAuth` middleware against the real routing stack, but no test signs a
  user in through Better Auth against a live D1 and gets a session cookie back.
- **No real generation run.** No test calls Cohere. The pipeline's behaviour on
  a real prompt is not covered at any level.
- **No non-Chromium browser.** Both Playwright projects are Chromium (desktop
  and Pixel 5 emulation). WebKit and Firefox are untested.
- **Contrast is measured; the rest of accessibility is not.** This bullet
  previously read "No accessibility audit. No contrast ratio has been measured."
  That was wrong when written — `apps/web/tokens/contrast-matrix.md` had
  computed the app's token ramps on 2026-08-21 — and it is wrong now for a
  better reason. `apps/web/src/styles/contrast.test.ts` reads `dual-theme.css`
  on every run and recomputes every role token against all three grounds in
  both themes (24 assertions). It found four AA failures that a static audit had
  already "corrected" once, because that audit measured against the base ground
  only. `docs/palette.md` records the values and the derivation.

  What is still **not** measured: focus order, screen-reader labelling, heading
  structure, and colour-independence of every state. No axe or Lighthouse run
  exists. Tap targets and menu focus behaviour are covered at 390px by
  `tests/e2e/mobile.spec.ts`, and that is a slice, not an audit. The
  simulator's `accessibility: 0.98` remains a simulation output and is not
  evidence of any of it.

- **The verboseness levels are proved against a seeded run, not a generated
  one.** `apps/web/tests/integration/pipeline-verboseness.test.ts` drives the
  real endpoint through the real auth middleware against a real migrated D1 at
  each of the three levels, and asserts the transcript contains exactly what
  that level promises — including that raising the level reveals what a lower
  one withheld, with no re-run. What it does not do is generate the rows: they
  are inserted in the shapes the orchestrator writes them rather than produced
  by five model calls, for the same reason as the bullet above — no test calls
  Cohere. So the projection is verified; that the pipeline populates every
  field the projection reads is not, and would need the §5 acceptance runs.
- **The generation screen is graded against stubbed frames, not a live run.**
  `tests/e2e/pipeline-legibility.spec.ts` drives the real built client with
  `/api/**` intercepted, so it does establish the two things only a rendered
  page can — the stage rail is on screen _while_ a run is going, and the review
  gate is inside the viewport without scrolling (asserted on the bounding box,
  not `toBeVisible`, which scrolls first and would pass for a gate below the
  fold). The frames it feeds in are copied from `routes/pipeline.ts`'s own
  `send()` calls, and `tests/integration/pipeline-stream.test.ts` is what holds
  those shapes to the database — including that the Coder's `step:start`
  carries the step number its rows were written with. Neither is evidence that
  a real pipeline drives the screen correctly end to end. That is a §5
  acceptance run.

  Worth recording because it is the kind of thing a suite hides: the first
  full-suite run of this spec failed two gate tests that pass in isolation,
  and the page snapshot captured at the failure had the gate on it, correctly
  rendered. The generation view boots its route chunk, the 2.9 MB Babel chunk
  and an iframe, and on a loaded machine that exceeded Playwright's 5s expect
  timeout — so the failure was reported against the gate assertion it happened
  to land on. `openRun` now waits once for the surface to mount before any
  assertion runs. That is a readiness barrier, not a loosened check: if the
  view never mounts the spec still fails, and it now fails saying that.

  Neither did it fail here for a reason the app was responsible for, so no
  product change came out of it — which is exactly why it is written down
  rather than quietly retried.

- **No performance measurement.** Bundle size is recorded above; no load,
  latency, or Core Web Vitals figure has been taken.
- **No preview container is exercised.** The Tier 3 unit tests
  (`sandbox-egress`, `sandbox-backend`, `sandbox-install`) cover the pure
  decision functions — the phase machine, the routing predicate, the install
  plan — and nothing more. No test starts a container, installs a dependency,
  or makes an HTTP request to a generated API route. The end-to-end proof §3.2
  asks for is not in this table yet.
- ~~**Tier 3 is not reachable from the UI at all.**~~ — fixed on 2026-08-29,
  and worth recording what the measurement found because one fix would not have
  been enough. Three independent breaks, each sufficient on its own: nothing in
  `src/views` rendered `PreviewFrame` (GenerationView bundled with esbuild into
  an iframe — Tier 2, always); `IDELayout` accepted only a `previewSrcDoc:
string`, so it structurally could not host a URL-backed preview; and
  **`pipeline_runs.project_id` was NULL for every run started from the
  Generation view**, while the container is keyed by project id. The preview was
  not merely unrendered, it was unaddressable.
  `tests/integration/preview-addressing.test.ts` pins the third — the one no
  unit test could see, because no single function was wrong. Calibrated:
  binding `null` back into the insert fails 2 of its 4 assertions.
  Reachability is not operation, though — the "no preview container is
  exercised" bullet above still stands in full.
- **The queue has never been observed under a real full pool.**
  `preview-capacity.test.ts` pins the decision function against 11 cases — a
  full pool, a project asking twice, a queue that holds its order across
  heartbeats, a slot whose container died holding it — and the DO, the route's
  202, the client's poll and the panel's copy are all wired to it. What has
  **not** happened is 21 concurrent projects asking for a container on the real
  account and the 21st being told it is first in line. Until that run exists,
  "concurrency above the ceiling queues visibly" is implemented and unit-tested,
  not demonstrated.

- **The nightly simulation has never fired on its own schedule.** §3.5's
  acceptance asks for "a scheduled run [that] fires without manual invocation,
  spends within budget, lands a row in `simulation_runs`". Everything downstream
  of the trigger is covered: `apps/web/tests/integration/simulation-ingest.test.ts`
  drives a real report through the real route into a real migrated D1, proves an
  unauthenticated ingest is rejected three ways, runs the watchdog against a
  seeded regression and checks it raises once and stays idempotent;
  `cron-coverage.test.ts` fails if a configured cron has no handler or if the
  three `crons` blocks disagree; `simulation-ingest-contract.test.ts` fails if
  the Python payload and the route's field names drift.

  The trigger itself has not run. `.github/workflows/simulation.yml` is
  scheduled for 04:00 UTC and needs a `SIMULATION_INGEST_SECRET` repository
  secret that this environment does not hold and cannot set — and a real run
  spends real credits against live production, which is a decision for the
  account owner and not a thing to do to establish a baseline. So: the
  schedule is configured and every part of it that can be executed here has
  been. Whether GitHub fires it, and what the first real run costs, is not
  verified. It becomes verifiable the moment the secret is set, and the first
  evidence will be a row in `simulation_runs` with a non-null `vdr_percent`.

## Percentages that survive the rule

The constraint is that no quality, stability, or confidence percentage may reach
user-facing copy, a system prompt, or an API response without a reproducible
derivation in the repo. Swept the source for percentage-rendering call sites;
three exist, and all three keep their derivation:

- `views/ValueView.tsx` renders `vdr.confidence` from `lib/value-delivery-rate.ts`,
  which computes it from actual run counts and returns 0 below the sample floor —
  and the view says "low confidence, need ~10+ runs" rather than showing a number
  it cannot support.
- `components/MemoryLattice.tsx` renders per-node confidence from lattice data,
  not from a constant.
- `lib/research-engine.ts` emits "N% of classified citations are supporting" from
  `scite-research.ts`, whose derivation is pinned by tests — including that it
  returns `null`, not 0, when nothing was classified.

**That sweep was incomplete, and this paragraph is the correction.** It looked
for percentage-rendering call sites in `src/views` and `src/lib` and found
three. It missed a fourth, because the number was not rendered by a component
and not computed by a library — it was interpolated into an agent message
inside `GenerationOrchestrator`:

```
Audit PASSED. Coverage: 87%. 3 findings.
```

`coverageScore` was a field the auditor's system prompt asked the model to
produce, bounded to 0–100 by a zod schema and by nothing else. No denominator,
no method, not reproducible from anything here. It reached the founder in the
group chat, it reached the gate summary, and it was stored on the run — which
`GET /api/pipeline/:id` returns whole, so it reached an API response too. All
three are surfaces the rule names explicitly.

It is removed rather than relabelled: the field is gone from the prompt, the
schema and the `AuditResult` type, the prompt now tells the model not to
volunteer one in prose either, and the two user-facing strings report counts
from the findings list instead — `3 findings, 1 critical, 1 warning.` A tally of
items in a list is reproducible; a percentage summarising them is not.
`pipeline/agents/auditor.no-score.test.ts` keeps it out.

The lesson for the next sweep: this one searched for the shape of a _render_,
and the defect was in the shape of a _string_. `grep -rn '%' --include='*.ts'`
over anything that reaches `publishAgentMessage` would have caught it.

The figures removed under this rule were the ones with no derivation at all:
`vdrCeiling: 91.3`, its `vdr_gap: 23.6`, the "67.7% of 91.3% ceiling" line, and
now `coverageScore`. `glaas/no-ceiling.test.ts` keeps the first three out.

## Provenance of the legs themselves

Three of the six legs did not exist or did not run before the `p0` merge, which
is why no earlier stability claim could have been sound:

- `pnpm test:all` previously died at leg 2 and never reached the legs after it.
- `pnpm lint` exited 2 on an `--ext` flag ESLint 9's flat config removed, so
  nothing had been linted in a long time.
- There was no root `typecheck` script.

A suite that reports success without running is worse than no suite, because it
answers the question it was never asked. The `p0` merge fixed all three; this
file is the first measurement taken after they were all actually executing.

## Corrections to the brief's premises, measured

The brief's §1.1 identified migration `019_user_roles.sql` aborting mid-file as
a live blocker, leaving `approval_gates`, `audit_results` and
`verification_results` uncreated in production — and instructed confirming
against production first. Confirmed: **production D1 has all 55 tables,
including those three.** The blocker was already closed. The brief labelled this
"Inference, not observation", and the observation disagreed with the inference.

A `d1_migrations` ledger table does exist in production, recording exactly one
row: `001_init.sql`, applied 2026-08-20. So "there is no ledger" was true in
effect — nothing had written to it since — but not literally.

Migration numbering is 001–024 with no duplicates; `main` had already renumbered
`user_events` to 024 before this work began.
