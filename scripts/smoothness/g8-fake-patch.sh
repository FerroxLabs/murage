#!/bin/bash
# Compatibility with old fake ACP trees; already-patched trees must be a no-op.
set -Eeuo pipefail
trap 'rc=$?; echo "g8-fake-patch: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
file=${1:?fake-acp-cli.ts}; patch_file=${2:?patch file}
test -f "$file"
if grep -qF FAKE_ACP_DELEGATE_TO "$file"; then
  echo 'fake-acp-cli: FAKE_ACP_DELEGATE_TO present; patch skipped' >&2
else
  patch --batch --forward --no-backup-if-mismatch "$file" < "$patch_file"
  grep -qF FAKE_ACP_DELEGATE_TO "$file"
fi
