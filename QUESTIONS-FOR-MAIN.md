Implementation and contract producer owner: win-sac-sign; deployment, enrollment, execution and evidence consumer owner: MAIN.
Security ruling owner: GrokBuild; existing signing identity and credential custody owner: secure administration; reserved decisions owner: Sean.

Release remains HOLD. No Windows host or cloud resource was contacted. GROK-WINSACCOL is AGREE-WITH-CHANGES, not execution or signing authority.

1. Secure administration: record the existing qualification-only signing approval and authoritative Public Trust identity/profile/publisher/issuer/EKU/timestamp/revocation/vendor policy outside Git. No such path is named in the reviewed inputs. Production signing stays blocked (rulings 1–2).
2. Sean/MAIN: confirm existing custody and distinct public keys for run authorization and extraction results, plus the separate approved authentication format/custody for observer and SAC evidence. Neither existing key may be reused for observations. A nonce is correlation only. Until this is specified, implementing a trusted observer transport or authenticated evidence producer would invent a security contract (ruling 6).
3. GrokBuild: name and accept an adapter bound to the measured Windows build for continuous SAC/Code Integrity policy identity, digest, effective enforcement, bookmarks, changes, continuity and loss. None is accepted. Two snapshots, unknown state, rollover loss, reboot or observer death fail (ruling 8).
4. GrokBuild/MAIN: demonstrate an approved mechanism that makes the signed failure process itself fail OpenProcessToken(TOKEN_ADJUST_PRIVILEGES), then produce EPOWER before any engine/job. A side token does not count. The success case uses a different fresh process. No test addon, generic preload, patch, shared-token change or power action is authorized. Slice 6 remains blocked (ruling 9).
5. Sean/secure administration: confirm only the existing extractor recipe/provenance, fresh unused OS disk, distinct audiences/subjects, minimum scopes/destinations and independent reaper authority. Name no new endpoint, signing identity, quota or resource. Approve real-engine credentials separately, outside the witness/captures (rulings 7, 11).
6. MAIN: name the already protected disposable promotion target and constrained writer. No production visibility changes; until named, promotion-both-entries stays blocked (ruling 13).
7. Sean: confirm the existing host expiry admission; no lifetime extension is inferred. Finish all captures, independent cleanup and private archive before the admitted expiry, or stop. GrokBuild accepts the later complete evidence bundle; Sean separately releases HOLD (rulings 4, 16).
8. MAIN: confirm a complete locked-build and all six vm-cleanup variants fit the unchanged 20-minute case / 128 MiB capture caps. Otherwise request a reviewed split and new plan digest; no timeout/budget increase or truncation (ruling 15).
9. MAIN: the brief says “Do NOT merge integration branches” while HOST-RULES requires an integration merge before PUSHED. This round follows the explicit task prohibition, performs no integration merge, and reports PARTIAL. Resolve before a later PUSHED handoff.

Resolved design changes: enrollment remains immutable; locked-build only rebuilds frozen inputs in its independently admitted output directory and operation nonce. The candidate-producing build precedes enrollment freeze and has distinct run/attempt identity. Witness faults never enter --assets; witness mode refuses CI and requires sealed witness enrollment. Existing witness account groups, SAC policy, signing identity, box tag and pre-existing tasks stay unchanged. Fault operations require prior exclusivity and exact PID plus creation time; an independent reaper is authoritative.

Round r implementation status: capture writing, a durable bounded resource journal,
recovery reconciliation and exact-PID/creation-FILETIME process reaping now have
portable self-checks/mutants. Native Windows checks/mutants are prepared, unexecuted.
These components do not invent observation authentication and do not complete the
operation adapters or independent supervisor. win-sac-sign retains implementation
ownership; MAIN supplies the reserved protected contracts and executes deployment.
The collector still cannot produce PASS through either collection entry.

10. MAIN/GrokBuild: provide the approved observation/SAC authentication contract,
OS-build adapter and established signed-candidate own-token S4 fault mechanism,
or identify the newer ruling containing them. Without those contracts the remaining
protected adapters cannot be implemented honestly from the supplied references.
11. MAIN: the current integration-tip comparison exposes existing release-capability
allowlist disagreements with the protected OIDC/signing/promotion pipeline. No new
permission/credential/command exemption is granted here. The lane will retain raw
paired reports and enumerate additional audit reasons outside Git; preserve HOLD
until the existing policy owner rules or supplies the reviewed audit contract.

