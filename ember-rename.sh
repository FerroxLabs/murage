#!/usr/bin/env bash
# Maus -> Ember (bot noun + mascot), and the OpenMaus* identifiers the
# first rebrand pass missed. Re-runnable; tokens are variables.
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"; MODE="${1:-dry}"; cd "$ROOT"

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=build
          --exclude-dir=dist --exclude-dir=target --exclude-dir=third_party
          --exclude-dir=brand --exclude-dir=.next --exclude=package-lock.json
          --exclude=pnpm-lock.yaml --exclude=rebrand.sh --exclude=ember-rename.sh)

TOKENS="$(mktemp)"
grep -rhoE '\b[A-Za-z_][A-Za-z0-9_]*\b' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -iE 'maus' | sort -u \
  | awk 'length($0) < 30' > "$TOKENS"          # drop random secrets/hashes

echo "### mapping:"
SED_ARGS=()
while IFS= read -r t; do
  [ -z "$t" ] && continue
  n="$t"
  # upstream leftovers first (longest match wins)
  n="${n//OpenMausBot/Murage}"; n="${n//openmausbot/murage}"; n="${n//OPENMAUSBOT/MURAGE}"
  n="${n//OpenMaus/Murage}";    n="${n//openmaus/murage}";    n="${n//OPENMAUS/MURAGE}"
  n="${n//openMaus/openMurage}"                      # camelCase product ref
  # plurals BEFORE the singular rule, else Maus+es -> Ember+es
  n="${n//Mauses/Embers}";      n="${n//mauses/embers}";       n="${n//MAUSES/EMBERS}"
  # the bot noun + mascot
  n="${n//SupaMaus/Ember}";     n="${n//supamaus/ember}"
  n="${n//Maus/Ember}";         n="${n//MAUS/EMBER}";         n="${n//maus/ember}"
  [ "$n" = "$t" ] && continue
  printf '  %-42s -> %s\n' "$t" "$n"
  SED_ARGS+=("s/\\b${t}\\b/${n}/g")
done < "$TOKENS"
rm -f "$TOKENS"

echo "### rules: ${#SED_ARGS[@]}"
# collision check
printf '%s\n' "${SED_ARGS[@]}" | sed -E 's|^s/\\b(.*)\\b/(.*)/g$|\2|' | sort | uniq -d \
  | sed 's/^/  COLLISION: /' || true

[ "$MODE" != "apply" ] && { echo "### DRY RUN"; exit 0; }

D="$(mktemp -d)"; R="$D/rules.pl"
for s in "${SED_ARGS[@]}"; do printf '%s;\n' "$s" >> "$R"; done
n=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -Iq . "$f" 2>/dev/null || continue
  perl -pi "$R" "$f" && n=$((n+1))
done <<< "$(grep -rliE 'maus' "${EXCLUDES[@]}" . 2>/dev/null || true)"
rm -rf "$D"
echo "### rewrote $n files"
