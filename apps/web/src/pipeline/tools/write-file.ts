/**
 * Tool: write a generated file to R2, keyed under the pipeline run. This is
 * the durable store both the Coder agent's iteration loop and (eventually)
 * Phase 6's preview tiers read from — Tier 3 (Sandbox) will pull the same
 * `pipeline-runs/{runId}/...` prefix to seed the container filesystem.
 */
import type { ToolDefinition } from '@bicameral/cohere/chat';
import type { ProjectFile } from '@bicameral/shared/types';

export function fileKey(pipelineRunId: string, path: string): string {
  return `pipeline-runs/${pipelineRunId}/${path.replace(/^\/+/, '')}`;
}

export async function writeFile(
  bucket: R2Bucket,
  pipelineRunId: string,
  file: ProjectFile
): Promise<{ key: string }> {
  const key = fileKey(pipelineRunId, file.path);
  await bucket.put(key, file.content, {
    httpMetadata: { contentType: languageToContentType(file.language) },
  });
  return { key };
}

export async function writeFiles(
  bucket: R2Bucket,
  pipelineRunId: string,
  files: ProjectFile[]
): Promise<{ key: string }[]> {
  return Promise.all(
    files.map((file) => writeFile(bucket, pipelineRunId, file))
  );
}

function languageToContentType(language: string): string {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return 'text/plain; charset=utf-8';
    case 'json':
      return 'application/json';
    case 'css':
      return 'text/css';
    case 'html':
      return 'text/html';
    default:
      return 'text/plain; charset=utf-8';
  }
}

/** Cohere tool schema — documents the write_file capability for direct
 * function-calling use once the Coder loop needs interactive tool turns
 * (today the loop runs as one structured-output call per iteration; see
 * pipeline/agents/coder.ts). */
export const WRITE_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or update a file in the generated project',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the project root',
        },
        content: { type: 'string', description: 'Full file contents' },
        language: {
          type: 'string',
          description: 'Language identifier, e.g. typescript, tsx, css, json',
        },
      },
      required: ['path', 'content', 'language'],
    },
  },
};
