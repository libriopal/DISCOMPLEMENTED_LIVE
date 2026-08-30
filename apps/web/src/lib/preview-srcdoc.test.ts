/**
 * The Tier 1 and Tier 2 preview documents.
 *
 * §3.2 item 10 asks for a test per tier that fails when the tier breaks. Tier
 * 3's lives in tests/integration/preview-health.test.ts and talks to the real
 * DO. These two tiers have no server, so what breaks is the document itself:
 * an escape that lets generated code end the script tag, or a failure path
 * that reports nothing and leaves the platform believing a blank iframe is a
 * working preview.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBabelSrcDoc,
  buildCompileErrorSrcDoc,
  buildEsbuildSrcDoc,
  escapeScriptClose,
  MOUNT_CHECK_DELAY_MS,
  PREVIEW_MESSAGE_SOURCE,
} from './preview-srcdoc.js';

const BUILDERS = {
  babel: buildBabelSrcDoc,
  esbuild: buildEsbuildSrcDoc,
} as const;

describe.each(Object.entries(BUILDERS))('the %s document', (_tier, build) => {
  const doc = build('const App = () => null; exports.default = App;');

  it('carries the error bridge', () => {
    expect(doc).toContain('window.onerror');
    expect(doc).toContain('unhandledrejection');
    expect(doc).toContain(PREVIEW_MESSAGE_SOURCE);
  });

  it('reports when the code exports nothing renderable', () => {
    // The esbuild document had no `else` here: a bundle that evaluated but
    // exported nothing produced a blank iframe, no message, and a preview the
    // platform believed was fine.
    expect(doc).toMatch(/if \(!Component\)/);
    expect(doc).toContain('exported nothing to render');
  });

  it('checks the root after rendering, not only that render was called', () => {
    // React catches a throw during render, so the surrounding try/catch never
    // fires and the root simply stays empty.
    expect(doc).toContain('__root.children.length === 0');
    expect(doc).toContain(`}, ${MOUNT_CHECK_DELAY_MS});`);
  });

  it('reports a successful mount, so silence is distinguishable from success', () => {
    expect(doc).toContain("__report('mounted'");
    expect(doc).toContain("__report('blank'");
  });

  it('does not let generated code end the script tag', () => {
    // Model output containing this sequence — a docs tool, a note app, a
    // template literal — used to be parsed as HTML from that point on: no
    // error, no message, a blank preview.
    const hostile = build('const s = "</script><h1>escaped</h1>";');
    expect(hostile).not.toContain('</script><h1>');
    expect(hostile).toContain('<\\/script>');
  });

  it('has exactly one root for the mount check to inspect', () => {
    expect(doc.match(/id="root"/g)).toHaveLength(1);
  });
});

describe('escapeScriptClose', () => {
  it('neutralises every case-variant of the closing tag', () => {
    expect(escapeScriptClose('a</SCRIPT>b')).toBe('a<\\/SCRIPT>b');
    expect(escapeScriptClose('a</ScRiPt >b')).toBe('a<\\/ScRiPt >b');
  });

  it('leaves ordinary code alone', () => {
    // The escape must not touch comparisons or arrow functions, or it would
    // corrupt the bundle it exists to protect.
    const code = 'const f = (a, b) => a < b; const g = x => x / 2;';
    expect(escapeScriptClose(code)).toBe(code);
  });

  it('is semantically a no-op in a JavaScript string', () => {
    // `'\\/' === '/'`, which is why this escape is safe to apply blindly.
    expect(eval(escapeScriptClose('"</script>"'))).toBe('</script>');
  });
});

describe('the compile-error document', () => {
  it('shows the message and reports it', () => {
    const doc = buildCompileErrorSrcDoc('Unexpected token (3:11)');
    expect(doc).toContain('Unexpected token (3:11)');
    expect(doc).toContain("__report('error'");
  });

  it('escapes a message that is itself markup', () => {
    // esbuild and Babel quote the offending source in their errors, so the
    // message routinely contains JSX.
    const doc = buildCompileErrorSrcDoc('unexpected <div> in </script> at 1:0');
    expect(doc).not.toContain('<div>');
    expect(doc).toContain('&lt;div&gt;');
    // And in the posted copy, which is inside a script element rather than
    // rendered as HTML.
    expect(doc).not.toMatch(/__report\('error', "[^"]*<\/script>/);
    expect(doc).toContain('\\u003c/script>');
  });
});
