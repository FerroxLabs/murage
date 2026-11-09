# PULLBACK-LAYERS closure record (1.0.18)

This is the committed closure record for the PULLBACK layer engine lane (fix/1018-pullback). It replaces the local round notes so that `src/components/pullback-closure.test.ts` reads a file that every checkout has. The round 3 text below is kept as written at the time; the "Round 4 (Astra r3 fix pass)" section at the end records the later fixes.

## Round 3 record

Base: `bfca748da575d155428ff251a38889b8bf64e0bc` (r2b), branch `fix/1018-pullback`. No commits, network, live app, server/cloudflare/electron implementation edits, or browser launches. All work remains uncommitted. Browser evidence must come from the shepherd: `pnpm exec playwright test -c src/e2e/pullback-layers.config.ts`.

## Part A

1. HireBotDialog imports now follow the complete copyright/UX comment header.
2. First R24-HANDOFF scrollTo restoration is in finally, matching its companion test.
3. D7 restoreAllMocks is in finally.
4. D8a uses fake timers: load and settle the actual palette, then advance the 150 ms search debounce. Both resolve/reject variants retain the id, input identity, opener return, and absence of stale focusMessage/error dispatch. Expected red reasoning (not an executed mutation): removing the request token guard allows A's completion to close B or dispatch a focusMessage/error; the unchanged id/focus/dispatch assertions fail. A missing search debounce response fails the hit assertion. This is not a weakened timer-only assertion. Real timers and mounted roots are restored in finally.
5. Additional modal imports are contiguous at the top. Native React imports are consolidated at the top; StrictMode no longer imports inside a test.
6. R3-RESUME: interval and delete appearance effect does not repeat when a higher layer closes. Both mounted tests were green before any production dependency change. useFocusTrap stores its LayerImpl in state for the activation; active is a getter, not a new handle on reorder. First appearance still focuses Custom interval/Keep. Tests deliberately select a different lower control, open and close a real higher LazyOverlay, and assert exact resumed control plus zero calls to the appearance control's focus. No dependency change needed.

Part A local result: 5 files, 81 tests passed (`pb-round3-A.log`). This includes the two new mounted resume cases and both timer variants.

## BF ledger

“Closed” below means the retained local implementation and behavior proof. Browser-dependent rows are explicitly **not run** and are not release closure claims. “Implemented” means executable coverage was added; the shepherd must run it. Remaining scope limits are listed after the table.

