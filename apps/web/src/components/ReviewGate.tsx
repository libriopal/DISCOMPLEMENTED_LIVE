/**
 * The human approval gate.
 *
 * §3.4: "Make the review gate the centre of the experience. **Appendix A.3:**
 * none of the 29 crawled competitors exposes a human approval gate as a
 * headline feature. It is the one structural claim this product can make that
 * the field does not, which is why it gets the scarcest colour in the system."
 *
 * Before this, the gate was three small buttons inside one card in a 360px
 * sidebar, in the same emerald and red as any other confirm/cancel pair — the
 * product's single differentiating moment rendered as a dialog footer. It is
 * now its own panel, it sits above the agent thread rather than inside it, and
 * it is the only element on this surface allowed the signal colour.
 *
 * Two scarcity rules apply and both are held by tests:
 *  - Appendix B.2: magenta appears at most twice on a surface. Here it is the
 *    gate panel and the gate's stage in the rail — the same gate, said in two
 *    places. `styles/gate-scarcity.test.ts` asserts nothing else claims it.
 *  - Appendix B.7: the signal role carries over into the product, and the
 *    review gate is its obvious claimant.
 *
 * The copy states what each choice *does*, not what it is called. "Approve"
 * alone does not tell a founder that the next thing to happen is a build.
 */
import { useState } from 'react';

export interface ReviewGateProps {
  /** What the pipeline is asking about, e.g. "the blueprint". */
  subject?: string;
  onDecide: (approved: boolean, feedback?: string) => void;
  /** Set while a decision is in flight, so it cannot be sent twice. */
  busy?: boolean;
}

export function ReviewGate({
  subject = 'the blueprint',
  onDecide,
  busy = false,
}: ReviewGateProps) {
  const [feedback, setFeedback] = useState('');
  const [changing, setChanging] = useState(false);

  return (
    <section
      className="review-gate"
      role="region"
      aria-label="Review gate — your approval is required"
    >
      <h2 className="review-gate__title">Your review</h2>
      <p className="review-gate__body">
        The pipeline has stopped and is waiting on you. Nothing is built until
        you approve {subject}.
      </p>

      {changing ? (
        <div className="review-gate__form">
          <label className="review-gate__label" htmlFor="review-gate-feedback">
            What should change?
          </label>
          <textarea
            id="review-gate-feedback"
            className="review-gate__textarea"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="The blueprint has no way to sign in…"
            rows={3}
          />
          <div className="review-gate__actions">
            <button
              type="button"
              className="review-gate__btn review-gate__btn--signal"
              disabled={busy || feedback.trim().length === 0}
              onClick={() => {
                onDecide(false, feedback.trim());
                setChanging(false);
                setFeedback('');
              }}
            >
              Send back to Design
            </button>
            <button
              type="button"
              className="review-gate__btn"
              onClick={() => setChanging(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="review-gate__actions">
          <button
            type="button"
            className="review-gate__btn review-gate__btn--signal"
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            Approve — start the build
          </button>
          <button
            type="button"
            className="review-gate__btn"
            disabled={busy}
            onClick={() => setChanging(true)}
          >
            Request changes
          </button>
        </div>
      )}

      <p className="review-gate__note">
        This gate is on by default. It is the point of the pipeline, not a step
        in it.
      </p>
    </section>
  );
}
