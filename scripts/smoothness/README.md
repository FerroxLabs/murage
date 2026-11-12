# Smoothness gate

Set `SMOOTH_ROOM_PROOF=1` for a fake-engine room route proof (with `hz-smooth.sh`, pass `-e SMOOTH_ROOM_PROOF=1` among its extra Docker arguments); real engines refuse the leg as INVALID with a reason. After all four measured rounds and the tail reach DONE, three separate scripted Grok members in a second room each request one `git status` approval at Ask, answered through the normal room drain and thread respond route; a second message uses `slow-tool`, waits for roster `working=true`, sends one group interrupt and drains to DONE within 60 seconds. Controls and levels are restored in `finally`. Results retain `roomProofRequested` and `scenarios.room.proof` with card/interrupt evidence and `ok`; S3 measurements stop before proof setup, and proof failures still use the room settlement gate before later scenarios or cleanup. Requested proofs add required `S3.proof.respond` and `S3.proof.interrupt` rows; otherwise those rows are absent. `S3.drain` is INFO with measured rounds/tail and final settlement. These changes and their isolated fake-clock tests are authored only; runtime qualification has not been performed.

Rig **5.9** immediately appends and fsyncs minimal `kind: first` failure evidence from SSE for runner-owned bot threads/tasks and group threads, including routine, delegated-worker and room-member turns, to `SMOOTH_OUT/failed-turns-<label>.jsonl`. Turn identities deduplicate first records; `turn()` appends richer `kind: enriched` records with the same key after transcript/native-trace reads. Results retain the unique failure count and latest 50 records. Pending enrichment is drained before resource deletion or server stop, bounded to 10 seconds total per boundary; timeouts are noted, journaled and saved. All retained failure diagnostics pass through secret redaction and accounting-value scrubbing; archived server logs use the same accounting keys, preserve originals and fail closed if filtering fails. Records retain only completion evidence, Murage error rows, RPC code/message and bounded traces, never full protocol frames or general conversation text. Output must be outside the data dir and checkout; launchers preserve JSONL before deleting copies, including orphaned runs. Journal write failures are noted. Only valid major.minor versions below 5.8, or files with neither version nor phase, retain legacy judging; malformed versions are INVALID and other files require finished cleanup with no leg failure. Control restoration ignores only ENOENT, verifies file contents/absence, and immediately saves a leg failure and blocks later scenarios on failure. These fixes and regression tests are authored only; no runtime qualification has been performed.

Rig 5.8 saves `phase: running`, then `cleanup`, then `finished` after all cleanup outcomes; failures are saved immediately with their reason, unfinished/failed legs cannot pass, and both judging launchers propagate nonzero runner exits to `REALEXIT` and their exit status (older result versions retain their judging behavior).

Rig **5.8** adds `SMOOTH_APP_DIR` for the packaged server leg. Set it to the unpacked electron-builder
directory or installed directory containing `Murage.exe` and `resources` on Windows, `murage` and `resources`
on Linux, or to `Murage.app` on macOS. The rig still needs its checkout (`SMOOTH_WORK`) for instrumentation
and redaction. With the variable unset the source launch remains the default: source wrappers forward
`--version` to the fake CLI exactly as at `fb1f97a1a`, and startup keeps the same selected boot sequence,
SSE start, two-second wait, instance load and roster read. Packaged resolver preflight never runs on
source legs. The source regression case covers generated wrapper bodies and the runner's startup
orchestration with injected in-memory operations, as well as launch arguments and environment.

