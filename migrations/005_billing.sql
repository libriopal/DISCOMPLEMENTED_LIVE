-- 005_billing.sql — Stripe billing (Task 3 / Phase C, commercial-launch
-- plan §5+§7): customer id persistence, subscription state, and webhook
-- idempotency dedup. See apps/web/src/lib/stripe.ts and
-- apps/web/src/routes/billing.ts.
--
-- NOTE: no real Stripe account exists yet (STRIPE_SECRET_KEY /
-- STRIPE_WEBHOOK_SECRET unset) — this schema is provisioned ahead of that,
-- same pattern as env.ts's Stripe secrets. Nothing here assumes live mode.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);

-- Subscription state for tier upgrades (Checkout mode: "subscription").
-- One-time credit-pack purchases (mode: "payment") don't need a row here —
-- they're fully captured by credit_ledger (type = 'credit').
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL, -- active | past_due | canceled (mirrors Stripe subscription.status)
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  current_period_end TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);

-- Webhook idempotency: Stripe retries a delivery on any non-2xx response,
-- and per Stripe's own docs an event can occasionally be delivered more
-- than once even after a prior 200 — dedup on event id before applying
-- credit/tier changes so a retry can't double-credit a user.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY, -- Stripe event id (evt_...), not a generated uuid
  event_type TEXT NOT NULL,
  processed_date TEXT NOT NULL
);
