/**
 * The logged-out marketing site.
 *
 * Replaces the previous logged-out experience, which was a logo, one headline
 * and a signup form — 34 semantic nodes with no pricing, no product
 * explanation, and nothing indexable. Section order is fixed by DESIGN_SPEC;
 * all copy comes verbatim from ./copy.ts and must not be reworded here.
 *
 * `onSignIn` hands off to the existing LoginScreen rather than duplicating any
 * auth UI, so there remains exactly one implementation of the credential form.
 */
import {
  HERO,
  HOW_IT_WORKS,
  BOUNDARIES,
  PRICING,
  TRUST,
  FOOTER,
  NAV_LINKS,
  BRAND,
  SIGN_IN,
} from './copy.js';
import { LatticeMark } from './assets/LatticeMark.js';
import { LatticeField } from './assets/LatticeField.js';
import { STEP_ICONS, IconStrong, IconEvolving } from './assets/StepIcons.js';
import { ThemeToggle } from '../ThemeToggle.js';
import '../../styles/marketing.css';

export interface MarketingSiteProps {
  /** Navigate to the existing auth screen. */
  onSignIn: () => void;
}

export function MarketingSite({ onSignIn }: MarketingSiteProps) {
  return (
    <div className="mkt">
      <header className="mkt-nav">
        <div className="mkt__inner mkt-nav__inner">
          <span className="mkt-nav__brandmark">
            <LatticeMark size={24} />
            <span className="mkt-nav__brand">{BRAND}</span>
          </span>
          <nav className="mkt-nav__links" aria-label="Primary">
            {NAV_LINKS.map((link) => (
              <a key={link.href} className="mkt-nav__link" href={link.href}>
                {link.label}
              </a>
            ))}
            <button type="button" className="mkt-nav__link" onClick={onSignIn}>
              {SIGN_IN}
            </button>
            {/* The theme picker lived only in IDELayout, so it was reachable
                only after signing in — which meant the surface carrying the
                palette was the one surface with no way to switch it. It is a
                control, not copy, so nothing in copy.ts describes it. */}
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main>
        <section className="mkt-hero">
          <LatticeField />
          <div className="mkt__inner">
            <div className="mkt-hero__body">
              <p className="mkt-eyebrow">{HERO.eyebrow}</p>
              <h1 className="mkt-hero__headline">{HERO.headline}</h1>
              <p className="mkt-hero__subhead">{HERO.subhead}</p>
              <div className="mkt-hero__actions">
                <button
                  type="button"
                  className="mkt-btn mkt-btn--primary"
                  onClick={onSignIn}
                >
                  {HERO.primaryCta}
                </button>
                <a className="mkt-btn mkt-btn--secondary" href="#how-it-works">
                  {HERO.secondaryCta}
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="mkt-section" id="how-it-works">
          <div className="mkt__inner">
            <h2 className="mkt-section__title">{HOW_IT_WORKS.title}</h2>
            <p className="mkt-section__subtitle">{HOW_IT_WORKS.subtitle}</p>
            <div className="mkt-steps">
              {HOW_IT_WORKS.steps.map((step, i) => {
                const Icon = STEP_ICONS[i] ?? STEP_ICONS[0];
                return (
                  <article
                    key={step.label}
                    className={`mkt-card${step.highlighted ? ' mkt-card--accent' : ''}`}
                  >
                    <span className="mkt-card__icon">
                      <Icon />
                    </span>
                    <h3 className="mkt-card__label">{step.label}</h3>
                    <p className="mkt-card__body">{step.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="mkt-section mkt-section--banded" id="boundaries">
          <div className="mkt__inner">
            <h2 className="mkt-section__title">{BOUNDARIES.title}</h2>
            <p className="mkt-section__subtitle">{BOUNDARIES.subtitle}</p>
            <div className="mkt-boundaries">
              <div>
                <h3 className="mkt-list__label mkt-list__label--strong">
                  {BOUNDARIES.strongLabel}
                </h3>
                <ul className="mkt-list">
                  {BOUNDARIES.strong.map((item) => (
                    <li key={item}>
                      <IconStrong className="mkt-list__icon" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mkt-list__label mkt-list__label--evolving">
                  {BOUNDARIES.evolvingLabel}
                </h3>
                <ul className="mkt-list mkt-list--evolving">
                  {BOUNDARIES.evolving.map((item) => (
                    <li key={item}>
                      <IconEvolving className="mkt-list__icon" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="mkt-section" id="pricing">
          <div className="mkt__inner">
            <div className="mkt-pricing__head">
              <h2 className="mkt-section__title">{PRICING.title}</h2>
              <span className="mkt-badge">{PRICING.badge}</span>
            </div>
            <p className="mkt-section__subtitle">{PRICING.subtitle}</p>
            <div className="mkt-tiers">
              {PRICING.tiers.map((tier) => (
                <article
                  key={tier.name}
                  className={`mkt-card${tier.highlighted ? ' mkt-card--accent' : ''}`}
                >
                  <h3 className="mkt-tier__name">{tier.name}</h3>
                  <p className="mkt-tier__price">{tier.price}</p>
                  <p className="mkt-card__body">{tier.body}</p>
                  {/* Derived from TIER_LIMITS and CREDIT_COSTS, never typed.
                      "More builds, more credits" used to sit beside a constant
                      that said exactly how many; now the page says the number
                      and moves when the constant does. */}
                  <p className="mkt-tier__limits">
                    <strong>{tier.appsPerMonth.toLocaleString()}</strong> apps a
                    month · up to {tier.perDay} a day
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          className="mkt-section mkt-section--banded mkt-trust"
          id="trust"
        >
          <div className="mkt__inner">
            <div className="mkt-trust__body">
              <h2 className="mkt-section__title">{TRUST.title}</h2>
              <p className="mkt-trust__para">{TRUST.body}</p>
              {/* Replaces the retired 91.3% ceiling. Not filler — see copy.ts. */}
              <p className="mkt-trust__disclaimer">{TRUST.disclaimer}</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mkt-footer">
        <div className="mkt__inner mkt-footer__inner">
          <span className="mkt-footer__brand">
            <LatticeMark size={18} />
            {FOOTER.copyright}
          </span>
          <div className="mkt-footer__links">
            {FOOTER.links.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
