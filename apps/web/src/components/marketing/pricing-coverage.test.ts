/**
 * The pricing surface must show every tier the code entitles, and every number
 * on it must come from the constant that governs it.
 *
 * Both halves were broken before a cross-vendor audit round found them:
 * TIER_LIMITS entitled an `enterprise` tier the page never showed, so a buyer
 * could not purchase a tier the system was ready to serve; and the page's
 * figures were prose beside constants that said something else.
 */
import { describe, it, expect } from 'vitest';
import {
  CREDIT_COSTS,
  TIER_LIMITS,
  TIER_SUBSCRIPTION_PRICES,
} from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared';
import {
  OFFER_CLASS,
  TIER_ORDER,
  appsPerMonth,
  formatLimit,
  priceLabel,
} from './pricing-derivation.js';

describe('every entitled tier is offered, and every offered tier is entitled', () => {
  it('TIER_ORDER and TIER_LIMITS agree in BOTH directions', () => {
    // One direction catches a tier the page forgot. The other catches a page
    // offering something the system cannot serve. Only both catch both.
    expect([...TIER_ORDER].sort()).toEqual(Object.keys(TIER_LIMITS).sort());
  });

  it('every tier declares exactly one offer class', () => {
    for (const tier of Object.keys(TIER_LIMITS) as SubscriptionTier[]) {
      expect(OFFER_CLASS[tier], `${tier} has no offer class`).toBeTruthy();
      expect(['default', 'purchasable', 'provisioned']).toContain(
        OFFER_CLASS[tier]
      );
    }
  });

  it('every PURCHASABLE tier has a Stripe price, and only those do', () => {
    const purchasable = (Object.keys(TIER_LIMITS) as SubscriptionTier[]).filter(
      (t) => OFFER_CLASS[t] === 'purchasable'
    );
    expect(purchasable.sort()).toEqual(
      Object.keys(TIER_SUBSCRIPTION_PRICES).sort()
    );
  });

  it('a PROVISIONED tier shows a route, never a price', () => {
    // Publishing a number nobody is actually charged is worse than publishing
    // none: an enterprise price is negotiated, a nonprofit grant has no price.
    for (const tier of (Object.keys(TIER_LIMITS) as SubscriptionTier[]).filter(
      (t) => OFFER_CLASS[t] === 'provisioned'
    )) {
      expect(priceLabel(tier)).not.toMatch(/\$\d/);
    }
  });
});

describe('no number on the page is typed', () => {
  it('each tier label derives from a governing constant', () => {
    for (const [tier, price] of Object.entries(TIER_SUBSCRIPTION_PRICES)) {
      expect(priceLabel(tier as SubscriptionTier)).toBe(
        `$${price.priceUsdCents / 100}/mo`
      );
    }
    expect(priceLabel('free')).toBe('$0');
  });

  it('apps-per-month moves when either governing constant moves', () => {
    // The derivation, restated independently of the implementation.
    for (const tier of Object.keys(TIER_LIMITS) as SubscriptionTier[]) {
      expect(appsPerMonth(tier)).toBe(
        Math.floor(TIER_LIMITS[tier].creditsPerMonth / CREDIT_COSTS.generation)
      );
    }
  });

  it('never renders the word Infinity at a visitor', () => {
    // enterprise.generationsPerDay was Infinity. It is finite now, but the
    // display rule is what stops a future one reaching a pricing page.
    expect(formatLimit(Infinity)).toBe('Unlimited');
    expect(formatLimit(20)).toBe('20');
    for (const tier of Object.keys(TIER_LIMITS) as SubscriptionTier[]) {
      expect(formatLimit(TIER_LIMITS[tier].generationsPerDay)).not.toContain(
        'Infinity'
      );
    }
  });
});

describe('the four directive audiences are each served by a real tier', () => {
  // solo, teams, nonprofits, enterprise — the audiences discomplemented.com
  // exists to serve. An audience whose tier cannot be obtained is unserved,
  // however much copy mentions it.
  const AUDIENCE_TIER: Record<string, SubscriptionTier> = {
    solo: 'pro',
    team: 'team',
    nonprofit: 'nonprofit',
    enterprise: 'enterprise',
  };

  for (const [audience, tier] of Object.entries(AUDIENCE_TIER)) {
    it(`${audience}: its tier exists and can actually be obtained`, () => {
      expect(TIER_LIMITS[tier], `${tier} is not entitled`).toBeTruthy();
      const klass = OFFER_CLASS[tier];
      // Purchasable means a price object exists; provisioned means a named
      // route does. Neither is acceptable.
      if (klass === 'purchasable') {
        expect(
          TIER_SUBSCRIPTION_PRICES[
            tier as keyof typeof TIER_SUBSCRIPTION_PRICES
          ]
        ).toBeTruthy();
      } else {
        expect(priceLabel(tier)).toMatch(/grant|Talk to us/i);
      }
    });
  }
});
