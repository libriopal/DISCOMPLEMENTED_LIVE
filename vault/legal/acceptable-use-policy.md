# Acceptable Use Policy — Bicameral (discomplement)

**DRAFT — not yet reviewed by a lawyer.** See `vault/vault_commercial_launch_plan.md` §4. This expands on Terms of Service §3; presented separately so it can be linked to directly from moderation/enforcement messaging.

_Last drafted: 2026-08-11._

You may not use Bicameral's pipeline to generate, request, or attempt to extract:

1. **Malicious software** — malware, ransomware, botnets, keyloggers, or code whose primary purpose is unauthorized access to or damage of computer systems.
2. **Exploit tooling** — proof-of-concept or working exploits for vulnerabilities you don't have explicit authorization to test against, or tooling designed to automate attacks against systems you don't own or have permission to test.
3. **Credential and data harvesting tools** — phishing kits, fake login pages, scrapers designed to defeat rate limits or terms of service of other platforms for the purpose of harvesting personal data at scale.
4. **Content violating Cohere's usage policies** — since Bicameral's pipeline runs on Cohere's API, anything that would violate Cohere's own acceptable-use terms is also prohibited here.
5. **Abuse of shared infrastructure** — deliberately crafting prompts or generation loops to exhaust rate limits, credits, or the security-scanning gate's capacity, or to circumvent per-account credit limits.
6. **Illegal content** under the laws applicable to you or to us.

**Enforcement.** Violations may result in a generation run being blocked, an account being rate-limited, suspended, or terminated, and — for serious or repeated violations — a report to relevant authorities where we're legally required or where the conduct poses a genuine safety risk. Our automated security gate (Semgrep-based static analysis on every generated project) is a detection layer, not the sole enforcement mechanism — manual review and account-level action remain available to us independent of what the automated gate finds.

**Good-faith security research.** If you're testing Bicameral's own security (not a third party's), see our responsible disclosure process [link — to be added] rather than this policy's restrictions on exploit tooling.
