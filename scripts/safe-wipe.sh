#!/usr/bin/env bash
# safe_wipe — the only recursive delete a shell script in this repository may
# use. Shell twin of server/testing/safe-wipe.mjs (same policy, documented in
# docs/verification/data-safety.md).
#
#   source scripts/safe-wipe.sh
#   safe_wipe /path/to/scratch            # rm -rf after the checks pass
#   SAFE_WIPE_WITHIN=/repo safe_wipe /repo/dist   # admit a build output under a root
#
# Admitted: a path under the OS temp dir ($TMPDIR, /tmp, /private/tmp, /var/tmp,
# /var/folders), a path with a *scratch*, *evidence* or *.e2e* segment, or a
# path strictly inside SAFE_WIPE_WITHIN.
# Refused, whatever the above says: "/", $HOME or any parent of it, $HOME/.murage,
# $HOME/.opengrokbot, $HOME/.murage-companion (and anything inside or containing
# them; the account home from the passwd database is protected the same way even
# when HOME is faked or TMPDIR covers it), a MURAGE_DATA_DIR that is not itself a scratch location, the working
# directory or any parent of it, and any directory that has a live
# .murage-data-owner-*.lease beside it or inside it (up to three levels).
# A refusal prints "safe-wipe REFUSED ..." and returns 2. Nothing is deleted.

