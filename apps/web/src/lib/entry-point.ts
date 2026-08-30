/**
 * What counts as a mountable entry point for a generated project.
 *
 * There is exactly one definition because three places need the same answer and
 * disagreeing about it produces a silent failure rather than an error:
 *
 *   - `durable-objects/sandbox-preview.ts` decides what `<script>` tag (if any)
 *     the fallback index.html points at;
 *   - `pipeline/tools/read-logs.ts` rejects a Coder iteration that produced
 *     nothing to mount, so the error-feedback loop gets a chance to fix it;
 *   - `pipeline/finalize-generation.ts` warns the founder when a run reaches
 *     "deployed" without one anyway.
 *
 * Measured in production 2026-08-28: a run whose Coder emitted
 * `src/pages/TimerPage.jsx`, `src/components/*.jsx`, `src/context/TimerContext.js`,
 * `src/styles/*.module.css` and `package.json` — six plausible files, no
 * index.html and no src/main.jsx. The fallback stub rendered `<div id="root">`
 * with no script, the preview ping got its HTTP 200, and the run was marked
 * `deployed`. Every automated check passed and the founder got a blank page.
 * A missing entry point has to be an error somewhere, so it is an error here.
 */
import type { ProjectFile } from '@bicameral/shared/types';

/**
 * Module entry points Vite will boot from when the fallback index.html supplies
 * the `<script type="module">`. Only root-level and `src/`-level, because the
 * stub has to guess the path and a nested one is not guessable.
 */
export const ENTRY_MODULE_PATTERN = /^(src\/)?(main|index)\.[jt]sx?$/;

/** Strips the leading `./` some models emit, so path comparison is stable. */
export function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, '');
}

export type EntryPoint =
  | { kind: 'html'; path: string }
  | { kind: 'module'; path: string };

/**
 * Returns the file the preview will actually boot from, or null if the set has
 * none. An `index.html` at the project root wins: Vite serves it directly and
 * whatever it references, so the stub is not involved at all.
 */
export function findEntryPoint(files: ProjectFile[]): EntryPoint | null {
  const html = files.find((f) => normalizeFilePath(f.path) === 'index.html');
  if (html) return { kind: 'html', path: normalizeFilePath(html.path) };

  const mod = files.find((f) =>
    ENTRY_MODULE_PATTERN.test(normalizeFilePath(f.path))
  );
  if (mod) return { kind: 'module', path: normalizeFilePath(mod.path) };

  return null;
}

/**
 * The message handed to the Coder when its output has no entry point. Phrased
 * as an instruction rather than a diagnosis because it is fed straight back
 * into the conversation as the next turn's user content.
 */
export const MISSING_ENTRY_POINT_MESSAGE =
  'No entry point. The preview boots by serving "index.html" from the project ' +
  'root, so the file set must contain either (a) an "index.html" at the root ' +
  'that loads the app, or (b) a root-level or "src/"-level entry module named ' +
  'main or index (main.jsx, main.tsx, src/main.jsx, src/index.js, …) that ' +
  'mounts the app into <div id="root">. Component and page files alone render ' +
  'a blank page. Add the entry point and return the COMPLETE file set again.';
