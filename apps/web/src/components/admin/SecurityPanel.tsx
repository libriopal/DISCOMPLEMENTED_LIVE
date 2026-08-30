/**
 * Security event log — GET /api/admin/security (security_events table).
 * Severity is a status encoding (never color-alone: icon + label on every
 * row), fixed rank order high -> low, not re-sorted by anything else.
 */
import { useEffect, useState } from 'react';

interface SecurityEvent {
  id: string;
  eventType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  ipAddress: string | null;
  userId: string | null;
  route: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

const SEVERITY_ORDER: SecurityEvent['severity'][] = [
  'critical',
  'high',
  'medium',
  'low',
];

const SEVERITY_STYLE: Record<
  SecurityEvent['severity'],
  { color: string; icon: string }
> = {
  critical: { color: 'var(--danger)', icon: '●' },
  high: { color: 'var(--danger)', icon: '▲' },
  medium: { color: 'var(--warning)', icon: '▲' },
  low: { color: 'var(--info)', icon: '○' },
};

export function SecurityPanel() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [filter, setFilter] = useState<SecurityEvent['severity'] | 'all'>(
    'all'
  );

  useEffect(() => {
    const query = filter === 'all' ? '' : `?severity=${filter}`;
    fetch(`/api/admin/security${query}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setEvents(data as SecurityEvent[]));
  }, [filter]);

  const sorted = events
    ? [...events].sort(
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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 'var(--space-3)',
        }}
      >
        <h3 style={{ fontSize: 16 }}>Security Events</h3>
        <select
          value={filter}
          onChange={(e) =>
            setFilter(e.target.value as SecurityEvent['severity'] | 'all')
          }
          style={{
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-base)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {sorted && sorted.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          No security events recorded.
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted?.map((event) => {
          const style = SEVERITY_STYLE[event.severity];
          return (
            <li
              key={event.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-2)',
                padding: '8px 0',
                borderBottom: '1px solid var(--border-default)',
                fontSize: 13,
              }}
            >
              <span style={{ color: style.color }} aria-hidden>
                {style.icon}
              </span>
              <span
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: style.color,
                  width: 56,
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {event.severity}
              </span>
              <span style={{ flex: 1 }}>
                <strong style={{ fontWeight: 500 }}>{event.eventType}</strong>
                {event.route ? ` on ${event.route}` : ''}
                {event.ipAddress ? ` from ${event.ipAddress}` : ''}
                {event.userId ? ` (user ${event.userId})` : ''}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                {new Date(event.createdAt).toLocaleString()}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