_safe_wipe_canon() {
  # realpath of the deepest existing prefix + the rest, without requiring the leaf.
  # A symlink leaf is judged by its target even when the target does not exist.
  local p=$1 suffix="" hops=0 t
  while [ -L "$p" ] && [ $hops -lt 32 ]; do
    t=$(readlink "$p"); case "$t" in /*) p=$t ;; *) p="$(dirname "$p")/$t" ;; esac; hops=$((hops+1))
  done
  while [ ! -e "$p" ] && [ "$p" != "/" ] && [ -n "$p" ]; do
    suffix="/$(basename "$p")$suffix"; p=$(dirname "$p")
  done
  local real out
  real=$(cd "$p" 2>/dev/null && pwd -P) || real=$p
  out="${real%/}$suffix"
  printf '%s\n' "${out:-/}"
}

_safe_wipe_inside() { # $1 child, $2 parent — child strictly inside parent
  case "$1" in "$2"/*) return 0 ;; esac
  return 1
}
_safe_wipe_same_or_inside() { [ "$1" = "$2" ] || _safe_wipe_inside "$1" "$2"; }

_safe_wipe_scratch() {
  local IFS=/ seg
  for seg in $1; do
    case "$seg" in *scratch*|*Scratch*|*SCRATCH*|*evidence*|*Evidence*|*EVIDENCE*|*.e2e*) return 0 ;; esac
  done
  return 1
}

_safe_wipe_under_tmp() {
  local p=$1 t
  for t in "${TMPDIR:-}" /tmp /private/tmp /var/tmp /private/var/tmp /var/folders /private/var/folders; do
    [ -n "$t" ] || continue
    t=$(_safe_wipe_canon "${t%/}")
    [ "$t" != "/" ] && _safe_wipe_same_or_inside "$p" "$t" && return 0
  done
  return 1
}

_safe_wipe_strictly_under_tmp() {
  local p=$1 t
  for t in "${TMPDIR:-}" /tmp /private/tmp /var/tmp /private/var/tmp /var/folders /private/var/folders; do
    [ -n "$t" ] || continue
    t=$(_safe_wipe_canon "${t%/}")
    [ "$t" != "/" ] && _safe_wipe_inside "$p" "$t" && return 0
  done
  return 1
}

# $1 canonical home, $2 canonical account home. The account home is never
# disposable, whatever TMPDIR says (TMPDIR=$HOME or TMPDIR=/Users must not admit
# ~/.murage as "tmpdir"). A different $HOME is disposable only when it sits
# strictly inside the temp dir: the throwaway home a test runner makes with
# mktemp -d, never one that *equals* the temp dir.
_safe_wipe_disposable_home() {
  [ "$1" != "$2" ] || return 1
  _safe_wipe_strictly_under_tmp "$1"
}

_safe_wipe_live_lease() { # $1 lease file -> 0 when it names a live foreign process (or is unreadable)
  local pid
  pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -1)
  [ -n "$pid" ] || return 0
  [ "$pid" = "$$" ] && return 1
  kill -0 "$pid" 2>/dev/null && return 0
  # EPERM (another user's live process) also counts as alive
  if [ -d "/proc/$pid" ]; then return 0; fi
  return 1
}

safe_wipe() {
  local target=$1
  if [ -z "$target" ]; then echo "safe-wipe REFUSED to delete '': empty path" >&2; return 2; fi
  local path home acct cwd d name lease
  path=$(_safe_wipe_canon "$target")
  if [ "$path" = "/" ] || [ -z "$path" ]; then echo "safe-wipe REFUSED to delete $path: filesystem root" >&2; return 2; fi
  cwd=$(pwd -P)
  if _safe_wipe_same_or_inside "$cwd" "$path"; then echo "safe-wipe REFUSED to delete $path: is or contains the working directory $cwd" >&2; return 2; fi
  acct=$(eval echo "~$(id -un)" 2>/dev/null)
  [ -n "$acct" ] && acct=$(_safe_wipe_canon "$acct")
  for home in "${HOME:-}" "$acct"; do
    [ -n "$home" ] || continue
    home=$(_safe_wipe_canon "$home")
    _safe_wipe_disposable_home "$home" "$acct" && continue
    if _safe_wipe_same_or_inside "$home" "$path"; then echo "safe-wipe REFUSED to delete $path: is or contains the home directory $home" >&2; return 2; fi
    for name in .murage .opengrokbot .murage-companion; do
      d="$home/$name"
      if _safe_wipe_same_or_inside "$path" "$d" || _safe_wipe_inside "$d" "$path"; then
        echo "safe-wipe REFUSED to delete $path: is, contains or lies inside the Murage data directory $d" >&2; return 2
      fi
    done
  done
  if [ -n "${MURAGE_DATA_DIR:-}" ]; then
    d=$(_safe_wipe_canon "$MURAGE_DATA_DIR")
    if [ "$d" != "/" ] && ! _safe_wipe_under_tmp "$d" && ! _safe_wipe_scratch "$d"; then
      if _safe_wipe_same_or_inside "$path" "$d" || _safe_wipe_inside "$d" "$path"; then
        echo "safe-wipe REFUSED to delete $path: is, contains or lies inside MURAGE_DATA_DIR=$d, which is not a scratch location" >&2; return 2
      fi
    fi
  fi
  local admitted=""
  if _safe_wipe_under_tmp "$path"; then admitted=tmpdir
  elif _safe_wipe_scratch "$path"; then admitted=scratch-segment
  elif [ -n "${SAFE_WIPE_WITHIN:-}" ]; then
    d=$(_safe_wipe_canon "$SAFE_WIPE_WITHIN")
    if [ "$d" = "/" ]; then echo "safe-wipe REFUSED to delete $path: SAFE_WIPE_WITHIN names a filesystem root" >&2; return 2; fi
    for home in "${HOME:-}" "$acct"; do
      [ -n "$home" ] || continue
      home=$(_safe_wipe_canon "$home")
      if _safe_wipe_same_or_inside "$home" "$d"; then echo "safe-wipe REFUSED to delete $path: SAFE_WIPE_WITHIN $d is or contains a home directory" >&2; return 2; fi
    done
    if _safe_wipe_inside "$path" "$d"; then admitted=within
    else echo "safe-wipe REFUSED to delete $path: is not strictly inside SAFE_WIPE_WITHIN $d" >&2; return 2; fi
  fi
  if [ -z "$admitted" ]; then
    echo "safe-wipe REFUSED to delete $path: not under the OS temp directory, not marked scratch/evidence/.e2e, and no SAFE_WIPE_WITHIN root given" >&2; return 2
  fi
  # live installation leases beside or inside the target
  if [ -d "$path" ] || [ -d "$(dirname "$path")" ]; then
    while IFS= read -r lease; do
      [ -n "$lease" ] || continue
      if _safe_wipe_live_lease "$lease"; then
        echo "safe-wipe REFUSED to delete $path: live installation lease $lease" >&2; return 2
      fi
    done < <({ find "$(dirname "$path")" -maxdepth 1 -name '.murage-data-owner-*.lease' 2>/dev/null; [ -d "$path" ] && find "$path" -maxdepth 4 -name '.murage-data-owner-*.lease' -not -path '*/node_modules/*' 2>/dev/null; } | sort -u)
  fi
  rm -rf -- "$path"
}
