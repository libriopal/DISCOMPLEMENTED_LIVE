import { describe, it, expect } from 'vitest';
import {
  assertChatMintQuota,
  recordChatMint,
  pruneChatMints,
  CHAT_MINTS_PER_HOUR,
  CHAT_MINTS_PER_DAY,
  CHAT_MINT_RETENTION_MS,
} from './chat-quota.js';

/**
 * A tiny in-memory stand-in for the one table this module touches. It is
 * deliberately not a mock that returns a canned count: the bug this file
 * exists to catch is a *format* bug — SQLite's datetime('now') writing
 * "2026-08-31 10:00:00" while the query compares against a toISOString()
 * bound — and a canned-count mock would report that as passing. So the fake
 * stores the strings that were actually bound and compares them the way
 * SQLite does: lexicographically.
 */
class FakeDb {
  rows: Array<{ id: string; user_id: string; created_date: string }> = [];

  prepare(sql: string) {
    const rows = this.rows;
    return {
      bind(...args: unknown[]) {
        return {
          async first<T>(): Promise<T> {
            const [userId, since] = args as [string, string];
            const count = rows.filter(
              (r) => r.user_id === userId && r.created_date >= since
            ).length;
            return { count } as T;
          },
          async run() {
            if (sql.startsWith('INSERT')) {
              const [id, user_id, created_date] = args as [
                string,
                string,
                string,
              ];
              rows.push({ id, user_id, created_date });
              return { meta: { changes: 1 } };
            }
            const [cutoff] = args as [string];
            // Spliced in place rather than reassigning `this.rows`, so the
            // array handed to an earlier prepare() is the same one the delete
            // shortens. Rebinding the field would have left a statement
            // captured before the prune still reading the pre-prune rows.
            const before = rows.length;
            const kept = rows.filter((r) => r.created_date >= cutoff);
            rows.splice(0, rows.length, ...kept);
            return { meta: { changes: before - rows.length } };
          },
        };
      },
    };
  }
}

const db = () => new FakeDb() as unknown as D1Database & { rows: unknown[] };

describe('the mint cap actually counts', () => {
  it('stores a timestamp the window query can compare against', async () => {
    // The regression guard. If recordChatMint ever goes back to
    // datetime('now'), the stored string is "YYYY-MM-DD HH:MM:SS" — no T, no
    // Z — which sorts BELOW every toISOString() bound, so countSince returns
    // 0 forever and the cap silently never fires. Assert the shape, then
    // assert a just-written row is actually visible to the counter.
    const d = db();
    const now = Date.parse('2026-08-31T10:00:00.000Z');
    await recordChatMint(d, 'u1', now);

    const stored = (d as unknown as FakeDb).rows[0]!.created_date;
    expect(stored).toBe('2026-08-31T10:00:00.000Z');

    const state = await assertChatMintQuota(d, 'u1', now);
    expect(state.lastHour).toBe(1);
    expect(state.lastDay).toBe(1);
  });

  it('refuses at the hourly cap and allows again once the window slides', async () => {
    const d = db();
    const t0 = Date.parse('2026-08-31T10:00:00.000Z');
    for (let i = 0; i < CHAT_MINTS_PER_HOUR; i++) {
      await recordChatMint(d, 'u1', t0 + i * 1000);
    }

    await expect(assertChatMintQuota(d, 'u1', t0 + 60_000)).rejects.toThrow(
      /12\/hour/
    );

    // Sliding, not fixed-bucket: an hour and a second after the FIRST mint,
    // that mint has left the window and one more is allowed. A fixed hourly
    // bucket would instead reset on the hour boundary and let a caller spend
    // two full windows back to back.
    const after = t0 + 60 * 60 * 1000 + 1000;
    await expect(assertChatMintQuota(d, 'u1', after)).resolves.toMatchObject({
      lastHour: CHAT_MINTS_PER_HOUR - 1,
    });
  });

  it('refuses at the daily cap even when the last hour is clear', async () => {
    const d = db();
    const t0 = Date.parse('2026-08-31T00:00:00.000Z');
    // Spread across the day so no single hour is ever over its own cap —
    // this is the case an hourly-only limit misses entirely.
    for (let i = 0; i < CHAT_MINTS_PER_DAY; i++) {
      await recordChatMint(d, 'u1', t0 + i * 20 * 60 * 1000);
    }
    const now = t0 + CHAT_MINTS_PER_DAY * 20 * 60 * 1000 + 60 * 60 * 1000;
    await expect(assertChatMintQuota(d, 'u1', now)).rejects.toThrow(/60\/day/);
  });

  it('counts per user, not globally', async () => {
    const d = db();
    const t0 = Date.parse('2026-08-31T10:00:00.000Z');
    for (let i = 0; i < CHAT_MINTS_PER_HOUR; i++) {
      await recordChatMint(d, 'noisy', t0 + i * 1000);
    }
    await expect(
      assertChatMintQuota(d, 'quiet', t0 + 60_000)
    ).resolves.toMatchObject({ lastHour: 0 });
  });
});

describe('pruning keeps the window intact', () => {
  it('never deletes a row the daily cap still needs', async () => {
    const d = db();
    const now = Date.parse('2026-08-31T10:00:00.000Z');
    // One row exactly at the edge of the daily window, one past retention.
    await recordChatMint(d, 'u1', now - 23 * 60 * 60 * 1000);
    await recordChatMint(d, 'u1', now - CHAT_MINT_RETENTION_MS - 1000);

    const removed = await pruneChatMints(d, now);
    expect(removed).toBe(1);

    const state = await assertChatMintQuota(d, 'u1', now);
    expect(state.lastDay).toBe(1);
  });
});
