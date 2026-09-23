-- Two holes in the grant guard, both found by the independent §4B audit on the
-- commit that introduced it.
--
-- 1. REVOCATION DID NOT CLAW BACK THE BALANCE.
--    The reconcile demoted a revoked nonprofit account to 'free' and left
--    credits_remaining at the nonprofit grant. The monthly grant statement
--    excludes 'free', so nothing ever reduced or expired that balance: a
--    revoked account went on spending team-volume credits indefinitely, which
--    is the exact loss the revocation exists to stop. Demoting without
--    clamping is revocation that revokes nothing.
--
-- 2. THE GUARD PENALISED SAME-MONTH RESUBSCRIPTION.
--    credits_granted_at was keyed to the USER, not to what they were granted
--    FOR. A Pro subscriber who downgraded on the 5th and resubscribed on the
--    10th kept '2026-09' on the row, so the guard refused to grant until
--    October: roughly three weeks of a paid month delivering nothing, to a
--    customer who had paid. The guard assumed one grant event per user per
--    month; a subscription can change within a month.
--
-- credits_granted_tier records WHICH tier's grant was last paid, so the two
-- questions the guard actually needs to ask -- "have they been paid this
-- month?" and "paid for WHICH entitlement?" -- can both be answered.
--
-- An upgrade mid-month tops up the DIFFERENCE rather than paying a second
-- full grant, so the cycle free -> pro -> free -> pro cannot farm grants: the
-- second upgrade sees credits_granted_tier already 'pro' for this month and
-- pays nothing. A downgrade pays nothing either, because the larger grant was
-- already delivered.

ALTER TABLE users ADD COLUMN credits_granted_tier TEXT;

-- Backfill: every row that has already been granted this month was granted at
-- its current tier, which is the only thing that was true under the old guard.
-- Leaving these NULL would make the first run after this migration treat every
-- existing subscriber as never-granted and pay a second grant in the same
-- month -- the migration would cause the overspend it exists to prevent.
UPDATE users
   SET credits_granted_tier = tier
 WHERE credits_granted_at IS NOT NULL
   AND credits_granted_tier IS NULL;