In packaged mode only, fake wrappers answer `--version` themselves: `fuigo 999.0.0` satisfies
`server/env-path.ts:810-857` and outranks ordinary bundles, Grok `1.0.62` meets
`server/drivers/acp/grok.ts:469-485`, and Claude `2.1.295 (Claude Code)` meets
`server/drivers/claude-guards.ts:20-33`. Each banner includes a fresh wrapper witness.
Before any packaged scenario, `/api/instances` must return the expected executable selection and that exact
driver-probed banner (`server/index.ts:30213-30230`, `server/harness/registry.ts:402-407`);
`/api/engine-management/fuigo` must also report PATH/custom, never bundled/managed
(`server/index.ts:30275-30277`, `server/engine-management.ts:96-104`). Missing proof refuses the leg.
Codex requires its semver gate (`server/drivers/codex-hook.ts:44`, `codex.ts:931-933`), but has no
fake wrapper here: S10 is real-only; fake roles use only Fuigo, Grok and Claude. No other fake engine
is launched. Real-engine selection and version answers remain unchanged. Tests pin all three banners
and refuse a bundled path/source or a foreign banner.

Pass 3, item 2: the runner replaces prior results with `status: INVALID`, mode, label, run id and
`preflight.ok=false` before validating data, app metadata, Electron version or native files. Every
validation refusal saves its reason before cleanup. `real-smooth.sh` exports `SMOOTH_RUN_ID=$RUN_ID`
to runner and judge; the judge prints INVALID and fails for a missing/different id when that variable
is set, retaining its previous behavior when unset. Tests cover stale PASS results and an early refusal.

Pass 5 follows RIG-V58-ROOM-DRAIN rev 3: two complete polls 1 s apart must show group
`working=false`, idle members and no open non-limit cards, followed by a final collection
re-check. All operations share the round's 90 s or tail's 30 s absolute deadline. Failure
latches S3 incomplete; one interrupt (10 s) and a separate 30 s observation gate every
non-DONE exit. Unproved settlement stops the owned server and makes all later rows INVALID;
a rejected room DELETE fails the leg. S3.cardWait remains information only. The lifecycle
assumption (each card holds a tracked room operation) still needs real-server wiring proof.
Agreed note: RIG-V58-ROOM-DRAIN (internal design record);
SHA-256 `de0e3ca55d15e7b3cf216ac0c03208a62c97ad182cd99fb5189b9532e4a034c3`.

Pass 3, item 4: `stopOwnedServer` takes the child and injected send, kill, spawn and sleep operations;
`stopServer` delegates to it. Authored cases cover exit zero, nonzero exit, signal exit, throwing IPC,
and the exact timeout fallbacks (`taskkill /PID <pid> /T /F` or `SIGKILL`). The refusal-cleanup test
clears its event list and checks the second invocation independently.

Pass 3, item 5(a): fixture launch mirrors `en-US`, unavailable desktop credential storage, empty
secret-save refusal/ambient Flux key, and backup control at
`<canonical DATA parent>/.murage-backup-control/<sha256(canonical DATA)>`, as actually derived by
`electron/backup-closed-controller.mjs:10` and `backup-closed-profile.mjs:10` (not under userData).
The remaining fork inputs in `electron/main.mjs:2156-2205`, `managed-composio.mjs:125-164`, and
`workspace-credentials.mjs:13-27,73-122` are mirrored or explicitly stripped and recorded in
`fixtureEnvOmitted: [{ name, reason, cite }]`. Tests pin the mirrored values and complete omission list.

Pass 3, item 5(b): the available 1.0.17 object `f28a6bad8` emits `cardClass` on permission cards:
`server/approval-card-grants.ts:104,128-131` and `server/index.ts:9269`, with its type in
`shared/fold-scopes.ts:29`. Thus unclassified approvals always receive Deny; no legacy command matcher
is needed. Tests cover classified ordinary/stop approvals, unclassified read/wipe commands, and the
unchanged Skip/leave-open behavior for questions and limit offers.

