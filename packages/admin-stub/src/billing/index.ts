/**
 * Stub billing module — all operations throw "admin module required"
 */
import type { Subscription, CreditLedgerEntry, SubscriptionTier } from '@bicameral/shared';
import { BicameralError, CREDIT_COSTS, TIER_LIMITS } from '@bicameral/shared';

const ADMIN_REQUIRED = (op: string) =>
  new BicameralError(
    `"${op}" requires the private @bicameral/admin module. See packages/admin-stub/README.md for self-hosting instructions.`,
    'ADMIN_MODULE_REQUIRED',
    501
  );

export async function stripeWebhookHandler(): Promise<Response> {
  throw ADMIN_REQUIRED('stripeWebhookHandler');
}
export async function createSubscription(): Promise<Subscription> {
  throw ADMIN_REQUIRED('createSubscription');
}
export async function cancelSubscription(): Promise<Subscription> {
  throw ADMIN_REQUIRED('cancelSubscription');
}
export async function getSubscription(): Promise<Subscription | null> {
  throw ADMIN_REQUIRED('getSubscription');
}
export async function deductCredits(): Promise<CreditLedgerEntry> {
  throw ADMIN_REQUIRED('deductCredits');
}
export async function checkCredits(): Promise<number> {
  // Return 0 in stub mode — no billing system
  return 0;
}
export async function resetCredits(): Promise<void> {
  throw ADMIN_REQUIRED('resetCredits');
}

// These are pure functions that CAN be in the stub (no secrets needed)
export function checkTierAccess(userTier: SubscriptionTier, requiredTier: SubscriptionTier): void {
  const tierOrder: SubscriptionTier[] = ['free', 'pro', 'team', 'enterprise'];
  const userLevel = tierOrder.indexOf(userTier);
  const requiredLevel = tierOrder.indexOf(requiredTier);
  if (userLevel < requiredLevel) {
    throw new BicameralError(`Requires ${requiredTier} tier`, 'TIER_INSUFFICIENT', 403, { userTier, requiredTier });
  }
}

export function getModelForTier(tier: SubscriptionTier): string {
  // Return the free model in stub mode
  return 'command-r7b-12-2024';
}
