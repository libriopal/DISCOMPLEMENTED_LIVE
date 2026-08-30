/**
 * Billing — credit packs, subscription tiers, and the Stripe customer
 * portal. Consumes routes/billing.ts (Phase C). See
 * vault_commercial_launch_plan.md §5/§7 (Phase E) for scope.
 *
 * Stripe is LIVE — all checkout/portal calls hit real Stripe endpoints.
 * Credit packages (including a $1 test option) and subscription tiers are
 * rendered dynamically from GET /api/billing/packages.
 */
import { useEffect, useState, type CSSProperties } from 'react';

interface CreditPackage {
  credits: number;
  priceUsdCents: number;
  label: string;
}

interface SubscriptionTierPrice {
  priceUsdCents: number;
  label: string;
}

interface PackagesResponse {
  creditPackages: Record<string, CreditPackage>;
  subscriptionTiers: Record<string, SubscriptionTierPrice>;
}

interface UsageSummary {
  creditsRemaining: number;
  creditsUsed: number;
  tier: string;
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--space-6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const primaryButtonStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 'var(--radius-pill)',
  border: 'none',
  background: 'var(--color-accent)',
  color: 'var(--surface-base)',
  fontSize: 14,
  cursor: 'pointer',
  transition: 'opacity var(--dur-fast) var(--ease-standard)',
};

const secondaryButtonStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 'var(--radius-pill)',
  border: '1px solid var(--border-default)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 14,
  cursor: 'pointer',
};

async function goToUrl(
  path: string,
  init: RequestInit,
  setError: (msg: string | null) => void,
  setBusyKey: (key: string | null) => void,
  busyKey: string
): Promise<void> {
  setError(null);
  setBusyKey(busyKey);
  try {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      error?: string;
      details?: string;
    };
    if (!res.ok || !data.url) {
      throw new Error(data.error ?? `Request failed (${res.status}).`);
    }
    window.location.href = data.url;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Something went wrong.');
    setBusyKey(null);
  }
}

export function BillingView() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [packages, setPackages] = useState<PackagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const checkout = new URLSearchParams(window.location.search).get(
      'checkout'
    );
    if (checkout === 'success') return 'Payment received — thank you!';
    if (checkout === 'canceled') return 'Checkout was canceled.';
    return null;
  });

  useEffect(() => {
    fetch('/api/usage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUsage(data as UsageSummary | null))
      .catch(() => setUsage(null));

    fetch('/api/billing/packages', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setPackages(data as PackagesResponse | null))
      .catch(() =>
        setError('Could not load billing packages. Try again shortly.')
      );
  }, []);

  const buyCredits = (packId: string) =>
    void goToUrl(
      '/api/billing/checkout/credits',
      { method: 'POST', body: JSON.stringify({ packId }) },
      setError,
      setBusyKey,
      `credits:${packId}`
    );

  const subscribe = (tier: string) =>
    void goToUrl(
      '/api/billing/checkout/subscription',
      { method: 'POST', body: JSON.stringify({ tier }) },
      setError,
      setBusyKey,
      `tier:${tier}`
    );

  const manageBilling = () =>
    void goToUrl(
      '/api/billing/portal',
      { method: 'GET' },
      setError,
      setBusyKey,
      'portal'
    );

  return (
    <div
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <div>
        <h1 style={{ fontSize: 32 }}>Billing</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          Buy credits or subscribe to a plan. All checkout happens on Stripe's
          hosted page — we never see your card details.
        </p>
      </div>

      {notice && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--success)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--space-3)',
          }}
        >
          {notice}
          <button
            onClick={() => setNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--danger)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
          }}
        >
          {error}
        </div>
      )}

      {usage && (
        <div
          style={{
            ...cardStyle,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Current plan
            </div>
            <div style={{ fontSize: 20, textTransform: 'capitalize' }}>
              {usage.tier}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Credits remaining
            </div>
            <div style={{ fontSize: 20 }}>{usage.creditsRemaining}</div>
          </div>
          <button
            onClick={manageBilling}
            disabled={busyKey === 'portal'}
            style={{
              ...secondaryButtonStyle,
              opacity: busyKey === 'portal' ? 0.6 : 1,
            }}
          >
            {busyKey === 'portal' ? 'Opening...' : 'Manage billing'}
          </button>
        </div>
      )}

      {packages && (
        <>
          <div>
            <h2 style={{ fontSize: 20, paddingBottom: 'var(--space-3)' }}>
              Credit packs
            </h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              {Object.entries(packages.creditPackages).map(([id, pack]) => (
                <div key={id} style={cardStyle}>
                  <div style={{ fontSize: 15 }}>{pack.label}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {pack.credits.toLocaleString()} credits
                  </div>
                  <button
                    onClick={() => buyCredits(id)}
                    disabled={busyKey === `credits:${id}`}
                    style={{
                      ...primaryButtonStyle,
                      opacity: busyKey === `credits:${id}` ? 0.6 : 1,
                    }}
                  >
                    {busyKey === `credits:${id}` ? 'Redirecting...' : 'Buy'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 style={{ fontSize: 20, paddingBottom: 'var(--space-3)' }}>
              Subscription plans
            </h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              {Object.entries(packages.subscriptionTiers).map(
                ([tier, price]) => (
                  <div key={tier} style={cardStyle}>
                    <div style={{ fontSize: 15 }}>{price.label}</div>
                    <div
                      style={{ fontSize: 13, color: 'var(--text-secondary)' }}
                    >
                      Billed monthly
                    </div>
                    <button
                      onClick={() => subscribe(tier)}
                      disabled={
                        busyKey === `tier:${tier}` || usage?.tier === tier
                      }
                      style={{
                        ...primaryButtonStyle,
                        opacity:
                          busyKey === `tier:${tier}` || usage?.tier === tier
                            ? 0.6
                            : 1,
                      }}
                    >
                      {usage?.tier === tier
                        ? 'Current plan'
                        : busyKey === `tier:${tier}`
                          ? 'Redirecting...'
                          : 'Subscribe'}
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        </>
      )}

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          gap: 'var(--space-4)',
          borderTop: '1px solid var(--border-default)',
          paddingTop: 'var(--space-4)',
        }}
      >
        <a href="/legal/terms" target="_blank" rel="noreferrer">
          Terms of Service
        </a>
        <a href="/legal/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        <a href="/legal/cookies" target="_blank" rel="noreferrer">
          Cookie Notice
        </a>
        <a href="/legal/acceptable-use" target="_blank" rel="noreferrer">
          Acceptable Use
        </a>
      </div>
    </div>
  );
}
