#!/usr/bin/env bash
# Re-runnable OpenMausBot -> Murage rebrand.
# Brand tokens are variables: change them here, re-run, done.
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"
MODE="${1:-dry}"          # dry | apply

# ---- brand tokens -------------------------------------------------
PROD_OLD="OpenMausBot";  PROD_NEW="Murage"
LOWER_OLD="openmausbot"; LOWER_NEW="murage"
UPPER_OLD="OPENMAUSBOT"; UPPER_NEW="MURAGE"
SHORT_OLD="omb";         SHORT_NEW="murage"      # bare identifier
ENV_OLD="OMB_";          ENV_NEW="MURAGE_"       # env prefix
BOX_OLD="OGB_";          BOX_NEW="MURAGEBOX_"    # cloud-box env prefix (distinct from app)
MCPNS_OLD="ogb";         MCPNS_NEW="muragebox"  # mcp__ogb__ namespace

# ---- English words that merely CONTAIN 'omb' — never touch ---------
DENY='^(combination|combinations|combinator|combinators|combobox|combine|combines|Combine|combined|combinedRegex|zombie|zombieConfig|afterZombieConfig|bomb|tomb|tombstone|tombstones|Tombstone|afterTombstone|fromBotId|randomBytes|newUrlFromBase|distanceFromBottom)$'

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=build
          --exclude-dir=dist --exclude-dir=target --exclude-dir=third_party
          --exclude-dir=.next --exclude=package-lock.json --exclude=pnpm-lock.yaml
          --exclude=Cargo.lock --exclude=rebrand.sh)

cd "$ROOT"

# ---- derive the omb/ogb identifier map ----------------------------
TOKENS_FILE="$(mktemp)"
grep -rhoE '\b[A-Za-z_][A-Za-z0-9_]*\b' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -iE 'omb|ogb' | sort -u | grep -vE "$DENY" > "$TOKENS_FILE"

echo "### identifiers to rewrite ($(wc -l < "$TOKENS_FILE" | tr -d ' ')):"
SED_ARGS=()
while IFS= read -r t; do
  [ -z "$t" ] && continue
  n="$t"
  n="${n//OMB_/$ENV_NEW}"
  n="${n//OGB_/$BOX_NEW}"
  n="${n//__omb/__$SHORT_NEW}"
  n="${n//Omb/Murage}"
  n="${n//ogb/$MCPNS_NEW}"
  # bare/prefixed lowercase omb
  if [[ "$n" == omb ]]; then n="$SHORT_NEW"; fi
  n="$(printf '%s' "$n" | sed -E "s/^omb(_|$)/${SHORT_NEW}\1/")"
  [[ "$n" == "$t" ]] && continue
  printf '  %-32s -> %s\n' "$t" "$n"
  SED_ARGS+=("s/\\b${t}\\b/${n}/g")
done < "$TOKENS_FILE"
rm -f "$TOKENS_FILE"

# ---- product-name replacements (order matters) --------------------
SED_ARGS+=(
  "s/${PROD_OLD}/${PROD_NEW}/g"
  "s/${UPPER_OLD}/${UPPER_NEW}/g"
  "s/${LOWER_OLD}/${LOWER_NEW}/g"
)

echo
echo "### total sed rules: ${#SED_ARGS[@]}"

if [[ "$MODE" != "apply" ]]; then
  echo "### DRY RUN — nothing written. Re-run: ./rebrand.sh apply"
  exit 0
fi

# BSD sed has no \b — use perl, which does.
RULESDIR="$(mktemp -d)"; RULES="$RULESDIR/rules.pl"
for s in "${SED_ARGS[@]}"; do printf '%s;\n' "$s" >> "$RULES"; done

FILES=$(grep -rlE "${PROD_OLD}|${LOWER_OLD}|${UPPER_OLD}|omb|ogb|OMB|OGB" \
        "${EXCLUDES[@]}" . 2>/dev/null || true)
n=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -Iq . "$f" 2>/dev/null || continue   # -I: skip binaries; passes JSON/JSONC
  perl -pi "$RULES" "$f" && n=$((n+1))
done <<< "$FILES"
rm -rf "$RULESDIR"
echo "### rewrote $n files"
