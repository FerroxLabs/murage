# Restore-park invariants, r3.4d: the whole set on one page
Each line: ID predicate: statement. Reject witness / accept witness / mutant. Every predicate in invariants.current.ts has exactly one line (PAGE_MAP); every line's predicate is disabled by the page mutant `page-off-<predicate>` (killed by its reject witness) and the named mutants listed.

## Named assumptions
- A-EVENT-5MIN, A-ANSWER-RTT, A-RESTORE-APPLY (FLUX_ASSUMPTIONS): fair Flux delivers events, answers and applies RESTOREs within their bounds; MAX_BLIP_MS = 120 s derived from them.
- A-FAIR-SUFFIX: liveness is judged only on a fair, owner-free, fault-free suffix (suffixIsFair); an unfair suffix proves nothing.
- A-RESTORE-WINDOW (r3.4d, Low a): capture + swap + prep of one restore take at most LIVELOCK_WINDOW_MS (= MAX_BLIP_MS, 120 s); the livelock clause fails a slower window.
- A-ARCHIVE-DIGEST (r3.4d, M-3): an ArchiveId IS the verified content digest of the archive; a verified local file is immutable.

## Safety
- S1 keepSuccessIsConfirmed: a Keep is recorded succeeded only after a GET sent after its RESTORE is answered active. get-before-restore-answered / real-get-after-restore / page-off.
- S2 guardArmedForEveryKeep: every admitted Keep arms a guard for its inbox in the same step. keep-without-guard / keep-with-guard / page-off.
- S3 guardLivesUntilEveryDeleteResolved: a guard lives until every DELETE it covers is resolved. guard-gone-at-30d-delete-lands-31d / released-by-delivered-answer / page-off.
- S4 guardDiesOnFreshRemove: a fresh owner Remove deletes the guard for its target. guard-survives-owner-remove / guard-deleted-with-remove / page-off.
- S5 guardActsOnlyOnGuardRecord: a guard restore acts only on the closing its guard record names and never reverts an owner Remove verified after the guarded Keep. guard-reverts-later-remove / guard-restores-delete-closing / page-off.
- S6 restoreUsesOwnerCredentialAndKeepPurpose: every RESTORE uses the owner credential with purpose keep or guard. restore-with-bot-key / restore-with-owner-key / page-off.
- S7 authorityCreatedByValidOwnerAction: an authority exists only from a valid owner action on a current token. token-for-rotated-generation / valid-owner-remove / page-off.
- S8 ownerAuthorityForEveryDestructiveSend: every destructive send has a live owner authority. reconnect-deletes-inbox / delete-under-owner-remove / page-off.
- S9 removalSendNeedsSendingLease: a removal send needs a sending lease. delete-without-send-claim / delete-under-sending-lease / page-off.
- S10 noDestructiveSendAfterBlindRestore: after a blind restore nothing destructive is sent until the owner confirms the inventory. delete-after-blind-restore / delete-after-owner-confirms / page-off.
- S11 keptKeysProtected: a kept key is never revoked except by a newer verified owner Remove; while a window is open no input is applied and no answer taken (HELD INPUT, N4); the sealed carry is the Keep authority at both consuming preps (N3, r3.4). kept-key-revoked-by-older-remove / kept-key-revoked-by-later-remove / restore-skips-older-keep-check.
- S12 deletedBotAuthorityDead: an authority of a deleted bot is never used again. deleteBot-authority-reused / deleteBot-other-bot-untouched / page-off.
- S13 nothingAutomaticUnparks: no automatic step unparks a park; only an ordered owner restore drops an admitted Keep. tick-resumes-parked-removal / tick-finishes-other-park-keep / unparks-unordered.
- S14 keptStaysKept: boot never re-parks a kept address. boot-reparks-kept-address / boot-adopts-other-target / page-off.
- S15 viewMintsScopedTokens: a view mints tokens scoped to exactly what its row shows. token-shows-another-target / token-scoped-to-row / bot-keep-token-ignored.
- S16 keyOnlyActionsTouchNoInbox: a key-only Keep or Remove touches no inbox. key-only-keep-sends-get / key-only-remove-revokes / page-off.
- S17 noRemoveDuringKeep: no Remove is authorized on a target with an open Keep. remove-authorized-during-key-only-keep / remove-with-no-keep / page-off.
- S18 keepNetworkNeedsClaim: Keep network work needs a claim. flux-closing-keep-unclaimed / claimed-keep-restore / page-off.
- S19 keepOpsFreshAndCasChecked: Keep ops are fresh and CAS-checked. keep-op-reused / fresh-keep-op / page-off.
- S20 admissionPinned (owner decisions): every owner decision is admitted or refused with a listed code; while the window is open or a finished job is uncleared every owner decision (keep, remove, deleteBot, try again, backup, restore) is refused restore_finishing, pure, with its line (N5, L3). keep-refused-while-unknown / keep-refused-only-while-sending / finished-job-restore-any-code.
- S21 keyTargetEntriesNeverDropped: a key-target entry is never dropped while live. target-dropped-while-live / target-dropped-after-revoke / page-off.
- S22 savedKeyNeverOutlivesRevokeWithoutWork: a saved key outlives its revoke only with work pending. revoked-key-saved-no-work / async-revoke-pending / page-off.
- S23 opsLinesNeverNameAddress (lines): no ops line names an address; customer lines are exactly the named constants (RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RECONFIRM_KEPT_LINE, LOOK_AGAIN_LINE). line-names-address / line-binding-and-window / page-off.
- S24 everyOrphanHasExecutableAction: every orphan row has an enabled executable action. bot-deleted-during-live-keep / unknown-provisioning-op-row / page-off.
- S25 blindRestoreIsOwnerVisible: a blind restore shows the restore-check row. blind-restore-silent / blind-restore-check-row / page-off.
- S26 keepAndRemoveSerialized: Keep and Remove on one target never run together. key-only-keep-with-active-removal / keep-with-lease-on-other-target / page-off.
- S27 keyTargetsNeverLost: every live key has a record. live-key-without-record / key-held-by-park / page-off.
- S28 environmentWellFormed: the fake Flux and the clock behave as Flux does (generator guard). restore-erases-held-delete / delete-closes-once / page-off.

