/**
 * Check 3 — Pipeline simulation.
 *
 * ONE synthetic founder run through the real 4-agent pipeline
 * (Architect -> Researcher -> Designer -> [human gate, scripted approval]
 * -> Coder) via local `wrangler dev`, using the dedicated QA-loop test
 * tenant/virtual key (see testTenant.ts). This makes REAL Cohere/OpenRouter
 * API calls and incurs REAL spend against agent_docs/cohere-integration.md
 * pricing — budget-capped per config.ts's BUDGET.perRunUsd ($1.00).
 *
 * Cost is estimated from pipeline_steps.tokens_in/tokens_out (written by
 * GenerationOrchestrator.completeStep) against the published per-model
 * rates, polled periodically WHILE the run is in flight so a run trending
 * over budget can be cancelled (POST /:id/cancel) mid-flight rather than
 * discovered only after the fact. This is a real cap enforced during the
 * run, not just an after-the-fact report note.
 */
import { LOCAL_API_BASE_URL, BUDGET, estimateCostUsd } from '../config.ts';
import { d1Rows } from '../util/d1.ts';
import type { CheckFinding, CheckResult } from '../types.ts';
import type { TestTenant } from '../testTenant.ts';

const SYNTHETIC_FOUNDER_PROMPT =
  'Build me a simple habit tracker where I can add daily habits, check them off, and see a streak count for each one. Keep it minimal — just one page.';

// Wall-clock ceiling for the whole simulated run (Architect + Researcher +
// Designer are typically well under a minute combined; Coder can run up to
// PIPELINE_DEFAULTS.maxCoderIterations=5 iterations against Command A in the
// worst case, plus the security-gate GitHub Actions round trip, which this
// harness does not wait on indefinitely). Chosen generously but finite so a
// stuck local run doesn't hang the harness forever.
const MAX_WAIT_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const BUDGET_POLL_EVERY_N_TICKS = 3;

interface PipelineRunRow {
  id: string;
  status: string;
  current_step: number;
  current_agent: string | null;
  error_message: string | null;
  deployment_url: string | null;
}

interface PipelineStepRow {
  id: string;
  step_number: number;
  agent_role: string;
  model_used: string;
  status: string;
  iteration: number;
  tokens_in: number;
  tokens_out: number;
}

async function fetchRun(id: string): Promise<PipelineRunRow | null> {
  const rows = await d1Rows<PipelineRunRow>(
    `SELECT id, status, current_step, current_agent, error_message, deployment_url FROM pipeline_runs WHERE id = '${id}'`
  );
  return rows[0] ?? null;
}

async function fetchSteps(id: string): Promise<PipelineStepRow[]> {
  return d1Rows<PipelineStepRow>(
    `SELECT id, step_number, agent_role, model_used, status, iteration, tokens_in, tokens_out FROM pipeline_steps WHERE pipeline_run_id = '${id}' ORDER BY step_number ASC, created_date ASC`
  );
}

function computeSpendFromSteps(steps: PipelineStepRow[]): {
  usd: number;
  byStep: Record<string, number>;
} {
  let usd = 0;
  const byStep: Record<string, number> = {};
  for (const step of steps) {
    if (step.status !== 'completed') continue;
    const cost = estimateCostUsd(
      step.model_used,
      step.tokens_in ?? 0,
      step.tokens_out ?? 0
    );
    usd += cost;
    byStep[
      `step${step.step_number}(${step.agent_role})/iter${step.iteration}`
    ] = cost;
  }
  return { usd, byStep };
}

