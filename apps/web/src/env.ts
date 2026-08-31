/**
 * Env — Cloudflare Workers bindings + secrets for @bicameral/web.
 * Mirrors wrangler.toml exactly. Phase 3's `src/index.ts` (route mounting)
 * and Phase 4's Durable Objects both bind against this same interface.
 */
export interface Env {
  // Static assets
  ASSETS: Fetcher;

  // D1 Database (11+ tables — see migrations/)
  DB: D1Database;

  // R2 Bucket (file storage)
  BUCKET: R2Bucket;

  // Vectorize (Memory Lattice embeddings — 1536 dims, cosine)
  LATTICE_INDEX: VectorizeIndex;

  // KV (kill switch, maintenance mode, config flags)
  CONFIG_KV: KVNamespace;

  // Analytics Engine (admin panel telemetry)
  ANALYTICS_ENGINE: AnalyticsEngineDataset;

  // Durable Objects
  GENERATION_DO: DurableObjectNamespace;
  LATTICE_DO: DurableObjectNamespace;
  PREVIEW_SANDBOX: DurableObjectNamespace;
  /** Admission control for the preview pool — see PreviewCapacity.ts. */
  PREVIEW_CAPACITY: DurableObjectNamespace;
  GLASS_ENGINE_DO: DurableObjectNamespace;

  // Secrets (set via `wrangler secret put`)
  COHERE_API_KEY: string;
  YDC_API_KEY: string;
  // Optional at the type level because it is optional in fact: predeploy
  // reports it unset as a warning, not a failure, and the research path
  // degrades without it (routes/pipeline.ts already coerces with `?? ''`).
  // Declaring it `string` told every new call site the key was guaranteed.
  SCITE_API_KEY?: string;
  // Tavily — web search + extraction for the research engine. Optional for
  // the same reason as SCITE_API_KEY: the phase degrades to "no Tavily
  // findings" rather than failing the run. Never declare it `string`.
  TAVILY_API_KEY?: string;
  GITHUB_TOKEN: string;
  // OpenRouter — alternate LLM provider (see lib/cohere.ts fallback)
  OPENROUTER_API_KEY: string;
  // NVIDIA Build — the independent auditor's provider since 2026-08-30, called
  // directly at integrate.api.nvidia.com rather than routed through
  // OpenRouter. Declared `string`, not optional, on purpose: the auditor has
  // no fallback by design (see CLAUDE.md, "No silent fallback"), so an unset
  // key must surface as a loud failure at the call, never as a skipped audit.
  NVIDIA_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  // GitHub OAuth — dual apps (dev app callback = localhost/*.workers.dev,
  // prod app callback = custom domain). See lib/auth.ts.
  GITHUB_OAUTH_CLIENT_ID_DEV: string;
  GITHUB_OAUTH_CLIENT_SECRET_DEV: string;
  GITHUB_OAUTH_CLIENT_ID_PROD: string;
  GITHUB_OAUTH_CLIENT_SECRET_PROD: string;
  // FluxyChat — self-hosted chat Worker (separate deployment, see
  // agent_docs/live-chat.md). FLUXYCHAT_API_KEY is the admin/project key
  // (mints member JWTs server-side with any roles).
  //
  // Correction to an earlier version of this comment, which said this key is
  // "also the shared secret FluxyChat's agent runtime sends back on
  // tool-execute callbacks". It is not, and no key is: FluxyChat sends no
  // credential on those callbacks at all. See verifyWebhookKey in
  // lib/fluxychat.ts for the measurement and for what authenticates them now.
  FLUXYCHAT_API_KEY?: string;
  // The user tier. Server-side too — the browser receives the short-lived
  // member JWT this key mints, never the key. Separate from the admin key so
  // a defect in the public /api/chat/session route cannot mint admin roles.
  // There is no fallback to FLUXYCHAT_API_KEY; see lib/fluxychat.ts.
  FLUXYCHAT_USER_API_KEY?: string;
  // The shared secret authenticating FluxyChat's inbound callbacks, carried in
  // the `?k=` parameter of the two URLs provisionSupportAgent registers. It is
  // neither of the keys above and must not be set to one of them: those are
  // presented outbound to FluxyChat, and reusing an outbound credential as an
  // inbound one means anyone who can read either direction can forge the other.
  // Optional in the type because an unset value degrades to a webhook that
  // refuses every call (verifyWebhookKey fails closed) rather than a crash.
  FLUXYCHAT_WEBHOOK_SECRET?: string;
  // Slack — operator alerting (lib/slack.ts). Optional: every caller treats
  // Slack as the SECOND record of an event that is already durable
  // elsewhere, so an unset token degrades to a logged line rather than
  // failing the request it was reporting on.
  SLACK_BOT_TOKEN?: string;
  // A channel ID (starts with "C"), not a "#name" — the bot has no
  // channels:read scope to resolve names with, and reading a workspace's
  // whole channel list is a far broader grant than posting to one channel.
  SLACK_ALERT_CHANNEL?: string;
  // Stripe — billing (routes wired in routes/billing.ts + lib/stripe.ts;
  // LIVE as of Aug 21, 2026 — Stripe account connected, all 3 secrets
  // provisioned on the worker. lib/stripe.ts makes real API calls.
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_SECRET_KEY: string;
  // Verifies the `Stripe-Signature` header on inbound webhook deliveries
  // (routes/billing.ts POST /api/billing/webhook) — see
  // https://docs.stripe.com/webhooks#verify-manually for the HMAC-SHA256
  // scheme lib/stripe.ts implements by hand (fetch-only, no stripe SDK).
  // Also unset — provisioned together with the two keys above once a real
  // Stripe account + webhook endpoint exist.
  STRIPE_WEBHOOK_SECRET: string;
  // Resend — transactional email (verification + password reset) for the
  // email/password auth path, see lib/auth.ts + lib/email.ts. Free tier:
  // 3,000 emails/mo, 100/day, no card required, 1 verified sending domain
  // (confirmed against resend.com/pricing 2026-08-11). PROVISIONED as a
  // production Worker secret — `wrangler secret list --env production` shows
  // it. If it is ever missing, lib/email.ts throws a clear error rather than
  // silently no-op'ing.
  RESEND_API_KEY: string;
  // Non-secret: the verified sending address, set in wrangler.toml [vars].
  // discomplemented.com carries Resend's DNS record set in Cloudflare (DKIM
  // at resend._domainkey; return-path MX + SPF on send.discomplemented.com),
  // so this is an address on that domain — NOT the onboarding@resend.dev
  // sandbox, which only delivers to the Resend account owner.
  RESEND_FROM_EMAIL: string;
  // Non-secret: where the support-chat escalation tool (lib/fluxychat.ts's
  // escalate_to_human) sends the founder-facing summary + transcript hint
  // for security/billing/legal issues the AI agent shouldn't try to
  // resolve itself. Optional — if unset, escalation is logged only (no
  // email sent), same "fail loud but don't break the chat" pattern as
  // RESEND_API_KEY above.
  SUPPORT_ESCALATION_EMAIL?: string;
  // Analytics Engine SQL API (admin panel bottleneck/metrics queries — the
  // ANALYTICS_ENGINE binding above is write-only). Optional: unset in local
  // dev, where lib/analytics-engine.ts degrades to an empty result set.
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;

