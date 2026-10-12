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
| `shapes.mjs` | The two shapes. `extreme` = SCALE-PLAN section 1 (3 years, 60 bots, 3M messages, 500k receipts, a 200k-row thread, a 2,000-receipt resumed session of ~20k roots, 150k checkpoint versions, 20k vectors, revoked receipts, a full routine journal, one two-year-old unanswered card). `pr` = every dimension at a small size. Any knob can be overridden with `SCALE_<KNOB>` (e.g. `SCALE_ROWS_TOTAL=200000`). |
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
| Murage-added time to first token | Turn trace `engine.first-text` (the fake engine answers at once) | 300 / 600 ms |
| Per-turn cost, turns 10 / 100 / 500 | 500 real turns on one resumed session (Slope), prep of the 5 turns ending at each mark | turn 500 ≤ 1.7 × turn 10 (10% per doubling) |
| Conversation switch | Playwright: click to the bot's rows on screen | 100 / 200 ms |
| Open the longest thread | Playwright: click to the first page painted (200k rows) | 150 / 300 ms |
| Memory search while capturing | Recall span per turn on a fresh Sable task, each right after a Capt turn (its capture and the generated job backlog are being worked meanwhile); success = recall not skipped; plus the owner's search | 300 / 500 ms, ≥ 95% success |
| Settings, bot settings | Playwright: Settings › Engines settled; bot settings open | 400 / 800 ms; 150 / 300 ms |
| App start on the big data dir | Server process start to healthy (3 starts) plus the first screen | usable 1.5 / 2.5 s, settled 3 / 4 s |
| Routine burst | `burstRoutines` routines due in the same minute: due to started | 1.0 / 2.0 s |
| Revoke / forget freeze | Archive and forget memory the long session rests on: request time, health requests stuck behind it, event-loop max | 250 ms worst case |
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
