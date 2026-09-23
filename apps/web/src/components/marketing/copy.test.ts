import { TIER_SUBSCRIPTION_PRICES } from '@bicameral/shared/constants';
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HERO,
  HOW_IT_WORKS,
  BOUNDARIES,
  PRICING,
  PRICING_COPY,
  TRUST,
  FOOTER,
  NAV_LINKS,
} from './copy.js';

/**
 * The four constraints DESIGN_SPEC marks as fixed regardless of visual
 * redesign: section order, verbatim copy, the provisional-pricing badge, and
 * the absence of any quality percentage.
 *
 * These assert the constraints rather than the styling, so the look can be
 * reworked freely without anyone silently reopening a claim the audit closed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETING_SOURCE = readFileSync(
  resolve(HERE, 'MarketingSite.tsx'),
  'utf8'
);

/**
 * Comments are stripped before the content assertions run. The constraint is
 * that no percentage reaches a visitor, and a comment recording *why* a figure
 * was retired is exactly the note that should survive — the first run of this
 * suite failed on its own explanatory comment.
 */
const MARKETING_TSX = MARKETING_SOURCE.replace(
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  ''
);

describe('verbatim copy', () => {
  it('hero matches the spec word-for-word', () => {
    expect(HERO.eyebrow).toBe('Research + design, before a line of code');
    expect(HERO.headline).toBe(
      'Your dev team researches and designs before it writes any code.'
    );
    expect(HERO.subhead).toBe(
      'A researcher, designer, and coder agent build a blueprint you review — then, and only then, the app gets built.'
    );
    expect(HERO.primaryCta).toBe('Start building');
    expect(HERO.secondaryCta).toBe('See how it works');
  });

  it('how-it-works steps match the spec word-for-word', () => {
    expect(HOW_IT_WORKS.subtitle).toBe(
      'Four steps. You approve the blueprint before anything ships.'
    );
    expect(HOW_IT_WORKS.steps.map((s) => s.label)).toEqual([
      '01 — Describe',
      '02 — Research & design',
      '03 — You review',
      '04 — Code & deploy',
    ]);
    expect(HOW_IT_WORKS.steps[2]?.body).toBe(
      'A human gate. Nothing gets built until you approve the plan.'
    );
  });

  it('keeps the trust disclaimer that replaced the retired ceiling', () => {
    expect(TRUST.disclaimer).toBe(
      "We're building toward measured, real-world quality metrics — we'd rather show nothing than a number we can't stand behind."
    );
  });

  it('pricing wording is frozen, tier by tier', () => {
    // §2 of the audit constraints says marketing wording may not change and is
    // "enforced by copy.test.ts". It was not: hero and how-it-works were
    // pinned word-for-word here, pricing never was. So the pricing subtitle
    // and tier bodies could be rewritten freely, and were — during the change
    // that re-derived the prices, with this file edited to accept the new
    // strings. The independent audit flagged it: any future wording change
    // could be landed the same way, because nothing held the old words.
    //
    // Now something does. The NUMBERS on this section are derived and must
    // move when the constants move; the WORDS are frozen and must not.
    expect(PRICING.subtitle).toBe(
      "Simple tiers while we're in early access. No surprises later."
    );
    expect(PRICING_COPY.free.body).toBe('Try the pipeline on a small project.');
    expect(PRICING_COPY.pro.body).toBe(
      'More builds, more credits, priority queue.'
    );
    expect(PRICING_COPY.team.body).toBe(
      'Shared projects, higher limits, team seats.'
    );
  });
});

describe('no quality percentage anywhere', () => {
  // The 91.3% VDR ceiling had no derivation behind it. Nothing on the public
  // site may state a quality figure until real staging data exists.
  const surfaces = [
    JSON.stringify({ HERO, HOW_IT_WORKS, BOUNDARIES, PRICING, TRUST, FOOTER }),
    MARKETING_TSX,
  ];

  it.each(surfaces.map((s, i) => [i === 0 ? 'copy' : 'markup', s]))(
    'the %s contains no percentage figure',
    (_label, source) => {
      // Percentages only; prices such as $29/mo are unaffected.
      expect(source).not.toMatch(/\d+(\.\d+)?\s?%/);
    }
  );

  it('never mentions VDR or a quality score on the public surface', () => {
    for (const source of surfaces) {
      expect(source).not.toMatch(/\bVDR\b/i);
      expect(source).not.toMatch(/quality (score|ceiling|rating)/i);
    }
  });

  it('91.3 appears nowhere', () => {
    for (const source of surfaces) expect(source).not.toContain('91.3');
  });
});

