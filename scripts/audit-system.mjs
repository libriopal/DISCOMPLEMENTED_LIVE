#!/usr/bin/env node
/**
 * A bounded whole-system audit by the independent model.
 *
 * ## How this differs from §4B, and why both exist
 *
 * `audit-diff.mjs` asks "is this change wrong?". It is a gate: it blocks a
 * commit, it runs on every commit, and its scope is the lines that changed.
 * That scope is also its blind spot. Every defect this overhaul found in the
 * simulation engine was invisible to a diff audit, because none of them were
 * in a diff — they were in the *absence* of a line. `simulationRoutes` was
 * imported and never mounted. `calculate_simulation_vdr` was defined below the
 * entry point and never called. A cron was configured with no handler. Nothing
 * changed to cause any of those; they were laid down complete and wrong, and a
 * reviewer looking at any one file would have seen nothing to object to.
 *
 * This script asks the other question: "given the whole thing, what does not
 * add up?" It is deliberately **not** a gate. It does not block a commit, it
 * does not run on every commit, and it does not fix anything.
 *
 * ## Why it is not allowed to fix anything
 *
 * The obvious next step — feed the findings back, apply them, re-audit, repeat
 * until the model approves — is the one thing this must not do. An unbounded
 * loop that terminates when a model says "approved" optimises for approval,
 * and the cheapest path to approval is weakening whatever is being checked.
 * That is CONSTRAINT 6 with the serial numbers filed off. There is a second
 * failure underneath it: an auditor shown its own prior feedback already
 * incorporated tends to approve out of agreeableness, so "it finally passed"
 * measures persistence and not correctness.
 *
 * So the bound is structural rather than advisory. `MAX_PASSES` is 2. A second
 * pass is for confirming that findings acted on are actually gone, not for
 * negotiating. If findings remain after pass 2, that is an escalation to a
 * human — the same shape §4C uses, for the same reason.
 *
 * ## Why a finding is a hypothesis and not a defect
 *
 * The model reads source. Source is exactly the thing that looked finished in
 * every case above. It cannot see that production's `d1_migrations` ledger
 * records one row, or that no `bicameral-pr-*` Worker exists, or that the
 * nightly has never once fired — those were found by querying live systems,
 * and a report claiming otherwise from a source read would be confident and
 * wrong. Every finding here is therefore written out as something to check,
 * with the check named where one is obvious. Nothing is acted on because this
 * script said so.
 *
 * ## Usage
 *
 *   node scripts/audit-system.mjs --dry-run    # partition + token estimate
 *   node scripts/audit-system.mjs --budget-tokens 3000000
 *   node scripts/audit-system.mjs --subsystem routes
 *   node scripts/audit-system.mjs --pass 2 --since .audit/system-<sha>.json
 *
 * Requires NVIDIA_API_KEY. Writes only to `.audit/`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditorEndpoint,
  auditorKey,
  auditorModel,
  postChatCompletion,
  AUDITOR_KEY_VAR,
  COST_USD,
} from './auditor-provider.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, '.audit');

/**
 * Two passes, and the second one only confirms. See the header. This is the
 * whole reason the script is safe to run unattended, so it is a const at the
 * top rather than a flag — a `--max-passes` option would make the bound a
 * suggestion.
 */
export const MAX_PASSES = 2;

/**
 * Rough characters-per-token for source. Used only to partition and to refuse
 * a run that would obviously exceed budget; the real token counts come back
 * from the API and are what get reported. Deliberately pessimistic: guessing
 * low here means discovering the overrun after paying for it.
 */
const CHARS_PER_TOKEN = 3.2;

/** Leave room for the system prompt, the seam extract and the response. */
const MAX_SUBSYSTEM_TOKENS = 60_000;

