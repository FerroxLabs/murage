# Scale rig

The measurement foundation for Murage at the extreme (SCALE-PLAN sections 1, 2 and 5): a deterministic
data generator, an overloaded-machine mode, the user-felt scenarios, and a gate that fails on a broken
budget, a growing per-turn cost or a regression. Nothing here touches production code paths; it runs
the tree under test as it ships, against fake engines that answer at once, so every millisecond
measured is Murage's own.

Everything runs on build-host in a container. Never on a laptop: the generator writes tens of GB and
it refuses any data dir outside `/scale/` (never `~/.murage`).

## Files

| File | What it is |
|---|---|
| `shapes.mjs` | The shapes, and `rcReceiptOutputs` (the RC receipt writer's final output lists: each row on its turn's receipt and the session's newest, at most two). `owner` = the owner's file (STORAGE-AUDIT): about 100k messages in 650 threads, room replies shown 47 lines of their members' threads, about 4.7k receipts, messages.db made with auto_vacuum=0. `extreme` = SCALE-PLAN section 1 (3 years, 60 bots, 3M messages, 500k receipts, a 200k-row thread, a 2,000-receipt resumed session of ~20k roots, 150k checkpoint versions, 20k vectors, revoked receipts, a full routine journal, one two-year-old unanswered card). `pr` = every dimension at a small size. Any knob can be overridden with `SCALE_<KNOB>` (e.g. `SCALE_ROWS_TOTAL=200000`). |
| `storage.mjs` | End-of-run storage measurement (dbstat per table with its indexes, the messages b-tree, live and file bytes, events/) and the slope session's bytes per new message. gate.mjs judges it against budgets.json `storage` (table groups by name prefix, as multiples of the messages b-tree); dbstat missing fails the rows. rig.mjs idles `SCALE_IDLE_MS` (default 8 min) first so idle maintenance runs. |
| `gen.ts` | The generator. Runs inside the tree under test with that tree's own code (see its header for what is real API and what is bulk rows). Same seed + shape = same data. Passes: `base`, then `rig.mjs prime`, then `hot`, then `manifest`. |
| `rig.mjs` | Scenario runner: `prime` (first boot after upgrade, memory model download, two real Sable turns) and `run` (all scenarios). Results: `results-<label>.json`. |
| `pw.mjs` | Playwright flows: app start, open the longest thread, conversation switch, Settings › Engines, bot settings, typing. |
| `load.mjs`, `fsync-delay.c` | Overloaded machine: `LOAD=1` starts `LOAD_LOOPS` (default 4) busy loops and a `LOAD_BALLOON_GB` balloon beside the server inside the container's CPU and memory limits; `SLOW_DISK=1` preloads a shim that delays every fsync/fdatasync by `FSYNC_DELAY_US` (default 8,000). |
| `eld.mjs` | Event-loop delay, one line a second, preloaded into the server. |
| `budgets.json` | SCALE-PLAN section 2 budgets, the slope rule and the regression rule. |
| `gate.mjs` | Judges a results file. Exit 1 on any failure. `--baseline` adds the regression check; `--compare` prints a side-by-side table. |
| `gate.test.mjs` | Unit tests of the gate (part of the normal vitest run). |
| `run-container.sh` | Container entry: install, build the UI, generate (or reuse the cache), prime, run, gate. |
| `hz-scale.sh` | Launcher from a checkout: exports a commit with `git archive`, syncs these scripts, starts the container on build-host. |

## Scenarios (each reports p50, p90 and max)

| Scenario | How it is measured | Budget (p50 / p90) |
|---|---|---|
| Turn prep before the engine | Turn trace `dispatch.send` on Sable's resumed 2,000-receipt session | 150 / 300 ms |
| Murage-added time to first token, warm | Turn trace `engine.first-text`, turnPrep run with the engine pool on, turns whose `engine.acquire` says `cold=false` only | 300 / 600 ms |
| Murage-added time to first token, cold start | The same mark, coldStart scenario with the pool off (the shipped default), turns with `cold=true` only | p90 3000 ms |
| Per-turn cost, turns 10 / 100 / 500 | 500 real turns on one resumed session (Slope), prep of the turns among the 5 ending at each mark that truly resumed (own memory line `resumed=true`, no reset); invalid below 90% resumed | turn 500 ≤ 1.7 × turn 10 (10% per doubling) |
| Conversation switch | Playwright: click to the bot's rows on screen | 100 / 200 ms |
| Open the longest thread | Playwright: click to the first page painted (200k rows) | 150 / 300 ms |
| Memory search while capturing | Recall span per turn on a fresh Sable task, each right after a Capt turn (its capture and the generated job backlog are being worked meanwhile); success = Sable's turn sent a bundle with hits (scored by its own trace, a re-dispatch followed; Capt's apart in `byBot`); plus the owner's search | 300 / 500 ms, ≥ 95% success |
| Settings, bot settings | Playwright: Settings › Engines settled; bot settings open | 400 / 800 ms; 150 / 300 ms |
| App start on the big data dir | Server process start to healthy (3 starts) plus the first screen | usable 1.5 / 2.5 s, settled 3 / 4 s |
| Routine burst | `burstRoutines` routines due in the same minute: due to started | 1.0 / 2.0 s |
| Revoke / forget freeze, index ready and index building | Archive and forget memory the session with the most source-citing receipts rests on: health requests stuck behind it, event-loop max; one row per revocation index state (the building state from a second, revoke-only pass with `SCALE_REVOKE_INDEX=building`) | 250 ms worst case each |
| Event-loop stall | Per-second max during turns, and over the whole run | p90 100 ms, max 250 ms |
| Background CPU while typing | Server + children CPU (not the load generator), sampled each second while Playwright types for 30 s (page load excluded) | 0.5 / 1.0 cores |

