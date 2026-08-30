# Privacy Policy — Bicameral (discomplement)

**DRAFT — not yet reviewed by a lawyer.** Do not treat as final or as a substitute for a real privacy/compliance review (GDPR, CCPA, or otherwise) before accepting non-trial or paying users. See `vault/vault_commercial_launch_plan.md` §4.

_Last drafted: 2026-08-11._

## 1. What we collect

- **Account data**: email address; if you sign in with GitHub, your GitHub profile identifier and avatar URL; a hashed password if you use email/password sign-in (we never store your plaintext password — hashing is handled by our auth library, scrypt by default).
- **Usage data**: prompts you submit to the pipeline, the research/design/code outputs generated for you, project files, and pipeline run metadata (timestamps, model used, token counts, credit consumption).
- **Telemetry**: aggregate usage and performance metrics, collected via Cloudflare Analytics Engine. This is write-scoped operational telemetry, not used for advertising.
- **Support chat**: messages you send through the in-app live chat (FluxyChat) are stored to provide support continuity.
- **Payment data** (once billing is live): Stripe processes and stores your payment method. We store a Stripe customer/subscription reference, not your card number.

## 2. Third parties who process your data

Bicameral is built by composing several third-party services, each of which processes a defined slice of your data as part of delivering the Service:

| Provider                                            | What they see                                                                         | Purpose                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cohere                                              | Your prompts and generated content, sent as API calls                                 | Powers the research/design/code pipeline                                                                       |
| OpenRouter                                          | Your prompts, for the free-tier code-generation model                                 | Cost-efficient routing for the Coder step                                                                      |
| GitHub (OAuth)                                      | Your GitHub identity, if you choose that sign-in method                               | Authentication only — we don't access your GitHub repos unless you explicitly connect them in a future feature |
| Stripe                                              | Payment method and billing history, once billing is live                              | Payment processing                                                                                             |
| Resend (or equivalent transactional email provider) | Your email address, for verification and password-reset emails                        | Account security flows                                                                                         |
| Cloudflare                                          | All of the above, as our hosting/infrastructure provider (Workers, D1, R2, Vectorize) | Runs the Service                                                                                               |

We do not sell your data to anyone, and we do not share it with third parties beyond what's needed to run the Service as described above.

## 3. Retention

Account and project data is retained for the life of your account. Deleting your account removes your stored projects and generated files from our active systems within a reasonable operational window; backups may persist briefly per standard operational practice before being purged. Generated code sent to third-party model providers (Cohere, OpenRouter) is subject to their own retention policies for API inputs, which we don't control — see their published data-processing terms.

## 4. Your rights

You can export your account/project data (self-service export, mirroring the admin panel's existing export capability) and delete your account at any time from account settings. Depending on your jurisdiction, you may have additional rights (access, correction, deletion, portability, objection to processing) — contact us to exercise these directly if self-service tools don't cover your request.

## 5. Security

Passwords are hashed, never stored in plaintext. API access uses per-user virtual keys that are stored only as salted hashes — the raw key is shown to you once, at creation. All generated code passes through an automated security scan before deployment. See our Terms of Service for the limits of what this scan guarantees.

## 6. Children

The Service is not directed at, and we do not knowingly collect data from, anyone under 18 (or the age of majority in their jurisdiction, if higher).

## 7. Changes

We'll flag material changes to this policy at your next login.

## 8. Contact

Privacy questions: [contact email — to be filled in with a real address before launch].
