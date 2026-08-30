/**
 * Heuristic recommendations — GET /api/admin/recommendations. Renders the
 * R1-R12 rules from lib/admin-recommendations.ts. Order is severity rank
 * (never re-sorted by rule number), matching SecurityPanel's convention.
 */
import { useEffect, useState } from 'react';

interface Recommendation {
  rule: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

const SEVERITY_ORDER: Recommendation['severity'][] = [
  'critical',
  'warning',
  'info',
];

const SEVERITY_COLOR: Record<Recommendation['severity'], string> = {
  critical: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--text-secondary)',
};

export function RecommendationsEngine() {
  const [recommendations, setRecommendations] = useState<
    Recommendation[] | null
  >(null);

  useEffect(() => {
    fetch('/api/admin/recommendations', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setRecommendations(
          (d as { recommendations: Recommendation[] } | null)
            ?.recommendations ?? []
        )
      );
  }, []);

  const sorted = recommendations
    ? [...recommendations].sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) -
          SEVERITY_ORDER.indexOf(b.severity)
      )
    : null;

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
      }}
    >
      <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
        Recommendations
      </h3>
      {sorted && sorted.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          No active recommendations — system healthy.
        </div>
      )}
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        {sorted?.map((rec, i) => (
          <li
            key={`${rec.rule}-${i}`}
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              fontSize: 13,
              alignItems: 'baseline',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: SEVERITY_COLOR[rec.severity],
                width: 32,
                flexShrink: 0,
              }}
            >
              {rec.rule}
            </span>
            <span>→ {rec.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
