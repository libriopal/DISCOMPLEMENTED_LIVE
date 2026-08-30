/**
 * Shared research-query quota check — used by both the ad-hoc
 * `POST /api/research` route and the pipeline's internal web-search tool
 * (pipeline/tools/web-search.ts), so a founder's pipeline runs and their
 * manual research queries draw from the same monthly cap instead of two
 * inconsistent counters. Cap source: TIER_LIMITS[tier].researchQueries.
 */
import { TierError } from '@bicameral/shared/errors';
import { TIER_LIMITS } from '@bicameral/shared/constants';
import type { SubscriptionTier } from '@bicameral/shared/types';

const RESEARCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches "X/mo" tier caps

export async function assertResearchQuota(
  db: D1Database,
  userId: string,
  tier: SubscriptionTier
): Promise<void> {
  const cap = TIER_LIMITS[tier].researchQueries;
  if (cap === Infinity) return;

  const since = new Date(Date.now() - RESEARCH_WINDOW_MS).toISOString();
  const usage = await db
    .prepare(
      'SELECT COUNT(*) as count FROM research_queries WHERE user_id = ? AND created_date >= ?'
    )
    .bind(userId, since)
    .first<{ count: number }>();

  if ((usage?.count ?? 0) >= cap) {
    throw new TierError(
      `Research query limit reached for ${tier} tier (${cap}/mo)`
    );
  }
}
