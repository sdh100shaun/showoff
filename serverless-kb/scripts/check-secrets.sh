#!/usr/bin/env bash
# Fails if tracked files contain values that should never be committed to a
# public repository: AWS account ids inside ARNs, access keys, private keys,
# or real (non-placeholder) environment config files.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
files=$(git ls-files -- . ':!:package-lock.json' ':!:scripts/check-secrets.sh')

check() {
  local label="$1" pattern="$2"
  local hits
  # Obvious placeholders made of one repeated digit (e.g. 111111111111) are allowed in tests.
  hits=$(echo "$files" | xargs -r grep -nEI -- "$pattern" 2>/dev/null | grep -vE '([0-9])\1{11}' || true)
  if [[ -n "$hits" ]]; then
    echo "✗ $label:"; echo "$hits"; fail=1
  fi
}

check "ARN containing a 12-digit account id" 'arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:'
check "AWS access key id" '(AKIA|ASIA)[A-Z0-9]{16}'
check "Private key material" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "Hard-coded account id assignment" "[\"']?account(Id)?[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[0-9]{12}"

tracked_cfg=$(echo "$files" | grep -E '^config/.*\.json$' | grep -v '^config/config.example.json$' || true)
if [[ -n "$tracked_cfg" ]]; then
  echo "✗ Environment config files must not be tracked:"; echo "$tracked_cfg"; fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "Secret/config check failed."; exit 1
fi
echo "✓ No account ids, keys or environment config found in tracked files."
