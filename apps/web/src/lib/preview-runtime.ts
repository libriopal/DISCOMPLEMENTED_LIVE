/**
 * What a generated project is allowed to import, and how to find out what it
 * actually imported.
 *
 * The preview container is built from `Dockerfile.preview` and still starts
 * with `enableInternet: false` (durable-objects/Sandbox.ts). What changed is
 * that there is now a bounded install phase before any generated code runs, so
 * `package.json` is no longer a statement of intent — a declared registry
 * dependency really is installed. See durable-objects/sandbox-install.ts for
 * what qualifies and durable-objects/sandbox-egress.ts for why the window is
 * safe.
 *
 * This module therefore checks a different thing than it used to. It used to
 * ask "is this one of the four packages in the image?"; it now asks "did the
 * project declare this, in a form that will actually install?". An undeclared
 * import is still a blank page, and that is still the failure worth catching.
 *
 * Measured in production 2026-08-28: a note-taking app whose Coder emitted
 * `src/utils/markdownParser.js` importing markdown-it, highlight.js and two
 * markdown-it plugins, with no package.json at all. Ten files, all over the
 * stub threshold, both entry points present, error loop reporting
 * `{"errors":[],"fixed":true}`. The preview root returned HTTP 200 and the run
 * was marked deployed; `/src/utils/markdownParser.js` returned HTTP 500, the
 * module that imported it never loaded, and the founder got a blank page.
 *
 * Keep AVAILABLE_PACKAGES in step with the `npm install` line in
 * Dockerfile.preview. Adding an entry here without adding it there produces
 * exactly the failure above.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import {
  declaredDependencies,
  PREINSTALLED_PACKAGES,
} from '../durable-objects/sandbox-install.js';
import { SERVER_ENTRY_CANDIDATES } from '../durable-objects/sandbox-backend.js';

/**
 * Package roots the preview image can resolve without installing anything.
 *
 * Derived from PREINSTALLED_PACKAGES rather than restated, because these two
 * lists drifting apart is the exact failure this module exists to catch. Both
 * still have to match the `npm install` line in Dockerfile.preview, which no
 * code can check from here.
 */
export const AVAILABLE_PACKAGES = new Set<string>(PREINSTALLED_PACKAGES);

/**
 * Node builtins a generated server may import without the `node:` prefix.
 *
 * Only honoured in a server entry file. The same bare `fs` in a browser module
 * is a real error — Vite cannot resolve it, and the module that imported it
 * never loads — so scoping this to the server is the difference between
 * allowing a legitimate backend and re-opening the blank page.
 */
const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'querystring',
  'sqlite',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'zlib',
]);

