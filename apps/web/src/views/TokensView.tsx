/**
 * API token management. There is no dedicated /api/tokens route yet (not in
 * the Phase 3 route list) — the virtual key is minted server-side on first
 * sign-in (lib/virtual-key.ts) and only ever shown once, at mint time, so
 * this view surfaces usage/rate-limit context instead of a raw key display.
 */
import { useEffect, useState } from 'react';

interface UsageSummary {
  creditsRemaining: number;
  creditsUsed: number;
  tier: string;
  rateLimitRemaining: number;
}

export function TokensView() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    fetch('/api/usage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUsage(data as UsageSummary | null));
  }, []);

  return (
    <div
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <h1 style={{ fontSize: 32 }}>API Tokens</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        Your virtual key authenticates programmatic requests (
        <code>Authorization: Bearer &lt;key&gt;</code>). It's issued once on
        first sign-in and never shown again — regeneration support is planned
        for the admin panel (Phase 7).
      </p>
      {usage && (
        <div
          style={{
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          <div style={{ fontSize: 14 }}>
            Tier: <strong>{usage.tier}</strong>
          </div>
          <div style={{ fontSize: 14 }}>
            Requests remaining this hour: {usage.rateLimitRemaining}
          </div>
          <div style={{ fontSize: 14 }}>
            Credits remaining: {usage.creditsRemaining}
          </div>
        </div>
      )}
    </div>
  );
}
