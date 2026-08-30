/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Exercises the real requireAuth middleware (src/lib/require-auth.ts) and
 * the two webhook-secret routes against the actual Worker running inside
 * Miniflare — not mocks — since the auth boundary is the one thing a unit
 * test mocking modules out can't actually verify: that unauthenticated
 * requests really get rejected by the real routing + middleware stack.
 */
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('auth boundary', () => {
  // The public liveness endpoint is /api/healthz, registered above
  // `app.use('/api/*', requireAuth)` in src/index.ts. /api/health is something
  // else entirely, and the name is the trap: routes/health.ts serves
  // `GET /api/health/:userId` — health scores, churn predictions and sentiment
  // for a specific customer. It is mounted after the auth middleware, and
  // rejecting anonymous callers is correct; serving it publicly would leak
  // per-user analytics. This test used to assert 200 from /api/health,
  // conflating the two.
  it('allows /api/healthz with no auth at all', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/healthz')
    );
    expect(res.status).toBe(200);
  });

  it('rejects /api/health (the user health-score API) with no auth', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/health')
    );
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with no credentials', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/pipeline')
    );
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with an invalid virtual key', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/pipeline', {
        headers: { Authorization: 'Bearer not-a-real-key' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with a garbage session cookie', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/projects', {
        headers: { Cookie: 'better-auth.session_token=garbage' },
      })
    );
    expect(res.status).toBe(401);
  });
});

describe('webhook-secret boundary (security gate)', () => {
  it('rejects the callback route with no secret header', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/security-gate/some-run-id/callback', {
        method: 'POST',
        body: JSON.stringify({ scanId: 'x' }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects the callback route with the wrong secret', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/security-gate/some-run-id/callback', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'wrong-secret' },
        body: JSON.stringify({ scanId: 'x' }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('accepts the correct secret and reaches route logic (404s on an unknown run)', async () => {
    const res = await exports.default.fetch(
      new Request('http://example.com/api/security-gate/some-run-id/callback', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'test-webhook-secret' },
        body: JSON.stringify({ scanId: 'nonexistent-scan' }),
      })
    );
    // Secret accepted, so this proves the auth check passed — it 404s on
    // the not-found scan row rather than 401ing, which is what would happen
    // if the secret comparison were broken in either direction.
    expect(res.status).toBe(404);
  });
});
