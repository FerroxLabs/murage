#!/bin/bash
# Verify a Murage customer home image and sign the verdict. One command, run on the operator's Mac:
#   sign-image.sh [--dry-run] <image-id> <staging|prod>
# It never prints or logs a secret: the build host token is read from a file by name into a private header file, and
# the AWS credentials are read from ~/.config/murage/verifier.env INSIDE A SUBSHELL that execs the aws child, so they
# never reach this shell, the logs or the console helper. (MURAGE_VERIFIER_AWS_PROFILE=<name> uses an AWS profile instead.)
#
# Steps: read the image from the build host API; create a throwaway server from it; boot that server into build host rescue;
# put a fresh SSH host key and a fresh client key on it THROUGH THE AUTHENTICATED WEB CONSOLE (so the first ssh
# connection is pinned to a key that never crossed an untrusted path); run image-release-check.sh over that ssh; build
# the signed statement with the Worker's own module (image-sig.mjs); sign it with AWS KMS; print the imageKinds entry.
# The throwaway server is deleted by exact id in an EXIT trap, whatever happens, and strays are listed.
#
# Files next to this script: image-release-check.sh (hashed into the statement), image-disk-check.sh, image-sig.mjs (the Worker's module,
# copied verbatim), image-sig-cli.mjs, console-type.py.
set -euo pipefail
umask 077