/*
 * The per-request ceiling lives in scripts/auditor-provider.mjs now
 * (STREAM_STALL_MS / STREAM_TOTAL_MS), because the response is streamed and
 * the timeout it enforces is silence rather than duration. `fetch` still has
 * no default timeout, and the property this had to preserve is unchanged: a
 * stalled chunk is recorded as unreachable and the run continues, because a
 * partial audit that names its gaps is worth having and one that pretends to
 * be complete is not.
 */

/**
 * The budget, in tokens.
 *
 * It used to be `--budget-usd`, priced from OpenRouter's published $0.085 /
 * $0.40 per Mtok. NVIDIA Build publishes no per-token list price and the API
 * returns no rate, so a dollar figure here would be a number nobody could
 * reproduce from anything in this repo — exactly what ground rule 2 forbids.
 *
 * The gate did not go away; it changed denomination to the unit the endpoint
 * actually reports. 3,000,000 is roughly one full-repository pass at the
 * current chunking (17 chunks, worst-cased at the 32K output ceiling each),
 * so the default admits one whole-system audit and refuses a runaway.
 */
const DEFAULT_BUDGET_TOKENS = 3_000_000;

/**
 * A 429 is a "come back shortly", not a failure to audit. Recording it as
 * unreachable would put a chunk in the "not covered" list for a reason that
 * resolves itself in seconds — the report would be honest and needlessly
 * incomplete.
 *
 * Bounded, because the alternative shape is a script that waits forever on a
 * quota that will not reset within the run.
 */
const RATE_LIMIT_MAX_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 15_000;
/** A Retry-After longer than this is a quota, not a burst. Stop, and say so. */
const RATE_LIMIT_MAX_WAIT_MS = 180_000;
// The pinned auditor reasons into `content` before it answers. At 8000 the
// first real run spent the whole ceiling on deliberation and returned no JSON
// at all, which surfaced as a parse failure rather than as the budget problem
// it was. This is sized for the reasoning, not for the answer.
const MAX_OUTPUT_TOKENS = 32_000;

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * Subsystem boundaries, ordered most-specific-first because the first match
 * wins. These are drawn along the lines the codebase actually has rather than
 * by directory depth, so that a subsystem is a thing someone could describe in
 * a sentence — "the pipeline", "the preview tiers" — and a finding about it
 * lands somewhere a person would think to look.
 */
