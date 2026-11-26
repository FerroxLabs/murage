# G-NL release host configuration

MAIN must replace the contents of `/root/fuigo-builds/swarm-b/_small/gnl-corpus.env` with exactly:

```sh
GNL_CORPUS_HOST=/root/fuigo-builds/swarm-b/_private/nolim-cards
GNL_CORPUS_SHA256=de299fed2541980e4a8585ebcb20ea02b355a200ccb08fcd64424f3309247913
GNL_CORPUS_SELFHASH=0
GNL_SHARDS=4
GNL_MAX_CONTAINERS=4
```

`GNL_CORPUS_SHA256` is the reviewed `labels-v1.sha256` LABEL seal, not the raw JSONL digest. The approved bundle contains 140 labeled records, the raw export header, display cards/manifest, labels, and the additional Fable review. Keep it on the host; never print, stream, copy, or archive corpus rows.

Run the committed replacement (do not invoke or edit `_small/gnl-hz.sh`):

```sh
set -a
source /root/fuigo-builds/swarm-b/_small/gnl-corpus.env
set +a
scripts/no-limits-live/gnl-hz-release.sh <40-hex-integrated-commit> <new-tag>
```

The runner archives that commit, uses the shared lockfile/cage caches, mounts the complete private bundle read-only at its exact allowlisted path, and runs the existing private replay worker. UID 0 inside each disposable container can read its root-owned private files. No private permission changes are needed. All containers use `--network none`, existing images only, inert native/API protocol fixtures, and at most four concurrent containers. Each shard uses the complete `release-engines.mjs` catalogue with matching `--shard`/`--shards`; its full exit status and verdict are binding. A fresh run directory is required. Source snapshots and containers are removed; logs, count-only replay results and verdicts remain as evidence.

P1 is a separate product fix. Its mandatory assertion must remain failing and the release verdict must remain FAIL until that fix is integrated. No failures are waived or subtracted.
