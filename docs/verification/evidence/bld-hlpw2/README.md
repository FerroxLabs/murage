# bld-hlpw2 — OPEN

The full protected desktop workflow is **not qualified or enabled**. This round integrates password completion into the real host, action, held-request, client, journal and recovery boundaries, verified with fakes. Production still lacks the trusted native owner/capture/input adapter, dedicated authenticated HTTP routes, renderer mounting, independent clipboard retention and packaged OS qualification. Missing dependencies fail closed. No claim is made that R1–R12 are all closed.

Baseline: `0d7d9e0f79bff3f205917b170060d584a0d70c9e`. The required initial fetch and fast-forward reported “Already up to date.” The resumed turn found a clean worktree at the interrupted run’s already-pushed `18cdcad16803ce5e50abcd9bf40356261e040ce7`, retained it in full, and fetched/fast-forwarded again (already up to date). No partial changes were discarded.

Requirements: `/work/build/des-hlf6/DESIGN-HL-USERPW.md` and its winning AMEND 5 in `/work/build/des-hlf6/REVIEW-HLPW-d1.md`. The memory prelude tool was unavailable and `.ijfw/memory` was absent. No subagents were used. No Mac, real HighLevel account, billable service or live application data was accessed.

## Changes

- Separate password-free tool/review and complete provider schemas. Preserve all supported optional fields, including a narrowly allowed reviewed profile-photo HTTP(S) URL. Keep shared credential, identifier and destination restrictions intact. `schemas/common.ts`, `manifest-data.json` and provider-manifest data are unchanged.
- Freeze an explicitly incomplete `desktop_password` template. Its digests cover only non-secret reviewed bytes and the completion requirement. Generic approval, policy approval and generic transport refuse it. Only an exact action/digest/turn/expiry-bound nonce-bank envelope can approve an action. Secret capabilities stay outside action/recovery journals and serialization.
- Force exact review in the host even under No limits. Require an explicit trusted server owner/protection dependency; production supplies none. Check trusted company, account type, role and singleton connected location before preparation and again after transport waits. The existing sole journaled mutation boundary performs the POST; no route-level provider call was added.
- Acquire the SQLite company/normalized-email claim before scoped inventory checking. A unique live owner can release only an unsent claim. Record the durable barrier before dispatch. Another action/RPC can perform a bounded scoped lookup but cannot acquire another sender. Empty/partial/contradictory recovery stays uncertain and never permits a resend.
- Consume the password after waits and authority checks, insert only that field, validate the complete body, disable redirects and send once. Zero transport buffers and drop references in `finally`. Suppress all provider refusal prose; reject literal and encoded echoes, including fully percent-encoded and nested encodings in otherwise valid identities. Release only validated non-secret identity/effect data. Remove provider-controlled identity-key logging.
- Carry completion metadata to both review presentations and disable generic Allow there. Rule B is preserved: reviewed values render in full in the existing scrollable view; no silent clipping was introduced.
- Fix the hlf6 `it.each` regression: invalid identifier arrays are wrapped in object rows, so Vitest passes each complete value instead of spreading its elements.
- After resuming: remove production Crashpad import/startup and the helper that starts it. Legacy dump discovery/export remains available for older files. The desktop source guard now rejects local-only crash reporting too. This prevents Murage from opting into Crashpad; it does not prove server core/heap/diagnostic dump prevention or OS crash behavior.
- Recheck owner authority after drain, after native protection and before copy. Keep the fence across pending native protection, pending copy, asynchronous disposal and clipboard retention. Failed disposal/clearing, owner loss during copy and uncertain copy receipts stay fenced. The independent native clipboard helper must return a non-secret clear/replacement acknowledgment for each copy; boolean success is insufficient. No native helper is supplied or inferred from this protocol.
- Bind dialog opening to each effect’s cancellation state. React StrictMode’s discarded protection request cannot replace the current lease or regenerate its secret.
- Record the design's explicit frozen-contract amendment. Historical F0.1/F0.2 checks normalize only exact pinned declaration/hash changes from four approved surfaces; unrelated drift still fails their original digests. The current full freeze remains independently checked.

The historical checks also needed the already-landed `93ffcee3d` common identifier-array hash amendment. Normalizing the parent snapshot's manifest alone reproduces the failing historical F0.2 digest `22b34d43ff42b5d56dce39c22733a610094f8e50acf7f8dc6888dabb500670d5`. The test helper accounts for that exact known common-schema hash; the common guard source is unchanged.

## Acceptance status

“Partial” means the complete requirement remains OPEN. Backend and helper evidence does not establish native or packaged behavior.

| R/M | R status | Mutation scope |
|---|---|---|
| 1 | Partial — real host/schema/template flow tested; protected production desktop flow absent | 1 tool-password variant killed |
| 2 | Partial — exact completion, company binding, nonce, authority and one POST tested; authenticated route/native session proof absent | 4 held/client company and nonce/post-wait variants killed |
| 3 | Partial — host policy, generic approval, nonce binding, renderer Allow and post-wait coordinator authority checks; native bot input/capture admission absent | 10 owner/policy/Allow/envelope/proof/coordinator variants killed; final resumed results below |
| 4 | GREEN — generator and exact custom validation | 3 generator variants killed |
| 5 | Partial — isolated dialog lifecycle and StrictMode stale-lease handling; application mounting absent | 3 persistence/auto-close/stale-effect variants killed; final resumed results below |
| 6 | Partial — unsupported copying fails closed, accepted ownership receipts retain the bot fence through close, failed/uncertain writes quarantine access; no independent native retention helper | 3 unprotected-copy/early-release/uncertain-write variants killed; OS expiry/newer-content/native death variants unqualified |
| 7 | Partial — real client/host response projection, echo rejection and fixed errors; full desktop sinks absent | 3 helper/client echo and diagnostic-key variants killed |
| 8 | Partial — atomic claims, actual host journal/restart, race and interrupted settlement tested; complete process-crash/UI matrix absent | 2 atomic-claim and dispatch-barrier variants killed |
| 9 | Partial — scoped inventory and conservative recovery tested; production route and complete crash matrix absent | 2 partial-inventory and empty-recovery variants killed |
| 10 | Partial — v2 positive controls and real host action/approval/recovery/SQLite scans, before close and across restart; whole-app instrumentation absent | 1 opaque-secret serialization variant killed; full app wire-journaling mutant unqualified |
| 11 | Partial — production Crashpad startup removed; coordinator awaits pending protection and asynchronous disposal; server dumps/native capture/input/forced-crash qualification absent | 4 coordinator/startup variants killed; forced OS crash/capture variants unqualified |
| 12 | OPEN — no isolated packaged macOS/Windows/Linux password workflow or five-second UX evidence | 2 jsdom variants killed; packaged variants unqualified |

