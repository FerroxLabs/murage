#!/bin/bash
# GitHub-hosted macOS runner ONLY (SIP disabled, passwordless sudo, disposable VM).
# Grants Screen Recording + Accessibility to one packaged Murage.app copy and its embedded
# cua-driver, by code requirement (csreq), the way the runner images grant their own tools.
# Usage: mac-tcc-grant.sh <path to Murage.app>
set -euo pipefail
APP="${1:?usage: mac-tcc-grant.sh <Murage.app>}"
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(id -un)" == "runner" ]] || { echo "refused: GitHub macOS runner only" >&2; exit 2; }
[[ -d "$APP/Contents" ]] || { echo "not an app bundle: $APP" >&2; exit 2; }
csrutil status || true
T=$(mktemp -d)
hexreq() { # designated requirement of a signed bundle or binary, compiled, as hex
  local req; req=$(codesign -d -r- "$1" 2>/dev/null | sed -n 's/^designated => //p')
  [[ -n "$req" ]] || { echo "no designated requirement for $1" >&2; return 1; }
  printf '%s\n' "$req" > "$T/req.txt"; csreq -r "$T/req.txt" -b "$T/req.bin"; xxd -p "$T/req.bin" | tr -d '\n'
}
grant() { # db service client client_type hex
  local q="INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,csreq,flags,last_modified) VALUES('$2','$3',$4,2,4,1,X'$5',0,CAST(strftime('%s','now') AS INTEGER));"
  sudo sqlite3 "$1" "$q"
}
BID=$(defaults read "$APP/Contents/Info.plist" CFBundleIdentifier)
APPREQ=$(hexreq "$APP")
DRV="$APP/Contents/Resources/cua-driver"
USERDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYSDB="/Library/Application Support/com.apple.TCC/TCC.db"
for db in "$SYSDB" "$USERDB"; do
  [[ -f "$db" ]] || continue
  for svc in kTCCServiceScreenCapture kTCCServiceAccessibility; do
    grant "$db" "$svc" "$BID" 0 "$APPREQ"
    if [[ -x "$DRV" ]]; then grant "$db" "$svc" "$DRV" 1 "$(hexreq "$DRV")"; fi
  done
  echo "== $(basename "$(dirname "$(dirname "$db")")") $db"
  sudo sqlite3 "$db" "SELECT service, client, client_type, auth_value FROM access WHERE client='$BID' OR client='$DRV';"
done
echo "bundle id: $BID; driver: $([[ -x "$DRV" ]] && echo present || echo absent)"
sudo pkill -x tccd || true
rm -rf "$T"
