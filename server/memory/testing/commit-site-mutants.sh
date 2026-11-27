#!/bin/bash
# MEMORY V2 lane W, W-COMMIT mutants (run in a disposable copy of the tree): commit-site-mutants.sh <list> <outdir>
# <list>: lines "<group><TAB><site id>"; for each, the site's mutant is written (commit-site-mutant.ts), only that site's test of
# server/memory/wake-sites-<group>.test.ts runs, and the file is restored. One log per site in <outdir>.
L=${1:?list}; O=${2:?outdir}; mkdir -p "$O"
while IFS=$'\t' read -r g id; do
  [ -n "$id" ] || continue
  n=$(printf '%s' "$id" | tr -c 'A-Za-z0-9#' '_'); f=${id%% *}
  cp "server/$f" "$O/.orig"
  node --experimental-strip-types --no-warnings server/memory/testing/commit-site-mutant.ts "$id" > "$O/$n.log" 2>&1
  pat=$(printf '%s' "$id" | sed 's/[][\\.*^$()+?{}|/]/\\&/g')
  timeout 300 npx vitest run "server/memory/wake-sites-$g.test.ts" -t "$pat\$" >> "$O/$n.log" 2>&1; echo "EXIT $?" >> "$O/$n.log"
  cp "$O/.orig" "server/$f"
done < "$L"
rm -f "$O/.orig"
