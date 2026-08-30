/**
 * Billing — Stripe checkout (credit packs + tier subscriptions), the
 * customer portal, and the webhook that turns a completed payment into a
 * real credit/tier change. See @agent_docs/api-spec.md if updated, and
 * vault_commercial_launch_plan.md §5/§7 (Phase C) for scope/rationale.
 *
 * `billingRoutes` is mounted under /api/billing *after* the global
 * requireAuth in index.ts — every call is a logged-in founder acting on
 * their own account. `billingWebhookRoutes` is mounted *before*
 * requireAuth (like /api/chat/webhook and /api/security-gate) because the
 * caller is Stripe itself, not a Bicameral session — it authenticates via
 * the `Stripe-Signature` header (lib/stripe.ts constructWebhookEvent)
 * instead of a session cookie/virtual key.
 *
 * LIVE as of Aug 21, 2026: Stripe account connected, all 3 secrets
 * provisioned, webhook endpoint registered. Routes below make real
 * Stripe API calls in live mode.
 * pretending to charge/credit anyone — see lib/stripe.ts's file header.
 */
import { Hono } from 'hono';
import { AuthError, ValidationError } from '@bicameral/shared/errors';
import {
  CREDIT_PACKAGES,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';
import type {
  CreditPackageId,
  PurchasableTier,
} from '@bicameral/shared/constants';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { creditUserCredits } from '../lib/virtual-key.js';
import {
  createCreditPackCheckoutSession,
  createPortalSession,
  createTierSubscriptionCheckoutSession,
  findOrCreateCustomer,
  constructWebhookEvent,
} from '../lib/stripe.js';

export const billingRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

interface UserRow {
  email: string;
  tier: string;
  stripe_customer_id: string | null;
}

async function getUser(db: D1Database, userId: string): Promise<UserRow> {
  const user = await db
    .prepare('SELECT email, tier, stripe_customer_id FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();
  if (!user) throw new AuthError('User not found');
  return user;
}

// ============ GET /api/billing/packages ============
// Lets the frontend render prices without hardcoding them a second time.
billingRoutes.get('/packages', (c) => {
  return c.json({
    creditPackages: CREDIT_PACKAGES,
    subscriptionTiers: TIER_SUBSCRIPTION_PRICES,
  });
});

// ============ POST /api/billing/checkout/credits ============
billingRoutes.post('/checkout/credits', async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{ packId?: string }>()
    .catch(() => ({}) as { packId?: string });
  const packId = body.packId as CreditPackageId | undefined;

  if (!packId || !(packId in CREDIT_PACKAGES)) {
    throw new ValidationError(
      `packId must be one of: ${Object.keys(CREDIT_PACKAGES).join(', ')}`
    );
  }

  const user = await getUser(c.env.DB, userId);
  const appUrl = c.env.APP_URL;

  const session = await createCreditPackCheckoutSession(
    {
      userId,
      email: user.email,
      packId,
      successUrl: `${appUrl}/billing?checkout=success`,
      cancelUrl: `${appUrl}/billing?checkout=canceled`,
    },
    c.env
  );

  return c.json({ url: session.url, sessionId: session.id });
});

// ============ POST /api/billing/checkout/subscription ============
billingRoutes.post('/checkout/subscription', async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{ tier?: string }>()
    .catch(() => ({}) as { tier?: string });
  const tier = body.tier as PurchasableTier | undefined;

  if (!tier || !(tier in TIER_SUBSCRIPTION_PRICES)) {
    throw new ValidationError(
      `tier must be one of: ${Object.keys(TIER_SUBSCRIPTION_PRICES).join(', ')}`
    );
  }

  const user = await getUser(c.env.DB, userId);
  const appUrl = c.env.APP_URL;

  const session = await createTierSubscriptionCheckoutSession(
    {
      userId,
      email: user.email,
      tier,
      successUrl: `${appUrl}/billing?checkout=success`,
      cancelUrl: `${appUrl}/billing?checkout=canceled`,
    },
    c.env
  );

  return c.json({ url: session.url, sessionId: session.id });
});

// ============ GET /api/billing/portal ============
billingRoutes.get('/portal', async (c) => {
  const userId = c.get('userId');
  const user = await getUser(c.env.DB, userId);

  const customer = await findOrCreateCustomer(user.email, userId, c.env);
  if (customer.id !== user.stripe_customer_id) {
    await c.env.DB.prepare(
      'UPDATE users SET stripe_customer_id = ?, updated_date = ? WHERE id = ?'
    )
      .bind(customer.id, new Date().toISOString(), userId)
      .run();
  }

  const portal = await createPortalSession(
    customer.id,
    `${c.env.APP_URL}/billing`,
    c.env
  );

  return c.json({ url: portal.url });
});

// ============ Webhook (unauthenticated — Stripe-signed) ============

