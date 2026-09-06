# Murage takeover state

Goal: all five approved stages. Status: active; programme incomplete.
2026-09-06 checkpoint:737e4ae137db7b3659b805f587f35316ee516fb6
(chore:checkpoint Murage stabilization) committed and pushed to private origin
codex/murage-reliability under Sean's new publish authorization. Main unchanged,
no release published. This is explicitly unaccepted/WIP, not integration approval.
Unrelated AGENTS.md,DESIGN.md,.ijfw/.codex state and bulky evidence snapshots
were excluded from commit and preserved. Automatic post-commit critique omitted
because it conflicts with the frozen two-round policy.
Sean explicitly confirmed this primary conversation is Astra medium. Execute
inline and reuse existing Astra worker; old CLI/new-worker blockers do not block
implementation. Root owns connector transport+integration tests; existing Astra
worker owns capability registry and index/routine production wiring.
Sean now authorizes finishing and publishing Murage, including necessary push/
release steps once required gates pass. This supersedes earlier no-publish/no-push
boundary for Murage only; unrelated production/networking/data protections stand.
No publication has occurred. Do not publish known failing or unverified required
release outcomes merely to meet the requested date.
## Active package — internal-turn identity (Task26 row36)

Independent Task19 Inspector-read bound: source countLines scans entirecoldfile
or appendedgrowth synchronously before existing8MiBtail. Frozen outcome perfile
perrequest<=8MiBcounting+8MiBtail, preserve exacttotals only when fullycounted,
recentvalidrecords available, sourcebytesunchanged. Add optional totalComplete
runtime/native booleans to InspectorPage with explicitbackendvalues; UI marks
incompletecounts and preservesflags through liveupdates. Sourceeventhistory is
not deleted; no storage/APIendpoint migration. Scope server/thread-events.ts/test
(Astra worker), InspectorPanel.tsx,src/lib/inspector.ts/test and one existing
desktop-capabilities browserfixture case(root). R1 notstarted. Frozen checks:
pnpm exec vitest run server/thread-events.test.ts src/lib/inspector.test.ts;
pnpm typecheck; pnpm exec playwright test --config .planning/isolated-browser.config.ts
--grep 'Inspector marks bounded counts'; oldbackend byte-read negativecontrol.
Measure cold/growth readSyncbytes,partiallines,rotation; rendered countlabel at
390px with nooverflow. Max2rounds; no reopening anyclosedpackage.
Inspector-count disposition:ACCEPTED round1.20 unit checks,typecheck and1
renderedbrowsercheck passed;390px screenshot inspected, countnoticevisible/no
horizontaloverflow. Exact oldbackend control measured21,037,150bytes against
16,777,216perfile budget before asserting any newmetadata. Temporarycontrol
source removed; logs inspector-count-round1-{unit,types,browser,control}.log.
No eventhistory deleted; no secondround/audit. This is scoped Inspector read
boundedness, not all Task19 resource/concurrency requirements.

Independent Stage5/Task19 native-trace retention: implementation assigned to
existing Astra worker, OWN server/drivers/native.ts/native.test.ts only. Outcome
new writes retain bounded recent diagnostics:64KiB encoded record,4MiB current
and one4MiB previous file perthread. These are chosen implementation defaults,
not previously proved global policy. Visible omission/retention markers, valid
NDJSON, redaction,0600creation, existingoversizedfile handling, and nonthrowing
write/rotationfailure required. Excludes canonicalevents,DB/transcript retention,
SSE,globalquotas and bounded inputserializationmemory. Frozen checks:pnpm exec
vitest run server/drivers/native.test.ts server/redact.test.ts; pnpm typecheck;
prechange writer control must show excess diskbytes, not compilationfailure.
Use fixture tempdata and interleavedthread/multibyte/imageheavy cases. R1 not
started; max2rounds; no reopened identity/recovery/clipboard/nativeMac cycles.
Task19 scoped disposition:ACCEPTED round1.23 native/redaction tests passed;
typecheck passed. Original append-only control reached3behavioral failures:
75,092-byte record vs65,536limit, absent rotation after repeated writes, and
4,195,473-byte legacy segment vs4,194,304limit. No compile/fixture failure
counted as red control. Temporary original writer removed; evidence retained
native-retention-round1.log/control.log/types.log. No second audit required.
This accepts per-thread native diagnostic disk retention only, not all Task19.

