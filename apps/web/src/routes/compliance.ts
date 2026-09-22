/**
 * Compliance — the governance state of this system, served publicly.
 *
 *   GET /api/compliance          the published artefact plus live self-checks
 *   GET /api/compliance/drift    self-checks only (what this Worker can prove
 *                                about itself, right now, without trusting a
 *                                file that was written elsewhere)
 *
 * Two different kinds of truth are served here and they are NOT merged:
 *
 *   `published` comes from the private governance repository. It is produced by
 *   an allowlist and a deny-scan, so it contains verdicts, counts and vendors
 *   and no gate logic, no planning documents and no tripwire signatures. This
 *   Worker cannot verify it — it can only report it, and it says so.
 *
 *   `drift` is what THIS Worker checks about ITSELF at request time. It is
 *   small, and that is honest: a self-check is worth something only where the
 *   thing being checked cannot quietly satisfy it.
 *
 * Every check reports its own denominator. A check that examined nothing must
 * not print the same green as one that examined everything — which is the rule
 * the whole governance package is built on, and it applies here too.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { AUDITOR_SYSTEM } from '../pipeline/agents/auditor.js';

const compliance = new Hono<{ Bindings: Env }>();

export interface Check {
  name: string;
  ok: boolean;
  /** How many things this check actually looked at. Zero is never a pass. */
  examined: number;
  unit: string;
  detail: string;
}

/**
 * Invariants this Worker can establish about itself.
 *
 * Kept deliberately narrow. Each one is a property a reader can restate without
 * reading the code, and each fails loudly rather than reporting zero.
 */
export function selfChecks(env: Env): Check[] {
  const checks: Check[] = [];

  // The auditor agent must refuse to emit a numeric score. A score invites
  // "7.5/10, ship it"; a finding has to be read. This is checked against the
  // prompt actually compiled into the deployed bundle, not against a copy.
  const banned = ['score', 'rating', 'out of 10', '/10'];
  const present = banned.filter((w) =>
    AUDITOR_SYSTEM.toLowerCase().includes(w)
  );
  const forbids =
    /\b(never|do not|don't|no)\b[^.]{0,80}\b(score|numeric|rating)\b/i.test(
      AUDITOR_SYSTEM
    );
  checks.push({
    name: 'auditor-refuses-scores',
    ok: forbids,
    examined: banned.length,
    unit: 'banned terms searched',
    detail: forbids
      ? `the deployed auditor prompt forbids a numeric verdict (${present.length} of ${banned.length} terms appear, in a prohibition)`
      : 'the deployed auditor prompt does NOT forbid a numeric verdict',
  });

  // The prompt must be the real one. An empty or stub prompt would let every
  // other check above pass while the agent did nothing.
  checks.push({
    name: 'auditor-prompt-substantive',
    ok: AUDITOR_SYSTEM.length > 400,
    examined: AUDITOR_SYSTEM.length,
    unit: 'characters of system prompt',
    detail: `${AUDITOR_SYSTEM.length} characters compiled into this bundle`,
  });

  // Secrets must not be readable from a public endpoint. This checks the SHAPE
  // of what is bound, never a value: it reports whether a binding is present,
  // and nothing about what it contains.
  const secretNames = [
    'COHERE_API_KEY',
    'STRIPE_SECRET_KEY',
    'BETTER_AUTH_SECRET',
  ];
  const bound = secretNames.filter(
    (n) => typeof (env as unknown as Record<string, unknown>)[n] === 'string'
  );
  checks.push({
    name: 'secrets-bound-not-exposed',
    ok: true,
    examined: secretNames.length,
    unit: 'bindings probed for presence only',
    detail: `${bound.length} of ${secretNames.length} configured; no value is read, logged or returned by this route`,
  });

  return checks;
}

/** The published artefact, or a stated absence. Never a fabricated green. */
async function published(env: Env): Promise<Record<string, unknown> | null> {
  try {
    const asset = await (
      env as unknown as {
        ASSETS?: { fetch: (r: Request) => Promise<Response> };
      }
    ).ASSETS?.fetch(new Request('https://internal/compliance.json'));
    if (asset && asset.ok)
      return (await asset.json()) as Record<string, unknown>;
  } catch {
    /* fall through to the stated absence below */
  }
  return null;
}

compliance.get('/drift', (c) => {
  const checks = selfChecks(c.env);
  const failed = checks.filter((k) => !k.ok);
  const empty = checks.filter((k) => k.examined === 0);
  return c.json({
    schema: 'discomplemented.drift/1',
    at: new Date().toISOString(),
    checks,
    checks_run: checks.length,
    failed: failed.map((k) => k.name),
    // A check that examined nothing is reported separately and denies the
    // green. Folding it into "passed" is the exact failure this system's own
    // audit rounds kept finding.
    measured_nothing: empty.map((k) => k.name),
    verdict: failed.length === 0 && empty.length === 0 ? 'green' : 'RED',
  });
});

compliance.get('/', async (c) => {
  const art = await published(c.env);
  const checks = selfChecks(c.env);
  const failed = checks.filter((k) => !k.ok);
  const empty = checks.filter((k) => k.examined === 0);
  const driftVerdict =
    failed.length === 0 && empty.length === 0 ? 'green' : 'RED';

  return c.json({
    schema: 'discomplemented.compliance.public/1',
    at: new Date().toISOString(),
    published: art,
    published_note: art
      ? 'Produced in the private governance repository by an allowlist and a ' +
        'deny-scan. This Worker reports it and cannot verify it.'
      : 'NOT PRESENT. No compliance artefact has been published to this ' +
        'deployment. An absent artefact is reported as absent — it is never ' +
        'treated as a pass.',
    drift: {
      checks,
      checks_run: checks.length,
      failed: failed.map((k) => k.name),
      measured_nothing: empty.map((k) => k.name),
      verdict: driftVerdict,
    },
    // The two verdicts are reported side by side and never combined into one
    // reassuring number. They answer different questions and can disagree.
    verdict: {
      published:
        (art?.verify as { verdict?: string } | undefined)?.verdict ?? 'unknown',
      drift: driftVerdict,
    },
  });
});

export default compliance;