export const billingWebhookRoutes = new Hono<{ Bindings: Env }>();

interface CheckoutSessionObject {
  id: string;
  customer: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null };
  subscription?: string | null;
  metadata?: Record<string, string>;
}

interface SubscriptionObject {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  metadata?: Record<string, string>;
}

async function alreadyProcessed(
  db: D1Database,
  eventId: string
): Promise<boolean> {
  const existing = await db
    .prepare('SELECT id FROM stripe_webhook_events WHERE id = ?')
    .bind(eventId)
    .first();
  return !!existing;
}

async function markProcessed(
  db: D1Database,
  eventId: string,
  eventType: string
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO stripe_webhook_events (id, event_type, processed_date) VALUES (?, ?, ?)'
    )
    .bind(eventId, eventType, new Date().toISOString())
    .run();
}

// ============ POST /api/billing/webhook ============
billingWebhookRoutes.post('/webhook', async (c) => {
  const payload = await c.req.text();
  const event = await constructWebhookEvent(
    payload,
    c.req.header('stripe-signature'),
    c.env
  );

  // Stripe retries on any non-2xx and can occasionally redeliver even
  // after a prior 200 — dedup before applying any credit/tier change so a
  // retry can't double-credit a user.
  if (await alreadyProcessed(c.env.DB, event.id)) {
    return c.json({ received: true, deduped: true });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as unknown as CheckoutSessionObject;
      const metadata = session.metadata ?? {};

      if (metadata.kind === 'credit_pack') {
        const userId = metadata.userId;
        const credits = Number(metadata.credits);
        if (userId && Number.isFinite(credits) && credits > 0) {
          await creditUserCredits(c.env.DB, userId, credits, {
            type: 'credit',
            description: `Stripe credit pack (${metadata.packId ?? 'unknown'}) — session ${session.id}`,
            createdBy: 'stripe_webhook',
          });
        }
      } else if (metadata.kind === 'tier_subscription') {
        const userId = metadata.userId;
        const tier = metadata.tier;
        const email =
          session.customer_email ?? session.customer_details?.email ?? null;
        if (userId && tier && session.customer && session.subscription) {
          const now = new Date().toISOString();
          await c.env.DB.batch([
            c.env.DB.prepare(
              'UPDATE users SET tier = ?, stripe_customer_id = ?, updated_date = ? WHERE id = ?'
            ).bind(tier, session.customer, now, userId),
            c.env.DB.prepare(
              `INSERT INTO subscriptions
                 (id, user_id, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, created_date, updated_date)
               VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?)
               ON CONFLICT(stripe_subscription_id) DO UPDATE SET
                 tier = excluded.tier,
                 status = excluded.status,
                 updated_date = excluded.updated_date`
            ).bind(
              crypto.randomUUID(),
              userId,
              tier,
              session.customer,
              session.subscription,
              now,
              now
            ),
          ]);
          void email; // reserved for a future receipt email via lib/email.ts
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as unknown as SubscriptionObject;
      const now = new Date().toISOString();
      const periodEnd = Number.isFinite(sub.current_period_end)
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      await c.env.DB.prepare(
        `UPDATE subscriptions
         SET status = ?, current_period_end = ?, updated_date = ?
         WHERE stripe_subscription_id = ?`
      )
        .bind(sub.status, periodEnd, now, sub.id)
        .run();

      // A subscription that lapses (past_due long enough to become
      // unpaid/canceled) drops the user back to `free` — Stripe sends a
      // dedicated `customer.subscription.deleted` for the terminal case,
      // handled below, but `updated` can also carry `status: 'unpaid'`.
      if (sub.status === 'unpaid' || sub.status === 'canceled') {
        const row = await c.env.DB.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?'
        )
          .bind(sub.id)
          .first<{ user_id: string }>();
        if (row) {
          await c.env.DB.prepare(
            'UPDATE users SET tier = ?, updated_date = ? WHERE id = ?'
          )
            .bind('free', now, row.user_id)
            .run();
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as unknown as SubscriptionObject;
      const now = new Date().toISOString();

      const row = await c.env.DB.prepare(
        'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?'
      )
        .bind(sub.id)
        .first<{ user_id: string }>();

      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'canceled', updated_date = ? WHERE stripe_subscription_id = ?`
      )
        .bind(now, sub.id)
        .run();

      if (row) {
        await c.env.DB.prepare(
          'UPDATE users SET tier = ?, updated_date = ? WHERE id = ?'
        )
          .bind('free', now, row.user_id)
          .run();
      }
      break;
    }

    default:
      // Unhandled event types are expected — Stripe sends far more event
      // types than this webhook needs to act on; ack with 200 either way.
      break;
  }

  await markProcessed(c.env.DB, event.id, event.type);
  return c.json({ received: true });
});
