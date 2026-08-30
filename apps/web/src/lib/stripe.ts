/**
 * Stripe billing — direct `fetch()` against Stripe's REST API, matching
 * this repo's existing pattern for Cohere (lib/cohere.ts) and Resend
 * (lib/email.ts) of hand-rolled fetch wrappers instead of a vendor SDK.
 * The `stripe` npm package is never used here.
 *
 * Covers what routes/billing.ts needs: Checkout Sessions (one-time credit
 * packs + subscription tier upgrades), the Billing Portal, Customers, and
 * manual webhook signature verification (Stripe's documented HMAC-SHA256
 * scheme — https://docs.stripe.com/webhooks#verify-manually).
 *
 * LIVE as of Aug 21, 2026: STRIPE_SECRET_KEY (rk_live_*),
 * STRIPE_PUBLISHABLE_KEY (pk_live_*), and STRIPE_WEBHOOK_SECRET are
 * provisioned on the production worker. Webhook endpoint registered at
 * https://discomplemented.com/api/billing/webhook. All functions below
 * make real requests to api.stripe.com in live mode.
 */
import type {
  CreditPackageId,
  PurchasableTier,
} from '@bicameral/shared/constants';
import {
  CREDIT_PACKAGES,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';
import { AuthError, BicameralError } from '@bicameral/shared/errors';
import type { Env } from '../env.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
// Pinned so behavior doesn't shift under us if Stripe's default API
// version changes — bump deliberately, not implicitly.
const STRIPE_API_VERSION = '2024-06-20';

export class StripeApiError extends BicameralError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'STRIPE_API_ERROR', 502, details);
    this.name = 'StripeApiError';
  }
}

function requireStripeConfigured(env: Env): void {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured — run `wrangler secret put STRIPE_SECRET_KEY` ' +
        '(see env.ts). No real Stripe account has been provisioned yet; billing ' +
        'routes cannot call the Stripe API until then.'
    );
  }
}

// ============ form encoding ============
// Stripe's REST API takes application/x-www-form-urlencoded bodies with
// bracket notation for nested objects/arrays (e.g.
// `line_items[0][price_data][unit_amount]=500`) — there is no JSON body
// mode. This flattens an arbitrarily-nested params object into that shape.
type StripeParams = Record<string, unknown>;

function flattenParams(obj: StripeParams, prefix = ''): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const arrKey = `${paramKey}[${i}]`;
        if (item && typeof item === 'object') {
          pairs.push(...flattenParams(item as StripeParams, arrKey));
        } else {
          pairs.push([arrKey, String(item)]);
        }
      });
    } else if (typeof value === 'object') {
      pairs.push(...flattenParams(value as StripeParams, paramKey));
    } else {
      pairs.push([paramKey, String(value)]);
    }
  }
  return pairs;
}