Independent Task17 packaging increment2026-09-06: build staged macOS arm64+x64
artifacts from frozen copied source in .planning/native-mac-KBGGUp/source,
using existing package:mac pipeline with --publish never. Preserve original
source and release output. Outcome: real local package build + codesign/resource
inspection, NOT publication or full native acceptance. mac Developer ID identity
is present; notarization remains a separate required gate. No real app launch,
clipboard mutation or user profile data. R1 named checks:pnpm package:mac in
staged source; codesign --verify --deep --strict on produced app bundles;
inspect architecture and shipped updater/resources. Max2 rounds. This does not
reopen identity/recovery/clipboard cycles or satisfy their failed acceptance.

Packaging live work:Windows artifact-only run34003230425 (observed running),
Ubuntu artifact-only run34003300086, both explicit FerroxLabs/murage and exact
737e4ae137db7b3659b805f587f35316ee516fb6. No release workflow dispatched.
Initial unqualified gh Windows dispatch failed during GET against inferred
upstream; no run created there. Corrected repository explicitly before dispatch.
Mac build49586 exited1 at Intel Fuigo archive fetch (Node connection timeout);
UI/server/companion/updater/Android/cloudflared stages passed and are reused.
IPv4 registry HEAD succeeded; first curl artifact fetch hit DNS timeout; second
bounded attempt with explicit known registry IP succeeded, pinned SHA256 checked.
Resume only remaining package steps with MURAGE_FUIGO_ARCHIVE_DIR cache; retain
tarball+binary digest gates. No repeated earlier builds or weakening validation.
Mac confirmation43085 exited1:codesign failed on Electron Framework locale.pak
with "A timestamp was expected but was not found." Build reached arm64 app
assembly/signing; neither complete signed distribution nor notarization proven.
Mac packaging cycle CLOSED/BLOCKED after2 rounds. Do not disable timestamps,
skip signing, or retry via another environment to reset the counter. Windows
and Ubuntu remain separate live planned native checks; no Mac reattempt pending.
Windows run34003230425 completed SUCCESS on737e4ae1, including Azure signing,
packaged resources/updater checks and real packaged server health. Artifact
windows-installer180491947bytes, archive digest
sha256:1f76b36401588057fb265185434b1baa8c9b8f36c8cccb5e47fcdc5d2cb06035.
Local export in progress90845 to .planning/windows-737e4ae1. Not Windows11 GUI,
installer-elevation/update proof or final whole-release acceptance.
Ubuntu R1 run34003300086 failed actual DEB installation:postinstall hook used
/opt/OpenMausBot, but package installs /opt/Murage. Logubuntu-737e4ae1-failed.log.
Correct only hook APP_ROOT and mismatched test-root variable; retain symlink,
owner/mode and sandbox checks. Existing hook test is Linux-only and was skipped
on Mac; add package-name regression and run that focused suite in native workflow.
Ubuntu R2 will run same full artifact/package/upgrade smoke after correction.
Linux-only correction committed/pushed bb19a25f9b126039edabc04607618536472ae3f9;
Ubuntu confirmation run34004136148 started exact commit. Local hook source
regression1passed/6Linux-only skips; native workflow runs all hook cases before
rebuilding and repeating existing native acceptance. No further Ubuntu rounds
if confirmation finds a blocker. Windows export90845 still live(gh PID81833),
not yet available locally; GitHub successful artifact retained14days.
Windows export90845 terminal exit1 after established download read timeout;
no local installer export claimed. Job results exported windows-737e4ae1-job.json;
successful GitHub artifact and its digest remain available. No blind download
restart or concurrent duplicate transfer.
Ubuntu confirmation34004136148 terminal FAILURE at AppImage update check:
"No published versions on GitHub". Hook tests, package contents, real DEB
upgrade and handed-over install command passed. Later packaged app lifecycle
steps skipped. Cycle CLOSED/BLOCKED: first-release update test requires an
existing published feed; do not publish an unaccepted build just to satisfy it.
Need explicit disposition of first-release updater proof (controlled candidate
feed before publication + real feed check afterward), not a silent skip/thirdrun.
Logs ubuntu-bb19a25f-failed.log and job.json retained.
No diagnostics artifact existed from failed run; exported failed step log retained.

