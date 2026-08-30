/**
 * Dependency and module-format rules for the offline preview.
 *
 * The regression case is the note-taking run of 2026-08-28: ten files, all
 * over the stub threshold, both entry points present, no package.json, and a
 * `src/utils/markdownParser.js` that imported markdown-it and called require().
 * `collectLogs` returned zero errors, the run deployed, and the page was blank.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@bicameral/shared/types';
import {
  extractImports,
  findDisallowedImports,
  isBareSpecifier,
  isModulePath,
  packageRoot,
  usesRequire,
} from './preview-runtime.js';
import { collectLogs } from '../pipeline/tools/read-logs.js';

function file(path: string, content: string, language = 'javascript') {
  return { path, content, language } as ProjectFile;
}

/** Padding to clear the 1024-byte stub threshold without adding imports. */
const bulk = (label: string) =>
  `\n// ${label} — real implementation body, kept above MIN_IMPL_BYTES`.repeat(
    20
  );

describe('extractImports', () => {
  it('finds every form Vite follows', () => {
    const found = extractImports(`
import React from 'react';
import { useState } from "react";
import './styles.css';
export { thing } from './thing.js';
const lazy = await import('markdown-it');
`);
    expect(found).toContain('react');
    expect(found).toContain('./styles.css');
    expect(found).toContain('./thing.js');
    expect(found).toContain('markdown-it');
  });
});

describe('isBareSpecifier', () => {
  it('separates packages from paths and URLs', () => {
    expect(isBareSpecifier('react')).toBe(true);
    expect(isBareSpecifier('@scope/pkg')).toBe(true);
    expect(isBareSpecifier('./local.js')).toBe(false);
    expect(isBareSpecifier('../up.js')).toBe(false);
    expect(isBareSpecifier('/abs.js')).toBe(false);
    expect(isBareSpecifier('https://cdn.example.com/x.js')).toBe(false);
  });
});

describe('packageRoot', () => {
  it('reduces a specifier to what npm would install', () => {
    expect(packageRoot('react-dom/client')).toBe('react-dom');
    expect(packageRoot('@scope/pkg/sub/path')).toBe('@scope/pkg');
    expect(packageRoot('lodash')).toBe('lodash');
  });
});

describe('findDisallowedImports', () => {
  it('allows react and react-dom subpaths', () => {
    const files = [
      file(
        'src/main.jsx',
        `import React from 'react';\nimport { createRoot } from 'react-dom/client';`
      ),
    ];
    expect(findDisallowedImports(files)).toEqual([]);
  });

  it('flags the packages the run actually reached for', () => {
    const files = [
      file(
        'src/utils/markdownParser.js',
        `import MarkdownIt from 'markdown-it';\nimport hljs from 'highlight.js';`
      ),
    ];
    const roots = findDisallowedImports(files).map((e) => e.root);
    expect(roots).toEqual(['markdown-it', 'highlight.js']);
  });

  it('ignores relative imports and non-module files', () => {
    const files = [
      file('src/main.jsx', `import NotesPage from './pages/NotesPage';`),
      file('src/styles/global.css', `@import 'nope';`, 'css'),
    ];
    expect(findDisallowedImports(files)).toEqual([]);
  });
});

describe('usesRequire', () => {
  it('catches a require call', () => {
    expect(usesRequire(`md.use(require('markdown-it-footnote'))`)).toBe(true);
    expect(usesRequire(`const x = require("y");`)).toBe(true);
  });

  it('does not fire on a method named require or on prose', () => {
    expect(usesRequire(`config.require('x')`)).toBe(false);
    expect(usesRequire(`// these fields require('quotes') in the docs`)).toBe(
      true
    ); // over-reporting inside a comment is deliberate — costs one retry
    expect(usesRequire(`const required = true;`)).toBe(false);
  });
});

describe('isModulePath', () => {
  it('covers the extensions Vite transforms as modules', () => {
    for (const p of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cjs']) {
      expect(isModulePath(p)).toBe(true);
    }
    for (const p of ['index.html', 'styles.css', 'package.json']) {
      expect(isModulePath(p)).toBe(false);
    }
  });
});

