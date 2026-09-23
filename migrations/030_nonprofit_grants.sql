-- Nonprofit grants, and the row that makes revocation mean something.
--
-- `packages/shared/src/nonprofit.ts` modelled a grant as revocable and wrote
-- `grantIsActive()` to say so. Nothing called it. The tier was added to
-- TIER_LIMITS, COHERE_MODELS, RATE_LIMITS, PAID_TIERS and the pricing page,
-- and no code path ever set a user's tier to 'nonprofit' or read a revocation.
--
-- That made the revocability the module calls "the whole design" unenforceable:
-- an operator could record revokedAt and the account would keep the team
-- product forever, because users.tier still said 'nonprofit', the monthly cron
-- kept topping it up, and entitlements.ts's PAID_TIERS kept answering "has this
-- user paid?" with yes. Found by the independent §4B audit.
--
-- A grant is a row here; the tier column is a CACHE of this row's verdict. The
-- cron reconciles the two, so revoking a grant demotes the account on the next
-- run whether or not anyone remembers to change the tier by hand.

CREATE TABLE IF NOT EXISTS nonprofit_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- WHO granted it. `grantIsActive()` refuses a grant with no named approver,
  -- because a grant nobody is attributable for is not one -- the same rule
  -- GLASSBOX Directive 6 applies to approvals.
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,

  -- WHAT was shown. Free product for an unevidenced claim of charity status is
  -- how this becomes a discount anyone can ask for. One of the documented
  -- evidence kinds in ELIGIBILITY_EVIDENCE.
  evidence_kind TEXT NOT NULL,
  evidence_ref TEXT,
  organisation TEXT,

  -- Withdrawal. Nullable, and null is the normal case.
  revoked_at TEXT,
  revoked_reason TEXT,

  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The reconciliation query asks "which granted accounts are no longer in
-- force?" on every cron run, so it is indexed on exactly that.
CREATE INDEX IF NOT EXISTS idx_nonprofit_grants_user
  ON nonprofit_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_nonprofit_grants_revoked
  ON nonprofit_grants(revoked_at);
