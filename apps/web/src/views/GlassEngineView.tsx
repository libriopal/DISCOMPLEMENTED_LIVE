/**
 * Glass Engine — admin observability dashboard. Shows SQL tape,
 * function log, and auth traces from the GlassEngineDO.
 * Admin-only (sidebar only shows this for admin users).
 */
import { useState, useEffect } from 'react';

interface SqlTapeEntry {
  sql: string;
  params: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

interface FunctionLogEntry {
  functionName: string;
  argsSummary: string;
  resultSummary: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

type Tab = 'sql-tape' | 'function-log' | 'auth-trace';

export function GlassEngineView() {
  const [tab, setTab] = useState<Tab>('sql-tape');
  const [sqlEntries, setSqlEntries] = useState<SqlTapeEntry[]>([]);
  const [functionEntries, setFunctionEntries] = useState<FunctionLogEntry[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const endpoint =
          tab === 'sql-tape'
            ? '/api/glass-engine/sql-tape'
            : tab === 'function-log'
              ? '/api/glass-engine/function-log'
              : '/api/glass-engine/auth-trace';

        const res = await fetch(endpoint, { credentials: 'include' });
        if (!res.ok) {
          if (res.status === 403) {
            setError('Admin access required');
          } else {
            setError(`Failed to load: ${res.status}`);
          }
          return;
        }
        const data: any = await res.json();

        if (tab === 'sql-tape') setSqlEntries(data.entries || []);
        else if (tab === 'function-log') setFunctionEntries(data.entries || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [tab]);

  if (loading && !error) {
    return (
      <div
        style={{ padding: 'var(--space-8)', color: 'var(--text-secondary)' }}
      >
        Loading Glass Engine data...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{ padding: 'var(--space-8)', color: 'var(--text-secondary)' }}
      >
        {error}
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-8)', maxWidth: 1000 }}>
      <h1
        style={{
          fontSize: 24,
          fontWeight: 600,
          marginBottom: 'var(--space-4)',
        }}
      >
        Glass Engine
      </h1>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-6)',
        }}
      >
        {(['sql-tape', 'function-log', 'auth-trace'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              border:
                tab === t
                  ? '1px solid var(--color-accent)'
                  : '1px solid var(--border-default)',
              background: tab === t ? 'var(--surface-hover)' : 'transparent',
              color:
                tab === t ? 'var(--color-accent)' : 'var(--text-secondary)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t === 'sql-tape'
              ? 'SQL Tape'
              : t === 'function-log'
                ? 'Function Log'
                : 'Auth Trace'}
          </button>
        ))}
      </div>

      {/* SQL Tape */}
      {tab === 'sql-tape' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {sqlEntries.length === 0 && (
            <p style={{ color: 'var(--text-secondary)' }}>
              No SQL queries recorded yet.
            </p>
          )}
          {sqlEntries.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-default)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <code style={{ fontSize: 12, color: 'var(--color-accent)' }}>
                  {entry.sql.slice(0, 120)}
                  {entry.sql.length > 120 ? '...' : ''}
                </code>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {entry.durationMs}ms
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                user: {entry.userId?.slice(0, 8)} · req:{' '}
                {entry.requestId?.slice(0, 8)} ·{' '}
                {new Date(entry.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Function Log */}
      {tab === 'function-log' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {functionEntries.length === 0 && (
            <p style={{ color: 'var(--text-secondary)' }}>
              No function calls recorded yet.
            </p>
          )}
          {functionEntries.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-default)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <code style={{ fontSize: 12, color: 'var(--color-accent)' }}>
                  {entry.functionName}
                </code>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {entry.durationMs}ms
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {entry.argsSummary} → {entry.resultSummary}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  marginTop: 2,
                }}
              >
                user: {entry.userId?.slice(0, 8)} · req:{' '}
                {entry.requestId?.slice(0, 8)} ·{' '}
                {new Date(entry.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Auth Trace */}
      {tab === 'auth-trace' && (
        <div
          style={{ padding: 'var(--space-4)', color: 'var(--text-secondary)' }}
        >
          Auth traces available via /api/glass-engine/auth-trace endpoint.
        </div>
      )}
    </div>
  );
}
