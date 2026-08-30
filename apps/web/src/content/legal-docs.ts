/**
 * Legal doc content for the standalone /legal/* screens (LegalDocScreen).
 * Mirrored from vault/legal/*.md (Phase B drafts — see
 * vault_commercial_launch_plan.md §4). vault/ isn't part of the deployed
 * bundle, so the text is inlined here rather than fetched at runtime;
 * LoginScreen's consent checkbox already links to /legal/terms and
 * /legal/privacy — before this file, those paths had no real content
 * behind them (App.tsx's SPA fallback just re-rendered the login gate).
 *
 * Keep this in sync by hand if vault/legal/*.md changes — there's no build
 * step wiring the two together yet.
 */

export interface LegalDoc {
  slug: string;
  title: string;
  markdown: string;
}

export const LEGAL_DOCS: Record<string, LegalDoc> = {
  terms: {
    slug: 'terms',
    title: 'Terms of Service',
    markdown: `**Preliminary — under review.** This document is a functional draft written to unblock implementation (a real consent checkbox needs real text behind it). Do not treat it as final or binding. Do not open the service to non-trial or paying users until this has had actual legal review.

_Last updated: 2026-08-21._

## 1. What Discomplement is

Discomplement ("we," "us," "the Service") is a software tool that takes a natural-language description of an application and, through an automated 5-stage pipeline (research, audit, verification, design, and code generation), produces a working software project on your behalf. Generated code may be deployed to infrastructure we operate (for previews) or exported by you.

## 2. Accounts

You may create an account via GitHub OAuth or with an email address and password. You're responsible for keeping your credentials secure and for all activity under your account. You must be at least 18 years old, or the age of majority in your jurisdiction, to create an account.

## 3. Acceptable use

You may not use Discomplement to:

- Generate malware, ransomware, credential-harvesting tools, exploit code for unpatched vulnerabilities, or other tooling whose primary purpose is to cause unauthorized harm to computer systems;
- Generate content that violates Cohere's own usage policies (Discomplement is built on Cohere's API and inherits these obligations as a downstream consumer);
- Attempt to circumvent rate limits, credit limits, or the security scanning gate that reviews generated code before it deploys;
- Use the Service to build a directly competing prompt-to-app platform by systematically extracting our prompts, pipeline design, or generated outputs at scale;
- Violate any applicable law.

We reserve the right to suspend or terminate accounts that violate this section, including generated projects that fail our automated security gate repeatedly with findings that indicate intentional misuse rather than incidental error.

## 4. Ownership of generated code

Code generated for your projects through the pipeline is yours. We claim no ownership over the output of a generation run you initiated. We retain the right to store generated files (in our infrastructure, for preview and iteration purposes) for the lifetime of your account or project, whichever is deleted first.

## 5. Credits, trials, and billing

New accounts receive a time-limited trial credit allotment (currently 30 days from account creation). Once trial credits are exhausted, continued use of the pipeline requires a paid plan. Paid billing is processed by Stripe; by adding a payment method you agree to Stripe's own terms in addition to these. We do not store your raw payment card details — Stripe does. Credits are consumed per pipeline run based on the models and steps used; unused credits do not carry a cash-refund guarantee except where required by law.

## 6. Service level and disclaimers

Discomplement is provided as a beta/evolving service. We do not guarantee a specific uptime SLA at this stage. Generated code is produced by AI models and may contain bugs, security issues, or incorrect behavior — our automated security gate reduces but does not eliminate this risk. You are responsible for reviewing generated code before using it in any production or safety-critical context. THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.

## 7. Termination

You may delete your account at any time via account settings, which removes your stored projects and generated files per our Privacy Policy's retention terms. We may suspend or terminate accounts for Section 3 violations, non-payment, or abuse of shared infrastructure (e.g., generation runs designed to exhaust rate limits or credits maliciously).

## 8. Changes to these terms

We may update these Terms as the Service evolves. Material changes will be flagged at your next login; continued use after that point constitutes acceptance.

## 9. Contact

Questions about these Terms: support@discomplemented.com.`,
  },
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    markdown: `**Preliminary — under review.** This document is a functional draft provided in good faith. It will be reviewed by counsel before general availability. For questions, contact support@discomplemented.com.

_Last updated: 2026-08-21._

## 1. What we collect

- **Account data**: email address; if you sign in with GitHub, your GitHub profile identifier and avatar URL; a hashed password if you use email/password sign-in (we never store your plaintext password — hashing is handled by our auth library, scrypt by default).
- **Usage data**: prompts you submit to the pipeline, the research/design/code outputs generated for you, project files, and pipeline run metadata (timestamps, model used, token counts, credit consumption).
- **Telemetry**: aggregate usage and performance metrics, collected via Cloudflare Analytics Engine. This is write-scoped operational telemetry, not used for advertising.
- **Support chat**: messages you send through the in-app live chat (FluxyChat) are stored to provide support continuity.
- **Payment data** (once billing is live): Stripe processes and stores your payment method. We store a Stripe customer/subscription reference, not your card number.

## 2. Third parties who process your data

Discomplement is built by composing several third-party services, each of which processes a defined slice of your data as part of delivering the Service: Cohere (your prompts and generated content, to power the research/design/code pipeline); OpenRouter (your prompts, for the free-tier code-generation model); GitHub OAuth (your GitHub identity, if you choose that sign-in method — we don't access your repos unless you explicitly connect them in a future feature); Stripe (payment method and billing history, once billing is live); our transactional email provider (your email address, for verification and password-reset emails); and Cloudflare (all of the above, as our hosting/infrastructure provider — Workers, D1, R2, Vectorize).

We do not sell your data to anyone, and we do not share it with third parties beyond what's needed to run the Service as described above.

## 3. Retention

Account and project data is retained for the life of your account. Deleting your account removes your stored projects and generated files from our active systems within a reasonable operational window; backups may persist briefly per standard operational practice before being purged. Generated code sent to third-party model providers (Cohere, OpenRouter) is subject to their own retention policies for API inputs, which we don't control.

## 4. Your rights

You can export your account/project data (self-service export, mirroring the admin panel's existing export capability) and delete your account at any time from account settings. Depending on your jurisdiction, you may have additional rights (access, correction, deletion, portability, objection to processing) — contact us to exercise these directly if self-service tools don't cover your request.

## 5. Security

Passwords are hashed, never stored in plaintext. API access uses per-user virtual keys that are stored only as salted hashes — the raw key is shown to you once, at creation. All generated code passes through an automated security scan before deployment. See our Terms of Service for the limits of what this scan guarantees.

## 6. Children

The Service is not directed at, and we do not knowingly collect data from, anyone under 18 (or the age of majority in their jurisdiction, if higher).

## 7. Changes

We'll flag material changes to this policy at your next login.

## 8. Contact

Privacy questions: support@discomplemented.com.`,
  },
  cookies: {
    slug: 'cookies',
    title: 'Cookie & Session Notice',
    markdown: `**Preliminary — under review.**

_Last updated: 2026-08-21._

Discomplement uses one essential, functionally-required cookie: a session cookie set by our authentication system (Better Auth) when you sign in, used to keep you logged in across requests. This cookie is not optional — the Service cannot function without it, so we don't present a cookie-consent banner for it (consistent with guidance that strictly necessary cookies don't require opt-in consent under most cookie-law frameworks).

We do not currently use third-party advertising or cross-site tracking cookies. If that changes in the future, this notice will be updated and a consent mechanism will be added before any such cookies are set.

Session cookies are \`HttpOnly\` and \`Secure\` in production, and scoped to our domain only (\`SameSite\`). You can end your session at any time by logging out, which clears the cookie.`,
  },
  'acceptable-use': {
    slug: 'acceptable-use',
    title: 'Acceptable Use Policy',
    markdown: `**Preliminary — under review.** This expands on Terms of Service §3; presented separately so it can be linked to directly from moderation/enforcement messaging.

_Last updated: 2026-08-21._

You may not use Discomplement's pipeline to generate, request, or attempt to extract:

1. **Malicious software** — malware, ransomware, botnets, keyloggers, or code whose primary purpose is unauthorized access to or damage of computer systems.
2. **Exploit tooling** — proof-of-concept or working exploits for vulnerabilities you don't have explicit authorization to test against, or tooling designed to automate attacks against systems you don't own or have permission to test.
3. **Credential and data harvesting tools** — phishing kits, fake login pages, scrapers designed to defeat rate limits or terms of service of other platforms for the purpose of harvesting personal data at scale.
4. **Content violating Cohere's usage policies** — since Discomplement's pipeline runs on Cohere's API, anything that would violate Cohere's own acceptable-use terms is also prohibited here.
5. **Abuse of shared infrastructure** — deliberately crafting prompts or generation loops to exhaust rate limits, credits, or the security-scanning gate's capacity, or to circumvent per-account credit limits.
6. **Illegal content** under the laws applicable to you or to us.

**Enforcement.** Violations may result in a generation run being blocked, an account being rate-limited, suspended, or terminated, and — for serious or repeated violations — a report to relevant authorities where we're legally required or where the conduct poses a genuine safety risk. Our automated security gate (Semgrep-based static analysis on every generated project) is a detection layer, not the sole enforcement mechanism.

**Good-faith security research.** If you're testing Discomplement's own security (not a third party's), see our responsible disclosure process [link — to be added] rather than this policy's restrictions on exploit tooling.`,
  },
  dmca: {
    slug: 'dmca',
    title: 'DMCA Copyright Policy',
    markdown: `**Designated Agent for Digital Millennium Copyright Act (DMCA) Notices**

_Last updated: 2026-08-21._

## 1. Designated Agent

In accordance with 17 U.S.C. § 512(c)(2), Discomplement (the "Service") has designated an agent to receive notification of alleged copyright infringement. Our designated agent's contact information is:

**Service Provider:** Johnathan Potter (doing business as Discomplement)

**Designated Agent:** Johnathan Potter

**Address:** [Physical address on file with the U.S. Copyright Office DMCA Directory]

**Email:** discomplement.admin@discomplemented.com

**Phone:** [Phone number on file with the U.S. Copyright Office DMCA Directory]

A copy of our DMCA designation is registered with the U.S. Copyright Office DMCA Directory and is available at https://copyright.gov/dmca-directory/.

## 2. Filing a Copyright Infringement Notice

To file a notice of alleged copyright infringement with us, you must provide a written communication (per 17 U.S.C. § 512(c)(3)) that includes the following:

1. **Identification of the copyrighted work** claimed to have been infringed, or, if multiple copyrighted works at a single online site are covered by a single notification, a representative list of such works.

2. **Identification of the material that is claimed to be infringing** and that is to be removed or access to which is to be disabled, including information reasonably sufficient to permit us to locate the material (e.g., the URL on discomplemented.com where the material appears).

3. **Your contact information**, including your full name, mailing address, telephone number, and email address.

4. A **statement that you have a good faith belief** that use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.

5. A **statement, made under penalty of perjury**, that the information in the notification is accurate and that you are authorized to act on behalf of the copyright owner.

6. Your **physical or electronic signature**.

## 3. How to Submit

Send your DMCA notice to our designated agent by email:

**Email:** discomplement.admin@discomplemented.com

Include "DMCA Takedown Notice" in the subject line.

## 4. Counter-Notification

If you believe that your material was removed or disabled by mistake or misidentification, you may file a counter-notification with our designated agent. Your counter-notification must include:

1. Identification of the material that has been removed or to which access has been disabled, and the location at which the material appeared before it was removed or access was disabled.

2. A statement, made under penalty of perjury, that you have a good faith belief that the material was removed or disabled as a result of mistake or misidentification.

3. Your full name, address, telephone number, and email address.

4. A statement that you consent to the jurisdiction of the Federal District Court for the judicial district in which your address is located (or if your address is outside the United States, the Northern District of Georgia), and that you will accept service of process from the person who provided the original takedown notification.

5. Your physical or electronic signature.

## 5. Repeat Infringers

We will terminate the accounts of users who are determined to be repeat infringers in accordance with the DMCA.

## 6. No Liability

We reserve the right to remove or disable access to material that we believe in good faith may infringe the copyrights of others, regardless of whether we have received a formal DMCA notice. We are not liable for removing or disabling access to material in good faith.

## 7. Contact

Questions about this policy: discomplement.admin@discomplemented.com`,
  },
  // ─── EICCA Terms ──────────────────────────────────────────────
  eicca: {
    slug: 'eicca',
    title: 'EICCA — Emergency Injection of Capital and Credit Agreement',
    markdown: `**Preliminary — under review.** This document is a functional draft provided in good faith. It will be reviewed by counsel before general availability. For questions, contact support@discomplemented.com.

_Last updated: 2026-08-21._

## 1. What EICCA is

The Emergency Injection of Capital and Credit Agreement (EICCA) allows eligible Discomplement users to receive emergency API credits when they have exhausted their paid credit balance. In exchange, the user grants Discomplement a revenue-share instrument (RBF), a SAFE note, or a warrant backed by the entity they declare at contract creation time.

EICCA ensures no user loses a deployment, deadline, or revenue opportunity because they ran out of credits mid-generation. It is a safety net, not a primary billing mechanism.

## 2. Eligibility

To be eligible for an EICCA contract, you must:
- Have a registered Discomplement account in good standing
- Have exhausted your current paid credit balance
- Declare a legal entity type (LLC, C-Corp, or S-Corp)
- Accept the contract terms via an explicit consent action (signed signature)

## 3. Instrument Types

EICCA supports three instrument types:
1. Revenue-Based Financing (RBF): You repay the credit amount plus a revenue-share percentage until the repayment cap is reached.
2. SAFE (Simple Agreement for Future Equity): The credit amount converts to equity at a valuation cap or discount rate upon a qualifying financing event.
3. Warrant: You grant Discomplement a warrant to purchase equity at a specified strike price.

## 4. Terms and Repayment

- Contract terms are hashed (SHA-256) and stored immutably at creation time
- The consent signature, timestamp, and IP are recorded
- A cancellation window is provided (specified in the contract terms)
- Repayment is processed automatically via webhook when revenue events occur
- Default terms are defined per instrument type and are non-negotiable at the EICCA level

## 5. Risk Disclosure

EICCA contracts involve real financial obligations. By accepting an EICCA contract, you are granting Discomplement a legal interest in your entity revenue or equity. You should consult with a financial advisor or attorney before accepting any EICCA contract. Discomplement provides EICCA contracts as a goodwill mechanism to prevent service interruption.

## 6. Cancellation

You may cancel an EICCA contract within the cancellation window specified in the contract terms. After the cancellation window expires, the contract is binding and may only be terminated through repayment, conversion, or mutual agreement.

## 7. Privacy

EICCA contract data (entity name, entity type, instrument terms, consent records) is stored in our D1 database and is accessible only to you and Discomplement administrators. This data is retained for the life of the contract plus 7 years for audit and compliance purposes.

## 8. Contact

Questions about EICCA: support@discomplemented.com.`,
  },
};