Final r comparison against the current int-train5 tip (f9367db4a56d): 365 paired
cases, baseline 3 failures, branch 13 failures, 11 NEW capability-audit failures,
1 resolved baseline failure, no pending cases. There are 4 baseline audit reasons
and 15 branch reasons; all 11 additional reasons remain open. The audit code and
its tests are unchanged; r-comparison.json outside Git binds the reports and inputs.
This does not satisfy zero NEW and is not a base-identical-failure claim.

MAIN's policy owner must rule on the existing pipeline's exact OIDC job-permission
profiles, the eight public pin/identity environment fields in assemble, the fixed
extraction-artifact action, and the stage/download-sac guard command inventory.
No permission, credential, action, environment or command exception was added to
the strict audit in this round. Implementation owner remains win-sac-sign; policy
and protected deployment consumer owner remains MAIN, with security decisions
reserved as stated above. Release remains HOLD while these and the missing
observation authentication/SAC/S4 contracts are unresolved.
Producer owners: recall-f062b (receipt-state triage) and ta4-fix (TA4 repair record).
Consumer owner: MAIN (privacy rulings and release).

## Recall F062

Producer owner: recall-f062b (comparison and triage).
Consumer owner: MAIN (privacy ruling and release); retained-proof owner: recall-prod-y.

F062 remains blocked by the preserved receipt-state contract. Its protected marker, reader, and proof functions and every existing assertion remain unchanged; the continuation separately repairs the edited-identity frame bug described below.

MAIN RULING 1116-RECALLF062 requires the overlapping S-B session to be withheld, its durable content mark retained, and R-b to remain delivered. The unchanged complete witness reaches `server/memory/memreplay-review.test.ts:113` and sees R-b revoked.

The marker's receipt range reaches later lines (`server/memory/receipt-outputs.ts:7`), and source marks are authoritative in `server/memory/deny-read.ts:417`. The bounded bookkeeping in `server/memory/session-proof.ts:102` reads R-b's cited y-old revision; the content lookup at line 109 returns withheld/deny-memory and revokes R-b before returning the required session refusal at line 113. The preceding witness assertions at `memreplay-review.test.ts:100` prove that the marker itself left R-b delivered, with S-B's content mark and an empty audience ledger.

Please rule which receipt-content bookkeeping must preserve delivered state under this positional denial while retaining R-s revoked, both session refusals, all source/privacy denials, and every durable S-B mark. Changing the interpretation of an authoritative content denial is a privacy decision; no bypass, deletion, undo, audience insertion, marker change, or test weakening was made.

The specific continuation instruction forbids integration merges; this branch remains isolated despite the standing merge-train paragraph.

Two historical NEW identities have independent fixture counterexamples, without editing tests. The paused reader setup (`server/memory/reader-lifecycle-server.test.ts:129-132`) opens an immediate second SQLite writer against the active server without lock-wait ownership; ordinary writer contention fails before the reader assertions. The worker-crash fixture (`server/memory/controller-reliability.test.ts:112-117`) advances an unpinned fake Date into the five-second admission closing window; `server/io-budget.ts:212` correctly refuses its background publication even with unused byte capacity, and `worker-controller.ts:1590-1598` leaves attempts unchanged. These setup assumptions need producer correction; neither justifies weakening a reader assertion, bypassing admission, or raising a budget. The historical raw failures remain recorded separately from subsequent complete runs.

The historical PIP edited-commitment failure is repaired in `server/memory/bundle.ts:327`. The identity frame previously joined each prepared-view reference to its exact projected version. An owner edit supersedes that version before asynchronous view maintenance adds the replacement, leaving the next frame without the edited commitment. The bounded reference page now resolves a known identity to its latest authoritative version, then applies the existing active-state, identity-kind, bot-scope and hydration gates; DISTINCT prevents duplicate versions of the same identity from rendering twice. The new `server/memory/recall-f062b-identity.test.ts:24` witness first failed on the missing new words, then passed after the repair, including its other-bot privacy negative. The unchanged complete PIP file now passes its line153 edited-commitment assertion. Its separate engine-window parity and restart-wait failures remain visible. The exact-base comparison continues on its frozen source; it does not silently incorporate this repair.

