# No limits early proof — correction qualification

The 08:05Z correction is binding. At No limits, saved permission denials require RUN with zero cards, permission refusals, holds or silent denies. A capability switched off requires OFF, zero cards and one plain line identifying its settings. Questions remain questions. Guests never inherit; a bot explicitly selected in 1.0.19+ applies as selected. Legacy Full access / permission revision flags do not establish that selection; missing origin stays Ask.

Primary correction qualification source: `edb8edf9fdf3f504d5c5c6107bf0ba15a50ae6d1`. Final product source was rechecked at `5bb37abc9af76c872e4d9a995a0dc5d2720daee7`: server typecheck, 207 main changed cases, 51 headless scenarios, self-test, 19 display contracts, exact-SHA seven-engine replay and zero-hit leak guard pass. The Git argument fix additionally passes 34 H6 cases and its killed mutant. Newest hub `7719151e773449c22098ed13fa4a59abfa46fe9d` is merged; its test-only connector reader correction passes all 83 cases, preserving the Full access reader. Checked changed-file coverage is now 437 cases (207 + 147 + 83). Product code is unchanged by this last test-only merge. The final source pin is in the external DONE record. Initial findings and the correction milestone were published before 09:00Z (`c2cb4a8c2a`, consolidated classification `c66d89c02d`). This file contains aggregate evidence only.

## Private real-log replay

The sealed corpus was read in place and streamed in memory into the job's isolated, network-disabled container. No raw corpus was copied into the repository or published evidence. Independent labels cover 140 asks; 121 complete inputs replay and 19 truncated inputs remain unavailable.

| Cohort | Recorded asks | Replayed inputs | Unavailable | Permission cards per engine |
| --- | ---: | ---: | ---: | ---: |
| Owner | 34 | 31 | 3 | 0 |
| Routine | 8 | 8 | 0 | 0 |
| Non-owner / missing origin | 98 | 82 | 16 | 82 |
| Total | 140 | 121 | 19 | 82 |

All seven supported judge projections ran: Claude, Codex, ACP, Pi, Antigravity, Muse and OpenAI. Across 847 judged decision cells, the 273 eligible owner/routine cells produce **0 non-wipe permission cards and 0 judge refusals**. The remaining 574 cells are non-owner Ask controls: the corpus cannot establish a newly recorded explicit bot choice. Each engine retains the same 19 unavailable inputs.

These are production-judge counterfactuals, not recovered original provider delivery. They do not prove the absence of historical transport holds or silent denies. The display command exits 2 for unavailable inputs and historical full-verdict parity; matrix exits 0. No unavailable input or historical comparison is converted into a release PASS. The final documentation commit receives a separate replay receipt; executable source is unchanged from the runtime pin above.

## Initial findings and producing paths

| Count | Kind / rule | Producing path at first measurement | Covered by hub list? | Outcome |
| ---: | --- | --- | --- | --- |
| 55 | always-ask / unreadable | server/auto-approve.ts:1167, server/auto-approve.ts:1213; origin projection server/auto-approve.ts:991 | C2, H5 | Expected non-owner Ask controls |
| 23 | sensitive-guard | server/auto-approve.ts:1592, server/auto-approve.ts:1690 | C2, H5 | Expected non-owner Ask controls |
| 3 | prompt-guard | server/auto-approve.ts:1624 | C2, H5 | Expected non-owner Ask controls |
| 1 | no-grant | server/auto-approve.ts:1797 | C2, H5 | Expected missing/non-owner Ask control |
| 1 | highlevel-unproven silent deny after a marked thread | server/index.ts:11205; server/highlevel/engine-policy.ts:29, server/highlevel/engine-policy.ts:60 | No | Fixed: eligible No limits bypasses the generic historical-mark backstop; current server/index.ts:11207 |

The milestone ledger is nonwipe=83, covered=82, new=1; 82 are excluded-origin controls, not eligible No limits failures. The separate HOME-assignment wipe miss was a safety finding, fixed by the merged hub. Unknown-delete RUN and visible-wipe controls remain tested.

Code audit also found saved consent suppressing host mounts, connected-app permission filtering at dispatch/discovery/stored-result boundaries, and HighLevel permission ceilings. These are additional code findings rather than additional historical corpus cards. They were outside the hub's listed items and are corrected here. Earlier R2 stored-denial refusal expectations were replaced with execution witnesses; no refusal-for-stored-deny implementation remains.

