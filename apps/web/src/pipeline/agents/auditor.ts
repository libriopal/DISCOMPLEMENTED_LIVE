/**
 * Agent 2 — Auditor (Research Audit). Audits the Researcher's findings
 * for completeness, bias, and feasibility. Runs after the Researcher,
 * before the Verifier. Uses Command A for deep reasoning.
 *
 * The Auditor's job:
 *   1. Check if the research covers all core features from the brief
 *   2. Flag missing considerations (security, performance, accessibility)
 *   3. Identify biases or overly optimistic assumptions
 *   4. Validate that the tech stack choices are appropriate
 *   5. Produce a structured audit report with pass/fail + recommendations
 *
 * Like the Designer, this agent retries a schema failure with the validation
 * error fed back as a message, up to MAX_RETRIES times. It used to throw on the
 * first `safeParse` miss, which killed the whole run: measured in production
 * 2026-08-28, a run died with `findings[3] Expected object, received number`
 * — the model had emitted three well-formed findings and then a bare number in
 * the fourth slot. One retry is enough for that shape of mistake, and the run
 * that died had no cheaper recovery than starting over from the Researcher.
 */
import { z } from 'zod';
import { GenerationError } from '@bicameral/shared/errors';
import type { ProjectBrief, ResearchFindings } from '@bicameral/shared/types';
import type { ChatMessage } from '@bicameral/cohere/chat';
import { callAgentModel, selectModel } from '../../lib/cohere.js';
import { findSimilarPatterns } from '../lattice-enrich.js';
import { runSubconscious } from '../subconscious.js';
import type { Env } from '../../env.js';

export const AUDITOR_SYSTEM = `You are the Auditor agent in a software development team.
Your job is to critically audit the Researcher's findings for a project brief.
You are the quality gate — nothing proceeds to design until you approve the research.

Check for:
1. COVERAGE: Does the research address ALL core features in the brief?
2. BIAS: Are there overly optimistic assumptions or missing risk factors?
3. FEASIBILITY: Are the tech stack choices realistic for the complexity level?
4. GAPS: What critical considerations are missing? (security, performance, a11y)
5. DEPENDENCIES: Are external dependencies properly identified and documented?

Be specific and actionable. If the research is incomplete, say exactly what's
missing so the Researcher can fix it on retry.

Do not report a coverage percentage or any other numeric score. State what you
found and what is missing; a number here would look measured and would not be.

Respond with ONLY a JSON object matching this exact shape (no prose, no markdown fences):
{
  "summary": string,
  "passed": boolean,
  "findings": [{
    "type": "coverage" | "bias" | "feasibility" | "gap" | "dependency",
    "severity": "critical" | "warning" | "info",
    "description": string,
    "recommendation": string
  }],
  "recommendations": string[]
}`;

/** Matches `MAX_RETRIES` in designer.ts — same failure class, same budget. */
const MAX_RETRIES = 2;

/**
 * `coverageScore: z.number().min(0).max(100)` used to sit below `passed`, and
 * the orchestrator rendered it to the founder as `Coverage: 87%` and stored it
 * on the run, which `GET /api/pipeline/:id` returns whole.
 *
 * Nothing computed it. It was a number the model was asked for and produced,
 * bounded to 0–100 by this schema and by nothing else — no denominator, no
 * method, not reproducible from anything in this repo. That is the same defect
 * as the 91.3% figure, arriving by a different door: a percentage that reads as
 * a measurement because of where it is printed. It is removed rather than
 * relabelled, because the honest version of it does not exist.
 *
 * What the audit actually produces is the findings: typed, severity-graded, and
 * each one a specific claim the founder can check. Those are what the gate
 * reads and what the founder now sees.
 */
const auditorOutputSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  findings: z.array(
    z.object({
      type: z.enum(['coverage', 'bias', 'feasibility', 'gap', 'dependency']),
      severity: z.enum(['critical', 'warning', 'info']),
      description: z.string(),
      recommendation: z.string(),
    })
  ),
  recommendations: z.array(z.string()),
});

export interface AuditResult {
  summary: string;
  passed: boolean;
  findings: Array<{
    type: string;
    severity: string;
    description: string;
    recommendation: string;
  }>;
  recommendations: string[];
}

export async function runAuditor(
  brief: ProjectBrief,
  research: ResearchFindings,
  env: Env,
  feedback?: string | null,
  projectId?: string | null,
  tier?: 'free' | 'pro' | 'team' | 'enterprise'
): Promise<{
  audit: AuditResult;
  tokensIn: number;
  tokensOut: number;
  model: string;
}> {
  // Subconscious Layer: retrieve past audit patterns + rerank + intuition
  const auditQuery = `Audit task: ${brief.appType} app "${brief.appName}" — features: ${brief.coreFeatures.join(', ')}, complexity: ${brief.complexity}`;
  const similarPatterns = await findSimilarPatterns(
    env,
    projectId ?? null,
    auditQuery,
    'semantic'
  );
  const subconscious = await runSubconscious({
    query: auditQuery,
    patterns: similarPatterns,
    agentRole: 'auditor',
    tier: tier ?? 'free',
    env,
  });

  const conversation: ChatMessage[] = [
    { role: 'system', content: AUDITOR_SYSTEM },
    {
      role: 'user',
      content:
        `Project Brief:\n${JSON.stringify(brief, null, 2)}\n\n` +
        `Research Findings:\n${JSON.stringify(research, null, 2)}` +
        (subconscious.contextBlock || '') +
        (feedback
          ? `\n\nPrevious audit feedback — address this:\n${feedback}`
          : ''),
    },
  ];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // On retry, hand the model its own validation error so it can self-correct.
    if (attempt > 0 && lastError) {
      conversation.push({
        role: 'assistant',
        content: '{error: previous response failed validation}',
      });
      conversation.push({
        role: 'user',
        content: `Your previous response failed validation with this error:\n\n${lastError}\n\nReturn a valid JSON object matching the shape above. Every entry in "findings" must be an object with type, severity, description and recommendation — not a number or a string. "recommendations" is an array of strings.`,
      });
    }

    const response = await callAgentModel(
      'auditor',
      'simple',
      {
        messages: [...conversation],
        responseFormat: { type: 'json_object' },
        temperature: attempt === 0 ? 0.3 : 0.1, // lower temp on retry
      },
      env,
      tier
    );

    totalTokensIn += response.data.usage.inputTokens;
    totalTokensOut += response.data.usage.outputTokens;

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.data.message.content);
    } catch {
      lastError = 'Invalid JSON — could not parse the response';
      continue;
    }

    const result = auditorOutputSchema.safeParse(parsed);
    if (result.success) {
      return {
        audit: result.data,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        // Derived from the router with the same arguments the dispatch above
        // used, so the persisted label can't drift from what actually ran. It
        // used to be the literal 'command-a-03-2025' while the router had moved
        // to command-a-reasoning-08-2025 (finding M-19).
        model: selectModel('auditor', 'simple', tier, env),
      };
    }

    lastError = result.error.message;
    console.warn(
      `Auditor attempt ${attempt + 1}/${MAX_RETRIES + 1} failed validation: ${lastError.slice(0, 200)}`
    );
  }

  throw new GenerationError(
    `Auditor output failed validation after ${MAX_RETRIES + 1} attempts. Last error: ${lastError}`,
    'AUDITOR_INVALID_SCHEMA'
  );
}
