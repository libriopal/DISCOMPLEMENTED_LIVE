import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * §3.5 item 1: "Add a test that fails if any configured cron lacks a
 * handler."
 *
 * `handleCron` switches on `event.cron` and its `default:` branch logs and
 * returns. So a cron added to wrangler.toml without a matching `case` is a
 * job that fires on schedule, does nothing, and reports nothing — the same
 * silent-success shape as a green check that never ran. Nothing else in the
 * repo can see the disagreement, because the two halves live in a TOML file
 * and a TypeScript file that never import each other.
 *
 * This reads both as text on purpose. Importing `cron-handler.ts` would
 * prove that the module loads, not that it has a case for every schedule,
 * and there is no way to enumerate a `switch`'s labels at runtime.
 */

const ROOT = resolve(__dirname, '../../../..');
const WRANGLER = readFileSync(resolve(ROOT, 'apps/web/wrangler.toml'), 'utf-8');
const HANDLER = readFileSync(
  resolve(ROOT, 'apps/web/src/lib/cron-handler.ts'),
  'utf-8'
);

/**
 * Every `crons = [...]` block in wrangler.toml, keyed by the environment it
 * belongs to. There are three — top level, production, staging — and named
 * environments do not inherit top-level triggers in wrangler v4, so they are
 * three independent lists that have to agree.
 */
function cronBlocks(): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  const lines = WRANGLER.split('\n');
  let environment = 'top-level';
  let collecting: string[] | null = null;

  for (const line of lines) {
    const section = /^\s*\[+([^\]]+)\]+/.exec(line);
    if (section && collecting === null) {
      const name = section[1];
      environment = name.startsWith('env.')
        ? name.split('.').slice(0, 2).join('.')
        : 'top-level';
    }

    if (/^\s*crons\s*=\s*\[/.test(line)) {
      collecting = [];
      blocks.set(environment, collecting);
      continue;
    }
    if (collecting) {
      if (/^\s*\]/.test(line)) {
        collecting = null;
        continue;
      }
      // Cron strings only. A comment continuation line has no quoted value
      // and must not be mistaken for one.
      const quoted = /"([^"]+)"/.exec(line);
      if (quoted) collecting.push(quoted[1]);
    }
  }

  return blocks;
}

/** Every `case '...':` label in the handler's switch. */
function handledCrons(): string[] {
  return [...HANDLER.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1]);
}

describe('cron configuration and handlers agree', () => {
  it('finds the three trigger blocks wrangler v4 requires', () => {
    // If this fails, the parser above has drifted from the file and every
    // other assertion here is checking an empty list — which would pass.
    const blocks = cronBlocks();
    expect([...blocks.keys()].sort()).toEqual([
      'env.production',
      'env.staging',
      'top-level',
    ]);
    for (const [environment, crons] of blocks) {
      expect(crons.length, `${environment} has no crons`).toBeGreaterThan(0);
    }
  });

  it('has a handler case for every configured cron', () => {
    const handled = new Set(handledCrons());
    for (const [environment, crons] of cronBlocks()) {
      for (const cron of crons) {
        expect(
          handled.has(cron),
          `${environment} schedules "${cron}" but cron-handler.ts has no ` +
            'case for it, so it would fire and silently do nothing'
        ).toBe(true);
      }
    }
  });

  it('schedules the same crons in every environment', () => {
    // A cron added to the top-level block but not to [env.production] never
    // fires in production, and nothing at deploy time says so.
    const blocks = cronBlocks();
    const top = [...(blocks.get('top-level') ?? [])].sort();
    expect([...(blocks.get('env.production') ?? [])].sort()).toEqual(top);
    expect([...(blocks.get('env.staging') ?? [])].sort()).toEqual(top);
  });

  it('does not carry a handler case for a cron nothing schedules', () => {
    // The other direction: dead code that reads as coverage. A case with no
    // schedule is a job someone believes runs.
    const scheduled = new Set(
      [...cronBlocks().values()].flatMap((crons) => crons)
    );
    for (const cron of handledCrons()) {
      expect(
        scheduled.has(cron),
        `cron-handler.ts handles "${cron}" but no [triggers] block ` +
          'schedules it'
      ).toBe(true);
    }
  });

  it('schedules the Monte Carlo watchdog after the nightly engine run', () => {
    // The ordering is the whole design: the Actions workflow runs the engine
    // at 04:00 UTC and the watchdog reads what it ingested. A watchdog that
    // ran first would alert every morning that last night's run is missing.
    const workflow = readFileSync(
      resolve(ROOT, '.github/workflows/simulation.yml'),
      'utf-8'
    );
    const engineHour = /cron:\s*'(\d+)\s+(\d+)\s/.exec(workflow);
    expect(engineHour, 'simulation.yml has no schedule').not.toBeNull();

    const watchdog = [...cronBlocks().values()]
      .flat()
      .filter((c) => /^0 6 \* \* \*$/.test(c));
    expect(watchdog.length).toBeGreaterThan(0);
    expect(Number(engineHour![2])).toBeLessThan(6);
  });
});
