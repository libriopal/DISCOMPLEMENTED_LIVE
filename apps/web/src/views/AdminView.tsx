/**
 * Admin "Task Manager" dashboard — see @agent_docs/admin-panel.md "Panel
 * Layout". Tabs mirror the mockup's left rail (Overview / Pipeline /
 * Security / Bottlenecks / Emergency / Simulation / Users). Gated client-side on
 * session.user.adminLevel for UX (hide the nav item, don't fetch); the
 * real enforcement is server-side in lib/admin-middleware.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  isAdminPermissionLevel,
  type AdminPermissionLevel,
  type SubscriptionTier,
} from '@bicameral/shared/types';
import { useAuth } from '../hooks/useAuth.js';
import {
  HealthMetrics,
  type AdminMetrics,
} from '../components/admin/HealthMetrics.js';
import { SecurityPanel } from '../components/admin/SecurityPanel.js';
import { BottleneckPanel } from '../components/admin/BottleneckPanel.js';
import { EmergencyControls } from '../components/admin/EmergencyControls.js';
import { RecommendationsEngine } from '../components/admin/RecommendationsEngine.js';
import { SimulationPanel } from '../components/admin/SimulationPanel.js';

type AdminTab =
  | 'overview'
  | 'pipeline'
  | 'security'
  | 'bottlenecks'
  | 'emergency'
  | 'simulation'
  | 'users';

const TABS: { id: AdminTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'security', label: 'Security' },
  { id: 'bottlenecks', label: 'Bottlenecks' },
  { id: 'emergency', label: 'Emergency Controls' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'users', label: 'Users' },
];

interface PipelineRunSummary {
  id: string;
  userEmail: string;
  status: string;
  currentStep: number;
  currentAgent: string | null;
  gateStatus: string | null;
  updatedAt: string;
}

interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  tier: SubscriptionTier;
  adminLevel: AdminPermissionLevel | null;
  creditsRemaining: number;
  creditsUsed: number;
  isBanned: boolean;
  createdAt: string;
}

function fetchJson<T>(path: string): Promise<T | null> {
  return fetch(path, { credentials: 'include' }).then((r) =>
    r.ok ? (r.json() as Promise<T>) : null
  );
}

function PipelineMonitor() {
  const [runs, setRuns] = useState<PipelineRunSummary[] | null>(null);

  const load = useCallback(() => {
    fetchJson<PipelineRunSummary[]>('/api/admin/pipelines?limit=50').then(
      setRuns
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
          paddingBottom: 'var(--space-3)',
        }}
      >
        <h3 style={{ fontSize: 16 }}>Pipeline Monitor</h3>
        <button
          onClick={load}
          style={{
            fontSize: 12,
            border: 'none',
            background: 'transparent',
            color: 'var(--color-accent)',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
      {runs && runs.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          No pipeline runs yet.
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {runs?.map((run) => (
          <li
            key={run.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              fontSize: 13,
              padding: '6px 0',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
              }}
            >
              {run.id.slice(0, 8)}
            </span>
            <span style={{ flex: 1 }}>{run.userEmail}</span>
            <span>
              Step {run.currentStep}/4 —{' '}
              {run.gateStatus === 'awaiting_approval'
                ? 'AWAITING APPROVAL'
                : run.status}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {new Date(run.updatedAt).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsersPanel({
  adminLevel,
}: {
  adminLevel: AdminPermissionLevel | null;
}) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const canWrite = adminLevel === '-write' || adminLevel === '-full';
  const canFull = adminLevel === '-full';

  const load = useCallback(() => {
    fetchJson<AdminUser[]>('/api/admin/users').then(setUsers);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patchUser(id: string, body: Record<string, unknown>) {
    await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    load();
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
        overflowX: 'auto',
      }}
    >
      <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>Users</h3>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
            <th style={{ fontWeight: 400, padding: '4px 8px 4px 0' }}>Email</th>
            <th style={{ fontWeight: 400, padding: '4px 8px' }}>Tier</th>
            <th style={{ fontWeight: 400, padding: '4px 8px' }}>Credits</th>
            <th style={{ fontWeight: 400, padding: '4px 8px' }}>Admin</th>
            <th style={{ fontWeight: 400, padding: '4px 8px' }}>Status</th>
            <th style={{ fontWeight: 400, padding: '4px 8px' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => (
            <tr
              key={u.id}
              style={{ borderTop: '1px solid var(--border-default)' }}
            >
              <td style={{ padding: '6px 8px 6px 0' }}>{u.email}</td>
              <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>
                {u.tier}
              </td>
              <td style={{ padding: '6px 8px' }}>{u.creditsRemaining}</td>
              <td
                style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}
              >
                {u.adminLevel ?? '—'}
              </td>
              <td
                style={{
                  padding: '6px 8px',
                  color: u.isBanned ? 'var(--danger)' : 'var(--success)',
                }}
              >
                {u.isBanned ? 'Banned' : 'Active'}
              </td>
              <td style={{ padding: '6px 8px' }}>
                <button
                  disabled={!canWrite}
                  onClick={() => patchUser(u.id, { isBanned: !u.isBanned })}
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-default)',
                    background: 'var(--surface-base)',
                    color: 'var(--text-primary)',
                    cursor: canWrite ? 'pointer' : 'not-allowed',
                    opacity: canWrite ? 1 : 0.5,
                    marginRight: 4,
                  }}
                >
                  {u.isBanned ? 'Unban' : 'Ban'}
                </button>
                <button
                  disabled={!canFull}
                  onClick={() => {
                    const amount = window.prompt(
                      'Credit adjustment (+/-)',
                      '0'
                    );
                    if (amount)
                      patchUser(u.id, { creditsAdjustment: Number(amount) });
                  }}
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-default)',
                    background: 'var(--surface-base)',
                    color: 'var(--text-primary)',
                    cursor: canFull ? 'pointer' : 'not-allowed',
                    opacity: canFull ? 1 : 0.5,
                  }}
                >
                  Credits
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminView() {
  const { user } = useAuth();
  const rawAdminLevel = (user as { adminLevel?: unknown } | null)?.adminLevel;
  const adminLevel = isAdminPermissionLevel(rawAdminLevel)
    ? rawAdminLevel
    : null;

  const [tab, setTab] = useState<AdminTab>('overview');
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const loadMetrics = useCallback(() => {
    fetch('/api/admin/metrics', { credentials: 'include' }).then((r) => {
      if (r.status === 401 || r.status === 403) {
        setForbidden(true);
        return;
      }
      if (r.ok) r.json().then((d) => setMetrics(d as AdminMetrics));
    });
  }, []);

  useEffect(() => {
    if (adminLevel) loadMetrics();
  }, [adminLevel, loadMetrics]);

  if (!adminLevel || forbidden) {
    return (
      <div
        style={{
          maxWidth: 480,
          margin: '80px auto',
          textAlign: 'center',
          color: 'var(--text-secondary)',
        }}
      >
        <h2 style={{ fontSize: 20, color: 'var(--text-primary)' }}>
          Admin access required
        </h2>
        <p style={{ fontSize: 14 }}>
          Your account doesn&apos;t have an admin permission tier assigned.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 1040,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <h1 style={{ fontSize: 28 }}>Discomplement Admin</h1>
        <span
          style={{
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
          }}
        >
          permission: {adminLevel}
        </span>
      </div>

      <nav
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 14px',
              border: 'none',
              borderBottom:
                tab === t.id
                  ? '2px solid var(--color-accent)'
                  : '2px solid transparent',
              background: 'transparent',
              color:
                tab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && metrics && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
          }}
        >
          <HealthMetrics metrics={metrics} />
          <RecommendationsEngine />
        </div>
      )}
      {tab === 'pipeline' && <PipelineMonitor />}
      {tab === 'security' && <SecurityPanel />}
      {tab === 'bottlenecks' && <BottleneckPanel />}
      {tab === 'emergency' && metrics && (
        <EmergencyControls
          metrics={metrics}
          adminLevel={adminLevel}
          onChanged={loadMetrics}
        />
      )}
      {tab === 'simulation' && <SimulationPanel />}
      {tab === 'users' && <UsersPanel adminLevel={adminLevel} />}
    </div>
  );
}
