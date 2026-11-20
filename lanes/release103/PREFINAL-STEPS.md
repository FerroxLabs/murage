# 1.0.3 pre-final: exact steps (re-runnable)

Worktree `/Volumes/Fixture/workspace/103-prefinal`, branch `int/103-prefinal`, remote `dev`.
Commits as `ci <ci@example.test>`, no AI or Co-Authored-By lines. No force-push, no `--no-verify`, no `git stash`.
No builds or tests on the Mac. Scratch files are prefixed `prefinal-`.

## 0. Status (2026-10-22)

- Base `int/103-rc-gate` = a99b36616815e535339217e422cc00121d937311.
- codexhook 54cdd621f (dev/fix/103-codexhook-pkg): already an ancestor of the base.
- fix/103-ci-rcfinal c7e418d9c: already an ancestor of the base.
- Merged clean, local only: fuigo-stop c4ad48978 -> 234c6269b, last3 8dc9d627f -> 3e87239a0,
  late-close 4381cc2f1 -> 7be43741d, msearch-cache 175ab843e -> b9be123af.
- openclaw-floor 4aa435d33 -> 5fd0ae2e7, conflict resolved per the owner call in section 2a.

## 1. Worktree and sha checks

```zsh
cd /Volumes/Fixture/workspace/103-prefinal
rtk proxy git fetch -q dev && rtk proxy git fetch -q pub main
rtk proxy git ls-remote dev refs/heads/int/103-rc-gate          # must print a99b36616...
rtk proxy git merge --ff-only a99b36616                           # first run only (old int/103-prefinal 8474a94ce is an ancestor)
for s in 54cdd621f c7e418d9c; do rtk proxy git merge-base --is-ancestor $s HEAD && echo "$s in" || echo "$s MERGE IT"; done
# each fix: full sha and the dev branch that points at it
for s in c4ad48978 8dc9d627f 4381cc2f1 175ab843e 4aa435d33; do
  f=$(rtk proxy git rev-parse --verify "$s^{commit}"); echo "$f $(rtk proxy git for-each-ref --points-at $f --format='%(refname:short)' refs/remotes/dev)"; done
```

## 2. Merges (in this order; later fixes append to this list)

```zsh
cd /Volumes/Fixture/workspace/103-prefinal
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.test GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.test
m() { rtk proxy git merge-base --is-ancestor $1 HEAD && { echo "$2 already in"; return; }
      rtk proxy git merge --no-ff --no-edit -m "Merge $2 (head ${1:0:9}) into the 1.0.3 pre-final integration" $1 || return 1; }
m c4ad489789ead3dbfc4ad0622ad45015506b5f0f fix/103-fuigo-stop    &&
m 8dc9d627f920d80ad1d7500e4fdfe09ffa3de4cd fix/103-last3         &&
m 4381cc2f1047bf0c94cd06d0d057c70ae7005e68 fix/103-late-close    &&
m 175ab843e6ea952ab4341828e8e2a1da98599dee fix/103-msearch-cache &&
m 4aa435d33e0dce348075d06062d8a4f1c71f4bfc fix/103-openclaw-floor
# later: m <sha> fix/103-agy-auto-selfguard ; m <sha> fix/103-resume-race-a
rtk proxy git diff --name-only --diff-filter=U   # non-empty = conflict: resolve mechanically only, else abort and report
```

### 2a. openclaw-floor vs last3 (resolved 2026-10-22, owner call)

`server/drivers/ask-stop.ts`: last3 adds `ASK_STOP_REASON(S)` and rewrites `ASK_STOP_OPENCLAW_OLD_NOTE` to
"... Choose Auto to let me act, or install OpenClaw 2026.10.10 or newer." openclaw-floor lowers
`OPENCLAW_PERMISSION_MODE_FLOOR` to 2026.8.1. The auto-merged `server/drivers/ask-stop.test.ts` then holds
last3 tests that expect 2026.10.5 to get the old-version note (lines ~301 and ~385) next to floor tests that expect
2026.10.5 to pass (line ~273), and the note still names 2026.10.10. Resolution, done inside the merge commit:
keep last3's ASK_STOP_REASON(S) block; the note reads "... Choose Auto to let me act, or install OpenClaw 2026.8.1 or
newer."; last3's below-floor cases 2026.10.5 / 2026.10.10-beta.2 become 2026.7.35 / 2026.8.1-beta.1; 2026.10.5 and
2026.8.1 join the no-note list. Re-run: `git merge --no-ff --no-commit 4aa435d33`, apply the same edits, then grep
`OpenClaw version cannot stop|install OpenClaw|10.10-beta` outside lanes/ for leftovers, commit.

### 2b. pm-sends expectation

