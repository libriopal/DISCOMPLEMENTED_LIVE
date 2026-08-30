/**
 * The documents Tier 1 (Babel) and Tier 2 (esbuild) render into the preview
 * iframe.
 *
 * These were inline template literals in PreviewFrame.tsx, which meant the
 * only way to check them was to render a React component and read an iframe.
 * They are here for the same reason the Tier 3 judgements are in
 * sandbox-health.ts: the tier's health is decided by this string, so this
 * string is the thing a test has to be able to hold.
 *
 * §3.2 requirement 8 asks each tier to be health-checked for real. Tier 3's
 * version is an HTTP request to a generated route. Tiers 1 and 2 have no
 * server to request from — they evaluate a bundle in the browser — so the
 * equivalent question is whether the bundle evaluated *and mounted something*,
 * and the document has to answer it out loud.
 *
 * Two failures previously went unreported:
 *
 *   1. The esbuild document had no `else` on `if (Component)`. A bundle that
 *      evaluated cleanly but exported nothing renderable produced a blank
 *      iframe, no message to the parent, and a preview the platform believed
 *      was fine. (The Babel document wrote a sentence into `#root`, which the
 *      founder could see but the platform still could not.)
 *   2. Nothing checked the result of `render`. A component that throws during
 *      render is caught by React, not by the surrounding `try`, so the root
 *      stays empty and the catch never fires.
 *
 * Both now post a message. `blank` is deliberately a different kind from
 * `error`: nothing threw, and calling it an error would put a red banner on a
 * preview whose only crime is rendering nothing yet.
 */

export const PREVIEW_MESSAGE_SOURCE = 'bicameral-preview';

/** How long to wait after `render` before deciding the root is empty.
 *
 * React 19 schedules work rather than rendering synchronously, so an immediate
 * check reports every app blank. This is long enough for a synchronous first
 * paint and short enough that the founder is not left looking at nothing; it
 * is not long enough for an app that fetches before it renders, which is why
 * the message it produces says "has not rendered anything yet" rather than
 * asserting the app is broken. */
export const MOUNT_CHECK_DELAY_MS = 400;

export const REACT_CDN = 'https://esm.sh/react@19';
export const REACT_DOM_CDN = 'https://esm.sh/react-dom@19/client';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Makes a JavaScript source safe to inline inside a `<script>` element.
 *
 * An HTML parser ends a script at the first `</script`, wherever it appears —
 * including inside a JavaScript string literal. Generated code is model
 * output, and a note-taking app or a docs tool writing that sequence into a
 * template is not exotic. The result was the rest of the bundle being parsed
 * as HTML: no error, no message, a blank preview.
 *
 * `<\/script` is the standard escape and is a no-op everywhere it can legally
 * appear in JavaScript — in a string `'\/' === '/'`, in a regex `\/` matches a
 * slash, and in a comment it is text.
 */
export function escapeScriptClose(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Reports what happened, from inside the iframe.
 *
 * Sent unconditionally — a preview that says nothing is indistinguishable from
 * one that has not loaded, and the parent has no other way to tell.
 */
const REPORTER = `
  function __report(type, message) {
    parent.postMessage({ source: '${PREVIEW_MESSAGE_SOURCE}', type: type, message: message }, '*');
  }`;

const ERROR_BRIDGE = `
<script>
${REPORTER}
  window.onerror = function (message) { __report('error', String(message)); };
  window.addEventListener('unhandledrejection', function (event) {
    __report('error', String(event.reason));
  });
</script>`;

/**
 * The render-and-check tail shared by both tiers.
 *
 * `Component` is resolved the way it always was — a default export, or a
 * top-level `App` — because that is what the Coder agent is told to emit.
 */
const RENDER_AND_CHECK = `
      const __root = document.getElementById('root');
      const Component = (typeof exports !== 'undefined' && exports.default) || (typeof App !== 'undefined' ? App : null);
      if (!Component) {
        __report('error', 'The code ran, but exported nothing to render. The preview expects a default export or a top-level App component.');
      } else {
        createRoot(__root).render(React.createElement(Component));
        setTimeout(function () {
          if (__root.children.length === 0) {
            __report('blank', 'The app mounted but has not rendered anything yet. If this does not change, the root component is returning nothing.');
          } else {
            __report('mounted', '');
          }
        }, ${MOUNT_CHECK_DELAY_MS});
      }`;

/** Tier 1: a single file, already transformed by Babel. */
export function buildBabelSrcDoc(transformedCode: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <div id="root"></div>
    ${ERROR_BRIDGE}
    <script type="importmap">{"imports":{"react":"${REACT_CDN}","react-dom/client":"${REACT_DOM_CDN}"}}</script>
    <script type="module">
${REPORTER}
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      window.React = React;
      try {
${escapeScriptClose(transformedCode)}
${RENDER_AND_CHECK}
      } catch (err) {
        __report('error', String(err));
      }
    </script>
  </body>
</html>`;
}

/** Tier 2: the whole project, bundled by esbuild-wasm. */
export function buildEsbuildSrcDoc(bundledCode: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <div id="root"></div>
    ${ERROR_BRIDGE}
    <script type="module">
${REPORTER}
      import React from '${REACT_CDN}';
      import { createRoot } from '${REACT_DOM_CDN}';
      window.React = React;
      try {
${escapeScriptClose(bundledCode)}
${RENDER_AND_CHECK}
      } catch (err) {
        __report('error', String(err));
      }
    </script>
  </body>
</html>`;
}

/**
 * The document shown when the code never compiled — a Babel throw, or esbuild
 * returning errors.
 *
 * The message is escaped as HTML because it is displayed, and it is displayed
 * rather than only posted because a compile error the founder cannot read is
 * not much better than a blank page. It still posts, so the platform records
 * it too.
 */
export function buildCompileErrorSrcDoc(message: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    ${ERROR_BRIDGE}
    <script>__report('error', ${JSON.stringify(message).replace(/</g, '\\u003c')});</script>
    <pre style="color:#c0362c;padding:16px;white-space:pre-wrap;font:12px ui-monospace,monospace;">${escapeHtml(message)}</pre>
  </body>
</html>`;
}