## Classification of every deny-* scenario row

| Row / setting | Code evidence at runtime pin | Class | Required No limits outcome |
| --- | --- | --- | --- |
| deny-host-declined | scripts/no-limits-live/r2-scenarios.mjs:37; server/index.ts:2238; server/host-computer-consent.ts:53 | 1: remembered permission answer | RUN; saved answer remains unchanged |
| deny-browser-never | scripts/no-limits-live/r2-scenarios.mjs:42; server/index.ts:2239; server/browser-extension-service.ts:943 | 1: saved site permission rule | RUN; saved Never row remains unchanged |
| deny-app-denied | scripts/no-limits-live/scenarios.mjs:25; server/bot-access.ts:150; shared/bot-access.ts:19 | 1: request-denied permission record | RUN |
| deny-app-revoked | scripts/no-limits-live/scenarios.mjs:25; server/bot-access.ts:139; shared/bot-access.ts:19 | 1: grant-revoked permission record, not an account disconnect | RUN |
| deny-script | scripts/no-limits-live/run.mjs:254; scripts/no-limits-live/scenarios.mjs:15 | 1 under the conservative rule: protected-path fixture, no capability disabled | RUN |
| HighLevel denyRules and connected-app write/family/operation permissions | server/highlevel/host.ts:516, server/highlevel/host.ts:675; server/bot-access.ts:195 | 1: saved rules and ceilings | RUN |
| Browser false / global browser disabled | server/feature-off.ts:6; server/index.ts:18061 | 2: capability disabled | OFF; one Browser settings line, zero cards |
| Computer off | server/feature-off.ts:7 | 2: capability disabled | OFF; one Computer settings line, zero cards |
| Connected apps false | server/feature-off.ts:8; server/bot-access.ts:188 | 2: integration disabled | OFF; one Connected apps settings line, zero cards |
| HighLevel account disconnected | server/highlevel/host.ts:534; server/highlevel/access.ts:105 | 2: integration disconnected | OFF; one reconnect/settings line, zero cards |
| Channel messages off | server/feature-off.ts:4 | 2: channel capability disabled | OFF; one Permissions settings line, zero cards |

All five deny-* rows are class 1. A saved record is never reclassified as a disabled capability because its identifier contains deny or revoked. This table is also present in the external DONE record.

## Checked correction boundaries

The isolated API regression launches the documented verification fixture, installs an inert engine/provider, drives actual conversation requests, and checks ordinary RUN, visible wipe, saved host denial and browser OFF outcomes. Browser-site Never has a service execution witness. Connected-app policy tests exercise stored request-denied and grant-revoked records. HighLevel tests require an actual fake-provider POST without review for saved denies and permission ceilings; a disconnected integration must not dispatch. Native release tests cover original and changed targets, visible wipes, and retained Full access controls.

The replay oracle now requires stored denies to run with zero cards/refusals/holds/silent denies. Explicit disabled-capability snapshots require no execution, no card and exactly one explanation line. The display judge accepts only named wipe evidence as an interruption exception. The shared G-NL synthetic list includes these contracts. The channel-off row requires OFF with one line and zero cards; the explicit guest row requires RUN without inheritance.

At the primary correction pin, all three configured typechecks pass. The initial tools invocation used a nonexistent config path; its setup-error receipt is retained and superseded by the configured tools/flux-stream-conformance/tsconfig.json check. Changed tests at that pin: 354/354 pass (207 main + 147 additional changed-file cases); the later test-only hub adds 83/83 passing connector cases. The correction's focused green set passes 55/55; all 16 mutants are killed, including saved-denial refusal and disabled-feature execution/card-oracle failures. Direct display-admission tests pass 19/19; leak guard v2 reports whole-tree=0 and added-lines=0. Native/structured transport fixtures pass 39/39, including all five retained Full access controls.

The headless native replay passes all 51 scenarios at fixture pin d44508798e9966d8cea30e35cba4ddeda6925285 and at final product pin 5bb37abc9af76c872e4d9a995a0dc5d2720daee7, including explicit guest RUN and channel OFF with one line and zero cards. The separate self-test and direct 19-test display contract pass at both pins; receipts are recorded externally. Product code is unchanged from the runtime pin. Original and repeat receipts remain separate.

