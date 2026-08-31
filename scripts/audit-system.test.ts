import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs script, no type declarations, deliberately.
import {
  MAX_PASSES,
  SUBSYSTEMS,
  subsystemOf,
  sourceFiles,
  partition,
  seamExtract,
  keepSpecific,
} from './audit-system.mjs';

/**
 * The claim this script makes is "whole-system". That claim is the thing to
 * test, because it is the one that fails silently: a partition that quietly
 * drops files still produces a confident report, and the report reads exactly
 * the same as one that covered everything. A missing subsystem is invisible in
 * the output — which is precisely the defect class the script exists to find,
 * reproduced in the tool built to find it.
 */

const ROOT = resolve(__dirname, '..');

function runCli(args: string[]) {
  return spawnSync('node', [resolve(__dirname, 'audit-system.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // The budget and pass guards both return before any network call, so no
    // key is needed and none is passed — if a guard ever regressed into
    // running first, this would spend real money and the absence of a key is
    // the backstop.
    env: { ...process.env, NVIDIA_API_KEY: '' },
  });
}

describe('importing the module does not run an audit', () => {
  it('guards main() behind a direct-execution check', () => {
    // The import at the top of this file is the proof: without the guard,
    // loading the module for its exports starts a real, paid audit inside the
    // test process. Pinned so nobody removes the guard as dead code.
    const src = readFileSync(resolve(__dirname, 'audit-system.mjs'), 'utf8');
    expect(src).toMatch(
      /realpathSync\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/
    );
  });
});

describe('the partition covers the system it claims to cover', () => {
  it('places every source file in exactly one chunk', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);

    const chunks = partition(files);
    const placed = chunks.flatMap((c: { files: string[] }) => c.files);

    // No file lost.
    expect(new Set(placed).size).toBe(files.length);
    // No file counted twice — a duplicate would be paid for twice and could
    // produce the same finding under two subsystems.
    expect(placed.length).toBe(files.length);
    expect([...placed].sort()).toEqual([...files].sort());
  });

  it('routes each known subsystem to a real chunk', () => {
    // A regex that matches nothing sends its whole subsystem to "other",
    // where it is still audited but reported under a name that tells nobody
    // anything. That is a silent degradation, so name it.
    const files = sourceFiles();
    const seen = new Set(files.map(subsystemOf));
    const missing = SUBSYSTEMS.map(([n]: [string, RegExp]) => n).filter(
      (n: string) => !seen.has(n)
    );
    expect(
      missing,
      `these subsystem patterns matched no tracked file, so their rule is dead: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('does not let "other" become the biggest subsystem', () => {
    // "other" is the escape hatch. If it grows past every named subsystem the
    // partition has stopped meaning anything and the boundaries need redrawing.
    const files = sourceFiles();
    const counts = new Map<string, number>();
    for (const f of files)
      counts.set(subsystemOf(f), (counts.get(subsystemOf(f)) ?? 0) + 1);
    const other = counts.get('other') ?? 0;
    const biggestNamed = Math.max(
      ...[...counts.entries()].filter(([k]) => k !== 'other').map(([, v]) => v)
    );
    expect(other).toBeLessThanOrEqual(biggestNamed);
  });
});

describe('the seam extract carries the facts a partition destroys', () => {
  const seams: string = seamExtract();

  it('finds each seam, rather than emitting empty sections', () => {
    // Every one of these is a text scrape of a file that can be reformatted
    // without breaking a build. If a scrape silently returns nothing, the
    // seam section renders as an empty code fence and the model concludes
    // there are no routes — so assert content, not just that it ran.
    expect(seams).toContain('app.route(');
    expect(seams).toContain('crons = [');
    expect(seams).toMatch(/case '.+':/);
    expect(seams).toContain('migrations/001');
    expect(seams).toContain('.github/workflows/');
  });

  it('reports the nightly simulation schedule', () => {
    // The specific seam §3.5 turned on. A workflow listed with "(no schedule)"
    // when it has one means the schedule scrape broke.
    expect(seams).toMatch(/simulation\.yml\s+schedule: /);
  });
});

describe('findings must be specific to count', () => {
  it('drops a finding with no file, line, or failure scenario', () => {
    const { kept, dropped } = keepSpecific(
      [
        { severity: 'high', summary: 'Consider adding error handling' },
        { severity: 'high', file: 'a.ts', summary: 'no line' },
        {
          severity: 'high',
          file: 'a.ts',
          line: 10,
          summary: 'scenario too short',
          failure_scenario: 'bad',
        },
        {
          severity: 'high',
          file: 'a.ts',
          line: 10,
          summary: 'real',
          failure_scenario:
            'calling GET /x with no session returns 200 and leaks the row',
        },
      ],
      ['a.ts']
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(3);
    expect(kept[0].file_in_scope).toBe(true);
  });

  it('marks a finding about a file that was not in the chunk', () => {
    const { kept } = keepSpecific(
      [
        {
          severity: 'high',
          file: 'never/sent.ts',
          line: 3,
          summary: 'x',
          failure_scenario: 'a scenario long enough to be kept by the filter',
        },
      ],
      ['a.ts']
    );
    // Not dropped — it may describe something real — but the line number
    // points into a file the model never saw, so a reader must be told.
    expect(kept[0].file_in_scope).toBe(false);
  });
});

describe('the bounds are enforced, not documented', () => {
  it('refuses a third pass', () => {
    // The whole safety argument rests on this. "Re-pass until the model
    // approves" is the shape CONSTRAINT 6 forbids, so a third pass must be
    // impossible rather than discouraged.
    expect(MAX_PASSES).toBe(2);
    const r = runCli(['--pass', '3', '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('MAX_PASSES');
  });

  it('refuses a budget it would exceed rather than auditing a subset', () => {
    // --paid, because the gate is about money and the default tier is free.
    // A free run costs nothing, so it cannot exceed any positive budget — and
    // testing the gate against a run that spends nothing would assert that
    // zero is less than the budget, not that the gate works.
    const r = runCli(['--budget-tokens', '1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/exceeds --budget-tokens/);
    // The distinction that matters: it must not quietly audit what fits.
    expect(r.stderr).toContain('Refusing');
  });

  it('rejects a non-positive budget', () => {
    expect(runCli(['--budget-tokens', '0']).status).toBe(2);
    expect(runCli(['--budget-tokens', 'abc']).status).toBe(2);
  });

  it('refuses --budget-usd rather than ignoring it', () => {
    // `--budget-usd 2` was the documented invocation until 2026-08-30. An
    // unrecognised flag that is silently dropped leaves the operator believing
    // they set a ceiling, which is worse than having no ceiling at all.
    const r = runCli(['--dry-run', '--budget-usd', '2']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--budget-usd no longer exists');
    expect(r.stderr).toContain('--budget-tokens');
  });

  it('spends nothing on --dry-run', () => {
    const r = runCli(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing sent, nothing spent');
  });
});

describe('sending our source to a third party is stated, every run', () => {
  it('names what is sent and what is not', () => {
    const r = runCli(['--dry-run']);
    expect(r.status).toBe(0);
    // A person choosing to ship this repository's source to NVIDIA should see
    // it as they choose, not find it in a comment later.
    expect(r.stdout).toContain("repository's own source to NVIDIA");
    expect(r.stdout).toContain("does NOT send any user's generated code");
  });

  it('has no free tier left to advertise', () => {
    // OpenRouter's `:free` ids trained on submitted prompts, which is why this
    // script used a different model from the Worker. The direct NVIDIA
    // endpoint has one tier, so the split is gone rather than hidden — and a
    // `:free` suffix reaching the endpoint would 404 per chunk and be recorded
    // as "unreachable", i.e. as a network problem.
    const r = runCli(['--dry-run']);
    expect(r.stdout).not.toContain(':free');
    expect(r.stdout).not.toContain('trains on prompts');
  });

  it('budgets and reports in tokens, not in invented dollars', () => {
    // NVIDIA Build publishes no per-token list price and the API returns no
    // rate. A dollar figure here would be enforced against a number this repo
    // made up, which ground rule 2 forbids.
    const r = runCli(['--dry-run']);
    expect(r.stdout).toMatch(/est\. total\s+~[\d,]+ tokens/);
    expect(r.stdout).not.toMatch(/est\. cost/);
  });

  it('reads the model and the endpoint from the pinned module', () => {
    // Recomputing either here would drift the moment the pin moves, and the
    // drift would be invisible: an id the provider does not recognise fails
    // per-chunk, which reads as an unreachable provider.
    const src = readFileSync(resolve(__dirname, 'audit-system.mjs'), 'utf8');
    expect(src).toContain("from './auditor-provider.mjs'");
    expect(src).toContain('auditorModel()');
    expect(src).toContain('auditorEndpoint()');
    expect(src).not.toContain('openrouter.ai');
  });

  it('shares one provider module with the commit gate', () => {
    // The two gates read two different constants until 2026-08-30, so they
    // audited on two different models while both reported "the pinned
    // auditor". Findings that cannot be compared across the gates are worth
    // less than either gate alone.
    const diff = readFileSync(resolve(__dirname, 'audit-diff.mjs'), 'utf8');
    expect(diff).toContain("from './auditor-provider.mjs'");
    // The constant is named in a comment recording why it went away; what
    // must not survive is a read of it.
    expect(diff).not.toMatch(/export const AUDITOR_MODEL_DEV_FREE/);
    expect(diff).not.toContain('openrouter.ai');
  });
});

describe('rate limiting is retried, and the retry is bounded', () => {
  const src = readFileSync(resolve(__dirname, 'audit-system.mjs'), 'utf8');

  it('retries only the transients, so a 402 is not waited out', () => {
    // The 402 run that motivated all of this took the full wall-clock of a
    // real audit to report that the account had no credits. Retrying every
    // status would restore that, multiplied by the retry count. 429 and 503
    // are the two that say "come back shortly" and nothing about the request.
    expect(src).toContain(
      'if (call.status !== 429 && call.status !== 503) break;'
    );
  });

  it('honours Retry-After rather than guessing', () => {
    expect(src).toContain("call.headers.get('retry-after')");
  });

  it('bounds both the attempt count and the wait', () => {
    // A free-tier daily quota does not reset inside a run. Without the wait
    // ceiling the script would sit on a `Retry-After: 3600` looking hung, and
    // "hung" and "working" are indistinguishable from outside.
    expect(src).toMatch(/const RATE_LIMIT_MAX_RETRIES = \d+;/);
    expect(src).toMatch(/const RATE_LIMIT_MAX_WAIT_MS = [\d_]+;/);
    expect(src).toContain('attempt >= RATE_LIMIT_MAX_RETRIES');
    expect(src).toContain('waitMs > RATE_LIMIT_MAX_WAIT_MS');
  });

  it('records exhausted retries as unreachable, never as a clean chunk', () => {
    // The whole design rests on this distinction and rate limiting is the
    // newest way to blur it: a chunk that gave up after four 429s contributes
    // the same zero findings as a chunk that was audited and was clean.
    const start = src.indexOf(
      'if (call.status !== 429 && call.status !== 503) break;'
    );
    const end = src.indexOf('if (!call.ok) {');
    const window = src.slice(start, end);
    expect(window).toContain('rate limited on all');
    expect(window).not.toMatch(/outcome: 'completed'/);
    for (const m of window.matchAll(/outcome: '(\w+)'/g)) {
      expect(m[1]).toBe('unreachable');
    }
  });
});

describe('an incomplete run cannot read as a clean one', () => {
  const src = readFileSync(resolve(__dirname, 'audit-system.mjs'), 'utf8');

  it('bounds every request so a stalled provider cannot hang the run', () => {
    // fetch has no default timeout. Without a bound, a provider that accepts
    // the connection and then stalls hangs forever, and a run that never
    // returns is indistinguishable from a slow one.
    //
    // The bound MOVED on 2026-08-30, it was not removed. It used to be a
    // 240s ceiling on the whole request, asserted here as
    // `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`. Measured against the pinned
    // NVIDIA model, a real ~19K-token audit prompt runs well past 240s
    // because the model reasons before it answers — so every chunk aborted
    // and the report read "0 findings" for a reason unrelated to the code.
    // Raising the ceiling would have hidden a dead connection behind a slow
    // one; streaming distinguishes them, so the timeout now measures silence
    // (STREAM_STALL_MS) with a separate absolute ceiling (STREAM_TOTAL_MS)
    // that a dribbling response still cannot outlast.
    expect(src).toContain('postChatCompletion');
    expect(src).not.toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');

    const provider = readFileSync(
      resolve(__dirname, 'auditor-provider.mjs'),
      'utf8'
    );
    expect(provider).toMatch(/export const STREAM_STALL_MS = [\d_]+;/);
    expect(provider).toMatch(/export const STREAM_TOTAL_MS = [\d_]+;/);
    // Both timers must actually reach the request, and silence must re-arm
    // the idle timer on every chunk — otherwise the "stall" timeout is just
    // the total timeout under a different name.
    expect(provider).toContain('signal: controller.signal');
    expect(provider).toContain('setTimeout(() => controller.abort(), totalMs)');
    expect(provider).toContain('armIdle()');
  });

  it('refuses to start without a key rather than producing an empty report', () => {
    // Found the hard way: the first real run of this script was launched from
    // a shell without the key exported. Every chunk recorded an honest
    // "unreachable" and the summary said so — but it spent the full wall-clock
    // of a real audit to reach a report whose finding count was zero for a
    // reason unrelated to the code. Honest late is still late.
    const r = runCli(['--budget-tokens', '3000000']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NVIDIA_API_KEY is not set');
    expect(r.stderr).toContain('Refusing to start');
  });

  it('names the chunks it failed to audit in the printed summary', () => {
    // A subsystem that was never audited contributes zero findings, which is
    // the same number a clean subsystem contributes. The distinction has to be
    // stated where the counts are printed, not only buried in the JSON.
    expect(src).toContain(
      "chunkResults.filter((c) => c.outcome !== 'completed')"
    );
    expect(src).toContain('This report does not cover:');
  });
});

describe('it is not a gate and must not become one', () => {
  it('is not wired into any git hook or CI workflow', () => {
    // A CI job failing on this script's output would create pressure to make
    // findings disappear — the exact pressure the design avoids. If someone
    // adds it to a hook later, this fails and they have to read why.
    const hooks = spawnSync(
      'git',
      ['ls-files', '.husky', '.github/workflows'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      }
    ).stdout;
    for (const f of hooks.split('\n').filter(Boolean)) {
      expect(
        readFileSync(resolve(ROOT, f), 'utf8'),
        `${f} invokes audit-system.mjs. It is advisory by design and exits 0 ` +
          'on findings; wiring it to a gate makes its output something to ' +
          'suppress rather than read.'
      ).not.toContain('audit-system');
    }
  });

  it('exits 0 even when it has findings to report', () => {
    // Asserted on the source rather than by running a paid audit: the tail of
    // main(), where findings have been counted and printed, must fall out
    // normally.
    //
    // Scoped to end at `main().catch` deliberately. That handler exits 1 and
    // should: an unexpected throw is a broken run, not a report of findings,
    // and the two must not be conflated in either direction.
    const src = readFileSync(resolve(__dirname, 'audit-system.mjs'), 'utf8');
    const start = src.indexOf('These are hypotheses');
    const end = src.indexOf('main().catch');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/process\.exit\([1-9]/);
  });
});
