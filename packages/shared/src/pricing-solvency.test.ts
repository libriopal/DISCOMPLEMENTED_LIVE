/**
 * Every price in this product must cover what it delivers.
 *
 * docs/cohere-unit-economics.md measured the product selling at a loss: a Pro
 * subscriber went underwater after spending 7.5% of their grant, and the daily
 * cap that was supposed to bound the loss still allowed $116 of spend against
 * $29 of revenue. Enterprise had no cap at all.
 *
 * That was not caught by a test, because there was no test — the numbers were
 * constants beside a document, and the document's own recommendations sat
 * unapplied. This file makes the arithmetic a build failure instead of a
 * finding: if anyone raises a grant, drops a price, or loosens a cap past the
 * point where it pays for itself, the build says so with the figures.
 *
 * It re-derives from ONE measured input — ALL_IN_COST_PER_APP_USD — rather than
 * asserting the constants against themselves, which would pass no matter what
 * they said.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_IN_COST_PER_APP_USD as COST,
  CREDIT_COSTS,
  CREDIT_PACKAGES,
  ENTERPRISE_CONTRACT_FLOOR_USD_CENTS,
  TARGET_GROSS_MARGIN as MARGIN,
  TIER_LIMITS,
  TIER_SUBSCRIPTION_PRICES,
} from './constants.js';

/**
 * Float tolerance ONLY. Never widen this to absorb a business decision: the
 * 5-point version of it hid Team earning 59.7% against a published 60%.
 */
const EPSILON = 1e-9;

/** Dollars of delivery cost a credit grant can generate, at the current rate. */
const costOfGrant = (credits: number) =>
  (credits / CREDIT_COSTS.generation) * COST;

describe('the measured basis is present and sane', () => {
  it('carries the all-in cost, not the Cohere-only average', () => {
    // $0.077 is the Cohere-only figure. Pricing against it is precisely how the
    // old grants looked survivable, so a regression to it must fail loudly.
    expect(COST).toBeGreaterThan(0.2);
    expect(MARGIN).toBeGreaterThan(0);
    expect(MARGIN).toBeLessThan(1);
  });

  it('charges enough credits per run that a credit covers its own delivery', () => {
    // At 10 credits the largest pack was already negative on an average run.
    expect(CREDIT_COSTS.generation).toBeGreaterThanOrEqual(20);
  });
});

describe('every paid subscription tier is profitable at FULL grant consumption', () => {
  // Worst case, not typical case. A subscriber who spends every credit they
  // were granted must still be profitable, or the grant is a liability that
  // scales with success.
  for (const [tier, price] of Object.entries(TIER_SUBSCRIPTION_PRICES)) {
    it(`${tier}: grant cost is within the revenue it is sold for`, () => {
      const limits = TIER_LIMITS[tier as keyof typeof TIER_LIMITS];
      const revenue = price.priceUsdCents / 100;
      const cost = costOfGrant(limits.creditsPerMonth);
      const margin = (revenue - cost) / revenue;
      // No business slack. This asserted `MARGIN - 0.05`, and those 5 points
      // were never documented as covering anything -- they silently admitted
      // Team's 59.7% while the constants file and the marketing page both
      // said 60%, and would have admitted drift all the way to 55% without a
      // figure moving anywhere a reader could see. The independent audit
      // caught it. EPSILON is float tolerance, not margin tolerance:
      // enterprise lands on exactly 60.0% and must not fail on a rounding bit.
      expect(
        margin,
        `${tier} earns ${(margin * 100).toFixed(1)}% margin at full grant ` +
          `($${revenue} revenue, $${cost.toFixed(2)} cost) — below the ` +
          `${MARGIN * 100}% target`
      ).toBeGreaterThanOrEqual(MARGIN - EPSILON);
    });

    it(`${tier}: the daily cap cannot outrun the monthly grant`, () => {
      // The old caps and grants disagreed, so neither was the real bound and
      // the "cap" bounded nothing. One ceiling, and it is the grant.
      const limits = TIER_LIMITS[tier as keyof typeof TIER_LIMITS];
      const appsFromGrant = limits.creditsPerMonth / CREDIT_COSTS.generation;
      expect(
        limits.generationsPerDay * 30,
        `${tier} allows ${limits.generationsPerDay * 30} runs/month by daily ` +
          `cap but only ${appsFromGrant} by grant — the cap is not the bound`
      ).toBeGreaterThanOrEqual(appsFromGrant);
    });
  }
});

describe('no tier is an unbounded loss', () => {
  it('every tier has a finite daily cap, enterprise included', () => {
    // enterprise.generationsPerDay was Infinity: the only unbounded-loss path
    // in the product, per the unit-economics doc.
    for (const [tier, limits] of Object.entries(TIER_LIMITS)) {
      expect(
        Number.isFinite(limits.generationsPerDay),
        `${tier} has no finite daily cap`
      ).toBe(true);
      expect(Number.isFinite(limits.creditsPerMonth)).toBe(true);
    }
  });

  it('the free tier costs less to serve than a cup of coffee', () => {
    // A free account is an acquisition cost and is allowed to be one. It is
    // not allowed to be unsized: it was 1,000 credits = $28.50 of real cost.
    const cost = costOfGrant(TIER_LIMITS.free.creditsPerMonth);
    expect(
      cost,
      `free tier costs $${cost.toFixed(2)}/account/month`
    ).toBeLessThan(2);
  });

  it('the enterprise floor covers the enterprise grant at target margin', () => {
    const cost = costOfGrant(TIER_LIMITS.enterprise.creditsPerMonth);
    const floor = ENTERPRISE_CONTRACT_FLOOR_USD_CENTS / 100;
    const margin = (floor - cost) / floor;
    expect(
      margin,
      `an enterprise contract at the floor ($${floor}) against a grant costing ` +
        `$${cost.toFixed(2)} earns ${(margin * 100).toFixed(1)}%`
    ).toBeGreaterThanOrEqual(MARGIN - EPSILON);
  });
});

