import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import { runRules, formatViolations, RULES } from './index.js';
import { collectLogs } from '../tools/read-logs.js';

const file = (
  path: string,
  content: string,
  language = 'typescript'
): ProjectFile => ({
  path,
  content,
  language,
});

/** A module long enough to clear the stub-size floor. */
const bulk = (marker = ''): string =>
  `${marker}\nexport function widget() {\n` +
  '  const rows = [];\n'.repeat(60) +
  '  return rows;\n}\n';

describe('rule registry', () => {
  it('exposes a unique id per rule', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes a clean file', () => {
    expect(runRules([file('src/app.ts', bulk())])).toEqual([]);
  });
});

describe('no_truncation_marker', () => {
  // The gap that motivated the port: neither previous validator looked for
  // elisions, so a file the model cut short read as complete.
  it.each([
    '// ... rest of the file unchanged',
    '/* ... remaining implementation */',
    '// ... existing code',
    '{/* ... */}',
  ])('catches %j', (marker) => {
    const found = runRules([file('src/app.ts', bulk(marker))]);
    expect(found.map((v) => v.ruleId)).toContain('no_truncation_marker');
  });

  it('reports the line the elision is on', () => {
    const content = `${'const a = 1;\n'.repeat(9)}// ... rest of file\n${bulk()}`;
    const [violation] = runRules([file('src/app.ts', content)]).filter(
      (v) => v.ruleId === 'no_truncation_marker'
    );
    expect(violation?.line).toBe(10);
  });

  it('does not fire on ordinary prose containing "rest"', () => {
    const found = runRules([
      file('src/app.ts', bulk('// let the worker rest between polls')),
    ]);
    expect(found.map((v) => v.ruleId)).not.toContain('no_truncation_marker');
  });
});

describe('no_placeholder_stub', () => {
  // finalize-generation.ts matched only /(Implement|TODO|placeholder)/ and so
  // silently passed both of these.
  it.each(['// stub — fill in later', '// not implemented yet'])(
    'catches %j, which the old finalize copy missed',
    (marker) => {
      expect(
        runRules([file('src/app.ts', bulk(marker))]).map((v) => v.ruleId)
      ).toContain('no_placeholder_stub');
    }
  );
});

describe('no_inlined_secret', () => {
  it('catches a Stripe secret key in a generated file', () => {
    const found = runRules([
      file('src/pay.ts', bulk('const k = "sk_live_51H8xQ2eZvKYlo2C";')),
    ]);
    expect(found.map((v) => v.ruleId)).toContain('no_inlined_secret');
  });

  it('catches a generic long api key assignment', () => {
    const found = runRules([
      file('src/api.ts', bulk('const apiKey = "a1b2c3d4e5f6g7h8i9j0k1l2m3";')),
    ]);
    expect(found.map((v) => v.ruleId)).toContain('no_inlined_secret');
  });

  it('leaves a short non-secret constant alone', () => {
    const found = runRules([
      file('src/api.ts', bulk('const mode = "production";')),
    ]);
    expect(found.map((v) => v.ruleId)).not.toContain('no_inlined_secret');
  });
});

describe('no_direct_provider_call', () => {
  it('flags a browser file calling a provider directly', () => {
    const found = runRules([
      file(
        'index.html',
        '<script>fetch("https://api.openai.com/v1/chat")</script>',
        'html'
      ),
    ]);
    expect(found.map((v) => v.ruleId)).toContain('no_direct_provider_call');
  });

  it('allows a server route to call one', () => {
    const found = runRules([
      file('server/llm.ts', bulk('fetch("https://api.cohere.com/v2/chat");')),
    ]);
    expect(found.map((v) => v.ruleId)).not.toContain('no_direct_provider_call');
  });
});

describe('balanced_delimiters', () => {
  it('reports an unclosed brace with its line', () => {
    const [violation] = runRules([
      file('src/a.ts', 'function go() {\n  return 1;\n'),
    ]).filter((v) => v.ruleId === 'balanced_delimiters');
    expect(violation?.line).toBe(1);
    expect(violation?.message).toMatch(/Unclosed/);
  });

  it('ignores delimiters inside strings and comments', () => {
    const content = bulk('const s = "a { b [ c ("; // and a } here');
    expect(
      runRules([file('src/a.ts', content)]).map((v) => v.ruleId)
    ).not.toContain('balanced_delimiters');
  });
});

describe('valid_json', () => {
  it('rejects malformed json', () => {
    const found = runRules([file('package.json', '{ "name": }', 'json')]);
    expect(found.map((v) => v.ruleId)).toContain('valid_json');
  });
});

describe('call sites share the registry', () => {
  // The point of the port: read-logs and finalize-generation cannot disagree
  // about what counts as a defect any more.
  const truncated = [file('src/app.ts', bulk('// ... rest of file'))];

  // collectLogs also runs project-level checks the registry cannot express
  // (entry point, manifest, resolvable imports), and those report before the
  // per-file findings. The fixture carries an entry point and a manifest so
  // this case isolates what it is actually about: that a registry finding
  // reaches the repair loop with its line number attached.
  const truncatedProject = [
    file('index.html', '<div id="root"></div>\n', 'html'),
    file('package.json', '{ "dependencies": {} }', 'json'),
    ...truncated,
  ];

  it('collectLogs surfaces registry findings with line numbers', () => {
    const logs = collectLogs(truncatedProject);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.message).toMatch(/^line \d+: /);
  });

  it('formatViolations renders path:line: message', () => {
    expect(formatViolations(runRules(truncated))[0]).toMatch(
      /^src\/app\.ts:\d+: /
    );
  });

  it('reports no files generated', () => {
    expect(collectLogs([])).toEqual([
      { path: '(project)', message: 'No files were generated' },
    ]);
  });
});
