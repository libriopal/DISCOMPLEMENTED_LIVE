/**
 * Tool: trigger the preview tier for a batch of generated files, used by
 * the Coder agent's error feedback loop (write -> run preview -> collect
 * errors -> fix -> repeat). Tier selection now comes from Phase 6's
 * lib/preview-strategy.ts (the canonical selector — also used by
 * PreviewFrame/useSandboxPreview on the client). The DO that runs this tool
 * has no DOM/container access, so the validation step itself stays
 * read-logs.ts's static lint pass rather than actually invoking Babel/
 * esbuild-wasm/Sandbox — those run interactively for the human-facing
 * preview (components/PreviewFrame.tsx), not inside the automatic loop.
 */
import type { ProjectFile } from '@bicameral/shared/types';
import type { PipelineComplexity } from '../../lib/cohere.js';
import {
  selectPreviewTier,
  type PreviewTier,
} from '../../lib/preview-strategy.js';
import { collectLogs } from './read-logs.js';

export type { PreviewTier };

export interface PreviewResult {
  tier: PreviewTier;
  success: boolean;
  errors: string[];
  url: string | null;
}

export function runPreview(
  files: ProjectFile[],
  complexity: PipelineComplexity
): PreviewResult {
  const tier = selectPreviewTier(complexity);
  const logs = collectLogs(files);

  return {
    tier,
    success: logs.length === 0,
    errors: logs.map((entry) => `${entry.path}: ${entry.message}`),
    // No real deploy target from the automatic loop — Sandbox URLs come
    // from routes/preview.ts once a founder opens the interactive preview.
    url: null,
  };
}
