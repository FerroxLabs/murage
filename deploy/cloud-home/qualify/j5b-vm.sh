#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# J5b r7 deployed-rig fleet wrapper. WRITTEN, NOT RUN: it creates a billable Vultr VM only when J5B_VM_APPLY=1 is set.
#   j5b-vm.sh plan                 print what would be created (fleet-create --print-only) and the current instance list; creates nothing
#   j5b-vm.sh create               list-before-create (stops when a j5b VM already exists), then fleet-create vultr with the fleet tags
#   j5b-vm.sh destroy <instance-id>  DELETE the instance, then read it back until GET answers 404; fails when it never does
# Fleet rules (fleet-registry/TAGS.md): tags owner, purpose, expires_at (YYYY-MM-DD, at most 90 days out; this rig uses 2 days). The API key is read
# from ~/.config/vultr/api.key and never printed or put in argv (curl reads the header from a config on stdin). IPv4 only (curl -4).
set -euo pipefail
FLEET=${FLEET_DIR:?Set FLEET_DIR to the fleet registry checkout}
KEY_FILE=${VULTR_KEY_FILE:-$HOME/.config/vultr/api.key}
API=https://api.vultr.com/v2
OWNER=${J5B_OWNER:-sean}
PURPOSE=${J5B_PURPOSE:-j5b-r8-deployed-tests}
DAYS=${J5B_EXPIRES_DAYS:-2}
NAME=${J5B_VM_NAME:-j5b-r8-rig}
REGION=${J5B_REGION:-ewr}
PLAN=${J5B_PLAN:-vc2-2c-4gb}
OS_ID=${J5B_OS_ID:-2284}          # Ubuntu 24.04 LTS x64 (confirm with GET /v2/os before the first real create)
SSH_KEY=${J5B_SSH_KEY:-463b4511-129c-47dc-b605-38f5dd509dc9}

api() { # METHOD PATH -> prints "HTTP_CODE" then the body on stdout
  [ -r "$KEY_FILE" ] || { echo "no API key file" >&2; return 2; }
  local method=$1 path=$2
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' < "$KEY_FILE")" |
    curl -4 -sS -K - -X "$method" -w '\n%{http_code}' "$API$path"
}
code_of() { tail -n1; }
body_of() { sed '$d'; }

expires() { # YYYY-MM-DD, DAYS from now, never more than 90
  [ "$DAYS" -le 90 ] || { echo "expires_at may be at most 90 days out" >&2; exit 2; }
  date -u -d "+${DAYS} days" +%F 2>/dev/null || date -u -v+"${DAYS}"d +%F
}
list_rig() { # ids of instances whose label is the rig name
  api GET "/instances?per_page=500" | body_of | python3 -I -c 'import json,sys; [print(i["id"]) for i in json.load(sys.stdin).get("instances", []) if i.get("label") == sys.argv[1]]' "$NAME"
}
create_args() { echo vultr --name "$NAME" --type "$PLAN" --image "$OS_ID" --region "$REGION" --ssh-key "$SSH_KEY" --owner "$OWNER" --purpose "$PURPOSE" --expires "$(expires)"; }

case "${1:-}" in
  plan)
    # shellcheck disable=SC2046
    "$FLEET/fleet-create" $(create_args) --print-only
    echo "existing rig instances:"; list_rig || true ;;
  create)
    [ "${J5B_VM_APPLY:-0}" = 1 ] || { echo "dry run: set J5B_VM_APPLY=1 to create (billable). Nothing created." >&2; exit 3; }
    existing=$(list_rig)                                    # list-before-create: never a second rig, never a stray
    [ -z "$existing" ] || { echo "a rig instance already exists: $existing" >&2; exit 4; }
    # shellcheck disable=SC2046
    "$FLEET/fleet-create" $(create_args) ;;
  destroy)
    id=${2:?instance id}
    [[ $id =~ ^[0-9a-f-]{36}$ ]] || { echo "not an instance id" >&2; exit 2; }
    out=$(api DELETE "/instances/$id"); echo "delete: HTTP $(echo "$out" | code_of)"
    for _ in $(seq 1 24); do                                # read back until the instance is gone (404)
      sleep 5
      out=$(api GET "/instances/$id"); code=$(echo "$out" | code_of)
      if [ "$code" = 404 ]; then echo "read-back: GET /instances/$id -> 404, destroyed"; exit 0; fi
    done
    echo "read-back: the instance still answers HTTP $code" >&2; exit 5 ;;
  *) echo "usage: j5b-vm.sh plan | create | destroy <instance-id>" >&2; exit 2 ;;
esac
