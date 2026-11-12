# Search recovery qualification (1.0.19 amendment, item 4)

This lane supplies harnesses, not release qualification results. Product code
stays on the independently built recovery lane. All files live under
`scripts/qualify-search/` and this documentation directory. The dedicated
Vitest config selects `.qual.test.ts` files tagged `qual`; the repository's
default config selects none of them. Run SQLite/data tests through Vitest,
never an ad hoc Node process pointed at a data directory.

The binding documents are `DESIGN-FTS-R3-AMEND.md` section 4 and
`MAIN-RULINGS-AMEND.md` in the originating design lane. R-1 reserves macOS
execution for a squashed `ci/try` snapshot after a matching green hz gate.
R-2 omits Windows disk-full because a VHD exceeds the Windows runner rule.
R-3 reserves private-copy execution for MAIN's RC copy gate. No Mac, Windows
runner, real data copy, hosted workflow, or paid service is contacted by smoke.

## Container entry points

From the worktree on the qualification host:

```sh
bash scripts/qualify-search/run.sh typecheck
bash scripts/qualify-search/run.sh smoke
bash scripts/qualify-search/baseline.sh legacy
bash scripts/qualify-search/run.sh q1
bash scripts/qualify-search/run.sh q2-diskfull
```

The shell entry points set `IT_JOB=qual-fts-amend`, the requested
`IT_qual-fts-amend` environment entry, `IT_W`, and
`IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and launch through
`/work/fuigo-builds/tools/it-remote.sh`. Two job-local advisory locks cap this
lane at two containers. Each launch waits while host load exceeds 60.
UID 2001, network none, six CPUs, 16 GiB RAM and a fresh `/data` tmpfs are
specified for every qualification container. Extra mounts select it-remote's
local generic fallback, which supports the required tmpfs flags. The shared
lockfile-specific dependencies are read-only; the checkout gets disposable
symlinks and caches. Never run the rig alongside the two Q1 legs.

Evidence goes to `$MURAGE_QUAL_JOB_DIR/evidence/r4`, defaulting to the parent
of the worktree. It is mounted at `/qual-evidence`; the data and temporary
home disappear with the container. The shell commands leave numeric reports
and logs, not the data fixture. Set a different job directory to keep separate
runs. Remove the checkout's created `node_modules` and TypeScript build
outputs after finishing; do not remove shared dependencies.

`run.sh smoke` uses 120 messages for Q1, 32 for disk-full, 64 for Q3 and
synthetic shard records for the rig. Q1 compresses the 50 minute schedule to
12 seconds, uses two-write bursts, a 60 ms pin and a scaled two-second halt.
Disk-full still exhausts a real 192 MiB tmpfs and attempts 200 owner writes.
Every negative run forces a named **report bar**, leaves Vitest failing at
`ORACLE:<leg>`, and is checked against both Vitest JSON and the raw report:

| Harness | Deliberately failed bar |
|---|---|
| Q1 | `main-fts` |
| Q2 disk-full | `integrity` |
| Q3 copy | `parity` |
| Rig | `new-fails` (also supplies an actual synthetic regression line) |

An import failure, missing report, timeout, or teardown error does not satisfy
a negative. A smoke report says `qualification:false`; smoke cannot satisfy a
release bar. The starting product can fail Q2's `atomic-owner` bar because a
second ROLLBACK masks SQLITE_FULL. The smoke driver accepts only that exact
known behavioural result as an executed smoke, prints it as OPEN, and keeps
the failed bar. Short Q1/Q3 timing misses on the shared host likewise remain OPEN
in their raw report. The driver verifies execution and negative controls; its
success does not change any measured qualification bar to green.

## Q1 and Linux Q2

`baseline.sh legacy` makes a disposable **b4dc27ea9 git archive**, overlays
only this harness directory, records the base SHA/archive hash, and invokes
its real legacy backfill through Vitest. `dbstat` measures all legacy FTS
shadow pages on the fixed-seed 103k fixture. No tip production file is overlaid.
`MURAGE_QUAL_SMOKE=1 bash scripts/qualify-search/baseline.sh legacy` checks that
entry point with 120 rows; regenerate without that flag before a full run.

`run.sh q1` launches exactly two containers concurrently: `q1-103k` (103,000
messages) and `q1-1m` (1,040,000). The fixed seed is 0x1019; 400 threads include
two 2,000-row drop targets. Text is approximately 50% 80 bytes, p99 4 KiB and
0.1% 64 KiB. The real index worker builds search.db with automerge disabled.
A fixture-only command on that same worker creates further real generations
with ordinary FTS DELETE/INSERT transactions, automerge 0, deletemerge 0 and
crisismerge 16 until levels 3, 4 and 5 each contain exactly 15 segments or the
30 minute total fixture budget expires. No FTS shadow metadata is edited.
The structure decoder validates the legacy and contentless-delete V2 formats,
including segment totals and complete buffer consumption. A topology miss
is a failed `segment-levels` bar with actual levels/generation count, never a
smaller index accepted as the crisis fixture. Automerge/deletemerge are
restored before measurement.

The workload writes twice per second throughout 50 minutes, bursts 50 each
minute during the initial 30 minutes, drops at 10 and 20 minutes, pins a search
reader at 12 minutes for 60 seconds, halts worker scheduling at minutes 30–40,
and continues writes during ten minutes of recovery. A pinned-window drop
intent ensures scrub actually has debt to clear. A forced reset at the end
measures full rebuild throughput. Fixture-only direct SQL runs before the
workload; measured sends and thread deletion use production owner functions.

`q1-103k` supplies Q2-linux. `q2-103k` uses the same code for the other OSes.
The report files are `q1-103k.json`, `q1-1m.json`, per-leg `*-bound.json`, and
`q1-combined.json`. A Q1 run exits nonzero if either leg or the cross-leg
comparison fails. The comparison requires full qualification reports and
exact equality of all 100 owner statement/frame samples, with no history
scan. A size-normalized ratio compares both legs to the same-run base's
103k legacy shadow bytes per searchable text byte.

| Bar | Required result |
|---|---|
| T-BOUND | Exact statement/frame equality across legs; no history SCAN in executed EQP |
| Main FTS | Zero owner/main SQL naming `messages_fts` during workload |
| Owner commit, including drops/pin/halt | p99 <20 ms; max <100 ms |
| Event loop | 10 ms histogram resolution; p99 <20 ms; zero observed ≥250 ms stalls |
| Apply/drop/rebuild/scrub steps | Every step ≤500 ms |
| Merge residual | Reported separately; every merge slice ≤30 s |
| Backlog outside halt/drain | ≤2,000 references and ≤240,000 reference bytes |
| Halt | Backlog growth attributable only to writes; drain ≤10 min; owner drain p99 <20 ms |
| Drop cleanup | Both debts clear within five minutes, excluding the pin overlap |
| Pinned scrub | ≤11 actual TRUNCATE attempts |
| Forced rebuild | ≤30 minutes; rows/sec reported |
| Legacy retirement | Main-thread portion ≤20 ms; fixture build and total wall reported |
| Growth | Checkpointed search.db bytes per live searchable byte ≤1.25× base legacy shadow ratio |

The final file size is read after stopping the worker and closing its reader,
so committed WAL pages are included in search.db without double counting.

The test-only worker observer appends timing wrappers to the actual eval
worker; it changes no scheduling or recovery decisions. It supplies missing
`step-ms`/`merge-ms` fields and counts actual TRUNCATE calls. Production timing
fields take precedence. Fixture generation is a separate explicit worker
command, never invoked during owner workload. SQLite's structure and merge
semantics are documented in [SQLite FTS5](https://www.sqlite.org/fts5.html)
and its [structure decoder](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_index.c).

## Disk-full

Q2 allocates a ballast file until free tmpfs space is at most 1 MiB, attempts
200 real owner writes, drops a thread and forces reset. It checks each success
against the stored text and each rejected write for an absent row; caller
errors must be SQLITE_FULL. The report distinguishes masked errors, committed
and rejected writes. It checks ≤8 reset cycles, RECOVERING followed by PARKED
or DEFERRED on the amended tip, both integrity checks, complete message row count/content hashes matching
the pre-exhaustion expected ledger at exhaustion and after making space, and every
committed send in the recovered FTS index. Space recovery has one 60 second
budget including a stop/start if PARKED (the required exit from that state).
The smoke may reopen because the starting tip has no recovery-state hook;
a full run requires the actual state evidence.

## OS job definitions (not dispatched)

`macos-ci-try.yml` is an installable workflow definition kept outside
`.github/workflows`. MAIN may copy it into a **root-commit ci/try snapshot**
only after hz is green. It verifies the branch, snapshot SHA, root history,
and matching `hz-gate.json` from a named green run, then runs the same 103k leg
and the full reset set. Tests run under a macOS network-denial sandbox with
fake fixture configuration. A 192 MiB HFS+ sparse image supplies the disk-full
volume; the detach trap runs on failure as well. It never invokes Sean's Mac.

The attestation artifact `search-hz-green` must contain `hz-gate.json` with
`{"sha":"<snapshot>","gates_rc":0}` and the non-smoke `q1-legacy.json`.
No workflow here uploads, pushes, or dispatches that artifact.

`windows-copy-job.ps1` defines the archive/install/103k/reset sequence inside
`D:\murage-ci` or fallback `C:\murage-ci`, checks command exits and the entire
named reset set, preserves evidence under that root, and removes its exact
created folder in `finally`. It is not invoked by Linux tests. Windows
filesystem exhaustion remains omitted under R-2.

`check-reset-set.mjs` independently requires the handshake and C15' crashes at
`reset-before-delete` and `reset-after-wal-delete`, then T-REC-RESET,
PERSISTENT, WINDOW, DEFER, ONCE and T-SCRUB-BACKOFF, NOSTARVE, RECOVER, CAP tests.
Thus the old tip cannot accidentally qualify by running a filter that selects
no new recovery tests.

## RC copy gate (MAIN-owned execution)

Do not run these commands against real data during harness development.
MAIN selects a cold release-copy source, never a live installation. The host
entry points mount the source **read-only**, hash every file before and after,
refuse symbolic links/special files and create a fresh copy inside the fixture.
The source is never opened as a SQLite connection. Large-file hashing streams
in 1 MiB blocks. Evidence contains counts, timings and hashes; no sampled
needle, message text, original file name or private assertion text is emitted.

```sh
export MURAGE_QUAL_COPY_SOURCE=/path/to/cold-release-copy
bash scripts/qualify-search/baseline.sh copy
bash scripts/qualify-search/run.sh q3-bound-1k
export MURAGE_QUAL_PRIVATE_CASES=/path/to/four-case-manifest.json
bash scripts/qualify-search/run.sh q3-copy
```

Q3's six bars are: open within base+20 ms; forced history rebuild from an empty working index to HEALTHY with
owner writes ≤20 ms; complete result-set parity of 50 fixed-seed 3–20 character needles against
actual base legacy FTS+LIKE results after audience filtering; 100 owner sends
with statements/frames equal to the synthetic 1k fixture and p99 <20 ms; a
large-thread drop with cleared debt, no unique synthetic deletion trigram
residue and integrity on both files; and all four private-copy cases.
The original manifest must match after all steps, including failures.

The private-case manifest is explicit because the design references four IDs
in RED-TABLE.json but that table is not present in this checkout. MAIN must
supply those **existing** four IDs with their exact file/test selectors and
the `sourceHash` from `q3-copy`/source audit. The harness invents no case IDs:

```json
{
  "sourceHash": "<sha256-of-source-manifest>",
  "cases": [
    {"id":"<existing Q3 ID>","file":"server/<existing>.test.ts","pattern":"<exact test selector>"}
  ]
}
```

There must be four unique entries. The case tests must consume
`MURAGE_QUAL_COPY_WORKING_DIR` and `MURAGE_QUAL_COPY_SOURCE_HASH`; they run as
Vitest subprocesses in the same network-isolated container. Missing results,
errors and skips fail. Their private stdout stays in memory and only statuses
and counts enter the report. Synthetic smoke checks four explicitly named
smoke invariants instead and cannot qualify the private cases.

## Final rig

On the harness tip and again on the integration SHA:

```sh
node scripts/qualify-search/rig.mjs "$PWD" HEAD /path/to/evidence/r4
MURAGE_FTS_MERGED_SHA=<merged-sha> node scripts/qualify-search/rig.mjs "$PWD" <merged-sha> /path/to/integration-evidence
```

The wrapper holds both lane container locks for the full rig, requires
preseeded dependencies for both lockfiles (it refuses a network install),
and requires hz-gate success and its actual `gates.rc=0`, runs
`vt-shard.sh` for base b4dc27ea9 and tip with `--shards 8`, `MAXC=2`, load limit
60 and the two vt hosts, reuses base/lane results from the shared-base registry,
requires fresh merged-mode tip results, and writes the sorted
set difference `NEW-FAILS.txt`. Missing reports/results fail. New product test
files require pass counts from shard JSON. Added skips may only be C16/C18;
on the integration run those exceptions are disabled. The default sharded
suite excludes qualification files by construction, so their separate raw
reports and pass counts accompany the rig result. Rig smoke invokes temporary
gate/shard executables on synthetic corpus result records and verifies the
actual command sequence, eight-way arguments and regression comparison; it
launches no nested containers and cannot create a release gate attestation.

## Review fixes and diagnostic inventory

Negative controls change the disposable fixture: Q1 executes owner FTS SQL,
Q2 corrupts the stopped search index, and Q3 removes indexed history postings.
The report never overrides a measured bar. Negative classifiers require both
`computedPass` and `pass` to be false, with supporting raw measurements.
Q2 compares both exhaustion and recovery snapshots to the original-row ledger,
adding each successful send and removing a thread only after its drop commits.

Q3 enumerates all FTS candidates without the public search page's 2,000 limit.
The production grouped walker runs to exhaustion per thread for LIKE and reader
privacy checks; a nonadvancing partial cursor fails. Rowid hashes intersect the
complete postings and visible results. Smoke tests exceed 2,000 matches and
remove an older posting. Every copy, including one with a healthy search.db,
has its working index removed while stopped, then asserts an empty index and
an active rebuild cursor before timing owner sends during history rebuild.

Merged rig runs require the full tip SHA marker. A saved adapter adds that
marker to each Docker invocation of the shared shard tool; source-anchor drift
fails closed. The tip runs with `--force --out` in a unique evidence directory,
so cached SHA-only reports cannot qualify integration. C16 and C18 must each
appear and explicitly pass. Both OS jobs include the crash test file; the reset
validator independently requires the handshake and both C15' SIGKILL barriers.

`search-qualification-english.json` inventories the lane's operator diagnostics,
internal errors, assertions in helper files, command templates and job labels.
Generate it with `node scripts/qualify-search/english-inventory.mjs` in the test
container. The base is 102c9a79f, the lane's original parent; tests and generated
JSON/Markdown are excluded. All entries are NEW, because every harness file was
introduced in this lane. No product UI strings changed. This inventory is
unreviewed copy supplied for Sol copy review; it does not claim approval.

Run `bash scripts/qualify-search/run.sh review` for the seven review regressions.
`review-mutations.py` runs the same tagged assertions on an isolated prior-HEAD
archive (RED) and one explicit reversion per finding (killed mutants), keeping
all logs and Vitest JSON. These checks use fake synthetic fixtures only.
