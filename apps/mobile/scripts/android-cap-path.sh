# Sourced by android-remote.sh (and its vitest). Prints the node_modules path
# that `cap sync` wrote into android/capacitor.settings.gradle, relative to
# apps/mobile, or fails. The path ends up in rsync source and destination
# arguments and in remote shell commands, so it must stay inside
# apps/mobile/node_modules and contain nothing a shell would interpret.
#
#   cap_path <apps/mobile dir>
cap_path() {
  local here=$1 cap real root
  cap=$(sed -n "s|.*new File('\.\./\(node_modules/.*\)/capacitor')|\1|p" "$here/android/capacitor.settings.gradle" 2>/dev/null) || true
  if [[ -z $cap || $cap == *$'\n'* ]]; then
    echo "capacitor.settings.gradle has no single node_modules path; run pnpm sync" >&2; return 1
  fi
  if [[ $cap == /* || $cap =~ (^|/)\.\.(/|$) || ! $cap =~ ^[A-Za-z0-9._@+/-]+$ || $cap != node_modules/* ]]; then
    echo "refusing capacitor path '$cap'" >&2; return 1
  fi
  if [[ ! -d "$here/$cap/capacitor" ]]; then
    echo "$cap/capacitor is missing; run pnpm sync" >&2; return 1
  fi
  real=$(realpath "$here/$cap") && root=$(realpath "$here/node_modules") || return 1
  if [[ $real != "$root"/* ]]; then
    echo "capacitor path '$cap' resolves outside node_modules" >&2; return 1
  fi
  printf '%s\n' "$cap"
}