`server/pm-sends-102-r26.test.ts` (the per-driver origin table, now line ~184): antigravity reads `murage: 1`.
Change to `murage: 2` only when the count of Murage-origin sends in `server/drivers/antigravity.ts` on the merged tree
is 2 (the gate-ea7b extra origin). Prove the count with the test's own counter on Hetzner, not by eye.

## 3. Push

```zsh
rtk proxy git push dev HEAD:refs/heads/int/103-prefinal       # plain push, never --force
rtk proxy git ls-remote dev refs/heads/int/103-prefinal       # must equal: rtk proxy git rev-parse HEAD
```

## 4. Hetzner gate (ONE container, /root/mb-prefinal), parallel with step 5

```zsh
H=$(rtk proxy git rev-parse HEAD); B=a99b36616815e535339217e422cc00121d937311
for w in head base; do r=$([ $w = head ] && echo $H || echo $B)
  rtk proxy git archive --format=tar.gz -o /private/tmp/prefinal-$w.tgz $r; done
ssh hetzner-dsm 'df -h / | tail -1; mkdir -p /root/mb-prefinal/{repo-head,repo-base,out}'
scp /private/tmp/prefinal-head.tgz /private/tmp/prefinal-base.tgz hetzner-dsm:/root/mb-prefinal/
ssh hetzner-dsm 'cd /root/mb-prefinal && tar -xzf prefinal-head.tgz -C repo-head && tar -xzf prefinal-base.tgz -C repo-base && chown -R 1000:1000 /root/mb-prefinal'
# /root/mb-prefinal/run.sh <head|base>: corepack pnpm install --frozen-lockfile; tsc -p tsconfig.json --noEmit;
#   tsc -p tsconfig.server.json --noEmit; vitest run (full) --reporter=json -> out/<w>/t.json; failed.txt
ssh hetzner-dsm 'docker run -d --name mb-prefinal --init --user 1000:1000 --cpus 8 --memory 24g -v /root/mb-prefinal:/lane -w /lane node:24-bookworm bash -c "bash /lane/run.sh head; bash /lane/run.sh base"'
ssh hetzner-dsm 'docker wait mb-prefinal'                      # ONE blocking wait (run in background)
# NEW = comm -13 <(sort out/base/failed.txt) <(sort out/head/failed.txt); also diff head failed.txt against the last
# green full run's failed list. Then: docker rm mb-prefinal; rm -rf -- /root/mb-prefinal   (literal path only)
```

## 5. Public try branch on top of 6386816d1

```zsh
V=~/murage-fixture-evidence-20260914/next-upstream-0183/0161/pub/v100
P=$(rtk proxy git rev-parse HEAD); P12=${P:0:12}
T=$($V/scrub.sh $P pub/main)
$V/scan.sh $T pub/main --gitleaks > $V/ci-try-scan-$P12.log 2>&1 || { echo "SCAN NOT CLEAN"; exit 3; }   # gitleaks + vendor prefixes
C=$(GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.test GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.test \
    /usr/bin/git commit-tree "$T" -p 6386816d1d406d945f9aa7ee9c2289756d866a2d -m "CI try $P12 (1.0.3 pre-final)")
BR=ci/try-$P12                                                  # NEW branch; never ci/try-5e344fd0248f
rtk proxy git ls-remote --exit-code pub refs/heads/$BR && { echo "exists: pick a new name"; exit 4; }
rtk proxy git push pub "$C:refs/heads/$BR"
gh workflow run ci.yml -R FerroxLabs/murage --ref $BR -f windows_only=false
gh workflow run package-win.yml -R FerroxLabs/murage --ref $BR
gh workflow run package-linux.yml -R FerroxLabs/murage --ref $BR
gh workflow run package-mac-qualification.yml -R FerroxLabs/murage --ref $BR -f source_sha=$C
# native-addon-msvc.yml only when the diff touches its watched paths:
rtk proxy git diff --name-only 6386816d1 $C | grep -E '^(native/|scripts/build-engine-exclusion|scripts/build-fuigo-probe|scripts/windows-native-imports|electron/windows-native|electron/backup-windows-acl|electron/backup-remote-|shared/windows-sddl|\.github/workflows/native-addon)' \
  && gh workflow run native-addon-msvc.yml -R FerroxLabs/murage --ref $BR
# NEVER nightly.yml. Run ids: gh run list -R FerroxLabs/murage -b $BR --json databaseId,workflowName
# ONE background wait per run: gh run watch <id> -R FerroxLabs/murage --exit-status > prefinal-watch-<id>.log
# Artifacts: gh run download <id> -R FerroxLabs/murage -D prefinal-art-<id>; shasum -a 256 on each package
```
