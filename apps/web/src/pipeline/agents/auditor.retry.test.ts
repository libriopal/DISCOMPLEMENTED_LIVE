/**
 * The Auditor's schema-retry loop.
 *
 * Replays the production failure of 2026-08-28 — the model emitted three
 * well-formed findings and then a bare number in the fourth slot, and the run
 * died at step 2 because `safeParse` threw on the first miss. The behaviour
 * under test is that the same response now costs one extra call instead of the
 * whole run, and that the validation error is handed back to the model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../env.js';
import type { ProjectBrief, ResearchFindings } from '@bicameral/shared/types';

const callAgentModel = vi.fn();

vi.mock('../../lib/cohere.js', () => ({
  callAgentModel: (...args: unknown[]) => callAgentModel(...args),
  selectModel: () => 'command-a-03-2025',
}));
vi.mock('../lattice-enrich.js', () => ({
  findSimilarPatterns: async () => [],
}));
vi.mock('../subconscious.js', () => ({
  runSubconscious: async () => ({ contextBlock: '' }),
}));

const { runAuditor } = await import('./auditor.js');

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

const validAudit = {
  summary: 'Research covers the brief.',
  passed: true,
  findings: [
    {
      type: 'gap',
      severity: 'warning',
      description: 'No accessibility considerations.',
      recommendation: 'Add a11y requirements.',
    },
  ],
  recommendations: ['Document the auth flow.'],
};

/** The exact shape that killed the run: findings[3] is a number. */
const malformedAudit = {
  ...validAudit,
  findings: [...validAudit.findings, 4 as unknown as object],
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

const research = { summary: 'ok' } as unknown as ResearchFindings;

describe('runAuditor schema retry', () => {
  beforeEach(() => callAgentModel.mockReset());

  it('recovers from a malformed findings entry on the second attempt', async () => {
    callAgentModel
      .mockResolvedValueOnce(reply(malformedAudit, 100, 20))
      .mockResolvedValueOnce(reply(validAudit, 130, 25));

    const result = await runAuditor(brief, research, {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(2);
    expect(result.audit.passed).toBe(true);
    // Tokens accumulate across attempts — a retry is not free and the run's
    // accounting has to say so.
    expect(result.tokensIn).toBe(230);
    expect(result.tokensOut).toBe(45);
  });

  it('feeds the validation error back to the model on the retry', async () => {
    callAgentModel
      .mockResolvedValueOnce(reply(malformedAudit))
      .mockResolvedValueOnce(reply(validAudit));

    await runAuditor(brief, research, {} as Env);

    const retryOptions = callAgentModel.mock.calls[1][2] as {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    const lastMessage = retryOptions.messages.at(-1)!;
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('failed validation');
    expect(lastMessage.content).toContain('findings');
    expect(retryOptions.temperature).toBe(0.1);
  });

  it('retries a response that is not JSON at all', async () => {
    callAgentModel
      .mockResolvedValueOnce({
        data: {
          message: { role: 'assistant', content: 'Here is the audit:' },
          finishReason: 'complete',
          usage: { billedTokens: 5, inputTokens: 3, outputTokens: 2 },
        },
      })
      .mockResolvedValueOnce(reply(validAudit));

    const result = await runAuditor(brief, research, {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(2);
    expect(result.audit.summary).toBe(validAudit.summary);
  });

  it('gives up after three attempts and reports the last error', async () => {
    callAgentModel.mockResolvedValue(reply(malformedAudit));

    await expect(runAuditor(brief, research, {} as Env)).rejects.toThrow(
      /failed validation after 3 attempts/
    );
    expect(callAgentModel).toHaveBeenCalledTimes(3);
  });

  it('does not retry a response that already validates', async () => {
    callAgentModel.mockResolvedValue(reply(validAudit));

    await runAuditor(brief, research, {} as Env);

    expect(callAgentModel).toHaveBeenCalledTimes(1);
  });
});