describe('Architect is never named as an agent', () => {
  // The role is dead in model-router.ts ("legacy — now handled by researcher"),
  // so naming it would describe a pipeline that no longer runs.
  it('does not appear in any marketing copy or markup', () => {
    const combined =
      JSON.stringify({ HERO, HOW_IT_WORKS, BOUNDARIES, PRICING, TRUST }) +
      MARKETING_TSX;
    expect(combined).not.toMatch(/\barchitect\b/i);
  });

  it('names exactly the three live roles in the hero subhead', () => {
    expect(HERO.subhead).toContain('researcher');
    expect(HERO.subhead).toContain('designer');
    expect(HERO.subhead).toContain('coder');
  });
});

describe('pricing is presented as provisional', () => {
  it('carries the mandatory badge', () => {
    expect(PRICING.badge).toBe('Early access — subject to change');
  });

  it('renders the badge in the markup', () => {
    expect(MARKETING_TSX).toContain('PRICING.badge');
    expect(MARKETING_TSX).toContain('mkt-badge');
  });

  it('lists every entitled tier, at prices derived from the constants', () => {
    // Was three tiers, hardcoded. TIER_LIMITS entitled four, so `enterprise`
    // was serveable and unbuyable; `nonprofit` was priced in the genome and
    // existed nowhere a visitor could see. Five now, and the prices are
    // asserted against the governing constants rather than retyped here --
    // a test that hardcodes the number it checks is a second copy of it.
    expect(PRICING.tiers.map((t) => [t.name, t.price])).toEqual([
      ['Free', '$0'],
      ['Pro', `$${TIER_SUBSCRIPTION_PRICES.pro.priceUsdCents / 100}/mo`],
      ['Team', `$${TIER_SUBSCRIPTION_PRICES.team.priceUsdCents / 100}/mo`],
      ['Nonprofit', 'Free, by grant'],
      ['Enterprise', 'Talk to us'],
    ]);
  });

  it('highlights Pro as the featured tier', () => {
    expect(
      PRICING.tiers.filter((t) => t.highlighted).map((t) => t.name)
    ).toEqual(['Pro']);
  });
});

describe('section order', () => {
  it('renders nav, hero, how-it-works, boundaries, pricing, trust, footer in order', () => {
    const markers = [
      'mkt-nav',
      'mkt-hero',
      'id="how-it-works"',
      'id="boundaries"',
      'id="pricing"',
      'id="trust"',
      'mkt-footer',
    ];
    const positions = markers.map((m) => MARKETING_TSX.indexOf(m));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('marks the human review gate as the highlighted step', () => {
    expect(
      HOW_IT_WORKS.steps.filter((s) => s.highlighted).map((s) => s.label)
    ).toEqual(['03 — You review']);
  });
});

describe('links', () => {
  it('points the footer at legal pages that exist in the repo', () => {
    const slugs = Object.keys(
      // Read the real doc registry rather than trusting the hrefs.
      JSON.parse(
        JSON.stringify(
          readFileSync(resolve(HERE, '../../content/legal-docs.ts'), 'utf8')
            .match(/slug: '([a-z-]+)'/g)
            ?.reduce<Record<string, true>>((acc, m) => {
              const slug = /slug: '([a-z-]+)'/.exec(m)?.[1];
              if (slug !== undefined) acc[slug] = true;
              return acc;
            }, {}) ?? {}
        )
      )
    );
    for (const link of FOOTER.links) {
      expect(slugs, `${link.href} has no legal doc`).toContain(
        link.href.replace('/legal/', '')
      );
    }
  });

  it('anchors every nav link to a section that exists, or routes it', () => {
    // Two kinds of link now. An in-page anchor must have a section to land on;
    // a route (`/compliance`) must not be checked for one, and conflating them
    // would either fail a valid link or stop checking the anchors at all.
    // The route branch ASSERTS THE ROUTE EXISTS, not merely that the string is
    // shaped like one. Its first version checked only /^\/[a-z0-9-]+$/, which
    // the independent §4B audit correctly called a weakened check under
    // constraint 6: `href: '/complience'` would have passed, and so would a
    // link to a route somebody later deleted. The old anchor-only test would
    // have failed on a dangling target; the replacement accepted any
    // well-shaped string — a dead nav link to the compliance surface, which is
    // precisely the "surface nobody can find" the link exists to prevent.
    const APP_TSX = readFileSync(resolve(HERE, '../../App.tsx'), 'utf8');
    for (const link of NAV_LINKS) {
      if (link.href.startsWith('#')) {
        expect(MARKETING_TSX).toContain(`id="${link.href.slice(1)}"`);
      } else {
        expect(
          APP_TSX,
          `NAV_LINKS points at ${link.href}, which App.tsx does not route. A ` +
            'nav link to a route that does not exist is a dead link, and ' +
            'checking only its shape cannot tell the two apart.'
        ).toContain(`'${link.href}'`);
      }
    }
  });
});

describe('marketing module hygiene', () => {
  it('keeps copy out of the component file', () => {
    // Every user-visible string must come from copy.ts, so the constraint
    // tests above cover all of it.
    const files = readdirSync(HERE);
    expect(files).toContain('copy.ts');
    expect(MARKETING_TSX).toContain("from './copy.js'");
  });
});
