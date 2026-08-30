/**
 * Human approval gate logic — the blueprint review checkpoint between
 * Step 3 (Design) and Step 4 (Implementation). Single source of truth for
 * gate state transitions, used by both `POST /api/pipeline/:id/approve`
 * (routes/pipeline.ts) and GenerationOrchestrator's alarm-based timeout.
 *
 * Workers can't block a request across the 24h timeout window, so "waiting"
 * is modeled as a DO alarm (GenerationOrchestrator.alarm(), scheduled when
 * the run enters `awaiting_approval`) rather than an in-memory wait — see
 * PIPELINE_DEFAULTS.approvalGateTimeoutMs. On timeout, the run is paused
 * (not cancelled) so a founder who comes back later can still approve/reject.
 */
import { PIPELINE_DEFAULTS } from '@bicameral/shared/constants';

export { PIPELINE_DEFAULTS };

export interface GateRunRow {
  status: string;
  gate_status: string | null;
}

export function isAwaitingApproval(run: GateRunRow): boolean {
  return run.status === 'awaiting_approval';
}

/** Approves or rejects the blueprint gate. Rejection restarts the pipeline
 * from Step 1 (Architect) with the founder's feedback folded into the next
 * prompt — see runArchitect's `feedback` param. */
export async function resolveGate(
  db: D1Database,
  pipelineRunId: string,
  approved: boolean,
  feedback: string | null
): Promise<{ status: string }> {
  const now = new Date().toISOString();

  // Read the current gate to determine which step to advance to
  const run = await db
    .prepare('SELECT current_gate FROM pipeline_runs WHERE id = ?')
    .bind(pipelineRunId)
    .first<{ current_gate: string | null }>();

  const currentGate = run?.current_gate ?? 'designer'; // default to designer (main gate)

  if (approved) {
    // Map the current gate to the next pipeline status
    const nextStatus: Record<string, string> = {
      researcher: 'auditing',   // Researcher → Auditor
      auditor: 'verifying',    // Auditor → Verifier
      verifier: 'designing',   // Verifier → Designer
      designer: 'implementing', // Designer → Coder (main gate)
    };
    const status = nextStatus[currentGate] ?? 'implementing';

    await db
      .prepare(
        "UPDATE pipeline_runs SET status = ?, gate_status = 'approved', gate_feedback = ?, current_gate = NULL, updated_date = ? WHERE id = ?"
      )
      .bind(status, feedback, now, pipelineRunId)
      .run();
    return { status };
  }

  // Rejected — increment iteration counter, check N_max, reset to gated step
  const MAX_ITERATIONS = 5; // Protocol: N_max = 5

  const runData = await db
    .prepare('SELECT iteration_count FROM pipeline_runs WHERE id = ?')
    .bind(pipelineRunId)
    .first<{ iteration_count: number }>();

  const currentIteration = runData?.iteration_count ?? 0;

  // If we've hit the max iteration limit, terminate with max_iterations_reached
  if (currentIteration >= MAX_ITERATIONS) {
    await db
      .prepare(
        `UPDATE pipeline_runs
         SET status = 'failed', gate_status = 'rejected', gate_feedback = ?,
             current_gate = NULL, pipeline_phase = 'rejected',
             final_verdict = 'MAX_ITERATIONS', error_message = ?,
             updated_date = ?
         WHERE id = ?`
      )
      .bind(feedback,
            `Max iterations (${MAX_ITERATIONS}) reached. Last gate (${currentGate}) rejected: ${feedback ?? 'no feedback'}`,
            now, pipelineRunId)
      .run();
    return { status: 'max_iterations_reached' };
  }

  // Increment iteration counter and reset to the gated step for retry
  const retryStatus: Record<string, string> = {
    researcher: 'researching',
    auditor: 'auditing',
    verifier: 'verifying',
    designer: 'designing',
  };
  const status = retryStatus[currentGate] ?? 'researching';

  await db
    .prepare(
      `UPDATE pipeline_runs
       SET status = ?, gate_status = 'rejected', gate_feedback = ?,
           current_gate = NULL, iteration_count = iteration_count + 1,
           pipeline_phase = ?,
           updated_date = ?
       WHERE id = ?`
    )
    .bind(status, feedback,
          status.replace('ing', ''), // 'researching' → 'research', etc.
          now, pipelineRunId)
    .run();
  return { status: 'restarted' };
}

/** Called from GenerationOrchestrator's alarm handler. No-ops if the gate
 * was already resolved (approved/rejected) before the alarm fired. */
export async function expireGateIfPending(
  db: D1Database,
  pipelineRunId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE pipeline_runs SET status = 'paused', gate_status = 'expired', updated_date = ? WHERE id = ? AND status = 'awaiting_approval'"
    )
    .bind(new Date().toISOString(), pipelineRunId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
