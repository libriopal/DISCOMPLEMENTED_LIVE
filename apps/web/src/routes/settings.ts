/**
 * Per-user display settings.
 *
 * GET   /api/settings — the caller's settings, defaults filled in
 * PATCH /api/settings — change one or more of them
 *
 * §3.3 requires the verboseness level to persist *per user*, which is why
 * this is a D1 row and not `localStorage`. A founder who sets verbose on their
 * laptop and opens the same run on their phone is the same person watching the
 * same pipeline; a per-browser setting would tell them otherwise.
 *
 * There is no row until someone changes something. `GET` on a user who never
 * has returns the defaults rather than 404, and `PATCH` upserts — so the
 * absence of a row means "has not chosen", which is a different and more
 * useful fact than a row full of defaults written at signup.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import {
  DEFAULT_VERBOSENESS,
  normalizeVerboseness,
  VERBOSENESS_LEVELS,
  type Verboseness,
} from '../lib/verboseness.js';

export const settingsRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface SettingsRow {
  verboseness: string | null;
}

export interface UserSettings {
  verboseness: Verboseness;
}

/**
 * Reads a user's settings, filling in defaults for anything unset.
 *
 * Exported because the pipeline messages endpoint needs the same answer and
 * must not reach a different one: the level the founder is shown has to be the
 * level they chose, whichever route is asked.
 */
export async function loadUserSettings(
  db: D1Database,
  userId: string
): Promise<UserSettings> {
  const row = await db
    .prepare('SELECT verboseness FROM user_settings WHERE user_id = ?')
    .bind(userId)
    .first<SettingsRow>();

  return { verboseness: normalizeVerboseness(row?.verboseness) };
}

settingsRoutes.get('/', async (c) => {
  const settings = await loadUserSettings(c.env.DB, c.get('userId'));
  return c.json({ settings, verbosenessLevels: VERBOSENESS_LEVELS });
});

settingsRoutes.patch('/', async (c) => {
  const userId = c.get('userId');

  let body: { verboseness?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Rejected rather than normalised. `normalizeVerboseness` exists to make
  // *reading* a stored value safe; silently storing `normal` when the caller
  // asked for `chatty` would mean a UI that thinks it saved a setting it did
  // not, which is a harder bug to see than a 400.
  if (
    body.verboseness !== undefined &&
    !VERBOSENESS_LEVELS.includes(body.verboseness as Verboseness)
  ) {
    return c.json(
      {
        error: 'Unknown verboseness level',
        details: `Expected one of: ${VERBOSENESS_LEVELS.join(', ')}`,
      },
      400
    );
  }

  const verboseness =
    (body.verboseness as Verboseness | undefined) ??
    (await loadUserSettings(c.env.DB, userId)).verboseness ??
    DEFAULT_VERBOSENESS;

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO user_settings (user_id, verboseness, created_date, updated_date)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET verboseness = excluded.verboseness,
                                        updated_date = excluded.updated_date`
  )
    .bind(userId, verboseness, now, now)
    .run();

  return c.json({ settings: { verboseness } });
});
