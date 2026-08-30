import {
  BUDGET,
  estimateCostUsd,
  RERANK_COST_PER_CALL_USD,
} from '../config.ts';

/** Tracks running Cohere/OpenRouter spend across the harness so the
 * pipeline-simulation check can abort (not the whole harness) before
 * exceeding its per-run cap, and the harness overall can stop issuing any
 * further paid calls once the total cap is close. This is an ESTIMATE based
 * on tokens_in/tokens_out recorded in D1's pipeline_steps table times the
 * published per-model rate — it is not a real-time balance read from
 * Cohere's billing API (no such endpoint is used here), so treat it as a
 * conservative approximation, not a reconciled invoice. */
export class CostTracker {
  private spentUsd = 0;
  private readonly log: Array<{ label: string; usd: number }> = [];

  get totalUsd(): number {
    return this.spentUsd;
  }

  get entries(): ReadonlyArray<{ label: string; usd: number }> {
    return this.log;
  }

  addModelCall(
    label: string,
    model: string,
    tokensIn: number,
    tokensOut: number
  ): number {
    const usd = estimateCostUsd(model, tokensIn, tokensOut);
    this.spentUsd += usd;
    this.log.push({ label, usd });
    return usd;
  }

  addRerankCall(label: string, calls = 1): number {
    const usd = RERANK_COST_PER_CALL_USD * calls;
    this.spentUsd += usd;
    this.log.push({ label, usd });
    return usd;
  }

  /** Would adding `usd` more spend push this run over its per-run cap? */
  wouldExceedRunCap(additionalUsd: number): boolean {
    return this.spentUsd + additionalUsd > BUDGET.perRunUsd;
  }

  wouldExceedTotalCap(additionalUsd: number): boolean {
    return this.spentUsd + additionalUsd > BUDGET.totalUsd;
  }
}