describe('collectLogs — dependency rules', () => {
  const goodManifest = file(
    'package.json',
    JSON.stringify(
      {
        name: 'notes',
        version: '1.0.0',
        type: 'module',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      },
      null,
      2
    ),
    'json'
  );

  const goodMain = file(
    'src/main.jsx',
    `import React from 'react';\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<div />);${bulk('main')}`
  );

  const indexHtml = file(
    'index.html',
    `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
    'html'
  );

  it('replays the run that shipped a blank page', () => {
    const errors = collectLogs([
      indexHtml,
      goodMain,
      file(
        'src/utils/markdownParser.js',
        `import MarkdownIt from 'markdown-it';\nconst md = new MarkdownIt().use(require('markdown-it-footnote'));\nexport default (c) => md.render(c);${bulk('parser')}`
      ),
    ]);
    const messages = errors.map((e) => e.message).join('\n');

    // No package.json at all — the run had none.
    expect(messages).toContain('No package.json');
    // The unresolvable imports, named.
    expect(messages).toContain('markdown-it');
    // The require() that Vite blamed on JSX.
    expect(messages).toContain('require()');
    // And the run's own verdict is now the opposite of fixed.
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes a set that only uses what the image provides', () => {
    expect(collectLogs([indexHtml, goodMain, goodManifest])).toEqual([]);
  });

  // This block used to assert the opposite: that declaring markdown-it was
  // itself an error, because nothing installed anything. There is a bounded
  // install phase now (durable-objects/sandbox-install.ts), so a declared
  // registry dependency really is installed and rejecting it would be
  // rejecting correct work.
  it('accepts a dependency that is declared and installable', () => {
    const manifest = file(
      'package.json',
      JSON.stringify({
        name: 'notes',
        type: 'module',
        dependencies: {
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          'markdown-it': '^14.0.0',
        },
      }),
      'json'
    );
    const parser = file(
      'src/parser.js',
      `import MarkdownIt from 'markdown-it';\nconst md = new MarkdownIt();\nexport default (c) => md.render(c);${bulk('parser')}`
    );
    expect(collectLogs([indexHtml, goodMain, manifest, parser])).toEqual([]);
  });

  it('rejects an import that package.json never declared', () => {
    const parser = file(
      'src/parser.js',
      `import MarkdownIt from 'markdown-it';\nexport default MarkdownIt;${bulk('parser')}`
    );
    const messages = collectLogs([
      indexHtml,
      goodMain,
      goodManifest,
      parser,
    ]).map((e) => e.message);
    expect(messages.some((m) => m.includes('markdown-it'))).toBe(true);
    expect(messages.some((m) => m.includes('Add "markdown-it"'))).toBe(true);
  });

  it('rejects a dependency the install phase would drop, and says why', () => {
    const manifest = file(
      'package.json',
      JSON.stringify({
        name: 'notes',
        type: 'module',
        dependencies: {
          react: '^19.0.0',
          'markdown-it': 'git+https://github.com/attacker/markdown-it.git',
        },
      }),
      'json'
    );
    const messages = collectLogs([indexHtml, goodMain, manifest]).map(
      (e) => e.message
    );
    expect(messages.some((m) => m.includes('"markdown-it"'))).toBe(true);
    expect(
      messages.some((m) => m.includes('not a registry version range'))
    ).toBe(true);
  });

  it('lets a server entry import Node builtins without the node: prefix', () => {
    const manifest = file(
      'package.json',
      JSON.stringify({
        name: 'notes',
        type: 'module',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      }),
      'json'
    );
    const server = file(
      'server.js',
      `import http from 'http';\nimport { DatabaseSync } from 'node:sqlite';\nhttp.createServer(() => {}).listen(Number(process.env.PORT), '0.0.0.0');${bulk('server')}`
    );
    expect(collectLogs([indexHtml, goodMain, manifest, server])).toEqual([]);
  });

  it('still flags a bare Node builtin imported from a browser module', () => {
    // Vite cannot resolve it there, and the module that imported it never
    // loads — the same blank page, from a different mistake.
    const bad = file(
      'src/store.js',
      `import fs from 'fs';\nexport default fs;${bulk('store')}`
    );
    const messages = collectLogs([indexHtml, goodMain, goodManifest, bad]).map(
      (e) => e.message
    );
    expect(messages.some((m) => m.includes('Imports "fs"'))).toBe(true);
  });

  it('reports a package.json that is not valid JSON, whatever its language tag', () => {
    const manifest = file('package.json', '{ "name": notes }', 'javascript');
    const messages = collectLogs([indexHtml, goodMain, manifest]).map(
      (e) => e.message
    );
    expect(messages.some((m) => m.startsWith('Invalid JSON'))).toBe(true);
  });

  it('accepts a manifest written as ./package.json', () => {
    const manifest = { ...goodManifest, path: './package.json' } as ProjectFile;
    expect(collectLogs([indexHtml, goodMain, manifest])).toEqual([]);
  });
});
