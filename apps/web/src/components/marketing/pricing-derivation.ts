/**
 * Pricing-page numbers, DERIVED from the constants that govern them.
 *
 * "More builds, more credits" was prose sitting beside a constant that says
 * exactly how many. Worse, the tier table and the pricing section disagreed:
 * TIER_LIMITS entitled an `enterprise` tier the page never showed, and the
 * genome priced a nonprofit tier that existed nowhere in code. A buyer could
 * not purchase a tier the system was ready to serve.
 *
 * So no number on the pricing page is typed. Each one resolves to a NAMED
 * governing constant, and `pricing-coverage.test.ts` fails the build if a
 * figure appears that cannot be attributed to one.
 *
 * THREE OFFER CLASSES, because two was not enough. An earlier version of this
 * scoping had only `purchasable` and `provisioned`, and a cross-vendor round
 * pointed out that `free` — the tier every visitor starts on — was neither: in
 * TIER_LIMITS, shown at $0, absent from TIER_SUBSCRIPTION_PRICES, and neither
 * quoted nor granted. Under that rule the parity gate could never pass.
 */
import {
  CREDIT_COSTS,
  ENTERPRISE_CONTRACT_FLOOR_USD_CENTS,
  TIER_LIMITS,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared';

/** How a tier is offered. Every tier declares exactly one. */
export type OfferClass = 'default' | 'purchasable' | 'provisioned';

export const OFFER_CLASS: Record<SubscriptionTier, OfferClass> = {
  free: 'default', // granted on signup
  pro: 'purchasable', // Stripe price object
  team: 'purchasable', // Stripe price object
  nonprofit: 'provisioned', // by grant — see packages/shared/src/nonprofit.ts
  enterprise: 'provisioned', // by quote — no Stripe price, see the floor below
};

/**
 * What a tier costs, as a display string, from the constant that governs it.
 *
 * Never a literal. `provisioned` tiers return a ROUTE rather than a price,
 * because publishing a number nobody is actually charged is worse than
 * publishing none — an enterprise price is negotiated per customer, and a
 * nonprofit grant has no price to show.
 */
export function priceLabel(tier: SubscriptionTier): string {
  const klass = OFFER_CLASS[tier];
  if (klass === 'default') return '$0';
  if (klass === 'provisioned') {
    return tier === 'nonprofit' ? 'Free, by grant' : 'Talk to us';
  }
  const price =
    TIER_SUBSCRIPTION_PRICES[tier as keyof typeof TIER_SUBSCRIPTION_PRICES];
  return `$${price.priceUsdCents / 100}/mo`;
}

/**
 * How many apps a tier's monthly grant actually delivers.
 *
 * Derived, so a change to either the grant or the per-run credit cost moves the
 * page. Both changed in the revenue fix; if this were prose, the page would
 * still be advertising the old numbers.
 */
export function appsPerMonth(tier: SubscriptionTier): number {
  return Math.floor(
    TIER_LIMITS[tier].creditsPerMonth / CREDIT_COSTS.generation
  );
}

/**
 * A cap rendered for humans.
 *
 * `Infinity` has no numeral, and `enterprise.generationsPerDay` used to be
 * exactly that — the only unbounded-loss path in the product. It is finite now,
 * but the formatter stays: a display rule for a value with no numeral is the
 * kind of thing that is obvious until it renders the word "Infinity" on a
 * pricing page.
 */
export function formatLimit(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : 'Unlimited';
}

/** The floor a bespoke contract may not go under, for the enterprise copy. */
export function enterpriseFloorLabel(): string {
  return `from $${(ENTERPRISE_CONTRACT_FLOOR_USD_CENTS / 100).toLocaleString()}/mo`;
}

/** Every tier, in the order a visitor should meet them. */
export const TIER_ORDER: SubscriptionTier[] = [
  'free',
  'pro',
  'team',
  'nonprofit',
  'enterprise',
];
