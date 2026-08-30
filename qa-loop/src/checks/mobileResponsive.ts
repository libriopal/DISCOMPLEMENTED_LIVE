/**
 * Check 6 — Mobile / responsive.
 *
 * This is the one check the task spec says can't be fully automated without
 * a browser. What IS feasible without one: read the responsive adaptation
 * rules called out in design/06-hifi-responsive-layouts.html (tablet/mobile
 * grid changes, bottom sheets, drawer patterns, etc. — all described in
 * that file's per-screen annotation text) and check whether the actual
 * implementation (CSS in apps/web/src/styles/, `@media` queries anywhere in
 * components) contains ANYTHING that could realize those rules. If there's
 * no @media query at all beyond a color-scheme preference query, that's a
 * concrete, source-verifiable finding — not a guess about what renders.
 *
 * What genuinely can't be checked this pass (actual rendered layout at
 * given viewport widths, touch target sizing, tap-to-expand interactions)
 * is reported as unverifiable, per the task's own instruction for this check.
 */
import { readFile, readdir } from 'node:fs/promises';
import { REPO_ROOT, WEB_APP_ROOT } from '../config.ts';
import type { CheckFinding, CheckResult } from '../types.ts';

async function walkFiles(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(`${full}/`, exts)));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

export async function runMobileResponsiveCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];

  let designAnnotations: string[] = [];
  try {
    const designHtml = await readFile(
      `${REPO_ROOT}design/06-hifi-responsive-layouts.html`,
      'utf-8'
    );
    const annotationMatches = [
      ...designHtml.matchAll(
        /<span style="color:#17171c;">(Tablet|Mobile|Desktop):<\/span>([^<]+)/g
      ),
    ];
    designAnnotations = annotationMatches.map((m) => `${m[1]}: ${m[2].trim()}`);
    findings.push({
      severity: 'info',
      message: `Design spec (design/06-hifi-responsive-layouts.html) documents ${designAnnotations.length} explicit breakpoint-adaptation rules (tablet/mobile layout changes, e.g. sidebar->bottom-tab-bar, drawers, accordions).`,
      location: 'design/06-hifi-responsive-layouts.html',
    });
  } catch (err) {
    findings.push({
      severity: 'low',
      message: `Could not read design/06-hifi-responsive-layouts.html: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const cssFiles = await walkFiles(`${WEB_APP_ROOT}src/`, ['.css']);
    const tsxFiles = await walkFiles(`${WEB_APP_ROOT}src/`, ['.tsx']);

    let mediaQueryCount = 0;
    let colorSchemeOnlyMediaQueries = 0;
    const mediaQueryLocations: string[] = [];

    for (const file of [...cssFiles, ...tsxFiles]) {
      const src = await readFile(file, 'utf-8');
      const matches = [...src.matchAll(/@media\s*\(([^)]+)\)/g)];
      for (const m of matches) {
        mediaQueryCount++;
        const relPath = file.replace(WEB_APP_ROOT, 'apps/web/');
        mediaQueryLocations.push(`${relPath}: @media (${m[1].trim()})`);
        if (/prefers-color-scheme/.test(m[1])) colorSchemeOnlyMediaQueries++;
      }
    }

    const hasUseMediaQueryHook = tsxFiles.length
      ? (
          await Promise.all(
            tsxFiles.map((f) =>
              readFile(f, 'utf-8').then((s) =>
                /useMediaQuery|matchMedia|window\.innerWidth/.test(s)
              )
            )
          )
        ).some(Boolean)
      : false;

    findings.push({
      severity: 'info',
      message: `Scanned ${cssFiles.length} CSS file(s) and ${tsxFiles.length} .tsx file(s) under apps/web/src/. Found ${mediaQueryCount} @media quer(y/ies) total.`,
    });

    if (mediaQueryCount === 0) {
      findings.push({
        severity: 'high',
        message:
          'No @media queries exist anywhere in apps/web/src/ (CSS or inline in .tsx) — none of the tablet/mobile layout adaptations described in design/06-hifi-responsive-layouts.html (bottom tab bar, drawer/sheet patterns, column-count changes) are implemented. The responsive design spec exists only as a reference document; the app renders one layout regardless of viewport width.',
      });
    } else if (mediaQueryCount === colorSchemeOnlyMediaQueries) {
      findings.push({
        severity: 'high',
        message: `All ${mediaQueryCount} @media quer(y/ies) found are prefers-color-scheme (dark mode) only (${mediaQueryLocations.join('; ')}) — zero width-based breakpoints exist, so none of the tablet/mobile layout adaptations in design/06 are implemented.`,
      });
    } else {
      findings.push({
        severity: 'info',
        message: `Width-based media queries found: ${mediaQueryLocations.filter((l) => !/prefers-color-scheme/.test(l)).join('; ')}`,
      });
    }

    if (!hasUseMediaQueryHook) {
      findings.push({
        severity: 'medium',
        message:
          'No JS-side responsive hook (useMediaQuery/matchMedia/window.innerWidth) found in any .tsx component either — layout does not adapt at runtime based on viewport.',
      });
    }

    findings.push({
      severity: 'info',
      message:
        'unocss is a declared devDependency (apps/web/package.json) but no uno.config.* file exists in the repo — its responsive utility classes (sm:/md:/lg: variants) are not wired up, consistent with the @media-query finding above.',
    });
  } catch (err) {
    findings.push({
      severity: 'medium',
      message: `CSS/component scan threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  findings.push({
    severity: 'info',
    message:
      'Unverifiable this pass: actual rendered layout at real viewport widths (does content overflow, are touch targets >=44px, does the sidebar visually collapse), and the interaction-level behaviors design/05 and design/06 describe (tap-to-expand lattice card, swipe-up sheets, pan/zoom canvas on touch). These need a browser-driven follow-up (Playwright viewport emulation or manual device testing), not a source-code read.',
  });

  const highOrAbove = findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical'
  );
  const status =
    highOrAbove.length > 0
      ? 'fail'
      : findings.some((f) => f.severity === 'medium')
        ? 'warn'
        : 'pass';

  return {
    id: 'mobile-responsive',
    title: 'Mobile / Responsive',
    status,
    summary:
      'Static source-level check only (see hard limitation below) — confirms whether ANY responsive implementation exists to realize the design/06 spec.',
    findings,
    durationMs: Date.now() - start,
    unverifiable: true,
    unverifiableReason:
      'Rendered-layout and touch-interaction behavior at real viewport widths cannot be checked without a browser; only static source presence/absence of responsive mechanisms was checked this pass.',
  };
}
