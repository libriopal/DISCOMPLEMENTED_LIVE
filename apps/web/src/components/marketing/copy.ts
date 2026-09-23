/**
 * Marketing copy — verbatim from DESIGN_SPEC.md and
 * "Discomplemented Overhaul Design.dc.html".
 *
 * This copy has been through design and audit (DREP-004, APPROVED) and is a
 * fixed constraint, not open for rewriting. It lives in one module, separate
 * from presentation, so that a visual change can never quietly reword it and
 * so the constraint tests have a single thing to assert against.
 *
 * Three rules are load-bearing rather than stylistic:
 *
 *   1. No quality/VDR percentage appears anywhere. There is no derived ceiling
 *      — the 91.3% figure had no basis, and DESIGN_SPEC §29 replaces it with
 *      the `trust.disclaimer` line below. That line is the replacement, not
 *      filler; deleting it re-opens the gap it was written to close.
 *   2. "Architect" is never named as an agent. The role is dead in
 *      model-router.ts ("legacy — now handled by researcher"), so naming it
 *      would describe a pipeline that no longer exists.
 *   3. The pricing badge stays until a real Stripe account exists. The prices
 *      are placeholders in constants.ts with nothing live behind them.
 */

import { TIER_LIMITS } from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared';
import type { OfferClass } from './pricing-derivation.js';
import {
  OFFER_CLASS,
  TIER_ORDER,
  appsPerMonth,
  formatLimit,
  priceLabel,
} from './pricing-derivation.js';

export const NAV_LINKS = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Boundaries', href: '#boundaries' },
  { label: 'Pricing', href: '#pricing' },
  // A compliance surface nobody can find is a compliance surface nobody
  // checks -- the same defect as a gate that runs and reports to nothing.
  // /compliance publishes this system's audit verdicts, gate denominators and
  // mutation coverage, including what is NOT established.
  { label: 'Compliance', href: '/compliance' },
] as const;

export const HERO = {
  eyebrow: 'Research + design, before a line of code',
  headline: 'Your dev team researches and designs before it writes any code.',
  subhead:
    'A researcher, designer, and coder agent build a blueprint you review — then, and only then, the app gets built.',
  primaryCta: 'Start building',
  secondaryCta: 'See how it works',
} as const;

export const HOW_IT_WORKS = {
  title: 'How it works',
  subtitle: 'Four steps. You approve the blueprint before anything ships.',
  steps: [
    {
      label: '01 — Describe',
      body: 'Tell it what you want to build, in plain language.',
      highlighted: false,
    },
    {
      label: '02 — Research & design',
      body: 'Agents scope the problem and produce a blueprint — not code yet.',
      highlighted: false,
    },
    {
      // The human gate is the differentiator, so this card carries the accent
      // border called for in DESIGN_SPEC §26.
      label: '03 — You review',
      body: 'A human gate. Nothing gets built until you approve the plan.',
      highlighted: true,
    },
    {
      label: '04 — Code & deploy',
      body: 'The coder agent builds it and deploys to your app, on Cloudflare Workers + D1.',
      highlighted: false,
    },
  ],
} as const;

export const BOUNDARIES = {
  title: "What it's good at today",
  subtitle:
    "We'd rather tell you where the edges are than let you find them the hard way.",
  strongLabel: 'Strong today',
  strong: [
    'Fast first builds from a plain-language description',
    'A real blueprint review before code exists',
    'Standard web-app patterns: auth, CRUD, dashboards',
  ],
  evolvingLabel: 'Still evolving',
  evolving: [
    'Complex third-party integrations',
    "Automated quality scoring — we're building toward measured, real-world metrics rather than a simulated one",
    'High-scale, high-compliance enterprise features',
  ],
} as const;

/**
 * The pricing section.
 *
 * `tiers` is BUILT, not written. Every figure comes from the constant that
 * governs it (see pricing-derivation.ts), so a change to a grant, a price or
 * the per-run credit cost moves this page or fails the build. The words are
 * still authored; the numbers are not.
 *
 * It used to list three tiers while TIER_LIMITS entitled four, so `enterprise`
 * was serveable and unbuyable. There are five now, because `nonprofit` was
 * priced in the system's own genome and existed nowhere a visitor could see.
 */
export const PRICING_COPY: Record<
  SubscriptionTier,
  { name: string; body: string; highlighted: boolean }
> = {
  // The three original tiers keep their EXACT wording. §2 of the audit
  // constraints freezes marketing copy, and this change needed new numbers,
  // not new sentences — rewording these while I was in the file, then updating
  // copy.test.ts to accept the new strings, would have defeated the freeze
  // rather than complied with it. The independent audit caught that and was
  // right. Only `nonprofit` and `enterprise` carry new text, because those
  // tiers had no visitor-facing copy at all.
  free: {
    name: 'Free',
    body: 'Try the pipeline on a small project.',
    highlighted: false,
  },
  pro: {
    name: 'Pro',
    body: 'More builds, more credits, priority queue.',
    highlighted: true,
  },
  team: {
    name: 'Team',
    body: 'Shared projects, higher limits, team seats.',
    highlighted: false,
  },
  nonprofit: {
    name: 'Nonprofit',
    body: 'The Team tier, granted free to qualifying nonprofits.',
    highlighted: false,
  },
  enterprise: {
    name: 'Enterprise',
    body: 'Bespoke limits, an evidence pack, and a contract.',
    highlighted: false,
  },
};

export interface PricingTier {
  tier: SubscriptionTier;
  name: string;
  /** Derived. A price for a purchasable tier, a route for a provisioned one. */
  price: string;
  appsPerMonth: number;
  perDay: string;
  body: string;
  highlighted: boolean;
  offer: OfferClass;
}

export const PRICING: {
  title: string;
  badge: string;
  subtitle: string;
  tiers: PricingTier[];
} = {
  title: 'Pricing',
  // Kept, for a narrower reason than before. The prices are derived from
  // measured unit economics and solvent at full grant consumption -- see
  // pricing-solvency.test.ts. They have not yet met a market.
  badge: 'Early access — subject to change',
  // Unchanged, and deliberately so. Rewriting this sentence was not needed by
  // the pricing change and §2 freezes the wording.
  subtitle: "Simple tiers while we're in early access. No surprises later.",
  tiers: TIER_ORDER.map((tier) => ({
    tier,
    name: PRICING_COPY[tier].name,
    price: priceLabel(tier),
    appsPerMonth: appsPerMonth(tier),
    perDay: formatLimit(TIER_LIMITS[tier].generationsPerDay),
    body: PRICING_COPY[tier].body,
    highlighted: PRICING_COPY[tier].highlighted,
    offer: OFFER_CLASS[tier],
  })),
};

export const TRUST = {
  title: 'Built on a real human review gate',
  body: 'A researcher and designer agent build the plan; you approve it before the coder agent touches anything. Built on Cloudflare Workers, D1, and Cohere.',
  disclaimer:
    "We're building toward measured, real-world quality metrics — we'd rather show nothing than a number we can't stand behind.",
} as const;

export const FOOTER = {
  copyright: '© Discomplement',
  links: [
    { label: 'Terms', href: '/legal/terms' },
    { label: 'Privacy', href: '/legal/privacy' },
    { label: 'AUP', href: '/legal/acceptable-use' },
  ],
} as const;

export const BRAND = 'Discomplement';
export const SIGN_IN = 'Sign in';
