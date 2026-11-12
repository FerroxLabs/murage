# Complete-source release comparison

Customer images use `git archive` and intentionally omit development fixtures
via `export-ignore`. Test inputs must use a complete checkout instead.

From an isolated job checkout:

```sh
mkdir -p .test-tmp/truth
python3 scripts/test-truth/snapshot.py --repo . --revision BASE_SHA --output .test-tmp/truth/base.tar.gz
python3 scripts/test-truth/snapshot.py --repo . --revision HEAD_SHA --base BASE_SHA --output .test-tmp/truth/head.tar.gz
node scripts/prepare-backup-test-fixtures.mjs --tool-directory "$PWD/.test-tmp/truth/age"
node scripts/prepare-historical-test-fixtures.mjs --allow-fetch
node --experimental-strip-types scripts/qualify-memory-runtime.ts --prepare-model --allow-download --destination "$PWD/.planning/memory-evidence/model"
tar -czf .test-tmp/truth/payload.tar.gz dist-native/backup-age/arm64/age dist-native/backup-restic/arm64/restic .v101-ref .v102-ref .vrel-ref .planning/memory-evidence/model
```

Stage build inputs before entering the network-disabled test container. Copy
and hash-verify the unchanged shared leak guard pair into
`.test-tmp/truth/shared`. Copy the worktree's own matching dependencies first.
The backup preparation command stages packaged Darwin age/restic payloads;
also stage the verified host `age` and `age-keygen` in
`.test-tmp/truth/age`. The container command explicitly exports
`MURAGE_BACKUP_TEST_AGE_DIR=/work/.test-tmp/truth/age`, because the shared
container wrapper currently clears that variable.

Build **both** packaged-layout runtime fixtures through the container harness,
before starting any full shard:

```sh
/work/fuigo-builds/tools/it-remote.sh 'node scripts/test-truth/prepare-runtime.mjs base' > "$JOB_EVIDENCE/base-runtime.log"
python3 scripts/test-truth/collect-runtime.py --log "$JOB_EVIDENCE/base-runtime.log" --side base --sha BASE_SHA --destination .test-tmp/truth --scratch "$JOB_EVIDENCE"
/work/fuigo-builds/tools/it-remote.sh 'node scripts/test-truth/prepare-runtime.mjs head' > "$JOB_EVIDENCE/head-runtime.log"
python3 scripts/test-truth/collect-runtime.py --log "$JOB_EVIDENCE/head-runtime.log" --side head --sha HEAD_SHA --destination .test-tmp/truth --scratch "$JOB_EVIDENCE"
```

Set `JOB_EVIDENCE` to a directory outside the synced checkout on the same
filesystem. These builds extract the corresponding exact source archive into a private
temporary directory and return immutable `BEGIN_RUNTIME` streams. They never
write build artifacts into the dispatcher mount. The host collector validates
the expected source SHA and artifact hash before atomic publication.
The `.test-tmp/truth/*-build.finished` receipts record
the source SHA and artifact SHA256. The shard runner verifies both before
using a runtime fixture. Check both receipts against the intended comparison SHAs.
The harness needs the job's `IT_JOB`, `IT_W` and `IT_ORIG` environment.

The 1.0.19 recovery run began before ignored runtime inputs were fully staged.
Its head commands therefore first recheck the fixture readers and the prematurely killed I/O-budget test on the
unchanged base, using the prepared payload, base runtime and declared test deadlines. Stage that
explicit reader inventory before those commands:

```sh
cp scripts/test-truth/fixture-readers-1019.json .test-tmp/truth/fixture-readers.json
```

Keep the original base result archive. Extract the first `BEGIN_RESULTS` block
between `BEGIN_BASE_FIXTURE_RECHECK` and `END_BASE_FIXTURE_RECHECK` separately,
then overlay its authoritative per-file reports on the base results, retaining
both sets of receipts. This is a fixture-only correction: do not apply head
product changes to base. The last `BEGIN_RESULTS` block contains head results.
For a fresh comparison, prepare every input before the initial base run too.

Run `node scripts/test-truth/full-shard.mjs base 0` through the isolated container
harness, for indexes 0 through 7, then repeat for head. At most eight shards
may run at once; the host coordinator must wait while load exceeds 60. Each
shard verifies every source against the manifest, uses its own temporary source
and data folders, and returns a base64 tar between `BEGIN_RESULTS` and
`END_RESULTS`. Extract these into `base/shard-0` through `head/shard-7`, retaining
the container exit status in each directory's `runner-exit`.

```sh
python3 scripts/test-truth/compare.py --base BASE_RESULTS --head HEAD_RESULTS --output COMPARISON
```

The comparison writes every assertion ID and its status, the new-red list,
the red-on-both list, resolved IDs and coverage problems. Exit 2 means missing
or invalid evidence; exit 1 means head has failing IDs, including failures
already present on base. Neither case is a pass. A red file on base cannot
mask a different failing assertion in that same file on head.
Only an actual passed assertion resolves a base failure. Newly skipped/todo
assertions that ran on base fail coverage and are listed in
`new-nonexecution.txt`; removing a failing ID also keeps the comparison red.
An intentional runner migration needs its separate per-ID proof and review.

The root Vitest inventory is determined by Vitest itself. Platform-specific
exclusions retain their reasons in `vite.config.ts`. Node-only gates run via
the blocking `test:electron` runner; they must never be mistaken for empty
Vitest suites.

Root Vitest configuration defaults to `update: "none"`, and the full runner
also sets `CI=1`. Missing snapshots fail. Intentional recording requires a
reviewed, explicit `--update` in a disposable checkout. Comparison rejects
snapshot added/updated/unchecked/removed counts even when a test process exits
zero. It also verifies that the eight shard file lists partition the complete
inventory exactly.

A timed-out process may not flush Vitest's final JSON. Its incremental reporter
still preserves collected and completed assertion IDs. The comparison retains
completed results, fails the running ID with `<TIMEOUT>`, and fails each
collected but unexecuted ID with `<NOT RUN after timeout>`. If neither final
JSON nor incremental IDs exist, coverage is incomplete and comparison exits 2.

Build each revision's own runtime before the full run:

```sh
CI=1 node scripts/test-truth/prepare-runtime.mjs base head
```

This also checks the imported Y3B RC snapshot against the exact base's product
code in a disposable source copy, without updating any snapshot. The full base
archive and its original snapshots remain untouched for the actual comparison.

For the OpenClaw package witness, stage the hash-pinned published 2026.10.5
package regions under `.test-tmp/truth/openclaw/package`. The required tarball
and file SHA-256 values are recorded in
`evidence/test-truth-r2/openclaw-fixture.json`. This uses fake Gateway/model
transports; no model or external service is called. The full runner supplies
that directory so the newly gated package witness executes instead of skipping.
