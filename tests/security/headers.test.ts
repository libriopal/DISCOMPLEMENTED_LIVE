/**
 * Asserts the security headers the Worker sets on every response.
 *
 * These are pinned rather than merely present: a header that exists but has
 * been quietly widened is worse than one that is missing, because it still
 * reads as covered. Narrowing `connect-src` is deliberate follow-up work — when
 * it happens, the expectation below should be tightened in the same commit, so
 * the change is visible in a diff rather than absorbed silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX = resolve(__dirname, '../../apps/web/src/index.ts');
const source = readFileSync(INDEX, 'utf8');

/** Pull a `c.header('Name', '...')` literal out of the Worker source. */
function headerLiteral(name: string): string | null {
  const re = new RegExp(
    `c\\.header\\(\\s*['"]${name}['"]\\s*,\\s*['"]([^'"]+)['"]`
  );
  return re.exec(source)?.[1] ?? null;
}

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff', () => {
    expect(headerLiteral('X-Content-Type-Options')).toBe('nosniff');
  });

  it('denies framing', () => {
    expect(headerLiteral('X-Frame-Options')).toBe('DENY');
  });

  it('sets a strict referrer policy', () => {
    expect(headerLiteral('Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin'
    );
  });

  it('sets HSTS with a one-year max-age and preload', () => {
    const hsts = headerLiteral('Strict-Transport-Security');
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('denies camera and geolocation outright', () => {
    const policy = headerLiteral('Permissions-Policy');
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');
  });
});

describe('content security policy', () => {
  // The CSP is built from an array joined with '; ', so it is read from the
  // source array rather than a single string literal.
  // Each directive is a double-quoted array entry whose value itself contains
  // single quotes ("connect-src 'self' https://..."), so the capture must
  // exclude only the double quote that delimits it.
  const directive = (name: string): string | undefined =>
    new RegExp(`"${name} ([^"]+)"`).exec(source)?.[1];

  it('defaults to self', () => {
    expect(directive('default-src')).toBe("'self'");
  });

  it('forbids plugins via object-src none', () => {
    expect(directive('object-src')).toBe("'none'");
  });

  it('pins base-uri to self, so injected <base> cannot redirect relative URLs', () => {
    expect(directive('base-uri')).toBe("'self'");
  });

  // Exact-match on purpose: this is an allowlist, and the assertion is what
  // stops a third origin being added without anyone deciding to. Both entries
  // render in an iframe and so genuinely need frame-src — Stripe Checkout, and
  // the Turnstile challenge widget admitted by the CSP fix on main. Adding an
  // origin here means adding it to this string too, deliberately.
  it('permits Stripe and Turnstile in frame-src and nothing else', () => {
    expect(directive('frame-src')).toBe(
      "'self' https://js.stripe.com https://challenges.cloudflare.com"
    );
  });

  it('never allows a wildcard connect-src', () => {
    const connect = directive('connect-src');
    expect(connect).toBeDefined();
    expect(connect).not.toContain('*');
    expect(connect).toContain("'self'");
  });
});
