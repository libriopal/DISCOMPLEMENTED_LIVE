# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Discomplement, please report it responsibly.

**DO NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. Email: security@discomplemented.com
2. Include a detailed description of the vulnerability
3. Provide steps to reproduce (if applicable)
4. Do not exploit the vulnerability or access data that isn't yours

### Response Timeline

| Stage              | Target                                           |
| ------------------ | ------------------------------------------------ |
| Acknowledgment     | Within 48 hours                                  |
| Initial assessment | Within 5 business days                           |
| Fix or mitigation  | Within 30 days (severity-dependent)              |
| Public disclosure  | After fix is deployed, coordinated with reporter |

### Scope

- Production deployment at discomplemented.com
- This repository's code (COMPaNiON)
- Authentication and authorization systems
- Data storage and access controls

### Out of Scope

- Third-party services (Cloudflare, Cohere, Stripe) — report to them directly
- Self-hosted deployments (report to the operator)
- Already known issues listed in GitHub Issues
- Feature requests

### Safe Harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations and data destruction
- Do not access or modify data that isn't theirs
- Report vulnerabilities promptly
- Do not publicly disclose until a fix is deployed

## Security Measures

- All secrets stored via Cloudflare Worker secrets (never in git)
- GitHub secret scanning enabled
- CodeQL analysis on every PR
- Branch protection requires review for security-sensitive paths
- `lib/tripwires/` directory is CODEOWNERS-protected

## DMCA Agent

Discomplement maintains a designated DMCA agent as required by 17 U.S.C. § 512(c)(2).

- DMCA notices: dmca@discomplemented.com
- The designated agent is registered with the U.S. Copyright Office.
