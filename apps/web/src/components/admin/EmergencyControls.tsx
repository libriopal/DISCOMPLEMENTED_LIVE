/**
 * Kill switch, maintenance mode, sandbox kill, data export. Buttons are
 * rendered for every admin tier but `disabled` below the tier that route
 * requires (see @agent_docs/admin-panel.md "-read" — "All action buttons
 * are rendered but greyed out with disabled and cursor: not-allowed").
 */
import { useState } from 'react';
import type { AdminPermissionLevel } from '@bicameral/shared/types';
import type { AdminMetrics } from './HealthMetrics.js';

const RANK: Record<AdminPermissionLevel, number> = {
  '-read': 0,
  '-write': 1,
  '-full': 2,
};

function atLeast(
  level: AdminPermissionLevel | null,
  min: AdminPermissionLevel
): boolean {
  return level !== null && RANK[level] >= RANK[min];
}

function buttonStyle(enabled: boolean, danger = false): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 'var(--radius-md)',
    border: `1px solid ${danger ? 'var(--danger)' : 'var(--border-default)'}`,
    background: danger && enabled ? 'var(--danger)' : 'var(--surface-base)',
    color:
      danger && enabled
        ? 'var(--neutral-0)'
        : danger
          ? 'var(--danger)'
          : 'var(--text-primary)',
    fontSize: 13,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  };
}

export function EmergencyControls({
  metrics,
  adminLevel,
  onChanged,
}: {
  metrics: AdminMetrics;
  adminLevel: AdminPermissionLevel | null;
  onChanged: () => void;
}) {
  const [sandboxProjectId, setSandboxProjectId] = useState('');
  const [busy, setBusy] = useState(false);

  const canWrite = atLeast(adminLevel, '-write');
  const canFull = atLeast(adminLevel, '-full');

  async function post(path: string, body?: unknown) {
    setBusy(true);
    try {
      await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function killSandbox() {
    if (!sandboxProjectId.trim()) return;
    setBusy(true);
    try {
      await fetch(
        `/api/admin/sandbox/${encodeURIComponent(sandboxProjectId.trim())}`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      );
      setSandboxProjectId('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    const res = await fetch('/api/admin/export', { credentials: 'include' });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bicameral-export-${new Date().toISOString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h3 style={{ fontSize: 16 }}>Emergency Controls</h3>
        <span
          style={{
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: metrics.emergencyShutdown
              ? 'var(--danger)'
              : metrics.maintenanceMode
                ? 'var(--warning)'
                : 'var(--success)',
          }}
        >
          ● System:{' '}
          {metrics.emergencyShutdown
            ? 'Shutdown'
            : metrics.maintenanceMode
              ? 'Maintenance'
              : 'Live'}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <button
          disabled={!canWrite || busy}
          style={buttonStyle(canWrite && !busy)}
          onClick={() =>
            post('/api/admin/maintenance', {
              enabled: !metrics.maintenanceMode,
            })
          }
        >
          {metrics.maintenanceMode
            ? 'Disable maintenance mode'
            : 'Enable maintenance mode'}
        </button>

        {metrics.emergencyShutdown ? (
          <button
            disabled={!canFull || busy}
            style={buttonStyle(canFull && !busy)}
            onClick={() => post('/api/admin/recover')}
          >
            Recover from shutdown
          </button>
        ) : (
          <button
            disabled={!canFull || busy}
            style={buttonStyle(canFull && !busy, true)}
            onClick={() => {
              if (
                window.confirm(
                  'Emergency shutdown cancels ALL active pipeline runs. Continue?'
                )
              ) {
                void post('/api/admin/shutdown');
              }
            }}
          >
            Emergency shutdown
          </button>
        )}

        <button
          disabled={!canFull || busy}
          style={buttonStyle(canFull && !busy)}
          onClick={exportData}
        >
          Export D1 data (JSON)
        </button>
      </div>

      <div
        style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
      >
        <input
          value={sandboxProjectId}
          onChange={(e) => setSandboxProjectId(e.target.value)}
          placeholder="Project ID"
          disabled={!canWrite}
          style={{
            padding: '8px 10px',
            fontSize: 13,
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-base)',
            color: 'var(--text-primary)',
            flex: 1,
            maxWidth: 260,
          }}
        />
        <button
          disabled={!canWrite || busy || !sandboxProjectId.trim()}
          style={buttonStyle(canWrite && !busy && !!sandboxProjectId.trim())}
          onClick={killSandbox}
        >
          Kill sandbox
        </button>
      </div>

      {!canWrite && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Read-only access — controls are visible but disabled.
        </div>
      )}
    </div>
  );
}