The unmodified headless attempt encountered owner-first scheduler load deferral before a webhook acquired its thread. Its failed receipt is retained. The repeat uses the repository's existing server/testing/idle-load-preload.mjs solely to model an idle host; assertions and permission behavior are unchanged. General app-denial workflow bindings remain explicitly UNBOUND and are not counted as native workflow passes.

## Full release qualification remains OPEN

The complete comparison against `dev/1019-int19m12b` (`49f91a80733d03aba0c3b7a422283ee05703c911`) is incomplete. Baseline inventory: 4,519 files; candidate inventory: 4,559 files. The eight-shard scheduler waits while shared-host load exceeds 60; candidate shards wait for their paired baseline slot. Timeout and missing-test records remain failures/unverified, never passes. Test results are compared by file and full test ID. No full-suite release PASS is claimed.

The final aggregate G-NL synthetic run at `d3588c124c23b896ba4df296f9469af82aa93cff` completes successfully: **2,581/2,581 tests across 29/29 files**, zero failures, exit 0, 1,082 seconds within its 1,200-second bound. Earlier 600-second timeout receipts are retained; their incomplete status was not converted into a pass. This closes the synthetic gate, including all 957 X2 Full access preservation cases. It does not qualify installed all-engine delivery. The private display corpus has nativeTransportProven=false and cannot establish original native delivery.

Two merge conflicts were resolved: server/decision/no-limits-structured-1019.test.ts uses the hub's awaited card presentation before durable lookup; server/drivers/no-limits-provider-release-1019.test.ts uses hub transport observation with robust cleanup and retains all five pre-existing Full access controls. Those controls use actual legacy native completion/decision witnesses rather than requiring a broker event the legacy path does not emit. Hub production code wins for its listed items. No test was skipped or deleted.

Project memory prelude was unavailable: no registered tool, command or memory directory. Verification used isolated fixtures; no live app, private machine, billable service or other lane's worktree was mutated.

The full run remains pinned to d3588c124c23b896ba4df296f9469af82aa93cff. This final report update changes only FINDINGS.md; executable and test source are identical. Product including the then-newest hub was pushed at 09:59:41Z; later pushes contain the test-only hub update and evidence. Exact final-report-SHA replay is recorded in the external DONE file.

## Review fix round

The fix round starts from `53b06c604c00f7c094aee43650e30489b3efeaac` and includes newest hub `df08e936cf6da904c77eacb17fddc0a07028997d` at runtime pin `d118c70bfca92c2f5f701f501db0f2c9f6806de6`. The only merge conflict was in server/decision/implementation.ts imports and capture declarations: the hub's full-input wipe fields and the earlier explicit-selection/OFF notice fields are both retained.

The original synchronous queue responder assertion is restored alongside the asynchronous level-change case. Synchronous presentation now refreshes the bound turn's current No limits authority. The replay oracle requires execution and zero interruptions for every eligible ordinary or stored-denial row, and its runner records the actual policy outcome. Explicit No limits guest projections preserve enabled capabilities and genuinely disabled settings. Channel OFF applies at every permission level. The positive OFF fixture includes the required single line, with negative controls for missing/extra lines and accidental execution. The new guest regression file is registered in the blocking test inventory.

SHA-bound RED at the starting HEAD: 12 behavioral assertion failures, with 39 passing controls, plus the positive OFF fixture failure. The final RUN/OFF API assertions also fail against original source `a73c31f6f0a662b7a85466fa97c58c75e2e4d0d7`: both saved-host-denial RUN and browser OFF reproduce their final assertion failures. No superseded stored-denial refusal expectation is used for these receipts.

At the merged runtime pin, **711/711 focused assertions pass**, as do all six direct OFF gate contracts. The private seven-engine replay retains **273 eligible judge decisions, zero cards and zero refusals**. Nineteen inputs remain unavailable; original transport delivery, holds and silent denials are not established by this counterfactual judge result. The broader string comparison finds zero corpus-text matches; its single raw overlap is a baseline commit SHA independently proven to exist in the starting public source. Shared leak guard v2 remains whole-tree=0, added-lines=0.

Typechecks, fresh mutation kills, the aggregate G-NL run and the complete comparison remain pending. The comparison preserves repeated test titles with case occurrence IDs and rejects timed-out processes even when they leave JSON output. Earlier incomplete receipts and tooling failures remain evidence, not passes. No full release qualification is claimed at this milestone.