Pass 3, item 5(c): `bootWarm.window` and `excludedWindows` span cold-server stop through warm health
and its three-second settle. `measuredEld` extends `eldStalls`' existing `SERVER_START_MARK` restart-gap
exclusion; warm ELD (including the first straddling tick), CPU/RSS and I/O stay out of ALL and appear in
the S0 WARM information row. I/O's mixed 60-second reporting interval (`server/io-budget.ts:19`) stays
with WARM and has a separate overlap count. Linux ALL RSS uses retained samples, explicitly labelled,
because cumulative `memory.peak` cannot subtract a warm peak. Tests isolate a warm stall, resource
spike and mixed I/O minute while retaining cold measurements and genuine sampling gaps.

Pass 3, item 6: the rig remains **5.8**. Regression cases extend the two existing test files; no new
test file or tier-list edit is needed for this pass. This pass used static inspection only: no fixture,
runtime, tests, build or script was executed, and no commit was made.

The packaged command is the app's own executable with `ELECTRON_RUN_AS_NODE=1`, followed by
`--import <file-URL of scripts/scale/eld.mjs> --import <file-URL of scripts/smoothness/packaged-preload.mjs>
<app resources>/server/index.js`. There are no server arguments and no TypeScript stripping. File URLs
encode Windows drive paths, spaces, `#` and `%`. The rig checks for real `[eld]` output; an Electron build
that cannot load the preload is refused, with no silent uninstrumented fallback.

The repository launch contract and the fixture adaptations are:

| Piece | Evidence and rig behavior |
|---|---|
| Compiled entry | `electron/main.mjs:2148` chooses `process.resourcesPath/server/index.js`. `electron-builder.yml:152-153` copies `dist-server` to `server` outside `app.asar`; `scripts/bundle-server.mjs` bundles the independent proxy entries too. |
| Runtime / argv / cwd | `electron/main.mjs:2210-2213` uses `utilityProcess.fork(entry, [], { env, stdio })`, with no cwd override. The requested rig uses that app's Electron in Node mode and inherits `SMOOTH_WORK` as cwd, with only the two rig preloads added. This measures the compiled server, not an Electron UI boot. |
| Resources | `electron/harness-resources.mjs:17-41,97-106` supplies `MURAGE_RESOURCES_PATH` and the UI, skills, skill library, team library, bot library, Fuigo, GEPA and memory-model directories. The rig maps all of these into the selected app. `server/proxy-paths.ts:26-31` therefore resolves the shipped `.js` proxies beside the bundle. |
| Data / port / version | `electron/main.mjs:2168,2176-2185` supplies `MURAGE_DATA_DIR`, `MURAGE_PORT`, `MURAGE_BOOT_NONCE`, `MURAGE_USER_DATA` and `MURAGE_APP_VERSION`. The rig supplies the leg's copy/port, a nonce, and a `smooth-user-data` folder inside the copy. The packaged server receives the app-style `NODE_COMPILE_CACHE` described below; the preload does not enable caching. |
| Fixture flags | The existing rig retains its HOME/TMP settings, `MURAGE_WEBHOOK_PORT`, accepted terms, `MURAGE_ANNOUNCEMENTS_URL=off`, and `MURAGE_TURN_TRACE=1`. The GEPA pin comes from the selected app's metadata (`electron/harness-resources.mjs:112-136`). It does not import the desktop's live credentials, backup host or data-owner lease. |
| Authentication | `server/sse-visibility.ts:56-79` rejects dev secrets when `process.parentPort` exists **or** `MURAGE_DESKTOP_PARENT=1`. A compiled server started in the requested Node mode has neither; its explicit `MURAGE_ALLOW_DEV_DESKTOP_SECRET=1` and `MURAGE_DEV_DESKTOP_SECRET` are supported fixture inputs. The rig checks `/api/desktop-secret` and an authenticated desktop-only `/api/storage` read before scenarios. No parent port is fabricated or auth code changed. The actual utility child's auth path is its freshly minted secret sent on the private port (`server/index.ts:1690-1703`), received by `electron/main.mjs:1150-1153`; that requires a real Electron utility parent, not Node IPC. |