function toFormBody(obj: StripeParams): string {
  return flattenParams(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function stripeRequest<T>(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  params?: StripeParams
): Promise<T> {
  requireStripeConfigured(env);

  const isGet = method === 'GET';
  const query = isGet && params ? `?${toFormBody(params)}` : '';
  const response = await fetch(`${STRIPE_API_BASE}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: isGet || !params ? undefined : toFormBody(params),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new StripeApiError(
      `Stripe API error: ${response.status} ${response.statusText}`,
      { path, body: detail }
    );
  }

  return response.json() as Promise<T>;
}

// ============ Checkout Sessions ============

export interface CheckoutSession {
  id: string;
  url: string | null;
}

export interface CreditPackCheckoutParams {
  userId: string;
  email: string;
  packId: CreditPackageId;
  successUrl: string;
  cancelUrl: string;
}

/** One-time purchase (Checkout mode: "payment") — the credit top-up flow
 * that closes the plan's "pay for more credits when the trial ends" gap.
 * Metadata carries everything the webhook needs to credit the right user
 * without a second DB round-trip keyed on something Stripe doesn't know. */
export async function createCreditPackCheckoutSession(
  params: CreditPackCheckoutParams,
  env: Env
): Promise<CheckoutSession> {
  const pack = CREDIT_PACKAGES[params.packId];
  if (!pack) {
    throw new StripeApiError(`Unknown credit package: ${params.packId}`);
  }

  return stripeRequest<CheckoutSession>(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: params.email,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // Stripe's Managed Payments (on by default for new accounts) requires
    // a product tax_code, which inline price_data line items don't carry —
    // without this the session creation 400s with "product tax code is
    // missing" on every real (live-mode) checkout attempt.
    managed_payments: { enabled: false },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.priceUsdCents,
          product_data: { name: pack.label },
        },
      },
    ],
    metadata: {
      kind: 'credit_pack',
      userId: params.userId,
      packId: params.packId,
      credits: String(pack.credits),
    },
  });
}

export interface TierSubscriptionCheckoutParams {
  userId: string;
  email: string;
  tier: PurchasableTier;
  successUrl: string;
  cancelUrl: string;
}

/** Recurring purchase (Checkout mode: "subscription") — upgrades a user
 * off the `free` tier. `free`/`enterprise` are intentionally excluded by
 * `PurchasableTier` (see constants.ts). */
export async function createTierSubscriptionCheckoutSession(
  params: TierSubscriptionCheckoutParams,
  env: Env
): Promise<CheckoutSession> {
  const price = TIER_SUBSCRIPTION_PRICES[params.tier];
  if (!price) {
    throw new StripeApiError(`Unknown subscription tier: ${params.tier}`);
  }

  return stripeRequest<CheckoutSession>(env, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer_email: params.email,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // See createCreditPackCheckoutSession above — Managed Payments requires
    // a product tax_code that inline price_data line items don't have.
    managed_payments: { enabled: false },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: price.priceUsdCents,
          recurring: { interval: 'month' },
          product_data: { name: price.label },
        },
      },
    ],
    metadata: {
      kind: 'tier_subscription',
      userId: params.userId,
      tier: params.tier,
    },
  });
}

// ============ Customers ============

export interface StripeCustomer {
  id: string;
  email: string | null;
}

/** Looks up a Stripe customer by exact email match (List Customers'
 * `email` filter), creating one if none exists. Used by the billing-portal
 * route — customers aren't otherwise created until a checkout completes,
 * so a user who hasn't purchased anything yet gets one lazily here too. */
export async function findOrCreateCustomer(
  email: string,
  userId: string,
  env: Env
): Promise<StripeCustomer> {
  const existing = await stripeRequest<{ data: StripeCustomer[] }>(
    env,
    'GET',
    '/customers',
    { email, limit: 1 }
  );
  if (existing.data[0]) return existing.data[0];

  return stripeRequest<StripeCustomer>(env, 'POST', '/customers', {
    email,
    metadata: { userId },
  });
}

// ============ Billing Portal ============

export interface PortalSession {
  id: string;
  url: string;
}

/** Customer-portal session (subscription management: cancel, update
 * payment method, view invoices). Only meaningful once a customer has at
 * least one subscription or payment on file — Stripe itself 400s a portal
 * session request for a customer with neither. */
export async function createPortalSession(
  customerId: string,
  returnUrl: string,
  env: Env
): Promise<PortalSession> {
  return stripeRequest<PortalSession>(env, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

// ============ Webhooks ============

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Verifies Stripe's `Stripe-Signature` header by hand (HMAC-SHA256 over
 * `${timestamp}.${payload}`), per
 * https://docs.stripe.com/webhooks#verify-manually — no SDK involved.
 * Uses Web Crypto (available in the Workers runtime) and a constant-time
 * comparison so this doesn't leak timing information about the expected
 * signature. */
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300
): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    })
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  const computedHex = [...new Uint8Array(signatureBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHex.length !== expectedSig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedHex.length; i++) {
    mismatch |= computedHex.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Verifies the signature and parses the raw webhook body. Throws
 * `AuthError` (401, matches index.ts's `BicameralError` handling) on a
 * missing/invalid signature or unconfigured secret, so a spoofed or
 * misconfigured webhook fails loudly rather than silently crediting
 * accounts on unverified input. */
export async function constructWebhookEvent(
  payload: string,
  sigHeader: string | undefined,
  env: Env
): Promise<StripeEvent> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is not configured — run `wrangler secret put STRIPE_WEBHOOK_SECRET` ' +
        '(see env.ts). Webhook events cannot be verified until then.'
    );
  }
  if (!sigHeader) {
    throw new AuthError(
      'Missing Stripe-Signature header',
      'STRIPE_WEBHOOK_UNSIGNED'
    );
  }

  const valid = await verifyStripeSignature(
    payload,
    sigHeader,
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) {
    throw new AuthError(
      'Invalid Stripe webhook signature',
      'STRIPE_WEBHOOK_INVALID'
    );
  }

  return JSON.parse(payload) as StripeEvent;
}