LATEST DISPOSITION:BLOCKED after round2, cycle CLOSED. Confirmation sessions
63489/99280/73795 terminal:338passed,2failed,1skip; typecheck passed. Chief
group-task creation returned409 after group stop (expected201); model change
returned409 after bot stop (expected200). Likely stop/idle fixture timing, not
yet established; no further correction/check without explicit direction.
Existing acceptance also lacks successful actual-harness calls using valid
connector-kind and computer-kind grants (mount/unit proof is insufficient).
Preserve unaffected R1 passes and candidate; do not publish/integrate as accepted.
Negative controls did reach wrongbot,wrongthread,kind,forgeddepth,post-stop,
delayed-body,approval-time,create-budget,roomstop and reload authority failures.
No third audit or renamed verification cycle. Request a bounded user decision
for the two failed scenarios and missing positive calls; independent approved
programme work can advance. No publication has occurred. Release repo
currently has no releases; CI/Release/Windows/Ubuntu workflows are active.

### Verification history for this package

Implementation READY2026-09-06: registry/lifecycle/route wiring plus connector
token separation and exact-live-turn fixture updates. Added HTTP authority,
natural-completion-before-approval, concurrency/historical-receipt, room/direct
stop/model/delete/reload cases; fake Claude has per-PID natural completion gate
only in fixtures. R1 completed:615passed,5fixture failures,1skip across15suites;
typecheck passed. Failures:completed-token desktop fixture, wrong selected-task
grant in routine fixture, preexisting target message count, deliberately refused
active model change, unsupported configinstances reload request. Fixtures
corrected without production authorization changes. R2 active sessions63489
(index/desktop-authority/Claude),99280(typecheck),73795(corrected negative cases).
Reuse unaffected passing suites. Maximum2 combined rounds; no acceptance yet.
R1 old-code controls reached wrongbot/depth/stop/delayedbody/approval/create/room
authority failures; handoff/delete status differences alone are not new-effect
proof. Corrected control checks separately exercise wrongthread/kind/model/reload.
Evidence:identity-round1-{tests,types,negative}.log and round2 equivalents.
Release access read-only checks: murage-releases public and writable; required
signing/notarization/releases secret NAMES configured, values not read. Origin
main still1234d669. These checks are not a successful release/build/signature.

### Historical worker-routing blockage (resolved by primary confirmation)

All implementation/planning/verification now Astra medium, per Sean. Prior
turn delivered planning only, no identity implementation. Built-in replacement
agent launch hit thread limit. Explicit Astra-medium Codex CLI fallback also
failed before any code execution:server400 says gpt-6-astra requires newer
Codex. Installed CLI0.153.4 equals npm registry latest0.153.4; app-bundled
CLI0.153.0 is older. No global update or unsupported model/header workaround.
CLI sessions52973(registry),61167(wiring),16792(tests) all observed terminal
exit1. Logs identity-{registry,wiring,tests}-agent.log. NO workers live and
NO identity source edits. Worker inputs retained in identity-*-input.md.
Routing correction loop stopped after built-in limit + CLI rejection; needs
fresh Astra-medium agent session or supported client/model access. Do not
retry unchanged launches. Prior implementation elsewhere remains preserved.
Third consecutive blocked turn rechecked:all three built-in workers completed,
CLI still0.153.4, no identity changes. No new launch or verification attempted.
Resume in a fresh Astra-medium session with this STATE and identity-*-input.md;
do not restart accepted work or reset the frozen verification budget.
One combined package, R1 NOT STARTED, maximum2 rounds across all workers.
Existing clipboard/recovery cycles stay closed; MCP/OAuth/Composio acceptance
is scoped and preserved. No commits, pushes, releases, real providers or user data.

Outcome: internal requests use active immutable bot/thread/generation/kind/depth
claims, not a boot-wide bearer or caller-supplied identity. Preserve legitimate
approvals, accepted queued delegation drain, historical receipts and Fuigo
inheritance. Scope: registry; index lifecycle/mount/routes; request-specific
routine proposal commit check; connector token transport; focused existing tests.
Excludes approval-mode migration, peer/room features, native/recovery reopening.

Registry API frozen: InternalCapabilities({now?,orphanMs?,tombstoneLimit?});
begin(botId,threadId,generation?):string; mint(claims):string; resolve(header);
isActive(claim); bindProviderTurn(threadId,generation,turnId):boolean;
completeProviderTurn(threadId,turnId); revokeGeneration(threadId,generation),
revokeThread, revokeBot, revokeAll; reserve(claim,'create'|'handoff',limit=4)
returns {commit,release} or null. Immutable claims botId/threadId/generation/
depth/kind(agents|connectors|computer)/skillAuthoring/expiresAt. Exact minted
object identity;30day orphan ceiling; bounded thread+turn tombstones; shared
generation budgets count successful creates/admitted handoffs, not rejections.

