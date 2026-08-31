/**
 * Modular blocks the Memory Lattice says this project needs and this blueprint
 * does not have. Rendered under the review gate, while the founder is deciding.
 *
 * Three constraints shape what this component is allowed to be:
 *
 *  - **It proposes; it never applies.** There is no "add this block" button,
 *    because nothing on the server would accept one — `/block-suggestions` is a
 *    GET and the blueprint is what the pipeline produced. A founder acts on one
 *    of these by putting it in the "request changes" box, which sends it back
 *    to the designer and keeps a record of who asked. Same boundary as
 *    §CORRECTION 7: surfaced loudly, applied by a person.
 *  - **Every proposal shows its source.** The rationale names the agent and the
 *    date the requirement was recorded. A suggestion that cannot say where it
 *    came from is a guess with a confident font.
 *  - **It does not take the gate's colour.** Appendix B.2 spends magenta twice
 *    on this surface — the gate panel and the gate's stage in the rail — and
 *    `styles/gate-scarcity.test.ts` fails on a third claimant. This panel is
 *    deliberately quiet: it sits below the decision, it is not the decision.
 *
 * An empty result renders its reason rather than nothing, because "your lattice
 * is empty" and "your blueprint already covers everything in it" are different
 * facts and a collapsed section states neither.
 *
 * ## Why the response shape is checked and never asserted
 *
 * This renders inside the gate's own subtree, so an exception thrown here does
 * not degrade a list of proposals — it unmounts the review gate and takes the
 * founder's ability to approve their blueprint with it. The first version cast
 * the response with `as` and read `.suggestions.length` off it, and the e2e
 * suite caught it immediately: `pipeline-legibility.spec.ts` stubs `/api/**`
 * with `{}`, that read threw, and two gate tests that have nothing to do with
 * suggestions went red because the region they look for no longer existed.
 * A `as` cast is a claim about a value that came off the network, and this is
 * the component that can least afford to be wrong about one.
 */
import { useEffect, useState } from 'react';

interface BlockSuggestion {
  id: string;
  title: string;
  rationale: string;
  blockType: string;
  sourceNodeIds: string[];
}

interface SuggestionsResponse {
  suggestions: BlockSuggestion[];
  reason: string | null;
}

function isBlockSuggestion(value: unknown): value is BlockSuggestion {
  const v = value as Partial<BlockSuggestion> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.rationale === 'string' &&
    typeof v.blockType === 'string'
  );
}

function isSuggestionsResponse(value: unknown): value is SuggestionsResponse {
  const v = value as Partial<SuggestionsResponse> | null;
  if (typeof v !== 'object' || v === null) return false;
  if (!Array.isArray(v.suggestions)) return false;
  if (!v.suggestions.every(isBlockSuggestion)) return false;
  // `reason` is what an empty list is rendered *as*. A response with no
  // suggestions and no reason would render an empty paragraph, which claims
  // nothing and looks like a bug.
  if (v.suggestions.length === 0 && typeof v.reason !== 'string') return false;
  return true;
}

export interface BlockSuggestionsProps {
  pipelineId: string | null;
  /** Only fetched at the gate — before then there is no blueprint to gap-check. */
  enabled: boolean;
}

export function BlockSuggestions({
  pipelineId,
  enabled,
}: BlockSuggestionsProps) {
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !pipelineId) return;
    let cancelled = false;
    setFailed(false);
    fetch(`/api/pipeline/${pipelineId}/block-suggestions`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<unknown>;
      })
      .then((body) => {
        // The shape is checked rather than asserted. This component renders
        // directly beneath the review gate, inside the same subtree, so an
        // exception thrown here does not degrade a suggestion list — it
        // unmounts the gate and removes the founder's ability to approve
        // anything. A panel of proposals must never be able to do that, so a
        // response that is not the shape we asked for is treated exactly like
        // a response that never arrived.
        if (cancelled) return;
        if (isSuggestionsResponse(body)) setData(body);
        else setFailed(true);
      })
      .catch(() => {
        // Say so rather than rendering an empty list. An empty list here is a
        // claim about the lattice, and a failed fetch has made no such claim.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, pipelineId]);

  if (!enabled || !pipelineId) return null;

  if (failed) {
    return (
      <section
        className="mt-3 rounded-lg border border-[var(--border)] p-3"
        aria-label="Suggested blocks"
      >
        <p className="text-xs text-[var(--text-muted)]">
          Could not read this project’s Memory Lattice just now, so there are no
          suggestions to show. This does not affect the blueprint above.
        </p>
      </section>
    );
  }

  if (!data) return null;

  return (
    <section
      className="mt-3 rounded-lg border border-[var(--border)] p-3"
      aria-label="Suggested blocks"
    >
      <h3 className="text-sm font-medium text-[var(--text)]">
        From your Memory Lattice
      </h3>
      {data.suggestions.length === 0 ? (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{data.reason}</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Recorded in earlier runs on this project, with no matching component
            in this blueprint. To add one, use “Request changes” above and say
            which.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {data.suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className="rounded-md bg-[var(--surface-2)] p-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-[var(--text)]">
                    {suggestion.title}
                  </span>
                  <span className="text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                    {suggestion.blockType}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {suggestion.rationale}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
