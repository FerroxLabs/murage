#!/usr/bin/env bash
# build host only. The Mac uses MAIN's fixed grep procedure, never this script.
set -euo pipefail
umask 077
[[ $# == 7 ]] || { echo 'usage: run.sh IMAGE CORPUS RESULTS SHA CORPUS_DIGEST POLICY_DIGEST PENDING_RECEIPT'; exit 2; }
image=$1 corpus=$2 results=$3 sha=$4 corpus_digest=$5 policy_digest=$6 pending=$7
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Validate allocations, immutable image pin, exact pending-readback binding and
# UID ownership without changing permissions anywhere outside these mounts.
python3 - "$script_dir" "$image" "$corpus" "$results" "$sha" "$corpus_digest" "$policy_digest" "$pending" <<'PY'
import importlib.util,json,os,re,stat,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('verify',Path(sys.argv[1])/'verify-receipt.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
_,_,image,corpus,result,sha,digest,policy,pending=sys.argv
v.image_digest(image);c=v.allocated_path(corpus,'corpus');r=v.allocated_path(result,'result')
v.need(bool(re.fullmatch('[a-f0-9]{40}',sha)) and all(re.fullmatch('[a-f0-9]{64}',x) for x in (digest,policy)),'DIGEST')
p=v.strict(v.read(Path(pending)));v.need(p.get('sourceSha')==sha and p.get('state')=='pending' and p.get('readbackVerified') is True and type(p.get('id')) is int,'PENDING-REVOCATION')
for folder in [c,r]:
 s=folder.lstat();v.need(stat.S_ISDIR(s.st_mode) and s.st_uid==10001 and s.st_gid==10001 and stat.S_IMODE(s.st_mode)==0o700,'UID-DIRECTORY')
v.need(not list(r.iterdir()),'EXISTING-RUN')
for path in c.iterdir():
 s=path.lstat();v.need(stat.S_ISREG(s.st_mode) and s.st_uid==10001 and s.st_gid==10001 and stat.S_IMODE(s.st_mode)==0o600,'UID-FILE')
PY
[[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.murage.nolim.source-sha"}}') == "$sha" ]] || { echo 'BLOCKED: image source mismatch'; exit 2; }
name="nolim-replay-${sha:0:12}-$$"
cleanup(){ docker rm -f "${name:?}" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
# The entrypoint verifies UID readability/writability again inside the namespace.
# No home, Docker socket, database, host network or credential mount is accepted.
timeout --signal=TERM --kill-after=15s 1800s docker run --name "$name" --network none \
 --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
 --pids-limit 256 --memory 6g --cpus 2 \
 --tmpfs /scratch:rw,nosuid,nodev,size=512m,mode=0700,uid=10001,gid=10001 \
 --mount "type=bind,src=$corpus,dst=/corpus,readonly" \
 --mount "type=bind,src=$results,dst=/results" \
 --env "NOLIM_SOURCE_SHA=$sha" --env "NOLIM_CORPUS_DIGEST=$corpus_digest" --env "NOLIM_POLICY_DIGEST=$policy_digest" \
 "$image"
python3 "$script_dir/verify-receipt.py" "$results" --sha "$sha" --corpus "$corpus_digest" --policy "$policy_digest"