Acceptance: wrong bot/thread/kind/depth and expired/terminal bearer deny without
effects; after-body/approval/connector/longpoll awaits revalidate; fast completion
before bind cannot retain authority; stale generation cannot revoke replacement;
stop/delete/model/task/reload/shutdown/group members revoke before teardown;
4-create/4-handoff concurrency budget; fresh legitimate turn reads old receipts;
Claude resume rotates mounts; Fuigo inheritance preserved; no token leakage into
renderer/config/SSE/diagnostics. Behavioral controls must reach target assertions.

Frozen combined checks (Node24 via rtk proxy pnpm exec vitest run):
server/internal-capabilities.test.ts server/index.test.ts server/comms.test.ts
server/routine-requests.test.ts server/desktop-authorization.test.ts
server/delegations.test.ts server/turn-dispatch-guard.test.ts
server/drivers/claude.test.ts server/drivers/acp/acp.test.ts
server/drivers/acp/fuigo.test.ts server/drivers/agents-proxy.test.ts
server/connector-proxy.test.ts server/composio.test.ts
server/composio-identity.test.ts server/redact.test.ts; then pnpm typecheck.
No verification before implementations/fixtures settle. R1 correct only
change-induced acceptance failures/evidenced blocking High/Critical. R2 confirm
and decide ACCEPTED or exact BLOCKED; no extra audit/counter reset.

## Current execution — 2026-09-06 parallel Task26 increments

Three bounded lanes; Astra owns planning and verification decisions. Max two
verification rounds per lane across all agents; no recovery/Composio restart.

- MCP reserved environment: implementation in registry/parser + Claude/Codex/ACP
  direct mounts. Custom MURAGE_*, MURAGEBOX_*, ELECTRON_RUN_AS_NODE, DWEB_URL,
  PH_ANDROID_SERIAL names rejected case-insensitively; built-ins and ordinary
  user variables preserved. Round1 six frozen suites:284 passed/1 skipped;
  isolated guard-disabled control:17 expected failures. Joint round2 typecheck
  passed; Astra ACCEPTED scoped MCP increment. Full internal-turn lifecycle open.
  Evidence:mcp-reserved-round1.log, mcp-reserved-round1-negative.log. No correction.
- Pending OAuth UI: Check status without cached URL, Continue with cached URL;
  pending alias hidden; unreadable inventory preserves accounts and blocks
  connection writes until authoritative recovery. PluginsPanel and its existing
  browser fixture only. Round1:6 unit +5 browser passes, screenshots reviewed.
  Evidence:oauth-pending-round1-unit.log, oauth-pending-round1-browser.log.
  Shared round2 typecheck passed; Astra ACCEPTED scoped OAuth UI increment.
  No OAuth correction; no live service proof claimed.
- Clipboard upstream eb1b4abc: root owns native Paste helper/wiring, clipboard
  items-first/files-fallback intake and errors; browser worker owns separate
  clipboard.human.spec.ts/config; native worker owns opt-in fixture only.
  Preserve native text/selection behavior, reject unsupported images/responders,
  upload once and retain delayed uploads in their originating task draft.
  Astra approved bounded useComposerDraft attachment-setter correction: persist
  synchronously from captured store/id before React publication, including after
  unmount. No optimistic preview/upload pipeline or payload IPC expansion.
  Frozen checks:node --test electron/paste-menu-item.node-test.mjs;
  pnpm exec vitest run src/lib/composer-attachments.test.ts server/drafts.test.ts;
  pnpm exec playwright test --config .planning/clipboard-browser.config.ts;
  pnpm typecheck. All via rtk proxy with Node24. Round1:7 menu,26 unit,
  9 browser checks passed. Joint typecheck failed on new DOM-only DataTransfer
  type used by the server build; structural interface corrected. Astra also
  confirmed introduced mounted-attachment loss when storage denies writes;
  corrected with captured per-draft memory fallback and added one precise
  browser/unit regression. Round2:27 unit +10 browser checks and joint typecheck
  passed. Reuse unaffected menu/MCP/OAuth evidence. Original delayed-unmount
  negative control failed fixture startup before its behavioral assertion;
  NOT a valid red control. Log:clipboard-round2-negative.log, retained trace:
  clipboard-round2-negative-trace.zip. Browser screenshots inspected for
  content/errors/draft counts only (unstyled fixture, not product styling proof).
  Native fixture syntax check passed. Astra disposition:BLOCKED on missing
  behavioral negative control and actual native Cmd-V/context-menu/Finder proof.
  Round2 CLOSED; no third exploratory review or corrective rerun without direction.
  Native Cmd-V/context-menu image and Finder-file acceptance remains pending;
  no real clipboard writes until requested user permission is answered. Native
  command after explicit permission/manual interaction:
  pnpm exec electron scripts/smoke-clipboard.mjs --allow-native-clipboard --case=image.
  Syntax-only node --check scripts/smoke-clipboard.mjs does not mutate clipboard.
  Finder remains separately unverified. Helper/browser proof is not
  native application proof. No credentials/providers/real user data in fixtures.

