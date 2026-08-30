/**
 * Preview strategy selector — single source of truth for which of the
 * three preview tiers (Babel -> esbuild-wasm -> Cloudflare Sandbox) a given
 * generation should use. Called from both sides of the pipeline:
 *   - client: components/PreviewFrame.tsx, to decide how to render live output
 *   - server: pipeline/tools/run-preview.ts, for the Coder agent's
 *     automatic error-feedback loop (see @agent_docs/preview-tiers.md)
 */
import type { PipelineComplexity } from './cohere.js';

export type PreviewTier = 'babel' | 'esbuild' | 'sandbox';

export interface PreviewStrategyOptions {
  /** Blueprints with server routes need a real backend process — Babel/esbuild
   * only run client-side JSX, so any apiRoutes force the Sandbox tier. */
  hasApiRoutes?: boolean;
  fileCount?: number;
}

export interface TierCapability {
  label: string;
  latency: string;
  description: string;
}

export const TIER_CAPABILITIES: Record<PreviewTier, TierCapability> = {
  babel: {
    label: 'Instant',
    latency: '~100ms',
    description:
      'Single-file JSX/TSX transform via @babel/standalone. No imports across files.',
  },
  esbuild: {
    label: 'Bundled',
    latency: '~1-2s',
    description:
      'Full esbuild-wasm bundle across the generated files, with bare imports resolved via esm.sh.',
  },
  sandbox: {
    label: 'Full-stack',
    latency: '~5-15s',
    description:
      'Real Node.js + Vite dev server in a Cloudflare Container — needed for API routes or heavy dependency graphs.',
  },
};

const ESBUILD_FILE_COUNT_THRESHOLD = 12;

export function selectPreviewTier(
  complexity: PipelineComplexity,
  opts: PreviewStrategyOptions = {}
): PreviewTier {
  if (opts.hasApiRoutes) return 'sandbox';
  if (complexity === 'complex') return 'sandbox';
  if (complexity === 'moderate') return 'esbuild';
  if ((opts.fileCount ?? 0) > ESBUILD_FILE_COUNT_THRESHOLD) return 'esbuild';
  return 'babel';
}
