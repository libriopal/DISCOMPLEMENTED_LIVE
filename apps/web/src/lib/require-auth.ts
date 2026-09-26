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

/**
 * Marks a request this Worker made to itself, so its rate limit is charged once.
 *
 * WHY THIS EXISTS. `routes/mcp.ts` runs each MCP tool by handing a Request back
 * to this same app, which means `requireAuth` runs TWICE for one tool call —
 * once at `/mcp` and once on the delegated `/api` route. `checkRateLimit` is
 * consumptive (`request_count = request_count + 1`), so every MCP tool call was
 * burning two tokens against a key's hourly limit. A tier documented at N
 * requests per hour delivered N/2 tool calls, and `entitlements` reported the
 * number that was not true.
 *
 * Found by the independent auditor on the commit that introduced it, not by the
 * author, and not by the 20 tests either — they measured the request that goes
 * out, and this is a property of the request going out TWICE.
 *
 * WHY A NONCE AND NOT A FIXED HEADER NAME. A constant marker would be a
 * rate-limit bypass for anyone who read this file: set the header, skip the
 * limit, on any route. The value is generated once per isolate and never
 * leaves it — `routes/mcp.ts` imports it rather than being told it — so a
 * client cannot supply a matching one. `dispatch()` builds the delegated
 * headers from scratch (authorization, cookie, accept) so a client-supplied
 * copy cannot ride along either; the nonce closes the case where some future
 * caller forwards headers wholesale.
 *
 * WHAT IS NOT SKIPPED: authentication. The delegated request still resolves the
 * key, and still refuses a banned account, an expired trial or an invalid key.
 * Only the counter increment is suppressed, because the outer pass already
 * charged it.
 */
export const INTERNAL_DELEGATION_HEADER = 'x-bicameral-internal-delegation';

/**
 * Set on the RESPONSE when, and only when, the marker above was honoured.
 *
 * The MCP dispatcher needs to know whether its delegation actually took effect
 * — a per-isolate nonce that failed to match means the caller just paid twice.
 * The first version inferred it from `X-Rate-Limit-Remaining` being `-1`, and
 * the independent auditor pointed out that this is sound only while the bearer
 * path is the exclusive setter of that header. Nothing enforced that, and the
 * natural future change (rate-limiting cookie sessions too) would have turned
 * the detector into a false alarm on every session-authenticated tool call.
 *
 * So the acknowledgement is its own header and carries no other meaning. The
 * question "was my marker honoured" is now answered by a header that exists for
 * no other reason, instead of being inferred from one that does other work.
 */
export const DELEGATION_ACK_HEADER = 'x-bicameral-delegation-honored';
export const INTERNAL_DELEGATION_NONCE = crypto.randomUUID();

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

    // Already charged by the outer pass of a self-delegated request. See
    // INTERNAL_DELEGATION_HEADER above — authentication still happened; only the
    // second increment is suppressed.
    const delegated =
      c.req.header(INTERNAL_DELEGATION_HEADER) === INTERNAL_DELEGATION_NONCE;

    const hashed = await sha256Hex(rawKey);
    const rateLimit = delegated
      ? { allowed: true, remaining: -1, retryAfterSeconds: 0 }
      : await checkRateLimit(c.env.DB, hashed, lookup.tier);
    if (!rateLimit.allowed) {
      throw new RateLimitError('Rate limit exceeded', {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    c.header('X-Rate-Limit-Remaining', String(rateLimit.remaining));
    if (delegated) c.header(DELEGATION_ACK_HEADER, '1');
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
