/**
 * The Verifier's schema-retry loop — the same contract as auditor.retry.test.ts.
 *
 * The Verifier differs from the Auditor in one way that matters: a You.com
 * dependency lookup runs after validation, so the retry loop has to settle
 * before that fires. These tests pin that it does — the search happens once,
 * not once per attempt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../env.js';
import type { ProjectBrief, ResearchFindings } from '@bicameral/shared/types';

const callAgentModel = vi.fn();
const verifyDependency = vi.fn();

vi.mock('../../lib/cohere.js', () => ({
  callAgentModel: (...args: unknown[]) => callAgentModel(...args),
  selectModel: () => 'command-a-03-2025',
}));
vi.mock('../../lib/youcom-research.js', () => ({
  verifyDependency: (...args: unknown[]) => verifyDependency(...args),
}));
vi.mock('../lattice-enrich.js', () => ({
  findSimilarPatterns: async () => [],
}));
vi.mock('../subconscious.js', () => ({
  runSubconscious: async () => ({ contextBlock: '' }),
}));

const { runVerifier } = await import('./verifier.js');

function reply(content: unknown, inputTokens = 10, outputTokens = 5) {
  return {
    data: {
      message: { role: 'assistant', content: JSON.stringify(content) },
      finishReason: 'complete',
      usage: {
        billedTokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
      },
    },
  };
}

const validVerification = {
  summary: 'Architecture is viable.',
  passed: true,
  contextCheck: {
    viable: true,
    maxRecommendedFiles: 6,
    estimatedTokensPerFile: 900,
    reasoning: 'Well under the 8K output ceiling.',
  },
  dependencyCheck: [
    { name: 'react', status: 'approved', notes: 'Stable and current.' },
  ],
  constraints: ['At most 6 files.'],
  recommendations: ['Keep state in a single context.'],
};

/** dependencyCheck entries arriving as bare strings instead of objects. */
const malformedVerification = {
  ...validVerification,
  dependencyCheck: ['react', 'vite'] as unknown as object[],
};

const brief = {
  appName: 'Timer',
  appType: 'web',
  targetUsers: 'people who cook',
  coreFeatures: ['countdown'],
  dataModels: [],
  techPreferences: 'React',
  complexity: 'simple',
  estimatedComponents: 3,
} as unknown as ProjectBrief;

const research = {
  techStack: [{ recommendation: 'React' }],
  recommendedLibraries: [],
} as unknown as ResearchFindings;

describe('runVerifier schema retry', () => {
  beforeEach(() => {
    callAgentModel.mockReset();
    verifyDependency.mockReset();
  });

  it('recovers from a malformed dependencyCheck on the second attempt', async () => {
    callAgentModel
      .mockResolvedValueOnce(reply(malformedVerification, 100, 20))
      .mockResolvedValueOnce(reply(validVerification, 130, 25));

    const result = await runVerifier(brief, research, 'audit ok', {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(2);
    expect(result.verification.passed).toBe(true);
    expect(result.tokensIn).toBe(230);
    expect(result.tokensOut).toBe(45);
  });

  it('feeds the validation error back to the model on the retry', async () => {
    callAgentModel
      .mockResolvedValueOnce(reply(malformedVerification))
      .mockResolvedValueOnce(reply(validVerification));

    await runVerifier(brief, research, 'audit ok', {} as Env);

    const retryOptions = callAgentModel.mock.calls[1][2] as {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    const lastMessage = retryOptions.messages.at(-1)!;
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('failed validation');
    expect(lastMessage.content).toContain('dependencyCheck');
    expect(retryOptions.temperature).toBe(0.1);
  });

  it('retries a response that is not JSON at all', async () => {
    callAgentModel
      .mockResolvedValueOnce({
        data: {
          message: { role: 'assistant', content: 'Sure — here goes:' },
          finishReason: 'complete',
          usage: { billedTokens: 5, inputTokens: 3, outputTokens: 2 },
        },
      })
      .mockResolvedValueOnce(reply(validVerification));

    const result = await runVerifier(brief, research, 'audit ok', {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(2);
    expect(result.verification.summary).toBe(validVerification.summary);
  });

  it('gives up after three attempts and reports the last error', async () => {
    callAgentModel.mockResolvedValue(reply(malformedVerification));

    await expect(
      runVerifier(brief, research, 'audit ok', {} as Env)
    ).rejects.toThrow(/failed validation after 3 attempts/);
    expect(callAgentModel).toHaveBeenCalledTimes(3);
  });

  it('runs the dependency lookup once, after the retry loop settles', async () => {
    verifyDependency.mockResolvedValue({
      name: 'zustand',
      status: 'approved',
      notes: 'Current.',
    });
    callAgentModel
      .mockResolvedValueOnce(reply(malformedVerification))
      .mockResolvedValueOnce(reply(validVerification));

    const result = await runVerifier(
      brief,
      { ...research, recommendedLibraries: ['zustand'] } as ResearchFindings,
      'audit ok',
      {} as Env
    );

    expect(verifyDependency).toHaveBeenCalledTimes(1);
    // The model's own entry plus the verified one — the merge still happens.
    expect(result.verification.dependencyCheck).toHaveLength(2);
  });

  it('does not retry a response that already validates', async () => {
    callAgentModel.mockResolvedValue(reply(validVerification));

    await runVerifier(brief, research, 'audit ok', {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(1);
  });
});