| BF | Status | Test name(s) | Source file and implementing symbol |
|---|---|---|---|
| BF-1 | closed, retained DOM | R24-INLINE | `src/components/ApproveAll.tsx`: ApproveAll, ApproveAllSheet |
| BF-2 | closed, retained DOM | R24-DIRTY/R23-CALENDAR | `src/components/CalendarLayer.tsx`: useCalendarLayer |
| BF-3 | round 3b export opener fixed, red/green DOM; browser not run locally; shepherd rerun pending | R23-NULL / BF-3 / R22-RETURN (five actual callers, dismiss/reject/load) | `src/components/LazyOverlay.tsx`: LazyOverlay; `src/components/Sidebar.tsx`: Sidebar export opener |
| BF-4 | implemented; browser not run | D18 / R23-STOP / BF-4; D18 / R23-ENGINE / BF-4 (separate owner-unmount rows); R22-TURN; B10 / R22-RESTART | `src/e2e/pullback-layers.fixture.ts`: PullbackFixture, restartEngine, settle; real StoreProvider dispatch and openLiveEvents |
| BF-5 | closed, retained DOM | R23-UNDO | `src/lib/undo.ts`: connectUndoHost |
| BF-6 | round 3b native return fixes, red/green DOM; browser not run locally; shepherd rerun pending | R22-RETURN; R22-OWNERS / R23-H3 / BF-6 / R22-RETURN eight native children cold/warm/StrictMode/crash/retry/cancel/unmount; R23-NULL native success/cancel | `src/components/LayerSlot.tsx`: LayerOwner.lease, loaded; LoadedLayerProps in LazyOverlay; `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show/captureReturn |
| BF-7 | closed, retained DOM | R22-TEAM | `src/components/TeamLibraryPanel.tsx`: TeamLibraryPanel registered Escape callback |
| BF-8 | closed, retained engine/DOM; browser supplement not run | R22-RESUME; D6; R3-RESUME; B5 / R22-RESUME | `src/lib/focus-trap.ts`: LayerImpl.captureReturn |
| BF-9 | closed, retained engine | BF-9/E7; E7 lower replacement | `src/lib/focus-trap.ts`: TrapDocument, lostFocus, LayerImpl.detach, observeFocus, attach |
| BF-10 | implemented; browser not run | B8 loading and rejected phone portal; S6 | `src/components/LayerSurface.tsx`: layerHost, LayerSurface |
| BF-11 | closed, DOM | D8a stale selection completion rejection=false/true | `src/components/CommandPaletteHost.tsx`: closeRequest; CommandPalette.activate; landOnSearchHit in src/lib/focus-message.ts |
| BF-12 | implemented; browser not run | D19; H1/R23-H1; R23-H1 Revoke; B1; R23-H1 / R22-H2 empty/nonempty; R23-H1 / D19 / BF-12 model/revoke foreign/native matrix | `src/components/ModelPicker.tsx`: ModelPicker target onKeyDown; SettingsModal search; RevokeDeviceConfirm |
| BF-13 | round 3b native silent teardown fixed, red/green DOM; browser not run locally; shepherd rerun pending | S1/S8/S9; H2/D13; D12; B4 native cancel and nested show order | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer; useLayerContainer in src/components/LayerSlot.tsx |
| BF-14 | closed, retained DOM | D1/D2; D3/BF-14 | `src/components/LazyFallback.tsx`: LazyFallback; OverlayShell error attachment in LazyBoundary |
| BF-15 | closed, retained engine/DOM | E4/H4; D8-empty; R22-H2; R24-INLINE foreign roots | `src/lib/focus-trap.ts`: guarded, canHandleLayerEscape |
| BF-16 | closed, retained engine/DOM | E3/E5; D20 | `src/lib/focus-trap.ts`: listen document bubble dispatcher |
| BF-17 | implemented; browser not run | D1/D2/D6/D8/D9; B1 through B10 | `src/testing/dom-harness.ts`: mount, cleanup, press, gate, settle; PullbackFixture |
| BF-18 | implemented; browser not run | D6; B2 held Settings and empty/reopened palette | `src/components/CommandPaletteHost.tsx`: CommandPaletteHost; publishLayers in src/lib/layers.ts |
| BF-19 | closed, DOM | D7 actual Settings crash and retry; D3/D4; R22-H1 | `src/components/LayerSlot.tsx`: LayerOwner covering activation and content revisions |
| BF-20 | closed, audit passed | R23-SOURCE | `src/lib/focus-trap.ts`: TrapDocument, LayerImpl.captureReturn; returnTarget in src/lib/return-focus.ts |
| BF-21 | closed, audit passed | R22-MAP; R23-MAP; R24-AUDIT | `docs/verification/pullback-layers-1018.md`: Provenance and retained mappings |
| BF-22 | round 3b production closed-details filter fixed, red/green DOM; browser not run locally; shepherd rerun pending | R22-DETAILS DOM and Chromium Tab comparison | `src/testing/dom-harness.ts`: installDOMHarness visibility shim; `src/lib/return-focus.ts`: usableFocusTarget, inClosedDetails |
| BF-23 | implemented; browser not run | BF-23 / H1 / D2 full App app-to-bot-to-app; D2/H1; E8 | `src/App.tsx`: Shell.settingsSession; settingsOpener in src/lib/settings-leave.ts |

## Browser fixture and limits

The real App mounts its own StoreProvider, Shell, Sidebar, HelpHost, Settings and CommandPaletteHost. A Vite-only observer is inserted directly under that provider; no production module is mocked. Supplemental SectionContextDialog, archives, Memory and Shortcuts are actual components under that same provider. The fixture never imports production server initialization. Each test creates its own loopback Vite door, fresh mkdtemp data/cache directory and real EventSource stream, and closes exactly that server and its sockets. External browser requests are denied. Chromium uses touch capability so pointer/hover idle prefetch cannot warm cold Settings before a held route is installed. Chunk routes are explicitly held or rejected. The reload seam is substituted only in the fixture transform of LazyOverlay. Normal reload and App unmount/remount are separately exercised.

The supplied health-doctor.human.spec.ts was read, including its actual-provider /__door fixture. health-doctor.config.ts is absent on this base. The new config is self-contained and allocates its evidence under a fresh temporary directory; no shared port, environment data directory or reuseExistingServer is required. The requested ijfw_memory_prelude tool and .ijfw/memory directory are unavailable. No prohibited home directory was read.

BF-4 observes actual client POST body, draft lookup acknowledgement, pendingQueued settlement and streaming disappearance separately. Engine tests disconnect the real SSE response, require a new connection and roster E2 adoption, and use an admitted stream barrier before checking rejection of E1. Stop and engine each have separate owner-unmount tests. Turn completion/restart and document/application restart have separate tests. These are fixture contracts awaiting Chromium execution, not claims of observed transitions.

Coverage added after the first audit: BF-6 now has eight actual independent native children (export, shortcuts, close/end project, bundle, What's new, engine link and sign-in), cold/warm and StrictMode variants, twice-repeated loaded crashes, fresh cover/child ids, zero intermediate opener focus, browser cancel, and external unmount with exact return counts. BF-12 now has actual contained ModelPicker/Revoke under the real Settings owner, with composition/prevented events, unresolved palette, foreign aria-modal and browser-native guard variants. These executable matrices are not run. R22-OWNERS adds actual App cover activation/return rows for All chats, Team map, Routines, Skill recorder, Computer and Inspector, alongside the retained matrices. Actual bot/group call and find covers and both App workspace callbacks now have dedicated R22-OWNERS rows, including the call end action and the browser workspace return to Computer. PhoneSheet and ApprovalDetailsSheet have actual browser owner tests, retaining Approval skipReturnFocus. No named B1-B10, H3/B7, D18, R23-STOP or R23-ENGINE id is omitted. No skip/fixme is used.

## Provenance and retained mappings

Historical Astra r23: BLOCK. Historical Grok r23: SKIPPED, not approval. Current Astra r24: AGREE. Current Grok r24: AGREE. The r24 verdict lines and retained Medium/Low tables were read; older reviews were not reread. The design's historically empty section 13 remains historical; the separate authorized BUILD-FIX contains 23 obligations. No second fix is invented for duplicate reviewer findings.

R23-SOURCE baseline audit: TrapKeyEvent line 45, TrapDocument line 59, isReachable line 95, opener line 116, capture listener line 118, resume line 140, wrapTabTarget line 167, unconditional resume line 190, hook cleanup line 225 (not 226). Baseline excerpts for the document, resume and cleanup were read. Baseline returnFocus is at line 12 and has no returnTarget. Baseline health-exit/escape-layer manifest rows already have both TAB separators. The separator premise is rejected; introducing returnTarget remains required and implemented. Current source audit resolves symbols, never obsolete line positions. E7/E8/R22-RESUME provide behavior proof rather than treating corrected citations as behavior fixes.

Out of scope: dependency/security product work; engine-default selection; Help-chief fallback; No-limits acceptance/copy. FullAccessWarning mechanics and the exact jsdom harness dependency stay in scope.

| Retained finding | Test mapping |
|---|---|
| AR21-1 | R22-H1 / D16-L |
| AR21-2 | R22-H2 / D8-empty / E4 |
| AR21-3 | R22-RETURN / D15-Hire |
| AR21-4 | R22-TEAM |
| AR21-5 | R22-RESUME / D6 |
| AR21-6 | R22-HTML / E7 |
| AR21-7 | R22-MAP |
| GR2-1 | R22-RESUME / D6 |
| GR2-2 | R22-H1 |
| GR2-3 | D1 / D3 |
| GR2-4 | R22-HTML / E7 |
| GR2-5 | R22-H2 |
| GR2-6 | R22-TEAM |
| GR2-7 | S7, already-separated baseline |
| GR2-8 | R22-DETAILS |
| AR22-1 | R23-H1 |
| AR22-2 | R23-CALENDAR |
| GR22-1 | R23-H1 |
| GR22-2 | R23-H2 |
| GR22-3 | R23-H3 |
| GR22-4 | R23-NULL |
| GR22-5 | R23-STOP / R23-ENGINE |
| GR22-6 | R23-UNDO |
| GR22-7 | R23-SOURCE corrected citation |
| GR22-8 | R23-SOURCE / S7 split separator and returnTarget disposition |
| AR23-1 | R24-H1 / R24-DIRTY / R24-BRANCH / R24-HANDOFF / R24-AUDIT |
| AR23-2 | R24-INLINE / E4 / H4 / R24-AUDIT |

## R22-MAP / R23-MAP / R24-AUDIT execution index

| Cases | Executable test file and names |
|---|---|
| R22-H1, D16-L, R23-H3, D15-Hire | src/components/lazy-overlay.dom.test.ts: D15/R22-H1 page handoff; R22-H1 stale completion; R23-H3 explicit lease, repeated lower crashes and external unmount; D15-Hire |
| R22-H2, R23-H1 | src/components/window-layers.dom.test.ts: H1/R23-H1; src/components/palette-layer.dom.test.ts: D8-empty/D9; browser R23-H1 / R22-H2 |
| R22-RETURN | src/components/loaded-modal-layers.dom.test.ts: actual hire/template/project/team cold/inert matrix; browser R23-NULL / BF-3 / R22-RETURN |
| R22-TEAM | src/components/team-library-layer.dom.test.ts: actual TeamLibrary pending/importing branch matrix |
| R22-RESUME, R22-HTML | src/lib/focus-trap.test.ts: R22-RESUME, BF-9/E7, lower replacement; src/components/window-layers.dom.test.ts D2/D6; browser B5 |
| R22-STOP, R22-ENGINE, R22-TURN, R22-RESTART | browser D18 / R23-STOP, D18 / R23-ENGINE, D18 / R22-TURN, B10 / R22-RESTART and B10 late completion |
| R22-DETAILS | src/components/layer-slot.dom.test.ts R22-DETAILS; browser R22-DETAILS / BF-22; R24 phone geometry checks actual template sheet at 844/500 visual viewport heights |
| R23-H2 | src/components/additional-modal-layers.dom.test.ts actual modal matrix; browser B9 |
| R23-CALENDAR | src/components/calendar-layers.dom.test.ts R24-DIRTY/R23-CALENDAR |
| R23-NULL | browser five callers times dismiss/reject/load; retained lazy-overlay normalization tests |
| R23-UNDO | src/components/modal-inventory.dom.test.ts R23-UNDO |
| R24-H1, R24-DIRTY, R24-BRANCH, R24-HANDOFF | src/components/calendar-layers.dom.test.ts actual calendar inventory, dirty close, capability branch, both list/paused/problems handoff paths |
| R24-INLINE | src/components/modal-inventory.dom.test.ts actual caution and selection, standalone/managed, native/foreign guards |
| R24-AUDIT | src/components/lazy-overlay-contract.test.ts S8/S9 and R24-AUDIT exact inventories; src/components/pullback-closure.test.ts R24-AUDIT |
| R22-MAP, R23-MAP, R23-SOURCE | src/components/pullback-closure.test.ts named documentation/source audits |

## R22-OWNERS closure index

This maps the one authoritative section 6a owner table, rather than creating another policy table. The matching real component matrices retain activation, first focus, return and Escape assertions. Browser supplements are not run.

| Owner rows | Behavior proof |
|---|---|
| Settings, Bot settings | window-layers H1/R23-H1, D2/D6, D7; browser B1 and BF-23 |
| Plugins, Team library | browser R22-OWNERS Plugins cold/warm; team-library-layer R22-TEAM; browser H3/B7 |
| Palette empty/loaded/error | palette-layer H1/D8, D8-empty/D9, D8a; browser B2 |
| Loading-only pages, Computer/Inspector, call and find covers | lazy-overlay D15/R22-H1, D15, D16, stale completion; actual App covers added for six owners; calls/find/workspace callbacks added under R22-OWNERS, not run |
| Hire/Templates/New project/Team settings | loaded-modal-layers R22-RETURN; browser R23-NULL |
| Native loaded callers | native-layers D12/D20; browser B4 and R23-NULL export/shortcuts; eight native crash matrices added under R22-OWNERS / R23-H3 / BF-6, not run |
| Phone/Approval/archive/ConfirmDelete | additional-modal-layers R23-H2 archive/confirm matrix; browser B9 and R22-OWNERS PhoneSheet/ApprovalDetailsSheet |
| All nine calendar surfaces, both RoutineSheet callers | calendar-layers R24-H1, R24-HANDOFF, R24-BRANCH, R24-DIRTY; R3-RESUME interval/delete |
| Four non-native Settings children | modal-inventory H2/D13 and busy remote confirmation |
| Five native Settings children | native-layers D12 parameterization; browser B4 |
| LevelConfirm, Update, New Team, New Channel/Project, Channel details, Manage members, Rename, Make project | additional-modal-layers R23-H2 matrix and busy branches |
| Undo toast, inline ApproveAll, Revoke | modal-inventory R23-UNDO, R24-INLINE, R23-H1 |
| Foreign native and aria-modal | focus-trap E4/H4 and modal-inventory R24-INLINE foreign roots |
| Help | window-layers D14 and browser B5 |
| Health/loaded nonmodal pages and phone drawer | lazy-overlay pending Health, escape-layer tests; browser B6/B8 |
| BotPermissionDefault and contained ModelPicker | modal-inventory ownership guards; window-layers D19; no independent slot as S8/S9 verifies |

## Validation and copy

Part A: 81/81 local DOM tests passed. Additional local result: 10 engine/DOM/source files, 163 tests passed (`pb-round3-closure.log`). Browser tests: **not run**, per the sandbox port restriction. New human spec follows existing human-spec classification: excluded from Vitest tier lists, selected by its own Playwright config. New Vitest closure audit has a three-field gate row. No shipped strings, locale keys or source hashes changed. Local helper/log files start with pb-; pre-existing vitest.pb.config.ts stays local.

Final checks: `node node_modules/typescript/bin/tsc -b` passed on the complete fixture/spec batch (`pb-round3-types-complete.log`). `node scripts/ci-test-tiers.mjs check` passed: 3492 Vitest files, 2005 gate, 1487 extended (`pb-round3-tiers-final.log`). The final five closure audits passed (`pb-round3-audit-final.log`); `git diff --check` passed. The three actual fixture transform outputs (App, SettingsModal, LazyOverlay) were syntax-checked without launching Vite or opening ports. Total distinct local tests run for this round: 244, all passing. Browser execution and the resulting fix pass remain with the shepherd; no browser result or live conversation/server verification is claimed.

Fully closed locally: BF-1, BF-2, BF-5, BF-7, BF-8, BF-9, BF-11, BF-14, BF-15, BF-16, BF-19, BF-20, BF-21. Partial only as executed evidence: BF-3, BF-4, BF-6, BF-10, BF-12, BF-13, BF-17, BF-18, BF-22, BF-23 await their written Chromium tests. No missing named Part B id, no new stack-class stop finding, no shipped copy changes, no commits.

## Round 3b

The shepherd's `pb-r3-pw.txt` reports 52 passed / 41 failed. Each numbered error, call log, driving row, fixture path and component was reviewed. Classification before fixes: **32 product failures (four bugs), nine spec/fixture failures**. The native matrix is not one cause: **16 warm** rows fail the zero-intermediate-return assertion at old line 480; **12 cold** rows fail final focus at old line 486. The four passing cold shortcuts/What's new rows show in layout effects; the other six children show in passive effects after LoadedCommit can focus its wrapper.

| Group | Rows | Diagnosis and correction |
|---|---:|---|
| Product: native crash teardown | 16 | `useNativeDialogLayer.retire` called browser close while the outgoing control still had focus. Defer closing until the React commit removes/replaces the node; generation checks cancel stale close on StrictMode replay, which re-registers an already-open dialog. |
| Product: native browser handback | 12 | Passive show remembers a loading wrapper as the browser opener. Final close focuses that wrapper; the guard incorrectly treats it as deliberate unrelated focus. Record the pre-show browser target and allow that exact return only when focus was inside the outgoing dialog at capture. |
| Product: Sidebar export opener | 3 | Menu item disappears before LazyOverlay captures the opener. Pass the persistent New or share ref explicitly, as template/hire already do. |
| Product: closed details reachability | 1 | Chromium may report rectangles for folded descendants. The jsdom visibility shim hid this bug. Production eligibility now excludes every closed-details ancestor except its first summary subtree. |
| Spec: commit/chunk/animation waits | 3 | B2 captured Settings before the reopened palette registered; B5 focused the transient HelpFrame Close; approval paint sampled the entering sheet below the viewport. Wait for the actual palette/Help component and poll the unchanged hit assertion. |
| Spec: duplicate Memory locator | 1 | Scope to the supplemental launcher; ChatView also mounts the same named button. |
| Spec: wrong origin/return contract | 2 | B6 entered Calendar from chat but expected Today; establish Today first. H3 reverse expected lower Settings focus despite Sidebar's explicit persistent opener outside that window. |
| Fixture: missing environment/roster inputs | 3 | Skill Recorder needs desktop + macOS capability inputs. Group roster in a numbered epoch needs recordEpoch/recordSeq and a consistent roomClock; without them the real reducer drops the row. |

No assertion was weakened, skipped, removed or given a larger timeout. H3 reverse changes *which target* is asserted: exact `New or share.toBeFocused()` replaces the lower-container boolean only in that direction. This preserves the required explicit opener return (BF-8 permits a reachable opener outside the resumed window), while retaining both paint-rank comparisons, exact remaining owner and the other direction's focus assertion. B6 still asserts Today and now actually starts there. Native crash/retry/cancel/external-unmount assertions are unchanged. Help waits for `[data-help-panel]:not([data-help-frame])`; approval still requires a pointer hit in the real sheet within the existing timeout.

The Skill Recorder row supplies a renderer-only `muragebox` capability fixture before App mounts; it invokes no real IPC or recorder and does not change production capability gates. The real App, provider, reducer, group views and eight native components remain mounted. Group rows additionally assert roster admission and the selected id before driving call/find. No server, cloudflare or electron implementation was edited.

New mounted regression names (abbreviations used below):

- **N-warm** — `native-layers.dom.test.ts`: `R3b native warm crash does not invoke browser return before replacement commits StrictMode=%s` (false/true). A scoped browser-close shim records actual pre-show focus, focuses the native control and models native close restoration. The ordinary harness omits this browser behavior.
- **N-passive** — same file: `R3b native passive show returns past the browser loading-wrapper target`, mounting actual EngineSignInDialog through a held LazyOverlay.
- **Details** — `layer-slot.dom.test.ts`: `R3b closed details excludes content even when Chromium reports its layout boxes`, mounted nested details with nonzero rectangles.
- **Export** — `additional-modal-layers.dom.test.ts`: `R3b Sidebar export preserves the New or share opener after its menu unmounts`, mounted Sidebar and its real menu/cover.

Executed red evidence before product edits: `pb-round3b-red.log` (native warm, passive and details fail); `pb-round3b-sidebar-red.log` (Sidebar exact opener focus fails). StrictMode warm adds coverage of replay after the initial red reproduction. Native browser behavior is modeled for local regression purposes; only the shepherd's Chromium rerun can validate actual top-layer behavior and animations.

| # | Failing row name (exact from shepherd log) | Cause | Fix: file and symbol | New mounted jsdom test |
|---|---|---|---|---|
| 1 | B2: held Settings resolves below empty and reopened palette without stealing focus | spec: captured settings id before palette commit | `src/e2e/pullback-layers.human.spec.ts`: B2 registration wait | — (spec/fixture only) |
| 2 | B4: real Memory native cancel and nested native showModal order preserve Settings | spec: duplicate Memory launcher | `src/e2e/pullback-layers.human.spec.ts`: B4 auxiliary-scoped locator | — (spec/fixture only) |
| 3 | B5 / R22-RESUME: Help beside Settings keeps focus and Escape returns to Help tab | spec: transient HelpFrame opener replaced by loaded Help | `src/e2e/pullback-layers.human.spec.ts`: B5 loaded panel wait | — (spec/fixture only) |
| 4 | B6: Routines loading cover paints below Settings and dismisses to Today | spec: Calendar entered from chat | `src/e2e/pullback-layers.human.spec.ts`: B6 Today origin setup | — (spec/fixture only) |
| 5 | H3/B7: equal-kind Team library and Settings agree on paint and Escape, reverse=true | spec: explicit Sidebar opener is outside Settings | `src/e2e/pullback-layers.human.spec.ts`: H3 reverse exact opener assertion | — (spec/fixture only) |
| 6 | R22-DETAILS / BF-22: Chromium Tab agrees with the shared resolver for closed and nested details | product: folded content included in resolver | `src/lib/return-focus.ts`: usableFocusTarget/inClosedDetails | Details |
| 7 | R23-NULL / BF-3 / R22-RETURN: Sidebar export dismiss | product: removed menu item captured as opener | `src/components/Sidebar.tsx`: Sidebar team-export LazyOverlay.opener | Export (cover); N-passive (loaded handback) |
| 8 | R23-NULL / BF-3 / R22-RETURN: Sidebar export reject | product: removed menu item captured as opener | `src/components/Sidebar.tsx`: Sidebar team-export LazyOverlay.opener | Export (cover); N-passive (loaded handback) |
| 9 | R23-NULL / BF-3 / R22-RETURN: Sidebar export load | product: removed menu item captured as opener | `src/components/Sidebar.tsx`: Sidebar team-export LazyOverlay.opener | Export (cover); N-passive (loaded handback) |
| 10 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native export warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 11 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native export warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 12 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native export warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 13 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native export warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 14 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native shortcuts warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 15 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native shortcuts warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 16 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native close-project warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 17 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native close-project warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 18 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native close-project warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 19 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native close-project warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 20 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native end-project warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 21 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native end-project warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 22 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native end-project warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 23 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native end-project warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 24 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native bundle warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 25 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native bundle warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 26 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native bundle warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 27 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native bundle warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 28 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native whats-new warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 29 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native whats-new warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 30 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-link warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 31 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-link warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 32 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-link warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 33 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-link warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 34 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-signin warm=false StrictMode=false crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 35 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-signin warm=false StrictMode=true crash retry and final return | product: final focus stranded on browser wrapper (inactive opener) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.show/captureReturn | N-passive |
| 36 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-signin warm=true StrictMode=false crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 37 | R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native engine-signin warm=true StrictMode=true crash retry and final return | product: intermediate browser return (expected 0, got 1) | `src/lib/native-dialog-layer.ts`: useNativeDialogLayer.retire/show | N-warm |
| 38 | R22-OWNERS: actual App page-skill-recorder cover activation, focus, upper owner and dismissal | fixture: remote browser lacks macOS desktop capability | `src/e2e/pullback-layers.human.spec.ts`: beforeEach capability input | — (spec/fixture only) |
| 39 | R22-OWNERS: actual group call cover dismiss ends only that call | fixture: unnumbered group rejected in numbered epoch | `src/e2e/pullback-layers.fixture.ts`: PullbackFixture /api/bots roster; spec group admission/selection waits | — (spec/fixture only) |
| 40 | R22-OWNERS: actual group find cover retains its owner and returns | fixture: unnumbered group rejected in numbered epoch | `src/e2e/pullback-layers.fixture.ts`: PullbackFixture /api/bots roster; spec group admission/selection waits | — (spec/fixture only) |
| 41 | R22-OWNERS: actual approval-sheet first focus, palette handback and close policy | spec: hit sampled during sheet entry animation | `src/e2e/pullback-layers.human.spec.ts`: paint polling | — (spec/fixture only) |

Round 3b validation: **200/200** tests across 12 renderer/focus files passed (`pb-round3b-dom.log`), including every jsdom file touched this round and the retained layer regression suites. The final closed-details self-focus assertion also passed (`pb-round3b-details-final.log`). **28/28** source/record audits passed: the 23 contract audits in `pb-round3b-audit.log`, plus the five closure audits rerun in `pb-round3b-audit-final.log` after clarifying the ledger's local browser status. `node node_modules/typescript/bin/tsc -b` passed (`pb-round3b-types-final.log`); `node scripts/ci-test-tiers.mjs check` passed (3492 files, 2005 gate / 1487 extended; `pb-round3b-tiers.log`). `git diff --check` passed. No new locale keys or shipped copy. All changes remain uncommitted on `fix/1018-pullback`. No Chromium, network, push, live app/data access or server/conversation verification was performed. All 41 failures have a proposed correction; actual browser closure remains pending the shepherd rerun, especially native top-layer restoration and animated pointer hits.


## Round 3c

BF-24 through BF-26 implement BUILD-FIX lines 149–166 and the file-reading Grok r24 findings. Earlier rounds remain intact. The calendar inventory now has ten surfaces; WebhookEditor is an additional page owner. No new shipped strings or locale keys.

| BF | Status | Test name(s) | Source file and implementing symbol |
|---|---|---|---|
| BF-24 | red then green mounted DOM; browser not run | R24-H1 routine-watch inventory, reverse Settings order; R24-AUDIT BF-24 c shortcut | `src/components/RoutineWatchPicker.tsx`: RoutineWatchPicker/propose; `src/components/RoutineCalendarPage.tsx`: RoutinesPage shortcut guard |
| BF-25 | red then green mounted DOM; browser not run | R24-HANDOFF BF-25 quick More options under none/window/palette | `src/components/RoutineCalendarPage.tsx`: QuickComposer More options; RoutinesPage shared CalendarLifetime opener passed to EventEditor |
| BF-26 | red then green mounted DOM; browser not run | R24-H1 BF-26 webhook Settings, editable Escape and return | `src/components/WebhooksPanel.tsx`: WebhookEditor |

Tests were added before implementation in `src/components/calendar-layers.dom.test.ts`, using its existing three-field tier row (description updated). `pb-round3c-red.log` records seven failures: missing Watch handles in both inventory orders, Watch allowing c to create a sheet, three quick callbacks observing the outgoing handle still registered, and the missing webhook handle. Quick focus already benefited from the retained shared CalendarLifetime; explicit release before the callback was missing. The fix keeps that original external opener path and the editor's active initial input target. The mounted swap fixture unmounts its CalendarLifetime on final close, matching the real caller. Under an empty palette the removed quick input naturally leaves body active without a focusin event; the test requires zero focus events, then exact editor title focus on activation and exactly one final opener return.

Browser rows added to `src/e2e/pullback-layers.human.spec.ts`: R24-H1/R24-AUDIT BF-24 in both Settings orders plus empty palette and c; R24-HANDOFF BF-25 under none/Settings/empty palette; R24-H1 BF-26 Settings paint, editable Escape, final return. These use the isolated PullbackFixture and renderer desktop capability input, never live app data. Chromium is not run locally and no browser paint result is claimed. The source closure audit now requires all 26 BF rows, preserving every earlier obligation.

Design amendments: BF-24 updates sections 6 and 6a (ten calendar surfaces); BF-25 sections 5a and 7b (committed silent release); BF-26 section 6 (webhook page owner). The external design files were read only, per worktree-only edits. No memory prelude tool is available and `.ijfw/memory` is absent. No network, commits, pushes, server/cloudflare/electron implementation edits, or prohibited home-directory reads.

Final local validation: **46/46 tests passed** (41 mounted calendar/webhook cases and five closure audits), using `node node_modules/vitest/vitest.mjs run --config vitest.pb.config.ts src/components/calendar-layers.dom.test.ts src/components/pullback-closure.test.ts` (`pb-round3c-final-tests.log`). `node node_modules/typescript/bin/tsc -b` passed (`pb-round3c-types-final.log`); the initial run caught two browser locator HTMLElement/SVGElement typing errors, corrected with explicit button types. `node scripts/ci-test-tiers.mjs check` passed: 3492 files, 2005 gate / 1487 extended (`pb-round3c-tiers.log`). `git diff --check` passed. All work remains uncommitted on `fix/1018-pullback`. No implementation stop reason; browser execution remains pending.

## Round 3d

Read all five errors and call logs in `pb-r3d-pw.txt`, plus BUILD-FIX lines 149–166. Every failure is a fixture contract fault; no production implementation change is warranted by these failures. The Settings helper's keyboard shortcut is valid (`App` accepts Ctrl or Meta); the missing textbox is a caught render failure, not evidence that the shortcut needs replacing. BF-24/25/26 still require exactly the recorded paint, Escape, editable-field, silent handoff and opener behavior. No assertion was removed or weakened, no timeout changed, and no skip/fixme/expected failure was introduced.

| Browser row | Cause from error/call log and local reproduction | Round 3d fix |
|---|---|---|
| R22-OWNERS page-skill-recorder | At spec line 526 the expected owner list remained empty. Round 3b supplied macOS capabilities but missed the independent config gate: `/api/config` lacked `composio`, so `configReply` rejected it and the recorder remained disabled with null config. | Supply a valid connected-apps block and explicit recorder feature in the isolated fixture config; require that feature to reach the actual store before driving any row. Keep cover identity, focus, upper owner and dismissal assertions. |
| R24-H1 / R24-AUDIT BF-24 reverse=false | At line 656, `settings()` timed out waiting for Search settings. Desktop General's `/api/about-me` received the fixture's generic object, giving AboutMeSettings an undefined draft; its render exception replaces Settings with the error cover. | Serve typed About me and time-zone replies in the fixture; retain Settings paint/Escape, picker shortcut guard, empty palette order and exact Watch opener return. |
| R24-H1 / R24-AUDIT BF-24 reverse=true | Same Search settings timeout, at line 647, before opening the lower picker; same invalid desktop General response. | Same valid fixture replies; retain reverse owner ordering and all existing assertions. |
| R24-HANDOFF BF-25 under settings | Same Search settings timeout at line 684, before invoking More options; same invalid desktop General response. | Same valid fixture replies; retain zero focus events during the covered swap, editor title focus only on activation, and original opener return. |
| R24-H1 BF-26 | Same Search settings timeout at line 716, after webhook editor first focus; same invalid desktop General response. | Same valid fixture replies; retain Settings paint, editable Escape consumption, final Escape close and exact opener return. |

`src/e2e/pb-pullback-responses.ts` supplies the exact reply objects shared by the HTTP fixture and local regression tests. `window-layers.dom.test.ts` now checks config admission/recorder enablement and mounts actual desktop Settings through LazyOverlay, waits for General replies, and asserts the search, About me content and loaded container survive. Before fixing replies, both new tests failed (`pb-round3d-red.log`): the connected-apps validation error and AboutMeSettings' undefined draft exception/missing search reproduce the two causes independently. After fixing replies, **53/53 tests passed** across window-layers, calendar-layers and pullback-closure (`pb-round3d-green.log`), using `vitest.pb.config.ts`. The type-checked About me/time-zone shapes also prevent accidental generic responses for these routes. These are fixture fixes, not a claim that arbitrary malformed production responses are covered by this lane.

Tier check passed: 3492 files, 2005 gate / 1487 extended (`pb-round3d-tiers.log`). No keys or shipped strings added. Previous rounds remain uncommitted; branch is `fix/1018-pullback`. No browser/network run, push, commit, live-data access, prohibited home reads, or server/cloudflare/electron implementation edits. The requested memory tool is unavailable and the worktree has no `.ijfw` directory. Browser closure remains pending the shepherd's isolated Chromium rerun; no implementation stop reason.

Final Round 3d checks: `node node_modules/typescript/bin/tsc -b` passed (`pb-round3d-types.log`); `git diff --check` passed. All five closure audits passed again after the record append (`pb-round3d-record.log`).

## Round 3e

Cause: all three BF-25 failures in `pb-r3e-pw.txt` are the same EventEditor render crash, not an accessible-name mismatch. Round 3d added `composio` to `pbConfig`, so `configReply` now admits it into state; the fixture still has no `box` block. Previously config admission failed and config remained null. `state.config?.box.configured` only guarded config, so More options now throws while reading `configured`. The editor's actual accessible name remains `New routine`.

Product fix: `src/components/RoutineCalendarPage.tsx` now reads `state.config?.box?.configured`, treating an absent cloud configuration as unavailable. The fixture and browser spec remain unchanged. The mounted BF-25 regression in `calendar-layers.dom.test.ts` now uses the exact admitted `pbConfig`. Before the source fix all three variants (none/window/palette) failed with the same TypeError at EventEditor (`pb-round3e-red.log`). Afterward all three pass. Existing assertions remain intact, including zero focus events beneath a higher layer, silent Quick release, editor first focus, and exact opener return. Added explicit assertions for dialog role/name, Quick removal, and the opener not retaining focus.

Local verification: `node node_modules/vitest/vitest.mjs run --config vitest.pb.config.ts src/components/calendar-layers.dom.test.ts src/components/window-layers.dom.test.ts src/components/pullback-closure.test.ts` passed 53/53 tests (`pb-round3e-green.log`). `node scripts/ci-test-tiers.mjs check` passed: 3492 files, 2005 gate / 1487 extended (`pb-round3e-tiers.log`). No assertions removed or weakened, timeout changes, or skip/fixme/expected-failure annotations. No keys or shipped strings added. Browser rerun remains with the shepherd; local mounted evidence does not claim Chromium verification.

All changes remain uncommitted on `fix/1018-pullback`. No network, live app/data, prohibited home reads, or server/cloudflare/electron implementation edits. The requested memory prelude tool and worktree `.ijfw/memory` are unavailable.

Final Round 3e checks: `node node_modules/typescript/bin/tsc -b` passed (`pb-round3e-types.log`); `git diff --check` passed.

## Round 4 (Astra r3 fix pass)

Astra r3 on ca30fa221 was BLOCK (2 High, 7 Medium, 1 Low, plus a scope Medium). Every item is fixed in this lane; each fix has a test that fails on the code before it.

1. High 1, clean checkout: this record is now committed under docs/verification and `pullback-closure.test.ts` reads it from here. The round notes are no longer a test input.
2. High 2, Sidebar target Esc: the create menu (Sidebar.tsx) and the New chat filter (SidebarNewChatPanel.tsx) ask `canHandleLayerEscape` first, so an open layer (the unresolved palette among them) keeps its Esc and an already prevented Esc is left alone. Tests: additional-modal-layers.dom R5-HIGH2 (menu and chat views, plain and prevented Esc).
3. Medium 3, BF-8 pending acquisition: `captureReturn` lets a resumed layer that never took its first focus take it, even after a usable return; keepFocusOnClose, native, foreign-modal and skip-return exits still win. Tests: focus-trap.test R5-M3/BF-8.
4. Medium 4, BF-6/BF-13 native close and reopen: `useNativeDialogLayer` has a hook-owned `close()` that retires the registration before the node closes; `show()` retires a registration whose node already closed; close events are bound to their activation. MemoryLauncher uses the hook close. Tests: native-layers.dom R5-M4 with queued close events.
5. Medium 5, visibility: `usableFocusTarget` drops computed visibility hidden and collapse, and the Tab wrap moves on when a candidate refuses focus. The DOM shim no longer hides visibility:hidden boxes. Tests: layer-slot.dom R5-M5, focus-trap.test R5-M5, Chromium R5-M5.
6. Medium 6, BF-12 Revoke: the CompanionSection test asserts Cancel has focus right after mount, with no test-arranged focus, and a higher-owner case asserts no focus event reaches Cancel.
7. Medium 7, round 2b mounted coverage: channel details and manage members return to the supplied trigger; Sidebar Hire from the vanishing chooser starts in the job box and returns to New or share; the Done card Hire row opens Hire and returns to the row; Chromium drives Hire (first focus, Enter writes a line, Tab and Shift+Tab wrap) and the approval sheet (Tab and Shift+Tab wrap).
8. Medium 8, BF-3 custom loading fallback: LazyOverlay puts any caller loading content inside the attached dismissible shell (registered owner, Close, Esc); only an always-cover null shows nothing. Tests: lazy-overlay.dom R5-M8.
9. Low 9: licence headers on lazy-overlay-contract.test.ts, pullback-layers.config.ts and the fixture replies file, renamed to src/e2e/pullback-layers.responses.ts.
10. Scope Medium: SMALLS-1019 and SMALLS-1020 hunks were taken out of the 1.0.18 lane by restore commit 1396158e2 (FIX-LEDGER PULLBACK-SMALLS-RESTORE).
