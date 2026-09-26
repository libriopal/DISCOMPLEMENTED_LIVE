/**
 * The delegated request does not pay the rate limit twice.
 *
 * WHY THIS FILE EXISTS, and why it is not in `routes/mcp.test.ts`. That suite
 * asserts the MCP dispatcher SETS the delegation header. Setting a header is
 * not the property that matters — the property is that `requireAuth` acts on
 * it and skips the counter increment. A mutation proved the difference: deleting
 * the skip in this file left all 27 MCP tests green, because every one of them
 * measured the request going out rather than what the middleware did with it.
 * That is the vocabulary proxy in its purest form — measuring whether a property
 * is *described* rather than whether it *holds*.
 *
 * `checkRateLimit` is consumptive: `request_count = request_count + 1`. So the
 * only honest test counts the UPDATE statements, which is what this does with a
 * D1 stub that records every query it is handed.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  requireAuth,
  INTERNAL_DELEGATION_HEADER,
  INTERNAL_DELEGATION_NONCE,
  DELEGATION_ACK_HEADER,
  type AuthVariables,
} from './require-auth.js';

/** The user row `resolveVirtualKey` reads, for a key that is valid and unbanned. */
const USER_ROW = {
  id: 'user-1',
  tier: 'pro' as const,
  is_banned: 0,
  trial_expires_at: null,
  credits_remaining: 100,
};

/**
 * A D1 stub that records SQL and answers the two queries this path makes.
 *
 * Deliberately not a mock of `checkRateLimit`: mocking the function under
 * discussion would make the test pass for a version that never calls it. The
 * stub sits one layer lower, at the database, where "was the counter
 * incremented" is a fact rather than an assertion about a call.
 */
function db() {
  const sql: string[] = [];
  const stub = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind: () => statement,
        run: async () => ({ success: true }),
        first: async () => {
          if (query.includes('FROM users WHERE virtual_key')) return USER_ROW;
          if (query.includes('UPDATE rate_limit_windows'))
            return { request_count: 1 };
          return null;
        },
      };
      return statement;
    },
  };
  return {
    stub,
    /** How many times the consumptive increment actually ran. */
    increments: () =>
      sql.filter((q) => q.includes('SET request_count = request_count + 1'))
        .length,
  };
}

function app(database: unknown) {
  const a = new Hono<{ Bindings: any; Variables: AuthVariables }>();
  a.use('*', requireAuth);
  a.get('/probe', (c) =>
    c.json({ userId: c.get('userId'), tier: c.get('tier') })
  );
  return (headers: Record<string, string>) =>
    a.request('/probe', { headers }, { DB: database });
}

const KEY = { authorization: 'Bearer vk_test' };

describe('rate limiting is charged once per caller request', () => {
  it('an ordinary request increments the counter', async () => {
    const d = db();
    const res = await app(d.stub)(KEY);
    expect(res.status).toBe(200);
    expect(d.increments()).toBe(1);
  });

  it('a delegated request does NOT increment it', async () => {
    const d = db();
    const res = await app(d.stub)({
      ...KEY,
      [INTERNAL_DELEGATION_HEADER]: INTERNAL_DELEGATION_NONCE,
    });
    expect(res.status).toBe(200);
    expect(d.increments()).toBe(0);
  });

  it('one MCP tool call costs ONE token, not two', async () => {
    /*
     * The shape of a real tool call: the outer /mcp request, then the delegated
     * /api request. Before the fix this was 2, so a tier documented at N
     * requests per hour delivered N/2 tool calls and `entitlements` reported a
     * number that was not true.
     */
    const d = db();
    const request = app(d.stub);
    await request(KEY); // the /mcp request
    await request({
      ...KEY,
      [INTERNAL_DELEGATION_HEADER]: INTERNAL_DELEGATION_NONCE,
    });
    expect(d.increments()).toBe(1);
  });

  it('NEGATIVE CONTROL: a forged marker still pays', async () => {
    /*
     * The bypass this must not become. A constant marker would let any caller
     * skip the rate limit on any route by setting one header; the nonce is
     * per-isolate, so a wrong value falls through to the normal path and is
     * charged. This is the assertion that a guessable value would break.
     */
    const d = db();
    const res = await app(d.stub)({
      ...KEY,
      [INTERNAL_DELEGATION_HEADER]: 'internal',
    });
    expect(res.status).toBe(200);
    expect(d.increments()).toBe(1);
  });

  it('NEGATIVE CONTROL: the marker does not skip AUTHENTICATION', async () => {
    /*
     * Only the counter is suppressed. A delegated request with no key must be
     * refused exactly as an ordinary one is — otherwise the marker would be a
     * full auth bypass rather than a rate-limit exemption, which is a far worse
     * bug than the one it was introduced to fix.
     */
    const d = db();
    const res = await app(d.stub)({
      [INTERNAL_DELEGATION_HEADER]: INTERNAL_DELEGATION_NONCE,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the delegation acknowledgement is set only when it is true', () => {
  /*
   * Added because two mutants survived. `routes/mcp.test.ts` asserts the
   * DETECTOR reads this header correctly; nothing asserted that `requireAuth`
   * SETS it correctly, so deleting the line — or setting it unconditionally —
   * left all 38 tests green. Both mutations break the detector completely: with
   * the header never set, every authenticated tool call warns about a double
   * charge that is not happening; set unconditionally, a real double charge goes
   * unreported forever. The detector is only as good as this one line, and this
   * is the test of that line.
   */
  it('a delegated request comes back acknowledged', async () => {
    const res = await app(db().stub)({
      ...KEY,
      [INTERNAL_DELEGATION_HEADER]: INTERNAL_DELEGATION_NONCE,
    });
    expect(res.headers.get(DELEGATION_ACK_HEADER)).toBe('1');
  });

  it('NEGATIVE CONTROL: an ordinary request does NOT come back acknowledged', async () => {
    // The half that matters more. An acknowledgement on a request that WAS
    // charged tells the dispatcher everything is fine while the caller pays
    // twice -- the failure the whole mechanism exists to notice, made invisible.
    const res = await app(db().stub)(KEY);
    expect(res.headers.get(DELEGATION_ACK_HEADER)).toBeNull();
  });

  it('NEGATIVE CONTROL: a forged marker is not acknowledged either', async () => {
    const res = await app(db().stub)({
      ...KEY,
      [INTERNAL_DELEGATION_HEADER]: 'guessed',
    });
    expect(res.headers.get(DELEGATION_ACK_HEADER)).toBeNull();
  });
});
