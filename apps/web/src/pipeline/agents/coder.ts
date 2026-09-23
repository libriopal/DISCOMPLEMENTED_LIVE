/**
 * Agent 4 — Coder (Architecture Implemented). Free-first model routing
 * (North Mini Code -> R7B -> Command A) implementing the error feedback
 * loop that's the "secret sauce" of AI app builders: write files -> run
 * preview -> collect errors -> feed them back -> repeat, up to
 * PIPELINE_DEFAULTS.maxCoderIterations. See @agent_docs/autonomous-dev-team.md
 * "Error Feedback Loop". Uses tools/write-file.ts (R2), tools/run-preview.ts
 * + tools/read-logs.ts (static validation today, real preview tiers once
 * Phase 6 lands — the interface doesn't change).
 */
import { z } from 'zod';
import { GenerationError } from '@bicameral/shared/errors';
import { PIPELINE_DEFAULTS } from '@bicameral/shared/constants';
import type {
  ProjectFile,
  SystemBlueprint,
  SubscriptionTier,
} from '@bicameral/shared';
import type { ChatMessage } from '@bicameral/cohere/chat';
import {
  callAgentModel,
  selectModel,
  type PipelineComplexity,
} from '../../lib/cohere.js';
import { writeFiles } from '../tools/write-file.js';
import { runPreview, type PreviewTier } from '../tools/run-preview.js';
import { recordToolInvocation, withToolRecord } from '../../lib/tool-record.js';
import {
  findSimilarPatterns,
  formatSimilarPatterns,
} from '../lattice-enrich.js';
import { runSubconscious } from '../subconscious.js';
import type { Env } from '../../env.js';

export const CODER_SYSTEM = `You are the Code agent in a software development team.
You receive a complete system blueprint and (after the first attempt) a list
of errors from the previous attempt. Write COMPLETE, FUNCTIONAL file contents
needed to implement the blueprint.

CRITICAL RULES — READ CAREFULLY:
0. ENTRY POINT (non-negotiable): the file set MUST be runnable as-is. It must
   contain either an "index.html" at the project root, or an entry module at
   "main.jsx" / "index.jsx" / "src/main.jsx" / "src/index.jsx" (.js/.ts/.tsx
   also accepted) that mounts the app into <div id="root">. Nested paths like
   "src/pages/App.jsx" do NOT count — nothing will load them. A set of
   components and pages with no entry point renders a blank page and will be
   rejected. If you write React, write the entry module that calls
   createRoot(document.getElementById('root')).render(<App />).

0b. DEPENDENCIES: ship a "package.json" at the root with name, version,
   "type": "module", and a "dependencies" object listing EVERY package you
   import. That list is what gets installed — a package you import without
   declaring it there will not resolve, and the module that imported it, plus
   everything importing that, renders a blank page.
   Rules for the list:
   - react, react-dom and vite are already present. Declare them anyway; they
     are recognised and skipped.
   - At most 24 dependencies. Beyond that the extras are dropped.
   - Registry packages and normal semver ranges ONLY ("^5.0.0", "1.2.3",
     "latest", "*"). A git URL, a "github:" shorthand, a tarball URL or a
     "file:" path in the version field is REFUSED — the preview installs from
     the npm registry and nowhere else.
   - Install runs with --ignore-scripts. A package whose usefulness depends on
     a postinstall step (native builds, binary downloads) will install but not
     work. Prefer pure-JS packages.
   - devDependencies are NOT installed. The preview runs the app; it does not
     run your tests or your linter.
   Prefer writing a small helper yourself over pulling a package for one
   function — every dependency is install time the founder waits through.

0bb. BACKEND (only when the blueprint has apiRoutes): write the server as
   "server.js" at the project root. Nothing else is started — "app.js",
   "backend/index.js" or a route file with no listener is a file sitting on
   disk, and every API call 503s.
   The server MUST:
   - listen on Number(process.env.PORT) and bind host "0.0.0.0". A hard-coded
     port, or the default localhost bind, is unreachable from outside the
     container and looks exactly like a crashed server.
   - use only Node's built-in modules (node:http, node:sqlite, node:crypto,
     node:fs) unless the package is declared under 0b. node:sqlite is built
     into Node 22 and is the right choice for persistence — there is no
     external database.
   - serve every path the blueprint's apiRoutes name, and answer an unknown
     path with 404 JSON rather than hanging.
   The frontend calls those paths with relative URLs ("/api/items"), never an
   absolute one — it is served from the same origin.

0c. ES MODULES ONLY: never write require(). Every file is served as an ES
   module. A single require() call fails the whole file, and Vite reports it as
   a misleading "invalid JS syntax — rename to .jsx" error. Use import.

1. CONSOLIDATE: Do NOT generate more than 3-4 files. Merge small utility files,
   config files, and helper modules into larger files. For most web apps, a
   SINGLE self-contained index.html with inline CSS and JavaScript is best.
   For apps with a backend, generate at most 3 files: index.html (frontend),
   server.js (backend), and styles.css (if needed).

2. FULL IMPLEMENTATIONS: Every file must contain complete, working code.
   A React component must include all imports, the full function with all
   state/handlers/effects, JSX, and exports. A game file must include ALL
   game logic — rendering, input, scoring, levels, game over, restart.
   Do NOT write stubs, placeholders, TODOs, or empty function bodies.

3. SELF-CONTAINED: Each file must be independently runnable. If you generate
   index.html, it must include <html>, <head>, <body>, <style>, <script> tags
   with ALL the app logic inline. The file should work if saved and opened
   in a browser directly.

4. SIZE MATTERS: Each code file (.js/.jsx/.ts/.tsx) must be at least 1024
   bytes — package.json and other manifests are exempt, do not pad them. If a file would be
   smaller, merge it into another file. A real game implementation is typically
   2000-5000 bytes. A real React component is typically 1000-3000 bytes.

5. FOR GAMES specifically: Generate ONE index.html file containing:
   - All game state (score, level, board, pieces)
   - All game logic (piece movement, collision, matching, clearing)
   - All rendering (canvas or DOM-based)
   - All input handling (keyboard, mouse, touch)
   - All UI (start screen, game board, game over screen, score display)
   - CSS styling (responsive, animations)
   The game must be fully playable — start, play, score, lose, restart.

Respond with ONLY a JSON object matching this exact shape (no prose, no markdown fences):
{
  "summary": string,
  "files": [{ "path": string, "content": string, "language": string }]
}`;