Next:Astra's selected row36 internal-turn identity chain: capability registry
and lifecycle wiring, followed by claim-based internal-route authorization,
under the existing combined acceptance gate. No peer/room tools or approval
mode expansion; do not reopen accepted MCP/OAuth/Composio or recovery lanes.
No third audit. Whole Task26/goal incomplete.
No commit/push/release/main change. Local checkpoint permission unanswered.

## Previous completed increment

2026-09-06 disposition:ASTRA ACCEPTED the scoped Composio backend-identity
package after round2. Existing Composio tests/typecheck plus six identity
regressions satisfy its frozen local-fixture contract. No additional checks
or audit were performed by the reviewer. This is local implementation in the
integration worktree, not live-service/release proof or all of Task26.
Planning, verification decisions and adversarial review now route to Astra,
as Sean requested; the same two-round budget applies across agents.
Next:advance the next already-selected Task26 security item after Astra's
bounded plan; no recovery or Composio verification-cycle restart.

Current package:Task26 selected upstream Composio backend identity fix,
commit52cd9563. Frozen contract:credential/backend changes must not reuse
another backend's cached catalog or MCP transport session; valid same-backend
sessions and user-project precedence remain functional. Scope:server/composio.ts
and focused tests. Excludes OAuth UX, toolkit renaming, internal turn
capabilities, provider engines and recovery. Acceptance:identity rotation,
unknown/mismatched sessions, late response ownership and bounded eviction.
Checks:existing Composio tests plus new identity regressions and typecheck;
local HTTP/fake credentials only. Round1:26passed, one stale fixture URL
rejected by the existing HTTPS/Composio host guard; typecheck passed.
Fixture corrected without weakening production validation. Round2 confirms
only the invalidated fixture; reuse other passing checks. Stop:ACCEPTED on
planned checks or precise BLOCKED item at
round2. No live Composio calls or credential reads.

Previous cycle CLOSED:session45138 full candidate command passed, source
9c0ab3a63126164487bcf9f51476f2e89c688293fba0e8e87271997bf26c9e42.
Recovery Task15 remains BLOCKED on its recorded original unmet acceptance
items; do not expand or restart that verification cycle. Current user-supplied
AGENTS.md is controlling. Local checkpoint commit permission requested;
no commit/push/release/main change performed.

Verification constraint from Sean: maximum TWO rounds per change set; fix
only Critical/High findings during verification, including build blockers.
Record lower-severity findings; report what remains after round two rather
than extending or relabelling the same verification loop.

Current delivery boundary:see VERIFICATION-POLICY.md and RECOVERY-CLOSURE.md.
Activation build blocker corrected. Round2 typecheck,178Electron tests and real
native activation/rollback fixture passed. Final planned frozen full suite
remains in session45138 at candidate-iyOss2; read the same handle/log, do not
restart on quiet output. No more recovery audit/scope expansion in this lane.
Task15's remaining original acceptance packages are recorded explicitly;
the whole five-stage goal is not complete.
## Current authoritative update — wave 14

Fresh restored connection profiles now separate Murage encrypted credentials,
companion settings/device state and tunnel runtime files while retaining old
profiles. Both bot and named browser cookie partitions are generation-scoped.
Late cleanup admission is closed during recovery/shutdown; admitted cleanup
holds quit ownership. Headless companion state is already under DATA_DIR;
source backups omit it and external archives cannot inject it.

137focused tests,178Electron Node tests (1Windows skip), typecheck and real
native macOS recovery/cookie/preferences isolation passed. See evidence-wave14.md.
No active test session remains from this wave. Activation is STILL closed:
next is durable hash-bound review tied to the new connection generation,
then real harness no-replay startup and complete packaged/platform acceptance.
All other five-stage/Fuigo/upstream requirements remain active.

Session8030 completed exit1:5,042Vitest passed, one updater fixture failure.
Result/log retained under candidate-ztrghu; fixture corrected and targeted
tests passed, not a fresh full-suite pass. DO NOT restart/poll8030.