export async function runPipelineSimulationCheck(
  tenant: TestTenant | null
): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];
  const details: Record<string, unknown> = {};

  if (!tenant) {
    return {
      id: 'pipeline-simulation',
      title: 'Pipeline Simulation (1 synthetic founder run)',
      status: 'skipped',
      summary:
        'No test tenant available — pipeline simulation requires a virtual key.',
      findings: [
        {
          severity: 'medium',
          message: 'Test tenant creation failed earlier; simulation skipped.',
        },
      ],
      durationMs: Date.now() - start,
      unverifiable: true,
      unverifiableReason: 'Test tenant unavailable.',
    };
  }

  let pipelineId: string | null = null;
  let budgetCapped = false;
  let cancelledForBudget = false;

  try {
    const createRes = await fetch(`${LOCAL_API_BASE_URL}/api/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.rawVirtualKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: SYNTHETIC_FOUNDER_PROMPT }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!createRes.ok) {
      const bodyText = await createRes.text().catch(() => '');
      return {
        id: 'pipeline-simulation',
        title: 'Pipeline Simulation (1 synthetic founder run)',
        status: 'fail',
        summary: `POST /api/pipeline failed: ${createRes.status} ${bodyText.slice(0, 300)}`,
        findings: [
          {
            severity: 'high',
            message: `Founder could not even start a pipeline run: POST /api/pipeline -> ${createRes.status}. ${bodyText.slice(0, 300)}`,
          },
        ],
        durationMs: Date.now() - start,
      };
    }

    const created = (await createRes.json()) as {
      pipelineId: string;
      status: string;
    };
    pipelineId = created.pipelineId;
    findings.push({
      severity: 'info',
      message: `Pipeline run created: ${pipelineId}`,
    });

    let approved = false;
    let ticks = 0;
    let lastStatus = '';
    let lastAgent = '';
    const statusTimeline: string[] = [];

    while (Date.now() - start < MAX_WAIT_MS) {
      ticks++;
      const run = await fetchRun(pipelineId);
      if (!run) {
        findings.push({
          severity: 'high',
          message: 'Pipeline run row vanished from D1 mid-run.',
        });
        break;
      }
      if (run.status !== lastStatus || run.current_agent !== lastAgent) {
        statusTimeline.push(
          `${new Date().toISOString()} status=${run.status} agent=${run.current_agent ?? '-'} step=${run.current_step}`
        );
        lastStatus = run.status;
        lastAgent = run.current_agent ?? '';
      }

      if (run.status === 'awaiting_approval' && !approved) {
        // Script the human-gate approval — this IS the human gate in
        // CLAUDE.md's pipeline diagram; a synthetic founder run has to pass
        // through it to reach Step 4, so this harness approves on its
        // behalf rather than treating the gate itself as a failure.
        const approveRes = await fetch(
          `${LOCAL_API_BASE_URL}/api/pipeline/${pipelineId}/approve`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tenant.rawVirtualKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              approved: true,
              feedback: 'qa-loop: auto-approved synthetic founder run',
            }),
            signal: AbortSignal.timeout(15_000),
          }
        );
        approved = true;
        if (!approveRes.ok) {
          findings.push({
            severity: 'high',
            message: `Blueprint approval failed: POST /:id/approve -> ${approveRes.status}`,
          });
          break;
        }
        findings.push({
          severity: 'info',
          message:
            'Blueprint gate: auto-approved (scripted) to continue to Coder step.',
        });
      }

      if (['deployed', 'error', 'paused'].includes(run.status)) {
        break;
      }

      // Budget check — every few ticks, not every tick, to avoid hammering
      // wrangler d1 execute (each invocation is a subprocess).
      if (ticks % BUDGET_POLL_EVERY_N_TICKS === 0) {
        const steps = await fetchSteps(pipelineId);
        const { usd } = computeSpendFromSteps(steps);
        if (usd > BUDGET.perRunUsd) {
          budgetCapped = true;
          findings.push({
            severity: 'high',
            message: `Estimated spend $${usd.toFixed(4)} exceeded the $${BUDGET.perRunUsd.toFixed(2)} per-run cap mid-flight — cancelling this run.`,
          });
          await fetch(
            `${LOCAL_API_BASE_URL}/api/pipeline/${pipelineId}/cancel`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${tenant.rawVirtualKey}` },
              signal: AbortSignal.timeout(10_000),
            }
          ).catch(() => undefined);
          cancelledForBudget = true;
          break;
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    details.statusTimeline = statusTimeline;

    if (!cancelledForBudget && Date.now() - start >= MAX_WAIT_MS) {
      findings.push({
        severity: 'medium',
        message: `Pipeline run did not reach a terminal state within ${MAX_WAIT_MS / 1000}s wall-clock cap — treated as a timeout, not a hang forever. Last known status: ${lastStatus}/${lastAgent}.`,
      });
    }

    const finalRun = await fetchRun(pipelineId);
    const finalSteps = await fetchSteps(pipelineId);
    const { usd: finalSpend, byStep } = computeSpendFromSteps(finalSteps);
    details.finalRun = finalRun;
    details.steps = finalSteps;
    details.spendByStep = byStep;
    details.estimatedSpendUsd = finalSpend;

    const iterationCount = finalSteps.filter(
      (s) => s.agent_role === 'coder'
    ).length;
    const modelsUsed = [...new Set(finalSteps.map((s) => s.model_used))];

    findings.push({
      severity: 'info',
      message: `Models selected: ${modelsUsed.join(', ') || '(none reached)'}. Coder iterations: ${iterationCount}. Total wall time: ${((Date.now() - start) / 1000).toFixed(1)}s. Estimated Cohere/OpenRouter spend: $${finalSpend.toFixed(4)} (cap: $${BUDGET.perRunUsd.toFixed(2)}).`,
    });

    if (finalRun?.status === 'deployed') {
      findings.push({
        severity: 'info',
        message: `Pipeline reached 'deployed'. deployment_url=${finalRun.deployment_url ?? '(none)'}`,
      });
    } else if (finalRun?.status === 'error') {
      findings.push({
        severity: 'medium',
        message: `Pipeline failed cleanly with status=error: ${finalRun.error_message ?? '(no error_message recorded)'}. A clean failure (not a hang, not a silent 200) is itself a pass condition for "does this fail loudly" — but the underlying cause is worth triage.`,
      });
    } else if (finalRun?.status === 'paused') {
      findings.push({
        severity: 'medium',
        message:
          'Pipeline paused (approval gate timeout) — unexpected since this harness scripts approval; check gate timing.',
      });
    }

    const status: CheckResult['status'] = budgetCapped
      ? 'warn'
      : finalRun?.status === 'deployed'
        ? 'pass'
        : finalRun?.status === 'error'
          ? 'warn'
          : 'fail';

    return {
      id: 'pipeline-simulation',
      title: 'Pipeline Simulation (1 synthetic founder run)',
      status,
      summary: budgetCapped
        ? `Budget-capped, partial: run cancelled after exceeding the $${BUDGET.perRunUsd.toFixed(2)} per-run cap.`
        : `Final status: ${finalRun?.status ?? 'unknown'}. Estimated spend: $${finalSpend.toFixed(4)}.`,
      findings,
      details,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: 'pipeline-simulation',
      title: 'Pipeline Simulation (1 synthetic founder run)',
      status: 'error',
      summary: `Pipeline simulation threw: ${err instanceof Error ? err.message : String(err)}`,
      findings: [
        {
          severity: 'high',
          message: `Unhandled error during pipeline simulation: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        },
      ],
      details,
      durationMs: Date.now() - start,
    };
  }
}
