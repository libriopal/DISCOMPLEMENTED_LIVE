/**
 * Dependency installation for the Tier 3 preview sandbox.
 *
 * Runs during the `installing` phase only — see sandbox-egress.ts, which owns
 * the guarantee that no generated code is executing while the registry is
 * reachable.
 *
 * The subtlety worth stating: `npm install` is itself an arbitrary-code-
 * execution surface. A package's `postinstall` script runs as soon as it is
 * unpacked, in this container, during the exact window when the network is
 * open. So the install runs with `--ignore-scripts`, which closes that window
 * rather than trusting that no dependency the model picked has one.
 */
import type { ProjectFile } from '@bicameral/shared/types';

/**
 * Packages already in the image (Dockerfile.preview) — never re-fetched.
 *
 * Reinstalling them would work now that the registry is reachable, but it
 * would spend the install window on bytes already on disk, and a version drift
 * between the baked React and an installed one is the kind of failure that
 * shows up as a blank page with a hooks error.
 */
export const PREINSTALLED_PACKAGES = [
  'vite',
  '@vitejs/plugin-react',
  'react',
  'react-dom',
] as const;

/**
 * Ceiling on the install phase.
 *
 * Bounded because the phase gates everything after it: a hung install would
 * hold the sandbox in the one phase where the network is open, for as long as
 * npm was willing to retry. Failing at three minutes and continuing without
 * the dependency is strictly better than staying open indefinitely.
 */
export const INSTALL_TIMEOUT_MS = 180_000;

/**
 * Most dependencies a single generated project may install.
 *
 * The Coder is told to consolidate into 3-4 files; a blueprint asking for 40
 * packages is a runaway, and installing it would spend the container's 2GB
 * disk and the install window on something no founder asked for.
 */
export const MAX_DEPENDENCIES = 24;

export interface DependencyPlan {
  /** `name@range` specs to install, already filtered and validated. */
  specs: string[];
  /** Names present in package.json but skipped, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * npm package names that are valid to pass to `npm install`.
 *
 * Anything not matching is refused rather than sanitised. These strings come
 * from a language model and end up in a shell command; the only safe treatment
 * of an unexpected shape is to not run it. In particular this rejects the
 * forms npm accepts that are *not* registry packages — a git URL, a
 * `file:../` path, an `http://` tarball — each of which would fetch code from
 * somewhere the egress allowlist does not cover.
 */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

/**
 * Version ranges we will pass through.
 *
 * Semver-ish characters only. `latest` and `*` are allowed because generated
 * package.json files use them constantly and they resolve to a registry
 * package like any other range. A range containing a slash, colon, or space is
 * almost always one of the non-registry forms above wearing a version's
 * clothing.
 */
const NPM_RANGE = /^[\w.\-+~^><=|\s*]+$/;

/**
 * Reads the generated package.json and decides what to install.
 *
 * Returns a plan rather than running anything, so the decision is testable and
 * so the skipped entries can be shown to the founder — a dependency that was
 * silently dropped is a blank page with no explanation, which is the failure
 * mode this whole workstream exists to end.
 */
export function declaredDependencies(files: ProjectFile[]): DependencyPlan {
  const manifest = files.find(
    (f) => f.path === 'package.json' || f.path === './package.json'
  );
  if (!manifest) return { specs: [], skipped: [] };

  let parsed: { dependencies?: Record<string, unknown> };
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return {
      specs: [],
      skipped: [
        {
          name: 'package.json',
          reason: 'not valid JSON, so no dependencies could be read',
        },
      ],
    };
  }

  // devDependencies are deliberately ignored. A preview runs the app; it does
  // not run its test suite or its linter, and installing them spends the
  // window and the disk on packages nothing will import.
  const deps = parsed.dependencies;
  if (!deps || typeof deps !== 'object') return { specs: [], skipped: [] };

  const specs: string[] = [];
  const skipped: DependencyPlan['skipped'] = [];

