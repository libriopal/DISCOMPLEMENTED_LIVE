/**
 * Regression tests for the entry-point contract.
 *
 * The case that motivated all of this is `rejects the file set that shipped
 * blank` below — a production run on 2026-08-28 that passed every check in the
 * Coder's error loop, passed the preview ping, was marked `deployed`, and
 * rendered nothing.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import { findEntryPoint, MISSING_ENTRY_POINT_MESSAGE } from './entry-point.js';
import { collectLogs } from '../pipeline/tools/read-logs.js';

const file = (path: string, content = 'x'): ProjectFile => ({
  path,
  content,
  language: 'text',
});

describe('findEntryPoint()', () => {
  it('prefers a root index.html over an entry module', () => {
    expect(findEntryPoint([file('src/main.jsx'), file('index.html')])).toEqual({
      kind: 'html',
      path: 'index.html',
    });
  });

  it('normalises the leading ./ some models emit', () => {
    expect(findEntryPoint([file('./index.html')])?.kind).toBe('html');
    expect(findEntryPoint([file('./src/main.jsx')])?.kind).toBe('module');
  });

  it('accepts root- and src-level main/index modules', () => {
    for (const path of [
      'main.jsx',
      'main.tsx',
      'index.js',
      'src/main.jsx',
      'src/index.ts',
    ]) {
      expect(findEntryPoint([file(path)])).toEqual({ kind: 'module', path });
    }
  });

  it('rejects a nested path that only looks like an entry', () => {
    // Nothing loads src/pages/index.jsx — the fallback stub can only guess a
    // root- or src-level path, so a deeper one is not an entry point.
    expect(findEntryPoint([file('src/pages/index.jsx')])).toBeNull();
    expect(findEntryPoint([file('app/main.tsx')])).toBeNull();
  });

  it('rejects a set of components with nothing to mount them', () => {
    expect(
      findEntryPoint([file('src/App.jsx'), file('src/components/Button.jsx')])
    ).toBeNull();
  });
});

describe("collectLogs() — the Coder's entry-point gate", () => {
  it('rejects the file set that shipped blank', () => {
    const shipped = [
      'src/pages/TimerPage.jsx',
      'src/components/TimerDisplay.jsx',
      'src/components/ControlButtons.jsx',
      'src/context/TimerContext.js',
      'src/styles/TimerStyles.module.css',
      'package.json',
    ].map((p) => file(p, 'a'.repeat(2000)));

    const messages = collectLogs(shipped).map((e) => e.message);
    expect(messages).toContain(MISSING_ENTRY_POINT_MESSAGE);
  });

  it('passes a set that has an entry point', () => {
    const ok = [
      file('index.html', 'a'.repeat(2000)),
      file('src/App.jsx', 'a'.repeat(2000)),
    ];
    expect(collectLogs(ok).map((e) => e.message)).not.toContain(
      MISSING_ENTRY_POINT_MESSAGE
    );
  });

  it('flags a major module under the shared 1KB threshold', () => {
    // The same threshold finalize-generation warns at; they used to disagree,
    // so a 724-byte file passed here and was flagged after the loop had exited.
    const logs = collectLogs([
      file('src/main.jsx', 'a'.repeat(2000)),
      file('src/components/TimerDisplay.jsx', 'a'.repeat(740)),
    ]);
    expect(logs.some((e) => e.message.includes('740 bytes'))).toBe(true);
  });
});
