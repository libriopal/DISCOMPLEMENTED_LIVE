/**
 * Better Auth configuration — GitHub OAuth (dual prod/dev apps) plus
 * email/username/password, on Cloudflare D1.
 *
 * D1 is wired in through Kysely's SQLite dialect (`kysely-d1`) since Better Auth
 * has no first-class D1 adapter. Table/field names are mapped onto our own
 * `users` table (see migrations/001_init.sql, migrations/002_auth_and_vkeys.sql)
 * instead of Better Auth's default `user` table, so app-specific columns
 * (tier, credits_remaining, virtual_key, ...) live in one place.
 *
 * See @agent_docs/security.md — session cookies validated on every request,
 * virtual key issued on first sign-in (see lib/virtual-key.ts).
 */
import { betterAuth } from 'better-auth';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import {
  sendEmail,
  verificationEmailHtml,
  resetPasswordEmailHtml,
} from './email.js';
import type { Env } from '../env.js';

// GitHub OAuth apps differ by environment: the dev app's callback points at
// localhost / *.workers.dev, the prod app's callback points at the custom
// domain. Both credential pairs are set via `wrangler secret put`.
function githubCredentials(env: Env) {
  const isProd = env.ENVIRONMENT === 'production';
  return {
    clientId: isProd
      ? env.GITHUB_OAUTH_CLIENT_ID_PROD
      : env.GITHUB_OAUTH_CLIENT_ID_DEV,
    clientSecret: isProd
      ? env.GITHUB_OAUTH_CLIENT_SECRET_PROD
      : env.GITHUB_OAUTH_CLIENT_SECRET_DEV,
  };
}