## Liveness
- L1 keepEndsActive: an admitted Keep ends active within MAX_BLIP_MS (120 s) under the named assumptions. restore-drops-guard-13 / flux-billing-close-ends-obligation / page-off.
- L2 quiescenceReachable: a fair suffix ends quiescent; JOB PROGRESS: from arm until CLEARED a job takes at most livenessBound of the home's own automatic steps; Flux and clock steps do not count (M-1, M-2). job-prepared-or-aborted-never-cleared-event-pending / owner-restore-many-env-steps-accepted / job-progress-counts-all-steps, job-bound-stops-at-finished.
- L3 heldInputDrains (new, Low b): input held by a window (an undelivered event, an answer Flux delivered but the home did not take) is applied or taken within livenessBound automatic steps after the window ends. held-event-dropped-after-window / held-event-applied-after-window / held-input-never-checked.

## Archive identity and the job
- A1 restoreJobProtocol: the job moves armed, captured, swapped, prepared or aborted, cleared, each by its named step; an archive is downloaded and verified before the arm; while a job exists no archiveFetch drops or replaces its archive; the swap re-checks that the job's archive is local (same digest); a failed fetch shows RESTORE_FAILED_LINE exactly when it serves an owner restore request (M-3, Low d). fetch-replaces-job-archive-mid-job, swap-archive-missing, background-prefetch-fails-shows-line / background-prefetch-fails-no-line / archive-not-frozen, swap-no-archive-recheck, fetch-line-always.
- A2 carryImmutable: the carry is sealed from capture to its consuming prep; only the armed job's capture creates it (N1). carry-mark-rewritten-after-swap / carry-recaptured-while-armed / carry-mutable.
- A3 outgoingCapturedBeforeSwap: a non-blind swap needs the job's complete carry; a blind swap has none. swap-without-carry / swap-after-complete-carry / blind-swap-with-carry.

## Crash and boot
- C1 restorePrepParksEverything: the prep that ends the window, the restore prep OR the boot prep after a crash, consuming its own job's carry, parks every archived and carried removal per target and keeps every key, inbox, op, carried guard and kept key; a stray prep owes no carry duty (M1, M-4). boot-prep-leaves-carried-removal-unparked, boot-prep-drops-carried-guard / boot-prep-parks-carried-removal / boot-prep-exempt.
- C2 restorePrepNeverThrows: a prep never throws. prep-throws / prep-commits / page-off.
- C3 markerNeverArchivedAndConsumedAtBoot: the boot marker is never archived and is consumed at boot. cloud-restic-carries-marker / archive-without-marker / page-off.
- C4 everyReplacementPreparedBeforeStore: the store never opens on an unprepared replacement. store-open-without-prep / boot-prep-opens-store / page-off.
- C5 restoreJobMatchesReality: the journal and the database marks (W25-W30) always match the world; boot reconciles both (N2). nolive-restore-pending-missing-in-window / nolive-restore-pending-through-crash-boot-prep / job-reality-unchecked.

## Code-lane checks (not testable in the model)
- T20 shell-harness: crash after W27, abort, assert no staged incoming DB file remains (r3.4c L2).
