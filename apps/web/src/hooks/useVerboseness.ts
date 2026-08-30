/**
 * The founder's verboseness setting, loaded from and saved to their account.
 *
 * Optimistic: the level changes locally the moment it is clicked and the PATCH
 * follows. The next `/messages` poll carries the new level as a query
 * parameter, so the transcript widens within one poll interval rather than
 * waiting on a round trip — and if the PATCH fails, the level is rolled back
 * and said out loud, because a control that silently forgets what it was told
 * is worse than one that refuses.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_VERBOSENESS,
  normalizeVerboseness,
  type Verboseness,
} from '../lib/verboseness.js';

export function useVerboseness() {
  const [verboseness, setVerbosenessState] =
    useState<Verboseness>(DEFAULT_VERBOSENESS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
      .then((body) => {
        if (cancelled) return;
        const settings = (
          body as { settings?: { verboseness?: unknown } } | null
        )?.settings;
        if (settings) {
          setVerbosenessState(normalizeVerboseness(settings.verboseness));
        }
        setLoaded(true);
      })
      .catch(() => {
        // A settings read that fails leaves the default in place. The
        // transcript still renders; it just renders at `normal`.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setVerboseness = useCallback(
    (next: Verboseness) => {
      const previous = verboseness;
      setVerbosenessState(next);
      setError(null);
      fetch('/api/settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verboseness: next }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        })
        .catch(() => {
          setVerbosenessState(previous);
          setError('Could not save that setting — it has been put back.');
        });
    },
    [verboseness]
  );

  return { verboseness, setVerboseness, loaded, error };
}