export function createAuth(env: Env) {
  const db = new Kysely({
    dialect: new D1Dialect({ database: env.DB }),
  });

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    // Local dev runs the frontend and API as separate origins (Vite on
    // :5173 proxying /api to `wrangler dev` on :8787 — see vite.config.ts);
    // Better Auth only trusts `baseURL` by default, so without this every
    // sign-in from the Vite origin 403s with INVALID_ORIGIN.
    // discomplemented.com and www.discomplemented.com are both bound as
    // live custom domains (see wrangler.toml) but APP_URL only names one of
    // them — without listing both here, whichever one isn't APP_URL 403s
    // every sign-in/sign-up with INVALID_ORIGIN.
    trustedOrigins:
      env.ENVIRONMENT === 'production'
        ? [
            env.APP_URL,
            'https://discomplemented.com',
            'https://www.discomplemented.com',
          ]
        : [env.APP_URL, 'http://localhost:5173'],
    database: {
      db,
      type: 'sqlite',
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'full_name',
        emailVerified: 'email_verified',
        image: 'avatar_url',
        createdAt: 'created_date',
        updatedAt: 'updated_date',
      },
      additionalFields: {
        role: { type: 'string', defaultValue: 'user', input: false },
        tier: { type: 'string', defaultValue: 'free', input: false },
        virtualKey: { type: 'string', fieldName: 'virtual_key', input: false },
        creditsRemaining: {
          type: 'number',
          fieldName: 'credits_remaining',
          input: false,
        },
        // Nullable — null means no admin panel access. Surfaced on the
        // session so the frontend can gate the Admin nav item without an
        // extra round trip. See lib/admin-middleware.ts for the
        // server-side enforcement this mirrors (client gating is UX only).
        adminLevel: {
          type: 'string',
          fieldName: 'admin_level',
          input: false,
          required: false,
        },
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_date',
        updatedAt: 'updated_date',
      },
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh once/day
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_date',
        updatedAt: 'updated_date',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_date',
        updatedAt: 'updated_date',
      },
    },
    socialProviders: {
      github: {
        ...githubCredentials(env),
      },
    },
    // Email/username/password path, alongside GitHub OAuth above — see
    // vault_commercial_launch_plan.md §3. requireEmailVerification +
    // autoSignIn: false means a freshly-registered account can't establish
    // a session until the verification link is clicked; Better Auth issues
    // the token/URL itself, we just deliver it (lib/email.ts, Resend).
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      autoSignIn: false,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(
          {
            to: user.email,
            subject: 'Reset your Discomplement password',
            html: resetPasswordEmailHtml(url),
          },
          env
        );
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(
          {
            to: user.email,
            subject: 'Verify your Discomplement email',
            html: verificationEmailHtml(url),
          },
          env
        );
      },
      // false, not true: better-auth's automatic post-signup send runs
      // through runInBackgroundOrAwait (@better-auth/core/context), which
      // awaits the promise but swallows any rejection into a log line —
      // a Resend send failure (e.g. the free onboarding@resend.dev sender's
      // "only your own address" restriction) never reaches the /sign-up/email
      // response, so the signup looks successful even though no email will
      // ever arrive. routes/auth.ts triggers the send itself instead, via
      // POST /send-verification-email, whose handler (email-verification.mjs)
      // does propagate the error to its caller.
      sendOnSignUp: false,
    },
    // Rate limiting is enforced separately in lib/virtual-key.ts (tier-based,
    // sliding window in D1) — this just throttles the auth endpoint itself
    // per @agent_docs/security.md ("Brute force virtual keys" mitigation).
    //
    // window/max below is the blanket default, keyed per (IP, path) — every
    // path gets its own bucket, it's not one shared counter across all of
    // /api/auth/*. better-auth also ships built-in stricter "special rules"
    // on top of this default (window=10s/max=3 for /sign-in, /sign-up,
    // /change-password, /change-email; window=60s/max=3 for
    // /request-password-reset, /send-verification-email). Note the path is
    // /request-password-reset on the version deployed here — POST
    // /api/auth/forget-password, its name in older better-auth releases,
    // returns 404 in production (verified against the live Worker).
    //
    // `enabled` MUST be explicit. better-auth's own default for this flag is
    // `options.rateLimit?.enabled ?? isProduction`, where `isProduction` is
    // `process.env.NODE_ENV === 'production'` (@better-auth/core/env). The
    // Workers runtime never sets `NODE_ENV` — it isn't in wrangler.toml
    // [vars], .dev.vars, or anywhere else in this repo — so that check
    // evaluates to `false` unconditionally, in local dev *and* in a real
    // Workers deploy. Leaving `enabled` unset silently disables all of the
    // brute-force protection described above, in every environment,
    // contradicting earlier assumptions that it was "on by default". Found
    // by local pentest: 25 back-to-back wrong-password /sign-in/email
    // attempts all returned 401 with no 429. Setting it explicitly is the
    // only way to actually get this protection under Workers.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 5,
      // `enabled: true` alone was not enough. The default storage is an
      // in-process Map (see migrations/023_auth_rate_limit.sql for the full
      // trace), which on Workers is per-isolate and evictable, so counters
      // never accumulated: eight back-to-back wrong-password sign-ins against
      // production on 2026-08-25 all returned 401, never 429. D1 is shared
      // across isolates and gives the limiter its atomic increment path.
      storage: 'database',
      modelName: 'auth_rate_limit',
      fields: {
        lastRequest: 'last_request',
      },
    },
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
      // Without this, better-auth cannot resolve a client IP under Workers and
      // says so at runtime: "Rate limiting could not determine a client IP and
      // is falling back to a single shared per-path bucket." That fallback
      // makes the limits above worthless in both directions — every visitor
      // shares one 5-per-60s bucket per path, so a single attacker exhausts it
      // and locks out real users, while a distributed attempt is never keyed
      // to anyone. Observed in production logs on POST
      // /api/auth/request-password-reset after the 2026-08-25 deploy.
      //
      // `cf-connecting-ip` is the right header here specifically because
      // Cloudflare sets it at the edge and strips any inbound copy, so it
      // cannot be spoofed by the client — unlike x-forwarded-for, which is
      // caller-supplied and would let an attacker mint a fresh bucket per
      // request.
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip'],
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
