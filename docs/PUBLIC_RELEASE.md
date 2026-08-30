# Public release — what actually happened

**This repo is public.** Executed 2026-08-30. This file used to describe the
plan; it now describes the result, because the plan and the result differ in
ways that matter to anyone maintaining the split.

## What was done

1. **`packages/admin/` left this repository.** All 22 files moved to
   `libriopal/DISCOMPLEMENTED_ADMIN` (private) under `web-admin-package/`.
   They are not stripped-at-release-time any more — they simply are not here.
2. **`packages/admin-stub/` is the only admin implementation in this repo.**
   Root and `apps/web` `package.json` both resolve
   `"@bicameral/admin": "link:packages/admin-stub"`. Verified: pnpm reports
   `@bicameral/admin <- @bicameral/admin-stub`, and the full gate passes.
3. **The history is not this repo's history.** `DISCOMPLEMENTED_LIVE` was
   created empty and received one commit. The previous private repo is
   `DISCOMPLEMENTED_LIVE_ARCHIVE`.

## Two corrections to the previous version of this document

**`git filter-repo` was not used, and would not have been sufficient.** The old
step 4 stripped `packages/admin/` from history and pushed the result to an
existing repository. A force-push does not delete anything on GitHub —
unreachable commits stay retrievable by SHA — so publishing a repo that
previously contained admin code would have exposed it at a known SHA. A repo
created empty has no such objects. That is why this one was created fresh.

**`export-ignore` was never the protection it looked like.** `.gitattributes`
carried `packages/admin/ export-ignore` and `security.yml` checked for it — but
`export-ignore` affects `git archive` only. It has no effect on a clone, a
fetch, or repository visibility. The check has been replaced with one that
asserts the property that actually matters, and **fails** rather than warning:

```yaml
- name: Verify admin package is not tracked
  run: |
    if git ls-files | grep -q "^packages/admin/"; then
      echo "::error::packages/admin is tracked in the public repo."; exit 1
    fi
```

The old document also listed `packages/ui/` in the structure table. It does not
exist and did not at the time of writing.

## Ongoing sync

`DISCOMPLEMENTED_LIVE` is the hierarchy leader. Changes land here first, and
`DISCOMPLEMENTED_ADMIN` adapts to them. There is no automated sync and no
subtree push — the admin package has no runtime importer in `apps/web/src`
(verified by grep before the move), so the two trees are coupled only through
the stub's export signatures. If a signature changes here, change it there.

## Known defect carried across the split

`web-admin-package/tests/security/auth.test.ts` in the admin repo is entirely
placeholders — every case is `expect(true).toBe(true)` with the real assertion
left as a comment, across all five stated acceptance criteria. It ran as part of
`pnpm test:security` here and reported green while asserting nothing. It is not
counted as coverage. Three of its cases describe
`apps/web/src/lib/admin-middleware.ts`, which stayed in this repo; writing real
tests against that file is tracked as a P1 item.

## What is safe to be public

| Path | Public | Why |
|------|--------|-----|
| `packages/shared/` | yes | types, schemas, constants |
| `packages/cohere/` | yes | fetch wrapper; key comes from env |
| `packages/admin-stub/` | yes | throws; lets contributors build |
| `apps/web/` | yes | keys are Worker secrets, never in the bundle |
| `packages/admin/` | **no** | now in DISCOMPLEMENTED_ADMIN |

`tests/security/client-bundle.test.ts` is what keeps the last row of that table
true at build time; `.github/workflows/security.yml` keeps the last row true at
the repository level.