## TA4

# TA4 audit follow-up — resolved
Owners: production and test repair: ta4-fix; approval/privacy rulings: MAIN.

MAIN ruling RULING-1116-TA4 resolves all questions from the initial build:

- R1: saved Never refuses with `site_denied`, no card and no one-use override. All eight route/answer/storage cases remain exercised; an in-flight read cannot deliver after Never and a subsequent snapshot cannot run.
- R2: automatic No limits reads have call-scoped authority. The retained subsequent-action witness moves to Ask and requires a card; its No limits twin auto-admits the snapshot independently. Both inspect empty read grants and saved state after the read.
- R3: merge the current `dev/1019-int-train5` before pushing this lane; do not merge other lanes.
- R4: replace the historical owner-deny, dry-run-push and native-protected-change mutants with current policy witnesses: explicit host refusal priority, ordinary Git dry-run admission and native patch admission after a protected alias change.

No security, approval, privacy or data ruling remains open.


Redesign Builder A producer owner: win-sac-sign-sa; CLI/observer caller owner:
win-sac-sign-sb; protected reaper installation and session admission owner: MAIN.
GrokBuild owns the reserved security rulings; Sean owns custody and resource admission.
- G-A/G-B and the version/adapter amendments in GROK-WINSACD2 are pending at API
  freeze. No audit permission allowance is added before G-A, and no separate-job
  extraction acceptance is inferred before G-B.
- Lease recovery needs authenticated lease-unknown observation, but section 1.4's
  closed observer verbs omit it. Closing an independent reaper's new pipe cannot
  close the original owning session. MAIN/GrokBuild must bind that observation and
  the original session owner to the admitted observer contract; no admin revoke
  RPC is invented. A gone service incarnation is independently measurable now;
  the live-service production path refuses R-COL(6) before effects. The complete
  lease state machine is checked with portable OS doubles outside production.
- The explicit instruction to merge int-train5 resolves earlier item 9 for this
  round. The current tip was merged into this lane, never the reverse.

GROK-WINSACD2 has now landed and was read in full. G-A is accepted with its exact
closed class; G-B requires two fresh invocation-bound jobs, not the design's shared
result. V/1.6/1.7/Option A changes belong to their respective source owners.
OPEN contract ownership: A owns release-guard, workflows and stage-gate; MAIN must
name the owner/change grant for windows-sac-promotion.mjs and
windows-extraction-contract.mjs. The latter creates a random request nonce inside
extractWindowsInstaller and currently requires running the extractor locally.
There is no invocation-bound remote-result consumer seam for the new jobs. A may
not edit these files under section 7's exact ownership. MAIN must bind the nonce,
request identity, result/archive and command purpose before separate-job evidence
can be consumed by the existing shared verifier; stage evidence must never grant
publish-prepared. G-A does not grant that missing contract. No shared-result
shortcut or local OIDC fallback is introduced. Version literal ownership likewise
needs windows-signing-authority.mjs plus promotion tests changed together per V;
A does not own either file.

Builder A native check execution requires MAIN's existing authorized Beast
transport; none is present in this lane's configuration or tooling. The native
script remains a mandatory release witness, never replaced by portable success.
MAIN must supply the transport or run the script and retain its verbatim output.
The recovery entry also needs a MAIN-installed protected recovery.json beside the
run journal, binding runNonce, scratchRoot and installRoot; no request can select
these roots. The lease-unknown verb remains unassigned by D2's closed observer
verb amendment. Live-service lease recovery therefore still refuses R-COL(6).

G-A's download fetch is specific to Windows installer assets. The existing
cross-platform download witness contains only asset.zip and stays unchanged;
new command-level checks cover the same-run Windows SAC fetch and its failure.
No existing test expectation is edited.

Protected journal boundary: the standard-user collector must append durably before
its effects, while RecoveryEntry admits only a SYSTEM/Administrators-writable
journal. Granting the witness arbitrary writes would let it select privileged
reaper targets; A does not relax that ACL. MAIN must supply the protected append
side of the collector/observer operation contract (producer A/B, protected writer
and deployment consumer MAIN). This is an unassigned implementation seam, not
permission to execute arbitrary commands or change the witness account.

