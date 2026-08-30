/**
 * Tool: collect error logs for the Coder agent's error feedback loop.
 *
 * Static, dependency-free lint pass over generated files. The checks
 * themselves now live in ../rules — a declarative registry ported from
 * Controller-C's farkleRules.ts — because the same detection was implemented
 * twice, here and in finalize-generation.ts, with different patterns. This
 * copy matched `stub` and `not implemented`; that one did not. Sharing the
 * registry stops them drifting again while leaving severity to each caller:
 * findings surface here as errors that drive repair, and there as warnings.
 *
 * The stub detection is critical — without it, the Coder's error loop
 * passes with 200-byte skeleton files that have balanced braces but no
 * actual logic, producing a "deployed" app that doesn't do anything.
 *
 * Rules gained in the port that neither copy had: truncation-marker detection
 * ("// ... rest of file"), inlined credentials, and client-side code calling
 * an LLM provider directly.
 *
 * Three checks stay here rather than moving into the registry, because a
 * registry rule sees one file at a time and these are properties of the file
 * *set*: whether anything can boot it, whether a manifest exists, and whether
 * its imports resolve against what the preview will actually have installed. They are the same
 * argument as stub detection one rung further out — a set of individually
 * valid components with nothing to mount them is a blank page that passes
 * every per-file rule, and a file importing a package nothing installs is one
 * Vite answers with HTTP 500 while the root URL still returns 200, so
 * finalize's ping sees a healthy preview. See lib/entry-point.ts and
 * lib/preview-runtime.ts.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import {
  findEntryPoint,
  MISSING_ENTRY_POINT_MESSAGE,
  normalizeFilePath,
} from '../../lib/entry-point.js';
import {
  disallowedImportMessage,
  findDisallowedImports,
  MISSING_PACKAGE_JSON_MESSAGE,
  PACKAGE_JSON_PATH,
} from '../../lib/preview-runtime.js';
import { declaredDependencies } from '../../durable-objects/sandbox-install.js';
import { runRules } from '../rules/index.js';

export interface LogEntry {
  path: string;
  message: string;
}

export function collectLogs(files: ProjectFile[]): LogEntry[] {
  if (files.length === 0) {
    return [{ path: '(project)', message: 'No files were generated' }];
  }

  const errors: LogEntry[] = [...collectProjectLevelErrors(files)];

  // The line number matters: the repair loop hands these back to the model,
  // and a located failure repairs far more reliably than a described one.
  for (const v of runRules(files)) {
    errors.push({
      path: v.path,
      message: v.line === null ? v.message : `line ${v.line}: ${v.message}`,
    });
  }

  return errors;
}

/** Checks about the file set as a whole, which a per-file rule cannot express. */
function collectProjectLevelErrors(files: ProjectFile[]): LogEntry[] {
  const errors: LogEntry[] = [];

  if (!findEntryPoint(files)) {
    errors.push({ path: '(project)', message: MISSING_ENTRY_POINT_MESSAGE });
  }

  const manifest = files.find(
    (f) => normalizeFilePath(f.path) === PACKAGE_JSON_PATH
  );
  if (!manifest) {
    errors.push({ path: '(project)', message: MISSING_PACKAGE_JSON_MESSAGE });
  } else {
    for (const message of checkManifestDependencies(manifest)) {
      errors.push({ path: manifest.path, message });
    }
  }

  for (const entry of findDisallowedImports(files)) {
    errors.push({ path: entry.path, message: disallowedImportMessage(entry) });
  }

  return errors;
}

/**
 * A manifest is only useful here if every entry in it will actually install.
 *
 * This used to reject any dependency outside the image's four packages,
 * because nothing installed anything. Dependencies are installed now, so the
 * check is narrower and sharper: the entries that will be *dropped* by the
 * install phase are the ones the Coder needs to hear about, while it can still
 * fix them. `declaredDependencies` is the same function the Sandbox runs, so
 * the verdict here and the behaviour there cannot drift.
 */
function checkManifestDependencies(manifest: ProjectFile): string[] {
  try {
    // Parsed for its error alone. The registry's valid_json rule only fires
    // when language === 'json' or the path ends .json, and package.json has
    // arrived labelled 'javascript' before now — so a syntax error would
    // otherwise reach declaredDependencies, which reports it as "no
    // dependencies could be read" without saying where the JSON broke.
    JSON.parse(manifest.content);
  } catch (err) {
    return [`Invalid JSON: ${(err as Error).message}`];
  }

  // declaredDependencies keys off the canonical root path; `manifest.path` has
  // already been matched against PACKAGE_JSON_PATH by the caller, but may
  // carry a "./" prefix.
  return declaredDependencies([
    { ...manifest, path: PACKAGE_JSON_PATH },
  ]).skipped.map(
    (entry) =>
      `Dependency "${entry.name}" will not be installed: ${entry.reason}. ` +
      `Fix or remove the entry, and remove any import of it.`
  );
}
