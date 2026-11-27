#!/usr/bin/env bash
set -euo pipefail

worktree=${IT_W:?IT_W is required}
job=${IT_JOB:?IT_JOB is required}
reviewed=$(sed -nE 's/^ *"digest": "(sha256:[0-9a-f]{64})",?$/\1/p' "$worktree/tools/mailtest/DEPS-REVIEW.json")
selector=${IT_MAILTEST_IMAGE:-${reviewed:?reviewed image digest missing}}
dependencies=${IT_MAILTEST_NODE_MODULES:-$worktree/node_modules}
command=${1:-node node_modules/vitest/vitest.mjs run --configLoader runner --config vitest.mailtest.config.ts}

[[ -d "$dependencies" ]] || { echo 'mailtest: missing test dependencies' >&2; exit 66; }
[[ -d "$worktree/node_modules" ]] || mkdir "$worktree/node_modules"
image=$(docker image inspect --format '{{.Id}}' "$selector")
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'mailtest: invalid image digest' >&2; exit 65; }
awk '{exit !($1 <= 50)}' /proc/loadavg || { echo 'mailtest: host load > 50' >&2; exit 75; }
[[ $(df --output=avail -B1 / | tail -1) -ge 66571993088 ]] || { echo 'mailtest: disk floor 62 GiB' >&2; exit 75; }

exec docker run --init --rm --network none --pull never --name "mailtest-$job-$$" \
  --label "owner=$job" --label purpose=test --cpus 6 --memory 14g \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m --add-host mail.example.test:127.0.0.1 \
  --env "MURAGE_MAILTEST_IMAGE=$image" --env HOME=/tmp --env CI=1 --env NO_COLOR=1 --env FORCE_COLOR=0 \
  --mount "type=bind,src=$worktree,dst=/work,readonly" \
  --mount "type=bind,src=$dependencies,dst=/work/node_modules,readonly" \
  --workdir /work "$image" node server/mailbox/testing/run-mailtest.ts "$command"
