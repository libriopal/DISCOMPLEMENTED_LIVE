-- Better Auth rate-limit storage.
--
-- `rateLimit.storage` defaults to "memory" (@better-auth/core create-context:
-- `options.rateLimit?.storage || (options.secondaryStorage ? "secondary-storage" : "memory")`),
-- and the memory backend is a module-level `Map` in
-- better-auth/dist/api/rate-limiter/index.mjs. On Cloudflare Workers that Map
-- lives inside a single isolate: consecutive requests from one client can land
-- on different isolates, and any isolate can be evicted between them, so the
-- counter never reliably accumulates. Verified against production on
-- 2026-08-25 — eight back-to-back wrong-password POSTs to
-- /api/auth/sign-in/email all returned 401 and never a 429, despite
-- `rateLimit.enabled: true` and better-auth's own stricter built-in rule for
-- that path (window=10s, max=3).
--
-- Switching to `storage: "database"` puts the counter in D1, which every
-- isolate shares, and lets the limiter use its atomic `incrementOne` path
-- instead of the best-effort read-then-write fallback.
--
-- Column names are the snake_case mapping declared in lib/auth.ts
-- (`rateLimit.fields`), matching how every other Better Auth model in this
-- schema is mapped.
CREATE TABLE IF NOT EXISTS auth_rate_limit (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL DEFAULT 0,
  last_request INTEGER NOT NULL
);

-- The limiter looks rows up only by `key`; UNIQUE already indexes it. This
-- index is for the sweep direction — finding stale windows to prune.
CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_last_request
  ON auth_rate_limit(last_request);
