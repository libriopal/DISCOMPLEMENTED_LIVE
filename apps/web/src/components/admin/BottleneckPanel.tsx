/**
 * P95/P99 per route (hot routes) + pipeline step timing — GET
 * /api/admin/bottlenecks. Hot routes need Analytics Engine's SQL API
 * configured (CF_ACCOUNT_ID/CF_ANALYTICS_API_TOKEN secrets); pipeline step
 * timing is always available from D1 alone.
 */
import { useEffect, useState } from 'react';

interface RouteStat {
  route: string;
  p95Ms: number;
  errorRate: number;
}

interface StepTiming {
  agentRole: string;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  count: number;
}

interface Bottlenecks {
  hotRoutes: RouteStat[];
  pipelineStepP95: StepTiming[];
  analyticsEngineConfigured: boolean;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function BottleneckPanel() {
  const [data, setData] = useState<Bottlenecks | null>(null);

  useEffect(() => {
    fetch('/api/admin/bottlenecks', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d as Bottlenecks | null));
  }, []);

  if (!data) return null;

  // Fixed by descending p95 — magnitude ranking is the point of this panel,
  // unlike HealthMetrics' fixed pipeline-step order.
  const hotRoutes = [...data.hotRoutes].sort((a, b) => b.p95Ms - a.p95Ms);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <div
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
        }}
      >
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
          Hot Routes (p95, last hour)
        </h3>
        {!data.analyticsEngineConfigured && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              paddingBottom: 'var(--space-2)',
            }}
          >
            Analytics Engine SQL API not configured (CF_ACCOUNT_ID /
            CF_ANALYTICS_API_TOKEN) — route-level timing unavailable.
          </div>
        )}
        {data.analyticsEngineConfigured && hotRoutes.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No traffic in the last hour.
          </div>
        )}
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
        >
          <tbody>
            {hotRoutes.map((r) => (
              <tr
                key={r.route}
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                <td
                  style={{ padding: '6px 0', fontFamily: 'var(--font-mono)' }}
                >
                  {r.route}
                </td>
                <td style={{ padding: '6px 0', textAlign: 'right', width: 80 }}>
                  {fmtMs(r.p95Ms)}
                </td>
                <td
                  style={{
                    padding: '6px 0',
                    textAlign: 'right',
                    width: 90,
                    color:
                      r.errorRate > 0.05
                        ? 'var(--danger)'
                        : 'var(--text-secondary)',
                  }}
                >
                  {(r.errorRate * 100).toFixed(1)}% err
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
        }}
      >
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
          Pipeline Step Timing
        </h3>
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
        >
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
              <th style={{ fontWeight: 400, padding: '4px 0' }}>Agent</th>
              <th
                style={{
                  fontWeight: 400,
                  padding: '4px 0',
                  textAlign: 'right',
                }}
              >
                avg
              </th>
              <th
                style={{
                  fontWeight: 400,
                  padding: '4px 0',
                  textAlign: 'right',
                }}
              >
                p95
              </th>
              <th
                style={{
                  fontWeight: 400,
                  padding: '4px 0',
                  textAlign: 'right',
                }}
              >
                p99
              </th>
              <th
                style={{
                  fontWeight: 400,
                  padding: '4px 0',
                  textAlign: 'right',
                }}
              >
                n
              </th>
            </tr>
          </thead>
          <tbody>
            {data.pipelineStepP95.map((t) => (
              <tr
                key={t.agentRole}
                style={{ borderTop: '1px solid var(--border-default)' }}
              >
                <td style={{ padding: '6px 0', textTransform: 'capitalize' }}>
                  {t.agentRole}
                </td>
                <td style={{ padding: '6px 0', textAlign: 'right' }}>
                  {fmtMs(t.avgMs)}
                </td>
                <td style={{ padding: '6px 0', textAlign: 'right' }}>
                  {fmtMs(t.p95Ms)}
                </td>
                <td style={{ padding: '6px 0', textAlign: 'right' }}>
                  {fmtMs(t.p99Ms)}
                </td>
                <td
                  style={{
                    padding: '6px 0',
                    textAlign: 'right',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {t.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
