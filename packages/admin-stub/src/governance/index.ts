/**
 * Stub governance module — all operations throw "admin module required"
 * except pure-function autonomy level checks.
 */
import type {
  ApprovalGate,
  AutonomyLevel,
  ClaimRecord,
} from '@bicameral/shared';
import { GovernanceError, BicameralError } from '@bicameral/shared';

const ADMIN_REQUIRED = (op: string) =>
  new BicameralError(
    `"${op}" requires the private @bicameral/admin module.`,
    'ADMIN_MODULE_REQUIRED',
    501
  );

export async function approvalGate(): Promise<ApprovalGate> {
  throw ADMIN_REQUIRED('approvalGate');
}
export async function aiAuditor(): Promise<{
  passed: boolean;
  violations: string[];
}> {
  // In stub mode, always pass (no auditor available)
  return { passed: true, violations: [] };
}
export async function verifyEvidence(): Promise<{
  status: string;
  claims: ClaimRecord[];
}> {
  throw ADMIN_REQUIRED('verifyEvidence');
}
export async function researchFreeze(): Promise<void> {
  throw ADMIN_REQUIRED('researchFreeze');
}

// Pure function — safe for stub
export function enforceAutonomyLevel(
  operation: string,
  level: AutonomyLevel,
  userApproval: boolean
): void {
  if (level === 'L5' && !userApproval) {
    throw new GovernanceError(
      `L5 human approval required for "${operation}"`,
      operation
    );
  }
  if (level === 'L4' && !userApproval) {
    throw new GovernanceError(
      `L4 controlled approval required for "${operation}"`,
      operation
    );
  }
}