export const SUBSYSTEMS = [
  ['pipeline', /^apps\/web\/src\/(pipeline|agents)\//],
  ['orchestration', /^apps\/web\/src\/durable-objects\//],
  ['routes', /^apps\/web\/src\/routes\//],
  ['worker-core', /^apps\/web\/src\/(index|env)\.ts$/],
  ['lib', /^apps\/web\/src\/lib\//],
  ['views', /^apps\/web\/src\/(views|components)\//],
  ['shared', /^packages\/shared\//],
  ['cohere', /^packages\/cohere\//],
  // packages/admin/ moved to DISCOMPLEMENTED_ADMIN when this repo went public.
  // The rule follows the code that is actually here — the stub — rather than
  // being deleted, so admin-stub keeps falling in a named subsystem instead of
  // silently dropping into 'other'.
  ['admin-stub', /^packages\/admin-stub\//],
  ['migrations', /^migrations\//],
  ['simulation', /^simulation\//],
  ['build-and-ci', /^(scripts\/|\.github\/|.*\.config\.(ts|js|mjs)$)/],
];

export function subsystemOf(path) {
  for (const [name, re] of SUBSYSTEMS) if (re.test(path)) return name;
  return 'other';
}

/**
 * Tracked source files, excluding tests.
 *
 * Tests are excluded on purpose and it is worth saying why, because including
 * them looks like more rigour. A test file states what someone believed the
 * code should do. Feeding both to a model asking "does this add up" invites it
 * to check the code against the test — which is what the test suite already
 * does, for free, deterministically, in 56 seconds. The gap this script exists
 * to find is the one *neither* the code nor the tests mention. Sending the
 * tests would fill that silence with reassurance.
 */
export function sourceFiles() {
  return git(['ls-files'])
    .split('\n')
    .filter(Boolean)
    .filter((p) => /\.(ts|tsx|js|mjs|py|sql|toml|yml)$/.test(p))
    .filter((p) => !/\.(test|spec)\.[jt]sx?$/.test(p))
    .filter((p) => !/^(node_modules|dist|\.audit)\//.test(p))
    .filter((p) => !/^apps\/web\/tests\//.test(p));
}

/**
 * Group files into chunks that fit the context, keeping a subsystem's files
 * adjacent. A subsystem larger than one chunk is split and the parts are
 * numbered, and the numbering is shown to the model — a model told it is
 * looking at "routes (2 of 3)" reports differently from one that believes it
 * has been handed everything.
 */
export function partition(files) {
  const bySub = new Map();
  for (const f of files) {
    const s = subsystemOf(f);
    if (!bySub.has(s)) bySub.set(s, []);
    bySub.get(s).push(f);
  }

  const chunks = [];
  for (const [name, list] of bySub) {
    let current = [];
    let currentTokens = 0;
    const parts = [];
    for (const f of list) {
      const size = Math.ceil(
        readFileSync(resolve(ROOT, f), 'utf8').length / CHARS_PER_TOKEN
      );
      if (currentTokens + size > MAX_SUBSYSTEM_TOKENS && current.length) {
        parts.push({ files: current, tokens: currentTokens });
        current = [];
        currentTokens = 0;
      }
      current.push(f);
      currentTokens += size;
    }
    if (current.length) parts.push({ files: current, tokens: currentTokens });
    parts.forEach((p, i) =>
      chunks.push({
        subsystem: name,
        part: i + 1,
        parts: parts.length,
        files: p.files,
        tokens: p.tokens,
      })
    );
  }
  return chunks;
}

/**
 * The seam extract: the facts a partition destroys.
 *
 * Splitting a repository by directory severs exactly the relationships that
 * produced this overhaul's worst defects, because each half looks correct
 * alone. A router that is never mounted is only wrong when you hold the router
 * and `index.ts` at once. A cron with no handler needs `wrangler.toml` and
 * `cron-handler.ts` together. A migration that never ran needs the directory
 * listing and the ledger. So these are pulled out as text and sent as their
 * own chunk, with nothing else competing for attention.
 */
export function seamExtract() {
  const read = (p) =>
    existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : '';

  const index = read('apps/web/src/index.ts');
  const mounts = [...index.matchAll(/^app\.(route|use)\((.*)$/gm)]
    .map((m) => m[0])
    .join('\n');
  const imports = [...index.matchAll(/^import .*Routes.*$/gm)]
    .map((m) => m[0])
    .join('\n');

  const wrangler = read('apps/web/wrangler.toml');
  const crons = [...wrangler.matchAll(/crons\s*=\s*\[[^\]]*\]/g)]
    .map((m) => m[0])
    .join('\n');
  const cronCases = [
    ...read('apps/web/src/lib/cron-handler.ts').matchAll(/case\s+'[^']+':/g),
  ]
    .map((m) => m[0])
    .join('\n');

  const migrations = git(['ls-files', 'migrations'])
    .split('\n')
    .filter(Boolean)
    .join('\n');

  const workflows = git(['ls-files', '.github/workflows'])
    .split('\n')
    .filter(Boolean)
    .map((p) => {
      const y = read(p);
      const sched = [...y.matchAll(/cron:\s*'([^']+)'/g)]
        .map((m) => m[1])
        .join(', ');
      return `${p}${sched ? `  schedule: ${sched}` : '  (no schedule)'}`;
    })
    .join('\n');

  return `
## Every route mount and middleware registration in apps/web/src/index.ts
Order matters here: a middleware registered before a route applies to it.
\`\`\`
${imports}

${mounts}
\`\`\`

## Cron schedules configured (wrangler.toml) vs cases handled (cron-handler.ts)
\`\`\`
${crons}

${cronCases}
\`\`\`

## Migration files on disk
\`\`\`
${migrations}
\`\`\`

## GitHub workflow files and their schedules
\`\`\`
${workflows}
\`\`\`
`.trim();
}

const SYSTEM_PROMPT = `
You are auditing a production codebase for defects of one specific kind:
code that exists, is syntactically correct, passes its tests, looks finished,
and does nothing — or does something other than what the surrounding code
assumes it does.

Concrete examples of the class, all of them real defects found in this
repository:

  - a router imported into the app entry point and never mounted, so every
    one of its endpoints returned 404 while the file looked complete;
  - a handler gating on a context variable that nothing in the codebase ever
    sets, so it refused every caller including a legitimate admin;
  - a function defined below the module's entry point, so the run that was
    supposed to call it finished before it existed, and the column it fills
    was NULL on every row;
  - a scheduled trigger configured with no matching handler case, where the
    switch's default branch logs and returns, so the job fired nightly and
    silently did nothing;
  - a value bound from a request body under a key the sender never sends, so
    the insert stored NULL and the endpoint answered 200.

What unites these: no error, no failing test, no exception. The only signal
was that two files disagreed and nothing compared them.

Report ONLY findings of this kind, plus outright security defects. Do NOT
report style, naming, formatting, missing comments, "consider extracting",
test coverage opinions, or anything you would phrase as a suggestion.

Every finding MUST have a file, a line, and a concrete failure scenario
stating the inputs or conditions and the resulting wrong behaviour. A finding
you cannot write a failure scenario for is not a finding — drop it.

You are reading source only. You cannot see the deployed state, the database
contents, or whether anything has ever actually run. Where a finding depends
on runtime state, say so in "check" — name the command or query that would
settle it. Do not assert as fact anything you inferred from source alone.

Respond with JSON only:
{"findings":[{"severity":"high|medium|low","category":"kebab-case",
"file":"path","line":123,"summary":"one sentence",
"failure_scenario":"inputs/state -> wrong result",
"check":"command or query that would confirm or refute this"}]}
Empty findings array is a valid and expected answer.
`.trim();

async function callAuditor({ model, userPrompt, maxTokens = MAX_OUTPUT_TOKENS }) {
  let progressDots = 0;
  const key = auditorKey();
  if (!key) {
    return {
      outcome: 'unreachable',
      error:
        `${AUDITOR_KEY_VAR} is not set, so the independent auditor could not ` +
        'be called. This is a refusal, not a clean report.',
    };
  }
  if (!model.includes('/')) {
    return {
      outcome: 'unreachable',
      error: `Auditor model "${model}" is not an independent-provider slug. Refusing to run.`,
    };
  }

  const started = Date.now();
  let call;
  let attempt = 0;
  // Retries 429 and 503 only. Both mean "come back shortly" and nothing about
  // the request; every other status falls straight through to the refusal
  // below, because retrying a 402 or a 400 spends wall-clock to arrive at the
  // same answer and a script that retries everything cannot tell "busy" from
  // "wrong".
  //
  // 503 was added on 2026-08-30 after the first NVIDIA run: the endpoint
  // answered `{"message":"Service temporarily overloaded"}` and the chunk was
  // recorded as unreachable, so a whole-system audit came back with a
  // subsystem missing for a condition that clears in seconds. That is not a
  // weakened check — an unretried 503 makes the audit report LESS complete,
  // and the bound below is the same one that already caps 429.
  for (;;) {
    try {
      call = await postChatCompletion({
        key,
        model,
        system: SYSTEM_PROMPT,
        user: userPrompt,
        maxTokens,
        // A dot per 4KB of output. Not decoration: the whole reason this is
        // streamed is that a thinking model and a dead socket are otherwise
        // indistinguishable, and that is as true for the person watching the
        // terminal as it is for the timeout.
        onProgress: (len) => {
          if (Math.floor(len / 4096) > progressDots) {
            progressDots = Math.floor(len / 4096);
            process.stdout.write('.');
          }
        },
      });
    } catch (err) {
      return {
        outcome: 'unreachable',
        error:
          err.name === 'AuditorStall'
            ? err.message
            : `network error: ${err.message}`,
      };
    }

    if (call.ok) break;
    if (call.status !== 429 && call.status !== 503) break;

    // Honour Retry-After when the provider sends one — it knows when the
    // window opens and exponential backoff is a guess. Seconds or an HTTP
    // date, per RFC 9110.
    const header = call.headers.get('retry-after');
    let waitMs = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
    if (header) {
      const seconds = Number(header);
      const parsed = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(header) - Date.now();
      if (Number.isFinite(parsed) && parsed > 0) waitMs = parsed;
    }

    if (waitMs > RATE_LIMIT_MAX_WAIT_MS) {
      // A window this far out is a daily quota, not a burst limit. Waiting it
      // out inside one run would mean an audit that appears to hang for hours.
      return {
        outcome: 'unreachable',
        error:
          `rate limited, and the provider asked for ${Math.round(waitMs / 1000)}s — ` +
          'longer than a burst limit, so this is a quota. Chunk not audited; ' +
          're-run later, or narrow the run with --subsystem.',
      };
    }

    if (attempt >= RATE_LIMIT_MAX_RETRIES) {
      return {
        outcome: 'unreachable',
        error:
          `rate limited on all ${RATE_LIMIT_MAX_RETRIES + 1} attempts (last wait ` +
          `${Math.round(waitMs / 1000)}s). Chunk not audited — this is a refusal, ` +
          'not a clean report.',
      };
    }

    process.stdout.write(
      `${call.status}, waiting ${Math.round(waitMs / 1000)}s ... `
    );
    await new Promise((r) => setTimeout(r, waitMs));
    attempt += 1;
  }

  if (!call.ok) {
    return {
      outcome: 'unreachable',
      error: `auditor endpoint returned ${call.status}: ${call.bodyText}`,
    };
  }

  const { content, finishReason, usage } = call;

  // The pinned auditor is a reasoning model and will happily emit its
  // deliberation around the JSON even in json_object mode. Pull the outermost
  // object rather than trusting the whole string to parse — but only after a
  // direct parse fails, so a well-formed response is never reinterpreted.
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const first = content.indexOf('{');
    const last = content.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        parsed = JSON.parse(content.slice(first, last + 1));
      } catch {
        /* fall through to the refusal below */
      }
    }
  }

  if (!parsed) {
    // Unparseable output is not a clean audit. Counting it as one is the
    // single easiest way to turn this into decoration.
    //
    // Two different things arrive here and they need different fixes, so they
    // are named separately. The pinned auditor is a reasoning model that emits
    // its deliberation into `content`; when the budget runs out mid-thought
    // the response ends before any JSON is produced. That is a budget defect
    // in this script (raise maxTokens), not a malformed model. Reporting both
    // as "unparseable" sent me looking at the parser for a problem that was in
    // the request.
    const truncated = finishReason === 'length';
    return {
      outcome: 'refused',
      error: truncated
        ? `auditor response hit the ${maxTokens}-token ceiling before emitting JSON ` +
          `(finish_reason=length, ${usage.completion_tokens ?? '?'} completion tokens). ` +
          `Not a malformed response — an unfinished one. Raise maxTokens. ` +
          `Output began: ${content.slice(0, 300)}`
        : `auditor returned unparseable output (finish_reason=${finishReason}, ` +
          `${content.length} chars): ${content.slice(0, 600)}`,
      durationMs: Date.now() - started,
      usage,
    };
  }

  return { outcome: 'completed', parsed, durationMs: Date.now() - started, usage };
}

/**
 * §4B req 4, applied here too: a finding without a file, a line and a failure
 * scenario is dropped, and the drop is counted. "Consider adding error
 * handling" cannot be acted on, and it must not be able to pad a finding count
 * into looking like diligence.
 */
export function keepSpecific(findings, chunkFiles) {
  const kept = [];
  const dropped = [];
  for (const f of findings ?? []) {
    const bad =
      !f.file ||
      !Number.isInteger(f.line) ||
      !f.failure_scenario ||
      String(f.failure_scenario).trim().length < 20;
    if (bad) {
      dropped.push(f);
      continue;
    }
    // A finding about a file that was not in the chunk is a hallucinated
    // location. It may still describe something real, but the line number is
    // meaningless and a person would go to the wrong place.
    f.file_in_scope = chunkFiles.includes(f.file);
    kept.push(f);
  }
  return { kept, dropped };
}

function buildPrompt(chunk, seams) {
  const body = chunk.files
    .map((f) => {
      const text = readFileSync(resolve(ROOT, f), 'utf8');
      const numbered = text
        .split('\n')
        .map((l, i) => `${String(i + 1).padStart(4)} ${l}`)
        .join('\n');
      return `### ${f}\n\`\`\`\n${numbered}\n\`\`\``;
    })
    .join('\n\n');

  const scope =
    chunk.parts > 1
      ? `You are seeing part ${chunk.part} of ${chunk.parts} of this subsystem. ` +
        'Files from the other parts are NOT shown. Do not report something as ' +
        'missing solely because you cannot see it here.'
      : 'You are seeing this subsystem in full.';

  return `
# Subsystem: ${chunk.subsystem}

${scope}

Files are shown with line numbers. Report the line number as printed.

${body}

---

# Wiring facts for the whole repository

These are extracted so that cross-file defects remain visible even though the
source above is only one subsystem. Use them to check that what the subsystem
declares is actually connected to something.

${seams}
`.trim();
}

function loadPrior(path) {
  if (!path) return null;
  const p = resolve(ROOT, path);
  if (!existsSync(p)) throw new Error(`--since file not found: ${path}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function main() {
  const argv = process.argv;
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const dryRun = argv.includes('--dry-run');
  const only = arg('--subsystem', null);
  const budgetTokens = Number(arg('--budget-tokens', DEFAULT_BUDGET_TOKENS));
  const passNum = Number(arg('--pass', '1'));
  const prior = loadPrior(arg('--since', null));

  // Refused loudly rather than accepted and ignored. `--budget-usd 2` used to
  // be the documented invocation, and a script that silently disregards the
  // flag someone typed to bound their spend is worse than one that never had
  // a budget: the operator believes there is a ceiling where there is none.
  if (argv.includes('--budget-usd')) {
    console.error(
      '\n--budget-usd no longer exists. The auditor moved from OpenRouter to ' +
        'NVIDIA on 2026-08-30, and NVIDIA publishes no per-token list price — ' +
        'a dollar ceiling here would be enforced against a rate this repo ' +
        'invented. Use --budget-tokens (default ' +
        `${DEFAULT_BUDGET_TOKENS.toLocaleString()}).\n`
    );
    process.exit(2);
  }
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    console.error(
      `--budget-tokens must be a positive number, got "${budgetTokens}"`
    );
    process.exit(2);
  }
  if (passNum > MAX_PASSES) {
    // The bound, enforced rather than documented. See the header.
    console.error(
      `--pass ${passNum} exceeds MAX_PASSES=${MAX_PASSES}. A third pass is not ` +
        'a better audit, it is a negotiation with the auditor. If findings ' +
        'remain after pass 2, escalate to a human instead.'
    );
    process.exit(2);
  }

  const model = auditorModel();
  const sha = git(['rev-parse', 'HEAD']).trim();
  let chunks = partition(sourceFiles());
  if (only) chunks = chunks.filter((c) => c.subsystem === only);
  if (!chunks.length) {
    console.error(
      `No files matched${only ? ` --subsystem ${only}` : ''}. Known subsystems: ` +
        SUBSYSTEMS.map(([n]) => n).join(', ')
    );
    process.exit(2);
  }

  const seams = seamExtract();
  const seamTokens = Math.ceil(seams.length / CHARS_PER_TOKEN);
  const estIn = chunks.reduce((n, c) => n + c.tokens + seamTokens, 0);
  // Worst case, deliberately: every chunk is counted as if it used the whole
  // output ceiling. A budget gate that estimates optimistically is a budget
  // gate that lets the run exceed the number the user typed.
  const estTotal = estIn + chunks.length * MAX_OUTPUT_TOKENS;

  // Printed every run, not documented once. The person running this is
  // choosing to send this repository's source to a third party, and that
  // choice should be in front of them at the moment they make it rather than
  // in a comment they read a month ago.
  console.log(
    '\nThis run sends this repository\'s own source to NVIDIA, which is ours\n' +
      'to disclose. It does NOT send any user\'s generated code.'
  );

  console.log(`\nmodel      ${model}`);
  console.log(`commit     ${sha.slice(0, 12)}`);
  console.log(`pass       ${passNum} of ${MAX_PASSES}`);
  console.log(`chunks     ${chunks.length}`);
  console.log(`est. input ~${estIn.toLocaleString()} tokens`);
  console.log(
    `est. total ~${estTotal.toLocaleString()} tokens ` +
      `(budget ${budgetTokens.toLocaleString()})\n`
  );
  for (const c of chunks) {
    const label =
      c.parts > 1 ? `${c.subsystem} (${c.part}/${c.parts})` : c.subsystem;
    console.log(
      `  ${label.padEnd(28)} ${String(c.files.length).padStart(3)} files  ~${c.tokens.toLocaleString()} tok`
    );
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing sent, nothing spent.\n');
    return;
  }

  if (estTotal > budgetTokens) {
    // Refused, not clamped — the same choice the simulation engine makes about
    // its credit budget. Silently auditing a subset would produce a report
    // that reads as whole-system and is not.
    console.error(
      `\nEstimated ${estTotal.toLocaleString()} tokens exceeds --budget-tokens ` +
        `${budgetTokens.toLocaleString()}. Raise the budget deliberately or ` +
        'narrow with --subsystem. Refusing rather than auditing part of the ' +
        'system and calling it a whole-system audit.\n'
    );
    process.exit(2);
  }

  // Checked once, here, rather than discovered per-chunk. Without this the run
  // completes: every chunk records an honest "unreachable", the report is
  // written, and the summary correctly says nothing was audited — but it takes
  // the full wall-clock of a real run to say so, and a reader skimming the
  // finding count sees zero. A precondition that is only enforced at the point
  // of use is a precondition that gets discovered late.
  if (!auditorKey()) {
    console.error(
      `\n${AUDITOR_KEY_VAR} is not set. Refusing to start: every chunk would ` +
        'record as unreachable and the report would contain zero findings for ' +
        'a reason that has nothing to do with the code.\n'
    );
    process.exit(2);
  }

  const findings = [];
  const chunkResults = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let droppedTotal = 0;

  for (const chunk of chunks) {
    const label =
      chunk.parts > 1
        ? `${chunk.subsystem} (${chunk.part}/${chunk.parts})`
        : chunk.subsystem;
    process.stdout.write(`\nauditing ${label} ... `);

    const res = await callAuditor({
      model,
      userPrompt: buildPrompt(chunk, seams),
    });

    if (res.outcome !== 'completed') {
      console.log(res.outcome.toUpperCase());
      console.log(`    ${res.error}`);
      chunkResults.push({ ...chunk, outcome: res.outcome, error: res.error });
      continue;
    }

    tokensIn += res.usage.prompt_tokens ?? 0;
    tokensOut += res.usage.completion_tokens ?? 0;

    const { kept, dropped } = keepSpecific(res.parsed.findings, chunk.files);
    droppedTotal += dropped.length;
    for (const f of kept) findings.push({ ...f, subsystem: chunk.subsystem });

    const highs = kept.filter((f) => f.severity === 'high').length;
    console.log(
      `${kept.length} finding(s)${highs ? `, ${highs} HIGH` : ''}` +
        `${dropped.length ? ` (${dropped.length} dropped as unspecific)` : ''}`
    );
    chunkResults.push({
      ...chunk,
      outcome: 'completed',
      kept: kept.length,
      dropped: dropped.length,
    });
  }

  // Rank, and mark anything the previous pass already reported. A finding that
  // survives a pass is not automatically more real — it may just be one the
  // model is consistently wrong about — but it is the set worth reading first.
  const priorKeys = new Set(
    (prior?.findings ?? []).map((f) => `${f.file}:${f.summary}`)
  );
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
  );
  for (const f of findings) f.repeat = priorKeys.has(`${f.file}:${f.summary}`);

  const report = {
    kind: 'system-audit',
    model,
    // Named, because a report that says only "nvidia/nemotron-..." does not say
    // whether that came from NVIDIA directly or through a router, and the two
    // are different accounts with different keys.
    provider: auditorEndpoint(),
    commit: sha,
    pass: passNum,
    created_at: new Date().toISOString(),
    chunks: chunkResults,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    // Deliberately null, not 0 — "free" and "not priced" are different claims
    // and only the second one is true here. See COST_USD in auditor-provider.mjs.
    cost_usd: COST_USD,
    cost_basis:
      'NVIDIA Build publishes no per-token list price; this run is bounded and ' +
      'reported in tokens, not dollars.',
    dropped_unspecific: droppedTotal,
    findings,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `system-${sha.slice(0, 12)}-p${passNum}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
  console.log('\n' + '-'.repeat(66));
  console.log(
    `${findings.length} finding(s): ${bySeverity('high')} high, ` +
      `${bySeverity('medium')} medium, ${bySeverity('low')} low` +
      `${droppedTotal ? `  (${droppedTotal} dropped as unspecific)` : ''}`
  );
  console.log(
    `${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out ` +
      `(${(tokensIn + tokensOut).toLocaleString()} of ${budgetTokens.toLocaleString()} budgeted)`
  );
  console.log(`written to ${relative(ROOT, outPath)}`);

  // A run that could not reach part of the system is not a whole-system audit,
  // and the difference is invisible in a findings count — a subsystem that was
  // never audited contributes zero findings and reads as a clean one. Say it
  // where the numbers are, not only in the JSON.
  const unreached = chunkResults.filter((c) => c.outcome !== 'completed');
  if (unreached.length) {
    console.log(
      `\n  ${unreached.length} of ${chunkResults.length} chunk(s) were NOT audited. ` +
        'This report does not cover:'
    );
    for (const c of unreached) {
      console.log(
        `    ${c.subsystem}${c.parts > 1 ? ` (${c.part}/${c.parts})` : ''} — ${c.error}`
      );
    }
  }

  for (const f of findings.filter((x) => x.severity === 'high')) {
    console.log(
      `\n  [HIGH] ${f.file}:${f.line}${f.file_in_scope ? '' : '  (FILE NOT IN CHUNK — location suspect)'}` +
        `${f.repeat ? '  (repeat)' : ''}\n    ${f.summary}\n    check: ${f.check ?? '(none given)'}`
    );
  }

  // Exit 0 regardless of findings. This is not a gate and must not become one
  // by accident — a CI job that starts failing on this script's output would
  // create pressure to make findings go away, which is the pressure this whole
  // design is built to avoid.
  console.log(
    '\nThese are hypotheses from a source-only read, not confirmed defects.' +
      '\nCheck each one against the named command before changing anything.\n'
  );
}

// Only when run as a program. The test file imports this module for its
// exports (partition, seamExtract, keepSpecific); an unconditional main() call
// meant importing it started a paid audit inside the test process. That was
// live before the key precondition made it visible.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
