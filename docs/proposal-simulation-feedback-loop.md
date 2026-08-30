# Proposal: let the simulation change one thing by itself

**Status: not approved. Nothing in this document is built.**
**Decision owner: Johnathan. Written 2026-08-30.**

This is the §10 proposal the overhaul brief reserves. It asks for one
explicit answer and stops. The §CORRECTION 7 boundary — simulation output
never rewrites production configuration unattended — holds today and holds
until that answer is yes.

---

## What exists now

As of this commit the loop is closed everywhere except the last hop:

| Step             | Where                                             | State                  |
| ---------------- | ------------------------------------------------- | ---------------------- |
| Run              | `.github/workflows/simulation.yml`, 04:00 UTC     | scheduled, never fired |
| Record           | `POST /api/simulation/ingest` → `simulation_runs` | proven end to end      |
| Notice           | `0 6 * * *` → `lib/simulation-watchdog.ts`        | proven, seeded         |
| Tell someone     | `simulation_alerts` → admin **Simulation** tab    | built                  |
| **Fix anything** | —                                                 | **a human, by hand**   |

The last row is the proposal. Everything above it is advisory: an alert says
what happened and what the numbers were, and a person reads it, decides, and
writes a commit.

## The precondition this proposal has not met

The brief is explicit that this argument is "far more credible when the daily
run is already producing real reports." **It is not yet.** The workflow has
never run: it needs a `SIMULATION_INGEST_SECRET` repository secret that this
environment cannot set, and a real run spends real credits against live
production, which is your call and not a thing to do unannounced.

So this document is written and parked. The honest sequence is:

1. You set the repository secret to match the Worker secret.
2. The nightly runs for two weeks. Cost and noise become measured facts
   instead of estimates.
3. **Then** this proposal gets an answer, against those facts.

Approving it before step 2 would be approving a mechanism whose input has
never been observed.

## The proposal itself

**One class of change, auto-applied, reversible, logged: tripwire
thresholds.**

Not remedies. Not model routing. Not gates. Not credit caps. The single
narrow claim is that when the nightly finds a tripwire firing far more or far
less than the threshold it is configured at, the threshold may move within a
declared band, by itself, and tell you it did.

The reason to pick this one and nothing else: a tripwire threshold is a
detection sensitivity, not a permission. Moving it wrong produces noise or a
missed detection — both visible, both recoverable by moving it back. Every
other candidate for automation on that list can produce an action taken
against a user's project, and none of them should be reachable from an
unattended process regardless of how good the simulation gets.

Concretely, if approved:

- A new `simulation_auto_adjustments` table records every change: the
  tripwire, the old value, the new value, the run that justified it, and a
  timestamp. Nothing is changed without a row.
- Each adjustable tripwire declares a **band** in source — a floor and a
  ceiling a machine may move between. Outside the band is an alert, never an
  adjustment. The band is the human decision; the position inside it is the
  automated one.
- At most one adjustment per tripwire per night, and none at all when the
  run raised a `no_run` or `new_exploit_class` alert — a night that found
  something new is a night to look at, not a night to tune against.
- A revert path that is one command, and an admin control that turns the
  whole mechanism off without a deploy.
- The admin Simulation tab shows adjustments as prominently as alerts. An
  automated change nobody sees is worse than the manual process it replaced.

## What stays forbidden regardless of the answer

- Anything touching a user's project, run, credits, or data.
- The approval gate, in any form. It is the one structural claim this product
  makes that the field does not, and a system that can quietly widen its own
  gate does not have one.
- Model routing, prompts, and the pipeline's own agent behaviour.
- Silent operation. Every automated change is a row, an alert, and a visible
  entry — or it does not happen.

## The three answers

- **No.** The loop stays advisory. Nothing changes; this document stays as
  the record of what was considered. This is a perfectly good answer and the
  system is complete without it.
- **Not yet.** Run the nightly, gather the two weeks, revisit. This is the
  default if nothing is said.
- **Yes, bounded as above.** Then it gets built to this shape and no wider,
  and the bands are set by you, in source, before the first automated change.

---

_Nothing here is implemented. `applied_to_architecture` is 0 on every row and
the only code path that could change it is a human writing a commit._
