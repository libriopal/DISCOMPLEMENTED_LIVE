/**
 * Local D1 access via `wrangler d1 execute --local`. Deliberately shells out
 * to the same CLI a human would use rather than reaching into
 * .wrangler/state/v3/d1's sqlite file directly — this is the same local
 * database `wrangler dev` (apps/web) reads/writes, so the harness sees
 * exactly what the running Worker sees, and there's no risk of touching a
 * remote/production D1 binding (--local is the whole point).
 *
 * This is ONLY ever pointed at apps/web's local D1. Nothing in this file
 * (or anywhere in qa-loop/) may be given a --remote flag.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { D1_DATABASE_NAME, WEB_APP_ROOT } from '../config.ts';

const execFileAsync = promisify(execFile);

export interface D1ExecResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta: Record<string, unknown>;
}

/** Runs a single SQL statement against the local D1 (apps/web's wrangler
 * config) and returns parsed rows. Throws on wrangler/D1 failure. */
export async function d1Query(sql: string): Promise<D1ExecResult[]> {
  const { stdout } = await execFileAsync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      D1_DATABASE_NAME,
      '--local',
      '--json',
      '--command',
      sql,
    ],
    { cwd: WEB_APP_ROOT, maxBuffer: 16 * 1024 * 1024 }
  );
  // wrangler sometimes prints non-JSON warnings to stdout before the JSON
  // array (e.g. update nags) — find the first '[' and parse from there.
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`wrangler d1 execute produced no JSON output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(jsonStart)) as D1ExecResult[];
}

/** Convenience: runs a query expected to return exactly one result set and
 * returns its `results` rows. */
export async function d1Rows<T = Record<string, unknown>>(
  sql: string
): Promise<T[]> {
  const [result] = await d1Query(sql);
  return (result?.results ?? []) as T[];
}
