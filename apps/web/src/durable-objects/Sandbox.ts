/**
 * Sandbox — Tier 3 preview. One Cloudflare Container per project
 * (`idFromName(projectId)`), running Dockerfile.preview. Files are written
 * into the container via `exec` (there's no shared filesystem mount for
 * dynamically-generated code), then Vite is started as a long-running
 * background process whose combined output is written to a log file inside
 * the container and tailed by `GET /api/preview/:projectId/logs`. HTTP
 * requests to the live app proxy straight through
 * `container.getTcpPort(DEV_SERVER_PORT)` — see sandbox-preview.ts for why
 * that path is reserved for real traffic.
 *
 * Routed entirely over `fetch()` (not Workers RPC like LatticeManager)
 * because the proxy path fundamentally has to be a fetch — see routes/preview.ts.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ProjectFile } from '@bicameral/shared/types';
import type { Env } from '../env.js';
import {
  DEV_SERVER_PORT,
  buildDevServerCommand,
  buildFallbackIndexHtml,
  buildPortProbeArgs,
  buildWriteFileScript,
  DEV_SERVER_LOG,
  PREVIEW_ORIGIN,
  SANDBOX_CONTROL_ORIGIN,
  WORKDIR,
} from './sandbox-preview.js';
import {
  BACKEND_LOG,
  BACKEND_PORT,
  buildBackendCommand,
  buildContainerEnv,
  describeMissingBackend,
  findServerEntry,
  isBackendPath,
} from './sandbox-backend.js';
import {
  assertMayRunUserCode,
  assertTransition,
  type SandboxPhase,
} from './sandbox-egress.js';
import {
  chooseBackendProbePath,
  judgeBackendResponse,
  judgeFrontendResponse,
  summarize,
  unprobeable,
  PROBE_TIMEOUT_MS,
  type HealthReport,
  type ProbeResult,
} from './sandbox-health.js';
import {
  buildInstallCommand,
  declaredDependencies,
  INSTALL_TIMEOUT_MS,
} from './sandbox-install.js';
import {
  decideStart,
  fileSetSignature,
  type StartAction,
} from './sandbox-persistence.js';

const SAFE_PATH = /^[\w./-]+$/;
const START_RETRY_ATTEMPTS = 5;
const START_RETRY_DELAY_MS = 1500;
const PORT_READY_TIMEOUT_MS = 60_000;
const PORT_POLL_INTERVAL_MS = 1000;

/**
 * How long a container may sit idle before the platform reaps it.
 *
 * Not an optimisation. `max_instances` is a hard global ceiling, one container
 * per project via `idFromName(projectId)`, and nothing destroyed a container
 * that was merely abandoned — only an explicit DELETE did.
 *
 * Measured on the production account 2026-08-29: 8 instance records, every one
 * `inactive`, last touched the previous day, none reaped by anything. An
 * earlier revision of this comment read that as 70% of the product's worldwide
 * preview capacity consumed; that was wrong and is withdrawn. An `inactive`
 * record does not hold a slot, so no capacity was actually being held. What the
 * measurement does show is that abandonment had no reaper at all — the records
 * survived because nothing was looking for them, not because they were in use.
 * The ceiling is still real and still reachable by live containers; this
 * timeout is what keeps an abandoned one from being the container that gets
 * there.
 *
 * 15 minutes is longer than a founder spends reading one preview and far
 * shorter than a day. `setInactivityTimeout` is the platform's own reaper, so
 * it keeps working when this DO is evicted — which is exactly when a
 * DO-managed alarm would not.
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface SecurityFinding {
  path: string;
  line: number;
  ruleId: string;
  message: string;
  severity: string;
}

export class Sandbox extends DurableObject<Env> {
  private devProcess: ExecProcess | null = null;
  /** True only once port 5173 has actually answered — not merely once the
   * dev-server process has been spawned. See waitForDevServer(). */
  private devServerReady = false;

  private backendProcess: ExecProcess | null = null;
  private backendReady = false;
  /** Blueprint route paths, used to decide what to proxy to the backend. */
  private apiRoutePaths: string[] = [];

  /**
   * Egress phase. The single most security-relevant field in this class:
   * generated code may only be started once it reads `sealed`.
   *
   * Held in memory rather than in DO storage on purpose. If this object is
   * evicted the container goes with it, so a phase persisted across eviction
   * could only ever describe a container that no longer exists — and a stale
   * `sealed` is precisely the value that would let user code start without the
   * seal ever having been applied. Losing it means starting from `booting`,
   * which fails closed.
   */
  private phase: SandboxPhase = 'booting';

  /**
   * Identity of the file set the live container was booted from, so a repeat
   * start can tell "the founder reloaded the page" from "the founder has a new
   * build". See sandbox-persistence.ts.
   *
   * In memory for the same reason as `phase`: if this object is rebuilt while
   * its container survives, not knowing is the safe answer, and null decides
   * to rebuild rather than to serve a preview of files it cannot identify.
   */
  private fileSignature: string | null = null;

  /** What the most recent start actually did. Reported so the UI can say "kept
   * the running preview" rather than claiming to have started one. */
  private lastStartAction: StartAction = 'boot';

  /** Non-fatal problems worth showing the founder — a dependency that could
   * not be installed, a backend that was promised but never generated. */
  private warnings: string[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Control plane and preview traffic are separated by ORIGIN, not by
    // pathname. See SANDBOX_CONTROL_ORIGIN: a generated app is very likely to
    // define /status or /health, and matching those by pathname would answer
    // the founder's own route with this object's internals.
    if (url.origin !== SANDBOX_CONTROL_ORIGIN) {
      return this.proxy(request, url.pathname + url.search);
    }

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await request.json<{
        files: ProjectFile[];
        apiRoutePaths?: string[];
        envVars?: Record<string, string>;
        declaredEnvVars?: string[];
        projectId?: string;
      }>();
      try {
        await this.start(body);
        return Response.json({
          running: true,
          backendRunning: this.backendReady,
          // 'reuse' means this call started nothing — the preview the founder
          // already had is still the one they are looking at, which is what
          // makes its state survive a reload.
          startAction: this.lastStartAction,
          warnings: this.warnings,
        });
      } catch (err) {
        return Response.json(
          {
            running: false,
            error: err instanceof Error ? err.message : 'Start failed',
            warnings: this.warnings,
          },
          { status: 502 }
        );
      }
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      return Response.json({
        running: this.ctx.container?.running ?? false,
        devServerStarted: this.devServerReady,
        // Reported separately from devServerStarted so a full-stack app whose
        // backend died is distinguishable from one that never had a backend.
        // Collapsing them into a single "ready" is how an app with a dead API
        // came to look identical to a working frontend-only app.
        backendRunning: this.backendReady,
        phase: this.phase,
        warnings: this.warnings,
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(await this.health());
    }

    if (request.method === 'DELETE' && url.pathname === '/destroy') {
      await this.destroy();
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      const body = await request.json<{ files: ProjectFile[] }>();
      try {
        const findings = await this.scan(body.files);
        return Response.json({ findings });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : 'Scan failed' },
          { status: 502 }
        );
      }
    }

    if (request.method === 'GET' && url.pathname === '/logs') {
      return this.streamLogs();
    }

    // Addressed to the control origin but matching nothing. Previously this
    // fell through to the proxy, which is how `POST /destroy` from the admin
    // panel (the DO handles DELETE) was forwarded to the generated app and its
    // failure swallowed by the caller's `.catch(() => undefined)` — the
    // "kill sandbox" control destroyed nothing, quietly. A 404 here means a
    // wrong control call fails loudly instead.
    return Response.json(
      {
        error: `No sandbox control endpoint ${request.method} ${url.pathname}`,
      },
      { status: 404 }
    );
  }

  /**
   * Boots a preview, in phase order.
   *
   *   booting -> [installing ->] sealed -> running
   *
   * The ordering is the security property, not a convenience: dependencies are
   * fetched while no generated code is running, and generated code starts only
   * after egress has been closed again. `sandbox-egress.ts` holds the machine
   * and refuses every other ordering; this method is one of its callers, not
   * its author.
   */
  private async start(opts: {
    files: ProjectFile[];
    apiRoutePaths?: string[];
    envVars?: Record<string, string>;
    declaredEnvVars?: string[];
    projectId?: string;
  }): Promise<void> {
    const {
      files,
      apiRoutePaths = [],
      envVars = {},
      declaredEnvVars = [],
      projectId = 'unknown',
    } = opts;

    if (!this.ctx.container) {
      throw new Error(
        'Container binding unavailable — Sandbox requires the `containers` config in wrangler.toml'
      );
    }

    // Decided before anything is touched, because two of the three answers
    // mean not touching it. A reload must not re-boot a container that is
    // already serving the same app — that is the whole of §3.2 requirement 3,
    // and until now it did not merely lose the preview's state, it threw:
    // `setPhase` from the terminal `running` phase surfaced to the founder as
    // "Preview failed to start" over a preview that was working.
    const requestedSignature = await fileSetSignature({
      files,
      apiRoutePaths,
      envVars,
    });
    const decision = decideStart({
      containerRunning: this.ctx.container.running,
      phase: this.phase,
      currentSignature: this.fileSignature,
      requestedSignature,
    });

    if (decision.action === 'reuse') {
      // Keep `warnings` as they were: they describe the container that is
      // still running, and clearing them would make a degraded preview look
      // clean on the founder's next reload.
      await this.ctx.container.setInactivityTimeout(IDLE_TIMEOUT_MS);
      this.lastStartAction = 'reuse';
      return;
    }

    if (decision.action === 'reboot') {
      // A fresh container, not a re-run against the live one. `running` is
      // terminal in the egress machine on purpose: installing again underneath
      // executing code would reopen egress beneath it.
      await this.destroy();
    }

    this.lastStartAction = decision.action;
    this.warnings = [];
    this.apiRoutePaths = apiRoutePaths;
    if (decision.action === 'reboot') {
      this.warnings.push(decision.reason);
    }

    // The blueprint declares env var *names* (SystemBlueprint.envVars is
    // string[]); nothing in the platform stores values for them yet. Say so
    // rather than starting an app that will read undefined and fail somewhere
    // unrelated — a preview that quietly lacks its API key is exactly the
    // silent degradation this workstream exists to end.
    for (const name of declaredEnvVars) {
      if (!(name in envVars)) {
        this.warnings.push(
          `${name} is declared by the blueprint but has no value in this preview. ` +
            `Anything reading process.env.${name} will see undefined.`
        );
      }
    }

    // Built before the container starts so a rejected variable stops the boot
    // rather than being discovered after generated code is already running.
    const containerEnv = buildContainerEnv(
      envVars,
      this.platformSecretValues()
    );

    if (!this.ctx.container.running) {
      // enableInternet stays false, exactly as before. The install phase does
      // not change this flag — it installs an outbound handler, which is
      // additive and revocable. Flipping the flag would grant the container
      // unrestricted egress for its whole lifetime, which is the thing §3.2
      // explicitly rules out.
      this.ctx.container.start({ enableInternet: false, env: containerEnv });
    }

    // Ask the platform to reap this container if it is abandoned. Set on every
    // start rather than once, because a container that outlived its DO comes
    // back with no timeout configured.
    await this.ctx.container.setInactivityTimeout(IDLE_TIMEOUT_MS);

    for (const file of files) {
      await this.writeFile(file);
    }
    await this.ensureIndexHtml(files);

    await this.installDependencies(files, projectId);
    await this.seal(projectId);

    // Only past this line may anything execute what the model wrote.
    await this.startDevServer();
    await this.waitForDevServer();

    await this.startBackend(files, apiRoutePaths.length > 0);

    // Recorded only once the boot has completed. A signature written earlier
    // would let a start that failed halfway be mistaken for a live container
    // running these files, and the next reload would "reuse" a broken preview.
    this.fileSignature = requestedSignature;
    this.setPhase('running');
  }

  private setPhase(next: SandboxPhase): void {
    assertTransition(this.phase, next);
    this.phase = next;
  }

  /**
   * Every string the Worker's env holds, for buildContainerEnv's by-value
   * check.
   *
   * Reading the bindings here and passing only their *values* keeps
   * buildContainerEnv structurally unable to receive the env itself — it takes
   * a list of forbidden strings, not a source of them.
   */
  private platformSecretValues(): string[] {
    return Object.values(this.env as unknown as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string'
    );
  }

  /**
   * The install phase: registry reachable, read-only, no generated code
   * running.
   *
   * A project with nothing to install skips it entirely and goes straight to
   * sealed — there is no reason to open egress for an app that does not need
   * it, and most generated apps do not.
   */
  private async installDependencies(
    files: ProjectFile[],
    projectId: string
  ): Promise<void> {
    const plan = declaredDependencies(files);

    for (const { name, reason } of plan.skipped) {
      this.warnings.push(`Dependency "${name}" was not installed: ${reason}.`);
    }

    if (plan.specs.length === 0) return;

    this.setPhase('installing');
    await this.ctx.container!.interceptOutboundHttps(
      'registry.npmjs.org',
      this.egressHandler('installing', projectId)
    );

    const proc = await this.execWithRetry([
      'sh',
      '-c',
      buildInstallCommand(plan.specs, WORKDIR),
    ]);

    // Bounded. A hung install would otherwise hold the sandbox in the one
    // phase where the network is open for as long as npm kept retrying.
    const timedOut = Symbol('timeout');
    const outcome = await Promise.race([
      proc.exitCode,
      new Promise<typeof timedOut>((resolve) =>
        setTimeout(() => resolve(timedOut), INSTALL_TIMEOUT_MS)
      ),
    ]);

    if (outcome === timedOut) {
      proc.kill();
      this.warnings.push(
        `Dependency install timed out after ${INSTALL_TIMEOUT_MS / 1000}s and ` +
          `was stopped. The preview will start without those packages, so any ` +
          `import of them will fail.`
      );
      return;
    }

    if (outcome !== 0) {
      // Not fatal. A preview that comes up and reports a broken import is more
      // use to a founder than no preview and one line of npm error text.
      const output = (await this.readAll(proc)).trim().slice(-800);
      this.warnings.push(
        `Dependency install failed (exit ${outcome}). Imports of those ` +
          `packages will fail. npm said: ${output || '(no output)'}`
      );
    }
  }

  /**
   * Closes egress and proves it is closed before generated code runs.
   *
   * The seal is applied by *replacing* the handler with one whose props say
   * `sealed`, not by removing it: an absent handler on a `*` glob would let
   * the platform fall through to its own policy, whereas a handler that denies
   * is a decision this code makes and can be read in the logs.
   */
  private async seal(projectId: string): Promise<void> {
    await this.ctx.container!.interceptOutboundHttps(
      '*',
      this.egressHandler('sealed', projectId)
    );
    this.setPhase('sealed');
  }

  /**
   * An egress handler bound to a phase.
   *
   * `ctx.props` is set by this Worker and cannot be forged by the container
   * (the platform guarantees props come from someone authorised to deploy the
   * callee), so the phase a handler enforces is not something code inside the
   * sandbox can talk its way past.
   */
  private egressHandler(phase: SandboxPhase, projectId: string) {
    return this.ctx.exports.SandboxEgressProxy({
      props: { phase, projectId },
    });
  }

  /**
   * Starts the generated application's server process.
   *
   * The gap this closes: `preview-strategy.ts` selects this tier *because* the
   * blueprint has apiRoutes, on the stated grounds that server routes need a
   * real backend process — and then no backend process was ever started. The
   * Designer emitted the routes, the orchestrator persisted them, the Coder
   * wrote server.js, and the file sat on disk while Vite served the frontend
   * and every API call 404'd.
   */
  private async startBackend(
    files: ProjectFile[],
    hasApiRoutes: boolean
  ): Promise<void> {
    assertMayRunUserCode(this.phase);

    const missing = describeMissingBackend(files, hasApiRoutes);
    if (missing) {
      // Visible degradation (§3.2 req 9), not a silent frontend-only preview.
      this.warnings.push(missing);
      return;
    }

    const entry = findServerEntry(files);
    if (!entry) return; // frontend-only project; nothing promised, nothing missing

    this.backendProcess?.kill();
    this.backendReady = false;
    this.backendProcess = await this.execWithRetry([
      'sh',
      '-c',
      buildBackendCommand(entry, WORKDIR),
    ]);

    const bound = await this.waitForPort(BACKEND_PORT, this.backendProcess);
    if (bound) {
      this.backendReady = true;
      return;
    }

    // The frontend still comes up. A founder looking at their app needs to see
    // it and be told the API is down, not get a blank screen.
    this.warnings.push(
      `The backend (${entry}) did not start listening on port ${BACKEND_PORT}. ` +
        `The frontend is running but every API call will fail. Server output: ` +
        `${await this.tailLog(BACKEND_LOG)}`
    );
  }

  /** Writes the index.html stub, when the generated file set lacks one, so the
   * preview shows the app's own module error rather than an unexplained 404. */
  private async ensureIndexHtml(files: ProjectFile[]): Promise<void> {
    const content = buildFallbackIndexHtml(files);
    if (content === null) return;
    await this.writeFile({ path: 'index.html', content, language: 'html' });
  }

  private async execWithRetry(
    cmd: string[],
    options: ContainerExecOptions = {}
  ): Promise<ExecProcess> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < START_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.ctx.container!.exec(cmd, {
          stdout: 'pipe',
          stderr: 'combined',
          ...options,
        });
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) =>
          setTimeout(resolve, START_RETRY_DELAY_MS)
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Container exec failed after retries');
  }

  /** Content is piped over stdin rather than interpolated into the shell
   * command — path is still validated (SAFE_PATH) since it's embedded in
   * the command string, but content never touches shell parsing at all,
   * so there's no delimiter-collision or metacharacter concern to reason
   * about regardless of what the Coder agent generated. */
  private async writeFile(file: ProjectFile): Promise<void> {
    if (!SAFE_PATH.test(file.path)) {
      throw new Error(`Refusing to write unsafe path: ${file.path}`);
    }
    const proc = await this.execWithRetry(
      ['sh', '-c', buildWriteFileScript(file.path)],
      {
        stdin: 'pipe',
      }
    );
    if (!proc.stdin) {
      throw new Error(`No stdin available to write ${file.path}`);
    }
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(file.content));
    await writer.close();

    const exitCode = await proc.exitCode;
    if (exitCode !== 0) {
      throw new Error(`Failed to write ${file.path} (exit ${exitCode})`);
    }
  }

  /** Task 2 of the security-gate spec — runs Semgrep (security-audit +
   * owasp-top-ten, same free packs as the CI job in security.yml) inside
   * the sandbox container against the Coder's just-written files. Rule
   * packs are the local files baked in at image build time — the container
   * runs with enableInternet: false, so there's no registry fetch here. */
  private async scan(files: ProjectFile[]): Promise<SecurityFinding[]> {
    if (!this.ctx.container) {
      throw new Error(
        'Container binding unavailable — Sandbox requires the `containers` config in wrangler.toml'
      );
    }
    if (!this.ctx.container.running) {
      this.ctx.container.start({ enableInternet: false });
    }

    for (const file of files) {
      await this.writeFile(file);
    }

    // `cd` first: exec starts in `/`, so a bare `.` used to point semgrep at
    // the entire container filesystem instead of the generated project.
    const proc = await this.execWithRetry([
      'sh',
      '-c',
      `cd ${WORKDIR} && exec semgrep scan ` +
        `--config ${WORKDIR}/.semgrep/security-audit.yml ` +
        `--config ${WORKDIR}/.semgrep/owasp-top-ten.yml ` +
        `--json --quiet .`,
    ]);

    const output = await this.readAll(proc);
    await proc.exitCode; // semgrep exits non-zero when findings exist — not an error

    let parsed: {
      results?: Array<{
        check_id: string;
        path: string;
        start: { line: number };
        extra: { message: string; severity: string };
      }>;
    };
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error(
        `Semgrep produced non-JSON output: ${output.slice(0, 500)}`
      );
    }

    return (parsed.results ?? []).map((r) => ({
      path: r.path,
      line: r.start.line,
      ruleId: r.check_id,
      message: r.extra.message,
      severity: r.extra.severity,
    }));
  }

  private async readAll(proc: ExecProcess): Promise<string> {
    if (!proc.stdout) return '';
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  /**
   * Launches Vite directly instead of `npm install && npm run dev`.
   *
   * The old command could not work, and the two halves failed for separate
   * reasons. `start()` boots the container with `enableInternet: false`, so
   * `npm install` has no registry to reach; it exited non-zero, the `&&`
   * short-circuited, and `npm run dev` never ran — nothing ever bound 5173.
   * Even past that, `npm run dev` needs a `dev` script in whatever
   * package.json the Coder agent happened to write, and the Coder's
   * package.json overwrites the one baked into the image.
   *
   * Neither is necessary: Dockerfile.preview bakes vite, react, react-dom and
   * @vitejs/plugin-react into /app/node_modules at build time precisely
   * because the running container is offline, so the binary is already there
   * and already resolves the React runtime. `--strictPort` matters — without
   * it Vite silently moves to 5174 when 5173 is busy, which reads downstream
   * as the exact same "container is not listening on 5173" failure.
   *
   * Measured in production 2026-08-27: run b61499bd finished with
   * `Preview unavailable: Preview route ping failed after 3 attempts: The
   * container is not listening in the TCP address 10.0.0.1:5173`.
   */
  private async startDevServer(): Promise<void> {
    // Vite serves files the model wrote and executes the project's own
    // vite.config.js, so this is user code and is gated like user code.
    assertMayRunUserCode(this.phase);
    this.devProcess?.kill();
    this.devServerReady = false;
    this.devProcess = await this.execWithRetry([
      'sh',
      '-c',
      buildDevServerCommand(),
    ]);
  }

  /**
   * Blocks until port 5173 actually answers.
   *
   * `devProcess !== null` only ever meant "the exec call returned", which is
   * true the instant the shell spawns and stays true after the dev server dies.
   * `/status` reported `devServerStarted: true` for a container with nothing
   * listening, so the caller's readiness gate passed and the failure only
   * surfaced later as an opaque TCP error from the proxy. Polling the port is
   * the only claim worth making here.
   */
  private async waitForDevServer(): Promise<void> {
    const bound = await this.waitForPort(DEV_SERVER_PORT, this.devProcess);
    if (!bound) {
      throw new Error(
        `Dev server did not bind port ${DEV_SERVER_PORT} within ` +
          `${PORT_READY_TIMEOUT_MS}ms. Last output: ${await this.tailLog(DEV_SERVER_LOG)}`
      );
    }
    this.devServerReady = true;
  }

  /**
   * Blocks until `port` actually answers, or the process dies, or the deadline
   * passes. Returns whether it bound.
   *
   * Polling the port rather than trusting that `exec()` returned: a non-null
   * process handle only ever meant "the shell spawned", which is true the
   * instant it starts and stays true after the server inside it dies. `/status`
   * used to report ready for a container with nothing listening, so the
   * caller's readiness gate passed and the failure surfaced much later as an
   * opaque TCP error from the proxy.
   *
   * Returns false rather than throwing because the two callers want different
   * things from a failure: a dead frontend is fatal, a dead backend degrades
   * to a visible warning with the frontend still up.
   */
  private async waitForPort(
    port: number,
    proc: ExecProcess | null
  ): Promise<boolean> {
    const exit: { code: number | null } = { code: null };
    proc?.exitCode
      .then((code) => {
        exit.code = code;
      })
      .catch(() => {
        exit.code = -1;
      });

    const deadline = Date.now() + PORT_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (exit.code !== null) return false; // died before binding
      try {
        const probe = await this.execWithRetry(buildPortProbeArgs(port), {
          stdout: 'pipe',
        });
        if ((await probe.exitCode) === 0) return true;
      } catch {
        // Probe failures are expected while the server is still coming up.
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PORT_POLL_INTERVAL_MS)
      );
    }

    return false;
  }

  /** Last few lines of a log file, for error messages. Best-effort: a
   * diagnostic must never be the reason a failure path throws. */
  private async tailLog(path: string, lines = 20): Promise<string> {
    try {
      const proc = await this.execWithRetry([
        'sh',
        '-c',
        `tail -n ${lines} ${path} 2>&1`,
      ]);
      const output = (await this.readAll(proc)).trim();
      return output || '(no output)';
    } catch (err) {
      return `(log unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  /** Tails the dev server's log file rather than the process's stdout pipe —
   * see DEV_SERVER_LOG for why the pipe can't be the source of truth. */
  private async streamLogs(): Promise<Response> {
    if (!this.devProcess) {
      return new Response('data: {"message":"No dev server running"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    const proc = await this.execWithRetry([
      'sh',
      '-c',
      `tail -n 200 -f ${DEV_SERVER_LOG} 2>&1`,
    ]);
    if (!proc.stdout) {
      return new Response('data: {"message":"No log stream available"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n').filter(Boolean)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ message: line })}\n\n`)
          );
        }
      },
      cancel() {
        reader.releaseLock();
        // `tail -f` never ends on its own; the client going away has to end it.
        proc.kill();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Forwards one live-preview request into the container's dev server.
   *
   * The response is read to completion here rather than handed back as a live
   * stream. Measured in production 2026-08-27: with the stream passed through,
   * exactly one proxied request per container succeeded and every later one
   * hung until the client gave up (Worker outcome `canceled`, no exception,
   * Vite's own log showing nothing after "ready in 295 ms") — the connection
   * to the container was never released. Draining the body inside the DO ends
   * it deterministically. Preview payloads are dev-server modules and assets,
   * so buffering them is cheap.
   *
   * Upgrade requests (HMR's WebSocket) are passed straight through: there is
   * no body to drain, and buffering one would break it.
   */
  private async proxy(
    request: Request,
    pathAndQuery: string
  ): Promise<Response> {
    if (!this.ctx.container?.running) {
      return new Response('Sandbox not running', { status: 503 });
    }

    const url = new URL(pathAndQuery || '/', PREVIEW_ORIGIN);
    const toBackend = isBackendPath(url.pathname, this.apiRoutePaths);

    if (toBackend && !this.backendReady) {
      // An explicit 503 with a reason, not Vite's index.html with a 200.
      // Falling through to the dev server would answer a fetch('/api/todos')
      // with an HTML document, which surfaces to the founder as a JSON parse
      // error somewhere else entirely.
      return new Response(
        JSON.stringify({
          error: 'Preview backend is not running',
          detail: this.warnings.at(-1) ?? 'The generated server did not start.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const port = toBackend ? BACKEND_PORT : DEV_SERVER_PORT;
    const target = new Request(url, request);
    const response = await this.ctx.container.getTcpPort(port).fetch(target);

    if (request.headers.get('Upgrade')) return response;

    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    // The runtime sets these for the new body; carrying the container's
    // values over would describe the wrong bytes.
    headers.delete('content-encoding');
    headers.delete('content-length');

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Probes the running preview for real — an HTTP request to the dev server,
   * and an HTTP request to a route the blueprint actually declared.
   *
   * This is what `backendRunning` was standing in for and could not do.
   * `backendRunning` is set when `waitForPort(8080)` sees the port accept a
   * connection; a server that binds and then 500s on every request, or mounts
   * its routes under a prefix the blueprint does not use, sets it just the
   * same. The judgements live in sandbox-health.ts, which documents what each
   * response class is taken to mean and why.
   *
   * Requests go over `getTcpPort(...)` directly rather than through
   * `this.proxy`, because proxy short-circuits a backend path to a 503 when
   * `backendReady` is false — which would make this check read the very flag
   * it exists to replace.
   */
  private async health(): Promise<HealthReport> {
    if (!this.ctx.container?.running) {
      return summarize([
        unprobeable('frontend', 'The container is not running.'),
        unprobeable('backend', 'The container is not running.'),
      ]);
    }

    const probes: ProbeResult[] = [
      await this.probe(DEV_SERVER_PORT, '/', judgeFrontendResponse, () =>
        unprobeable(
          'frontend',
          'The dev server has not finished starting; nothing to probe yet.'
        )
      ),
    ];

    if (this.apiRoutePaths.length === 0) {
      probes.push(
        unprobeable(
          'backend',
          'This blueprint declares no API routes, so there is no backend to check.'
        )
      );
    } else {
      const path = chooseBackendProbePath(this.apiRoutePaths);
      if (path === null) {
        // Honest, not green. See chooseBackendProbePath for why a parameterised
        // route cannot be probed without inventing data that a correct server
        // would answer 404 for.
        probes.push(
          unprobeable(
            'backend',
            `Every declared API route takes a parameter (${this.apiRoutePaths.join(', ')}), ` +
              `so none can be requested without inventing data. The backend was not checked.`
          )
        );
      } else {
        probes.push(
          await this.probe(
            BACKEND_PORT,
            path,
            judgeBackendResponse,
            (reason) => ({
              target: 'backend',
              path,
              outcome: 'unhealthy',
              detail: `${path} could not be reached inside the container: ${reason}`,
            })
          )
        );
      }
    }

    return summarize(probes);
  }

  /** One probe: request, read, judge. A throw or a timeout is a result, not an
   * exception — the status endpoint that calls this must always answer. */
  private async probe(
    port: number,
    path: string,
    judge: (input: {
      path: string;
      status: number;
      contentType: string;
      body: string;
    }) => ProbeResult,
    onFailure: (reason: string) => ProbeResult
  ): Promise<ProbeResult> {
    try {
      const response = await this.ctx.container!.getTcpPort(port).fetch(
        new Request(new URL(path, PREVIEW_ORIGIN), {
          headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      );
      return judge({
        path,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.text(),
      });
    } catch (err) {
      return onFailure(err instanceof Error ? err.message : String(err));
    }
  }

  private async destroy(): Promise<void> {
    this.devProcess?.kill();
    this.devProcess = null;
    this.devServerReady = false;
    this.backendProcess?.kill();
    this.backendProcess = null;
    this.backendReady = false;
    // Back to the phase that fails closed. A destroyed container that somehow
    // gets reused must not inherit `sealed` and skip the seal.
    this.phase = 'booting';
    this.warnings = [];
    // The files went with the container. Leaving this set would let the next
    // start "reuse" a container that no longer exists.
    this.fileSignature = null;
    await this.ctx.container?.destroy();
  }
}
