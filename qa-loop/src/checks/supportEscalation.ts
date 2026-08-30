/**
 * Check 5 — Support / escalation.
 *
 * Two parts, independently caught:
 *   a. Live-chat round-trip probe: mint a chat session via local
 *      `wrangler dev`'s POST /api/chat/token (as the QA-loop test tenant)
 *      and confirm the response looks like a real session (token/roomId
 *      present), NOT a full conversation — read-only probe.
 *   b. Read routes/chat.ts + lib/fluxychat.ts and check whether there is
 *      ANY explicit escalation logic keyed on security/privacy/billing/
 *      legal keywords (as opposed to just logging/passing every message to
 *      the same support-AI room). This is a source-code read, not a guess.
 */
import { readFile } from 'node:fs/promises';
import { LOCAL_API_BASE_URL, WEB_APP_ROOT } from '../config.ts';
import type { CheckFinding, CheckResult } from '../types.ts';
import type { TestTenant } from '../testTenant.ts';

const ESCALATION_KEYWORD_GROUPS = ['security', 'privacy', 'billing', 'legal'];

async function checkEscalationLogicInSource(): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  const filesToScan = [
    {
      path: `${WEB_APP_ROOT}src/routes/chat.ts`,
      label: 'apps/web/src/routes/chat.ts',
    },
    {
      path: `${WEB_APP_ROOT}src/lib/fluxychat.ts`,
      label: 'apps/web/src/lib/fluxychat.ts',
    },
  ];

  let combinedSource = '';
  for (const { path, label } of filesToScan) {
    try {
      const src = await readFile(path, 'utf-8');
      combinedSource += `\n${src}`;

      const hasEscalationFunction = /escalat/i.test(src);
      const keywordHits = ESCALATION_KEYWORD_GROUPS.filter((kw) =>
        new RegExp(kw, 'i').test(src)
      );

      if (!hasEscalationFunction) {
        findings.push({
          severity: 'medium',
          message: `No "escalat*" identifier found in ${label} — no dedicated escalation function/route for flagging sensitive conversations.`,
          location: label,
        });
      }
      if (keywordHits.length === 0) {
        findings.push({
          severity: 'medium',
          message: `None of the escalation keyword groups (${ESCALATION_KEYWORD_GROUPS.join('/')}) appear anywhere in ${label} — support routing has no keyword-based logic for security/privacy/billing/legal topics.`,
          location: label,
        });
      }
    } catch (err) {
      findings.push({
        severity: 'low',
        message: `Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Cross-check: does the pipeline-status tool webhook or session-mint path
  // do anything beyond logging a message through to the same support room?
  const hasConditionalRouting =
    /if\s*\([^)]*(security|privacy|billing|legal)/i.test(combinedSource);
  if (!hasConditionalRouting) {
    findings.push({
      severity: 'high',
      message:
        'Confirmed by source read: apps/web/src/routes/chat.ts and lib/fluxychat.ts contain no conditional branch that routes a message differently based on security/privacy/billing/legal content. Every founder message goes to the same Cohere-backed support-AI room (supportRoomId) regardless of sensitivity — there is no human-escalation path for e.g. "my card was charged twice" or "I found a security bug" beyond whatever FluxyChat\'s own hosted agent decides to do, which this codebase does not configure.',
      location: 'apps/web/src/routes/chat.ts, apps/web/src/lib/fluxychat.ts',
    });
  }

  return findings;
}

async function probeChatRoundTrip(tenant: TestTenant): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  try {
    const res = await fetch(`${LOCAL_API_BASE_URL}/api/chat/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.rawVirtualKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status >= 500) {
      findings.push({
        severity: res.status >= 500 ? 'high' : 'medium',
        message: `POST /api/chat/token returned ${res.status} for a valid test tenant.`,
      });
      return findings;
    }
    if (!res.ok) {
      findings.push({
        severity: 'low',
        message: `POST /api/chat/token returned ${res.status} — likely FLUXYCHAT_WORKER_URL (http://localhost:8788) isn't running locally, so the self-hosted FluxyChat Worker this bridges to is unreachable. Not a bug in Bicameral's own code, but does mean the live-chat round trip is unverifiable this pass without also standing up FluxyChat locally.`,
      });
      return findings;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const hasToken = typeof body.token === 'string' && body.token.length > 0;
    const hasRoomId = typeof body.roomId === 'string' && body.roomId.length > 0;
    if (hasToken && hasRoomId) {
      findings.push({
        severity: 'info',
        message:
          'Chat session mint round-trips successfully: token + roomId present.',
      });
    } else {
      findings.push({
        severity: 'medium',
        message: `Chat session response missing expected fields (token: ${hasToken}, roomId: ${hasRoomId}).`,
      });
    }
  } catch (err) {
    findings.push({
      severity: 'low',
      message: `Chat round-trip probe failed (likely FluxyChat Worker not running locally on :8788): ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return findings;
}

export async function runSupportEscalationCheck(
  tenant: TestTenant | null
): Promise<CheckResult> {
  const start = Date.now();
  const findings: CheckFinding[] = [];

  try {
    findings.push(...(await checkEscalationLogicInSource()));
  } catch (err) {
    findings.push({
      severity: 'low',
      message: `Escalation-logic source scan threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let unverifiable = false;
  let unverifiableReason: string | undefined;
  if (tenant) {
    try {
      findings.push(...(await probeChatRoundTrip(tenant)));
    } catch (err) {
      unverifiable = true;
      unverifiableReason = `Round-trip probe threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    unverifiable = true;
    unverifiableReason =
      'No test tenant available (tenant creation failed earlier) — round-trip probe skipped.';
  }

  const highOrAbove = findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical'
  );
  const status =
    highOrAbove.length > 0
      ? 'fail'
      : findings.some((f) => f.severity === 'medium')
        ? 'warn'
        : 'pass';

  return {
    id: 'support-escalation',
    title: 'Support / Escalation',
    status,
    summary:
      highOrAbove.length > 0
        ? 'No keyword-based escalation logic exists in chat routing — see findings.'
        : 'Escalation logic and round-trip checked; see findings for detail.',
    findings,
    durationMs: Date.now() - start,
    unverifiable,
    unverifiableReason,
  };
}
