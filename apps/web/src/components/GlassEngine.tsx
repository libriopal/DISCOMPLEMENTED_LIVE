/**
 * Glass Engine — the backend preview pane.
 *
 * A second preview, peer to the UI preview, showing what's happening
 * behind the frontend: live SQL tape, function logs, auth/RLS traces,
 * cost HUD, and schema map.
 *
 * This is the "see the engine" requirement from the blueprint (§5).
 * Nobody in the reference field (Replit, Lovable, Bolt) has this.
 * It's what makes Discomplement different: you don't just see the app,
 * you see the engine running it.
 */
import { useState, useEffect } from 'react';

export interface GlassEvent {
  id: string;
  type: 'sql' | 'function' | 'auth' | 'cost' | 'schema';
  timestamp: number;
  data: {
    // SQL
    query?: string;
    rowsAffected?: number;
    durationMs?: number;
    // Function
    functionName?: string;
    input?: string;
    output?: string;
    coldStart?: boolean;
    // Auth
    userId?: string;
    policy?: string;
    allowed?: boolean;
    reason?: string;
    // Cost
    credits?: number;
    feature?: string;
    burnRate?: number;
    // Schema
    tableName?: string;
    columns?: string[];
  };
}

export interface GlassEngineProps {
  events: GlassEvent[];
  totalCreditsSpent: number;
  creditBudget: number;
  activeTab?: 'sql' | 'functions' | 'auth' | 'cost' | 'schema';
}

type Tab = 'sql' | 'functions' | 'auth' | 'cost' | 'schema';

const TAB_CONFIG: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'sql', label: 'SQL Tape', icon: '◐' },
  { id: 'functions', label: 'Functions', icon: '⚡' },
  { id: 'auth', label: 'Auth/RLS', icon: '🔒' },
  { id: 'cost', label: 'Cost HUD', icon: '⌬' },
  { id: 'schema', label: 'Schema', icon: '⊞' },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function SqlTape({ events }: { events: GlassEvent[] }) {
  const sqlEvents = events.filter((e) => e.type === 'sql');
  if (sqlEvents.length === 0) {
    return <div className="glass-empty">No SQL statements executed yet.</div>;
  }
  return (
    <div className="glass-event-list">
      {sqlEvents.map((e) => (
        <div key={e.id} className="glass-event-row">
          <div className="glass-event-meta">
            <span className="glass-time">{formatTime(e.timestamp)}</span>
            <span
              className={`glass-duration ${e.data.durationMs && e.data.durationMs > 100 ? 'slow' : ''}`}
            >
              {e.data.durationMs ?? 0}ms
            </span>
            <span className="glass-rows">{e.data.rowsAffected ?? 0} rows</span>
          </div>
          <pre className="glass-query">{e.data.query ?? '(empty)'}</pre>
        </div>
      ))}
    </div>
  );
}