A's dedicated extract-stage/extract-publish producers now retain the fresh signed
request/result/archive from the shared verifier. The result consumer remains
unassigned under the exact file ownership above. In particular assemble must not
extract locally and the stage result must not authorize publish-prepared. These
producers alone do not satisfy G-B, and A does not claim section 6 complete.

The paired full workflow run found one NEW gate-inventory failure: the requested
scripts/windows-extraction-reaper.test.mjs needs its ci/gate-tests.txt registration.
That shared file is outside section 7's exact A/B lists (A resolved its integration
merge conflict only). MAIN owns the gate inventory side; add the Linux/all-platform
entry without excluding the test or weakening classification. A runs the full
cloud suite explicitly and does not conceal the NEW failure. The earlier eleven
capability-audit NEW failures are closed; this inventory issue is separate.

# S4 retained membership and Sable witness
Owners: nolim-s4-port-b owns retained channel-turn membership and the Sable production witness; nolim-s4-port-a owns server/index.ts, narrow-denials.ts and decision-wiring/runtime-fixture.ts.

Sable uses a local test-only sable-runtime-fixture.ts with the strict fake CLI acknowledgement adapter extracted from 0c3e96a4b7. No runtime-fixture.ts change is needed for this witness. MAIN/port-a may consolidate the duplicate adapter after seating both lanes. The train implements S1 contracts, so Sable needs no legacy missing-contract stubs.

The unrelated M21/R19b mutation bundled in the old sable-server-mutant.mjs belongs to port-a's ancestor-save/spread work. This lane ports the Sable drop-producer mutant only, using fixture module loading to leave server/index.ts untouched.

The explicit lane instruction “Do NOT merge integration branches” takes precedence over the generic host merge rule; this branch remains based on f9367db4a56.

Sable adaptations retain every original assertion: resolve all relative fake-CLI imports; use a FAKE_ manifest variable preserved by the train launcher; forward the EventBus SourceContext; omit decorative fake tool-use/result frames (the unchanged full MCP permission request is the witness) so display stays inside the existing stream budget; enable the real browser capability for the three browser request shapes because the train correctly refuses disabled capabilities before No limits. No decision stubs, production hooks or raised budgets.

MAIN owns the three existing routines-tracked-save failures: inheritAllPermissions persistence parity, R5 run identity rollback (Nested full transaction), and R5 alternating owner-view creation (720 history reads). All three reproduce unchanged on f9367db4a56; this lane does not change those tests.

## 1019-WINSAC-REDESIGN fix-round disposition

Ownership: Builder A owns the journal/reaper and G-B producer/consumer changes;
Builder B owns Program.cs, collection bindings and adapters; MAIN owns protected
append deployment, native transport/execution and security contract assignment.

H1's G-B consumer is implemented in this round through the existing shared
extraction verifier. The stage and publish contexts have different nonces even
for identical installer bytes. Those nonces bind command, immutable build and
publication identities, installer digest, evidence pins and extractor lock pins.
Only the extraction-result key verifies the returned archive. The writer waits
for the separate publish job in this exact attempt and rehashes actual bytes.
The remaining reserved controller enrollment is unchanged; no endpoint, audience,
key, credential or cloud resource is created by this implementation.

H2 remains a real blocker: ResourceJournal.Open requests read/write access to the
protected file, and RecoveryEntry rejects standard-user write ACLs. No approved
protected append verb exists in the closed observation contract. MAIN must assign
and specify that endpoint, authenticating caller token, run/case/request binding,
resource incarnation and effect authorization before durable append. A general
privileged append RPC accepting caller-selected reaper targets is not a fix.
Do not grant the standard account write access, elevate it, or treat this missing
implementation as an allowed section-5 seam refusal. OPEN NO-OWNER: protected
append implementation pending MAIN's assignment of that side.

H3: Builder B's CLI dispatch, adapters and version fixture were integrated from
e4895a0886 without direct A edits to B-owned files. Both production CollectionEntry
paths still stop without constructing CaseRunner or a production measurement
binding. MAIN must coordinate that B fix before claiming section-8 completion;
this missing production implementation remains High, not a section-5 refusal.

