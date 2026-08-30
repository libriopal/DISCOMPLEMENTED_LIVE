/**
 * Pipeline smoke test — Phase 9 CI requirement: verify Step 1 (Architect)
 * turns a founder prompt into valid JSON conforming to ProjectBrief.
 * Mocks callAgentModel so this runs in CI without a live Cohere key; the
 * real contract under test is runArchitect's JSON.parse + projectBriefSchema
 * validation, not the network call itself. See .github/workflows/ci.yml
 * and @agent_docs/implementation-phases.md Phase 9.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../env.js';

vi.mock('../../lib/cohere.js', () => ({
  callAgentModel: vi.fn(async () => ({
    data: {
      id: 'test-response',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          appName: 'Dog Park Finder',
          appType: 'web',
          targetUsers: 'Dog owners looking for nearby off-leash parks',
          coreFeatures: ['Map view', 'Park reviews', 'Check-ins'],
          dataModels: [
            { name: 'Park', fields: ['name', 'location', 'rating'] },
          ],
          techPreferences: 'React + Cloudflare Workers',
          complexity: 'simple',
          estimatedComponents: 5,
        }),
      },
      finishReason: 'complete',
      usage: { billedTokens: 100, inputTokens: 60, outputTokens: 40 },
    },
    cost: { inputTokens: 60, outputTokens: 40, billedTokens: 100 },
  })),
  selectModel: vi.fn(() => 'command-a-03-2025'),
}));

const { runArchitect } = await import('./architect.js');

describe('pipeline smoke: Architect (Step 1)', () => {
  it('produces a ProjectBrief that satisfies the schema contract', async () => {
    const env = {} as Env;
    const { brief, model } = await runArchitect(
      'A dog park finder app for pet owners',
      env,
      null
    );

    expect(brief.appName).toBeTruthy();
    expect(['web', 'mobile', 'fullstack']).toContain(brief.appType);
    expect(brief.coreFeatures.length).toBeGreaterThan(0);
    expect(brief.dataModels.length).toBeGreaterThan(0);
    expect(['simple', 'moderate', 'complex']).toContain(brief.complexity);
    expect(typeof model).toBe('string');
  });

  it('surfaces a GenerationError when the model returns unparseable JSON', async () => {
    const cohereLib = await import('../../lib/cohere.js');
    vi.mocked(cohereLib.callAgentModel).mockResolvedValueOnce({
      data: {
        id: 'bad-response',
        message: { role: 'assistant', content: 'not json' },
        finishReason: 'complete',
        usage: { billedTokens: 10, inputTokens: 5, outputTokens: 5 },
      },
      cost: { inputTokens: 5, outputTokens: 5, billedTokens: 10 },
    } as never);

    await expect(
      runArchitect('A dog park finder app for pet owners', {} as Env, null)
    ).rejects.toThrow(/invalid JSON/i);
  });
});
