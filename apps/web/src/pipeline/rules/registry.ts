/**
 * The rules themselves. See ./types.ts for why these are pure functions.
 *
 * Ordered cheapest-first within each file, matching Controller-C's
 * pipelineValidator: a rule that scans for a literal runs before one that
 * parses. The runner short-circuits nothing per-file (a file can violate
 * several rules and the model repairs better seeing all of them at once), but
 * the caller short-circuits the expensive CI layers on any violation at all.
 */

import type { ProjectFile } from '@bicameral/shared/types';
import {
  isModulePath,
  REQUIRE_MESSAGE,
  REQUIRE_PATTERN,
  usesRequire,
} from '../../lib/preview-runtime.js';
import type { Rule, Violation } from './types.js';
import { lineAt } from './types.js';

/**
 * Below this, a module claiming to implement a feature is a stub.
 *
 * This threshold has to match `MIN_MAJOR_MODULE_BYTES` in
 * pipeline/finalize-generation.ts. The two used to disagree — 500 here, 1024
 * there — so a file between the thresholds passed the Coder's repair loop and
 * then produced a "may be a stub" warning on the finished run, which is the
 * worst place to learn about it: the loop that could have fixed it had already
 * exited. Raise or lower both.
 */
const MIN_IMPL_BYTES = 1024;

/** Extensions that count as major modules for the size heuristic. */
const MAJOR_EXTENSIONS = ['.jsx', '.tsx', '.ts', '.js'];

const isMajorModule = (path: string): boolean =>
  MAJOR_EXTENSIONS.some((ext) => path.endsWith(ext));

const BRACE_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'css',
  'json',
  'java',
  'c',
  'cpp',
  'go',
  'rust',
]);

/**
 * Elisions the model writes when it runs out of output budget. The Coder's
 * system prompt forbids these, which is exactly why they need detecting:
 * a forbidden-but-emitted marker is the signature of a truncated generation,
 * and the file it appears in is missing code the user asked for.
 *
 * Neither previous validator looked for these at all.
 */
const TRUNCATION_MARKERS: RegExp[] = [
  /\/\/\s*\.\.\.\s*(rest|remainder|the rest|remaining|other|previous|existing)\b/i,
  /\/\*\s*\.\.\.\s*(rest|remainder|the rest|remaining|other|previous|existing)\b/i,
  /\{\s*\/\*\s*\.\.\.\s*\*\/\s*\}/,
  /^\s*\/\/\s*\.\.\.\s*$/m,
  /\b(unchanged|as before|same as above)\s*\)?\s*(\*\/|$)/im,
  /<!--\s*\.\.\.\s*(rest|remaining)/i,
];

