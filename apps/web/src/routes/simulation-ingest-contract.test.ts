import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The ingest contract spans two languages and nothing enforces it.
 *
 * `simulation/monte_carlo_engine.py` builds a JSON body; `routes/
 * simulation-ingest.ts` reads `body.<key>` and binds each one to a column. A
 * key spelled differently on one side does not fail — Hono hands back
 * `undefined`, `.bind(undefined)` stores NULL, the POST answers 200, and the
 * row lands looking complete with a hole in it. That is precisely how
 * `vdr_percent` was NULL on every row: not a mismatch, but a function that
 * was never called. The same silence would hide a rename.
 *
 * So: read both files as text and check that every key the route reads is one
 * the engine sends. Text, because a runtime check would need Python.
 */

const ROOT = resolve(__dirname, '../../../..');
const ROUTE = readFileSync(
  resolve(ROOT, 'apps/web/src/routes/simulation-ingest.ts'),
  'utf-8'
);
const ENGINE = readFileSync(
  resolve(ROOT, 'simulation/monte_carlo_engine.py'),
  'utf-8'
);

/** Every `body.<key>` the route reads. */
function routeKeys(): string[] {
  return [...new Set([...ROUTE.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]))];
}

/** Every `"key":` inside the engine's `to_ingest_payload` return dict. */
function engineKeys(): string[] {
  const start = ENGINE.indexOf('def to_ingest_payload');
  expect(start, 'to_ingest_payload is gone from the engine').toBeGreaterThan(
    -1
  );
  const end = ENGINE.indexOf('\nasync def ', start);
  const body = ENGINE.slice(start, end === -1 ? undefined : end);
  return [...new Set([...body.matchAll(/"(\w+)":/g)].map((m) => m[1]))];
}

describe('the Python engine and the ingest route agree on field names', () => {
  it('finds both halves', () => {
    // Without this, a parser that matches nothing makes the check below pass
    // over an empty list, which is the failure mode this whole file is about.
    expect(routeKeys().length).toBeGreaterThan(5);
    expect(engineKeys().length).toBeGreaterThan(5);
  });

  it('sends every field the route reads', () => {
    const sent = new Set(engineKeys());
    for (const key of routeKeys()) {
      expect(
        sent.has(key),
        `routes/simulation-ingest.ts binds body.${key} to a column, but ` +
          'to_ingest_payload in simulation/monte_carlo_engine.py does not ' +
          'send it — the column would silently store NULL'
      ).toBe(true);
    }
  });

  it('does not send a field the route ignores', () => {
    // The other direction is not an outage, but it is a lie in the source: a
    // key computed for an ingest that drops it.
    const read = new Set(routeKeys());
    for (const key of engineKeys()) {
      expect(
        read.has(key),
        `to_ingest_payload sends "${key}" but routes/simulation-ingest.ts ` +
          'never reads it'
      ).toBe(true);
    }
  });

  it('computes VDR before building the payload', () => {
    // `calculate_simulation_vdr` was defined below `if __name__ ==
    // "__main__"`, so the run finished before the function existed. Pin the
    // ordering that fixed it rather than the fact that it is called.
    const mainBlock = ENGINE.indexOf('if __name__ == "__main__":');
    const vdrDef = ENGINE.indexOf('def calculate_simulation_vdr');
    expect(vdrDef).toBeGreaterThan(-1);
    expect(
      vdrDef,
      'calculate_simulation_vdr is defined after the entry point again — it ' +
        'cannot be called by the run it is meant to measure'
    ).toBeLessThan(mainBlock);
    expect(ENGINE).toContain('calculate_simulation_vdr(bot_reports)');
  });

  it('refuses a budget above the engine hard cap', () => {
    // §3.5 item 3: "assert the hard caps still hold". A --budget that were
    // silently clamped would let the workflow file claim a ceiling the engine
    // never honoured.
    expect(ENGINE).toContain('if budget > TOTAL_CREDIT_BUDGET:');
    expect(ENGINE).toContain('raise ValueError(');
    expect(ENGINE).toContain('guard = CreditGuard(total_budget=budget)');
  });
});
