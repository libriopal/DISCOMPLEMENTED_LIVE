# Terms of Service — Bicameral (discomplement)

**DRAFT — not yet reviewed by a lawyer.** This document is a functional draft written to unblock implementation (a real consent checkbox needs real text behind it). Do not treat it as final or binding. Do not open the service to non-trial or paying users until this has had actual legal review. See `vault/vault_commercial_launch_plan.md` §4 for context.

_Last drafted: 2026-08-11._

## 1. What Bicameral is

Bicameral ("we," "us," "the Service") is a software tool that takes a natural-language description of an application and, through an automated 4-stage pipeline (research, design, a review step where you approve or reject the plan, and code generation), produces a working software project on your behalf. Generated code may be deployed to infrastructure we operate (for previews) or exported by you.

## 2. Accounts

You may create an account via GitHub OAuth or with an email address and password. You're responsible for keeping your credentials secure and for all activity under your account. You must be at least 18 years old, or the age of majority in your jurisdiction, to create an account.

## 3. Acceptable use

You may not use Bicameral to:

- Generate malware, ransomware, credential-harvesting tools, exploit code for unpatched vulnerabilities, or other tooling whose primary purpose is to cause unauthorized harm to computer systems;
- Generate content that violates Cohere's own usage policies (Bicameral is built on Cohere's API and inherits these obligations as a downstream consumer);
- Attempt to circumvent rate limits, credit limits, or the security scanning gate that reviews generated code before it deploys;
- Use the Service to build a directly competing prompt-to-app platform by systematically extracting our prompts, pipeline design, or generated outputs at scale;
- Violate any applicable law.

We reserve the right to suspend or terminate accounts that violate this section, including generated projects that fail our automated security gate repeatedly with findings that indicate intentional misuse rather than incidental error.

## 4. Ownership of generated code

Code generated for your projects through the pipeline is yours. We claim no ownership over the output of a generation run you initiated. We retain the right to store generated files (in our infrastructure, for preview and iteration purposes) for the lifetime of your account or project, whichever is deleted first.

## 5. Credits, trials, and billing

New accounts receive a time-limited trial credit allotment (currently 30 days from account creation). Once trial credits are exhausted, continued use of the pipeline requires a paid plan. Paid billing is processed by Stripe; by adding a payment method you agree to Stripe's own terms in addition to these. We do not store your raw payment card details — Stripe does. Credits are consumed per pipeline run based on the models and steps used; unused credits do not carry a cash-refund guarantee except where required by law.

## 6. Service level and disclaimers

Bicameral is provided as a beta/evolving service. We do not guarantee a specific uptime SLA at this stage. Generated code is produced by AI models and may contain bugs, security issues, or incorrect behavior — our automated security gate reduces but does not eliminate this risk. You are responsible for reviewing generated code before using it in any production or safety-critical context. THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.

## 7. Termination

You may delete your account at any time via account settings, which removes your stored projects and generated files per our Privacy Policy's retention terms. We may suspend or terminate accounts for Section 3 violations, non-payment, or abuse of shared infrastructure (e.g., generation runs designed to exhaust rate limits or credits maliciously).

## 8. Changes to these terms

We may update these Terms as the Service evolves. Material changes will be flagged at your next login; continued use after that point constitutes acceptance.

## 9. Contact

Questions about these Terms: [contact email — to be filled in with a real support address before launch].