function FunctionLog({ events }: { events: GlassEvent[] }) {
  const fnEvents = events.filter((e) => e.type === 'function');
  if (fnEvents.length === 0) {
    return <div className="glass-empty">No function calls yet.</div>;
  }
  return (
    <div className="glass-event-list">
      {fnEvents.map((e) => (
        <div key={e.id} className="glass-event-row">
          <div className="glass-event-meta">
            <span className="glass-time">{formatTime(e.timestamp)}</span>
            <span className="glass-fn-name">
              {e.data.functionName ?? 'unknown'}
            </span>
            {e.data.coldStart && (
              <span className="glass-badge cold">cold start</span>
            )}
            <span className="glass-duration">{e.data.durationMs ?? 0}ms</span>
          </div>
          {e.data.input && <pre className="glass-io">in: {e.data.input}</pre>}
          {e.data.output && (
            <pre className="glass-io">out: {e.data.output}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function AuthTrace({ events }: { events: GlassEvent[] }) {
  const authEvents = events.filter((e) => e.type === 'auth');
  if (authEvents.length === 0) {
    return <div className="glass-empty">No auth/RLS events yet.</div>;
  }
  return (
    <div className="glass-event-list">
      {authEvents.map((e) => (
        <div key={e.id} className="glass-event-row">
          <div className="glass-event-meta">
            <span className="glass-time">{formatTime(e.timestamp)}</span>
            <span className="glass-user">{e.data.userId ?? 'anonymous'}</span>
            <span
              className={`glass-badge ${e.data.allowed ? 'allowed' : 'denied'}`}
            >
              {e.data.allowed ? 'ALLOWED' : 'DENIED'}
            </span>
          </div>
          <div className="glass-policy">Policy: {e.data.policy ?? 'none'}</div>
          {e.data.reason && <div className="glass-reason">{e.data.reason}</div>}
        </div>
      ))}
    </div>
  );
}

function CostHud({
  events,
  totalSpent,
  budget,
}: {
  events: GlassEvent[];
  totalSpent: number;
  budget: number;
}) {
  const costEvents = events.filter((e) => e.type === 'cost');
  const pct = budget > 0 ? (totalSpent / budget) * 100 : 0;
  const remaining = budget - totalSpent;
  const burnRate =
    costEvents.length > 0
      ? (costEvents[costEvents.length - 1].data.burnRate ?? 0)
      : 0;

  return (
    <div className="glass-cost-hud">
      <div className="glass-cost-summary">
        <div className="glass-cost-stat">
          <span className="glass-cost-label">Spent</span>
          <span className="glass-cost-value">{totalSpent.toFixed(1)}</span>
        </div>
        <div className="glass-cost-stat">
          <span className="glass-cost-label">Budget</span>
          <span className="glass-cost-value">{budget}</span>
        </div>
        <div className="glass-cost-stat">
          <span className="glass-cost-label">Remaining</span>
          <span
            className={`glass-cost-value ${remaining < 0 ? 'negative' : ''}`}
          >
            {remaining.toFixed(1)}
          </span>
        </div>
        <div className="glass-cost-stat">
          <span className="glass-cost-label">Burn rate</span>
          <span className="glass-cost-value">{burnRate.toFixed(2)}/min</span>
        </div>
      </div>
      <div className="glass-cost-bar">
        <div
          className={`glass-cost-bar-fill ${pct > 80 ? 'danger' : pct > 60 ? 'warning' : ''}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="glass-cost-events">
        {costEvents.length === 0 ? (
          <div className="glass-empty">No cost events recorded.</div>
        ) : (
          costEvents.map((e) => (
            <div key={e.id} className="glass-event-row">
              <span className="glass-time">{formatTime(e.timestamp)}</span>
              <span className="glass-cost-feature">
                {e.data.feature ?? 'unknown'}
              </span>
              <span className="glass-cost-amount">
                -{e.data.credits ?? 0} credits
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SchemaMap({ events }: { events: GlassEvent[] }) {
  const schemaEvents = events.filter((e) => e.type === 'schema');
  if (schemaEvents.length === 0) {
    return <div className="glass-empty">No schema changes detected.</div>;
  }
  return (
    <div className="glass-schema">
      {schemaEvents.map((e) => (
        <div key={e.id} className="glass-schema-table">
          <div className="glass-schema-name">
            ⊞ {e.data.tableName ?? 'unknown'}
          </div>
          <div className="glass-schema-cols">
            {(e.data.columns ?? []).map((col) => (
              <span key={col} className="glass-schema-col">
                {col}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function GlassEngine({
  events,
  totalCreditsSpent,
  creditBudget,
  activeTab: initialTab = 'sql',
}: GlassEngineProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="glass-engine">
      <div className="glass-header">
        <span className="glass-title">Glass Engine</span>
        <span className="glass-subtitle">Backend preview — see the engine</span>
      </div>
      <div className="glass-tabs">
        {TAB_CONFIG.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`glass-tab ${tab === t.id ? 'active' : ''}`}
          >
            <span className="glass-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
      <div className="glass-content">
        {tab === 'sql' && <SqlTape events={events} />}
        {tab === 'functions' && <FunctionLog events={events} />}
        {tab === 'auth' && <AuthTrace events={events} />}
        {tab === 'cost' && (
          <CostHud
            events={events}
            totalSpent={totalCreditsSpent}
            budget={creditBudget}
          />
        )}
        {tab === 'schema' && <SchemaMap events={events} />}
      </div>
    </div>
  );
}
