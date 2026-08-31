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

## Prerequisites — resolved 2026-08-31

Both external blockers this section previously named are now cleared. Recording
what changed rather than deleting the entry, because the reason each was a
blocker is the reason to distrust a future "it's fine" about the same thing.

1. **FluxyChat is deployed.** `FLUXYCHAT_WORKER_URL` =
   `https://fluxychat.johnathanallen1998.workers.dev` is live; `/health`
   reports `database`, `durableObjects`, `kv` and `r2` connected, and all 223
   of its migrations are applied to the `fluxychat` D1. Feature 2 can now be
   verified end-to-end rather than only unit-tested against the SDK.
2. **`FLUXYCHAT_USER_API_KEY` has a real issuer.** It was minted by
   FluxyChat's own `POST /platform/bootstrap`, not generated locally — a
   random `fc_`-shaped string would have authenticated against nothing while
   making the configuration look complete. The bootstrap endpoint was
   re-closed afterwards and verified refusing (`bootstrap_disabled`).

   One correction to the original brief, restated here so it is not lost:
   FluxyChat has **no** native two-tier key model. The tier boundary is two
   separate FluxyChat projects, each with its own project key. Support rooms,
   the support agent, and the tool-execute webhook all live in the _user-tier_
   project — an agent provisioned into the admin project would never see a
   founder's message.

Neither feature has an external blocker now.

## 4. Auditor ↔ Memory Lattice, with the lattice held at arm's length

Added to P1 on 2026-08-31 by explicit direction. The auditor is currently
blind to project history, which means it re-derives context every run and
cannot see a flaw that only exists across runs.

**Wire it.** The NVIDIA Nemotron auditor receives the same Memory Lattice
context payload the Cohere agents get.

**Do not let it become ground truth.** This is the whole risk of the feature.
The lattice is written by the previous agents in the loop; an auditor that
trusts it will confirm whatever the last run asserted, and a compounded
architectural error becomes permanent the moment it is written down. An
auditor that rubber-stamps is worse than no auditor, because it produces a
green check that never ran.

**Prompt construction.** The lattice payload is sandboxed in its own clearly
delimited section, framed as _"Developer Intent and Historical Context"_, with
explicit instructions that it is a record of **untrusted claims made by
previous agents**, not a statement of fact. The auditor is told to:

- read it for _intent_ — what the user was trying to achieve;
- treat every technical assertion in it as a claim to be checked against the
  actual repository state, never as a premise;
- hunt specifically for compounded flaws — a wrong pattern that each later
  agent extended rather than questioned;
- critique _how_ previous agents pursued the stated intent, not merely whether
  the current diff compiles.

Same containment rule as feature 2: the lattice is scoped to the server-known
`userId`. A `userId` arriving inside a tool-call argument is ignored — that is
an IDOR with a language model in front of it.

**Memory pruning directive (self-healing).** Pointing at a bad memory does not
remove it; the next run ingests it again. So when the auditor finds a
hallucinated dependency, broken logic, or a flawed architectural pattern baked
into the lattice, it emits a structured `lattice_correction_directive` in its
JSON response naming the specific node and the action (`delete` or `rewrite`)
with a reason.

Bounded, per §4C and §CORRECTION 7:

- a directive names **specific node ids**; there is no "clear the lattice";
- `rewrite` carries the replacement text, so the change is reviewable as a
  diff rather than as an instruction;
- directives are recorded with the audit run that produced them, and a
  rejected one stays recorded — a correction the system declined to apply is
  exactly the thing worth being able to find later;
- the auditor may prune the lattice. It may **not** touch production
  configuration, and it may never resolve a finding by weakening the check
  that produced it.

Open question for implementation, flagged rather than assumed: whether
`delete` executes unattended or queues for the same human gate the Design step
uses. Deleting a memory node is not reversible from inside the loop, and
§CORRECTION 7 says activation means findings surface loudly, not that output
rewrites state unattended. Default to queuing unless the account owner says
otherwise.