H4's shared authority/promotion/launch and witness-pack versions now admit the
literal 1.0.19, retaining the rejected 1.0.20 and both tree/relabel negatives.
Builder B's WitnessCodec.cs and positive fixture arrived through the B merge,
never a direct A edit; all version callers now agree.

H5 remains required and unexecuted: this lane has no authorized Beast transport.
MAIN must run Native.selfcheck.ps1 for process/job/file/supervisor and the five
native mutants, retaining verbatim output outside Git. Linux container doubles
are portable evidence only. No box, signing, enrollment or cloud action is
inferred from this task. The section-8 bar and release HOLD remain unchanged.
# Sable R11: session-path redaction collision (ruling requested)
Owners: sable-redact-new owns diagnosis/fix/witness; MAIN owns the M23 privacy manifest and release ruling; nolim-s4-port-b owns the Sable consumer.

A valid generated session UUID can also pass the IBAN checksum. Claude's internal tool-result directory embeds that UUID. M23 currently scans toolResultDirs as display text, so this internal policy input can latch an otherwise clean turn. The existing Sable expectations remain unchanged. Controlled collision replay reproduces the original owner-routine completion assertion. Every R10 merge and merge parent has the same failing collector. Actual historical runtime replay is GREEN on aed5be8152 and RED on e972f2e4fb (the introducing source commit); b8ea911cdf introduces the Sable witness, not this runtime cause. Passing random replays were not used to close causality.

Requested ruling: may toolResultDirs be execution-only (X), omitted entirely from audience JSON and text scanning? Repository callers use the original directory only for own-tool-result approval; the renderer has no consumer. This preserves the original execution input and exposes less metadata. All actual displayed request/text fields would retain the shared scanner and latch. No UUID/content scanner exemption or owner bypass is proposed. M23 currently lists display copies as T, so a manifest classification ruling is needed before claiming closure. The RULING-1116-WARMTEN2 privacy refusal precedence remains binding.

The explicit R11 instruction not to merge integration branches overrides the generic host merge instruction.

Candidate checkpoint: the collision regression goes RED to GREEN; 123 collector, serialized privacy and original approval-wiring checks pass. The unchanged Sable owner-routine assertion passes ten independent times with the valid colliding UUID selected in each final group. The M23 classification ruling above remains pending.

Further qualification: the cause-restoring mutant fails the unchanged owner-routine completion assertion after 51 accepted deliveries, and restored source is GREEN. Tip comparison has zero NEW failures and zero lost identities. Both server/renderer typechecks pass; 60 ledger/refusal checks pass. A separate non-owner displayed-path witness still latches on the identical colliding UUID, proving no scanner/UUID exemption. Secret scans report zero findings and zero private-string diff matches.

## Fix round 1019-R11: BLOCK 1 ruling still required
Owners: sable-redact-new owns the candidate, direct field witnesses and manifest reconciliation; MAIN owns the privacy classification decision; nolim-s4-port-b owns the Sable acceptance consumer.

The High review finding blocks closure because the candidate omits `toolResultDirs` scanning for every admission while M23/M24 still specify T. Please explicitly approve or reject the proposed X classification for both permission and question requests and all audiences. Approval would mean the original directories remain available only to execution, absent from audience JSON and text scanning; a secret only in this execution field would not latch subsequent completion text. Displayed secrets, displayed paths, missing admissions and existing privacy refusals would remain fail-closed. The fix round will not infer approval from passing tests.

If X is rejected, the current candidate remains unqualified and needs a different source fix under the retained T policy. No integration merge is authorized in this lane.

## Fix round afix2-sable-redact-new: T-to-X withdrawn; 1116-M23-SESSION-TOKEN applied
- The T-to-X request for M23/M24 toolResultDirs is withdrawn; M23/M24 stay T.
- The display copy of a fixed-form toolResultDirs entry carries the host token `{session}` in place of the raw session id (M02, DESIGN-r2.md:330/:335); it is still scanned and latches. Any other entry is scanned whole. Execution events are never mutated.
- Lane case 1 used a non-fixed path (`/tmp/session/<uuid>/tool-results`), which C2 requires to be scanned whole; it now uses the real fixed form (`projects/<key>/<uuid>/tool-results`), the same behaviour the Sable owner routine hits. The unfixed shape is pinned as masked in W4.
