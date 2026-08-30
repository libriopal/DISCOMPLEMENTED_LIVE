/**
 * Nightly Monte Carlo simulation — §3.5 item 5, "surface findings loudly".
 *
 * Reads GET /api/simulation/alerts, /latest and /history. The engine runs out
 * of band (.github/workflows/simulation.yml, 04:00 UTC) and a watchdog cron
 * reads what it ingested two hours later; this is where both land.
 *
 * Two things this panel deliberately does NOT have: a button that applies a
 * recommendation, and a button that runs the simulation. The first is the
 * §CORRECTION 7 boundary — findings are advisory and remediation is a separate
 * human-authored commit, which is why `applied_to_architecture` is displayed
 * as a state rather than offered as an action. The second is because a run
 * spends real credits against live production and a button that does that
 * without a budget conversation is how a recurring cost becomes an accident.
 *
 * Ground rule 2 applies to every number here: these are simulated figures. The
 * VDR shown is the engine's own `calculate_simulation_vdr` over one night's
 * bots, not a measurement of production traffic, and the panel says so on
 * screen rather than relying on the reader to remember.
 */
import { useEffect, useState } from 'react';

interface SimulationAlert {
  id: string;
  runId: string | null;
  kind: string;
  severity: 'high' | 'medium';
  summary: string;
  detail: string;
  acknowledged: boolean;
  acknowledgedDate: string | null;
  createdDate: string;
}

interface CreditStatus {
  total_budget?: number;
  spent?: number;
  remaining?: number;
  paused?: boolean;
  pause_reason?: string | null;
}

interface LatestRun {
  id: string;
  status: string;
  numBots: number;
  totalCreditsSimulated: number;
  vdrPercent: number | null;
  houseEdgePercent: number | null;
  exploitsFound: { bot?: string; tripwires?: string[] }[];
  tripwireBreakdown: Record<string, number>;
  recommendations: string[];
  creditStatus: CreditStatus | null;
  approvedByAdmin: boolean;
  appliedToArchitecture: boolean;
  createdDate: string;
}

interface HistoryRun {
  id: string;
  num_bots: number;
  total_credits_simulated: number;
  vdr_percent: number | null;
  approved_by_admin: number;
  applied_to_architecture: number;
  created_date: string;
}

const CARD: React.CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-6)',
};

function fmtDate(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16) + 'Z';
}