function isServerEntry(path: string): boolean {
  const normalized = path.replace(/^\.\//, '');
  return (SERVER_ENTRY_CANDIDATES as readonly string[]).includes(normalized);
}

const MODULE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

export function isModulePath(path: string): boolean {
  return MODULE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Import specifiers, from every form Vite's import analysis will follow:
 * static `import`/`export … from`, bare side-effect `import 'x'`, and dynamic
 * `import('x')`. Deliberately a regex and not a parser — this runs inside the
 * Coder's loop where a dependency-free pass is the whole point (read-logs.ts),
 * and over-reporting an import inside a comment costs one retry while
 * under-reporting costs a blank page.
 */
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+[^'"\n]*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+[^'"\n]*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function extractImports(content: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

/** True for a package import — not a relative path, absolute path, or URL. */
export function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(specifier)
  );
}

/**
 * The installable root of a specifier: `react-dom/client` → `react-dom`,
 * `@scope/pkg/sub` → `@scope/pkg`. What npm would have had to install.
 */
export function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export interface DisallowedImport {
  path: string;
  specifier: string;
  root: string;
  /** Why it will not resolve — the Coder needs this to fix it correctly. */
  reason: 'undeclared' | 'not-installable';
  /** Set when reason is 'not-installable': what sandbox-install.ts objected to. */
  detail?: string;
}

/**
 * Roots the preview will be able to resolve for this file set: the ones baked
 * into the image, plus the ones the install phase will actually fetch.
 *
 * `declaredDependencies` is the authority on the second half — the same
 * function the Sandbox runs — so a package this accepts is one that installs,
 * and a package it rejects is rejected here for the same stated reason.
 */
function resolvableRoots(files: ProjectFile[]): {
  roots: Set<string>;
  rejected: Map<string, string>;
} {
  const plan = declaredDependencies(files);
  const roots = new Set(AVAILABLE_PACKAGES);
  for (const spec of plan.specs) {
    // `name@range`, where name may itself start with '@'.
    const at = spec.lastIndexOf('@');
    roots.add(at > 0 ? spec.slice(0, at) : spec);
  }
  const rejected = new Map<string, string>();
  for (const entry of plan.skipped) rejected.set(entry.name, entry.reason);
  return { roots, rejected };
}

/** Every bare import in the file set that the preview will not resolve. */
export function findDisallowedImports(
  files: ProjectFile[]
): DisallowedImport[] {
  const found: DisallowedImport[] = [];
  const { roots, rejected } = resolvableRoots(files);

  for (const file of files) {
    if (!isModulePath(file.path) || !file.content) continue;
    const server = isServerEntry(file.path);

    for (const specifier of extractImports(file.content)) {
      if (!isBareSpecifier(specifier)) continue;
      const root = packageRoot(specifier);
      if (roots.has(root)) continue;
      if (server && NODE_BUILTINS.has(root)) continue;

      const detail = rejected.get(root);
      found.push({
        path: file.path,
        specifier,
        root,
        reason: detail ? 'not-installable' : 'undeclared',
        ...(detail ? { detail } : {}),
      });
    }
  }

  return found;
}

export function disallowedImportMessage(entry: DisallowedImport): string {
  if (entry.reason === 'not-installable') {
    return (
      `Imports "${entry.specifier}". "${entry.root}" is in package.json but ` +
      `will not install: ${entry.detail}. Fix the entry in dependencies, or ` +
      `remove the import and implement what you need yourself.`
    );
  }
  return (
    `Imports "${entry.specifier}", which nothing will install. The preview ` +
    `installs exactly what package.json's "dependencies" declares (plus ` +
    `${[...AVAILABLE_PACKAGES].sort().join(', ')}, which are already in the ` +
    `image). Add "${entry.root}" to dependencies with a normal semver range, ` +
    `or remove the import and write what you need yourself.`
  );
}

/**
 * CommonJS in a file Vite serves as an ES module.
 *
 * Vite's own diagnostic for this is actively misleading — it reports "content
 * contains invalid JS syntax. If you are using JSX, make sure to name the file
 * with the .jsx extension" for a `.js` file containing no JSX at all, which
 * sends the Coder off renaming files instead of removing the `require`.
 */
export const REQUIRE_PATTERN = /(?:^|[^.\w])require\s*\(\s*['"]/;

export function usesRequire(content: string): boolean {
  return REQUIRE_PATTERN.test(content);
}

export const REQUIRE_MESSAGE =
  'Uses require(), which is CommonJS. The preview serves every file as an ES ' +
  'module, and Vite fails the whole module — reporting a misleading "invalid ' +
  'JS syntax / rename to .jsx" error — when it sees one. Use ES import syntax ' +
  'at the top of the file instead.';

export const PACKAGE_JSON_PATH = 'package.json';

export const MISSING_PACKAGE_JSON_MESSAGE =
  'No package.json. Every project must ship one at the root declaring its ' +
  'name, version, "type": "module", and a dependencies object listing every ' +
  'package it imports — that list is what the preview installs, so an import ' +
  'missing from it will not resolve. Add it and return the COMPLETE file set ' +
  'again.';