The app imports `compileCacheEnvironment` in `electron/main.mjs:14` and spreads it into the server's
fork environment at `electron/main.mjs:2182`. The rig mirrors `electron/compile-cache.mjs:13-18`:
`<leg MURAGE_USER_DATA>/node-compile-cache/<appVersion>-electron-<electronVersion>`, replacing characters
outside `[0-9A-Za-z._-]` in each version with `_`. `MURAGE_USER_DATA` is `<leg MURAGE_DATA_DIR>/smooth-user-data`.
The app version comes from the selected app's package metadata.
Electron's version uses the first `version` file beside the executable, in resources or at the app root (trimmed, optional `v` removed), otherwise the selected executable's `-p process.versions.electron` with only `ELECTRON_RUN_AS_NODE=1`, hidden window and 30 s timeout; semver evidence is recorded as `electronVersion`, `electronVersionSource` (`file`/`exe`) and `electronVersionFile`/`electronVersionExecutable`, and invalid evidence or a failed probe refuses the leg (results INVALID, gate FAIL).
Inherited `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE`
are dropped in packaged plans so the server receives only the app-style cache setting.

Every packaged leg creates a fresh empty cache directory before its first spawn. An existing populated
directory is refused without deleting its contents; an existing empty leaf is recreated. Separate legs
must use their own data/userData copies. Like an update to a new app version, **S0.boot is COLD** and
keeps the existing 20,000 ms p90 budget. Its `scenarios.boot` contains only the first boot's `healthy`
statistics and `samples`. After the existing three-second settling interval, the rig reuses `stopServer`
and `startServer` for a clean shutdown and restart with the same environment and cache directory.
`scenarios.bootWarm` has the identical timing fields and appears as **S0.warm (WARM)**, information only,
with no budget or verdict effect. Both boots run on every packaged leg, including a selected-scenario
run. Source mode retains its existing launch and boot behavior.

Results record `compileCache: { dir, emptyAtStart: true, filesAfterCold }`. The file count is recursive
and taken after the cold process exits cleanly, so cache writes flushed at shutdown count. If it is zero,
the results note and WARM row say **cache did not fill**; the second start is not claimed as a warm boot.
An unclean cold shutdown refuses the leg rather than claiming a valid warm measurement.

Packaged preflight compares health's PID with the owned child, then reads the server's own data-dir owner
lease from the rig parent. `server/config.ts:643` resolves `DATA_DIR`; `server/index.ts:1183` acquires its
lease before store construction, through the re-export in `server/data-dir-lease.ts:3`. The shared
implementation derives the sibling `.murage-data-owner-<sha256>.lease` filename from the canonical data
path (`electron/data-dir-lease.mjs:333-342`) and publishes the owner record with the server PID
(`electron/data-dir-lease.mjs:459-471,497,597-604,687-689`). The rig mirrors that filename derivation,
including Windows namespace/case handling and macOS NFC/case folding. It fills `observedData` only when
the record at that path names the owned server PID, then compares it with `realpath(MURAGE_DATA_DIR)`.
Missing, unreadable, malformed or other-PID evidence refuses the leg; a mismatched observed path also
refuses it. This proves ownership of the expected directory without patching SQLite or any other module.
The check runs after startup and does not prevent the server's own startup writes; it cannot report an
unexpected directory's location when the expected lease is absent. The preload contains only a Windows
native-addon witness that reads `require.cache`. On the real Windows leg the installed native files are hashed and the actual loaded
addon path is checked in the Electron child. A short preflight bot turn must emit `[turn-trace]` before
measured scenarios; the bot is stopped and deleted afterward. Failure records a refusal, stops the owned
child, exits 2, and makes the judge reject the leg.

`results-<label>.json` records `rigVersion`, `mode`, `appDir`, `appVersion`, `serverEntry`, and preflight
evidence. The version is read from the app's packaged `package.json` (including `app.asar`), never the
checkout version. Startup preflight runs again on each restart; the trace probe runs once before scenarios.

