/**
 * Recommendations engine — heuristic rules R1-R12 from
 * @agent_docs/admin-panel.md "Recommendations Engine Rules". Pure function
 * over already-gathered metrics so routes/admin.ts can reuse the same D1/AE
 * reads for both /metrics and /recommendations without querying twice.
 */

export interface Recommendation {
  rule: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface RouteStat {
  route: string;
  p95Ms: number;
  errorRate: number;
}

export interface IpEventStat {
  ipAddress: string;
  count: number;
}

export interface RecommendationInput {
  routeStats: RouteStat[];
  wafByIp: IpEventStat[];
  failedAuthByIp: IpEventStat[];
  activeSandboxes: number;
  maxSandboxInstances: number;
  usersNearCreditCap: { userId: string; percentUsed: number }[];
  negativeBalanceUsers: string[];
  generateRouteP95Ms: number | null;
  architectP95Ms: number | null;
  coderAvgIterations: number | null;
  pipelineSuccessRate: number | null;
  blueprintRejectionRate: number | null;
}

export function computeRecommendations(
  input: RecommendationInput
): Recommendation[] {
  const recs: Recommendation[] = [];

  // R1: D1 query latency > 100ms on any route
  for (const r of input.routeStats.filter((r) => r.p95Ms > 100)) {
    recs.push({
      rule: 'R1',
      message: `Add D1 index on the query backing ${r.route} (p95 ${Math.round(r.p95Ms)}ms)`,
      severity: 'warning',
    });
  }

  // R2: Error rate > 5% on any route
  for (const r of input.routeStats.filter((r) => r.errorRate > 0.05)) {
    recs.push({
      rule: 'R2',
      message: `Investigate ${r.route} — error rate ${(r.errorRate * 100).toFixed(1)}%`,
      severity: 'critical',
    });
  }

  // R3: WAF events from single IP > 500/hr
  for (const ip of input.wafByIp.filter((i) => i.count > 500)) {
    recs.push({
      rule: 'R3',
      message: `Apply rate limit to IP ${ip.ipAddress} (${ip.count} WAF events/hr)`,
      severity: 'critical',
    });
  }

  // R4: Credit usage > 80% of monthly cap for tier
  for (const u of input.usersNearCreditCap.slice(0, 5)) {
    recs.push({
      rule: 'R4',
      message: `Notify user ${u.userId} — approaching credit limit (${Math.round(u.percentUsed * 100)}%)`,
      severity: 'info',
    });
  }

  // R5: p95 latency > 500ms on generate route
  if (input.generateRouteP95Ms !== null && input.generateRouteP95Ms > 500) {
    recs.push({
      rule: 'R5',
      message:
        'Consider adding Cohere model cache — /api/generate p95 exceeds 500ms',
      severity: 'warning',
    });
  }

  // R6: Active sandboxes > 80% of max_instances
  if (input.activeSandboxes > 0.8 * input.maxSandboxInstances) {
    recs.push({
      rule: 'R6',
      message: `Scale container max_instances — ${input.activeSandboxes}/${input.maxSandboxInstances} sandboxes active`,
      severity: 'warning',
    });
  }

  // R7: Failed auth > 10 from same IP in 1hr
  for (const ip of input.failedAuthByIp.filter((i) => i.count > 10)) {
    recs.push({
      rule: 'R7',
      message: `Auto-ban IP ${ip.ipAddress} — brute force detected (${ip.count} failed auth/hr)`,
      severity: 'critical',
    });
  }

  // R8: Credit ledger negative balance
  for (const userId of input.negativeBalanceUsers.slice(0, 5)) {
    recs.push({
      rule: 'R8',
      message: `Suspend virtual key for user ${userId} — negative credit balance`,
      severity: 'critical',
    });
  }

  // R9: Architect agent (Command A) P95 > 30s
  if (input.architectP95Ms !== null && input.architectP95Ms > 30_000) {
    recs.push({
      rule: 'R9',
      message: `Consider caching common project briefs — Architect p95 ${(input.architectP95Ms / 1000).toFixed(1)}s`,
      severity: 'warning',
    });
  }

  // R10: Coder error iterations avg > 3
  if (input.coderAvgIterations !== null && input.coderAvgIterations > 3) {
    recs.push({
      rule: 'R10',
      message: `Blueprint quality may be low — review Designer agent prompts (avg ${input.coderAvgIterations.toFixed(1)} Coder iterations)`,
      severity: 'warning',
    });
  }

  // R11: Pipeline success rate < 80%
  if (input.pipelineSuccessRate !== null && input.pipelineSuccessRate < 0.8) {
    recs.push({
      rule: 'R11',
      message: `Investigate common failure points in Step 4 — pipeline success rate ${Math.round(input.pipelineSuccessRate * 100)}%`,
      severity: 'critical',
    });
  }

  // R12: Blueprints rejected > 30%
  if (
    input.blueprintRejectionRate !== null &&
    input.blueprintRejectionRate > 0.3
  ) {
    recs.push({
      rule: 'R12',
      message: `Designer agent may need prompt tuning — ${Math.round(input.blueprintRejectionRate * 100)}% of blueprints rejected`,
      severity: 'warning',
    });
  }

  return recs;
}