const coderOutputSchema = z.object({
  summary: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        language: z.string().default('typescript'),
      })
    )
    // An empty array parses fine and then fails silently three steps later, in
    // finalize-generation, as "No files were generated" on a run already marked
    // deployed. Reject it where the model can still be told about it.
    .min(1, 'files must contain at least one file'),
});

export interface CoderIterationResult {
  iteration: number;
  files: ProjectFile[];
  errors: string[];
  fixed: boolean;
  tier: PreviewTier;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface CoderRunResult {
  success: boolean;
  files: ProjectFile[];
  iterations: CoderIterationResult[];
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface CoderOptions {
  bucket: R2Bucket;
  pipelineRunId: string;
  projectId?: string | null;
  tier?: SubscriptionTier;
  onIteration?: (result: CoderIterationResult) => Promise<void> | void;
  /** Findings fed back from a prior GitHub Actions security-gate scan (see
   * pipeline/tools/security-scan-gh.ts and GenerationOrchestrator's
   * security-gate retry path) — threaded in as if they were the previous
   * iteration's preview errors, so the model fixes them the same way. */
  initialErrors?: string[];
}

export async function runCoder(
  blueprint: SystemBlueprint,
  complexity: PipelineComplexity,
  env: Env,
  opts: CoderOptions
): Promise<CoderRunResult> {
  const model = selectModel('coder', complexity, opts.tier);
  const iterations: CoderIterationResult[] = [];
  let priorErrors: string[] = opts.initialErrors ?? [];
  let lastFiles: ProjectFile[] = [];

  // Retrieved once, not per-iteration — the blueprint doesn't change
  // between iterations, only priorErrors does.
  const similar = await findSimilarPatterns(
    env,
    opts.projectId ?? null,
    JSON.stringify(blueprint).slice(0, 2000),
    'code'
  );
  // Full subconscious: Rerank + intuition layer
  const subconscious = await runSubconscious({
    query: JSON.stringify(blueprint).slice(0, 2000),
    patterns: similar,
    agentRole: 'coder',
    tier: opts.tier ?? 'free',
    env,
  });
  const similarBlock =
    subconscious.contextBlock ||
    formatSimilarPatterns(similar, 'Similar past implementations');

  // Full conversation history, not a fresh 2-message request per iteration —
  // Cohere Labs' model card for North Mini Code says thinking/reasoning
  // content from one turn should be "retained and passed along in the
  // conversation history" on later turns for best agentic performance
  // (verified 2026-08-12). Each retry now appends the model's own prior
  // response (including its thinking block, if any) before the next
  // error-report turn, instead of re-deriving a one-shot prompt from
  // scratch each time.
  const conversation: ChatMessage[] = [
    { role: 'system', content: CODER_SYSTEM },
  ];

  for (
    let iteration = 1;
    iteration <= PIPELINE_DEFAULTS.maxCoderIterations;
    iteration++
  ) {
    const userContent =
      iteration === 1
        ? JSON.stringify(blueprint) + similarBlock
        : `Previous attempt's errors — fix these:\n${priorErrors.join('\n')}`;
    conversation.push({ role: 'user', content: userContent });

    const response = await callAgentModel(
      'coder',
      complexity,
      {
        messages: conversation,
        responseFormat: { type: 'json_object' },
        temperature: 0.2,
        maxTokens: 8192, // Enough for 5 multi-file output (was 4096, only generated 1 file)
      },
      env,
      opts.tier
    );

    conversation.push({
      role: 'assistant',
      content: response.data.message.content,
      thinking: response.data.message.thinking,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.data.message.content);
    } catch {
      // Carry the evidence. This threw bare for a long time, and a run that
      // died here (production, 2026-08-28) left nothing to distinguish a model
      // that emitted prose from one that was cut off mid-JSON — the two have
      // different fixes. finishReason 'max_tokens' means raise maxTokens or
      // push harder on rule 1 (CONSOLIDATE); 'complete' with no leading '{'
      // means the model ignored the response format.
      throw new GenerationError(
        `Coder returned invalid JSON (finishReason=${response.data.finishReason}, ` +
          `${response.data.message.content.length} bytes): ` +
          truncate(response.data.message.content, 300),
        'CODER_INVALID_JSON'
      );
    }

    const result = coderOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new GenerationError(
        `Coder output failed validation: ${result.error.message}`,
        'CODER_INVALID_SCHEMA'
      );
    }

    const files = result.data.files;
    await withToolRecord(
      env.DB,
      opts.pipelineRunId,
      {
        agent: 'coder',
        tool: 'write-file',
        detail: { iteration, paths: files.map((f) => f.path) },
      },
      () => writeFiles(opts.bucket, opts.pipelineRunId, files),
      () =>
        `Wrote ${files.length} file${files.length === 1 ? '' : 's'} to storage (iteration ${iteration}).`
    );
    const preview = runPreview(files, complexity);
    await recordToolInvocation(env.DB, opts.pipelineRunId, {
      agent: 'coder',
      tool: 'run-preview',
      summary: preview.success
        ? `Preview built on the ${preview.tier} tier with no errors (iteration ${iteration}).`
        : `Preview built on the ${preview.tier} tier with ${preview.errors.length} error${preview.errors.length === 1 ? '' : 's'} (iteration ${iteration}).`,
      detail: {
        iteration,
        tier: preview.tier,
        success: preview.success,
        errors: preview.errors,
      },
    });

    const iterationResult: CoderIterationResult = {
      iteration,
      files,
      errors: preview.errors,
      fixed: preview.success,
      tier: preview.tier,
      tokensIn: response.data.usage.inputTokens,
      tokensOut: response.data.usage.outputTokens,
      model,
    };
    iterations.push(iterationResult);
    lastFiles = files;
    if (opts.onIteration) await opts.onIteration(iterationResult);

    // Functional correctness only — the security gate (Semgrep via GitHub
    // Actions) runs once, after this loop returns success, orchestrated by
    // GenerationOrchestrator.runCoderStep rather than per-iteration here:
    // it can't block a Worker request for the ~1-2 minutes a workflow run
    // takes, so it dispatches and waits for a webhook callback instead. If
    // that scan finds issues, GenerationOrchestrator re-invokes runCoder
    // with the findings as initialErrors (see CoderOptions), so this loop
    // does still see security fixes — just across separate invocations.
    if (preview.success) {
      const totals = totalTokens(iterations);
      return {
        success: true,
        files,
        iterations,
        model,
        ...totals,
      };
    }
    priorErrors = preview.errors;
  }

  // Max iterations reached — return what we have, marked partial.
  const totals = totalTokens(iterations);
  return { success: false, files: lastFiles, iterations, model, ...totals };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

function totalTokens(iterations: CoderIterationResult[]): {
  totalTokensIn: number;
  totalTokensOut: number;
} {
  return {
    totalTokensIn: iterations.reduce((sum, i) => sum + i.tokensIn, 0),
    totalTokensOut: iterations.reduce((sum, i) => sum + i.tokensOut, 0),
  };
}
