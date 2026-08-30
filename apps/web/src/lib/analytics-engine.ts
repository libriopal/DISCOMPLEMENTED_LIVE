/**
 * Analytics Engine SQL API client — reads back what the telemetry
 * middleware writes via `ANALYTICS_ENGINE.writeDataPoint()`. The Workers
 * binding is write-only; querying requires the account-scoped HTTP SQL API.
 * See https://developers.cloudflare.com/analytics/analytics-engine/sql-api/.
 *
 * CF_ACCOUNT_ID / CF_ANALYTICS_API_TOKEN are optional secrets — when unset
 * (e.g. local dev), callers get an empty result set instead of a thrown
 * error, since the admin panel should degrade gracefully rather than 500
 * when telemetry querying isn't provisioned yet.
 */
import type { Env } from '../env.js';

export interface AnalyticsQueryResult {
  meta: { name: string; type: string }[];
  data: Record<string, string | number>[];
  rows: number;
}

export async function queryAnalyticsEngine(
  env: Env,
  sql: string
): Promise<AnalyticsQueryResult | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN) return null;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    }
  );

  if (!response.ok) return null;
  return response.json<AnalyticsQueryResult>();
}