S3 keeps every room card payload, counts distinct request IDs whether answered or still open, and uses
S7's `POST /api/threads/:id/respond` path. Classified ordinary approvals get Allow, questions get Skip,
limit offers remain for the owner, and stop/wipe or unclassified approvals get Deny. `cardRows` retains shown/answered
timestamps and S7-style derived timings. The room prompt is unchanged. **S3.workerSliceWall** reads
`[turn-trace] phase=memory.indexSlice ms=<wall incl commit> rowMs=<row work> rows=<n>` from the room
scenario's own log window (including its settling cleanup). It displays count, max and nearest-rank p99
of `ms`, with the `rowMs` max beside them; no matching line means **not measured**. This row is information
only, with no bound or verdict effect. Tests extend the existing
`smooth-config.test.mjs` and `smooth-gate.test.mjs`, including all `packaged.mjs` helpers, lease/native observations,
fake startup/trace/refusal flows, launch plans on Windows/POSIX, and a fake room thread. Both existing test
files now have their missing GATE rows in `ci/gate-tests.txt`; no new test file was added. A link test checks
the runner's named imports without starting it. Test assertions are authored, not executed.

Gate-owner follow-up: update the external `G8_RIGTAG` and any other v5.7 deployment labels to v5.8.
Those launcher definitions are not present in this checkout. Runtime qualification and tests have not
been executed for this edit-only change.

The whole-system gate 1.0.5 must pass before it publishes (design: `104-lastresort-evidence/designs/SMOOTHNESS-GATE-105.md`).
Every lane proves its own fix; this proves the product as Sean lives it: his real data (a copy), his day as a fixed scenario
set, an idle and an 80%-loaded machine, fake engines so every millisecond, byte and card is Murage's own.

| File | What it is |
|---|---|
| `smooth.mjs` | The runner. Starts the server on a COPY of the real data (refuses any path without `smooth` in it or with `.murage`), with `claude`, `fuigo` and `grok` wrappers first on PATH that run the test fakes (`server/testing/fake-*-cli.ts`), and plays the scenarios: boot, routineBurst, delegation, room, trust, longThread, deletion, engineSwitch, stop, idle. Results: `$SMOOTH_OUT/results-<label>.json`. Counts, ids and timings only. |
| `smooth-config.mjs` | Pure helpers: Sean's log signatures, transcript reading (cards, withheld mirrors, Context changed), levels, routine burst scoring, the chain, the judge, the verdict. |
| `budgets.json` | The budgets, one row per symptom or wait. A loaded run has the same limits; a loaded latency row shows the old 1.5 factor beside it as information only. |
| `smooth-gate.mjs` | Judges results against the budgets: one table, exit 1 on any FAIL, `--verdict` writes the file the release gate reads. |
| `run-container.sh` | Container entry: refuses a data copy with `routines.json` or `config.json`, runs the runner, then the gate. |
| `hz-smooth.sh` | Launcher from a checkout: `git archive` of the commit, node_modules hard-linked from a lane dir with the same lockfile, a fresh `cp -a` of the data source (routines.json deleted in the copy), the container, and for `load` a host `stress-ng --cpu 6 --cpu-load 80` pinned to the container's cores. The copy is deleted when the run ends. |
| `keep-logs.sh` | Copies a run's full server log, results, gate table and debug dir to `smoothness/logs/<run-id>/` (box: `$HOME/smoothness/logs` for the real leg, `/srv/murage-smooth/smoothness/logs` for the container leg). Both launchers run it before they delete a working copy, and keep the copy when it fails. Rev 4: the server log and the `failed-turns-*.jsonl` journal both go through one awk filter with the `scrubAccounting` grammar (512-char budget per value, a malformed or unterminated value drops the remainder; a malformed journal fails the keep with exit 4); the archive is built in a private temp dir and published with one rename. |
| `stage-keeper.sh` | Run by `hz-smooth.sh` before ANY tree or data replacement: stages the hash-verified local `keep-logs.sh` privately, refuses when Docker's state for the label is unknown or running, holds a per-lane lock (`smoothness/locks/<label>.d`) until the container starts, and preserves the previous run. `SMOOTH_PRESERVE_ONLY=1` is prepare-only (writes the receipt); `SMOOTH_SYNC=present` consumes it (and re-archives if the lane changed). The PowerShell wrappers (`real-leg-win.ps1`) do not run it; their keep stays the v5.8 copy. |
| `*.test.mjs` | GATE tier (ci/gate-tests.txt). |

