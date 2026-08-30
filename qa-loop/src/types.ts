export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped' | 'error';

export interface CheckFinding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  location?: string; // e.g. "apps/web/src/routes/chat.ts:42" or "file:line"
}

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  findings: CheckFinding[];
  details?: Record<string, unknown>;
  /** Wall-clock duration of the check itself, ms. */
  durationMs: number;
  /** True if this check could not be run at all and is a known/expected gap. */
  unverifiable?: boolean;
  unverifiableReason?: string;
}

export interface HarnessRunMeta {
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  cohereSpendUsd: number;
  budgetCapUsd: number;
  budgetCapped: boolean;
  testTenantUserId?: string;
  gitCommit?: string;
  gitBranch?: string;
}