Confirmed disabled engines still invoked factories; fixed registry admission
and discovery with a failing control. Restores now use explicit disabled
fleets; ordinary auto discovery remains unchanged. Desktop enable/disable
API and confirm/pending/error UI implemented;105unit/config tests, two real
API checks and two browser tests passed. Native recovery fixture passed.
See evidence-wave13.md. Full server file completed exit0 in session2512:
191tests passed, log engine-enablement-server-full.log. No test session
remains active from this wave.

Restore activation remains closed pending Companion/account reconnection
admission and remaining recovery guarantees. Whole five-stage scope unchanged.

Historical full run: session8030, candidate aaf9fbee at
.planning/candidates/murage-candidate-ztrghu/source,5,975files.
Full SHA256:aaf9fbeedd19a8763afb8d12eea432eb80cf8e615f85ff961d1639a4973f5ef6.
Node24 pnpm test output: sibling evidence/full-suite.log. Terminal failure
and follow-up are recorded above; this is not an active run.

Dedicated desktop recovery window/preload and failure-only supervisor now
wired. Main/frame/ownership/writer tests passed;171Electron Node tests passed
with1Windows skip; typecheck and packaged checks passed. Real macOS Electron
window + actual delegated utility backup/inspect/inactive restore/rollback
passed with injected native-dialog responses and zero providers. Dark/light
screenshots inspected. See evidence-wave12.md for scopes and native-only
stdout/end timeout fixed with acknowledged private result messaging.
Safe activation, full packaged startup/native-dialog acceptance, other
platforms and remaining whole-program gates stay open. No current wave12
focused/native test session remains active; new full run is recorded above.

Desktop recovery controller/protocol:10Node tests passed. Delegated real
child backup/restore/rollback with primary lease retained passed; new bounded
worker and CLI source/bundle tests passed. Initial bundled worker produced
two JSON responses; separated reusable server command library from CLI entry,
then packaged harness/proxy/MCP/recovery/worker checks passed. See
evidence-wave11.md for exact next integration tasks and caveats.
No actual recovery window/main/preload wiring yet; do not call GUI complete.
No test session remains active from this wave.

Routine/calendar/webhook/delegation receipt validation is wired into archive
creation and external preparation.99integrated tests passed;17overlapping
diagnostics/real-manager tests passed after the final CLI follow-up. Negative
control:four malformed archive cases accepted when validator bypassed, all
four rejected after restoration. Final packaged harness/proxy/MCP/recovery
command passed. See evidence-wave10.md and recovery-records-*.log.
GUI/review activation and complete cross-component provenance remain open;
this did not rewrite runtime permissive loaders. No active test session is
left from wave10. Last full-suite evidence remains the frozen candidate below.

Frozen candidate576de965 completed full `pnpm test` exit0, session94327:
5,007Vitest passed/20skips/1todo;7broker passed;151Electron passed/1Windows
skip; contrast and packaged harness/proxy/MCP/offline-recovery checks passed.
Durable evidence and result.json are in the candidate directory below.
Do not poll/restart session94327; it is terminal and has been observed.

Newer live-tree schema/transcript follow-up:83focused tests passed, packaged
server/recovery command passed, typecheck passed (see evidence-wave9.md).
These changes postdate that full candidate; no latest-live-tree full-suite
claim. Runtime columns, unknown triggers, JSON/column identity, parent cycles,
legacy graphs and manifest database counts now checked. GUI/review activation,
complete component/receipt validation, native/Fuigo/upstream and Stage5 remain.

Fresh candidate `576de96533a70b927b545ab7d9680379a3364525d8d9b141c4c19dfefff41288`
contains 5,952 verified source files at
`.planning/candidates/murage-candidate-pIBHOM/source`. Full Node24 `pnpm test`
completed in session94327; log is sibling `evidence/full-suite.log`.
Dependencies reused this worktree's independent node_modules throughout.

Offline archive/restore/rollback integration: 66 tests passed, typecheck
exit 0, standalone packaged recovery smoke exit 0. Five real restore-crash
boundaries and three rollback-crash boundaries covered. Original directory
identity is checked; an external active journal blocks startup throughout
rollback, even while DATA_DIR is absent. See evidence-wave8.md and the
recovery-transaction-*.log files. GUI recovery/activation, complete semantic
validation, power-loss/native acceptance and full programme remain open.