describe('the code that ISSUES credits pays the number that was priced', () => {
  /**
   * Everything above this point re-derives from ALL_IN_COST_PER_APP_USD and
   * proves the CONSTANTS are solvent. That is necessary and it is not
   * sufficient, and the gap between the two shipped: TIER_LIMITS was cut to
   * solvent numbers while `cron-handler.ts` went on granting the old ones from
   * three hardcoded literals, and `001_init.sql` went on granting every new
   * account 1,000 free credits. Every test in this file passed throughout,
   * because every test in this file read the constant.
   *
   * A test that measures the number instead of the payout reports the same
   * green whether the payout matches it or not. So these read the payout
   * paths — the real SQL in the real files — and compare them to the priced
   * figure. Source-level rather than behavioural because the cron runs against
   * D1 inside a Worker; the thing that broke was a literal in a query, and a
   * literal in a query is visible here.
   */
  const repoRoot = resolve(__dirname, '../../..');
  const cronSrc = readFileSync(
    resolve(repoRoot, 'apps/web/src/lib/cron-handler.ts'),
    'utf8'
  );

  it('the monthly reset does not hardcode any grant figure', () => {
    // The exact defect: `WHEN tier = 'pro' THEN 50000`.
    const hardcoded = [
      ...cronSrc.matchAll(/WHEN tier = '(\w+)' THEN (\d+)/g),
    ].map((m) => `${m[1]}=${m[2]}`);
    expect(
      hardcoded,
      `cron-handler.ts hardcodes grant figures (${hardcoded.join(', ')}). ` +
        'They must be built from TIER_LIMITS, or the priced number and the ' +
        'paid number drift apart silently — which is what happened.'
    ).toEqual([]);
  });

  it('the monthly reset builds its grant from TIER_LIMITS', () => {
    expect(cronSrc).toContain('TIER_LIMITS');
    expect(cronSrc).toMatch(/creditsPerMonth/);
  });

  it('the monthly reset covers every tier that receives a grant', () => {
    // `tier IN ('pro','team','enterprise')` excluded nonprofit, so a granted
    // nonprofit account would never have been topped up. Derived, so a sixth
    // tier is covered the day it is added.
    const granted = Object.keys(TIER_LIMITS).filter((t) => t !== 'free');
    expect(granted.length).toBeGreaterThan(3);
    const literalList = /tier IN \('[a-z]+'(?:, ?'[a-z]+')*\)/.test(cronSrc);
    expect(
      literalList,
      'cron-handler.ts restates the granted-tier list as a literal; it must ' +
        'be derived from TIER_LIMITS so a new tier is not silently skipped.'
    ).toBe(false);
  });

  it('the free signup grant in SQL matches the free grant that was priced', () => {
    // better-auth creates accounts through its adapter, so the column DEFAULT
    // is the signup grant. It said 1,000 — 40 apps, $11.40 per free signup —
    // while this file asserted free cost under $2, reading the constant.
    const migrations = resolve(repoRoot, 'migrations');
    const files = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    // The LAST definition wins, so read them in order and keep the final one.
    let dflt: number | null = null;
    for (const f of files) {
      const m = [
        ...readFileSync(resolve(migrations, f), 'utf8').matchAll(
          /credits_remaining\s+INTEGER\s+DEFAULT\s+(\d+)/gi
        ),
      ];
      if (m.length) dflt = Number(m[m.length - 1][1]);
    }
    expect(
      dflt,
      'no credits_remaining default found in any migration'
    ).not.toBeNull();
    expect(
      dflt,
      `new accounts are granted ${dflt} credits, but the free tier is priced ` +
        `at ${TIER_LIMITS.free.creditsPerMonth}. At ${CREDIT_COSTS.generation} ` +
        `credits/run that is $${((dflt! / CREDIT_COSTS.generation) * COST).toFixed(2)} ` +
        'of delivery cost per signup.'
    ).toBe(TIER_LIMITS.free.creditsPerMonth);
  });
});

describe('every credit pack covers what it delivers', () => {
  for (const [id, pack] of Object.entries(CREDIT_PACKAGES)) {
    it(`${id}: is not sold below cost, unless deliberately labelled`, () => {
      const revenue = pack.priceUsdCents / 100;
      const cost = costOfGrant(pack.credits);
      if (id === 'test') {
        // The one exception, and it is stated rather than tolerated: a $1
        // smoke test of the purchase path, knowingly sold at a small loss.
        expect(pack.label).toContain('test');
        expect(cost - revenue).toBeLessThan(1);
        return;
      }
      expect(
        revenue,
        `${id} sells ${pack.credits} credits for $${revenue} against ` +
          `$${cost.toFixed(2)} of delivery cost`
      ).toBeGreaterThan(cost);
    });
  }
});
