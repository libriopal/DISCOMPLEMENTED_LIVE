/**
 * Shared finalization: write the `generations` row, verify generated files,
 * start a container-backed preview sandbox, ping the generated route to
 * confirm it serves content, and mark the pipeline run `deployed` only
 * when both asset generation AND live preview routing are confirmed.
 *
 * DIRECTIVE (Aug 21 2026):
 *   a) Asset generation — files exist, non-empty, major modules >1KB.
 *   b) Live container preview — Sandbox DO started, dev server confirmed
 *      running, AND the generated route returns a valid HTTP response.
 *   deployment_url is set ONLY after verifying a valid status response.
 *   If preview fails, the run is still marked "deployed" (files are stored
 *   in the generations row and can be served via R2), but deployment_url
 *   stays null with a warning explaining the failure.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import { findEntryPoint, normalizeFilePath } from '../lib/entry-point.js';
import { isModulePath } from '../lib/preview-runtime.js';
import { formatViolations, runRules } from './rules/index.js';
import { SANDBOX_CONTROL_ORIGIN } from '../durable-objects/sandbox-preview.js';

// The stub-size floor and the major-extension list moved into pipeline/rules.
// They were declared here at 1024 bytes and in tools/read-logs.ts at 500 — a
// third way the two copies had drifted. The registry now carries the 1024 this
// file used, and tools/read-logs.ts gates the repair loop on the same value, so
// the warning here and the gate there can no longer disagree.
// POST /start now blocks until the container's dev server actually answers on
// its port (Sandbox.waitForDevServer, up to 60s) rather than returning the
// moment the process is spawned, so the start timeout has to cover a cold Vite
// boot. At 15s this aborted mid-boot and the failure surfaced downstream as a
// ping error against a container that was still starting.
const PREVIEW_START_TIMEOUT_MS = 90_000;
const PREVIEW_PING_TIMEOUT_MS = 10_000;
const PREVIEW_PING_RETRIES = 5;
const PREVIEW_PING_RETRY_DELAY_MS = 3000;
/** Per-module timeout for the sweep in step 4. */
const PREVIEW_MODULE_TIMEOUT_MS = 10_000;
/** Modules fetched concurrently by the sweep. */
const PREVIEW_MODULE_CONCURRENCY = 4;
/** Broken modules named in the error before it says "and N more". */
const PREVIEW_MODULE_REPORT_LIMIT = 3;

export interface FinalizeGenerationInput {
  pipelineRunId: string;
  projectId: string | null;
  userId: string;
  prompt: string;
  model: string;
  files: ProjectFile[];
  tokensIn: number;
  tokensOut: number;
  warning: string | null;
}

export interface FinalizeResult {
  deployed: boolean;
  previewUrl: string | null;
  warnings: string[];
}

/**
 * Validates that generated files are real implementations, not stubs.
 * Returns an array of warning strings (empty if all good).
 *
 * Delegates to the shared rule registry (pipeline/rules). This function used
 * to carry its own copy of the stub checks with a narrower pattern than
 * tools/read-logs.ts — it never matched `stub` or `not implemented`, so a run
 * could finish "clean" on files the repair loop would have rejected. Same
 * detection now feeds both; the difference stays where it belongs, in
 * severity: errors there drive repair, warnings here annotate a finished run.
 */
function validateFiles(files: ProjectFile[]): string[] {
  if (!files || files.length === 0) {
    return ['No files were generated'];
  }
  const warnings: string[] = [];

  // Last line of defence, and project-level rather than per-file, so it stays
  // here instead of moving into the registry. read-logs.ts already rejects this
  // inside the Coder's error loop, but a run that exhausts maxCoderIterations
  // still arrives here with success:false and gets finalized anyway. Without
  // this the founder is shown a preview URL that returns HTTP 200 and renders
  // nothing.
  if (!findEntryPoint(files)) {
    warnings.push(
      'No entry point (index.html or a main/index module) — the preview will not render the app'
    );
  }

  warnings.push(...formatViolations(runRules(files)));

  return warnings;
}

