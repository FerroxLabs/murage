#!/bin/bash
# All writes are isolated in a temporary index. Only testing files are overlaid.
set -Eeuo pipefail
umask 077
shopt -s inherit_errexit
trap 'rc=$?; echo "g8-overlay: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
hub=${G8_HUB:-$(git -C "$(dirname -- "$0")" rev-parse --absolute-git-dir)}
product=${1:?product commit}; rig=${2:?rig commit}; job=${3:?job directory}
fake=fd825341c6cc752318f0433203399db4d434a19c
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$job"
tmp=$(mktemp -d "$job/overlay.XXXXXXXX")
trap 'rc=$?; rm -rf -- "${tmp:?}" || rc=4; exit "$rc"' EXIT
export GIT_INDEX_FILE=$tmp/index
g() { git --git-dir="$hub" "$@"; }
product=$(g rev-parse --verify "$product^{commit}")
rig=$(g rev-parse --verify "$rig^{commit}")
g cat-file -e "$fake^{commit}"
g read-tree "$product"
g ls-tree -r "$rig" scripts/smoothness | g update-index --index-info
# Pin all four fake engines and their common request parser, irrespective of
# whether this product has merged the fix. The selected product stays the parent.
files=(server/testing/fake-acp-cli.ts server/testing/fake-claude-cli.ts
  server/testing/fake-codex-app-server.ts server/testing/fake-pi-cli.ts
  server/testing/fixture-request.ts)
g ls-tree -r "$fake" -- "${files[@]}" | g update-index --index-info
g show "$fake:server/testing/fake-acp-cli.ts" > "$tmp/fake-acp-cli.ts"
bash "$here/g8-fake-patch.sh" "$tmp/fake-acp-cli.ts" "$here/g8-fake-acp.patch" >&2
blob=$(g hash-object -w "$tmp/fake-acp-cli.ts")
g update-index --cacheinfo "100755,$blob,server/testing/fake-acp-cli.ts"
tree=$(g write-tree)
commit=$(git -c user.name=ci -c user.email=ci@example.com --git-dir="$hub" commit-tree "$tree" -p "$product" \
  -m "rig: smoothness $rig with fake engines $fake on $product")
g update-ref "refs/rig/smooth-v7/$commit" "$commit"
echo "$commit"