Evidence correction: earlier frozen snapshot5e171c92 was recorded as passing
in conversation, but its temporary directory is no longer available for
reinspection. Do not treat it as current-tree proof. All "running" session
references below are historical and require live revalidation; session38368
is not known live now. New frozen candidates use .planning/candidates/ for
durable source manifests and logs. No commit/push/release/main advancement.

## Historical progress notes (superseded by update above)

Latest: private installation stage builder + one shared offline ownership
epoch implemented;15component/integration tests and typecheck passed. See
evidence-wave7.md. This is not portable archive/restore or a customer-facing
feature yet. Frozen5e171c92 full run session38368 remains live, checked this
turn; no terminal result yet and no restart issued.
Fourth frozen candidate5e171c92: /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-candidate-20260905-3Ea9oU/source,
5933files, complete SHA256 5e171c92b4e9f96e874918a4bb45b66eb117f982cad33c5e28d84ea6e98f00e1.
Full pnpm test running in session38368; sibling evidence/full-suite.log.
Includes socket-path/goal-draft/webhook/database-snapshot follow-ups. Read this
latest run before older in-progress notes below; do not restart on quiet output.
Latest progress: current server integration190/190 passed
(server-integration-cancel-barrier.log). Offline database snapshot component
implemented/tested, with WAL plain-copy negative control; not customer-facing
backup/restore. Combined recovery run session24885 is in
database-recovery-integrated.log. See evidence-wave6.md for scope/limits.
Latest frozen run completed: candidate2b3f4444 session66651 exited1 with
4921passed,11failed,20skips,1todo (361files;713.83seconds). The11failures
were10Claude deterministic socket-path cases and the shared private-room
fixture case. Socket repair passed fullClaude suite; dedicated room nowpasses.
Latest complete current server-file rerun still active as recorded below.
Latest live work after snapshot2b3f4444: goal-draft mode persistence (9unit,
14browser plus2goal-retry checks passed), webhook corruption preservation
(23tests passed), and long canonical permission socket paths (76tests passed,
one Windows-onlyskip includingfullClaudedriver suite). The frozen2b3f4444 run
has reported10Claude permission failures and one server/index failure; it
predates the socket repair and remains running through session66651. Root
current server/index rerun log: server-integration-post-owner.log. Do not
report the old snapshot as green or assume the remaining indexfailure matches
the already repaired socket issue.
Follow-up: dedicated test-read-dm fixture fixes the deleted-room dependency.
Full server rerun then passed189/190 with a connector prompt dump timeout;
both connector/private-room targeted tests passed. Added explicit cancellation
idle barrier between connector fixture turns (no timeout increase); full190
rerun active in session19141, log server-integration-cancel-barrier.log.
See evidence-wave5.md for exact newer code/tests. No full current-tree green
claim; whole goal still includes recovery UI/backup, native/live Fuigo proofs,
remaining upstream ports and original tasks19–25.
Latest continuation: see evidence-wave4.md. Worker processes from the earlier
turn are no longer live; their current source was inspected before resuming.
Config preservation wiring completed locally; 100 focused checks and six real
startup ownership/corruption checks passed. Full Electron and packaged-server
checks completed exit0: 150 Electron tests passed, one Windows-only skip;
packaged server/proxy-path/MCP smoke passed. Whole-program status remains
active, not release-ready.

Third frozen candidate: /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-candidate-20260905-etuYXk/source.
Tree SHA256 2b3f4444c4a7542ae6f4201798a4e1c98560ccdd7d7f99cde714ecd23eaa374a;
5929 source files verified before/after copying. Full pnpm test session66651 launched;
results will be in sibling evidence/full-suite.log. This includes the completed
config/migration, data-owner, SSE, operator UI and selected upstream fixes.
Worktree: /Volumes/Mando/WaylandBots/murage-astra
Branch: codex/murage-reliability
Base: b445ff373edaefdd11f75e777a7cc8c46a137cac

