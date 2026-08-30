/**
 * The run, said out loud, above the IDE.
 *
 * §3.4: "a user watching the pipeline should be able to answer, at any moment,
 * *what is happening, why, and what happens next* — without opening dev tools."
 *
 * What this replaced: a span reading `Researcher...` and a second reading
 * `Instant preview`. The five-stage rail existed, but only on the *empty*
 * screen — it vanished the moment a run started, so the screen was at its most
 * legible when there was nothing to be legible about. There was no elapsed
 * time, no model, and no statement of what the run was waiting on anywhere.
 *
 * Every sentence rendered here comes from lib/pipeline-legibility.ts, which is
 * unit-tested. This file is layout.
 *
 * Colour, per Appendix B.2 and B.7: the rail is structure (gold), the running
 * stage is accent (cyan), and **signal (magenta) is used only for the review
 * gate** — the one stage that stops and asks a human. That is the surface's
 * whole allowance for it, and `styles/gate-scarcity.test.ts` holds the rule.
 */
import { useEffect, useState } from 'react';
import {
  PIPELINE_STAGES,
  describeTier,
  formatElapsed,
  stageStatuses,
  waitingOn,
  type PreviewTier,
  type RunSnapshot,
} from '../lib/pipeline-legibility.js';
import type { Verboseness } from '../lib/verboseness.js';

export interface PipelineStatusProps {
  snapshot: RunSnapshot;
  /** ISO timestamp from the run's own row. Null before the stream reports it. */
  startedAt: string | null;
  /** Which model is serving the current stage, if known. */
  model?: string | null;
  /** Withholds the model below `verbose`, matching what the transcript
   * promises at each level — see lib/verboseness.ts. */
  verboseness: Verboseness;
  tier: PreviewTier;
  /** True once the Tier 3 container is serving. Only meaningful for `sandbox`. */
  backendRunning?: boolean;
}

/**
 * A clock that ticks, reading from a server-supplied start.
 *
 * Once per second, and only while the run is live: a finished run's elapsed
 * time is a fact, and re-rendering the tree every second to redraw the same
 * number is a cost with nothing on the other side of it.
 */
function useElapsed(startedAt: string | null, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) return null;
  const began = Date.parse(startedAt);
  if (Number.isNaN(began)) return null;
  return Math.max(0, now - began);
}

const STATUS_MARK: Record<string, string> = {
  done: '✓',
  active: '',
  gate: '',
  failed: '✕',
  pending: '',
};

export function PipelineStatus({
  snapshot,
  startedAt,
  model,
  verboseness,
  tier,
  backendRunning,
}: PipelineStatusProps) {
  const live = !snapshot.finished && !snapshot.error;
  const elapsedMs = useElapsed(startedAt, live);
  const elapsed = formatElapsed(elapsedMs);
  const statuses = stageStatuses(snapshot);
  const waiting = waitingOn(snapshot);
  const preview = describeTier(tier);

  const doneCount = statuses.filter((s) => s === 'done').length;

  return (
    <section className="pipe-status" aria-label="Pipeline status">
      <ol className="pipe-rail">
        {PIPELINE_STAGES.map((stage, index) => {
          const status = statuses[index];
          return (
            <li
              key={stage.agent}
              className={`pipe-rail__stage pipe-rail__stage--${status}`}
              // The title is the "why". It is also on screen in the line
              // below for the running stage; here it covers the other four
              // without spending five lines of vertical space on them.
              title={stage.purpose}
              aria-current={
                status === 'active' || status === 'gate' ? 'step' : undefined
              }
            >
              <span className="pipe-rail__mark" aria-hidden="true">
                {STATUS_MARK[status] || stage.step}
              </span>
              <span className="pipe-rail__label">{stage.label}</span>
              <span className="sr-only">
                {status === 'gate' ? 'awaiting your review' : status}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="pipe-status__line">
        {/* Not a percentage. A count of stages finished against stages that
            exist, and the denominator is the rail directly above it. */}
        <span className="pipe-status__count">
          Stage {Math.min(doneCount + 1, PIPELINE_STAGES.length)} of{' '}
          {PIPELINE_STAGES.length}
        </span>

        <span
          className={`pipe-status__now pipe-status__now--${waiting.subject}`}
          role="status"
        >
          {waiting.now}
        </span>

        {elapsed && (
          <span className="pipe-status__elapsed" title="Since the run started">
            {elapsed}
          </span>
        )}

        {/* Withheld below verbose so that this header and the transcript agree
            about what each level shows. The value arrives on the SSE stream
            either way — see usePipeline's `modelByStep`. */}
        {verboseness === 'verbose' && model && (
          <span className="pipe-status__model" title="Model serving this stage">
            {model}
          </span>
        )}
      </div>

      <p className="pipe-status__next">{waiting.next}</p>

      {/* The three tiers as three different states, not one word apart.
          `limit` is what makes them different, and Tier 3 is the one with
          none — which is the whole reason it exists. */}
      <div className="pipe-status__preview">
        <span className={`pipe-tier pipe-tier--${tier}`}>{preview.label}</span>
        <span className="pipe-status__preview-text">
          {tier === 'sandbox' && backendRunning
            ? 'A real dev server and your API server are running in a container.'
            : preview.summary}
          {preview.limit ? ` ${preview.limit}` : ''}
        </span>
      </div>
    </section>
  );
}