```
scripts/smoothness/hz-smooth.sh smooth-<label> <commit> idle      # then wait on gate.log's REALEXIT= line with ONE blocking ssh
scripts/smoothness/hz-smooth.sh smooth-<label>-load <commit> load
node scripts/smoothness/smooth-gate.mjs out/results-smooth-<label>.json --loaded out/results-smooth-<label>-load.json --md GATE.md --verdict ci/smoothness-verdicts/<tree12>.json
```

**Blocking:** `scripts/release-ci-gate.mjs` refuses a release without `ci/smoothness-verdicts/<first 12 of the tree>.json` for the
pinned commit (or its parent when only that directory changed since), with both runs green and no older than 7 days. No waiver.

**Real engines:** `SMOOTH_ENGINES=real` runs the PATH engines as they are (the real-engine gate box, subscription logins). The
fake-only steps are reworded (see the design, section 5); latency rows are not judged for a real-engine run, the zero rows are.
Today (2026-10-24) no engine is signed in on that box, so the baseline is fake-engine only.
On real engines the S8 Stop bot runs at Full access (`SMOOTH_STOP_LEVEL`, default `full`), so an approval card nobody answers
is not what holds the stopped turn. Every runner bot works in its own folder (`/tmp/smooth-work/<scenario>--<bot>`), a turn
that times out is stopped and its bot waited idle before the next message, and every bot a scenario made is stopped when the
scenario ends (`endStop` in the results), so no scenario's leftover turn holds the next one.
S7's switch bot stays at the default Ask level (what customers get). The runner answers each approval card as the owner would,
Allow through the app's own route (`POST /api/threads/:id/respond`; a question card gets its own Skip), and times it: `S7.cardShown` (engine asked to card shown)
and `S7.cardClosed` (Allow to card closed) are Murage's own and judged on both legs, passing as "none raised" only when the card count was really read and is 0.
The owner's time on a card (`cardWaitMs`) extends the turn's timeout and is shown beside the wall; nothing is subtracted from the wall.

Rev 6 lane ownership uses a persistent per-label flock mutex and token-qualified lock directories. Locks never expire by age. `SMOOTH_PRESERVE_ONLY=1` prints the prepared transaction token; pass it as `SMOOTH_TXN` with `SMOOTH_SYNC=present` after the external replacement. A claimed receipt cannot be replayed. For an abandoned owner, first quiesce that owner, then invoke the launcher with `SMOOTH_BREAK_LOCK=<exact owner token>` (the prepared transaction token for a prepared owner). Recovery prints the checked owner and detaches its directory under the same mutex. Never unlink the flock file.

The host keeper uses `/usr/local/bin/node` (Node 22); the real launcher passes `$R/node/bin/node` (Node 24) for both preservation calls. The follower uses its captured container ID, run ID and private log, verifies `run.id` after acquiring fresh ownership, and retains data on ambiguous state or preservation/removal failure. Its acquisition wait defaults to 3600 seconds with ten-second retries; `SMOOTH_FOLLOW_WAIT_SECONDS` may shorten that limit.

ALL ELD now begins at the first message send attempt, including preflight, room sends and failed attempts. Results and `debug/run-events-<runId>.jsonl` retain the same epoch, request ID and log offset. The two run-start ELD rows and the first-send delay remain informational. IO, home, stale, context and RSS keep their previous windows; S0 retains boot measurement. No send or no post-send readings leaves gated ELD unmeasured.

