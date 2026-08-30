# Contributing to Discomplement

Thank you for your interest in contributing! Discomplement is an AI-powered prompt-to-app platform that uses a Monte Carlo evolutionary architecture to optimize value delivery.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/COMPaNiON.git`
3. Install dependencies: `pnpm install`
4. Create a feature branch: `git checkout -b feat/your-feature`
5. Make your changes
6. Run checks: `pnpm lint && pnpm type-check && pnpm test`
7. Commit using [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, etc.
8. Push and open a Pull Request

## Pull Request Process

- All PRs require at least 1 review
- Security-sensitive paths (`/routes`, `/lib/tripwires`, `/lib/vdr-engine`, `/migrations`, `/.github`) require owner review via CODEOWNERS
- CI must pass (lint, type-check, tests, security scan, sanitize check)
- Use squash merge

## Code Standards

- TypeScript strict mode
- Prettier for formatting (config in `.prettierrc`)
- Conventional commits enforced by commitlint
- No secrets in code — use `wrangler secret put` for production
- No `console.log` in production code (use the logging system)

## Security-Sensitive Changes

If your PR touches:

- Authentication or authorization
- Tripwires or VDR engine
- Database migrations
- Credit/billing logic
- Security gates

...it requires explicit owner review and may need additional security testing.

## Contributor License Agreement (CLA) or DCO

We accept contributions under either a CLA or DCO:

### Option A: CLA (Contributor License Agreement)

### Option B: DCO (Developer Certificate of Origin)

Add `Signed-off-by: Your Name <your.email@example.com>` to your commit message:

```
feat: add new component

Signed-off-by: Your Name <your.email@example.com>
```

This certifies that you created the contribution and have the right to submit it under the AGPL-3.0 license.

By submitting a pull request, you agree that:

1. You have the right to contribute your code under the AGPL-3.0 license
2. Your contribution is original work or properly attributed
3. You grant Discomplement a perpetual, worldwide, non-exclusive license to use, modify, and distribute your contribution
4. Your contribution is not confidential and may be publicly disclosed

## Reporting Issues

- Bug reports: use the `bug_report.yml` template
- Feature requests: use the `feature_request.yml` template
- Security vulnerabilities: see [SECURITY.md](SECURITY.md)

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be respectful and inclusive.
