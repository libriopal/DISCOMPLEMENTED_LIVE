# P1 — Unified pipeline agent, lattice-backed chat, and blueprint suggestions

Status: **design, not built.** Written 2026-08-30, after P0-a (the NVIDIA
auditor cutover) went green. This is the note the three P1 features get built
against; nothing here is wired yet, and nothing here should be read as
shipped.

## The vocabulary is already right — do not add a second one

`apps/web/src/lib/pipeline-legibility.ts` is the single definition of the five
stages:

| agent        | step | label    |
| ------------ | ---- | -------- |
| `researcher` | 1    | Research |
| `auditor`    | 2    | Audit    |
| `verifier`   | 3    | Verify   |
| `designer`   | 4    | Design   |
| `coder`      | 5    | Build    |

These are the names the backend already uses in `pipeline_runs.current_agent`
and `pipeline_steps`. The standing constraint is explicit that there must be
no translation layer between UI vocabulary and backend vocabulary, so every
P1 surface below reads `PIPELINE_AGENTS` / `PIPELINE_STAGES` rather than
carrying its own list. A private copy of these five strings anywhere is the
bug, even when it happens to match today.

One thing to be careful of: `label` for `coder` is **"Build"**, not "Code".
The stage vocabulary in the brief says "code" and the user-facing label says
"Build". That is a deliberate legibility choice already made in §3.4, not
drift — the _agent id_ is the vocabulary, and the label is presentation.
Match on `agent`, never on `label`.

## 1. Unified 5-in-1 pipeline agent

**What it is:** one prompt in, one pre-verified blueprint out, with the five
stages running underneath instead of being driven one at a time by the user.

**What it is not:** a new pipeline. It is a new _entry point_ to the existing
one. `GenerationOrchestrator` (the Durable Object) already sequences the
stages and already records per-step rows; a second sequencer would be a
second source of truth about what stage a run is in, and the two would
disagree the first time one of them was changed.

Shape:

- `POST /api/pipeline/unified` — accepts the prompt, creates one
  `pipeline_runs` row, and returns its id immediately. It does not block for
  the length of a five-stage run.
- Progress is read from the endpoints that already exist. The unified entry
  point adds no new progress channel.
- `ask_first` remains the default execution mode. "Unified" means the user
  does not have to drive each stage; it does not mean the run stops asking
  before it acts. The Design stage's human approval gate stays exactly where
  it is — that gate is the magenta surface reserved in Appendix B.2, and
  removing it to make the flow feel seamless would be removing the review,
  not the friction.
- A stage that fails fails the run. There is no "continue with the remaining
  four", because a blueprint that skipped Audit is precisely the thing the
  ladder exists to prevent, and it would be indistinguishable in the output
  from one that passed.

Open question for the account owner, not to be assumed: whether the unified
run should escalate to `AUDITOR_MODEL_ESCALATION` when Audit returns HIGH
findings twice, or stop and hand back. Escalating costs more per run;
stopping is the §4C shape. **Default to stopping** until told otherwise —
that is the direction that fails loudly.

## 2. General Flagship Agent → Memory Lattice

**What it is:** the Fluxy support agent gains a tool that reads the asking
user's own project lattice, so "why did my build pick Postgres?" can be
answered from the recorded decision rather than guessed.

Wiring:

- A new tool alongside the existing `get_pipeline_status`, answered by the
  same webhook route in `routes/chat.ts`. The lattice read goes through
  `routes/lattice.ts`'s existing query path, not a new SQL statement.
- **Scoped to the caller's own projects.** The tool receives the `userId`
  that the server already knows from the session — never a `userId` taken
  from the tool-call arguments. The model constructs those arguments, and a
  model that can name any project id is an IDOR with a language model in
  front of it.
- The tool webhook stays authenticated by `verifyToolWebhookSecret`, which
  is the admin key. That is correct and is not a violation of the tier split:
  the callback arrives from FluxyChat's server, not a browser.
- Returns recorded facts only — node contents and decisions. No confidence
  or quality percentage, per the standing rule that no such number may appear
  without a reproducible derivation in the repo.

## 3. Blueprint builder block suggestions

**What it is:** the node-based builder proposes blocks based on what the
active lattice already contains.

The whole risk here is in one word: _suggests_. A suggestion is rendered as a
proposal the user accepts; it never adds a node on its own. This is the same
line §CORRECTION 7 and §3.5 item 6 draw for the simulation engine — the
engine surfaces findings loudly and does not rewrite configuration
unattended, and a builder that silently grows a graph is that failure with a
nicer animation.

Rules:

- Suggestions come from the lattice's recorded contents. If there is no
  lattice yet, the correct output is no suggestions — not generic starter
  blocks dressed as analysis.
- Every suggestion says what in the lattice it came from. A recommendation a
  user cannot trace is one they cannot evaluate.
- No percentage on a suggestion. See above; there is no derivation for one.

## Prerequisites, honestly stated

Two of these three cannot be finished today, and the reasons are external:

1. **FluxyChat is not deployed.** `FLUXYCHAT_WORKER_URL` points at
   `fluxychat.johnathanallen1998.workers.dev`, and as of 2026-08-30
   `wrangler deployments list --name fluxychat` answers `code 10007` (no such
   Worker) and the URL 404s. Feature 2 can be written and unit-tested against
   the SDK, but it cannot be verified end-to-end until that Worker exists.
2. **`FLUXYCHAT_USER_API_KEY` has no issuer yet.** The tier split is in the
   code and enforced by tests, but the value must be issued by the FluxyChat
   deployment above. Generating a random `fc_`-shaped string locally would
   produce a credential that authenticates against nothing while making the
   configuration _look_ complete — the exact "green check that never ran"
   this repo refuses.

Feature 1 and feature 3 have no external blocker.