/**
 * Starts a container-backed preview sandbox and pings the generated route
 * to verify it serves content. Returns the preview URL only if all checks pass.
 *
 * Verification sequence:
 *   1. POST /start — start the container with generated files
 *   2. GET /status — confirm container is running AND dev server started
 *   3. GET / (proxied to dev server) — confirm the generated app responds
 *   4. GET every generated module — confirm each one actually transforms
 *
 * Step 4 exists because steps 1-3 all passed on a run that shipped a blank
 * page (production, 2026-08-28). Vite serves index.html happily and does not
 * touch a module until something requests it, so a file that fails to
 * transform — a bad import, CommonJS in an ES module — is invisible to a root
 * ping and fatal to every module that imported it. Requesting the root proves
 * the server is up; requesting each module is what proves the app is.
 */
export interface BrokenModule {
  path: string;
  status: string;
}

/**
 * Requests every generated module through the dev server and reports the ones
 * it will not serve.
 *
 * Only modules: index.html is already covered by the root ping, and a CSS file
 * that fails to transform degrades the look rather than blanking the page.
 * A transform failure surfaces as HTTP 500 — Vite's error page — so anything
 * outside 2xx counts, and so does a request that never comes back.
 */
export async function sweepModules(
  sandbox: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
  files: ProjectFile[]
): Promise<BrokenModule[]> {
  const paths = files
    .map((f) => normalizeFilePath(f.path))
    .filter((p) => isModulePath(p));

  const broken: BrokenModule[] = [];

  // Batched rather than one Promise.all over the whole set: a large file set
  // would otherwise open every subrequest at once against a single container.
  for (let i = 0; i < paths.length; i += PREVIEW_MODULE_CONCURRENCY) {
    const batch = paths.slice(i, i + PREVIEW_MODULE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          const res = await sandbox.fetch(`https://sandbox/${path}`, {
            signal: AbortSignal.timeout(PREVIEW_MODULE_TIMEOUT_MS),
          });
          return res.ok ? null : { path, status: `HTTP ${res.status}` };
        } catch (err) {
          return {
            path,
            status: err instanceof Error ? err.message : 'fetch failed',
          };
        }
      })
    );
    for (const result of results) {
      if (result) broken.push(result);
    }
  }

  return broken;
}

