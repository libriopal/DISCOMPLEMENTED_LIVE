/**
 * Auth middleware — resolves either a Better Auth session cookie or an
 * `Authorization: Bearer {virtual_key}` header to a userId + tier, per
 * @agent_docs/api-spec.md "Auth Middleware". Mounted on every route except
 * /api/auth/* and /api/health.
 */
import { createMiddleware } from 'hono/factory';
import { AuthError, RateLimitError } from '@bicameral/shared/errors';
import type { SubscriptionTier } from '@bicameral/shared/types';
import { createAuth } from './auth.js';
import { resolveVirtualKey, checkRateLimit, sha256Hex } from './virtual-key.js';
import type { Env } from '../env.js';

export interface AuthVariables {
  userId: string;
  tier: SubscriptionTier;
}

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header('authorization');

  if (authHeader?.startsWith('Bearer ')) {
    const rawKey = authHeader.slice('Bearer '.length);
    const lookup = await resolveVirtualKey(c.env.DB, rawKey);
    if (!lookup) throw new AuthError('Invalid virtual key');
    if (lookup.isBanned)
      throw new AuthError('Account banned', 'ACCOUNT_BANNED');
    if (lookup.trialExpired)
      throw new AuthError('Trial expired', 'TRIAL_EXPIRED');

    const hashed = await sha256Hex(rawKey);
    const rateLimit = await checkRateLimit(c.env.DB, hashed, lookup.tier);
    if (!rateLimit.allowed) {
      throw new RateLimitError('Rate limit exceeded', {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    c.header('X-Rate-Limit-Remaining', String(rateLimit.remaining));
    c.header('X-Credits-Remaining', String(lookup.creditsRemaining));
    c.set('userId', lookup.userId);
    c.set('tier', lookup.tier);
    return next();
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id) throw new AuthError('Authentication required');

  const user = await c.env.DB.prepare(
    'SELECT tier, is_banned FROM users WHERE id = ?'
  )
    .bind(session.user.id)
    .first<{ tier: SubscriptionTier; is_banned: number }>();
  if (!user) throw new AuthError('User not found');
  if (user.is_banned) throw new AuthError('Account banned', 'ACCOUNT_BANNED');

  c.set('userId', session.user.id);
  c.set('tier', user.tier);
  return next();
});
