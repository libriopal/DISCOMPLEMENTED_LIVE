/**
 * Resend transactional email — direct `fetch()` against Resend's REST API,
 * matching this repo's existing pattern for Cohere (see lib/cohere.ts,
 * @bicameral/cohere) of hand-rolled fetch wrappers instead of a vendor SDK.
 *
 * Used by lib/auth.ts's `emailVerification.sendVerificationEmail` and
 * `emailAndPassword.sendResetPassword` hooks.
 *
 * Free tier (confirmed against resend.com/pricing 2026-08-11): 3,000
 * emails/mo, capped at 100/day, 1 verified sending domain, no credit card
 * required to sign up. Sufficient for verification/reset email volume at
 * launch scale; revisit if signup volume approaches ~100/day.
 *
 * LIVE: RESEND_API_KEY is provisioned as a production Worker secret, and
 * RESEND_FROM_EMAIL is an address on discomplemented.com, which is set up as
 * a Resend sending domain in Cloudflare DNS (DKIM at resend._domainkey, plus
 * the return-path MX/SPF pair on send.discomplemented.com). It is no longer
 * the `onboarding@resend.dev` sandbox, which could only deliver to the Resend
 * account owner's own address.
 */
import type { Env } from '../env.js';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

const RESEND_API_BASE = 'https://api.resend.com';

export async function sendEmail(
  params: SendEmailParams,
  env: Env
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error(
      'RESEND_API_KEY is not configured — run `wrangler secret put RESEND_API_KEY` ' +
        '(see env.ts). Transactional email (verification/password reset) cannot send until then.'
    );
  }

  const response = await fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Resend send failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
    );
  }
}

export function verificationEmailHtml(url: string): string {
  return `
    <p>Welcome to Discomplement — confirm your email to finish setting up your account.</p>
    <p><a href="${url}">Verify your email</a></p>
    <p>If you didn't create a Discomplement account, you can ignore this email.</p>
  `.trim();
}

export function resetPasswordEmailHtml(url: string): string {
  return `
    <p>A password reset was requested for your Discomplement account.</p>
    <p><a href="${url}">Reset your password</a></p>
    <p>If you didn't request this, you can ignore this email — your password won't change.</p>
  `.trim();
}
