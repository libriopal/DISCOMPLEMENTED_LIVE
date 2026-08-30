/**
 * Navigation sidebar — switches App.tsx's active view. Section list mirrors
 * the Phase 5 MVP views plus the Value Assurance nav items (Value Panel
 * and Glass Engine admin dashboard).
 */
import { isAdminPermissionLevel } from '@bicameral/shared/types';
import { useAuth } from '../hooks/useAuth.js';
import { useState, useEffect } from 'react';

export type ViewName =
  | 'generation'
  | 'projects'
  | 'lattice'
  | 'tokens'
  | 'usage'
  | 'billing'
  | 'value'
  | 'responsive'
  | 'admin'
  | 'glass-engine';

const NAV_ITEMS: { id: ViewName; label: string }[] = [
  { id: 'generation', label: 'Generate' },
  { id: 'projects', label: 'Projects' },
  { id: 'lattice', label: 'Memory Lattice' },
  { id: 'usage', label: 'Usage' },
  { id: 'value', label: 'Value' },
  { id: 'billing', label: 'Billing' },
  { id: 'tokens', label: 'API Tokens' },
  { id: 'responsive', label: 'Responsive Preview' },
];

const ADMIN_NAV_ITEMS: { id: ViewName; label: string }[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'glass-engine', label: 'Glass Engine' },
];

export function Sidebar({
  active,
  onSelect,
}: {
  active: ViewName;
  onSelect: (view: ViewName) => void;
}) {
  const { user, signOut } = useAuth();
  type Forecast = {
    balance: number;
    burnRate?: { avgDailyBurn: number; trend: string };
    forecast?: { daysUntilDepletion: number | null; alertLevel: string };
  };
  const [forecast, setForecast] = useState<Forecast | null>(null);

  useEffect(() => {
    fetch('/api/usage/forecast', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.resolve(null)))
      .then((data) => setForecast(data as Forecast | null))
      .catch(() => {});
    const interval = setInterval(() => {
      fetch('/api/usage/forecast', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.resolve(null)))
        .then((data) => setForecast(data as Forecast | null))
        .catch(() => {});
    }, 60000); // Update every minute
    return () => clearInterval(interval);
  }, []);

  const rawAdminLevel = (user as { adminLevel?: unknown } | null)?.adminLevel;
  const adminLevel = isAdminPermissionLevel(rawAdminLevel)
    ? rawAdminLevel
    : null;
  const navItems = adminLevel ? [...NAV_ITEMS, ...ADMIN_NAV_ITEMS] : NAV_ITEMS;

  return (
    <nav
      className="app-sidebar"
      style={{
        width: 220,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        borderRight: '1px solid var(--border-default)',
        padding: 'var(--space-6) var(--space-4)',
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      <div>
        <div
          className="app-sidebar-brand"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            paddingBottom: 'var(--space-6)',
          }}
        >
          <img src="/logo.png" alt="" width={18} height={18} />
          Discomplement
        </div>
        <ul
          className="app-sidebar-nav"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          {/* Credit monitor widget */}
          {forecast && (
            <div
              style={{
                padding: 'var(--space-3) var(--space-4)',
                marginBottom: 'var(--space-4)',
                borderRadius: 'var(--radius-md)',
                background:
                  forecast.forecast?.alertLevel === 'urgent'
                    ? 'rgba(192, 54, 44, 0.15)'
                    : forecast.forecast?.alertLevel === 'warning'
                      ? 'rgba(234, 179, 8, 0.1)'
                      : 'var(--surface-raised)',
                border: '1px solid var(--border-default)',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Credits
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color:
                    forecast.forecast?.alertLevel === 'urgent'
                      ? 'var(--danger)'
                      : 'var(--text-primary)',
                }}
              >
                {forecast.balance}
              </div>
              {forecast.burnRate && forecast.burnRate.avgDailyBurn > 0 && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    marginTop: 2,
                  }}
                >
                  {forecast.burnRate.avgDailyBurn.toFixed(1)}/day
                  {forecast.forecast?.daysUntilDepletion !== null &&
                    forecast.forecast?.daysUntilDepletion !== undefined && (
                      <span style={{ marginLeft: 4 }}>
                        · {forecast.forecast.daysUntilDepletion}d left
                      </span>
                    )}
                </div>
              )}
              {forecast.forecast?.alertLevel === 'urgent' && (
                <div
                  style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}
                >
                  ⚠ Low credits — buy more
                </div>
              )}
            </div>
          )}
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => onSelect(item.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: 'none',
                  background:
                    active === item.id
                      ? 'var(--surface-raised)'
                      : 'transparent',
                  color:
                    active === item.id
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                  fontSize: 14,
                  cursor: 'pointer',
                  transition: 'background var(--dur-fast) var(--ease-standard)',
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        {user && (
          <div
            className="app-sidebar-email"
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user.email}
          </div>
        )}
        <button
          onClick={() => void signOut()}
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