## Verification

All test and typecheck executions use `/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=bld-hlpw2`, the requested `IT_W`, the requested `IT_ORIG`, and network disabled. The job wrapper waits while build host's one-minute load exceeds 60. At most two owned containers run concurrently. Concurrent checks use separate remote machines/filesystems so mutations cannot alter a running verification suite.

RED evidence precedes the corresponding implementation: the initial template tests failed 11 assertions; the host tests failed review/admission/uncertain-outcome assertions; review metadata and optional-photo tests failed; the unbound-envelope, provider-key diagnostic and encoded-identity regressions failed before their fixes. Later coverage additions are not represented as independently recorded RED runs.

The first mutation attempt lacked Vitest in the local fallback. Those failures are infrastructure errors and are not kills. Its logs are retained separately. All 28 executed variants were subsequently killed against green baselines; restoration hashes match the current implementation. The mutation runner now refuses a missing runner or non-green baseline, records source hashes, runs serial mutants, restores each source in `finally`, and verifies restoration hashes.

The F6 isolated server fixture uses the shared verification launcher and explicit-URL Doctor. Its URL, PID, temporary data directory, log path, command, Doctor result and server log are preserved. It proves server readiness, not the unimplemented password HTTP/UI workflow.

Pre-interruption GREEN checks: 15,810 Vitest tests across 58 files, 21 focused contract checks, 5 Electron coordinator tests, and the complete typecheck (`tsc -b`, server, and Flux conformance). All 28 executed mutants were killed after green baselines. The earlier full-suite failures and failed runner attempts are retained rather than presented as successful evidence.

Final check results and external evidence hashes are recorded in `/work/build/bld-hlpw2/evidence/`. [English copy inventory](COPY-REVIEW.md).

## Remaining integration boundary

Do not install a `desktopPasswordOwner` callback based on surface headers, renderer assertions or cloud identities. It must authenticate the desktop session and immutable direct-owner ancestry, establish native protection, fence and drain all bot reads and input, and enforce Stop/access loss before any form or nonce. The production runtime still applies its existing read-only grant adapter and has no completion dependency. `HighLevelSetPassword` remains unmounted; nonce/body helpers do not install routes. Native Copy/Cut/context-menu/selection/drag bypasses and server core/heap/diagnostic dump prevention remain unresolved. Production desktop modules no longer initialize Crashpad. Copying must remain closed without independent ownership-aware expiry through main death, quit and suspend, plus history/sync exclusion.

The intended persistence boundary excludes OS swap/hibernation, external clipboard managers/capture and deliberate owner sharing. No universal memory-erasure or non-persistence claim is made: JavaScript strings cannot be reliably overwritten. Packaged macOS verification was not attempted under “never touch the Mac.” Human copy approval remains outstanding.

## Resumed verification

New RED logs record four coordinator authority/teardown failures, the existing Crashpad startup, clipboard retention acknowledgment and failed-clear handling, React StrictMode’s stale lease, and the owner-loss fence regression. All were followed by GREEN fixes. Additional coverage for uncertain writes and renewed receipts was added during implementation and is not claimed as separately recorded RED.

Resumed broad GREEN: **15,825 tests across 59 files**, including all HighLevel contract/freeze/recovery and leak guard v2 checks, the isolated server fixture and the hlf6 object-row `it.each` regression. **Full typecheck passed** for UI, server and Flux conformance. Final desktop/coordinator/clipboard neighbour checks: **24/24**. Main, coordinator and mutation script syntax checks passed. The final mutation runner used fresh green baselines and killed **38/38 executed variants**; all source restoration hashes match. A preceding 37-variant run is also retained. These counts qualify only the implemented backend/helper, isolated dialog and desktop startup source boundaries; they do not close the missing native/package mutants.

Evidence: `/work/build/bld-hlpw2/evidence/resume/` contains raw RED/GREEN logs, final baselines, 38 variant logs/results, source hashes, fixture URL/PID/dataDir/Doctor/server log, commands and machine-readable status. The post-typecheck final change was confined to the `.mjs` coordinator’s owner-loss quarantine plus its Node regression and mutant; the typed UI/server/conformance sources are unchanged from the passing typecheck. Copy inventory adds no new product strings for this resumed patch.

The production enablement request is still OPEN. This patch supplies no native capture/input adapter, independent clipboard implementation, authenticated completion routes, renderer mount or full-access grant runtime. Owner loss in the uninstalled coordinator conservatively quarantines bot access rather than claiming an implemented native/UI revocation handshake. Complete forced process-crash/clipboard-expiry/leak instrumentation and packaged macOS/Windows/Linux/five-second UX qualification remain absent. No real HighLevel account or live data was used, and the Mac prohibition was respected.
