/**
 * The egress phase machine is the boundary between the platform and arbitrary
 * model-generated code. These assertions are the reason the boundary is
 * checkable at all — everything else about it is a comment.
 *
 * The property that matters is a negative one: there is no sequence of legal
 * transitions that has generated code running while the registry is reachable.
 * The last test in the first block asserts that exhaustively rather than by
 * example, because an example only covers the path someone thought of.
 */
import { describe, it, expect } from 'vitest';
import {
  assertMayRunUserCode,
  assertTransition,
  canTransition,
  decideInstallEgress,
  INSTALL_ALLOWED_HOSTS,
  isEgressOpen,
  mayRunUserCode,
  stripOutboundHeaders,
  STRIPPED_OUTBOUND_HEADERS,
  type SandboxPhase,
} from './sandbox-egress.js';

const ALL_PHASES: SandboxPhase[] = [
  'booting',
  'installing',
  'sealed',
  'running',
];

describe('the phase invariant', () => {
  it('never has egress open and user code runnable at the same time', () => {
    // The whole point of the module, asserted over every phase rather than
    // over the ones that came to mind. If a phase is ever added, this fails
    // until someone has decided which side of the line it sits on.
    for (const phase of ALL_PHASES) {
      expect(isEgressOpen(phase) && mayRunUserCode(phase)).toBe(false);
    }
  });

  it('opens egress in exactly one phase', () => {
    expect(ALL_PHASES.filter(isEgressOpen)).toEqual(['installing']);
  });

  it('refuses to start user code while installing', () => {
    expect(() => assertMayRunUserCode('installing')).toThrow(/sealed/i);
  });

  it('refuses to start user code while booting', () => {
    expect(() => assertMayRunUserCode('booting')).toThrow();
  });

  it('allows user code once sealed', () => {
    expect(() => assertMayRunUserCode('sealed')).not.toThrow();
    expect(() => assertMayRunUserCode('running')).not.toThrow();
  });
});

describe('phase transitions', () => {
  it('lets a project with no dependencies skip the install phase', () => {
    // Opening egress for a project that does not need it is pure downside.
    expect(canTransition('booting', 'sealed')).toBe(true);
  });

  it('allows the install path', () => {
    expect(canTransition('booting', 'installing')).toBe(true);
    expect(canTransition('installing', 'sealed')).toBe(true);
    expect(canTransition('sealed', 'running')).toBe(true);
  });

  it('never lets user code run without passing through sealed', () => {
    expect(canTransition('installing', 'running')).toBe(false);
    expect(canTransition('booting', 'running')).toBe(false);
  });

  it('never reopens egress under running code', () => {
    // The dangerous transition: a container already executing generated code
    // being put back into a phase where the registry answers.
    expect(canTransition('running', 'installing')).toBe(false);
    expect(canTransition('sealed', 'installing')).toBe(false);
    expect(() => assertTransition('running', 'installing')).toThrow(
      /never move backwards/i
    );
  });

  it('has no path from any phase back to booting', () => {
    for (const phase of ALL_PHASES) {
      expect(canTransition(phase, 'booting')).toBe(false);
    }
  });
});

describe('decideInstallEgress', () => {
  const get = (url: string) => ({ method: 'GET', url });

  it('allows a registry tarball fetch during install', () => {
    const decision = decideInstallEgress(
      get('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'),
      'installing'
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies everything once sealed, including the registry', () => {
    // The seal is a phase, not a host list. After install the registry is as
    // unreachable as anything else.
    const decision = decideInstallEgress(
      get(`https://${INSTALL_ALLOWED_HOSTS[0]}/lodash`),
      'sealed'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/closed/i);
  });

  it('denies during running, which is when generated code is executing', () => {
    expect(
      decideInstallEgress(get('https://registry.npmjs.org/x'), 'running')
        .allowed
    ).toBe(false);
  });

  it('denies a host that is not the registry', () => {
    for (const url of [
      'https://evil.example.com/exfil',
      'https://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
      'https://api.cohere.ai/v2/chat',
    ]) {
      const decision = decideInstallEgress(get(url), 'installing');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/allowlist/i);
    }
  });

  it('denies a lookalike host rather than matching on a suffix', () => {
    // `registry.npmjs.org.evil.com` ends with nothing meaningful, but a
    // suffix or substring check would pass the first two of these.
    for (const host of [
      'registry.npmjs.org.evil.com',
      'notregistry.npmjs.org',
      'registry.npmjs.org.',
    ]) {
      expect(
        decideInstallEgress(get(`https://${host}/lodash`), 'installing').allowed
      ).toBe(false);
    }
  });

  it('denies a POST to the registry even during install', () => {
    // A POST with a stolen token is how a compromised sandbox would publish a
    // package. The install phase is read-only.
    const decision = decideInstallEgress(
      { method: 'POST', url: 'https://registry.npmjs.org/-/user/token' },
      'installing'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/method/i);
  });

  it('denies PUT and DELETE to the registry', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect(
        decideInstallEgress(
          { method, url: 'https://registry.npmjs.org/x' },
          'installing'
        ).allowed
      ).toBe(false);
    }
  });

  it('allows HEAD, which npm uses', () => {
    expect(
      decideInstallEgress(
        { method: 'HEAD', url: 'https://registry.npmjs.org/lodash' },
        'installing'
      ).allowed
    ).toBe(true);
  });

  it('is not case-sensitive about the method', () => {
    expect(
      decideInstallEgress(
        { method: 'get', url: 'https://registry.npmjs.org/lodash' },
        'installing'
      ).allowed
    ).toBe(true);
  });

  it('denies a non-web protocol', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/plain,hello',
      'ftp://registry.npmjs.org/x',
    ]) {
      expect(decideInstallEgress(get(url), 'installing').allowed).toBe(false);
    }
  });

  it('denies an unparseable URL rather than throwing', () => {
    // A throw inside the outbound handler would fail the request, but with no
    // stated reason and no record of what was attempted.
    const decision = decideInstallEgress(get('not a url'), 'installing');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it('always states a reason when denying', () => {
    for (const phase of ALL_PHASES) {
      for (const url of ['https://evil.com', 'https://registry.npmjs.org/x']) {
        const decision = decideInstallEgress(get(url), phase);
        if (!decision.allowed) expect(decision.reason).toBeTruthy();
      }
    }
  });
});

describe('stripOutboundHeaders', () => {
  it('removes every credential-bearing header', () => {
    const headers = new Headers({ 'user-agent': 'npm/10' });
    for (const name of STRIPPED_OUTBOUND_HEADERS) headers.set(name, 'secret');

    const clean = stripOutboundHeaders(headers);

    for (const name of STRIPPED_OUTBOUND_HEADERS) {
      expect(clean.get(name)).toBeNull();
    }
    expect(clean.get('user-agent')).toBe('npm/10');
  });

  it('does not mutate the original', () => {
    const headers = new Headers({ authorization: 'Bearer x' });
    stripOutboundHeaders(headers);
    expect(headers.get('authorization')).toBe('Bearer x');
  });
});