export function SimulationPanel() {
  const [alerts, setAlerts] = useState<SimulationAlert[]>([]);
  const [latest, setLatest] = useState<LatestRun | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  function load() {
    const opts = { credentials: 'include' as const };
    Promise.all([
      fetch('/api/simulation/alerts', opts).then((r) =>
        r.ok ? r.json() : null
      ),
      fetch('/api/simulation/latest', opts).then((r) =>
        r.ok ? r.json() : null
      ),
      fetch('/api/simulation/history', opts).then((r) =>
        r.ok ? r.json() : null
      ),
    ]).then(([a, l, h]) => {
      setAlerts((a as { alerts?: SimulationAlert[] } | null)?.alerts ?? []);
      // /latest answers with { message } when nothing has ever been ingested.
      setLatest((l as LatestRun | null)?.id ? (l as LatestRun) : null);
      setHistory((h as { runs?: HistoryRun[] } | null)?.runs ?? []);
      setLoaded(true);
    });
  }

  useEffect(load, []);

  function acknowledge(id: string) {
    fetch(`/api/simulation/alerts/${id}/acknowledge`, {
      method: 'POST',
      credentials: 'include',
    }).then(load);
  }

  if (!loaded) return null;

  const open = alerts.filter((a) => !a.acknowledged);
  // Trend is the previous run's VDR, from history — the same comparison the
  // watchdog makes, shown so the alert can be checked rather than trusted.
  const previous = history.find((r) => r.id !== latest?.id);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      {/* --- Alerts --- */}
      <div style={CARD}>
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
          Alerts {open.length > 0 && `(${open.length} unacknowledged)`}
        </h3>
        {open.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No open alerts. The watchdog runs at 06:00 UTC and raises one if a
            new exploit class appears, value delivery drops materially, a
            tripwire spikes, or no report lands at all.
          </p>
        )}
        {open.map((a) => (
          <div
            key={a.id}
            style={{
              borderLeft: `3px solid ${
                a.severity === 'high'
                  ? 'var(--color-error)'
                  : 'var(--color-warning)'
              }`,
              paddingLeft: 'var(--space-4)',
              marginBottom: 'var(--space-4)',
            }}
          >
            <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
              {a.summary}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                paddingTop: 4,
              }}
            >
              {a.detail}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                paddingTop: 6,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                }}
              >
                {a.kind} · {fmtDate(a.createdDate)}
              </span>
              <button
                onClick={() => acknowledge(a.id)}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Acknowledge
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* --- Latest run --- */}
      <div style={CARD}>
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
          Latest run
        </h3>
        {!latest && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No simulation report has been ingested yet.
          </p>
        )}
        {latest && (
          <>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 'var(--space-4)',
                fontSize: 13,
              }}
            >
              <Stat label="Ran" value={fmtDate(latest.createdDate)} />
              <Stat label="Bots" value={String(latest.numBots)} />
              <Stat
                label="Credits spent"
                value={
                  latest.creditStatus?.total_budget
                    ? `${latest.totalCreditsSimulated} / ${latest.creditStatus.total_budget}`
                    : String(latest.totalCreditsSimulated)
                }
              />
              <Stat
                label="Exploit classes"
                value={String(latest.exploitsFound.length)}
              />
              <Stat
                label="VDR (simulated)"
                value={
                  latest.vdrPercent === null
                    ? 'not computed'
                    : `${latest.vdrPercent}%${
                        previous?.vdr_percent != null
                          ? ` (was ${previous.vdr_percent}%)`
                          : ''
                      }`
                }
              />
              <Stat
                label="Reviewed"
                value={latest.approvedByAdmin ? 'yes' : 'not yet'}
              />
              <Stat
                label="Applied to architecture"
                value={latest.appliedToArchitecture ? 'yes' : 'no'}
              />
            </dl>
            {latest.creditStatus?.paused && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--color-warning)',
                  paddingTop: 'var(--space-3)',
                }}
              >
                The credit guard paused this run:{' '}
                {latest.creditStatus.pause_reason ?? 'no reason recorded'}.
              </p>
            )}
            <p
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                paddingTop: 'var(--space-4)',
              }}
            >
              These are simulated figures from bot personas, not measurements of
              production traffic, and none of them may appear on a customer
              surface.
            </p>
          </>
        )}
      </div>

      {/* --- Tripwires + exploits --- */}
      {latest && (
        <div style={CARD}>
          <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
            Tripwire breakdown
          </h3>
          {Object.keys(latest.tripwireBreakdown).length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              No tripwire fired during the last run.
            </p>
          ) : (
            <ul style={{ fontSize: 13, listStyle: 'none' }}>
              {Object.entries(latest.tripwireBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => (
                  <li
                    key={name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '4px 0',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span>{name}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {count}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {/* --- Recommendations --- */}
      {latest && latest.recommendations.length > 0 && (
        <div style={CARD}>
          <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
            Recommendations
          </h3>
          <ul
            style={{
              fontSize: 13,
              paddingLeft: 'var(--space-4)',
              lineHeight: 1.6,
            }}
          >
            {latest.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              paddingTop: 'var(--space-4)',
            }}
          >
            Advisory only. Nothing here is applied automatically; a change is a
            separate human-authored commit, and `applied to architecture` above
            stays &quot;no&quot; until one lands.
          </p>
        </div>
      )}

      {/* --- Trend --- */}
      {history.length > 1 && (
        <div style={CARD}>
          <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
            Recent runs
          </h3>
          <table style={{ width: '100%', fontSize: 12, borderSpacing: 0 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                <th style={{ padding: '4px 0' }}>Ran</th>
                <th>Bots</th>
                <th>Credits</th>
                <th>VDR</th>
                <th>Reviewed</th>
                <th>Applied</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: 'var(--font-mono)' }}>
              {history.slice(0, 14).map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: '4px 0' }}>
                    {fmtDate(r.created_date)}
                  </td>
                  <td>{r.num_bots}</td>
                  <td>{r.total_credits_simulated}</td>
                  <td>{r.vdr_percent === null ? '—' : `${r.vdr_percent}%`}</td>
                  <td>{r.approved_by_admin ? 'yes' : '—'}</td>
                  <td>{r.applied_to_architecture ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
        }}
      >
        {label}
      </dt>
      <dd style={{ fontFamily: 'var(--font-mono)' }}>{value}</dd>
    </div>
  );
}
