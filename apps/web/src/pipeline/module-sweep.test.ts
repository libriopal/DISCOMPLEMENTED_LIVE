/**
 * Step 4 of the preview verification: request every generated module.
 *
 * Steps 1-3 (start, status, root ping) all passed on the run that shipped a
 * blank page — Vite does not touch a module until something asks for it, so a
 * module that fails to transform is invisible to a root ping. These tests pin
 * that the sweep asks for each one and reports the failures.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import { sweepModules } from './finalize-generation.js';

function file(path: string) {
  return { path, content: 'x', language: 'javascript' } as ProjectFile;
}

function sandboxServing(statuses: Record<string, number>) {
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\//, '');
    const status = statuses[path] ?? 200;
    return { ok: status >= 200 && status < 300, status } as Response;
  });
  return { sandbox: { fetch }, fetch };
}

describe('sweepModules', () => {
  it('reports the module that 500s and leaves the healthy ones alone', async () => {
    const { sandbox } = sandboxServing({
      'src/utils/markdownParser.js': 500,
    });

    const broken = await sweepModules(sandbox, [
      file('src/main.jsx'),
      file('src/components/NotePreview.jsx'),
      file('src/utils/markdownParser.js'),
    ]);

    expect(broken).toEqual([
      { path: 'src/utils/markdownParser.js', status: 'HTTP 500' },
    ]);
  });

  it('returns nothing when every module transforms', async () => {
    const { sandbox } = sandboxServing({});
    const broken = await sweepModules(sandbox, [
      file('src/main.jsx'),
      file('src/pages/NotesPage.jsx'),
    ]);
    expect(broken).toEqual([]);
  });

  it('requests modules only — not index.html or css', async () => {
    const { sandbox, fetch } = sandboxServing({});

    await sweepModules(sandbox, [
      file('src/main.jsx'),
      { ...file('index.html'), path: 'index.html' },
      { ...file('src/styles/global.css'), path: 'src/styles/global.css' },
      { ...file('package.json'), path: 'package.json' },
    ]);

    const requested = fetch.mock.calls.map((c) =>
      new URL(c[0] as string).pathname.replace(/^\//, '')
    );
    expect(requested).toEqual(['src/main.jsx']);
  });

  it('normalises a ./-prefixed path before requesting it', async () => {
    const { sandbox, fetch } = sandboxServing({});
    await sweepModules(sandbox, [{ ...file('x'), path: './src/main.jsx' }]);
    expect(new URL(fetch.mock.calls[0][0] as string).pathname).toBe(
      '/src/main.jsx'
    );
  });

  it('counts a request that throws as broken rather than passing', async () => {
    const sandbox = {
      fetch: vi.fn(async () => {
        throw new Error('timed out');
      }),
    };

    const broken = await sweepModules(sandbox, [file('src/main.jsx')]);

    expect(broken).toEqual([{ path: 'src/main.jsx', status: 'timed out' }]);
  });

  it('sweeps a set larger than one concurrency batch', async () => {
    const paths = Array.from({ length: 11 }, (_, i) => `src/m${i}.js`);
    const { sandbox, fetch } = sandboxServing({ 'src/m9.js': 500 });

    const broken = await sweepModules(sandbox, paths.map(file));

    expect(fetch).toHaveBeenCalledTimes(11);
    expect(broken).toEqual([{ path: 'src/m9.js', status: 'HTTP 500' }]);
  });
});