async function startAndVerifyContainerPreview(
  env: Env,
  projectId: string,
  files: ProjectFile[]
): Promise<{ url: string | null; error: string | null }> {
  if (!projectId) {
    return { url: null, error: 'No project ID — cannot start preview' };
  }

  try {
    const sandboxId = env.PREVIEW_SANDBOX.idFromName(projectId);
    const sandbox = env.PREVIEW_SANDBOX.get(sandboxId);

    // --- 1. Start the container ---
    const startResponse = await sandbox.fetch(
      `${SANDBOX_CONTROL_ORIGIN}/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(PREVIEW_START_TIMEOUT_MS),
      }
    );

    if (!startResponse.ok) {
      const error = await startResponse.text();
      return { url: null, error: `Sandbox start failed: ${error}` };
    }

    // --- 2. Verify container status ---
    const statusResponse = await sandbox.fetch(
      `${SANDBOX_CONTROL_ORIGIN}/status`
    );
    const status = await statusResponse.json<{
      running: boolean;
      devServerStarted: boolean;
    }>();

    if (!status.running) {
      return { url: null, error: 'Container started but not running' };
    }

    if (!status.devServerStarted) {
      // Dev server might still be booting — wait and retry status
      await new Promise((r) => setTimeout(r, 3000));
      const retryStatus = await sandbox.fetch(
        `${SANDBOX_CONTROL_ORIGIN}/status`
      );
      const retryStatusData = await retryStatus.json<{
        running: boolean;
        devServerStarted: boolean;
      }>();
      if (!retryStatusData.devServerStarted) {
        return {
          url: null,
          error: 'Container running but dev server not started',
        };
      }
    }

    // --- 3. Ping the generated route (proxied through Sandbox DO) ---
    // The Sandbox DO proxies any non-/start, /status, /destroy request
    // to the container's dev server. We fetch the root path and check
    // for a valid HTTP response (200-399).
    let pingOk = false;
    let lastPingError = '';

    for (let attempt = 0; attempt < PREVIEW_PING_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, PREVIEW_PING_RETRY_DELAY_MS));
      }

      try {
        const pingResponse = await sandbox.fetch('https://sandbox/', {
          signal: AbortSignal.timeout(PREVIEW_PING_TIMEOUT_MS),
        });

        if (
          pingResponse.ok ||
          (pingResponse.status >= 200 && pingResponse.status < 400)
        ) {
          pingOk = true;
          break;
        } else {
          lastPingError = `HTTP ${pingResponse.status}`;
        }
      } catch (err) {
        lastPingError = err instanceof Error ? err.message : 'fetch failed';
      }
    }

    if (!pingOk) {
      return {
        url: null,
        error: `Preview route ping failed after ${PREVIEW_PING_RETRIES} attempts: ${lastPingError}`,
      };
    }

    // --- 4. Fetch every generated module through the dev server ---
    const broken = await sweepModules(sandbox, files);
    if (broken.length > 0) {
      const named = broken
        .slice(0, PREVIEW_MODULE_REPORT_LIMIT)
        .map((m) => `${m.path} (${m.status})`)
        .join(', ');
      const rest =
        broken.length > PREVIEW_MODULE_REPORT_LIMIT
          ? ` and ${broken.length - PREVIEW_MODULE_REPORT_LIMIT} more`
          : '';
      return {
        url: null,
        error: `${broken.length} generated module(s) failed to load: ${named}${rest}. The app will not render.`,
      };
    }

    // All four checks passed — set the deployment URL
    const previewUrl = `/api/preview/${projectId}/proxy/`;

    return { url: previewUrl, error: null };
  } catch (err) {
    return {
      url: null,
      error: err instanceof Error ? err.message : 'Unknown preview error',
    };
  }
}

export async function finalizeGeneration(
  env: Env,
  input: FinalizeGenerationInput
): Promise<FinalizeResult> {
  const now = new Date().toISOString();
  const warnings: string[] = [];

  if (input.warning) {
    warnings.push(input.warning);
  }

  // --- 1. Validate generated files ---
  const fileWarnings = validateFiles(input.files);
  warnings.push(...fileWarnings);

  // --- 2. Start container preview and verify the route responds ---
  let previewUrl: string | null = null;
  const previewResult = await startAndVerifyContainerPreview(
    env,
    input.projectId ?? input.pipelineRunId,
    input.files
  );

  if (previewResult.url) {
    previewUrl = previewResult.url;
  } else if (previewResult.error) {
    warnings.push(`Preview unavailable: ${previewResult.error}`);
  }

  // --- 3. Write the generations row ---
  await env.DB.prepare(
    `INSERT INTO generations (id, project_id, user_id, pipeline_run_id, prompt, model_used, files, status, credits_used, tokens_in, tokens_out, created_date, updated_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, 'system')`
  )
    .bind(
      crypto.randomUUID(),
      input.projectId,
      input.userId,
      input.pipelineRunId,
      input.prompt,
      input.model,
      JSON.stringify(input.files),
      input.tokensIn,
      input.tokensOut,
      now,
      now
    )
    .run();

  // --- 4. Mark pipeline run as deployed ---
  // deployment_url is set ONLY if the container preview was verified.
  const warningText = warnings.length > 0 ? warnings.join('; ') : null;

  await env.DB.prepare(
    `UPDATE pipeline_runs
     SET status = 'deployed',
         error_message = ?,
         deployment_url = ?,
         completed_at = ?,
         updated_date = ?
     WHERE id = ?`
  )
    .bind(warningText, previewUrl, now, now, input.pipelineRunId)
    .run();

  return {
    deployed: true,
    previewUrl,
    warnings,
  };
}

/**
 * Legacy compat wrapper for callers that only have db (no env).
 * Falls back to the old behavior (no preview verification).
 */
export async function finalizeGenerationLegacy(
  db: D1Database,
  input: FinalizeGenerationInput
): Promise<void> {
  console.warn(
    'finalizeGenerationLegacy called without env — container preview will not be started'
  );
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO generations (id, project_id, user_id, pipeline_run_id, prompt, model_used, files, status, credits_used, tokens_in, tokens_out, created_date, updated_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, 'system')`
    )
    .bind(
      crypto.randomUUID(),
      input.projectId,
      input.userId,
      input.pipelineRunId,
      input.prompt,
      input.model,
      JSON.stringify(input.files),
      input.tokensIn,
      input.tokensOut,
      now,
      now
    )
    .run();

  await db
    .prepare(
      "UPDATE pipeline_runs SET status = 'deployed', error_message = ?, completed_at = ?, updated_date = ? WHERE id = ?"
    )
    .bind(input.warning, now, now, input.pipelineRunId)
    .run();
}
