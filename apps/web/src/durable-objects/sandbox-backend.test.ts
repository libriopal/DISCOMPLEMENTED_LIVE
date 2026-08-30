/**
 * Backend routing and container environment for the Tier 3 sandbox.
 *
 * Two properties worth pinning: a request meant for the generated API never
 * silently reaches Vite (which answers it with index.html and a 200, the
 * hardest possible failure to diagnose), and no platform secret can be placed
 * inside a container.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import {
  BACKEND_PORT,
  buildBackendCommand,
  buildContainerEnv,
  describeMissingBackend,
  findServerEntry,
  isBackendPath,
  matchRoutePattern,
} from './sandbox-backend.js';
import { DEV_SERVER_PORT } from './sandbox-preview.js';

const file = (path: string): ProjectFile => ({
  path,
  content: 'x'.repeat(1200),
  language: 'javascript',
});

describe('findServerEntry', () => {
  it('finds the file the Coder is told to write', () => {
    // agents/coder.ts §1 names server.js specifically.
    expect(findServerEntry([file('index.html'), file('server.js')])).toBe(
      'server.js'
    );
  });

  it('prefers the most conventional entry when several exist', () => {
    expect(findServerEntry([file('src/server.js'), file('server.js')])).toBe(
      'server.js'
    );
  });

  it('tolerates a ./ prefix', () => {
    expect(findServerEntry([file('./server.js')])).toBe('server.js');
  });

  it('returns null for a frontend-only file set', () => {
    expect(
      findServerEntry([file('index.html'), file('src/App.jsx')])
    ).toBeNull();
  });

  it('does not mistake a client file for a server', () => {
    // `src/api.js` is a fetch wrapper in most generated apps, not a server.
    expect(findServerEntry([file('src/api.js'), file('api.js')])).toBeNull();
  });
});

describe('describeMissingBackend', () => {
  it('says nothing when no API routes were promised', () => {
    expect(describeMissingBackend([file('index.html')], false)).toBeNull();
  });

  it('says nothing when the backend is present', () => {
    expect(describeMissingBackend([file('server.js')], true)).toBeNull();
  });

  it('explains the gap when routes were promised and no server written', () => {
    // Degradation has to be visible (§3.2 req 9). This is the text a founder
    // reads instead of watching every fetch 404 with no explanation.
    const message = describeMissingBackend([file('index.html')], true);
    expect(message).toMatch(/API routes/);
    expect(message).toMatch(/frontend is running/i);
  });
});

describe('isBackendPath', () => {
  it('routes /api/* to the backend with no blueprint at all', () => {
    // The fallback matters: a blueprint route list can be incomplete, and an
    // API call that reaches Vite gets index.html and a 200.
    expect(isBackendPath('/api/todos')).toBe(true);
    expect(isBackendPath('/api')).toBe(true);
    expect(isBackendPath('/api/v1/users/42')).toBe(true);
  });

  it('leaves frontend paths to Vite', () => {
    for (const path of ['/', '/index.html', '/src/main.jsx', '/assets/x.css']) {
      expect(isBackendPath(path)).toBe(false);
    }
  });

  it('does not route /apiary to the backend', () => {
    // A prefix check without the boundary would.
    expect(isBackendPath('/apiary')).toBe(false);
    expect(isBackendPath('/api-docs')).toBe(false);
  });

  it('routes a declared blueprint route outside /api', () => {
    expect(isBackendPath('/graphql', ['/graphql'])).toBe(true);
    expect(isBackendPath('/webhooks/stripe', ['/webhooks/stripe'])).toBe(true);
  });

  it('leaves Vite internals alone even with greedy blueprint routes', () => {
    // Vite's own module and HMR paths must never be captured, or the preview
    // stops loading modules entirely.
    expect(isBackendPath('/@vite/client', ['/graphql'])).toBe(false);
    expect(isBackendPath('/node_modules/.vite/deps/react.js', [])).toBe(false);
  });
});

describe('matchRoutePattern', () => {
  it('matches an Express-style parameter', () => {
    expect(matchRoutePattern('/todos/42', '/todos/:id')).toBe(true);
    expect(matchRoutePattern('/todos/42/items', '/todos/:id')).toBe(false);
  });

  it('matches a Next-style parameter', () => {
    expect(matchRoutePattern('/users/abc', '/users/[id]')).toBe(true);
  });

  it('matches a trailing wildcard', () => {
    expect(matchRoutePattern('/files/a/b/c', '/files/*')).toBe(true);
  });

  it('requires the same segment count without a wildcard', () => {
    expect(matchRoutePattern('/todos', '/todos/:id')).toBe(false);
    expect(matchRoutePattern('/todos/1/2', '/todos/:id')).toBe(false);
  });

  it('fails closed on a pattern that is not a path', () => {
    // Fails to Vite rather than to the backend: an unrecognised pattern must
    // not widen what the backend receives.
    expect(matchRoutePattern('/todos', 'todos')).toBe(false);
    expect(matchRoutePattern('/todos', 'GET /todos')).toBe(false);
  });
});

describe('buildBackendCommand', () => {
  it('does not collide with the Vite port', () => {
    expect(BACKEND_PORT).not.toBe(DEV_SERVER_PORT);
  });

  it('cds into the workdir before running', () => {
    // Every exec starts in `/`, not the image's WORKDIR — the bug that had
    // Vite serving the whole container filesystem. See sandbox-preview.ts.
    expect(buildBackendCommand('server.js', '/app')).toMatch(/^cd \/app &&/);
  });

  it('supplies PORT, which is what a generated server reads', () => {
    expect(buildBackendCommand('server.js', '/app')).toContain(
      `PORT=${BACKEND_PORT}`
    );
  });

  it('redirects output to a file, not the exec stdout pipe', () => {
    // An undrained exec pipe fills and blocks the process; that is how the
    // dev server used to stop serving mid-request.
    expect(buildBackendCommand('server.js', '/app')).toMatch(/> \S+ 2>&1$/);
  });
});

describe('buildContainerEnv', () => {
  const SECRET = 'sk-live-4f9a2b7c1e8d6a35f0b9c2d1e7a4f8b3';

  it('passes the project owner’s own variables through', () => {
    expect(buildContainerEnv({ APP_TITLE: 'Todo' }, [SECRET])).toEqual({
      APP_TITLE: 'Todo',
    });
  });

  it('refuses a variable whose value is a platform secret', () => {
    // The check is by value, not by name. A naming convention only catches
    // the mistakes someone anticipated; this catches the secret however it is
    // labelled.
    expect(() =>
      buildContainerEnv({ INNOCUOUS_SETTING: SECRET }, [SECRET])
    ).toThrow(/platform secret/i);
  });

  it('catches the secret under every disguise', () => {
    for (const name of ['DEBUG', 'MY_APP_KEY', 'x', 'PUBLIC_URL']) {
      expect(() => buildContainerEnv({ [name]: SECRET }, [SECRET])).toThrow();
    }
  });

  it('does not fire on short config values that merely collide', () => {
    // A var equal to some one-character platform value is a coincidence. A
    // check that fires on noise gets switched off, and then catches nothing.
    expect(() =>
      buildContainerEnv({ MODE: 'production' }, ['production', '1', ''])
    ).not.toThrow();
  });

  it('rejects a name that is not a valid environment variable', () => {
    for (const name of ['MY-VAR', '2FA', 'a b', 'PATH=x']) {
      expect(() => buildContainerEnv({ [name]: 'v' }, [])).toThrow(
        /valid.*environment variable/i
      );
    }
  });

  it('cannot reach the Worker env, because it is never given it', () => {
    // The structural half of the guarantee: the signature takes user vars and
    // a list of forbidden values. There is no parameter through which the
    // Worker's bindings could arrive, so no future edit can accidentally
    // forward them without changing the signature past this test.
    expect(buildContainerEnv.length).toBe(2);
    expect(buildContainerEnv({}, [])).toEqual({});
  });
});