  // Coder-loop security gate (GitHub Actions — see
  // pipeline/tools/security-scan-gh.ts). GITHUB_ACTIONS_TOKEN is a PAT with
  // `actions:write` on GITHUB_REPO (to dispatch security-gate.yml);
  // SECURITY_GATE_WEBHOOK_SECRET authenticates both the workflow's file
  // fetch and its findings callback.
  GITHUB_ACTIONS_TOKEN: string;
  SECURITY_GATE_WEBHOOK_SECRET: string;
  GITHUB_REPO: string;

  // EICCA webhook authentication — verifies x-eicca-webhook-secret header
  // on the repayment webhook (routes/eicca.ts POST /api/eicca/webhook).
  // Uses timingSafeEqual against this shared secret.
  EICCA_WEBHOOK_SECRET: string;

  // Figma OAuth integration
  FIGMA_CLIENT_ID: string;
  FIGMA_CLIENT_SECRET: string;

  // Non-secret vars (from wrangler.toml [vars])
  COHERE_BASE_URL: string;
  OPENROUTER_BASE_URL: string;
  /**
   * Overrides the pinned independent-auditor model. Optional and usually
   * empty — see packages/cohere/src/auditor-model.ts for the pin and for why
   * it must stay a non-Cohere slug.
   */
  AUDITOR_MODEL?: string;
  FLUXYCHAT_WORKER_URL: string;
  APP_URL: string;
  ENVIRONMENT: string;
  /**
   * The preview pool's ceiling, as a string because vars are strings.
   *
   * Must equal `max_instances` in the `[[containers]]` blocks. Optional at the
   * type level so a local run with no vars still works: `resolveCapacity`
   * falls back to the same number rather than to unbounded, because unbounded
   * would hand the overflow straight to a platform refusal — which is the
   * behaviour admission control exists to remove.
   */
  PREVIEW_MAX_INSTANCES?: string;
}