# ---- pins -------------------------------------------------------------------------------------------------------
# sha256 of the verbatim copy of cloudflare/control-plane/scripts/image-sig.mjs (dev fix/cloud-accept-check-staging-pins: e9c331ed7 plus the accepted check sha).
PINNED_SIG_MODULE_SHA256="9e3a07c9dd0210c3dfc08cfee28e332890008f1545a25c26f9e6a7fe73249ec4"
# sha256 of the reviewed image-release-check.sh. The Worker pins the same value (ACCEPTED_CHECK_SHA256).
PINNED_CHECK_SHA256="c2051ebd5a4e7411eb46513c7238a1ebbc44ffe94af1ea0b1b70ae4dfc4ee790"
# sha256 of the reviewed image-disk-check.sh (runs on the rescue server; not part of the signed statement, so the signer pins it).
PINNED_DISK_CHECK_SHA256="44984364b689d6f7392164567c3d3e91fb426631b49a780d91a9d3ee43074748"
CHECK_VERSION="1"
KEY_ALIAS="alias/murage-image-verify"
KMS_REGION="eu-west-1"
AWS_PROFILE_NAME="${MURAGE_VERIFIER_AWS_PROFILE:-}"          # optional override; default is the env file below
VERIFIER_ENV_FILE="${MURAGE_VERIFIER_ENV_FILE:-$HOME/.config/murage/verifier.env}"
SIGNER_CONFIG="${MURAGE_SIGNER_CONFIG:-$HOME/.config/murage-signer/provider.env}"   # provider names live OUTSIDE the repo
LOCATION="${MURAGE_VERIFY_LOCATION:-fsn1}"
NAME_PREFIX="mv-verify-"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DRY=0
if [[ ${1:-} == "--dry-run" ]]; then DRY=1; shift; fi
IMAGE_ID=${1:-}
ENV_NAME=${2:-}
if [[ $# -ne 2 ]]; then echo "usage: sign-image.sh [--dry-run] <image-id> <staging|prod>" >&2; exit 2; fi

step() { echo "STEP $*"; }
die() { echo "sign-image: $*" >&2; exit 1; }
nap() { if (( DRY )); then return 0; fi; sleep "$1"; }

[[ $IMAGE_ID =~ ^[1-9][0-9]{0,15}$ ]] || die "image id must be a decimal number"
[[ $ENV_NAME == staging || $ENV_NAME == prod ]] || die "env must be staging or prod"

# ---- dry run: every outside command must come from the mock directory ------------------------------------------
if (( DRY )); then
    [[ -n ${MURAGE_DRYRUN_BIN:-} && -d $MURAGE_DRYRUN_BIN ]] || die "--dry-run needs MURAGE_DRYRUN_BIN (a directory of mock commands)"
    MURAGE_DRYRUN_BIN=$(cd "$MURAGE_DRYRUN_BIN" && pwd)
    export PATH="$MURAGE_DRYRUN_BIN:$PATH"
    for c in curl aws ssh ssh-keygen console-type; do
        [[ $(command -v "$c" || true) == "$MURAGE_DRYRUN_BIN/$c" ]] || die "dry run: $c is not the mock"
    done
    export MURAGE_DRYRUN=1
    CONSOLE_TYPE=(console-type)
else
    unset MURAGE_DRYRUN_BIN MURAGE_NOW MURAGE_DRYRUN MURAGE_DRYRUN_SPKI_B64
    CONSOLE_TYPE=(python3 -I "$HERE/console-type.py")
fi

# ---- pre-checks -------------------------------------------------------------------------------------------------
step precheck
for c in curl aws ssh ssh-keygen node base64 date; do command -v "$c" >/dev/null 2>&1 || die "$c is not on PATH"; done
if (( ! DRY )); then command -v python3 >/dev/null 2>&1 || die "python3 is not on PATH"; fi
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
CHECK_SCRIPT="$HERE/image-release-check.sh"
[[ -f $CHECK_SCRIPT ]] || die "image-release-check.sh is missing next to this script"
CHECK_SHA=$(sha256_of "$CHECK_SCRIPT")
[[ $CHECK_SHA == "$PINNED_CHECK_SHA256" ]] || die "image-release-check.sh is not the reviewed one (sha256 $CHECK_SHA)"
[[ -f $HERE/image-disk-check.sh ]] || die "image-disk-check.sh is missing next to this script"
[[ $(sha256_of "$HERE/image-disk-check.sh") == "$PINNED_DISK_CHECK_SHA256" ]] || die "image-disk-check.sh is not the reviewed one"
[[ $(sha256_of "$HERE/image-sig.mjs") == "$PINNED_SIG_MODULE_SHA256" ]] || die "image-sig.mjs is not the pinned copy of the Worker module"
CLI=(node "$HERE/image-sig-cli.mjs")

# ---- provider config: strict KEY=VALUE parse, never sourced ----------------------------------------------------------
# Allowlisted keys only; each value must match its regex; the file must be a regular file owned by this user and not
# group- or world-writable. Keys: API_URL, CONSOLE_HOST, TOKEN_FILE_PRODUCTION, TOKEN_FILE_STAGING.
[[ -f $SIGNER_CONFIG && -s $SIGNER_CONFIG ]] || die "provider config not found: $SIGNER_CONFIG (set MURAGE_SIGNER_CONFIG or create it)"
cfg_stat=$(stat -c '%a %u' "$SIGNER_CONFIG" 2>/dev/null || stat -f '%Lp %u' "$SIGNER_CONFIG") || die "cannot stat provider config: $SIGNER_CONFIG"
cfg_mode=${cfg_stat% *}; cfg_uid=${cfg_stat#* }
[[ $cfg_uid == "$(id -u)" ]] || die "provider config is not owned by this user: $SIGNER_CONFIG"
[[ $cfg_mode =~ ^[0-7]{3,4}$ ]] || die "provider config has an unreadable mode: $SIGNER_CONFIG"
(( (8#$cfg_mode & 8#022) == 0 )) || die "provider config must not be group- or world-writable (is $cfg_mode): $SIGNER_CONFIG"
API_URL="" CONSOLE_HOST="" TOKEN_FILE_PRODUCTION="" TOKEN_FILE_STAGING=""
# Space-separated seen keys, not an associative array: macOS ships bash 3.2, which has none.
cfg_seen=" "
re_host='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+'
re_api="^https://${re_host}(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*/?\$"
re_bare="^${re_host}\$"
re_path='^/[A-Za-z0-9._/-]{1,200}$'
while IFS= read -r cfg_line || [[ -n $cfg_line ]]; do
    [[ -z $cfg_line || $cfg_line == \#* ]] && continue
    [[ $cfg_line =~ ^([A-Z_]{1,30})=(.*)$ ]] || die "provider config has a line that is not KEY=VALUE"
    ck=${BASH_REMATCH[1]}; cv=${BASH_REMATCH[2]}
    [[ $cfg_seen != *" $ck "* ]] || die "provider config repeats key $ck"
    cfg_seen+="$ck "
    case $ck in
        API_URL)               [[ $cv =~ $re_api ]] || die "provider config: API_URL must be an https URL"; API_URL=$cv ;;
        CONSOLE_HOST)          [[ $cv =~ $re_bare ]] || die "provider config: CONSOLE_HOST must be a bare hostname"; CONSOLE_HOST=$cv ;;
        TOKEN_FILE_PRODUCTION) [[ $cv =~ $re_path && $cv != *..* ]] || die "provider config: TOKEN_FILE_PRODUCTION must be an absolute path"; TOKEN_FILE_PRODUCTION=$cv ;;
        TOKEN_FILE_STAGING)    [[ $cv =~ $re_path && $cv != *..* ]] || die "provider config: TOKEN_FILE_STAGING must be an absolute path"; TOKEN_FILE_STAGING=$cv ;;
        *) die "provider config has an unknown key: $ck" ;;
    esac
done < "$SIGNER_CONFIG"
for ck in API_URL CONSOLE_HOST TOKEN_FILE_PRODUCTION TOKEN_FILE_STAGING; do
    [[ $cfg_seen == *" $ck "* ]] || die "provider config is missing key $ck"
done
HZ_API=${API_URL%/}

if [[ -n ${MURAGE_HZ_TOKEN_FILE:-} ]]; then
    TOKEN_FILE=$MURAGE_HZ_TOKEN_FILE
elif [[ $ENV_NAME == prod ]]; then
    TOKEN_FILE=$TOKEN_FILE_PRODUCTION
else
    TOKEN_FILE=$TOKEN_FILE_STAGING
fi
[[ -f $TOKEN_FILE && -s $TOKEN_FILE ]] || die "provider token file not found: $TOKEN_FILE"
mode=$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE")
[[ $mode == 600 || $mode == 400 ]] || die "token file must be mode 600 or 400 (is $mode): $TOKEN_FILE"
if [[ -n $AWS_PROFILE_NAME ]]; then
    aws configure list-profiles | grep -Fx -- "$AWS_PROFILE_NAME" >/dev/null || die "AWS profile $AWS_PROFILE_NAME is not configured"
else
    # Only the file's existence and mode are checked here; its contents are never read by this shell.
    [[ -f $VERIFIER_ENV_FILE && -s $VERIFIER_ENV_FILE ]] || die "verifier credentials file not found: $VERIFIER_ENV_FILE"
    vmode=$(stat -c '%a' "$VERIFIER_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$VERIFIER_ENV_FILE")
    [[ $vmode == 600 ]] || die "verifier credentials file must be mode 600 (is $vmode): run chmod 600 $VERIFIER_ENV_FILE"
fi

# ---- private workspace and cleanup trap ------------------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sign-image.XXXXXX")
chmod 700 "$WORK"
EVIDENCE_ROOT="${MURAGE_SIGN_EVIDENCE:-$HOME/murage-sign-evidence}"
EVIDENCE="$EVIDENCE_ROOT/$IMAGE_ID"
RUN_ID=""
SERVER_ID=""
POST_SENT=0
SEQ=0
AUTH_FILE="$WORK/auth.hdr"

# hz METHOD PATH [JSON-BODY]: the response body lands in $HZ_OUT; returns 0 for a 2xx answer, 1 for anything else.
hz() {
    local method=$1 path=$2 body=${3:-} code
    HZ_CODE=""
    SEQ=$((SEQ + 1))
    HZ_OUT="$WORK/resp.$SEQ"
    local args=(-4 -sS --max-time 60 -X "$method" -H "@$AUTH_FILE" -H "Content-Type: application/json" -o "$HZ_OUT" -w '%{http_code}')
    if [[ -n $body ]]; then args+=(--data-binary "$body"); fi
    code=$(curl "${args[@]}" "$HZ_API$path") || return 1
    HZ_CODE=$code
    [[ $code =~ ^2[0-9][0-9]$ ]]
}
jget() { "${CLI[@]}" jget "$1" < "$HZ_OUT"; }

delete_server() { # delete_server ID: exact id, guarded by name prefix and both labels
    local id=$1 name run purpose n=0
    hz GET "/servers/$id" || { if [[ ${HZ_CODE:-} == 404 ]]; then return 0; fi; echo "sign-image: cannot read server $id before delete" >&2; return 1; }
    name=$(jget server.name) || return 1
    purpose=$("${CLI[@]}" jget 'server.labels.purpose' < "$HZ_OUT" 2>/dev/null || true)
    run=$("${CLI[@]}" jget 'server.labels.murage/verify-run' < "$HZ_OUT" 2>/dev/null || true)
    if [[ ! $name =~ ^mv-verify-[0-9]{1,12}$ || $purpose != image-verify || -z $RUN_ID || $run != "$RUN_ID" ]]; then
        echo "sign-image: NAME GUARD refused to delete server $id ($name)" >&2
        return 1
    fi
    step "delete-server $id"
    hz DELETE "/servers/$id" || { echo "sign-image: DELETE of server $id failed" >&2; return 1; }
    while (( n < 24 )); do
        if ! hz GET "/servers/$id"; then if [[ ${HZ_CODE:-} == 404 ]]; then return 0; fi; fi
        n=$((n + 1)); nap 5
    done
    echo "sign-image: server $id is STILL PRESENT after delete; remove it by id" >&2
    return 1
}

reap_by_label() { # a create whose answer was lost: find it by the run label and delete it by exact id
    local tries=0 id name run found=0
    while (( tries < 20 )); do
        if hz GET "/servers?label_selector=murage%2Fverify-run%3D$RUN_ID"; then
            while IFS=$'\t' read -r id name run; do
                [[ -n $id ]] || continue
                if [[ $run == "$RUN_ID" ]]; then found=1; delete_server "$id" || CLEAN_FAILED=1; fi
            done < <("${CLI[@]}" list-servers < "$HZ_OUT")
            (( found )) && return 0
        fi
        tries=$((tries + 1)); nap 15
    done
    echo "sign-image: possible orphan from run $RUN_ID, list servers with label purpose=image-verify" >&2
    CLEAN_FAILED=1
}

list_strays() {
    local id name run any=0
    if hz GET "/servers?label_selector=purpose%3Dimage-verify"; then
        while IFS=$'\t' read -r id name run; do
            [[ -n $id ]] || continue
            any=1
            echo "STRAY verify server id=$id name=$name run=$run" >&2
            if [[ -n $RUN_ID && $run == "$RUN_ID" ]]; then CLEAN_FAILED=1; fi
        done < <("${CLI[@]}" list-servers < "$HZ_OUT")
        if (( ! any )); then echo "no stray verify servers"; fi
    else
        echo "sign-image: could not list stray servers" >&2
        CLEAN_FAILED=1
    fi
}

CLEAN_FAILED=0
cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    set +e
    step cleanup
    if [[ -n $SERVER_ID ]]; then
        delete_server "$SERVER_ID" || CLEAN_FAILED=1
    elif (( POST_SENT )) && [[ -n $RUN_ID ]]; then
        reap_by_label
    fi
    if [[ -n ${AUTH_FILE:-} && -f $AUTH_FILE ]]; then list_strays; fi
    rm -rf "$WORK"
    if (( rc == 0 && CLEAN_FAILED )); then rc=3; fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
{ printf 'Authorization: Bearer '; tr -d '\r\n' < "$TOKEN_FILE"; printf '\n'; } > "$AUTH_FILE"
chmod 600 "$AUTH_FILE"

wait_action() { # wait_action ID
    local id=$1 n=0 st
    while (( n < 120 )); do
        hz GET "/actions/$id" || die "cannot read action $id"
        st=$(jget action.status)
        case $st in
            success) return 0 ;;
            error) die "build host action $id failed" ;;
        esac
        n=$((n + 1)); nap 3
    done
    die "build host action $id did not finish"
}

# ---- 1. the image, first read ----------------------------------------------------------------------------------
step "image-read-1 $IMAGE_ID"
hz GET "/images/$IMAGE_ID" || die "cannot read image $IMAGE_ID (HTTP ${HZ_CODE:-?})"
FIRST=$("${CLI[@]}" check-image "$IMAGE_ID" "$ENV_NAME" < "$HZ_OUT") || die "image $IMAGE_ID is not eligible for $ENV_NAME"
IFS=$'\t' read -r _ CREATED_AT IMAGE_SIZE _ _ ARCH DISK <<< "$FIRST"
step "image-eligible arch=$ARCH size=$IMAGE_SIZE"

# ---- 2. keys, server type ---------------------------------------------------------------------------------------
step keys
ssh-keygen -q -t ed25519 -N '' -C '' -f "$WORK/host" >/dev/null
ssh-keygen -q -t ed25519 -N '' -C '' -f "$WORK/client" >/dev/null
RUN_ID=$("${CLI[@]}" uuid)
step "pick-type"
hz GET "/server_types?per_page=50" || die "cannot list server types"
TYPE=$("${CLI[@]}" pick-type "$ARCH" "$DISK" "$LOCATION" < "$HZ_OUT") || die "no server type fits the image"
[[ $TYPE =~ ^[a-z0-9]{2,12}$ ]] || die "unexpected server type name"

# ---- 3. the check server ----------------------------------------------------------------------------------------
SUFFIX=$IMAGE_ID
if (( ${#SUFFIX} > 12 )); then SUFFIX=${SUFFIX: -12}; fi
NAME="$NAME_PREFIX$SUFFIX"
step "create-server type=$TYPE"
BODY=$(printf '{"name":"%s","server_type":"%s","location":"%s","image":%s,"labels":{"purpose":"image-verify","murage/verify-run":"%s","murage/verify-image":"%s"},"start_after_create":false,"public_net":{"enable_ipv4":true,"enable_ipv6":false}}' \
    "$NAME" "$TYPE" "$LOCATION" "$IMAGE_ID" "$RUN_ID" "$IMAGE_ID")
POST_SENT=1
hz POST /servers "$BODY" || die "server create failed (HTTP ${HZ_CODE:-?})"
SERVER_ID=$(jget server.id)
[[ $SERVER_ID =~ ^[1-9][0-9]{0,15}$ ]] || die "unexpected server id"
wait_action "$(jget action.id)"

step rescue
hz POST "/servers/$SERVER_ID/actions/enable_rescue" '{"type":"linux64"}' || die "enable_rescue failed"
printf '%s' "$(jget root_password)" > "$WORK/root.pw"
wait_action "$(jget action.id)"
step poweron
hz POST "/servers/$SERVER_ID/actions/poweron" || die "poweron failed"
wait_action "$(jget action.id)"
n=0
while :; do
    hz GET "/servers/$SERVER_ID" || die "cannot read server"
    [[ $(jget server.status) == running ]] && break
    n=$((n + 1)); (( n < 100 )) || die "server did not reach running"
    nap 5
done
IP=$(jget server.public_net.ipv4.ip)
[[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "unexpected server address"

# ---- 4. install our own keys through the authenticated console --------------------------------------------------
step console
hz POST "/servers/$SERVER_ID/actions/request_console" || die "request_console failed"
printf '%s' "$(jget wss_url)" > "$WORK/console.url"
printf '%s' "$(jget password)" > "$WORK/console.pw"
b64() { base64 < "$1" | tr -d '\n'; }
CMD="umask 077; mkdir -p /root/.ssh /etc/ssh; rm -f /etc/ssh/ssh_host_*; echo $(b64 "$WORK/client.pub") | base64 -d > /root/.ssh/authorized_keys; echo $(b64 "$WORK/host") | base64 -d > /etc/ssh/ssh_host_ed25519_key; echo $(b64 "$WORK/host.pub") | base64 -d > /etc/ssh/ssh_host_ed25519_key.pub; chmod 600 /etc/ssh/ssh_host_ed25519_key; printf 'HostKey /etc/ssh/ssh_host_ed25519_key\\nPasswordAuthentication no\\nPermitRootLogin prohibit-password\\nPubkeyAuthentication yes\\n' > /etc/ssh/sshd_config; (systemctl restart ssh || systemctl restart sshd || service ssh restart) >/dev/null 2>&1"
printf '%s' "$CMD" > "$WORK/console.cmd"
BOOT_WAIT=45
if (( DRY )); then BOOT_WAIT=0; fi
"${CONSOLE_TYPE[@]}" --url-file "$WORK/console.url" --vnc-pass-file "$WORK/console.pw" --root-pass-file "$WORK/root.pw" --command-file "$WORK/console.cmd" --boot-wait "$BOOT_WAIT" --console-host "$CONSOLE_HOST" \
    || die "console step failed"
rm -f "$WORK/console.pw" "$WORK/root.pw" "$WORK/console.url" "$WORK/console.cmd"

# ---- 5. ssh pinned to OUR host key, then the check -------------------------------------------------------------
step ssh-wait
printf '%s %s\n' "$IP" "$(cut -d' ' -f1,2 "$WORK/host.pub")" > "$WORK/known_hosts"
SSH=(ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORK/known_hosts" -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no -o ConnectTimeout=10 -i "$WORK/client" "root@$IP")
n=0
until "${SSH[@]}" true >/dev/null 2>&1; do
    n=$((n + 1)); (( n < 40 )) || die "ssh to the pinned host key never worked"
    nap 15
done
step mount
# image-disk-check.sh runs on the rescue server: it refuses an unclean or journal-dirty ext4, any unexpected partition or
# second root, and a bootloader config that boots something other than the checked root; it mounts what it inspected read-only.
DISKOUT="$WORK/disk-check.out"
DRC=0
"${SSH[@]}" "bash -s -- mount-image $ENV_NAME" < "$HERE/image-disk-check.sh" > "$DISKOUT" 2>&1 || DRC=$?
cat "$DISKOUT"
case $(tail -n 1 "$DISKOUT") in
    "image-disk-check: ok "*) ;;
    *) die "the image disk is not the expected layout (exit $DRC); nothing signed" ;;
esac
(( DRC == 0 )) || die "disk check exit $DRC; nothing signed"
step "check"
mkdir -p "$EVIDENCE"
LOG="$EVIDENCE/verify-$IMAGE_ID.log"
RC=0
"${SSH[@]}" "bash -s -- /mnt/img $IMAGE_ID $ENV_NAME" < "$CHECK_SCRIPT" > "$LOG" 2>&1 || RC=$?
cat "$LOG"
LAST=$(tail -n 1 "$LOG")
case $LAST in
    "image-release-check: ok image=$IMAGE_ID env=$ENV_NAME "*) ;;
    *) die "release check did not pass (exit $RC); nothing signed" ;;
esac
(( RC == 0 )) || die "release check exit $RC; nothing signed"

# ---- 6. the image, second read must be identical ----------------------------------------------------------------
step "image-read-2 $IMAGE_ID"
hz GET "/images/$IMAGE_ID" || die "cannot re-read image $IMAGE_ID"
SECOND=$("${CLI[@]}" check-image "$IMAGE_ID" "$ENV_NAME" < "$HZ_OUT") || die "image $IMAGE_ID is no longer eligible"
[[ $SECOND == "$FIRST" ]] || die "image changed while it was being checked; nothing signed"

# ---- 7. statement, signature, entry -----------------------------------------------------------------------------
step payload
VERIFIED_AT=$(date -u +%Y%m%dT%H%M%SZ)
if (( DRY )) && [[ -n ${MURAGE_NOW:-} ]]; then VERIFIED_AT=$MURAGE_NOW; fi
PAYLOAD="$WORK/payload.bin"
"${CLI[@]}" payload "$IMAGE_ID" "$CREATED_AT" "$IMAGE_SIZE" "$ENV_NAME" "$CHECK_SHA" "$VERIFIED_AT" > "$PAYLOAD" || die "payload refused"
step sign
KMS_JSON="$WORK/kms-sign.json"
AWS_EXTRA=()
if (( DRY )); then for v in $(compgen -v | grep '^MOCK_' || true); do AWS_EXTRA+=("$v=${!v}"); done; fi
if [[ -n $AWS_PROFILE_NAME ]]; then
    env -i HOME="$HOME" PATH="$PATH" AWS_PAGER="" ${AWS_EXTRA[@]+"${AWS_EXTRA[@]}"} aws --profile "$AWS_PROFILE_NAME" --region "$KMS_REGION" kms sign \
        --key-id "$KEY_ALIAS" --message "fileb://$PAYLOAD" --message-type RAW --signing-algorithm ECDSA_SHA_256 --output json > "$KMS_JSON" \
        || die "aws kms sign failed"
else
    # The credentials exist only inside this subshell and the aws process it execs. Parent AWS_* variables are dropped first;
    # sourcing errors are silenced so a bad line is never echoed.
    (
        for v in $(compgen -v | grep '^AWS_' || true); do unset "$v"; done
        set -a
        { . "$VERIFIER_ENV_FILE"; } 2>/dev/null || { echo "sign-image: could not load the verifier credentials file" >&2; exit 1; }
        set +a
        export AWS_PAGER=""
        for v in ${AWS_EXTRA[@]+"${AWS_EXTRA[@]}"}; do export "$v"; done
        exec aws --region "$KMS_REGION" kms sign \
            --key-id "$KEY_ALIAS" --message "fileb://$PAYLOAD" --message-type RAW --signing-algorithm ECDSA_SHA_256 --output json
    ) > "$KMS_JSON" || die "aws kms sign failed"
fi
step entry
ENTRY=$("${CLI[@]}" entry "$PAYLOAD" "$KMS_JSON" "$CHECK_VERSION") || die "could not build the entry"

mkdir -p "$EVIDENCE"
cp "$PAYLOAD" "$EVIDENCE/payload-$IMAGE_ID.bin"
cp "$KMS_JSON" "$EVIDENCE/kms-sign-$IMAGE_ID.json"
printf '%s\n' "$ENTRY" > "$EVIDENCE/imagekind-$IMAGE_ID.json"
chmod 644 "$EVIDENCE/imagekind-$IMAGE_ID.json"
printf '"%s": %s\n' "$IMAGE_ID" "$ENTRY"
echo "signed image $IMAGE_ID -> $EVIDENCE/imagekind-$IMAGE_ID.json"