| Work item | Status | Progress / pending work |
|---|---|---|
| 1 Baseline | ⏳ In progress | Complete pnpm test on second frozen candidate 4f5d7e94 passed: 4867 Vitest tests, 7 broker tests, 85 Electron tests and packaged-server smoke. Full human/native gates and CI consolidation remain. |
| 2 Correctness | In progress | M01/M02/M03/M04/M05/M08/M10 implemented; integrated repairs: 648 passed, 7 skips. Private companion join: 148 targeted tests passed. Recovery UI and backup/restore remain. |
| 3 Customer/Fuigo | ⏳ In progress | Intake: 25 passed, 2 project skips; HTTP send/retry: 6 passed; goal wait: 31 passed, 1 existing TODO; HTTPS adoption: 107 passed. Pinned Fuigo 1.0.4 staged and version/hash checked; real inherited-environment tool proof still pending. |
| 4 VPS/release | ⏳ In progress | Latest installer: 114 passed. Hetzner candidate 597c1b0a passed production build and packaged-server/MCP smoke. Backup/restore contract ready. Vultr/Tailscale API access verified; no VM/device created; Windows Server availability does not prove Windows 11. |
| 5 Performance/power | ⏳ In progress | Bounded SSE/replay/client admission implementation and real TCP tests in progress; 11 unit, 3 TCP, existing 3 scope and 22 transport checks reported green. Full acceptance/negative controls pending. Other tasks 19–25 remain. |
| Upstream release reconciliation | ⏳ In progress | Added by Sean: live API latest v0.1.54, 79 non-merge commits after prior reviewed source47971da6 through that release; 3 later unreleased changes separately tracked. Windows Tailscale discovery port assigned. Full disposition ledger and selected ports remain. |

Approved sources: MURAGE-PLAN.md; /Volumes/Mando/WaylandBots/notes/murage-audit-2026-09-05/*; docs/plans/HANDOFF-ASTRA-2026-09-05.md.
Exact evidence in evidence-wave1.md, evidence-wave2.md, evidence-wave3.md and task-specific logs. The first installer run had 112 passes and 1 failure due to an unsafe real-companion fixture. Root has now independently rerun the corrected suite: 114 passed, exit 0. Public release operations remain forbidden. GitHub immutable-release server-side protection remains unverified; the helper detects publication races but does not claim atomic remote API behavior.

Hetzner buildbox authorized for build/test use by Sean. Verified SSH via tailnet: use existing hetzner-dsm identity with HostName=100.81.158.63 and HostKeyAlias=95.216.244.213. Ubuntu 24.04.4 x64, 96 CPUs, 251 GiB RAM; latest disk check: 75 GiB free (96% used), so bound scratch usage. Existing workloads remain active. Owned scratch /var/tmp/murage-build-20260905-9OpA4Y, owner sean; isolated Node 24.20.0 runtime and pnpm 10.33 dependencies ready. Do not alter existing services. Windows and macOS Intel remain separate gates. SeanDesktop is down; Vultr temporary VMs and temporary Tailscale device enrollment are now authorized. Exact credential locations and ownership/cleanup contract are in temporary-infrastructure.md; no keys printed/read into logs and no VM/device created yet.

Frozen original baseline: 341 files, 4549 passed, 10 failed, 20 skipped, 1 todo; 2030.26 seconds. Failures: five ambient-Fuigo path assertions, two obsolete untracked-team fixtures, three server/index.test.ts timing/name-isolation cases. All addressed; targeted reruns passed. This does not establish a complete corrected-suite pass.

First corrected candidate: /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-candidate-20260905-kiW3Rq/source. Tree hash597c1b0aa01bfcb008646867c21fa2384a2dfdf591963f84b0b961a92d1f7be5;5903files. Full suite completed exit1:4796passed,21failed,20skips,1todo. All21failures traced and repaired in focused runs; retain evidence/full-suite.log. Remote Linux source verified against this exact manifest; build and packaged-server-retry.log exported beside it. First remote smoke hit non-root EACCES on host/tmp; retry used our private TMPDIR without changing host permissions and passed. No remote native GUI claim.

Second corrected candidate: /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-candidate-20260905-UCWIfN/source. Tree hash4f5d7e9494a8e7613f46bdbbadefe465206d0743f9c2d7013783c2026e52c00d;5907files. Full pnpm test session86844 completed exit0:4867Vitest passed,20skips,1todo;7broker passed;85Electron passed;packaged-server+proxy-path/MCP smoke passed. Full log in sibling evidence/full-suite.log. Separate typecheck exposed5test-only errors (HTTPS JS import declaration and unknown JSON result type); both corrected in live worktree. This snapshot predates those type-only corrections, bounded SSE and fresh upstream ports. No candidate commit made.

Latest goal addition is task26 in MURAGE-PLAN.md and UPSTREAM-RECONCILIATION.md; it must be complete before final task25 handoff. User's exact progress format is Work item | Status | Progress / pending work, with ✅Done / ⏳In progress / ⬜Pending and an overall-goal row.

Original checkout and its in-flight test processes preserved. No push/publication/main advancement or live networking changes.
