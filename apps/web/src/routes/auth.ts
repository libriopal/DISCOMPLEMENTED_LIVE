/**
 * Mounts Better Auth's handler under /api/auth/*.
 * See @agent_docs/api-spec.md — auth route.
 */
import { Hono } from 'hono';
import { createAuth } from '../lib/auth.js';
import { issueVirtualKeyIfMissing } from '../lib/virtual-key.js';
import type { Env } from '../env.js';

export const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * Builds a `Cookie` header from the cookies a response is *setting*.
 *
 * A request that establishes a session carries no session cookie — the cookie
 * is on the way back out. Reading `c.req.raw.headers` on a sign-in therefore
 * always resolved to no session, which is why virtual keys stopped being
 * minted for email/password accounts (verified in production 2026-08-26: every
 * account created after the email/password path went live has
 * `virtual_key = NULL`, while older OAuth accounts have one). Only the
 * `name=value` pair is kept; attributes like Path and HttpOnly are response-only
 * and would not parse as a request cookie.
 */
function cookieHeaderFromResponse(response: Response): string | null {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const pairs = setCookies
    .map((cookie) => cookie.split(';', 1)[0]?.trim())
    .filter((pair): pair is string => Boolean(pair));
  return pairs.length > 0 ? pairs.join('; ') : null;
}

authRoutes.on(['GET', 'POST'], '/*', async (c) => {
  const auth = createAuth(c.env);
  const response = await auth.handler(c.req.raw);

  // First sign-in needs a virtual key minted for the new user — Better Auth
  // only knows about its own user/session fields. Three paths establish a
  // session for the first time: the GitHub OAuth callback, and (for the
  // email/password path, which has requireEmailVerification +
  // autoSignIn: false — see lib/auth.ts) the verify-email link click and
  // the subsequent sign-in. issueVirtualKeyIfMissing() is idempotent
  // (no-ops if the user already has one), so matching all three paths is
  // safe rather than needing to track which one fired first.
  const mintsSession =
    c.req.path.includes('/callback/') ||
    c.req.path.includes('/verify-email') ||
    c.req.path.includes('/sign-in/email');
  if (mintsSession && response.status < 400) {
    // Prefer the cookie the response is setting; fall back to the request's own
    // cookies for a path that re-uses an existing session (a second OAuth
    // callback, say) and sets nothing new.
    const headers = new Headers(c.req.raw.headers);
    const issued = cookieHeaderFromResponse(response);
    if (issued) headers.set('cookie', issued);

    try {
      const session = await auth.api.getSession({ headers });
      if (session?.user?.id) {
        await issueVirtualKeyIfMissing(c.env.DB, session.user.id);
      }
    } catch {
      // Minting is a side benefit, not part of signing in — a failure here must
      // never turn a successful sign-in into an error. Nothing retries this
      // automatically (usage.ts imports the helper but never calls it), so the
      // cost of a miss is that the account has no API key until the next
      // session-establishing request or a manual generate from the usage route.
      // Browser login itself is unaffected: require-auth accepts the session
      // cookie as well as the bearer key.
    }
  }

  // sendOnSignUp is off (see lib/auth.ts) precisely so this send happens
  // here instead, where a failure can actually reach the client — confirmed
  // live 2026-08-12 (Resend 403: "You can only send testing emails to your
  // own email address") that the automatic path silently ate this error.
  if (c.req.path.endsWith('/sign-up/email') && response.status < 400) {
    const body = (await response.clone().json()) as {
      user?: { email?: string };
    };
    const email = body.user?.email;
    if (email) {
      try {
        await auth.api.sendVerificationEmail({ body: { email } });
      } catch (err) {
        return c.json(
          {
            ...body,
            emailDeliveryFailed: true,
            emailDeliveryError:
              err instanceof Error
                ? err.message
                : 'Failed to send verification email',
          },
          200
        );
      }
    }
  }

  return response;
});