const STUB_MARKERS: RegExp[] = [
  /\/\/\s*(TODO|FIXME|Implement|placeholder|stub|not implemented)/i,
  /\/\*\s*(TODO|FIXME|Implement|placeholder|stub|not implemented)/i,
  /\bthrow\s+new\s+Error\(\s*['"`]Not implemented/i,
  /\breturn\s+null\s*;\s*\/\/\s*TODO/i,
];

/**
 * Credential shapes worth failing on inside a *generated* app. The pipeline
 * never has cause to write a real key into a user's project, so any match is
 * either a leaked live credential or a fake one the user will ship believing
 * it works. Both are defects.
 */
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: 'OpenAI key', re: /\bsk-(?!ant-)[A-Za-z0-9]{32,}/ },
  { label: 'Stripe secret key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    label: 'generic bearer secret',
    re: /["']?(api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/i,
  },
];

/**
 * Provider endpoints a generated frontend must never call directly — doing so
 * requires shipping a key to the browser. This mirrors the invariant asserted
 * for our own client bundle in tests/security/client-bundle.test.ts, applied
 * to the code we hand users.
 */
const PROVIDER_HOSTS = [
  'api.cohere.com',
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'api.you.com',
];

function scan(
  file: ProjectFile,
  patterns: readonly RegExp[],
  build: (match: RegExpExecArray) => string,
  ruleId: Violation['ruleId']
): Violation[] {
  const found: Violation[] = [];
  for (const re of patterns) {
    const match = re.exec(file.content);
    if (match !== null) {
      found.push({
        ruleId,
        path: file.path,
        message: build(match),
        line: lineAt(file.content, match.index),
      });
      break; // one finding per rule per file — the model fixes the class, not the instance
    }
  }
  return found;
}

export const RULES: readonly Rule[] = [
  {
    id: 'no_empty_file',
    description: 'A generated file must have content',
    check: (file) =>
      file.content.trim().length === 0
        ? [
            {
              ruleId: 'no_empty_file',
              path: file.path,
              message: 'File is empty',
              line: null,
            },
          ]
        : [],
  },
  {
    id: 'no_truncation_marker',
    description: 'Elision markers mean the file was cut short, not finished',
    check: (file) =>
      scan(
        file,
        TRUNCATION_MARKERS,
        (m) =>
          `Truncation marker ${JSON.stringify(m[0].trim().slice(0, 48))} — the file is incomplete. Emit the whole file with no elisions.`,
        'no_truncation_marker'
      ),
  },
  {
    id: 'no_placeholder_stub',
    description: 'Placeholder comments mean unimplemented behaviour',
    check: (file) =>
      scan(
        file,
        STUB_MARKERS,
        (m) =>
          `Placeholder ${JSON.stringify(m[0].trim().slice(0, 48))} — replace with a real implementation.`,
        'no_placeholder_stub'
      ),
  },
  {
    id: 'no_inlined_secret',
    description: 'Generated projects must never contain credentials',
    check: (file) => {
      for (const { label, re } of SECRET_PATTERNS) {
        const match = re.exec(file.content);
        if (match !== null) {
          return [
            {
              ruleId: 'no_inlined_secret',
              path: file.path,
              message: `Possible ${label} inlined — read it from an environment variable instead.`,
              line: lineAt(file.content, match.index),
            },
          ];
        }
      }
      return [];
    },
  },
  {
    id: 'no_direct_provider_call',
    description: 'A browser must not call an LLM provider directly',
    check: (file) => {
      // Server files legitimately talk to providers; only frontend assets and
      // anything under a client/ or public/ path are constrained.
      const clientSide =
        file.path.endsWith('.html') ||
        /(^|\/)(public|client|static|assets)\//.test(file.path) ||
        (isMajorModule(file.path) &&
          !/(^|\/)(server|api|worker|functions)\//.test(file.path));
      if (!clientSide) return [];

      for (const host of PROVIDER_HOSTS) {
        const index = file.content.indexOf(host);
        if (index !== -1) {
          return [
            {
              ruleId: 'no_direct_provider_call',
              path: file.path,
              message: `Client-side code contacts ${host} directly, which requires shipping a key to the browser. Proxy it through a server route.`,
              line: lineAt(file.content, index),
            },
          ];
        }
      }
      return [];
    },
  },
  {
    id: 'no_stub_sized_module',
    description: 'A major module below the size floor is a stub',
    check: (file) => {
      if (!isMajorModule(file.path)) return [];
      const size = file.content.length;
      if (size >= MIN_IMPL_BYTES || size === 0) return []; // empty is no_empty_file's finding
      return [
        {
          ruleId: 'no_stub_sized_module',
          path: file.path,
          message: `Only ${size} bytes (floor ${MIN_IMPL_BYTES}) — add the functions, state, handlers and exports this module needs.`,
          line: null,
        },
      ];
    },
  },
  {
    id: 'balanced_delimiters',
    description: 'Braces, brackets and parens must balance',
    check: (file) => {
      if (!BRACE_LANGUAGES.has(file.language)) return [];
      const error = checkBalanced(file.content);
      return error === null
        ? []
        : [
            {
              ruleId: 'balanced_delimiters',
              path: file.path,
              message: error.message,
              line: error.line,
            },
          ];
    },
  },
  {
    id: 'valid_json',
    description: 'JSON files must parse',
    check: (file) => {
      if (file.language !== 'json' && !file.path.endsWith('.json')) return [];
      try {
        JSON.parse(file.content);
        return [];
      } catch (err) {
        return [
          {
            ruleId: 'valid_json',
            path: file.path,
            message: `Invalid JSON: ${(err as Error).message}`,
            line: null,
          },
        ];
      }
    },
  },
  {
    id: 'no_require_in_module',
    description: 'A file served as an ES module cannot use require()',
    check: (file) => {
      if (!isModulePath(file.path) || !usesRequire(file.content)) return [];
      const index = file.content.search(REQUIRE_PATTERN);
      return [
        {
          ruleId: 'no_require_in_module',
          path: file.path,
          message: REQUIRE_MESSAGE,
          line: index === -1 ? null : lineAt(file.content, index),
        },
      ];
    },
  },
];

/**
 * Delimiter balance, skipping strings and comments so that a brace inside a
 * string literal is not counted. Reports the line of the first unmatched
 * opener rather than only that a mismatch exists.
 */
function checkBalanced(
  content: string
): { message: string; line: number } | null {
  const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const CLOSERS = new Set(Object.values(PAIRS));
  const stack: Array<{ char: string; index: number }> = [];

  let i = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;

  while (i < content.length) {
    const ch = content[i] as string;
    const next = content[i + 1];

    if (comment === 'line') {
      if (ch === '\n') comment = null;
      i += 1;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        comment = null;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      comment = 'line';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      comment = 'block';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }

    if (PAIRS[ch] !== undefined) {
      stack.push({ char: ch, index: i });
    } else if (CLOSERS.has(ch)) {
      const open = stack.pop();
      if (open === undefined) {
        return {
          message: `Unmatched closing "${ch}"`,
          line: lineAt(content, i),
        };
      }
      if (PAIRS[open.char] !== ch) {
        return {
          message: `Expected "${PAIRS[open.char]}" to close "${open.char}" but found "${ch}"`,
          line: lineAt(content, i),
        };
      }
    }
    i += 1;
  }

  const unclosed = stack[0];
  if (unclosed !== undefined) {
    return {
      message: `Unclosed "${unclosed.char}" — the file may have been cut short`,
      line: lineAt(content, unclosed.index),
    };
  }
  return null;
}
