-- The grant belongs to a BILLING EVENT, not to a calendar month.
--
-- Keying it on the month alone produced two requirements that cannot both be
-- satisfied, which is how you know the model was wrong:
--
--   * A Pro subscriber who downgraded on the 5th and resubscribed on the 10th
--     must be granted again — they paid again. Keyed on the month, the guard
--     refused until October: three weeks of a paid month delivering nothing.
--
--   * A user cycling free -> pro -> free -> pro must NOT collect a grant per
--     cycle. Keyed on anything that resets on downgrade, they could.
--
-- Both were true at once, so no rule over (month, tier) could satisfy them.
-- The distinguishing fact is not in that pair: it is whether a NEW SUBSCRIPTION
-- was paid for. That fact already exists in `subscriptions.stripe_subscription_id`.
--
-- credits_granted_ref stores `YYYY-MM:<subscription id>`, so:
--     same month, same subscription -> same ref  -> no grant   (no farming)
--     same month, NEW subscription  -> new ref   -> grant      (they paid)
--     new month,  same subscription -> new ref   -> grant      (next period)
--
-- Tiers with no subscription (nonprofit grants, enterprise contracts) fall back
-- to the tier name, so they keep the calendar-month behaviour they had.
--
-- The finding that led here came from the independent §4B audit; the conflict
-- between the two tests above is what showed the calendar guard could not be
-- patched into correctness.

ALTER TABLE users ADD COLUMN credits_granted_ref TEXT;

-- Backfill so the first run after this migration does not treat every existing
-- subscriber as never-granted and pay a second grant inside the same month --
-- the migration would otherwise cause the overspend it exists to prevent.
-- Rows already stamped this month are recorded against their current
-- subscription, which is the only thing that was true under the old guard.
-- THIS EXPRESSION MUST MATCH grantRefExpr() IN cron-handler.ts EXACTLY.
--
-- The first version of this backfill fell back to `tier` while the runtime
-- fell back to the constant '-'. They therefore never matched: every
-- backfilled nonprofit or enterprise row stored 'YYYY-MM:nonprofit' while the
-- next cron run computed 'YYYY-MM:-', the guard read "not yet granted", and a
-- second full grant was paid in the same month — the exact double-pay the
-- comment above claims this backfill prevents. Found by the independent §4B
-- audit before it shipped.
--
-- `grant-schedule.test.ts` now applies the migrations and then runs the real
-- statement, so a divergence between these two expressions fails a test rather
-- than paying out twice.
UPDATE users
   SET credits_granted_ref =
       substr(credits_granted_at, 1, 7) || ':' || COALESCE(
         (SELECT s.stripe_subscription_id || ':' || COALESCE(s.current_period_end, '')
            FROM subscriptions s
           WHERE s.user_id = users.id
             AND s.status = 'active'
        ORDER BY s.created_date DESC
           LIMIT 1),
         '-'
       )
 WHERE credits_granted_at IS NOT NULL
   AND credits_granted_ref IS NULL;
