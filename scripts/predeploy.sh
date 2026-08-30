#!/usr/bin/env bash
#
# predeploy.sh — the gate that runs before `pnpm deploy` pushes to production.
#
# Every check here exists because something in this repo was once broken in a
# way a deploy would not have caught:
#
#   * `pnpm lint` passed `--ext`, which ESLint 9 flat config rejects with exit
#     2, so lint never actually ran and a real error sat hidden behind it.
#   * `migrations/019_user_roles.sql` indexed a column that does not exist,
#     which aborted any fresh migration run — invisible until the integration
#     suite was actually executed.
#   * Two `[vars]` in wrangler.toml sat under a `[[containers]]` header and
#     were parsed as container fields, so they never reached the Worker at all.
#     Only `wrangler deploy --dry-run` surfaces that.
#   * Named environments do not inherit top-level config in wrangler v4, so a
#     deploy without `--env production` silently drops the custom domains.
#
# Exit codes: 0 = safe to deploy. 1 = a check failed. Warnings never fail the
# gate, but they are printed last so they are the final thing you read.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAILURES=()
WARNINGS=()

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILURES+=("$1"); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARNINGS+=("$1"); }

run() { # run <label> <cmd...>
  local label="$1"; shift
  local log; log="$(mktemp)"
  if "$@" > "$log" 2>&1; then
    ok "$label"
  else
    bad "$label (exit $?)"
    tail -n 25 "$log" | sed 's/^/      /'
  fi
  rm -f "$log"
}

step "1/6  Types"
run "tsc --noEmit (apps/web)" pnpm --filter @bicameral/web exec tsc --noEmit

step "2/6  Lint"
# ESLint exits 1 on errors and 0 on warnings-only, which is the behaviour we
# want: warnings do not block a deploy, errors do.
run "eslint apps/web/src packages/*/src" pnpm lint

step "3/6  Tests"
run "unit"        pnpm test:unit
run "integration" pnpm test:integration
run "security"    pnpm test:security
# No e2e check here on purpose: there is no Playwright config and no specs in
# this repo, and `pnpm test:e2e` fails by design saying so. Do not add it to
# this gate until a real suite exists.

step "4/6  Build"
run "vite build" pnpm build

step "5/6  Worker config (production environment)"
# --dry-run resolves the whole production config — bindings, routes, vars —
# without publishing. It is the only check that catches a var that TOML
# scoping quietly attached to the wrong table.
DRYRUN_LOG="$(mktemp)"
# `--containers-rollout none` is not about rollout policy here — it is what
# stops wrangler from building the sandbox container image, which it otherwise
# does even on a dry run. That build invokes `docker build --load`, a buildx
# flag this machine's Docker (20.10.24, no buildx plugin) does not have, so
# without this the whole config check dies on exit 125 for a reason that has
# nothing to do with the config. Drop the flag on a host with buildx if you
# want the image built as part of the gate.
if (cd apps/web && npx wrangler deploy --env production --dry-run --outdir /tmp/predeploy-dry --containers-rollout none) > "$DRYRUN_LOG" 2>&1; then
  ok "wrangler deploy --env production --dry-run"
  if grep -qi "Unexpected fields found" "$DRYRUN_LOG"; then
    warn "wrangler reported unexpected config fields — a key is under the wrong table header:"
    grep -i -A3 "Unexpected fields found" "$DRYRUN_LOG" | sed 's/^/      /'
  fi
else
  bad "wrangler deploy --env production --dry-run"
  tail -n 30 "$DRYRUN_LOG" | sed 's/^/      /'
fi
rm -f "$DRYRUN_LOG"

step "6/6  Production secrets vs src/env.ts"
# env.ts is the declared contract. Anything non-optional there that is neither
# a provisioned secret nor a wrangler.toml var is a hole; the Worker will read
# `undefined` at runtime.
SECRET_LOG="$(mktemp)"
if (cd apps/web && npx wrangler secret list --env production) > "$SECRET_LOG" 2>&1; then
  SECRET_LOG="$SECRET_LOG" python3 - <<'PY'
import json, os, re, sys

raw = open(os.environ["SECRET_LOG"]).read()
try:
    have = {s["name"] for s in json.loads(raw[raw.index("["):])}
except Exception as e:
    print(f"  \033[31m✗\033[0m could not parse `wrangler secret list` output: {e}")
    sys.exit(1)

src = open("apps/web/src/env.ts").read()
required, optional = set(), set()
for m in re.finditer(r"^\s{2}([A-Z_0-9]+)(\??):\s*string;", src, re.M):
    (optional if m.group(2) else required).add(m.group(1))

declared_vars = set(
    re.findall(r"^([A-Z_0-9]+)\s*=", open("apps/web/wrangler.toml").read(), re.M)
)

missing = sorted(required - have - declared_vars)
unset_optional = sorted(optional - have - declared_vars)

print(f"  \033[32m✓\033[0m {len(have)} secrets provisioned on the production Worker")
if missing:
    print(f"  \033[33m!\033[0m {len(missing)} required-by-env.ts value(s) unset: {', '.join(missing)}")
if unset_optional:
    print(f"  \033[33m!\033[0m optional, unset: {', '.join(unset_optional)}")
PY
else
  warn "could not list production secrets (not authenticated?) — secret coverage unchecked"
  tail -n 10 "$SECRET_LOG" | sed 's/^/      /'
fi
rm -f "$SECRET_LOG"

# Unset secrets are deliberately a WARNING, not a failure. Both currently-unset
# required values degrade rather than crash: lib/scite-research.ts returns an
# empty result set on the 401 an absent key produces, and
# lib/fluxychat.ts:verifyToolWebhookSecret fails closed (returns false) when
# FLUXYCHAT_API_KEY is empty. Deploying without them loses those features; it
# does not break the site.

printf '\n\033[1m═══ predeploy gate ═══\033[0m\n'
if ((${#WARNINGS[@]})); then
  printf '\033[33m%d warning(s):\033[0m\n' "${#WARNINGS[@]}"
  printf '  · %s\n' "${WARNINGS[@]}"
fi
if ((${#FAILURES[@]})); then
  printf '\033[31m%d check(s) FAILED — not safe to deploy:\033[0m\n' "${#FAILURES[@]}"
  printf '  · %s\n' "${FAILURES[@]}"
  exit 1
fi
printf '\033[32mAll checks passed. Safe to run: pnpm deploy\033[0m\n'
