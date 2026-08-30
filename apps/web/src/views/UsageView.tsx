/**
 * Usage stats + credit balance. See @agent_docs/api-spec.md "Usage".
 */
import { useEffect, useState } from 'react';

interface CreditHistoryEntry {
  amount: number;
  type: string;
  description: string | null;
  date: string;
}

interface Breakdown {
  byModel: Record<string, { count: number; tokens: number }>;
  byPipelineStep: Record<string, { count: number; tokens: number }>;
}

export function UsageView() {
  const [credits, setCredits] = useState<{
    balance: number;
    history: CreditHistoryEntry[];
  } | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);

  useEffect(() => {
    fetch('/api/usage/credits', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) =>
        setCredits(
          data as { balance: number; history: CreditHistoryEntry[] } | null
        )
      );
    fetch('/api/usage/breakdown', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setBreakdown(data as Breakdown | null));
  }, []);

  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <h1 style={{ fontSize: 32 }}>Usage</h1>

      {credits && (
        <div>
          <div style={{ fontSize: 40, fontFamily: 'var(--font-display)' }}>
            {credits.balance}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            credits remaining
          </div>
        </div>
      )}

      {breakdown && (
        <div
          style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-2)' }}>
              By model
            </h3>
            {Object.keys(breakdown.byModel).length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>
                No usage yet. Run a generation to see model breakdown.
              </div>
            )}
            {Object.entries(breakdown.byModel).map(([model, stats]) => (
              <div
                key={model}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  padding: '4px 0',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)' }}>{model}</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {stats.count} calls · {stats.tokens} tok
                </span>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-2)' }}>
              By pipeline step
            </h3>
            {Object.entries(breakdown.byPipelineStep).map(([step, stats]) => (
              <div
                key={step}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  padding: '4px 0',
                }}
              >
                <span style={{ textTransform: 'capitalize' }}>{step}</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {stats.count} runs · {stats.tokens} tok
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {credits && (
        <div>
          <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-2)' }}>
            History
          </h3>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {credits.history.length === 0 && (
              <li style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>
                No credit transactions yet. Credits you purchase or use will appear here.
              </li>
            )}
            {credits.history.map((entry, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                <span>{entry.description ?? entry.type}</span>
                <span
                  style={{
                    color:
                      entry.amount < 0 ? 'var(--danger)' : 'var(--success)',
                  }}
                >
                  {entry.amount > 0 ? '+' : ''}
                  {entry.amount}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
