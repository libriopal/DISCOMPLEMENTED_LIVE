#!/usr/bin/env bash
# Pre-flight secret assertion for CI workflows.
#
# Usage:  scripts/assert-secrets.sh NAME:MINLEN [NAME:MINLEN ...]
#
# Each NAME is read from the *environment*, never from an argument, so a secret
# value never appears in a process list, a shell trace, or a workflow log line.
# The caller binds it with `env:` in the step; this script only tests it.
#
# Why this exists: without it, a missing repo secret surfaces as a confusing
# failure deep in the job — wrangler authenticating as nobody, or an ingest POST
# answering 401 after the simulation already spent its credit budget. Both cost
# minutes (and in simulation.yml, real money) before the real cause shows up.
# Failing in the first ten seconds with the secret's name is strictly cheaper.
#
# What is printed: the secret's NAME and whether it passed. Never the value, and
# never its actual length — only whether it clears the declared minimum. Length
# is a real (if small) leak: it narrows a brute-force space and it fingerprints
# which credential format a key is. The minimum is a shape check, not a
# validity check; a well-formed string can still be revoked or wrong.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::assert-secrets.sh called with no secrets to check"
  exit 1
fi

failed=0

for spec in "$@"; do
  name="${spec%%:*}"
  minlen="${spec##*:}"

  if [ "$name" = "$spec" ] || [ -z "$minlen" ]; then
    echo "::error::assert-secrets.sh: malformed spec '$spec' (expected NAME:MINLEN)"
    failed=1
    continue
  fi
  case "$minlen" in
    '' | *[!0-9]*)
      echo "::error::assert-secrets.sh: non-numeric minimum length in '$spec'"
      failed=1
      continue
      ;;
  esac

  # Indirect expansion, with `set -u` disarmed for exactly this read: an unset
  # secret is the case we are here to report, not a reason to abort the loop
  # before the remaining names are checked. One run should name every missing
  # secret, not just the first.
  set +u
  value="${!name}"
  set -u

  if [ -z "$value" ]; then
    echo "::error::$name is not set — add it to the repository/environment secrets"
    failed=1
  elif [ "${#value}" -lt "$minlen" ]; then
    echo "::error::$name is set but shorter than the expected minimum — it is likely truncated or a placeholder"
    failed=1
  else
    echo "✅ $name present"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "::error::Pre-flight secret check failed. Nothing was deployed or spent."
  exit 1
fi

echo "✅ All required secrets present."
