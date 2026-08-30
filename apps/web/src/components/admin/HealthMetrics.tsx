/**
 * Real-time system health tile row + per-agent pipeline step P95 bars.
 * Data comes from GET /api/admin/metrics (routes/admin.ts) — see
 * @agent_docs/admin-panel.md "Panel Layout" for the mockup this mirrors.
 */
export interface AdminMetrics {
  requestsPerHour: number | null;
  avgRequestDurationMs: number | null;
  errorRate: number | null;
  activeUsers: number;
  activeSandboxes: number;
  maxSandboxInstances: number;
  activePipelines: number;
  avgCoderIterations: number | null;
  pipelineSuccessRate: number | null;
  pipelinesByStatus: Record<string, number>;
  pipelineStepTiming: {
    agentRole: string;
    p95Ms: number;
    p99Ms: number;
    avgMs: number;
    count: number;
  }[];
  analyticsEngineConfigured: boolean;
  maintenanceMode: boolean;
  emergencyShutdown: boolean;
}

// Fixed pipeline order (never re-sorted by value — see dataviz skill
// "color follows the entity, never its rank").
// Mirrors PIPELINE_STEP_ORDER in @bicameral/shared/constants — the live
// 5-role loop. The old 4-step list led with "architect", a role that is dead
// in packages/cohere/src/model-router.ts (`legacy — now handled by
// researcher`), so it always rendered an empty bar at the top.
const AGENT_ORDER = [
  'researcher',
  'auditor',
  'verifier',
  'designer',
  'coder',
] as const;
const AGENT_LABEL: Record<string, string> = {
  researcher: 'Step 1 Researcher',
  auditor: 'Step 2 Auditor',
  verifier: 'Step 3 Verifier',
  designer: 'Step 4 Designer',
  coder: 'Step 5 Coder',
};

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          color: 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {label}
      </div>
    </div>
  );
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtPct(ratio: number | null): string {
  if (ratio === null) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function HealthMetrics({ metrics }: { metrics: AdminMetrics }) {
  const timingByRole = new Map(
    metrics.pipelineStepTiming.map((t) => [t.agentRole, t])
  );
  const maxP95 = Math.max(1, ...metrics.pipelineStepTiming.map((t) => t.p95Ms));

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <div>
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-4)' }}>
          Health Metrics
        </h3>
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}
        >
          <Tile
            label="Requests / hr"
            value={
              metrics.requestsPerHour === null
                ? metrics.analyticsEngineConfigured
                  ? '—'
                  : 'not configured'
                : String(Math.round(metrics.requestsPerHour))
            }
          />
          <Tile
            label="Avg request time"
            value={fmtMs(metrics.avgRequestDurationMs)}
          />
          <Tile label="Error rate" value={fmtPct(metrics.errorRate)} />
          <Tile label="Active users" value={String(metrics.activeUsers)} />
          <Tile
            label="Sandboxes"
            value={`${metrics.activeSandboxes} / ${metrics.maxSandboxInstances}`}
          />
          <Tile
            label="Active pipelines"
            value={String(metrics.activePipelines)}
          />
          <Tile
            label="Avg Coder iterations"
            value={
              metrics.avgCoderIterations === null
                ? '—'
                : metrics.avgCoderIterations.toFixed(1)
            }
          />
          <Tile
            label="Pipeline success rate"
            value={fmtPct(metrics.pipelineSuccessRate)}
          />
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 16, paddingBottom: 'var(--space-3)' }}>
          Pipeline Step P95
        </h3>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {AGENT_ORDER.map((role) => {
            const t = timingByRole.get(role);
            const widthPct = t ? Math.max(2, (t.p95Ms / maxP95) * 100) : 0;
            return (
              <div
                key={role}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                }}
                title={
                  t
                    ? `p95 ${fmtMs(t.p95Ms)} · p99 ${fmtMs(t.p99Ms)} · avg ${fmtMs(t.avgMs)} · n=${t.count}`
                    : 'no completed steps yet'
                }
              >
                <div
                  style={{
                    width: 140,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {AGENT_LABEL[role]}
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 10,
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--surface-raised)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${widthPct}%`,
                      height: '100%',
                      borderRadius: 'var(--radius-pill)',
                      background: 'var(--color-accent)',
                    }}
                  />
                </div>
                <div style={{ width: 56, fontSize: 12, textAlign: 'right' }}>
                  {t ? fmtMs(t.p95Ms) : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