## Running it

One command for a BASELINE.md (launches, waits on one blocking ssh, copies results, writes `BASELINE-<label>.md`):

```sh
scripts/scale/baseline.sh int102 <commit>            # extreme shape, overloaded, slow disk; exit 0 = all budgets pass
scripts/scale/ci-check.sh pr-1234 <commit> [baseline.json]   # pr shape; fails on a budget or regression
```

`.github/workflows/scale-budget.yml` runs the check manually and nightly only (not on the default CI path: it takes over 15 minutes).

Lower-level:

```sh
# from a checkout of this branch (the commit can be any commit, e.g. a PR head)
scripts/scale/hz-scale.sh pr-1234 <commit> pr -e LOAD=1                               # per PR (see runtime below)
scripts/scale/hz-scale.sh nightly <commit> extreme -e LOAD=1 -e LOAD_BALLOON_GB=16 -e SLOW_DISK=1
ssh build-host 'tail -f /root/mb-0161-hz/scale-<label>/gate.log'                    # ends with REALEXIT=<gate>
```

Runtime. Generating `pr` takes about a minute and the scenarios a few minutes once turns cost what the
budgets allow; the 500-turn slope dominates. On today's trees a pr turn costs 1 to 4 s, so the slope alone
takes up to an hour (capped by `SCALE_SLOPE_CAP_MS`, default 60 min for pr, 90 min for extreme). Generating
`extreme` takes about 1.5 to 2 hours per tree (3M messages through capture, 500k receipts with real lineage
writes, and the tree's own message search index build on first open) and writes about 35 GB.

The generated data is cached under `/root/mb-0161-hz/scale-data/cache/<shape>-s<seed>-<commit>-<generator hash>`,
so a second run of the same commit skips generation. Delete old cache entries by literal path when a
lane is done.

## CI wiring (not yet in .github/workflows)

Workflow changes get their own CI first, and MurageMain decides that, so nothing here edits
`.github/workflows` or `release.yml`. The intended wiring:

1. **Per PR** that touches `server/memory/**`, `server/index.ts`, `server/store.ts`, `server/drivers/**`,
   `src/state/**` or `src/components/Sidebar.tsx`: a job with the build host deploy key runs
   `scripts/scale/hz-scale.sh pr-<number> <head sha> pr -e LOAD=1 -e BASELINE=baseline-pr.json`, waits on the
   log's `REALEXIT=` line with one blocking command, and fails the check on a non-zero exit. The baseline is
   the last green `pr` results file from main, copied into the label's `out/`.
2. **Nightly** on the release branch: the same with `extreme -e LOAD=1 -e LOAD_BALLOON_GB=16 -e SLOW_DISK=1`;
   publish `results-<label>.json` and `gate-<label>.md` as artifacts.
3. **Release gate:** the nightly extreme run must be green for the release head.

At most two rig containers run at once on the host (`hz-scale.sh` refuses a third).

### Other hosts

`RIG_HOST=<ssh host>` (default `build-host`) points `hz-scale.sh`, `baseline.sh` and `ci-check.sh` at another
host; `RIG_MAX` (default 2) is how many rig containers that host may run at once. The host needs docker,
`cc`, rsync, the `mcr.microsoft.com/playwright:v1.57.0-noble` image, and under `/root/mb-0161-hz`: `tools/`
(pnpm), `store/`, `passwd`, `group` and `perf102-rig/secrets/` (may be empty; the key is read only with
`SCALE_FLUX=1`). An extreme run takes 6 cores and 24 GB per container and about 100 GB of disk per commit.

## chatDuringPostUpgradeCheck

The owner chatting while the 1.0.1 to 1.0.2 upgrade's "Checking earlier memory" phase runs. It needs the FIRST boot of an unprimed copy of
the extreme data dir, so it has its own run: `hz-scale.sh <label> <commit> extreme -e SCALE_UNPRIMED=1` (the container generates the base
data only, with no prime and no hot session, runs just this scenario and gates just its budgets). To judge a normal run together with it,
pass the unprimed run's results file to the normal run's gate: `-e UPGRADE_ALSO=results-<unprimed label>.json` (copied into that run's out
directory), or `node gate.mjs results.json --also results-<unprimed label>.json`. Without it the five chat budgets read "not measured" and
fail.

The scenario reads `/api/health` `upgrade` in the shape of `shared/upgrade-contract.mjs` (contract version 2, lane upgui; `upgradeStatus`
in rig-config.mjs, tested against `fixtures/health-upgrade.json`). While stage is "background" and complete is not true it sends a message
to Sable every 30 s, whether or not the last one is back, and reads the health once a second on its own clock. It is finished only when the
server reports complete; a reading that is missing or is not the contract's shape, a blocked upgrade, or a cap reached all fail the gate
(`finishedFlag`), as does any failed message (`failedSends`) or any message without all of its clocks (`samplesFlag`). Budgets: accepted
within 1 s, message received to engine started (the `engine.submit` trace mark, where the adapter is handed the turn) p90 within 3 s, no
event-loop stall over 250 ms, and the check's percent never frozen for more than 60 s. `SCALE_UPGRADE_CHAT_CAP_MS` caps the wait.
Other new options: `SCALE_ACP_POOL=1` (or `MURAGE_ACP_POOL=1`) runs the engines pooled, recorded as `acpPool` in the results.

## How a turn is read (rig-config.mjs)

Trace lines carry a turn id and no thread id, so each turn first waits until no earlier trace is open, sends with its own
`sendId`, and is read only from the traces that started after its send: its prep is its own `dispatch.send`, its memory
line the one written right before that mark, its resets the `memory continuation reset thread=<its thread>` lines. The
event stream ends it only for its own engine turn id. A turn the server re-dispatched (`re-preparing once`) waits for the
re-dispatch and is scored by it. The warm-session row runs with the pool on (a restart if the base run has it off) and the
cold-start row with it off; each turn records `engineCold` and `pooling`. `SCALE_REVOKE_INDEX=building` resets the
revocation index on the data copy and runs revoke first and alone; `run-container.sh` runs that pass after the main run
(`SCALE_REVOKE_BUILDING_PASS=0` skips it) and gates with `gate.mjs --with`. `pw.mjs` writes a request waterfall (path,
start, end, status, bytes) for app start and Settings › Engines into `pw-flows-<label>.json`. Each row of `budgets.json`
has a `description` of exactly what it measures.