Rig 8 Nov (MurageMain ruling): on real engines the three S3 room bots are set to Full access (setLevel full, as S5 does for its held bots) before the room is created, so S3.cards measures room smoothness and not Ask cards; the S3.cards bound (0) is unchanged and S4 keeps its own Ask and No limits levels. real-smooth.sh now exports TREE_SHA (the staged build sha, .smooth-sha or git rev-parse) so the gate header and results.json carry it instead of "tree ?".

Rig 8 Nov (Sean approved Mac CPU row): on macOS S9.cpuTree is the judged CPU row at its 0.25 bound and S9.cpu (whole-machine top) is information only, labelled "whole machine, info only (macOS)". Linux (cgroup) and Windows keep S9.cpu judged. No bound changes.

Source container runs provision the native relocation helper before measurement
(`native-preflight.mjs`, called by `smooth.mjs` before server startup). A missing Linux helper is
compiled from this checkout's `native/engine-exclusion/exclusion.c` with the
fixture image's gcc and N-API headers, without network access. Its `build.json`
records the source hash, binary hash, target, compiler and `fixtureOnly: true`.
This artifact belongs to the Node fixture runtime; release packages continue to
use `build-engine-exclusion.mjs` and its AlmaLinux glibc floor.

To supply an existing build, set `SMOOTH_NATIVE_FROM` to a mounted directory
containing `<platform>-<arch>/engine-exclusion.node` and `build.json`. For a
standalone helper build/load proof, run
`node scripts/smoothness/native-preflight.mjs`. macOS and Windows require an
existing build (their build and packaging paths remain in the platform scripts).
Every source leg verifies the receipt's source and binary hashes and optional
`SMOOTH_ENGINE_EXCLUSION_SHA256`, then asks the product loader to open that exact
file. The load probe must move a dangling link and refuse an occupied target.
Missing, stale, unloadable or unsafe helpers refuse the leg before any turn.
The result keeps `nativePreflight`. A preparation failure invalidates the leg
through the existing refusal path, after superseding any previous PASS.

The focused fake-engine regression is
`pnpm exec vitest run scripts/smoothness/s5-relocation.test.mjs scripts/smoothness/native-preflight.test.mjs`.
After provisioning the helper, it seeds three old-root pinned skill links in a
fresh verification fixture, sends five turns and applies the unchanged
`S5.firstText`, `S5.resumed` and `S5.failed` budgets. It retains bounded control
results and the fixture log in `.planning/s5-evidence` (or `S5_EVIDENCE_DIR`).
It does not qualify the full real-data idle/load gate.

For the original S5 long-thread proof, run `s5-replay.mjs` inside the isolated,
network-disabled test container, with the preserved drained archive and private
manifest (archive SHA-256, bot, thread, original message count, all 12 link names
and targets, source HEAD, and `supportHashes`). Export the five fake-engine
files from the original overlay, the two prebuild helpers from its rig and its
verified `cage/` files into the support directory; the manifest pins their hashes. No private fixture data
belongs in Git.

```
node scripts/smoothness/s5-replay.mjs ARCHIVE MANIFEST PINNED_SUPPORT OUTPUT
S5_REPLAY_MANIFEST=MANIFEST S5_REPLAY_RESULTS=OUTPUT/s5-replay-results.json pnpm exec vitest run scripts/smoothness/s5-replay.test.mjs --maxWorkers=1
```

The replay verifies the archive, history count and every old-root link before
launching the unchanged rig with `SMOOTH_SCENARIOS=longThread` and fake engines.
It retains the input proof, original-history hashes before and after, all three
row verdicts, prebuild and server logs, raw rig results and native helper. Its
selected task's Mac working-folder pin is adapted to the copied desk and that
path change is recorded separately; its history and skill links are preserved.
The temporary source/data copies are removed afterward. This is S5-only evidence;
the full idle/load release gate still requires both complete legs.