  for (const [name, range] of Object.entries(deps)) {
    if ((PREINSTALLED_PACKAGES as readonly string[]).includes(name)) {
      continue; // already in the image; not a skip worth reporting
    }
    if (!NPM_NAME.test(name)) {
      skipped.push({ name, reason: 'not a valid npm package name' });
      continue;
    }
    if (typeof range !== 'string' || !NPM_RANGE.test(range)) {
      skipped.push({
        name,
        reason:
          `version "${String(range)}" is not a registry version range — git ` +
          `URLs, file paths and tarball URLs are not installable here`,
      });
      continue;
    }
    if (specs.length >= MAX_DEPENDENCIES) {
      skipped.push({
        name,
        reason: `over the ${MAX_DEPENDENCIES}-dependency limit for one preview`,
      });
      continue;
    }
    specs.push(`${name}@${range}`);
  }

  return { specs, skipped };
}

/**
 * Where the platform drops the ephemeral CA used for HTTPS interception.
 *
 * It exists only while the container runs and only once an outbound handler is
 * installed, so it cannot be baked into the image at build time — it has to be
 * copied into the trust store from inside the running container, before npm
 * makes its first TLS connection.
 */
export const CF_CA_SOURCE =
  '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const CF_CA_DEST =
  '/usr/local/share/ca-certificates/cloudflare-containers-ca.crt';

/**
 * Copies the interception CA into the system trust store.
 *
 * Run as part of the install command rather than from the image's entrypoint,
 * which is where the docs put it. The entrypoint runs at container start; the
 * DO's install `exec` can arrive before it has finished, and the failure that
 * produces is a TLS error from npm that looks exactly like a network outage.
 * Doing it inline is one ordering instead of two.
 *
 * `|| true` on the copy is deliberate and is not a swallowed failure: if the CA
 * is absent, npm fails immediately afterwards with its own TLS error, which
 * says far more than "cp: no such file" would. The install phase is bounded and
 * its failure is reported to the founder either way.
 */
function trustInterceptionCa(): string {
  return (
    `cp ${CF_CA_SOURCE} ${CF_CA_DEST} 2>/dev/null || true; ` +
    `update-ca-certificates >/dev/null 2>&1 || true; `
  );
}

/**
 * The install command.
 *
 * `--ignore-scripts` is the load-bearing flag: lifecycle scripts are arbitrary
 * code from a package the model chose, and they would run inside the container
 * during the one phase when the network is open. Very few frontend packages
 * need them, and a preview that renders without a postinstall is worth far
 * more than one that runs it.
 *
 * `--no-audit --no-fund` are not cosmetic here — both make extra registry
 * calls, and every call during this phase is one more thing happening while
 * egress is open.
 *
 * `--no-package-lock` avoids writing a lockfile the founder never asked for
 * into their generated file set.
 *
 * `NODE_EXTRA_CA_CERTS` belts the trust-store copy: npm bundles its own CA
 * handling and does not always follow the system store.
 */
export function buildInstallCommand(specs: string[], workdir: string): string {
  if (specs.length === 0) {
    throw new Error('buildInstallCommand called with no packages to install');
  }
  // Single-quoting makes every shell metacharacter literal, and NPM_NAME /
  // NPM_RANGE both reject `'` so the quoting cannot be closed early. That is
  // two independent reasons this is safe; the assertion is the third, because
  // these strings were written by a language model from a stranger's prompt
  // and "the regex upstream rejects it" is a claim about a different function.
  for (const spec of specs) {
    if (spec.includes("'")) {
      throw new Error(
        `Refusing to install "${spec}": a package spec containing a quote ` +
          `cannot be safely passed to a shell.`
      );
    }
  }
  const quoted = specs.map((s) => `'${s}'`).join(' ');
  return (
    trustInterceptionCa() +
    `cd ${workdir} && NODE_EXTRA_CA_CERTS=${CF_CA_SOURCE} ` +
    `npm install --ignore-scripts --no-audit --no-fund ` +
    `--no-package-lock --loglevel=error ${quoted} 2>&1`
  );
}
