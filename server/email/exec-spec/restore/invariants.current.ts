/**
 * RESTORE-PARK executable spec, part 1: INVARIANTS AS CODE.  Revision 3.4.
 *
 * r3.4d written 2026-11-11T02:34Z (date -u) by the builder: closes the Opus design check of r3.4c (FAILED: N-M1..N-M4 Medium, N-L1..N-L4 Low)
 *   under the MurageMain redesign brief. PAGE: INVARIANTS-PAGE-r34d.md (Safety S1-S28, Liveness L1-L3, Archive identity and job A1-A3,
 *   Crash and boot C1-C5). PAGE MAP (every registered predicate has exactly one page line; PAGE_MAP, checked by a test):
 *     S1 keepSuccessIsConfirmed  S2 guardArmedForEveryKeep  S3 guardLivesUntilEveryDeleteResolved  S4 guardDiesOnFreshRemove
 *     S5 guardActsOnlyOnGuardRecord  S6 restoreUsesOwnerCredentialAndKeepPurpose  S7 authorityCreatedByValidOwnerAction  S8 ownerAuthorityForEveryDestructiveSend
 *     S9 removalSendNeedsSendingLease  S10 noDestructiveSendAfterBlindRestore  S11 keptKeysProtected  S12 deletedBotAuthorityDead
 *     S13 nothingAutomaticUnparks  S14 keptStaysKept  S15 viewMintsScopedTokens  S16 keyOnlyActionsTouchNoInbox
 *     S17 noRemoveDuringKeep  S18 keepNetworkNeedsClaim  S19 keepOpsFreshAndCasChecked  S20 admissionPinned
 *     S21 keyTargetEntriesNeverDropped  S22 savedKeyNeverOutlivesRevokeWithoutWork  S23 opsLinesNeverNameAddress  S24 everyOrphanHasExecutableAction
 *     S25 blindRestoreIsOwnerVisible  S26 keepAndRemoveSerialized  S27 keyTargetsNeverLost  S28 environmentWellFormed
 *     L1 keepEndsActive  L2 quiescenceReachable  L3 heldInputDrains  A1 restoreJobProtocol
 *     A2 carryImmutable  A3 outgoingCapturedBeforeSwap  C1 restorePrepParksEverything  C2 restorePrepNeverThrows
 *     C3 markerNeverArchivedAndConsumedAtBoot  C4 everyReplacementPreparedBeforeStore  C5 restoreJobMatchesReality
 *   M-1 job progress counts only the home's automatic steps (Flux and clock steps do not count). M-2 the bound runs until the job is
 *   CLEARED. M-3 archiveId IS the verified content digest; while a job exists no archiveFetch drops or replaces its archive; the swap
 *   re-checks the job's archive is local. M-4 the boot prep after a crash that ends the window owes the carry duties. Low (a)
 *   A-RESTORE-WINDOW named; (b) heldInputDrains (new trace predicate); (c) T20 code-lane check; (d) RESTORE_FAILED_LINE only on a
 *   failed fetch that serves an owner restore request (a background prefetch shows no line).
 *   ASSUMPTIONS (named): A-EVENT-5MIN, A-ANSWER-RTT, A-RESTORE-APPLY (fair Flux, FLUX_ASSUMPTIONS); A-FAIR-SUFFIX (liveness judged
 *   on a fair owner-free fault-free suffix only); A-RESTORE-WINDOW: capture + swap + prep <= LIVELOCK_WINDOW_MS = MAX_BLIP_MS (120 s),
 *   the livelock clause fails a slower window (RESTORE_ASSUMPTIONS); A-ARCHIVE-DIGEST: an ArchiveId is the verified content digest and
 *   a verified local file is immutable.
 *   CODE-LANE CHECKS (not testable in the model):
 *     T20 shell-harness: crash after W27, abort, assert no staged incoming DB file remains
 *   WIP (redesign brief step 2): the predicates touched by M-1..M-4 / Low b / Low d (quiescenceReachable, restoreJobProtocol,
 *   restorePrepParksEverything, heldInputDrains) are written from their page lines; the other 35 keep their r3.4c bodies, each mapped
 *   to a page line and checked by the page mutants, and are still to be re-derived from the page in a follow-up pass.
 * r3.4c written 2026-11-11T02:14Z (date -u) by the builder: closes the Opus design check of r3.4b (FAILED: M1-M3 Medium, L1-L3 Low).
 *   M1 restorePrepParksEverything judges carry duties only while prepPending and carry.jobId names the job (a stray prep owes none).
 *   M2 (a) an item held by an open restore window is not late (itemLate); (b) quiescenceReachable JOB PROGRESS: on the owner-free,
 *   fault-free suffix no job stays unfinished (armed / captured / swapped) for livenessBound steps. M3 the archive is downloaded and
 *   verified BEFORE arming (HomeFs.localArchives, auto.archiveFetch); download_failed is a pre-arm refusal (RESTORE_FAILED_LINE, nothing
 *   changed), never an in-window abort; the 120 s keepEndsActive bound is unchanged. L1 stale confirm_expired text removed. L2 abort
 *   discards a staged incoming database (R1). L3 owner.restore while a finished job is not yet cleared is refused restore_finishing.
 * r3.4b written 2026-11-11T01:56Z (date -u) by the Opus design pass: closes the independent Opus design check of r3.4 (FAILED: N1 High, N2 and N3
 *   Medium, N4 and N5 Low). N1 carry provenance: carry.jobId; only the armed job's capture creates or replaces a carry (carryImmutable);
 *   a prep consumes only its own job's carry (carryOfJob); a blind swap needs no carry (outgoingCapturedBeforeSwap); arming needs no
 *   journal and no carry (restoreJobProtocol); restoreJobMatchesReality checks the carry's job. N2: the job moved from LocalDb to the
 *   durable sidecar journal HomeFs.restoreJob (JOURNAL_NAME restore-job.json, atomic replace, every restore); swapped and prepared are
 *   database marks LocalDb.swappedJobId (W27, staged DB) and LocalDb.preparedJobId (W28, in W4); jobOf derives the effective phase; boot
 *   reconciles journal plus database (Fable r3.3i F1's id-carrying flag). N3: only a window-ending prep (prep pending) consumes the
 *   carry, and an entry re-kept under a Keep a later owner Remove ended is rejected. N4: held input: no event applied and no answer
 *   taken while the window is open. N5: stale confirm_expired text removed; owner.backup is a window decision. R1, R2 updated.
 * r3.4 written 2026-11-11T01:16Z (date -u) by the Opus design pass: a REDESIGN of the restore window after the third DISAGREE (Astra and
 * Fable on r3.3i). The flag-based mechanics (fs.restorePending, restoreArmed, prepPending refusals) are replaced by ONE structure:
 *   1 Durable restore job  LocalDb.restoreJob {id, archiveId, source, phase armed|captured|swapped|prepared|aborted, at}; each phase
 *                          change is a named durable write W25-W30 with a crash witness; the prep writes prepared in its own transaction;
 *                          boot resumes from the durable phase or aborts; auto.restoreAbort (before the swap) changes nothing but the job
 *                          and shows RESTORE_FAILED_LINE; auto.restoreJobClear deletes the carry and clears a finished job; liveness:
 *                          no job is left in a phase (quiescentModuloWaiting). State invariant restoreJobMatchesReality replaces
 *                          restorePendingTracksPrep; step invariant restoreJobProtocol owns the phase writes. (Astra #3, Fable F1, F3, F4)
 *   2 One window           phases armed, captured, swapped. Every owner decision is refused restore_finishing ONLY (confirm_expired
 *                          removed), changing nothing but the surface (bots and Flux now in the snapshot); every view shows the line;
 *                          no sends; capture / swap only for the job. (Astra #4, #6, Fable F2)
 *   3 Sealed carry         carryImmutable; both preps take the carried Keep and mark as the authority, re-creating a carried key the
 *                          archive lacks. (Astra #1, #2)
 *   4 Witnesses restored   nolive-revoked-key-leaves-before-clamp, nolive-later-remove-leaves-before-clamp (restore prep) and
 *                          nolive-later-remove-clamped-not-raised-revoke (revoke send, rebuilt after the restore in r3.4a) are back on their original actions; the
 *                          restorePrepParksEverything conflict is resolved in the predicate (departed keys). (Astra #5)
 *   5 Text and copy        R1 covers system and blind swaps; R3 drop wording matches the predicate; skipped_in_use keeps the mark and
 *                          RECONFIRM_KEPT_LINE. (Fable F4, F5, F6)
 *   State types CHANGED: LocalDb.restoreJob, RestoreRecord.jobId (optional), HomeFs.restorePending REMOVED; DurableWrite W25-W30; Action
 *   auto.restoreArm, auto.restoreAbort, auto.restoreJobClear. New exports: RestoreJob, RestoreJobPhase, jobOf, jobOpen, windowOpen,
 *   RESTORE_FAILED_LINE, restoreJobMatchesReality, restoreJobProtocol, carryImmutable. Removed: restoreArmed, restorePendingTracksPrep.
 *   Reference copy of r3.3i: invariants.r33i.ts.
 *
 * r3.3i written 2026-11-11T00:49Z (date -u) by the Opus design pass: the independent Opus design check FAILED r3.3h (A-F) plus the Sol copy check (G):
 *   A Partial #2  stale mark brought in by the swap    -> the window-ending prep RE-STAMPS every mark it leaves: a carried key gets its
 *                                                      carried mark value, every other marked entry the prep's own step; immutability
 *                                                      holds at every other step. A fresh Keep / Remove ends a mark only when verified
 *                                                      strictly after the mark's step.
 *   B High        archive mark != carry mark wedge     -> resolved by A: the carried value wins at the window-ending prep.
 *   C High        mark laundered by a Remove           -> a Remove ends a mark ONLY with the key leaving keptKeys (revoke or completed
 *                                                      removal); a Remove still owed keeps the mark; capture copies every kept key's mark.
 *   D Med/High    R1 not implementable                 -> durable HomeFs.restorePending (beside the install, outside the restored tree):
 *                                                      written before capture / swap of an owner restore, cleared only in the step that
 *                                                      commits the window-ending prep; state invariant restorePendingTracksPrep
 *                                                      (prepPending => set; set => prepPending or restoreArmed) at every state, crash
 *                                                      points included. R1 keys on it; reset / undo markers imply no refusal.
 *   E Low         windowDurable incomplete             -> also archives, ops and ghost.keptHighWater.
 *   F Low         combined gate claimed, absent        -> a real gate: EVERY predicate over EVERY must-accept witness, 0 failures.
 *   G Copy        look-again line misused              -> RECONFIRM_KEPT_LINE on the bot section on every view while a key is marked;
 *                                                      LOOK_AGAIN_LINE only for the binding-changed Keep refusal.
 *   State types CHANGED: HomeFs.restorePending (optional, absent = false). New exports: RECONFIRM_KEPT_LINE, restoreArmed,
 *   restorePendingTracksPrep (STATE_INVARIANTS).
 *
 * r3.3h written 2026-11-11T00:34Z (date -u) by the Opus design pass: Astra's second DISAGREE (on r3.3g, six items):
 *   #1 High   carried mark lost across boot prep      -> BOTH preps that end the window (auto.restorePrepare committed, auto.bootPrep ok
 *                                                      while prepPending) consume the carry: carried kept keys at least at the carried
 *                                                      Keep and carried marks with their carried VALUE (consumesCarry).
 *   #2 High   mark mutable / forgeable                 -> a mark's value is the step that made it (a window-ending prep stamps its own step or
 *                                                      restores the carried value; a swap may bring an earlier archive mark); immutable
 *                                                      while present; ended only by an owner Keep or Remove verified after it, or the key
 *                                                      revoked at Flux. Preservation compares the value.
 *   #3 High   Remove after the mark "done" unrevoked   -> removalDone counts a kept entry only when its Keep is newer than the Remove.
 *   #4 Medium queued restore has no durable request   -> NO QUEUE: while prepPending owner.restore is REFUSED (nothing recorded, no state
 *                                                      change) with RESTORE_FINISHING_LINE; no service obligation.
 *   #5 Medium tryAgainNow in the window has no outcome -> ONE window-refusal rule (admissionPinned): while prepPending every owner decision
 *                                                      (keep, remove, deleteBot, tryAgainNow, reconnect, confirmInventory, restore) may be
 *                                                      refused restore_finishing / confirm_expired. R1 keys on the restore marker, not on
 *                                                      proc.phase: an ordinary boot refuses nothing.
 *   #6 Medium window refusals impure / silent          -> the purity snapshot is every durable field (all of LocalDb incl. savedKeys, carry,
 *                                                      fs, proc, owner ledgers); every refusal shows the restore-finishing line (home row or
 *                                                      the bot's row, LOOK_AGAIN_LINE there too); every owner view while prepPending shows
 *                                                      it, so it shows again after a crash. No replay obligation.
 *   State types CHANGED: owner.restore gains an optional outcome (absent = ok); SurfaceRow.section gains "home". New exports:
 *   RESTORE_FINISHING_LINE, WINDOW_REFUSAL_CODES.
 *
 * r3.3g written 2026-11-11T00:18Z (date -u) by the Opus design pass: Astra's DISAGREE on r3.3f (five items), all in keptKeysProtected:
 *   #1 High   second restore inside the window      -> SERIALIZED: no capture and no swap while a replacement prep is pending
 *                                                      (prepPending); r3.3h: the later owner.restore is refused, no queue.
 *   #2 High   lost-disk clamp has no source          -> design (i) FAIL CLOSED: LocalDb.unconfirmedKept. A window-ending prep leaves every
 *                                                      uncarried entry at/above the high-water OR marked unconfirmed; the reducer, which
 *                                                      cannot read the high-water, marks every uncarried entry. While marked: no drop or
 *                                                      revoke except revoked-at-Flux or an owner Remove after the mark; the mark clears only
 *                                                      with a new owner Keep; each owner view shows LOOK_AGAIN_LINE. No new production store.
 *   #3 Medium window not isolated                    -> while prepPending: no net.send, every owner decision refused purely (confirm_expired,
 *                                                      admissionPinned), no capture / swap.
 *   #4 Medium clamp changed an existing verdict      -> the clamp judges ONLY the prep that ends an outstanding window (prepPending(prev));
 *                                                      an ordinary later boot owes nothing.
 *   #5        departed keys owe no clamp; the clamp never raises an authority (accept witnesses).
 *
 * r3.3b written 2026-11-10T22:09Z (date -u) by the Opus design pass, one clause (reducer-builder gap + MurageMain ruling) and Astra's r3.3a Low:
 *   admissionPinned: an UNTOKENED bot-row Keep (bot_section / live / flux_closing) whose target is not the bot's current live binding
 *   may be refused confirm_expired (tokened Keeps keep tokenProblem); that refusal changes no park, binding, authority, Keep op or Keep
 *   record, and shows the bot's row with LOOK_AGAIN_LINE. keptKeysProtected: a ghost.keptHighWater entry is never deleted and never set
 *   to an authority with an earlier verifiedAtStep (checked directly, not through the max with the live entry). No state-type change.
 * r3.3a written 2026-11-10T22:04Z (date -u) by the Opus design pass, ONE Medium (Astra A8-M1, MurageMain ruling): a swap / prep dropped an
 *   uncarried kept-key entry and a later tick re-kept it under an older Keep -> keptKeysProtected: a restore step drops only keys the
 *   carry holds; per-key authority is monotonic against the new ghost.keptHighWater (recorder-written, never lowered).
 * r3.3 written 2026-11-10T21:57Z (date -u) by the Opus design pass: MurageMain ruling 1 (owner restore only), Astra's check of r3.2 (A7-*),
 * Fable FA-L2 and FA-L7. Narrow: nothing else reopened.
 *   A7-H1  any later swap/prep ends an admitted Keep    -> only an OWNER restore REQUESTED AFTER the op's claim ends it (ownerRestoredAfter;
 *          (ruling 1)                                      RestoreRecord.ownerRequestStep, ghost.ownerRestoreRequests, environmentWellFormed);
 *                                                          nothingAutomaticUnparks no longer exempts swap/prep from the keep_pending ban.
 *                                                          The model's automatic / system restore = an auto.swap no owner.restore asked for
 *                                                          (ownerRequestStep null): crash recovery replays the marker, never a new swap.
 *   A7-M2  prep downgrades an uncarried kept key        -> keptKeysProtected skips the older-Keep check on a swap/prep only for keys the
 *                                                          carry holds; every other key keeps the rule
 *   A7-M3  one recovered delay disables livelock        -> livelock judged after the last drained step AND the last late item (sliding);
 *                                                          lateness and the window DERIVED: an item is late past its assumption (A-ANSWER-RTT,
 *                                                          A-EVENT-5MIN) or PROMPT_STEPS = one fault-free round trip; LIVELOCK_WINDOW_MS =
 *                                                          MAX_BLIP_MS; livelock = more than the window (time) or fairRecoverySteps (steps)
 *   FA-L2  other-setup removal lost by restore          -> queuedRemovals keys on !l.foreign; CarriedRemoval.botId and Park.botId nullable
 *   FA-L7  bot-row Keep with a fresh token rejected     -> viewMintsScopedTokens judges a bot-row Keep's token when it carries one
 *   State types CHANGED: Park.botId, CarriedRemoval.botId -> BotId | null; RestoreRecord.ownerRequestStep: number | null (new);
 *   Ghost.ownerRestoreRequests: OwnerRestoreRequest[] (new). New exports: OwnerRestoreRequest, ownerRestoredAfter, LIVELOCK_WINDOW_MS,
 *   ROUND_TRIP_ACTIONS, itemLate.
 *
 * r3.2 written 2026-11-10T21:44Z (date -u) by the Opus design pass: Astra's final check of r3 (A6-*) and Fable's three Mediums (FA-*), no r4.
 *   A6-H1  admitted Keep discarded after a later view    -> quiescenceReachable judges EVERY admitted owner op (owner-caused ends only:
 *                                                           bot deleted after the claim, later Keep on a Remove's target, later restore;
 *                                                           the model has no owner Keep-cancel action); nothingAutomaticUnparks: no
 *                                                           automatic keep_pending -> parked / parked_evidence, absolute
 *   A6-M2  completed listing ineffective                 -> unknownExcused only while discoveryPending: (d) and (f) demand rows/records
 *   A6-M3  correct swap rejected by keptKeysProtected    -> swap / prep judged on the carried protection (carry holds the newer Keep,
 *                                                           prep restores one at least as recent)
 *   A6-M4  one drained step disables livelock            -> livelock judged on the suffix after the LAST drained step
 *   A6-M5  ok deleteBot unpinned (R3-Q4)                 -> admissionPinned: per bot a delete authority, a lease on its target, the
 *                                                           target's parks to remove_authorized; quiescenceReachable: its work completes
 *   FA-M1  blip bound 90 s < 120 s worst case            -> MAX_BLIP_MS / MAX_EVENT_BLIP_MS derived from ENV_ASSUMPTIONS
 *   FA-M2  bot_present keyed on the action's bot         -> keyed on a present bot's live binding naming the target (also FA-L1)
 *   FA-M3  inbox_gone on closing evidence (High-class)   -> purge evidence only: delivered not_found or delivered deleted event
 *   Lows folded: FA-L3 tokenProblem park/restore step; FA-L4 guard keepOp pinned; FA-L5 owner exits only the named target's park
 *   (bot delete: its bots); FA-L6 subsumed by A6-M2; FA-L8 blindPending comment. Not folded (not one-liners): FA-L2 (needs a nullable
 *   CarriedRemoval.botId, a state-type change), FA-L7 (bot-row Keep token). State types: UNCHANGED. Helper parksOfBot removed.
 *
 * r3 written 2026-11-10T21:16Z (date -u) by the Opus design pass after Astra round 5 (astra-acct4.log on r2: 8 H + 5 M, DISAGREE) and
 * Fable round 5 (fable-review.md on r2: 1 H + 3 M + 6 L, DISAGREE). Ids: A5-n = Astra r2 finding n; F5-H1/M1-M3/L1-L6 = Fable r2.
 * Closed rulings are not reopened; everything both reviewers judged closed is unchanged.
 *   A5-H1  authority not bound to the owner's choice     -> viewMintsScopedTokens: a token is minted ONLY by a view, for an enabled
 *                                                           action on a row whose target, inbox, keys and address it shows exactly;
 *                                                           authorityCreationVerdict binds bot + target to the action, TOKEN_KINDS_FOR
 *                                                           (Reconnect needs a b token), untokened Keep keys pinned (F5-L5)
 *   A5-H2  carry loses queued removals / evidence        -> CarryRecord.removals (queuedRemovals), carryCovers; prep parks every
 *                                                           archived AND carried removal, one parked park PER TARGET
 *   A5-H3  protections editable before the check         -> guard contents fixed, `unresolved` only shrinks by resolution (F5-L1);
 *                                                           kept-key entries leave only by revoke or a later Remove; carry and prep
 *                                                           preserve guard / kept-key CONTENTS
 *   A5-H4  timing impossible under permitted faults      -> keepEndsActive: named assumptions FLUX_ASSUMPTIONS checked directly
 *                                                           (held RESTORE, late answer, late event); the clock restarts after each
 *                                                           break; an irreversible purge ends the terminal obligation (R3-Q2)
 *   A5-H5  blind-restore discovery contradictory         -> discoveryPending(): both (d) and (f) exempt unknown entries until a
 *                                                           complete listing; quiescence REQUIRES the pass once the listing exists
 *                                                           (R2-Q4); the fence spans a later restore (F5-M2, CarryRecord.blindPending)
 *   A5-H6  no-op owner actions satisfy (e) and (h)       -> admissionPinned: an ok Keep creates authority + Keep op + history, an ok
 *          + F5-H1 refusals that last forever               Remove creates authority + lease; (h) requires the admitted Keep to end
 *                                                           succeeded or Flux-refused and the Remove to take effect; bot_present only
 *                                                           where the row's premise is an absent bot; inbox_gone only on evidence
 *   A5-H7  completed-Remove exemption hides parks        -> removedByOwner needs a CURRENT-epoch authority and no park on the inbox
 *   A5-H8  idempotent DELETE branch wrong (R2-Q2)        -> environmentWellFormed: with the key honoured, a duplicate of an executed
 *                                                           DELETE changes nothing; without it, it acts as a fresh DELETE
 *   A5-M9  fairness ignores recovery-created work        -> suffixIsFair = drained at the end; envPrompt + livelock clause in (h)
 *   A5-M10 removal revoke outside the send claim         -> removalSendNeedsSendingLease covers removal REVOKE_KEY
 *   A5-M11 Keep history mutable                          -> environmentWellFormed fixes success step, time and confirmation together
 *   A5-M12/M13 passive accepts, missing contrasts        -> witnesses.ts: acting accepts, new contrasts, `// r2-escape` set
 *   F5-M1 = A5-H5; F5-M2 fence after 2nd restore; F5-M3 Keep offer on a guarded Flux closing (skip only DELETE closings);
 *   F5-L1 = A5-H3; F5-L2 recorder fields pinned; F5-L3 parked exits only by ok Keep/Remove/bot delete; F5-L4 pre-trace authorities;
 *   F5-L5 = A5-H1; F5-L6 GET not_found releases a guard.  tsc: authorityCreationVerdict guards `typeof action.outcome === "object"`.
 * MUTANT HOOKS: every step invariant carries a `// PERMITTED ACTION:` line; the harness builds an over-strict mutant forbidding it,
 * and that mutant must fail at least one must-accept witness.
 *
 * r2 header follows (unchanged mapping for rounds 3-4).
 *
 * r1 written 2026-11-10T20:26Z. r2 written 2026-11-10T20:43Z-21:30Z (UTC) by the Opus design pass, the ONE revision MurageMain ruled
 * after Astra round 4 (astra-acct4.log, 10 H + 4 M + 1 L) and Fable round 4 (fable-review.md, 4 H + 6 M + 6 L), both DISAGREE.
 * Pure: no I/O, no imports, no clock, no randomness. Witnesses (must-reject and must-accept traces for every exported invariant) are in
 * the sibling `witnesses.ts`; the checker runs them FIRST and aborts if any witness disagrees with its invariant (a vacuous or
 * over-strict predicate fails its own witnesses).
 *
 * Standing order (Sean): after a backup restore, Cloud reset or Cloud undo, an inbox removal that was in flight or queued is PARKED.
 * Nothing automatic finishes, re-runs or revokes it. Only the owner's Keep or Remove resumes it. Keep always wins.
 *
 * Binding inputs: r3.2 rulings (D1 REVERSED: unknown provisioning outcome = key-only orphan, no exemption in (b)); D3 resolved (soft
 * delete, no timers); invariant (a) accepted; Check 1 and Check 2; the three BINDING blocks appended at the end of this file (RULINGS
 * Q1-Q5, guard lifetime, FLUX FACTS) and the FLUX FACT of 2026-11-10 ~20:45Z: a DELETE landing on an inbox already closing emits NO
 * second email.inbox.closing; its answer repeats the first closing window. One closing event per closing, not per DELETE.
 *
 * TRUSTED BOUNDARY (Astra4 M12). `World.flux` (remote truth) and `World.ghost` (history) are written ONLY by the checker's environment
 * and history recorder, never by the reducer. The reducer sees `ReducerView` (below) plus the answers and events delivered to it.
 * `environmentWellFormed` checks the recorder itself on every step (append-only history, requests survive restore, Flux semantics).
 *
 * Finding -> where it is answered (A4 = Astra round 4; F4 = Fable round 4; A3/F3 = round 3, still mapped):
 *   A4-H1  authority checked against copied claims          -> authorityCreatedByValidOwnerAction (validated at creation, against the
 *                                                               owner action, its token and the CURRENT generation / park revision)
 *   A4-H2  no operation/authority matrix                    -> OP_MATRIX in ownerAuthorityForEveryDestructiveSend; keepEndsActive
 *                                                               and guardDiesOnFreshRemove count only validly created authorities
 *   A4-H3  key-only Keep outside serialization; keptKeys     -> TargetRef everywhere (inbox / provisioning op / bot); keepAndRemove-
 *                                                               Serialized, noRemoveDuringKeep by target; keptKeysProtected
 *   A4-H4  GET confirmation not verified                    -> keepSuccessIsConfirmed (real GET, this keep op, delivered, active,
 *                                                               sent after every restore of this op was ANSWERED)
 *   A4-H5  (a) vs no-auto-restore of Flux closings / parks   -> keepEndsActive window ends on a Flux-caused closing, a valid fresh
 *                                                               Remove, or a BLIND restore (then blindRestoreIsOwnerVisible); a carried
 *                                                               guard beats an archived removal (restorePrepParksEverything)
 *   A4-H6  timing not achievable under faults               -> guard has no expiry (ruling); purge clause dropped; timing bound only on
 *                                                               environment-fair intervals (ENV_ASSUMPTIONS), eventual activity always
 *   A4-H7  Q2 carry absent                                  -> CarryRecord captured BEFORE the swap outside the restored tree;
 *                                                               outgoingCapturedBeforeSwap; restorePrepParksEverything checks keys,
 *                                                               inbox ids, provisioning ops, guards, kept keys, outstanding DELETEs,
 *                                                               evidence; parks keyed by park id (several per bot)
 *   A4-H8  unknown inbox id demanded; token expiry           -> op-backed rows cover inboxes created under the op; token freshness
 *                                                               checked at the view step (viewMintsScopedTokens), not every step
 *   A4-H9  unusable actions satisfy the spec                -> admissionPinned (legal refusal codes with preconditions only);
 *                                                               (d) needs an ENABLED keep/remove; (h) counts no refusal as progress
 *   A4-H10 async revoke vs savedKey predicate               -> savedKeyNeverOutlivesRevokeWithoutWork accepts pending work
 *   A4-M11 credential capability inferred                   -> FLUX FACTS: restore is owner-key only; restoreUsesOwnerCredential...
 *   A4-M12 trusted boundary                                 -> ReducerView; environmentWellFormed
 *   A4-M13 fairness and depth                               -> suffixIsFair; CHECKER fair recovery from every explored state; depth 14
 *   A4-M14 marker absence proves nothing                    -> everyReplacementPreparedBeforeStore
 *   A4-L15 ops lines                                        -> opsLinesNeverNameAddress: every line has binding+generation, blips a window
 *   F4-H1  restore drops the guard -> (a) unsatisfiable     -> carry + restorePrepParksEverything (guards survive); blind restore ends
 *                                                               the window with an owner-visible row
 *   F4-H2  admission unpinned                               -> admissionPinned
 *   F4-H3  guard reverts an owner Remove                    -> guardDiesOnFreshRemove (mandatory), guardActsOnlyOnGuardRecord
 *   F4-H4  expiry contradicts the guard ruling              -> KeepGuard has no eventUntilMs; guardLivesUntilEveryDeleteResolved
 *   F4-M1  purge / Flux closing spurious failures            -> window ends on a Flux closing; purge constrained in environmentWellFormed
 *   F4-M2  bot-key restore                                  -> owner credential only (FLUX FACTS); key release no longer waits
 *   F4-M3  owner-removed inbox counted as orphan             -> everyOrphanHasExecutableAction excludes a closing under a valid Remove
 *   F4-M4  no send-claim predicate                          -> removalSendNeedsSendingLease
 *   F4-M5  Q2 not representable                             -> LIST_ACCOUNT request, owner.confirmInventory, restore_check row,
 *                                                               noDestructiveSendAfterBlindRestore
 *   F4-M6  duplicate DELETE after a delivered answer         -> FluxSemantics.deleteIdempotencyKeyHonoured; ghost check in
 *                                                               guardLivesUntilEveryDeleteResolved counts duplicate copies when false
 *   F4-L1..L6                                               -> keepSuccessIsConfirmed; authority creation pins gen/park; RESTORE
 *                                                               purposes; keptKeysProtected; depth 14 + fair suffix + bulk delete
 *                                                               carries a bot list; F-BACKFILL in (a); guard arms on EVERY Keep
 *   A3-*, F3-* (round 3)                                    -> unchanged mapping: (a)-(h) as in r1, now with the fixes above
 *
 * R2 QUESTIONS, answered by both reviewers (AGREE) and now encoded:
 *   R2-Q1 carried Keep beats an archived removal; the carried guard's FULL state is preserved (A5-H3).
 *   R2-Q2 Idempotency-Key on DELETE: both semantics encoded consistently (A5-H8); conservative guard release kept.
 *   R2-Q3 the 5-minute event bound is conditional on the named assumption A-EVENT-5MIN (FLUX_ASSUMPTIONS), checked on the trace.
 *   R2-Q4 owner-confirmed unknown entries stay live until discovery runs; a discovery pass is REQUIRED once the listing exists.
 *   R2-Q5 bot-row Keep tokenless; orphan / key-only Keep tokened; action and target validation still apply (A5-H1, F5-L5).
 * OPEN QUESTIONS r3 (encoded as recommended, not as exemptions):
 *   R3-Q1 A removal revoke now needs a `sending` lease claim like a DELETE (A5-M10). RECOMMEND accept (Keep admission must see it).
 *   R3-Q2 Flux's purge (>= 30 d closing, irreversible) ends (a)'s terminal obligation; the timing bound still judges every fair interval
 *         before it. RECOMMEND accept: the only alternative is an unsatisfiable obligation after a 30-day outage.
 *   R3-Q3 Authorities in the checker's INITIAL ghost count as validly created (F5-L4): the initial-state generator emits only histories
 *         a valid run could write. RECOMMEND accept.
 *   R3-Q4 An ok owner.deleteBot is not yet pinned to per-bot authorities (only Keep / Remove are, A5-H6). RECOMMEND pin in r4 only if a
 *         reviewer asks; the bulk delete is token-gated per bot already.
 */

// ===================================================================================================================================
// 1. Identities, constants, assumptions
// ===================================================================================================================================

export type BotId = string;
export type InboxId = string;
export type KeyId = string;
export type OpId = string;
export type ParkId = string;
export type RemovalId = string;
export type AttemptId = string;
export type AuthorityId = string;
export type TokenId = string;
export type RequestId = string;
export type EventId = string;
export type ArchiveId = string;
export type CarryId = string;

/** Durable identity of one thing the owner can Keep or Remove: an inbox, a provisioning op (key-only, inbox unknown), or a bot's keys. */
export type TargetRef = string; // "inbox:<id>" | "op:<opId>" | "bot:<botId>"
export const inboxTarget = (i: InboxId): TargetRef => "inbox:" + i;
export const opTarget = (o: OpId): TargetRef => "op:" + o;
export const botTarget = (b: BotId): TargetRef => "bot:" + b;

export const MARKER_NAME = "restore-pending.json";
export const GUARD_POLL_MS = 60_000;
export const GUARD_POLL_WINDOW_MS = 24 * 3600_000;
export const FLUX_PURGE_MS = 30 * 24 * 3600_000;
export const GATE_RTT_MS = 30_000;
export const TOKEN_TTL_MS = 10 * 60_000;

/** Environment assumptions (not facts). Timing bounds in (a) are checked only on intervals where these held, and each is checked
 *  DIRECTLY on the trace (A4-H6, A5-H4, R2-Q3). A broken assumption suspends the bound; the clock restarts when it holds again. */
export const FLUX_ASSUMPTIONS = {
  "A-EVENT-5MIN": { ms: 5 * 60_000, text: "a closing event reaches a running home within 5 min", status: "ASSUMED; FluxMain to commit a delivery target (R2-Q3)" },
  "A-RESTORE-APPLY": { ms: GATE_RTT_MS, text: "Flux applies a RESTORE within 30 s of its send", status: "ASSUMED" },
  "A-ANSWER-RTT": { ms: GATE_RTT_MS, text: "a GET / RESTORE answer is delivered within 30 s of its send", status: "ASSUMED" },
} as const;
export const ENV_ASSUMPTIONS = {
  eventDeliveryMs: FLUX_ASSUMPTIONS["A-EVENT-5MIN"].ms, restoreApplyMs: FLUX_ASSUMPTIONS["A-RESTORE-APPLY"].ms, answerRttMs: FLUX_ASSUMPTIONS["A-ANSWER-RTT"].ms,
} as const;
/** r3.2 (Fable M1): the in-window blip bound is DERIVED from the named assumptions, not hard-coded: worst case with none broken =
 *  next GET poll (GUARD_POLL_MS) + its answer (A-ANSWER-RTT) + the RESTORE applied (A-RESTORE-APPLY) = 120 s. After 24 h: the closing
 *  event (A-EVENT-5MIN) + the RESTORE applied. */
export const MAX_BLIP_MS = GUARD_POLL_MS + ENV_ASSUMPTIONS.answerRttMs + ENV_ASSUMPTIONS.restoreApplyMs;
export const MAX_EVENT_BLIP_MS = ENV_ASSUMPTIONS.eventDeliveryMs + ENV_ASSUMPTIONS.restoreApplyMs;
/** r3.3 (A7-M3): promptness is DERIVED, not picked. One fault-free round trip is send, apply, answer; an item outstanding for that
 *  many steps of the suffix, or past its named assumption in time (A-ANSWER-RTT / A-RESTORE-APPLY for a request, A-EVENT-5MIN for an
 *  event), is LATE. A home with a prompt environment drains within one worst-case blip (MAX_BLIP_MS: next poll + its answer + a
 *  RESTORE applied), so LIVELOCK_WINDOW_MS = MAX_BLIP_MS. */
export const ROUND_TRIP_ACTIONS = ["net.send", "flux.apply", "net.answer"] as const;
export const PROMPT_STEPS = ROUND_TRIP_ACTIONS.length;
export const LIVELOCK_WINDOW_MS = MAX_BLIP_MS;
/** r3.4d (Low a): the restore window's time bound is a stated product obligation, enforced by the livelock clause of quiescenceReachable. */
export const RESTORE_ASSUMPTIONS = {
  "A-RESTORE-WINDOW": { ms: LIVELOCK_WINDOW_MS, text: "capture + swap + prep of one restore finish within LIVELOCK_WINDOW_MS (120 s)", status: "ASSUMED" },
  "A-ARCHIVE-DIGEST": { ms: 0, text: "an ArchiveId is the verified content digest; a verified local archive file is immutable", status: "ASSUMED" },
} as const;

// ===================================================================================================================================
// 2. State
// ===================================================================================================================================

export type BindingState =
  | "provisioning" | "active" | "failed" | "paused" | "billing_hold" | "grace" | "closing"
  | "removing" | "remove_requested" | "removal_parked" | "account_off" | "restored_unverified";
export const ALL_BINDING_STATES: readonly BindingState[] = [
  "provisioning", "active", "failed", "paused", "billing_hold", "grace", "closing",
  "removing", "remove_requested", "removal_parked", "account_off", "restored_unverified",
];

/** FULL generation; `serial` strictly increases whenever any other field changes (A3-M9). */
export interface Generation { inboxId: InboxId | null; opId: OpId | null; emailKeyRef: KeyId | null; serial: number }

export interface Binding { botId: BotId; state: BindingState; step: "key" | "inbox" | "restored" | null; gen: Generation; address: string | null }
export interface Intent { botId: BotId; inboxId: InboxId | null; keyId: KeyId | null; phase: "uncommitted" | "committed" | "removed"; deletionProof: boolean }

/** `revoked_clear_pending` = revoke answered ok, saved secret not yet cleared (its own durable phase, A3-M10). */
export type KeyTargetStatus = "pending" | "revoked_clear_pending" | "revoked" | "skipped_in_use" | "kept";
export interface KeyTarget { keyId: KeyId; status: KeyTargetStatus }

export type ParkState = "parked" | "parked_evidence" | "keep_pending" | "remove_authorized" | "key_release";
export interface Park {
  parkId: ParkId; botId: BotId | null; parkRev: number; // r3.3 (FA-L2): null = a park of a botless (other-setup) removal
  origin: "restore" | "legacy" | "kept";
  state: ParkState; target: TargetRef; inboxId: InboxId | null; provisionOpId: OpId | null;
  gen: Generation; address: string | null; keyTargets: KeyTarget[]; remoteDeletedAtMs: number | null;
}

export type LeasePhase = "authorized" | "sending" | "unknown" | "acked" | "keeping" | "gone";
export interface Lease {
  removalId: RemovalId; target: TargetRef; inboxId: InboxId | null; botId: BotId | null; authorityId: AuthorityId;
  foreign: boolean; phase: LeasePhase; attemptId: AttemptId | null; attempts: AttemptId[]; keyTargets: KeyTarget[];
}

export type KeepMode = "bot_section" | "orphan" | "live" | "flux_closing" | "key_only";
export interface KeepOp { keepOp: OpId; botId: BotId; target: TargetRef; inboxId: InboxId | null; mode: KeepMode; authorityId: AuthorityId; claimedAtStep: number }

/** Post-Keep guard (F3-H2, F4-H4). No expiry. `unresolved` = DELETE attempts of this generation not yet resolved, or "unknown" when
 *  the home cannot enumerate them (any Keep after a restore or legacy adoption, or an attempt list lost). Polls for 24 h, then
 *  event-only (tiny row). */
export interface KeepGuard {
  inboxId: InboxId; botId: BotId; gen: Generation; keepOp: OpId; keptAtMs: number; pollUntilMs: number;
  unresolved: AttemptId[] | "unknown"; lastCheckedAtMs: number | null;
}

export interface RotationCursor { botId: BotId; opId: OpId; oldKeyId: KeyId | null; newKeyId: KeyId | null; authorityId: AuthorityId }
export interface PendingLifecycle { eventId: EventId; inboxId: InboxId; type: FluxEventType }

export interface LocalDb {
  tablesPresent: boolean;
  bindings: Record<BotId, Binding>;
  intents: Record<BotId, Intent>;
  parks: Record<ParkId, Park>;
  leases: Record<RemovalId, Lease>;
  keepOps: Record<OpId, KeepOp>;
  keepGuards: Record<InboxId, KeepGuard>;
  rotations: Record<BotId, RotationCursor>;
  pendingLifecycle: PendingLifecycle[];
  keptKeys: Record<KeyId, AuthorityId>;
  savedKeys: Record<BotId, KeyId | null>; // the secrets file: a separate durable write
  /** r3.3g (Astra r3.3f #2, design (i) fail closed): kept entries a window-ending prep could not prove current (no carry holds the key),
   *  each with the step of the prep that marked it. Written in the prep's commit; cleared only by a new owner Keep naming the key or the
   *  entry's legitimate departure. Lives in the home database (no new store); a non-blind swap's carry holds it. */
  unconfirmedKept?: Record<KeyId, number>;
  /** r3.4b (Opus check N2): the job's two DATABASE marks (the job itself lives in the journal HomeFs.restoreJob). swappedJobId is
   *  written into the STAGED incoming database before W3 renames it into place (W27), so archive and mark land together; preparedJobId
   *  is a row of the prep's own transaction W4 (W28). Each names a journal id; a mark naming an old id is inert. */
  swappedJobId?: string | null;
  preparedJobId?: string | null;
}

/** r3.4 (redesign of the restore window; Astra r3.3i #3, #4, Fable F1, F3, F4): every restore (owner, system, blind) runs as ONE durable
 *  job in the home database. Each phase change is its own durable write: armed W25, captured W26 (after the carry W23), swapped W27
 *  (written into the STAGED incoming database before W3 renames it into place, so archive and phase land together), prepared W28 (a row
 *  of the prep's own transaction W4), aborted W29, cleared W30 (after the carry delete W24). `at` = the step of the latest phase write.
 *  The window is phases armed, captured and swapped; prepared / aborted are finished and wait only to be cleared. */
/** r3.4b (Opus check N2): the job record lives in the durable SIDECAR JOURNAL HomeFs.restoreJob (JOURNAL_NAME, beside the install,
 *  outside the restored tree), written by atomic replace (tmp file, fsync, rename) for EVERY restore, blind included (a blind restore has
 *  no outgoing database to hold it). The journal stores phases armed (W25), captured (W26) and aborted (W29) and is unlinked by the clear
 *  (W30). swapped and prepared are DATABASE marks, never journal writes: LocalDb.swappedJobId (W27) and LocalDb.preparedJobId (W28 in
 *  W4). jobOf() is the journal with its effective phase: prepared if preparedJobId names it, else swapped if swappedJobId names it, else
 *  the journal's own phase. Boot reconciles: journal and preparedJobId === journal.id -> the prep committed: delete the carry, unlink
 *  the journal; journal not prepared -> resume from its effective phase or abort; no journal -> no job. This is Fable r3.3i F1's design
 *  (a flag that carries an id, the prepared id in the prep's transaction, boot unlinks the stale flag). */
export const JOURNAL_NAME = "restore-job.json";
export type RestoreJobPhase = "armed" | "captured" | "swapped" | "prepared" | "aborted";
/** r3.4d (M-3, A-ARCHIVE-DIGEST): archiveId IS the verified content digest of the archive; the same id names the same bytes. */
export interface RestoreJob { id: string; archiveId: ArchiveId; source: "desktop" | "cloud_reset" | "cloud_undo"; phase: RestoreJobPhase; at: number }

/** Pre-swap capture of the OUTGOING home (Q2, F4-H1 production note). Written BEFORE the swap to a sidecar OUTSIDE the restored tree
 *  (desktop: beside the install, not in the data dir; Cloud: beside `home`, written in `mark_restored` before `swap_in`), fsynced,
 *  deleted only after the prep that consumes it commits. `complete` = every table was read.
 *  r3 (A5-H2): `removals` = every in-flight or queued removal of the outgoing home (authorized-but-unsent included) with its evidence;
 *  `blindPending` (F5-M2) = the outgoing home was still inside an unconfirmed, unlisted blind restore, so the fence carries over.
 *  r3.2 (Fable L8): `blindPending` is a PRODUCTION note checked only at the swap; every predicate derives the fence from ghost. */
export interface CarriedRemoval { target: TargetRef; botId: BotId | null; inboxId: InboxId | null; provisionOpId: OpId | null; evidence: boolean }
export interface CarryRecord {
  carryId: CarryId; capturedAtStep: number; forEpoch: number; complete: boolean;
  keyIds: KeyId[]; inboxIds: InboxId[]; provisionOps: OpId[]; keepGuards: KeepGuard[]; keptKeys: Record<KeyId, AuthorityId>;
  outstandingDeletes: { inboxId: InboxId; attemptId: AttemptId }[];
  removals: CarriedRemoval[]; blindPending: boolean;
  /** r3.3g: the outgoing home's LocalDb.unconfirmedKept, carried so a later restore cannot launder a mark away. */
  unconfirmedKept?: Record<KeyId, number>;
  /** r3.4b (Opus check N1): the job whose ARMED capture wrote this carry. Only that job's window-ending prep consumes it. */
  jobId?: string | null;
}

/** r3.4: the r3.3i flag HomeFs.restorePending is REMOVED. r3.4b (N2): the job record is the journal HomeFs.restoreJob (JOURNAL_NAME). */
export interface HomeFs { liveMarker: { resetId: string } | null; stagedMarker: { resetId: string } | null; messagesDbPresent: boolean; restoreJob?: RestoreJob | null;
  /** r3.4c (Opus check M3): archives downloaded and VERIFIED locally (beside the install); a job arms only for one of these. */
  localArchives?: ArchiveId[] }
export interface ProcessState { processId: number; phase: "down" | "boot_prep" | "store_open" | "running"; emailOn: boolean }
export interface Bot { botId: BotId; present: boolean }

// ---------- Flux (fixed provider contract) ---------------------------------------------------------------------------------------

export type FluxInboxState = "active" | "closing" | "purged";
export type DeleteReason = "owner" | "bot_deleted";
export type FluxCloseReason = "account_disabled" | "billing" | "support";
export type ClosingCause = { kind: "delete"; requestId: RequestId; reason: DeleteReason } | { kind: "flux"; reason: FluxCloseReason };
export interface FluxInbox {
  inboxId: InboxId; installOwned: boolean; createdUnderOp: OpId | null; forBot: BotId | null; address: string;
  state: FluxInboxState; closingCause: ClosingCause | null; closingSinceMs: number | null; closingSinceStep: number | null;
}
export interface FluxKey { keyId: KeyId; installOwned: boolean; mintedUnderOp: OpId | null; forBot: BotId; state: "live" | "revoked" }

export type RemoteKind = "DELETE_INBOX" | "REVOKE_KEY" | "RESTORE_INBOX" | "GET_INBOX" | "CREATE_INBOX" | "MINT_KEY" | "LIST_ACCOUNT";
export type RequestPurpose = "removal" | "keep" | "guard" | "rotation" | "provision" | "poll" | "view" | "discovery";
export type AnswerResult = "ok" | "accepted" | "not_found" | "refused" | "uncertain";
/** Lives in Flux state: survives restore, reset, undo and crash (A3-H1). Duplicates are separate records with `copyOf`. */
export interface RemoteRequest {
  requestId: RequestId; copyOf: RequestId | null; kind: RemoteKind; purpose: RequestPurpose;
  target: InboxId | KeyId | OpId; credential: "owner" | "bot_key";
  removalId: RemovalId | null; attemptId: AttemptId | null; authorityId: AuthorityId | null; keepOp: OpId | null;
  sentAtStep: number; sentAtMs: number; sentInProcess: number; sentInEpoch: number;
  flux: "held" | "applied"; appliedAtMs: number | null;
  answer: "pending" | "lost" | "delivered";
  answerSeen: { atStep: number; result: AnswerResult; fluxStateSeen: FluxInboxState | null } | null;
  listingComplete?: boolean; // LIST_ACCOUNT only
}

export type FluxEventType = "email.inbox.closing" | "email.inbox.deleted" | "email.inbox.restored";
export interface FluxEvent {
  eventId: EventId; type: FluxEventType; inboxId: InboxId; atMs: number; atStep: number; deliveredToHome: boolean;
  reason: DeleteReason | FluxCloseReason | null;
}
export interface FluxSemantics {
  restoreCredential: "owner"; // FLUX FACTS: restore authenticates with the owner key only
  deleteIdempotencyKeyHonoured: boolean; // R2-Q2, both values explored
  listingShipped: boolean; // inboxes?include=closing + GET bot-keys (F-BACKFILL); per account
}
/** MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md.
 * One physical RESTORE per logical id. Transport copies share this committed outcome. */
export interface RestoreOutcome { requestId: RequestId; target: InboxId; committedAtStep: number; answer: AnswerResult; code: string | null; fluxStateSeen: FluxInboxState | null }
export interface FluxState { inboxes: Record<InboxId, FluxInbox>; keys: Record<KeyId, FluxKey>; requests: RemoteRequest[]; events: FluxEvent[]; semantics: FluxSemantics; restoreOutcomes?: Record<RequestId, RestoreOutcome> }

// ---------- Owner surface ------------------------------------------------------------------------------------------------------------

export type OwnerActionKind = "keep" | "remove" | "try_again_now" | "confirm_inventory";
export interface SurfaceAction { kind: OwnerActionKind; tokenId: TokenId | null; enabled: boolean }
export interface SurfaceRow {
  section: "bot" | "parked" | "kept" | "key_only" | "other_setup" | "removing" | "restore_check" | "home"; // r3.3h: "home" = the home-level line
  target: TargetRef | null; botId: BotId | null; inboxId: InboxId | null; keyIds: KeyId[]; provisionOpId: OpId | null;
  address: string | null; // r3.4d: the address a row (and so every token minted on it) displays; always the row binding or park own address
  visible: boolean; line: string; actions: SurfaceAction[];
}

export type ArchiveKind = "desktop_backup" | "desktop_export" | "cloud_restic" | "cloud_export" | "cloud_snapshot_for_undo";
export interface Archive { archiveId: ArchiveId; kind: ArchiveKind; topLevelNames: string[] }
export interface OpsLine {
  kind: "blip" | "guard_restore" | "guard_refused" | "other"; bindingId: BotId | null; gen: Generation | null; text: string;
  window: { closingSinceMs: number; restoredAtMs: number | null } | null;
}

// ---------- Ghost history (checker-only) ---------------------------------------------------------------------------------------------

export type Principal = "owner_desktop" | "owner_browser" | "owner_phone" | "bot_credential" | "engine_credential" | "system";
export const OWNER_PRINCIPALS: ReadonlySet<Principal> = new Set<Principal>(["owner_desktop", "owner_browser", "owner_phone"]);

export interface TokenIssue {
  tokenId: TokenId; kind: "b" | "p" | "f" | "r"; // r = restore check (confirm inventory)
  botId: BotId | null; gen: Generation | null; park: { parkId: ParkId; parkRev: number } | null;
  shown: { target: TargetRef | null; address: string | null; inboxId: InboxId | null; keyIds: KeyId[] };
  issuedTo: Principal; issuedAtStep: number; issuedAtMs: number; processId: number; epoch: number;
}

export type AuthorityKind =
  | "remove_bot_section" | "remove_park" | "remove_orphan" | "remove_other_setup" | "remove_key_only"
  | "bot_delete_with_token" | "orphan_keep_key_release" | "rotate_reconnect" | "keep" | "confirm_inventory";
export const REMOVE_KINDS: ReadonlySet<AuthorityKind> = new Set<AuthorityKind>([
  "remove_bot_section", "remove_park", "remove_orphan", "remove_other_setup", "remove_key_only", "bot_delete_with_token",
]);
export const KEEP_KINDS: ReadonlySet<AuthorityKind> = new Set<AuthorityKind>(["keep", "orphan_keep_key_release"]);

/** Which authority kinds may send which request (A4-H2). Anything not listed is refused. */
export const OP_MATRIX: Record<"DELETE_INBOX" | "REVOKE_KEY" | "RESTORE_INBOX", ReadonlySet<AuthorityKind>> = {
  DELETE_INBOX: new Set<AuthorityKind>(["remove_bot_section", "remove_park", "remove_orphan", "remove_other_setup", "bot_delete_with_token"]),
  REVOKE_KEY: new Set<AuthorityKind>(["remove_bot_section", "remove_park", "remove_orphan", "remove_key_only", "bot_delete_with_token", "orphan_keep_key_release", "rotate_reconnect"]),
  RESTORE_INBOX: new Set<AuthorityKind>(["keep", "orphan_keep_key_release"]),
};

export interface AuthorityRecord {
  authorityId: AuthorityId; kind: AuthorityKind; principal: Principal; tokenId: TokenId | null;
  verifiedAtStep: number; verifiedAtMs: number; verifiedInProcess: number; epoch: number;
  botId: BotId | null; scope: { target: TargetRef | null; inboxId: InboxId | null; keyIds: KeyId[] };
  genAtVerify: Generation | null; parkAtVerify: { parkId: ParkId; parkRev: number } | null;
}

export interface KeepRecord {
  keepOp: OpId; botId: BotId; target: TargetRef; inboxId: InboxId | null; mode: KeepMode; authorityId: AuthorityId;
  claimedAtStep: number; succeededAtStep: number | null; succeededAtMs: number | null;
  confirmedBy: { requestId: RequestId; atStep: number } | null;
}

export interface RestoreRecord {
  atStep: number; atMs: number; epochAfter: number; source: "desktop" | "cloud_reset" | "cloud_undo"; archiveId: ArchiveId;
  blind: boolean; carryId: CarryId | null;
  /** r3.3 (A7-H1, ruling 1): step of the owner.restore this swap answers; null = an automatic / system restore nobody asked for. */
  ownerRequestStep: number | null;
  /** r3.4: the restore job this swap belongs to (recorder-written at the swap). */
  jobId?: string | null;
}
/** r3.3: an owner.restore request, written by the recorder in the owner.restore step itself; append-only. */
export interface OwnerRestoreRequest { atStep: number; source: RestoreRecord["source"]; archiveId: ArchiveId }

export interface Ghost {
  epoch: number; tokens: TokenIssue[]; authorities: AuthorityRecord[]; keeps: KeepRecord[]; restores: RestoreRecord[];
  usedKeepOps: OpId[]; preparedEpochs: number[]; inventoryConfirmedEpochs: number[]; preparedResets: string[];
  lastBootAtMs: number; lastParkOrRestoreStep: Record<BotId, number>;
  /** r3.1 (R3-Q4): step of the ok owner.deleteBot that deleted each bot; written once, by the recorder, never changed. */
  botDeletedAtStep: Record<BotId, number>;
  /** r3.3 (A7-H1): every owner.restore, in order. */
  ownerRestoreRequests: OwnerRestoreRequest[];
  /** r3.3a (A8-M1): per kept key, the newest Keep authority its entry has ever held. The recorder writes it whenever the entry is dropped
   *  or moved to an older Keep (the live entry counts while present, see keptHighWater); never removed, never lowered. */
  keptHighWater: Record<KeyId, AuthorityId>;
}

export interface World {
  step: number; nowMs: number;
  bots: Record<BotId, Bot>; local: LocalDb; carry: CarryRecord | null; fs: HomeFs; proc: ProcessState;
  flux: FluxState; surface: SurfaceRow[]; archives: Archive[]; ops: OpsLine[]; ghost: Ghost;
}

/** What the reducer may read (A4-M12). Never `flux` or `ghost`; remote truth reaches it only as delivered answers and events. */
export type ReducerView = Pick<World, "step" | "nowMs" | "bots" | "local" | "carry" | "fs" | "proc">;
/* r3.4 REDUCER OBLIGATIONS (restoreJobProtocol, restoreJobMatchesReality, carryImmutable, keptKeysProtected, admissionPinned,
 * quiescenceReachable). Each reads ReducerView only (local incl. swappedJobId / preparedJobId, carry incl. carry.jobId, fs incl. the journal fs.restoreJob, proc, bots, step, nowMs); none reads ghost or flux.
 *   R1 THE RESTORE JOB. Every restore, owner, system or blind, is the journal fs.restoreJob {id, archiveId, source, phase, at} (r3.4b) read through jobOf; at most one.
 *      Arm (W25): an admitted owner.restore, or a system restore (auto.restoreArm), writes phase armed before anything else; an
 *      owner.restore while a job is open is refused. Capture: only in phase armed; write the carry (W23), then phase captured (W26); a
 *      carry found in phase armed is a capture whose W26 was lost, and capturing again overwrites it. Swap: only the job's own archive and
 *      source, from captured, or from armed when there is no outgoing database (blind); write phase swapped into the STAGED incoming
 *      database (W27) before W3 renames it into place. Prep: the prep that ends the window (restore prep, or boot prep after a crash)
 *      writes phase prepared inside its own transaction (W28 in W4). r3.4c (M3): the archive is downloaded and verified BEFORE arming (auto.archiveFetch
 *      verified adds it to fs.localArchives); arm only an archive in fs.localArchives; a failed download is a pre-arm refusal: no job,
 *      nothing changed, the home row shows RESTORE_FAILED_LINE. Abort (auto.restoreAbort: archive unreadable, owner
 *      cancel; never download_failed, r3.4c): only from armed or captured; r3.4c (L2) first delete any STAGED incoming database (it may
 *      already hold swappedJobId from W27), then write phase aborted (W29) and nothing else; the home row shows RESTORE_FAILED_LINE. Clear: a
 *      prepared or aborted job is cleared (W30) after its carry is deleted (W24). Boot recovery reads the job and resumes it from its
 *      durable phase: armed -> capture (or swap if blind) or abort; captured -> swap or abort; swapped -> prep; prepared / aborted ->
 *      delete the carry and clear. No job is ever left in a phase: every job reaches prepared or aborted and is cleared.
 *      THE WINDOW is phases armed, captured and swapped. While open: send nothing; capture and swap only for this job; refuse EVERY owner
 *      decision (keep, remove, deleteBot, tryAgainNow, reconnect, confirmInventory, restore, r3.4b backup) with code restore_finishing and no other
 *      code, changing nothing in the world but the surface (bots, LocalDb, carry, files, process, archives, ops log all identical); each
 *      refusal shows RESTORE_FINISHING_LINE on the home row or the bot's own row; every owner view shows the home line, so it shows
 *      again after a crash. NO queue: a refused restore is not recorded and owes nothing. r3.4c (L3): an owner.restore while the job is
 *      prepared or aborted but not yet cleared is refused restore_finishing, pure, with RESTORE_FINISHING_LINE (the clear follows).
 *      r3.4c (M2): the job always progresses: it never waits on an owner, Flux or a held item, and reaches prepared or aborted within
 *      livenessBound automatic steps; held input is applied after that (r3.4d: heldInputDrains, within livenessBound automatic steps of the window's end; the
 *      job bound counts only the home's automatic steps and runs until the clear; the swap re-checks the job's archive is local).
 *      r3.4b (Opus check N1-N5). CARRY PROVENANCE: only the armed job's own capture creates or replaces a carry, stamped carry.jobId =
 *      job.id; a prep consumes the carry only when it ends the window (phase swapped) and carry.jobId names the job; a blind swap runs
 *      with no carry; arming needs no journal and no carry (a finished job is cleared first). JOURNAL: the job is the sidecar journal
 *      (JOURNAL_NAME) plus the database marks swappedJobId (W27) and preparedJobId (W28 in W4); boot reconciles both, a crash between
 *      the W4 commit and the journal unlink included. HELD INPUT: while the window is open the reducer applies no Flux event
 *      (auto.applyEvent) and takes no answer (net.answer): it neither applies nor acks them, so Flux keeps each event and each request
 *      stays answerable, and they are applied after the job is prepared or aborted (nothing is queued in the outgoing database, which the
 *      swap replaces). owner.backup is refused restore_finishing in the window like every other owner decision.
 *   R2 The prep that writes phase prepared RE-STAMPS every mark it leaves in local.unconfirmedKept: a key the carry marks gets the carried
 *      value (carry.unconfirmedKept[k]); every other kept entry no carry holds gets the prep's own step (v.step), whatever mark the swap
 *      brought. It cannot see ghost.keptHighWater, so it marks every uncarried kept entry and never clamps to an authority it cannot see.
 *      r3.4b: for the same reason KEEPING a kept entry (marked) is always legal for the reducer: the "Remove after its high-water"
 *      departure is a checker allowance the reducer never needs to use.
 *   R3 Outside that prep a mark's value never changes. It ends only (a) when the owner Keeps the key again (a Keep verified strictly after
 *      the mark's step), or (b) together with the entry leaving keptKeys, which is allowed only when Flux answered the key revoked or under
 *      an owner Remove verified strictly after the mark; that Remove still owes the revoke until it is done (the drop needs the Remove
 *      authority, the revoke is the Remove's own work). A Remove that is owed, or that ends skipped_in_use, keeps the entry and the mark.
 *      While marked, REVOKE_KEY is sent only under such a Remove, and every owner view shows RECONFIRM_KEPT_LINE on a "bot" section row
 *      (the bot holding the key, or, for a key no bot holds, a bot row naming the key). LOOK_AGAIN_LINE is ONLY the binding-changed Keep
 *      refusal. A Remove naming a key kept under a Keep admitted BEFORE that Remove is finished only by revoking the key (or while in use).
 *      r3.4b (N3): a prep that does not consume its job carry never re-creates an entry under a Keep that a later owner Remove ended.
 *      r3.4c (M1): such a prep owes no carry duty at all (it may leave a removed key out).
 *   R4 Capture copies local.unconfirmedKept (every kept key's mark, a key whose Remove is owed included) and local.keptKeys into the carry.
 *      The carry is SEALED: no field of it changes from its capture until the prep consumes it (or the clear of an aborted job deletes
 *      it). The prep that consumes it (the window-ending restore prep OR boot prep after a crash, and only for the job carry.jobId names, r3.4b) sets every carried kept key to EXACTLY its carried Keep,
 *      re-creating an entry the archive lacks, and every carried mark with its carried VALUE, unless a fresh owner Keep (R3 a) ended it.
 *      The sealed carried value is the authority: it is accepted even when the archive holds an older Keep or none. */

// ===================================================================================================================================
// 3. Actions
// ===================================================================================================================================

export type DurableWrite =
  | "W1_desktop_prep_tx" | "W2_marker_staged" | "W3_swap_record" | "W4_consumer_tx" | "W5_marker_unlink" | "W6_adoption_tx"
  | "W7_deletion_proof" | "W8_save_bots" | "W9_commit_or_orphanize" | "W10_authorize" | "W11_send_claim" | "W12_delete_answer"
  | "W13_keep_claim" | "W14_keep_done" | "W15_keep_rollback" | "W16_event_batch" | "W17_lifecycle_apply" | "W18_revoke_mark"
  | "W19_secret_clear" | "W20_keep_guard" | "W21_completion" | "W22_key_only_park" | "W23_carry_capture" | "W24_carry_delete"
  // r3.4 restore job phase writes (R1): armed, captured, swapped (into the staged database, before W3), prepared (inside W4), aborted, cleared
  // r3.4b (N2): W25 / W26 / W29 replace the journal atomically; W27 = LocalDb.swappedJobId (staged DB); W28 = LocalDb.preparedJobId (in W4); W30 unlinks the journal
  | "W25_job_armed" | "W26_job_captured" | "W27_job_swapped_staged" | "W28_job_prepared" | "W29_job_aborted" | "W30_job_cleared";

export type OwnerOutcome = { ok: true } | { ok: false; code: string };

export type Action =
  | { t: "owner.keep"; principal: Principal; botId: BotId; target: TargetRef; tokenId: TokenId | null; mode: KeepMode; outcome: OwnerOutcome }
  | { t: "owner.remove"; principal: Principal; botId: BotId | null; target: TargetRef; tokenId: TokenId | null; section: SurfaceRow["section"]; outcome: OwnerOutcome }
  | { t: "owner.deleteBot"; principal: Principal; botIds: BotId[]; tokens: Record<BotId, TokenId | null>; outcome: OwnerOutcome }
  | { t: "owner.tryAgainNow"; principal: Principal; botId: BotId; target: TargetRef; outcome: OwnerOutcome }
  | { t: "owner.reconnect"; principal: Principal; botId: BotId; tokenId: TokenId | null; outcome: OwnerOutcome }
  | { t: "owner.confirmInventory"; principal: Principal; tokenId: TokenId | null; outcome: OwnerOutcome }
  | { t: "owner.viewSurface"; principal: Principal }
  | { t: "owner.backup"; kind: ArchiveKind; outcome?: OwnerOutcome } // r3.4b (N5): absent = ok; refused restore_finishing while a restore window is open
  | { t: "owner.restore"; source: RestoreRecord["source"]; archiveId: ArchiveId; outcome?: OwnerOutcome } // r3.3h: absent = ok; refused while prepPending
  | { t: "auto.restoreArm"; source: RestoreRecord["source"]; archiveId: ArchiveId } // r3.4: a system restore nobody asked for arms its job
  | { t: "auto.restoreAbort"; reason: "download_failed" | "archive_unreadable" | "owner_cancel" } // r3.4: before the swap only; r3.4c: never download_failed
  | { t: "auto.archiveFetch"; archiveId: ArchiveId; outcome: "verified" | "download_failed" } // r3.4c (M3): download + verify, BEFORE arming
  | { t: "auto.restoreJobClear" } // r3.4: delete a finished job's carry (W24), then clear the job (W30)
  | { t: "auto.captureOutgoing" }
  | { t: "auto.swap"; source: RestoreRecord["source"]; archiveId: ArchiveId; blind: boolean }
  | { t: "auto.boot" }
  | { t: "auto.restorePrepare"; outcome: "committed" | "threw" }
  | { t: "auto.bootPrep"; outcome: "ok" | "threw" }
  | { t: "net.settle" } | { t: "auto.emailOn" } | { t: "auto.settle" } | { t: "auto.tick" }
  | { t: "auto.applyEvent"; eventId: EventId }
  | { t: "net.send"; request: RemoteRequest }
  | { t: "net.answer"; requestId: RequestId; result: AnswerResult; fluxStateSeen: FluxInboxState | null }
  | { t: "flux.apply"; requestId: RequestId }
  | { t: "flux.emit"; event: FluxEvent }
  | { t: "flux.close"; inboxId: InboxId; reason: FluxCloseReason }
  | { t: "flux.purge"; inboxId: InboxId }
  | { t: "fault.crash"; at: DurableWrite; when: "before" | "after" }
  | { t: "fault.loseAnswer"; requestId: RequestId }
  | { t: "fault.duplicate"; requestId: RequestId }
  | { t: "fault.reorder"; first: RequestId; second: RequestId }
  | { t: "fault.delayEvent"; eventId: EventId }
  | { t: "clock.advance"; ms: number };

export type ActionOrigin = "owner" | "automatic" | "remote" | "fault" | "clock";
export function originOf(a: Action): ActionOrigin {
  const p = a.t.slice(0, a.t.indexOf("."));
  if (p === "owner") return "owner";
  if (p === "flux") return "remote";
  if (p === "fault") return "fault";
  if (p === "clock") return "clock";
  return "automatic";
}

export type Verdict = { ok: true } | { ok: false; invariant: string; why: string; step: number };
export type StepInvariant = (prev: World, action: Action, next: World) => Verdict;
export type StateInvariant = (w: World) => Verdict;
export interface TraceStep { prev: World; action: Action; next: World }

const OK: Verdict = { ok: true };
const fail = (invariant: string, why: string, step: number): Verdict => ({ ok: false, invariant, why, step });

// ===================================================================================================================================
// 4. Helpers (pure)
// ===================================================================================================================================

export function sameGeneration(a: Generation | null, b: Generation | null): boolean {
  if (a === null || b === null) return a === b;
  return a.inboxId === b.inboxId && a.opId === b.opId && a.emailKeyRef === b.emailKeyRef && a.serial === b.serial;
}
export const values = <T>(r: Record<string, T>): T[] => Object.keys(r).map(k => r[k]);
const botPresent = (w: World, b: BotId | null): boolean => b !== null && !!w.bots[b]?.present;
const leasesOn = (w: World, t: TargetRef): Lease[] => values(w.local.leases).filter(l => l.target === t);
const keepsOn = (w: World, t: TargetRef): KeepOp[] => values(w.local.keepOps).filter(k => k.target === t);
const parksOn = (w: World, t: TargetRef): Park[] => values(w.local.parks).filter(p => p.target === t);
const authorityById = (w: World, id: AuthorityId | null) => (id === null ? undefined : w.ghost.authorities.find(a => a.authorityId === id));
const tokenById = (w: World, id: TokenId | null) => (id === null ? undefined : w.ghost.tokens.find(t => t.tokenId === id));
/** r3.3e (Astra r3.3d Medium): the bot a token speaks for: a b token's botId; a p token's park's bot (else its own botId). ONE resolution,
 *  shared by tokenProblem and deletedBotAuthorityDead so the two can never drift apart. */
const tokenBot = (w: World, t: TokenIssue): BotId | null => t.kind === "b" ? t.botId : t.park ? w.local.parks[t.park.parkId]?.botId ?? t.botId : t.botId;
const isParked = (s: ParkState): boolean => s === "parked" || s === "parked_evidence";
const newAuthorities = (prev: World, next: World) => next.ghost.authorities.slice(prev.ghost.authorities.length);
const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
/** A complete Flux listing answered after restore `r` (F-BACKFILL; per account). */
export const listedSince = (w: World, r: RestoreRecord): boolean => w.flux.semantics.listingShipped && w.flux.requests.some(x =>
  x.kind === "LIST_ACCOUNT" && x.sentAtStep > r.atStep && x.answerSeen?.result === "ok" && x.listingComplete === true);
/** r3.3 (A7-H1, ruling 1): an OWNER restore requested after `step` has swapped in (ownerRequestStep > step). */
export const ownerRestoredAfter = (w: World, step: number): boolean => w.ghost.restores.some(r => r.ownerRequestStep !== null && r.ownerRequestStep > step);
/** Blind restores the owner has not confirmed in that epoch or any later one (F5-M2: a later restore does not lift it). */
export const unconfirmedBlindRestores = (w: World): RestoreRecord[] =>
  w.ghost.restores.filter(r => r.blind && !w.ghost.inventoryConfirmedEpochs.some(e => e >= r.epochAfter));
export const blindUnconfirmed = (w: World): boolean => unconfirmedBlindRestores(w).length > 0;
/** Ruling Q2 fence: an unconfirmed blind restore with no complete listing since it. */
export const blindFenced = (w: World): boolean => unconfirmedBlindRestores(w).some(r => !listedSince(w, r));
/** R2-Q4 / A5-H5 / F5-M1: after the latest blind restore, discovery is pending until a complete listing is answered (for ever while
 *  the listing has not shipped). While pending, entries unknown to the home are not demanded as rows or records. */
export const discoveryPending = (w: World): boolean => {
  const blinds = w.ghost.restores.filter(r => r.blind);
  return blinds.length > 0 && !listedSince(w, blinds[blinds.length - 1]);
};
const restoreCheckRow = (w: World): boolean => w.surface.some(r => r.visible && r.section === "restore_check" && r.actions.some(a => a.enabled && a.kind === "confirm_inventory"));
/** An entry unknown to the home is excused ONLY while discovery is pending (no complete listing answered since the latest blind
 *  restore): covered by the restore-check row while unconfirmed, or owner-confirmed. r3.2 (A6-M2): once a complete listing has been
 *  delivered, nothing is excused, confirmed or not: every listed inbox and key needs its row and durable record. */
const unknownExcused = (w: World): boolean => discoveryPending(w) && (!blindUnconfirmed(w) || restoreCheckRow(w));
/** Target of a destructive or keep request. */
const requestTarget = (w: World, r: RemoteRequest): TargetRef | null => {
  if (r.kind === "DELETE_INBOX" || r.kind === "RESTORE_INBOX" || r.kind === "GET_INBOX") return inboxTarget(r.target);
  const a = authorityById(w, r.authorityId);
  return a?.scope.target ?? null;
};
/** Inbox targets a target ref covers (an op target covers the inbox created under that op, if any). */
const inboxOfTarget = (w: World, t: TargetRef): InboxId | null => {
  if (t.startsWith("inbox:")) return t.slice(6);
  if (t.startsWith("op:")) { const op = t.slice(3); const fi = values(w.flux.inboxes).find(i => i.createdUnderOp === op); return fi ? fi.inboxId : null; }
  return null;
};

export function locallyReferencedKeys(db: LocalDb): Set<KeyId> {
  const s = new Set<KeyId>();
  for (const b of values(db.bindings)) if (b.gen.emailKeyRef) s.add(b.gen.emailKeyRef);
  for (const k of values(db.savedKeys)) if (k) s.add(k);
  for (const i of values(db.intents)) if (i.keyId && i.phase !== "removed") s.add(i.keyId);
  for (const p of values(db.parks)) for (const t of p.keyTargets) if (t.status !== "revoked") s.add(t.keyId);
  for (const l of values(db.leases)) for (const t of l.keyTargets) if (t.status !== "revoked") s.add(t.keyId);
  for (const r of values(db.rotations)) { if (r.oldKeyId) s.add(r.oldKeyId); if (r.newKeyId) s.add(r.newKeyId); }
  for (const k of Object.keys(db.keptKeys)) s.add(k);
  return s;
}
export function locallyReferencedOps(db: LocalDb): Set<OpId> {
  const s = new Set<OpId>();
  for (const b of values(db.bindings)) if (b.gen.opId) s.add(b.gen.opId);
  for (const p of values(db.parks)) if (p.provisionOpId) s.add(p.provisionOpId);
  for (const r of values(db.rotations)) s.add(r.opId);
  return s;
}
export function locallyReferencedInboxes(db: LocalDb): Set<InboxId> {
  const s = new Set<InboxId>();
  for (const b of values(db.bindings)) if (b.gen.inboxId) s.add(b.gen.inboxId);
  for (const p of values(db.parks)) if (p.inboxId) s.add(p.inboxId);
  for (const l of values(db.leases)) if (l.inboxId && !l.foreign) s.add(l.inboxId);
  for (const g of values(db.keepGuards)) s.add(g.inboxId);
  return s;
}
/** RV1: a key another live generation, another present bot's saved key, or a rotation uses. */
export function keyInUse(w: World, key: KeyId, exceptBot: BotId | null): boolean {
  for (const b of values(w.local.bindings)) if (b.botId !== exceptBot && b.gen.emailKeyRef === key && b.state !== "removal_parked" && botPresent(w, b.botId)) return true;
  for (const bot of Object.keys(w.local.savedKeys)) if (bot !== exceptBot && w.local.savedKeys[bot] === key && botPresent(w, bot)) return true;
  for (const r of values(w.local.rotations)) if (r.botId !== exceptBot && (r.oldKeyId === key || r.newKeyId === key)) return true;
  return false;
}
/** Every in-flight or queued removal of a database, one entry per target (A5-H2): removing / remove_requested / removal_parked
 *  bindings, uncommitted-or-committed intents, parks, non-foreign leases (authorized-but-unsent included), with deletion evidence. */
export function queuedRemovals(db: LocalDb): CarriedRemoval[] {
  const byTarget = new Map<TargetRef, CarriedRemoval>();
  const add = (r: CarriedRemoval) => { const x = byTarget.get(r.target); if (x) x.evidence = x.evidence || r.evidence; else byTarget.set(r.target, { ...r }); };
  const tgt = (inbox: InboxId | null, op: OpId | null, bot: BotId): TargetRef => (inbox ? inboxTarget(inbox) : op ? opTarget(op) : botTarget(bot));
  for (const b of values(db.bindings)) if (b.state === "removing" || b.state === "remove_requested" || b.state === "removal_parked")
    add({ target: tgt(b.gen.inboxId, b.gen.opId, b.botId), botId: b.botId, inboxId: b.gen.inboxId, provisionOpId: b.gen.opId, evidence: false });
  for (const i of values(db.intents)) if (i.phase !== "removed") {
    const g = db.bindings[i.botId]?.gen; const inbox = i.inboxId ?? g?.inboxId ?? null;
    add({ target: tgt(inbox, g?.opId ?? null, i.botId), botId: i.botId, inboxId: inbox, provisionOpId: g?.opId ?? null, evidence: false });
  }
  for (const p of values(db.parks)) add({ target: p.target, botId: p.botId, inboxId: p.inboxId, provisionOpId: p.provisionOpId, evidence: p.remoteDeletedAtMs !== null || p.state === "parked_evidence" });
  for (const l of values(db.leases)) if (!l.foreign) add( // r3.3 (FA-L2): botless other-setup removals too
    { target: l.target, botId: l.botId, inboxId: l.inboxId, provisionOpId: null, evidence: l.phase === "gone" });
  return [...byTarget.values()];
}
const guardContent = (g: KeepGuard) => JSON.stringify([g.inboxId, g.botId, g.gen, g.keepOp, g.keptAtMs, g.pollUntilMs, g.unresolved]);
/** `next` keeps at least the protection of `was` (A5-H3): same Keep op and generation; "unknown" stays "unknown"; a list may become
 *  "unknown" or keep every attempt. */
const guardAtLeast = (was: KeepGuard, now: KeepGuard | undefined): boolean => {
  if (!now || now.keepOp !== was.keepOp || !sameGeneration(now.gen, was.gen)) return false;
  if (was.unresolved === "unknown") return now.unresolved === "unknown";
  const nu = now.unresolved;
  return nu === "unknown" || was.unresolved.every(a => nu.includes(a));
};
export function carryCovers(db: LocalDb, c: CarryRecord): boolean {
  if (!c.complete) return false;
  for (const k of locallyReferencedKeys(db)) if (!c.keyIds.includes(k)) return false;
  for (const i of locallyReferencedInboxes(db)) if (!c.inboxIds.includes(i)) return false;
  for (const o of locallyReferencedOps(db)) if (!c.provisionOps.includes(o)) return false;
  for (const g of values(db.keepGuards)) if (!guardAtLeast(g, c.keepGuards.find(x => x.inboxId === g.inboxId))) return false; // contents, A5-H3
  for (const k of Object.keys(db.keptKeys)) if (c.keptKeys[k] !== db.keptKeys[k]) return false;
  for (const l of values(db.leases)) for (const at of l.attempts) if (l.inboxId && !c.outstandingDeletes.some(d => d.attemptId === at)) return false;
  for (const r of queuedRemovals(db)) if (!c.removals.some(x => x.target === r.target && (x.evidence || !r.evidence))) return false; // A5-H2
  return true;
}

/** Token kinds each authority kind accepts (A5-H1): Reconnect, bot-row Remove and bot delete sign the FULL generation (b) only. */
export const TOKEN_KINDS_FOR: Record<AuthorityKind, ReadonlyArray<TokenIssue["kind"]>> = {
  remove_bot_section: ["b"], bot_delete_with_token: ["b"], rotate_reconnect: ["b"], remove_park: ["p"], remove_other_setup: ["f"],
  remove_key_only: ["b", "p"], orphan_keep_key_release: ["b", "p"], remove_orphan: ["b", "p", "f"], keep: ["b", "p", "f"], confirm_inventory: ["r"],
};

/**
 * The single authority-validation rule (A4-H1, F4-L2). An authority is valid only if it was created in a step whose action is the
 * owner action of the matching kind, with an ok outcome, by an owner principal, with the token that action carried; the token was
 * minted by THIS process in THIS restore epoch for an owner, unexpired, after the target's latest park or restore; it signs the
 * CURRENT full generation (b) or park revision (p); and the authority's scope equals what the token showed.
 */
export function authorityCreationVerdict(prev: World, action: Action, next: World, a: AuthorityRecord): string | null {
  const okAction = (t: Action["t"], kinds: AuthorityKind[]) => action.t === t && kinds.includes(a.kind);
  const kindOk =
    okAction("owner.keep", ["keep", "orphan_keep_key_release"]) ||
    okAction("owner.remove", ["remove_bot_section", "remove_park", "remove_orphan", "remove_other_setup", "remove_key_only"]) ||
    okAction("owner.deleteBot", ["bot_delete_with_token"]) ||
    okAction("owner.reconnect", ["rotate_reconnect"]) ||
    okAction("owner.confirmInventory", ["confirm_inventory"]);
  if (!kindOk) return `authority kind ${a.kind} not created by its owner action (${action.t})`;
  if (!("outcome" in action) || typeof action.outcome !== "object" || !action.outcome.ok) return "authority created by a refused action"; // tsc r3
  if (!("principal" in action) || action.principal !== a.principal || !OWNER_PRINCIPALS.has(a.principal)) return `principal ${a.principal} is not the acting owner`;
  const carried = action.t === "owner.deleteBot" ? (a.botId !== null ? action.tokens[a.botId] ?? null : null) : "tokenId" in action ? action.tokenId : null;
  if (a.tokenId !== carried) return "authority token differs from the token the action carried";
  if (a.verifiedAtStep !== next.step || a.verifiedAtMs !== prev.nowMs || a.verifiedInProcess !== prev.proc.processId || a.epoch !== prev.ghost.epoch)
    return "authority stamps (step, time, process, epoch) are not this step's";
  // A5-H1: the authority is the owner's ACTUAL choice: its bot and target are the action's.
  const actBot: BotId | null = action.t === "owner.deleteBot" ? (a.botId !== null && action.botIds.includes(a.botId) ? a.botId : "\u0000none") : "botId" in action ? action.botId : null;
  if (a.botId !== actBot) return `authority bot ${a.botId} is not the bot the owner acted on`;
  if ("target" in action && a.scope.target !== action.target) return `authority scope ${a.scope.target} is not the owner's target ${action.target}`;
  if (a.tokenId === null) {
    if (a.kind === "keep" && action.t === "owner.keep" && (action.mode === "bot_section" || action.mode === "live" || action.mode === "flux_closing")) { // R2-Q5
      const cur = a.botId !== null ? prev.local.bindings[a.botId]?.gen ?? null : null;
      if (!cur || a.scope.inboxId !== cur.inboxId || !a.scope.keyIds.every(k => k === cur.emailKeyRef)) return "untokened Keep scope exceeds the bot's current binding (F5-L5)";
      return null;
    }
    return `authority ${a.kind} needs an owner-seen token`;
  }
  const t = tokenById(prev, a.tokenId);
  if (!t) return "token was never minted";
  if (!TOKEN_KINDS_FOR[a.kind].includes(t.kind)) return `${a.kind} cannot be authorized by a ${t.kind} token (A5-H1)`;
  if (!OWNER_PRINCIPALS.has(t.issuedTo)) return `token shown to ${t.issuedTo}`;
  if (t.processId !== prev.proc.processId) return "token minted by an earlier process";
  if (t.epoch !== prev.ghost.epoch) return "token minted before a restore";
  if (prev.nowMs > t.issuedAtMs + TOKEN_TTL_MS) return "token expired";
  if (a.botId !== null && t.issuedAtStep <= (prev.ghost.lastParkOrRestoreStep[a.botId] ?? -1)) return "token predates the latest park or restore";
  if (a.scope.target !== t.shown.target || a.scope.inboxId !== t.shown.inboxId) return "scope target differs from the token's";
  if (!a.scope.keyIds.every(k => t.shown.keyIds.includes(k))) return "scope keys exceed the token's";
  if (t.kind === "b") {
    const cur = a.botId !== null ? prev.local.bindings[a.botId]?.gen ?? null : null;
    if (t.botId !== a.botId) return "b token signs another bot";
    if (!sameGeneration(t.gen, cur) || !sameGeneration(a.genAtVerify, cur)) return "token or authority does not sign the CURRENT full generation";
    if (a.kind === "rotate_reconnect" && (a.scope.keyIds.length !== 1 || a.scope.keyIds[0] !== cur?.emailKeyRef)) return "rotation scope must be exactly the current (old) key";
  } else if (t.kind === "p") {
    const p = t.park ? prev.local.parks[t.park.parkId] : undefined;
    if (!p || !t.park || p.parkRev !== t.park.parkRev || !a.parkAtVerify || a.parkAtVerify.parkId !== p.parkId || a.parkAtVerify.parkRev !== p.parkRev)
      return "token or authority does not sign the CURRENT park revision";
    if (p.target !== a.scope.target) return "park token used on another target";
    if (p.botId !== a.botId) return "park token used for another bot";
  } else if (t.kind === "f") {
    if (a.scope.keyIds.length) return "other-setup token authorizes no key";
  }
  return null;
}
/** Validity of an authority, by replaying its creation step in the trace. An authority already in the trace's INITIAL ghost was
 *  written by the checker's initial-state generator, which emits only valid histories (F5-L4, R3-Q3). */
export function authorityValidInTrace(trace: readonly TraceStep[], id: AuthorityId): boolean {
  for (const s of trace) {
    const a = newAuthorities(s.prev, s.next).find(x => x.authorityId === id);
    if (a) return authorityCreationVerdict(s.prev, s.action, s.next, a) === null;
  }
  return trace.length > 0 && trace[0].prev.ghost.authorities.some(x => x.authorityId === id);
}

/**
 * R3-Q3 condition (r3.1, BINDING). The rule above trusts the initial ghost, so the HARNESS GENERATOR MUST CHECK THAT EVERY INITIAL
 * STATE IS REACHABLE THROUGH A VALID HISTORY. Exactly: (1) every initial state is produced by replaying a trace from an empty home (or
 * from a 1.0.18 pre-preparation shape, whose ghost is empty) on which `checkTrace` returns [] — reachability is a property of a
 * history, not of a World, so this replay is the generator's obligation; and (2) `initialStateValid(w)` returns null on that state,
 * the harness aborting the run otherwise. (2) is the World-only necessary part: it re-checks each recorded authority against the
 * token it names, and each Keep record, Keep op, lease, kept key and bot deletion against the authority history. Returns the first
 * reason the ghost cannot have been written by a valid run, or null.
 */
export function initialStateValid(w: World): string | null {
  const g = w.ghost;
  if (g.restores.some(r => r.epochAfter > g.epoch) || g.preparedEpochs.some(e => e > g.epoch) || g.inventoryConfirmedEpochs.some(e => e > g.epoch))
    return "an epoch is recorded beyond the current one";
  for (const r of g.restores) if (r.ownerRequestStep !== null && !g.ownerRestoreRequests.some(q => q.atStep === r.ownerRequestStep && q.atStep < r.atStep))
    return `restore at step ${r.atStep} names no earlier owner restore request (A7-H1)`;
  for (const t of g.tokens) {
    if (!OWNER_PRINCIPALS.has(t.issuedTo)) return `token ${t.tokenId} shown to ${t.issuedTo}`;
    if (t.issuedAtStep > w.step || t.issuedAtMs > w.nowMs || t.epoch > g.epoch) return `token ${t.tokenId} issued in the future`;
  }
  for (const a of g.authorities) {
    if (!OWNER_PRINCIPALS.has(a.principal)) return `authority ${a.authorityId} by ${a.principal}`;
    if (a.verifiedAtStep > w.step || a.verifiedAtMs > w.nowMs || a.epoch > g.epoch) return `authority ${a.authorityId} verified in the future`;
    if (a.tokenId === null) { if (a.kind !== "keep") return `authority ${a.authorityId} (${a.kind}) has no token`; continue; }
    const t = g.tokens.find(x => x.tokenId === a.tokenId);
    if (!t) return `authority ${a.authorityId} names token ${a.tokenId} that was never minted`;
    if (!TOKEN_KINDS_FOR[a.kind].includes(t.kind)) return `authority ${a.authorityId}: ${a.kind} cannot use a ${t.kind} token`;
    if (t.issuedAtStep > a.verifiedAtStep || t.epoch !== a.epoch || t.processId !== a.verifiedInProcess || a.verifiedAtMs > t.issuedAtMs + TOKEN_TTL_MS)
      return `authority ${a.authorityId} not verified while its token was fresh`;
    if (a.scope.target !== t.shown.target || a.scope.inboxId !== t.shown.inboxId || !a.scope.keyIds.every(k => t.shown.keyIds.includes(k)))
      return `authority ${a.authorityId} scope exceeds its token`;
    if (t.kind === "b" && t.botId !== a.botId) return `authority ${a.authorityId}: b token signs another bot`;
    const del = a.botId !== null ? g.botDeletedAtStep[a.botId] : undefined;
    if (del !== undefined && a.verifiedAtStep > del && t.issuedAtStep <= del) return `authority ${a.authorityId} uses a token of a deleted bot (R3-Q4)`;
  }
  const auth = (id: AuthorityId) => g.authorities.find(a => a.authorityId === id);
  for (const k of g.keeps) {
    const a = auth(k.authorityId);
    if (!a || !KEEP_KINDS.has(a.kind) || a.scope.target !== k.target || k.claimedAtStep < a.verifiedAtStep) return `Keep ${k.keepOp} has no prior Keep authority on its target`;
    if ((k.succeededAtStep === null) !== (k.succeededAtMs === null)) return `Keep ${k.keepOp} success step and time not written together`;
    if (!g.usedKeepOps.includes(k.keepOp)) return `Keep ${k.keepOp} not in usedKeepOps`;
  }
  for (const op of values(w.local.keepOps)) if (!g.keeps.some(k => k.keepOp === op.keepOp && k.authorityId === op.authorityId)) return `Keep op ${op.keepOp} has no Keep history`;
  for (const l of values(w.local.leases)) {
    if (l.foreign) continue;
    const a = auth(l.authorityId);
    if (!a || !REMOVE_KINDS.has(a.kind) || a.scope.target !== l.target) return `lease ${l.removalId} has no Remove authority on its target`;
  }
  for (const k of Object.keys(w.local.keptKeys)) { const a = auth(w.local.keptKeys[k]); if (!a || a.kind !== "keep" || !a.scope.keyIds.includes(k)) return `kept key ${k} has no Keep naming it`; }
  for (const k of Object.keys(g.keptHighWater)) { const a = auth(g.keptHighWater[k]); if (!a || a.kind !== "keep" || !a.scope.keyIds.includes(k)) return `kept key ${k} high-water names no Keep naming it`; }
  for (const b of Object.keys(g.botDeletedAtStep)) {
    if (g.botDeletedAtStep[b] > w.step) return `bot ${b} deleted in the future`;
    if (w.bots[b]?.present) return `bot ${b} recorded deleted but present`;
  }
  return null;
}

const requestOpen = (r: RemoteRequest): boolean => r.flux === "held" || (r.answer === "pending" && r.copyOf === null);
const eventDeliveredBy = (suffix: readonly TraceStep[], i: number, e: FluxEvent): boolean =>
  e.deliveredToHome || suffix.slice(0, i + 1).some(s => s.action.t === "auto.applyEvent" && s.action.eventId === e.eventId);
/** After suffix step i the environment has DRAINED: every request (including those the home created during the suffix, A5-M9) is
 *  applied and answered, every event delivered, the home runs, and a tick followed the last remote delivery. */
export function drainedAt(suffix: readonly TraceStep[], i: number): boolean {
  const w = suffix[i].next;
  if (w.proc.phase !== "running") return false;
  if (w.flux.requests.some(requestOpen)) return false;
  if (w.flux.events.some(e => !eventDeliveredBy(suffix, i, e))) return false;
  let lastRemote = -1;
  for (let j = 0; j <= i; j++) if (suffix[j].action.t === "net.answer" || suffix[j].action.t === "auto.applyEvent") lastRemote = j;
  return suffix.slice(lastRemote + 1, i + 1).some(s => s.action.t === "auto.tick");
}
/** r3.3 (A7-M3): the indices of `suffix` at which some request or event is LATE: outstanding for PROMPT_STEPS suffix steps, or
 *  past its named assumption in time (a request: A-ANSWER-RTT after its send; an event: A-EVENT-5MIN after it was emitted). */
export function itemLate(suffix: readonly TraceStep[]): number[] {
  const first = new Map<string, number>(), late: number[] = [];
  for (let i = 0; i < suffix.length; i++) {
    const w = suffix[i].next;
    let isLate = false;
    const held = windowOpen(w); // MUTANT held-counts-late
    for (const r of w.flux.requests) {
      if (!first.has(r.requestId)) first.set(r.requestId, suffix[0].prev.flux.requests.some(x => x.requestId === r.requestId) ? 0 : i);
      if (held && r.flux !== "held") continue; // r3.4c (M2a): an answer the open window holds is the home's hold, not late
      if (requestOpen(r) && (i - first.get(r.requestId)! >= PROMPT_STEPS || w.nowMs - r.sentAtMs > ENV_ASSUMPTIONS.answerRttMs)) isLate = true;
    }
    for (const e of w.flux.events) {
      const k = "event:" + e.eventId;
      if (!first.has(k)) first.set(k, suffix[0].prev.flux.events.some(x => x.eventId === e.eventId) ? 0 : i);
      if (held) continue; // r3.4c (M2a): an event the open window holds is not late
      if (!eventDeliveredBy(suffix, i, e) && (i - first.get(k)! >= PROMPT_STEPS || w.nowMs - e.atMs > ENV_ASSUMPTIONS.eventDeliveryMs)) isLate = true;
    }
    if (isLate) late.push(i);
  }
  return late;
}
/** The environment was PROMPT over `suffix`: no item was ever late in it (A5-M9). */
export function envPrompt(suffix: readonly TraceStep[]): boolean { return itemLate(suffix).length === 0; }
/** A fault-free, owner-free suffix is fair when it ENDS drained (A4-M13, F4-L5, A5-M9). Work the home started near the end is not yet
 *  judged; a home that never lets a prompt environment drain is caught by the livelock clause of quiescenceReachable. */
export function suffixIsFair(suffix: readonly TraceStep[]): boolean {
  if (!suffix.length) return false;
  if (suffix.some(s => originOf(s.action) === "fault" || originOf(s.action) === "owner")) return false;
  return drainedAt(suffix, suffix.length - 1);
}

/** Quiescent modulo legitimate waiting (h): owner choices (parked, key-only parked, restore check), keep guards, and polling while Flux
 *  reports the inbox closing under a valid Remove are waiting, not violations. */
export function quiescentModuloWaiting(w: World): { ok: boolean; why: string } {
  if (w.proc.phase !== "running") return { ok: false, why: "home not running" };
  if (w.fs.liveMarker) return { ok: false, why: "marker not consumed" };
  if (w.carry) return { ok: false, why: "carry record not consumed" };
  // r3.4 (Astra r3.3i #3, Fable F3): no job is left in a phase: every job reaches prepared or aborted and is cleared. MUTANT quiescence-ignores-job.
  if (w.fs.restoreJob) return { ok: false, why: `restore job ${w.fs.restoreJob.id} still in journal phase ${w.fs.restoreJob.phase} (r3.4b)` };
  if (w.flux.requests.some(r => r.flux === "held" || (r.answer === "pending" && r.copyOf === null))) return { ok: false, why: "outstanding remote request" };
  if (w.local.pendingLifecycle.length) return { ok: false, why: "pending lifecycle row (A3-M11)" };
  if (w.flux.semantics.listingShipped && discoveryPending(w)) return { ok: false, why: "discovery pass not run after a blind restore (R2-Q4)" };
  if (Object.keys(w.local.keepOps).length) return { ok: false, why: "open keep op" };
  const closing = (i: InboxId | null) => i !== null && w.flux.inboxes[i]?.state === "closing";
  for (const l of values(w.local.leases)) if (!(l.phase === "acked" && closing(l.inboxId))) return { ok: false, why: `lease ${l.removalId} in ${l.phase}` };
  for (const p of values(w.local.parks)) {
    if (isParked(p.state)) {
      if (p.inboxId === null && p.provisionOpId && w.flux.semantics.listingShipped && values(w.flux.inboxes).some(i => i.createdUnderOp === p.provisionOpId))
        return { ok: false, why: `key-only park ${p.parkId}: inbox under its op not discovered` };
      continue;
    }
    const l = values(w.local.leases).find(x => x.target === p.target);
    if (p.state === "remove_authorized" && l && l.phase === "acked" && closing(l.inboxId)) continue;
    return { ok: false, why: `park ${p.parkId} in ${p.state}` };
  }
  for (const b of values(w.local.bindings)) if (b.state === "removing" || (b.state === "remove_requested" && !closing(b.gen.inboxId))) return { ok: false, why: `binding ${b.botId} in ${b.state}` };
  for (const bot of Object.keys(w.local.savedKeys)) { const k = w.local.savedKeys[bot]; if (k && w.flux.keys[k]?.state === "revoked") return { ok: false, why: `revoked key still saved for ${bot}` }; }
  return { ok: true, why: "" };
}

// ===================================================================================================================================
// 5. THE INVARIANTS
// ===================================================================================================================================

// ---------- (a) After a successful Keep, the inbox ends ACTIVE -----------------------------------------------------------------------

/**
 * (a) keepEndsActive. After a Keep succeeds on an inbox, every closing CAUSED BY A DELETE (reason owner or bot_deleted; including one
 * sent before a restore, reset or undo and held by Flux, A3-H1) is reverted: back to active within MAX_BLIP_MS while inside the 24 h
 * polling window, MAX_EVENT_BLIP_MS (A-EVENT-5MIN + A-RESTORE-APPLY) after it (both derived, Fable M1) (R2-Q3: that bound exists ONLY because of the named assumption), measured from
 * max(closing start, last boot, end of the last assumption break) (Q5, A5-H4); judged only while every named assumption holds on the
 * interval (envAssumptionState: no fault since the clock restarted, no RESTORE held past A-RESTORE-APPLY, no GET/RESTORE answer late past
 * A-ANSWER-RTT, and after 24 h no closing event late past A-EVENT-5MIN); and a settled trace ends with the inbox active. Holds for every
 * Keep mode (bot section, orphan, live, Flux-closing, A3-H2), after the park, lease and binding are gone (F3-H2) and across a NON-blind
 * restore (the carried guard, F4-H1).
 * The obligation ENDS at the first of: a VALIDLY created fresh owner Remove authority on that inbox (A4-H2); a Flux-caused closing
 * (billing / account_disabled / support: Flux's decision, mirrored and offered to the owner, F4-M1, A4-H5); a BLIND restore (then
 * blindRestoreIsOwnerVisible makes it owner-visible, never a silent loss); Flux's irreversible purge (A5-H4, R3-Q2: reachable only
 * after 30 days in which every fair, running interval was already judged by the bound).
 * F-BACKFILL DEPENDENCY (Q5 ruling): during a blip Flux accepts the mail at the provider but drops it at intake (no event, no
 * projection row), so the inbox ending active does NOT make the blip lossless. Only Flux F-BACKFILL (replay on restore) does. A home
 * that is down cannot restore promptly; the blip ops alert records the window.
 */
/** The named assumptions on the interval since a closing, evaluated at trace step i (A5-H4, R2-Q3). `brokenNow`: an assumption is
 *  being broken right now (a RESTORE held, an answer or event overdue), so no bound applies. `brokenUntilMs`: the latest moment an
 *  earlier break ended (a fault, a late apply / answer / event); the bound's clock restarts there. Faults before the closing do not
 *  count: one early fault no longer excuses the bound for ever. */
export function envAssumptionState(trace: readonly TraceStep[], i: number, inbox: InboxId, sinceStep: number, eventsMatter: boolean): { brokenNow: boolean; brokenUntilMs: number } {
  const w = trace[i].next;
  let brokenNow = false, until = Number.NEGATIVE_INFINITY;
  const upto = trace.slice(0, i + 1);
  const msAtStep = (step: number): number | null => { const s = upto.find(x => x.next.step === step); return s ? s.next.nowMs : null; };
  for (const s of upto) if (s.next.step > sinceStep && originOf(s.action) === "fault") until = Math.max(until, s.next.nowMs);
  for (const r of w.flux.requests) {
    if (r.target !== inbox || r.copyOf !== null || (r.kind !== "RESTORE_INBOX" && r.kind !== "GET_INBOX")) continue;
    if (r.kind === "RESTORE_INBOX") { // A-RESTORE-APPLY
      if (r.flux === "held") { if (w.nowMs - r.sentAtMs > FLUX_ASSUMPTIONS["A-RESTORE-APPLY"].ms) brokenNow = true; }
      else if (r.appliedAtMs !== null && r.appliedAtMs - r.sentAtMs > FLUX_ASSUMPTIONS["A-RESTORE-APPLY"].ms) until = Math.max(until, r.appliedAtMs);
    }
    if (r.answer === "pending") { if (w.nowMs - r.sentAtMs > FLUX_ASSUMPTIONS["A-ANSWER-RTT"].ms) brokenNow = true; } // A-ANSWER-RTT
    else if (r.answer === "delivered" && r.answerSeen) {
      const at = msAtStep(r.answerSeen.atStep);
      if (at !== null && at - r.sentAtMs > FLUX_ASSUMPTIONS["A-ANSWER-RTT"].ms) until = Math.max(until, at);
    }
  }
  if (eventsMatter) for (const e of w.flux.events) { // A-EVENT-5MIN
    if (e.inboxId !== inbox || e.type !== "email.inbox.closing" || e.atStep < sinceStep) continue;
    const ds = upto.find(s => s.action.t === "auto.applyEvent" && s.action.eventId === e.eventId);
    if (!ds) { if (!e.deliveredToHome && w.nowMs - e.atMs > FLUX_ASSUMPTIONS["A-EVENT-5MIN"].ms) brokenNow = true; }
    else if (ds.next.nowMs - e.atMs > FLUX_ASSUMPTIONS["A-EVENT-5MIN"].ms) until = Math.max(until, ds.next.nowMs);
  }
  return { brokenNow, brokenUntilMs: until };
}

// r3.4d SHADOW deletions (keepEndsActive): #19 `fi.state !== closing` and #20 `fi.closingCause?.kind !== delete` (dead branches at :1113 and :1118): an ACTIVE inbox is filtered because closingSinceMs and closingSinceStep are both null (fakeflux.ts:64, :74), so it never reaches :1120; flux-caused closings and purged inboxes also set endStep, but endStep is not the shield for active inboxes.
export function keepEndsActive(trace: readonly TraceStep[], settled: boolean): Verdict {
  const I = "keepEndsActive";
  if (!trace.length) return OK;
  const last = trace[trace.length - 1].next;
  for (const k of last.ghost.keeps) {
    if (k.succeededAtStep === null || k.succeededAtMs === null || k.inboxId === null) continue;
    const inbox = k.inboxId;
    let endStep = Number.POSITIVE_INFINITY;
    for (const a of last.ghost.authorities)
      if (REMOVE_KINDS.has(a.kind) && a.scope.inboxId === inbox && a.verifiedAtStep > k.succeededAtStep && authorityValidInTrace(trace, a.authorityId)) endStep = Math.min(endStep, a.verifiedAtStep);
    for (const r of last.ghost.restores) if (r.blind && r.atStep > k.succeededAtStep) endStep = Math.min(endStep, r.atStep);
    for (const s of trace) {
      const fi = s.next.flux.inboxes[inbox];
      if (s.next.step > k.succeededAtStep && fi?.state === "closing" && fi.closingCause?.kind === "flux") endStep = Math.min(endStep, s.next.step);
      if (s.next.step > k.succeededAtStep && fi?.state === "purged") endStep = Math.min(endStep, s.next.step); // A5-H4, R3-Q2
    }
    for (let i = 0; i < trace.length; i++) {
      const w = trace[i].next;
      if (w.step <= k.succeededAtStep || w.step >= endStep || w.proc.phase !== "running") continue;
      const fi = w.flux.inboxes[inbox];
      if (!fi || fi.closingSinceMs === null || fi.closingSinceStep === null) continue;
      const afterPolling = fi.closingSinceMs > k.succeededAtMs + GUARD_POLL_WINDOW_MS;
      const env = envAssumptionState(trace, i, inbox, fi.closingSinceStep, afterPolling);
      if (env.brokenNow) continue;
      const from = Math.max(fi.closingSinceMs, w.ghost.lastBootAtMs, env.brokenUntilMs);
      const bound = afterPolling ? MAX_EVENT_BLIP_MS : MAX_BLIP_MS; // r3.2 Fable M1: derived
      if (w.nowMs - from > bound) return fail(I, `inbox ${inbox} closing ${w.nowMs - from} ms after Keep ${k.keepOp} (bound ${bound})`, w.step);
    }
    if (settled && endStep === Number.POSITIVE_INFINITY && last.flux.inboxes[inbox]?.state !== "active")
      return fail(I, `inbox ${inbox} not active at quiescence after Keep ${k.keepOp}`, last.step);
  }
  return OK;
}

/** (a) keepSuccessIsConfirmed (A4-H4, F4-L1). A Keep on an inbox succeeds only on a REAL GET_INBOX of that inbox, sent under this keep
 *  op after its claim, whose answer was delivered with Flux reporting active, and sent only after every logical RESTORE of this op was
 *  answered (no stale GET racing its own restore). Transport duplicates join the first execution or replay its stored outcome.
 *  MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md withdraws retrospective ordering of future copies. */
// PERMITTED ACTION: mark a Keep succeeded on its own GET (sent after every logical RESTORE of the op was answered) delivered active.
export const keepSuccessIsConfirmed: StepInvariant = (prev, action, next) => {
  const I = "keepSuccessIsConfirmed";
  if (action.t === "flux.apply" || action.t === "net.answer") {
    const r = prev.flux.requests.find(x => x.requestId === action.requestId);
    const stored = r?.kind === "RESTORE_INBOX" ? prev.flux.restoreOutcomes?.[r.copyOf ?? r.requestId] : undefined;
    if (stored) {
      if (!same(prev.flux.inboxes, next.flux.inboxes) || !same(prev.flux.events, next.flux.events) || !same(stored, next.flux.restoreOutcomes?.[r!.copyOf ?? r!.requestId]))
        return fail(I, "duplicate RESTORE started a second physical copy", next.step);
      const answer = next.flux.requests.find(x => x.requestId === action.requestId)?.answerSeen;
      if (action.t === "net.answer" && (!answer || answer.result !== stored.answer || answer.fluxStateSeen !== stored.fluxStateSeen))
        return fail(I, "duplicate RESTORE did not return its stored outcome", next.step);
    }
  }
  for (const k of next.ghost.keeps) {
    const before = prev.ghost.keeps.find(x => x.keepOp === k.keepOp);
    if (k.succeededAtStep === null || (before && before.succeededAtStep !== null)) continue;
    for (const b of values(next.local.bindings)) if ((b.gen.inboxId ? inboxTarget(b.gen.inboxId) : botTarget(b.botId)) === k.target && (b.state === "removing" || b.state === "remove_requested" || b.state === "removal_parked")) return fail(I, `Keep ${k.keepOp} succeeded but binding ${b.botId} on ${k.target} is still ${b.state}`, next.step); // S1 (inbox or key-only): Keep success (inbox or key-only) resets EVERY binding on its target; none is left removing, requested or parked. MUTANT keep-success-leaves-binding-removing
    if (k.inboxId === null) continue; // key-only: no GET to confirm, S1 above already judged it
    const c = k.confirmedBy;
    const g = c ? next.flux.requests.find(r => r.requestId === c.requestId) : undefined;
    if (!c || !g) return fail(I, `Keep ${k.keepOp} succeeded with no confirming request`, next.step);
    if (g.kind !== "GET_INBOX" || g.target !== k.inboxId || g.keepOp !== k.keepOp || g.sentAtStep <= k.claimedAtStep)
      return fail(I, `Keep ${k.keepOp} confirmed by a request that is not its own GET`, next.step);
    if (g.answer !== "delivered" || !g.answerSeen || g.answerSeen.result !== "ok" || g.answerSeen.fluxStateSeen !== "active" || g.answerSeen.atStep !== c.atStep)
      return fail(I, `Keep ${k.keepOp} confirmed without a delivered GET reporting active`, next.step);
    for (const r of next.flux.requests) if (r.kind === "RESTORE_INBOX" && r.keepOp === k.keepOp && r.copyOf === null) {
      const answered = next.flux.requests.some(copy => (copy.copyOf ?? copy.requestId) === r.requestId && copy.kind === "RESTORE_INBOX" && copy.target === r.target && copy.keepOp === r.keepOp && copy.answer === "delivered" && copy.answerSeen !== null && copy.answerSeen.atStep < g.sentAtStep);
      if (!answered) return fail(I, `Keep ${k.keepOp} GET was sent before its restore was answered`, next.step);
    }
  }
  return OK;
};

/** (a) guardArmedForEveryKeep (F3-H2, F4-L6). EVERY successful Keep on an inbox writes a KeepGuard in the same step (production cannot
 *  know whether a DELETE may land), with pollUntilMs = kept + 24 h, and `unresolved` = "unknown" whenever the home cannot enumerate
 *  the attempts of the generation (any restore or legacy origin). */
// PERMITTED ACTION: commit a Keep success together with its guard (24 h polling window; "unknown" after a restore / legacy park).
export const guardArmedForEveryKeep: StepInvariant = (prev, _a, next) => {
  const I = "guardArmedForEveryKeep";
  for (const k of next.ghost.keeps) {
    const before = prev.ghost.keeps.find(x => x.keepOp === k.keepOp);
    if (k.succeededAtStep === null || (before && before.succeededAtStep !== null) || k.inboxId === null) continue;
    const g = next.local.keepGuards[k.inboxId];
    if (!g || g.keepOp !== k.keepOp) return fail(I, `Keep ${k.keepOp} on ${k.inboxId} committed without its keep guard`, next.step);
    if (g.pollUntilMs !== g.keptAtMs + GUARD_POLL_WINDOW_MS || g.keptAtMs !== prev.nowMs) return fail(I, `guard for ${k.inboxId} has a wrong polling window`, next.step);
    const parkOrigin = values(prev.local.parks).find(p => p.target === k.target)?.origin;
    if ((parkOrigin === "restore" || parkOrigin === "legacy") && g.unresolved !== "unknown") return fail(I, `guard after a restore/legacy park must be "unknown"`, next.step);
  }
  return OK;
};

/**
 * (a) guardLivesUntilEveryDeleteResolved (ruling 20:36Z, F4-H4, FLUX FACT one-closing-event). A guard leaves only when: (1) a valid
 * fresh owner Remove authority on its inbox is created in that step (guardDiesOnFreshRemove), or (2) every attempt it lists is
 * resolved, or (3) the inbox is purged (deleted event applied). An attempt is resolved by its delivered answer (and, when Flux does not
 * honour a DELETE idempotency key, no copy of it is still held, F4-M6) or by a closing event ONLY when it was the single unresolved
 * attempt left: one closing event per closing, so with two outstanding DELETEs the event may be d1's while d2 is in transit. An
 * "unknown" list resolves only by (1) or (3). Ghost cross-check: no DELETE for that inbox is still held at Flux. A restore swap may
 * drop the local row only when the carry holds it or the restore is blind.
 * r3 (A5-H3, F5-L1, F5-L6): while a guard stays, its identity (inbox, bot, generation, Keep op, kept time, polling window) is fixed and
 * `unresolved` only SHRINKS by resolution: "unknown" stays "unknown"; an attempt leaves the list only when resolved as above. A
 * delivered GET answering not_found (the inbox is already purged) also resolves everything (F5-L6).
 */
// PERMITTED ACTION: drop a guard (or an attempt from its list) when a valid fresh Remove, a delivered DELETE answer, the single
// remaining attempt's closing event, a purge event or a GET not_found resolves it.
export const guardLivesUntilEveryDeleteResolved: StepInvariant = (prev, action, next) => {
  const I = "guardLivesUntilEveryDeleteResolved";
  const answered = (at: AttemptId) => next.flux.requests.some(r => r.kind === "DELETE_INBOX" && r.attemptId === at && r.copyOf === null && r.answerSeen !== null && r.answerSeen.result !== "uncertain");
  const closingEventFor = (inbox: InboxId) => action.t === "auto.applyEvent" && prev.flux.events.some(e => e.eventId === action.eventId && e.type === "email.inbox.closing" && e.inboxId === inbox && (e.reason === "owner" || e.reason === "bot_deleted"));
  const goneByGet = (inbox: InboxId) => next.flux.requests.some(r => r.kind === "GET_INBOX" && r.target === inbox && r.answer === "delivered" && r.answerSeen?.result === "not_found");
  /** Attempts of `g` that may legitimately leave its list in this step. */
  const resolvable = (inbox: InboxId, list: AttemptId[]): AttemptId[] => {
    const un = list.filter(at => !answered(at));
    return list.filter(at => answered(at) || (un.length === 1 && un[0] === at && closingEventFor(inbox)));
  };
  // Contents: a surviving guard is never weakened (A5-H3, F5-L1). Swap and prep are governed by the carry checks.
  if (action.t !== "auto.swap" && action.t !== "auto.restorePrepare") for (const inbox of Object.keys(prev.local.keepGuards)) {
    const g = prev.local.keepGuards[inbox], n = next.local.keepGuards[inbox];
    if (!n || goneByGet(inbox)) continue;
    if (n.keepOp !== g.keepOp && !next.ghost.keeps.some(k => k.keepOp === n.keepOp && k.succeededAtStep === next.step)) // r3.2 Fable L4
      return fail(I, `guard for ${inbox} moved to Keep op ${n.keepOp} with no Keep succeeding now`, next.step);
    if (n.keepOp === g.keepOp && guardContent({ ...n, unresolved: [] }) !== guardContent({ ...g, unresolved: [] }))
      return fail(I, `guard for ${inbox} rewritten (identity or polling window changed)`, next.step);
    if (g.unresolved === "unknown") { if (n.unresolved !== "unknown") return fail(I, `guard for ${inbox} rewritten from "unknown" to a list`, next.step); continue; }
    if (n.unresolved === "unknown") continue;
    const ok = resolvable(inbox, g.unresolved), nu = n.unresolved;
    const dropped = g.unresolved.filter(at => !nu.includes(at) && !ok.includes(at));
    if (dropped.length) return fail(I, `guard for ${inbox} dropped unresolved attempt(s) ${dropped.join(",")}`, next.step);
  }
  for (const inbox of Object.keys(prev.local.keepGuards)) {
    if (next.local.keepGuards[inbox]) continue;
    const g = prev.local.keepGuards[inbox];
    if (action.t === "auto.swap") {
      if (action.blind || (prev.carry && prev.carry.keepGuards.some(x => x.inboxId === inbox))) continue;
      return fail(I, `swap dropped the guard for ${inbox} with no carry`, next.step);
    }
    if (newAuthorities(prev, next).some(a => REMOVE_KINDS.has(a.kind) && a.scope.inboxId === inbox && authorityCreationVerdict(prev, action, next, a) === null)) continue;
    const purged = action.t === "auto.applyEvent" && prev.flux.events.some(e => e.eventId === action.eventId && e.type === "email.inbox.deleted" && e.inboxId === inbox);
    if (purged || goneByGet(inbox)) continue;
    if (g.unresolved === "unknown") return fail(I, `guard for ${inbox} ("unknown" attempts) released without a Remove or purge`, next.step);
    const unanswered = g.unresolved.filter(at => !answered(at));
    if (unanswered.length > 1 || (unanswered.length === 1 && !closingEventFor(inbox)))
      return fail(I, `guard for ${inbox} released with ${unanswered.length} unresolved DELETE(s); one closing event proves at most one`, next.step);
    const held = prev.flux.requests.filter(r => r.kind === "DELETE_INBOX" && r.target === inbox && r.flux === "held" &&
      (r.copyOf === null || !prev.flux.semantics.deleteIdempotencyKeyHonoured));
    if (held.length) return fail(I, `guard for ${inbox} released while ${held.length} DELETE(s) are still held at Flux`, next.step);
  }
  return OK;
};

/** (a, F4-H3, point 3) guardDiesOnFreshRemove. When a valid fresh owner Remove authority on an inbox is created, that inbox's guard is
 *  deleted in the same step, so the guard can never revert an owner-authorized removal. */
// PERMITTED ACTION: delete the inbox guard in the step a valid owner Remove authority is created.
export const guardDiesOnFreshRemove: StepInvariant = (prev, action, next) => {
  for (const a of newAuthorities(prev, next)) {
    if (!REMOVE_KINDS.has(a.kind) || a.scope.inboxId === null || authorityCreationVerdict(prev, action, next, a) !== null) continue;
    if (next.local.keepGuards[a.scope.inboxId]) return fail("guardDiesOnFreshRemove", `guard for ${a.scope.inboxId} survived owner Remove ${a.authorityId}`, next.step);
  }
  return OK;
};

/** (page S5, re-derived r3.4e from the S5 line as edited by MurageMain) guardActsOnlyOnGuardRecord: a guard restore acts only on the
 *  closing its guard record names and never reverts an owner Remove verified after the guarded Keep. Read: a guard restore (a RESTORE
 *  with purpose guard) of an inbox needs the home's guard record for that inbox, and the inbox's closing at Flux must be one that record
 *  names: a closing caused by a DELETE of that inbox the guard covers (in its attempt list, or any DELETE of the inbox when the list is
 *  "unknown", as S3 reads coverage). No owner Remove authority on the inbox may be verified after the guarded Keep (the Keep op the
 *  guard names: its success step, else its claim step; with no Keep record, after the guard's kept time). */
// PERMITTED ACTION: send a guard RESTORE for an inbox in a closing its guard names, with no owner Remove verified after the Keep.
export const guardActsOnlyOnGuardRecord: StepInvariant = (prev, action, next) => {
  const I = "guardActsOnlyOnGuardRecord";
  if (action.t !== "net.send" || action.request.kind !== "RESTORE_INBOX" || action.request.purpose !== "guard") return OK;
  const inbox = action.request.target;
  const g = prev.local.keepGuards[inbox];
  if (!g) return fail(I, `guard restore of ${inbox} with no guard record`, next.step);
  if (values(prev.local.leases).some(l => l.inboxId === inbox)) return fail(I, `guard restore of ${inbox} with a lease`, next.step);
  if (values(prev.local.parks).some(p => p.inboxId === inbox)) return fail(I, `guard restore of parked ${inbox}`, next.step);
  const fi = prev.flux.inboxes[inbox];
  if (!fi || fi.state !== "closing") return fail(I, `guard restore of ${inbox} not in a closing`, next.step);
  const cause = fi.closingCause;
  const del = cause?.kind === "delete" ? prev.flux.requests.find(r => r.requestId === cause.requestId) : undefined;
  if (!del || del.kind !== "DELETE_INBOX" || del.target !== inbox)
    return fail(I, `guard restore of ${inbox} has no DELETE of this inbox behind its closing`, next.step);
  if (g.unresolved !== "unknown" && (del.attemptId === null || !g.unresolved.includes(del.attemptId)))
    return fail(I, `guard restore of ${inbox} acts on a closing its guard record does not name`, next.step);
  const k = prev.ghost.keeps.find(x => x.keepOp === g.keepOp);
  const later = (a: AuthorityRecord) => k ? a.verifiedAtStep > (k.succeededAtStep ?? k.claimedAtStep) : a.verifiedAtMs > g.keptAtMs;
  if (prev.ghost.authorities.some(a => REMOVE_KINDS.has(a.kind) && a.scope.inboxId === inbox && later(a))) // MUTANT s5-later-remove
    return fail(I, `guard restore of ${inbox} reverts an owner Remove verified after the guarded Keep`, next.step);
  return OK;
};

/** (page S6, re-derived r3.4e from the S6 line as edited by MurageMain) restoreUsesOwnerCredentialAndKeepPurpose: every RESTORE uses
 *  the owner credential with purpose keep or guard. Read: a RESTORE_INBOX send carries credential "owner" and purpose "keep" or "guard". */
// PERMITTED ACTION: send a RESTORE with the owner credential and purpose keep or guard.
export const restoreUsesOwnerCredentialAndKeepPurpose: StepInvariant = (_p, action, next) => {
  const I = "restoreUsesOwnerCredentialAndKeepPurpose";
  if (action.t !== "net.send" || action.request.kind !== "RESTORE_INBOX") return OK;
  if (action.request.credential !== "owner") return fail(I, `restore of ${action.request.target} sent with credential ${action.request.credential}`, next.step);
  const purposes: RequestPurpose[] = ["keep", "guard"]; // MUTANT s6-or-guard
  if (!purposes.includes(action.request.purpose)) return fail(I, `restore of ${action.request.target} with purpose ${action.request.purpose}`, next.step);
  return OK;
};

// ---------- (b) No removal, no revoke without fresh owner-seen authority. No exemptions. ---------------------------------------------

/** (b) authorityCreatedByValidOwnerAction (A4-H1, F4-L2). Every new authority passes authorityCreationVerdict in its creation step. */
// PERMITTED ACTION: create an authority in an ok owner action step, bound to its bot, target and a valid token.
export const authorityCreatedByValidOwnerAction: StepInvariant = (prev, action, next) => {
  for (const a of newAuthorities(prev, next)) {
    const why = authorityCreationVerdict(prev, action, next, a);
    if (why) return fail("authorityCreatedByValidOwnerAction", `${a.authorityId}: ${why}`, next.step);
  }
  return OK;
};

/** (b) ownerAuthorityForEveryDestructiveSend. Every DELETE and revoke leaving the home names an authority of a kind OP_MATRIX allows for
 *  that request (Reconnect can never DELETE, A4-H2), from THIS epoch, whose scope names the target; a revoke never hits a key in use
 *  (RV1) nor, for rotation, the key now saved; a Remove authority superseded by a later Keep claim on its target is dead (Keep always
 *  wins). Every request Flux applies was sent by a home process (G3). */
// PERMITTED ACTION: send a DELETE / revoke under a current-epoch authority whose kind and scope allow it.
export const ownerAuthorityForEveryDestructiveSend: StepInvariant = (prev, action, next) => {
  const I = "ownerAuthorityForEveryDestructiveSend";
  if (action.t === "flux.apply") return prev.flux.requests.some(r => r.requestId === action.requestId) ? OK : fail(I, `Flux applied ${action.requestId} that no home sent`, next.step);
  if (action.t !== "net.send") return OK;
  const r = action.request;
  if (r.kind !== "DELETE_INBOX" && r.kind !== "REVOKE_KEY") return OK;
  const a = authorityById(prev, r.authorityId);
  if (!a) return fail(I, `${r.kind} ${r.target} with no authority`, next.step);
  if (!OP_MATRIX[r.kind].has(a.kind)) return fail(I, `${a.kind} may not send ${r.kind}`, next.step);
  if (a.epoch !== prev.ghost.epoch) return fail(I, `authority ${a.authorityId} is from an earlier restore epoch`, next.step);
  if (r.kind === "DELETE_INBOX" && a.scope.inboxId !== r.target) return fail(I, `DELETE ${r.target} outside scope`, next.step);
  if (r.kind === "REVOKE_KEY") {
    if (!a.scope.keyIds.includes(r.target)) return fail(I, `revoke ${r.target} outside scope`, next.step);
    if (keyInUse(prev, r.target, a.botId)) return fail(I, `revoke of key ${r.target} in use (RV1)`, next.step);
    if (a.kind === "rotate_reconnect" && a.botId !== null && prev.local.savedKeys[a.botId] === r.target) return fail(I, "rotation revoking the key now saved", next.step);
  }
  if (REMOVE_KINDS.has(a.kind) && a.scope.target !== null) {
    const later = prev.ghost.keeps.find(k => k.target === a.scope.target && k.claimedAtStep > a.verifiedAtStep);
    if (later) return fail(I, `${r.kind} after Keep ${later.keepOp} superseded ${a.authorityId}`, next.step);
  }
  return OK;
};

/** (b, F4-M4, A5-M10) removalSendNeedsSendingLease. A DELETE, and a REMOVAL revoke (purpose removal or a Remove-kind authority), leave
 *  only under a lease in `sending` (claimed by CAS in an earlier step) with the request's attempt id, on that inbox (DELETE) or naming
 *  that key as a pending key target (revoke); one request per (attempt, kind, target). Keep admission therefore sees every removal send. */
// PERMITTED ACTION: send a DELETE or a removal revoke under a lease already in `sending` for that attempt.
export const removalSendNeedsSendingLease: StepInvariant = (prev, action, next) => {
  const I = "removalSendNeedsSendingLease";
  if (action.t !== "net.send" || (action.request.kind !== "DELETE_INBOX" && action.request.kind !== "REVOKE_KEY")) return OK;
  const r = action.request;
  if (r.kind === "REVOKE_KEY") {
    const a = authorityById(prev, r.authorityId);
    if (r.purpose !== "removal" && !(a && REMOVE_KINDS.has(a.kind))) return OK; // rotation / Keep key release: not a removal send
  }
  const l = r.removalId ? prev.local.leases[r.removalId] : undefined;
  if (!l || l.phase !== "sending" || l.attemptId !== r.attemptId) return fail(I, `${r.kind} ${r.target} without a sending lease for attempt ${r.attemptId}`, next.step);
  if (r.kind === "DELETE_INBOX" && l.inboxId !== r.target) return fail(I, `DELETE ${r.target} outside its lease's inbox`, next.step);
  if (r.kind === "REVOKE_KEY" && !l.keyTargets.some(k => k.keyId === r.target && k.status === "pending")) return fail(I, `revoke ${r.target} is not a pending key target of its lease`, next.step);
  if (prev.flux.requests.some(x => x.attemptId === r.attemptId && x.copyOf === null && x.kind === r.kind && x.target === r.target)) return fail(I, `second ${r.kind} for attempt ${r.attemptId}`, next.step);
  return OK;
};

/** (b, Q2 ruling, F4-M5, F5-M2) noDestructiveSendAfterBlindRestore. After a restore with no outgoing database (blind), no DELETE and no
 *  revoke leaves until the owner confirms the inventory (in that epoch or later), or a complete Flux listing (when shipped) was
 *  answered after it. A LATER restore (blind or not) does not lift the fence (F5-M2). An unknown live entry is never destroyed either
 *  way: (b)'s tokens still have to show it to the owner. */
// PERMITTED ACTION: send a DELETE or revoke after the owner confirmed the inventory or a complete listing was answered.
export const noDestructiveSendAfterBlindRestore: StepInvariant = (prev, action, next) => {
  if (action.t !== "net.send" || (action.request.kind !== "DELETE_INBOX" && action.request.kind !== "REVOKE_KEY")) return OK;
  return blindFenced(prev) ? fail("noDestructiveSendAfterBlindRestore", `${action.request.kind} after a blind restore before owner confirmation or listing`, next.step) : OK;
};

/** (b, A4-H3, F4-L4, A5-H3) keptKeysProtected. A key enters keptKeys only under an owner Keep authority whose scope names it; an entry
 *  changes only to a Keep authority at least as recent as the key's high-water that names it; it LEAVES only once the key is revoked
 *  at Flux or a Remove authority naming it was verified after that Keep, or at a swap / prep for a key the carry holds (r3.3a); a kept key is revoked only under a
 *  Remove authority verified after that Keep. */
// r3.2 (A6-M3): on a swap the archive's older attribution is allowed when the carry holds the newer one; the prep must restore it.
// r3.3 (A7-M2): never for a key the carry does not hold.
// r3.3a (A8-M1, ruling): swap / prep may DROP a kept-key entry only for a key the carry holds; and authority is monotonic per key:
// outside a carried restore no step sets an entry to a Keep older than the key's high-water (ghost.keptHighWater or the live entry).
// PERMITTED ACTION: drop a kept-key entry after a later owner Remove revoked it; revoke a kept key under a later owner Remove; swap in
// an archive naming an older Keep, or lacking the key, while the carry preserves the newer one; re-keep a dropped key under a Keep at
// least as recent as its high-water; (r3.3f) a blind / no-live-DB swap into a closed store whose archive names an older Keep, when
// the prep (or the boot prep after a crash) clamps the entry to the high-water; (r3.3g) the same prep keeping the older entry and marking it
// unconfirmed; an owner decision refused restore_finishing while the window is open (r3.4c L1); an ordinary boot prep after the window, unclamped;
// dropping a revoked key, or a key under a Remove after its high-water, at that prep.
/** r3.3f: the store is closed between a swap and its prep in these phases (the swap window). */
/** r3.3g (Astra r3.3f #4): the swap-window obligation, explicit and derived from the recorder: a replacement prep is PENDING from the swap
 *  until its epoch's prep commits (restore prep, or the boot prep after a crash). */
export const prepPending = (w: World): boolean => w.ghost.restores.length > 0 && !w.ghost.preparedEpochs.includes(w.ghost.epoch);
/** r3.4 (redesign): the durable restore job (R1) and its window. The window is OPEN in phases armed, captured and swapped. The checker
 *  also treats a ghost-pending prep as open (restoreJobMatchesReality makes the two agree on every valid trace). */
export const journalOf = (w: World): RestoreJob | null => w.fs.restoreJob ?? null; // r3.4b (N2): the sidecar journal
export const jobOf = (w: World): RestoreJob | null => {
  const j = journalOf(w); if (!j) return null;
  if (j.phase === "swapped" || j.phase === "prepared") return j; // never a legal journal phase: restoreJobMatchesReality rejects it as written
  const ph: RestoreJobPhase = w.local.preparedJobId === j.id ? "prepared" : w.local.swappedJobId === j.id ? "swapped" : j.phase;
  return ph === j.phase ? j : { ...j, phase: ph };
};
/** r3.4b (Opus check N1): the carry is the current job's own (its armed capture stamped carry.jobId). */
export const carryOfJob = (w: World): boolean => { const j = jobOf(w); return !!w.carry && !!j && w.carry.jobId === j.id; };
const OPEN_PHASES: ReadonlySet<RestoreJobPhase> = new Set<RestoreJobPhase>(["armed", "captured", "swapped"]);
export const jobOpen = (w: World): boolean => { const j = jobOf(w); return !!j && OPEN_PHASES.has(j.phase); };
export const windowOpen = (w: World): boolean => jobOpen(w) || prepPending(w);
const unconfirmedKept = (w: World): Record<KeyId, number> => w.local.unconfirmedKept ?? {};
const OWNER_DECISIONS: ReadonlySet<Action["t"]> = new Set<Action["t"]>(["owner.keep", "owner.remove", "owner.deleteBot", "owner.tryAgainNow", "owner.reconnect", "owner.confirmInventory"]);
/** r3.3h (Astra r3.3g #4, #6): the line every window refusal and every owner view while a prep is pending shows. Plain words. */
export const RESTORE_FINISHING_LINE = "A restore is finishing. Try again in a minute.";
/** r3.3i (Sol copy check G): the line every owner view shows, on a "bot" section row, while a kept key is marked unconfirmed. */
export const RECONFIRM_KEPT_LINE = "Choose Keep or Remove again for this bot's email.";
/** r3.3h (Astra r3.3g #5): the codes of the ONE window-refusal rule. r3.4 (Astra r3.3i #4, Fable F2): restore_finishing ONLY;
 *  confirm_expired is no longer a legal window refusal. MUTANT window-accepts-confirm-expired. */
export const WINDOW_REFUSAL_CODES = ["restore_finishing"] as const;
/** r3.4 (Fable F3): the home-row line of an aborted restore. Plain words, no dashes. */
export const RESTORE_FAILED_LINE = "That restore did not finish. Nothing changed. You can try again.";
const WINDOW_DECISIONS: ReadonlySet<Action["t"]> = new Set<Action["t"]>([...OWNER_DECISIONS, "owner.restore", "owner.backup"]); // r3.4b (N5): backup too
const ownerOutcomeOf = (a: Action): OwnerOutcome => (a as { outcome?: OwnerOutcome }).outcome ?? { ok: true };
const actionBot = (a: Action): BotId | null => ("botId" in a ? (a as { botId: BotId | null }).botId : null);
/** r3.3h (Astra r3.3g #6): every DURABLE field a window refusal must leave unchanged: the whole home database (LocalDb: tablesPresent,
 *  bindings, intents, parks, leases, keepOps, keepGuards, rotations, pendingLifecycle, keptKeys, savedKeys, unconfirmedKept), the carry,
 *  the home files, the process, the recorder's owner ledgers and the request log; r3.3i (design check E): also the archives, the ops log
 *  and ghost.keptHighWater; r3.4 (Astra r3.3i #6): also the bots and all of Flux, i.e. the whole world except the clock, the surface and
 *  the recorder's own history. Only the (non-durable) surface may change. MUTANT window-purity-omits-bots. */
const windowDurable = (w: World) => JSON.stringify([w.local, w.carry, w.fs, w.proc, w.ghost.tokens, w.ghost.authorities, w.ghost.keeps, w.ghost.usedKeepOps, w.ghost.ownerRestoreRequests, w.ghost.botDeletedAtStep, w.ghost.inventoryConfirmedEpochs, w.flux.requests, w.archives, w.ops, w.ghost.keptHighWater, w.bots, w.flux]); // r3.4 (Astra r3.3i #6): the whole world but ghost history, clock and surface
const windowLineShown = (w: World, b: BotId | null): boolean => w.surface.some(r => r.visible && ((r.section === "home" && r.line === RESTORE_FINISHING_LINE) ||
  (b !== null && r.section === "bot" && r.botId === b && r.line === RESTORE_FINISHING_LINE))); // r3.3i (G): LOOK_AGAIN_LINE no longer explains a window refusal
const SWAP_WINDOW_PHASES: ReadonlySet<ProcessState["phase"]> = new Set<ProcessState["phase"]>(["boot_prep", "down"]);
const keptHighWater = (w: World, k: KeyId): AuthorityRecord | undefined => {
  const g = authorityById(w, w.ghost.keptHighWater[k] ?? null), l = authorityById(w, w.local.keptKeys[k] ?? null);
  return !g ? l : !l ? g : l.verifiedAtStep > g.verifiedAtStep ? l : g;
};
// r3.4d SHADOW deletions: #12 `action.t !== owner.restore` (dead branch at :1421: the owner.restore case is tested first, the two guards merge into one with a ternary message); #24 the action.t test on consumesCarry (implied by windowEnds at :1431, which names both preps); #53/#54 `na.kind === keep`, `na.scope.keyIds.includes(k)` and #94 `a.kind === keep` (inductive on the guard at :1443, not a same-step early return: :1441 checks only CHANGED entries, and an unchanged entry is safe because it entered under :1443); #117 `prev.carry` (implied by carryOfJob at :1436).
export const keptKeysProtected: StepInvariant = (prev, action, next) => {
  const I = "keptKeysProtected";
  // r3.3g (Astra r3.3f #1, #3): WINDOW ISOLATION. While a replacement prep is pending nothing acts on the swapped-in entries: no capture and
  // no swap (r3.3h: a later owner.restore is REFUSED, never queued, so no carry captures a stale entry; MUTANT
  // window-allows-second-restore); no net.send of any kind (MUTANT window-allows-send); every owner decision refused with no state change
  // (r3.4: restore_finishing only, admissionPinned; the owner looks again once the store opens; MUTANT window-admits-owner).
  // r3.4 (redesign): the window is the job's open phases (R1). After the swap nothing captures or swaps; before it only the job's own
  // capture / swap happen (restoreJobProtocol). No net.send of any kind while open (MUTANT window-allows-send).
  if (prepPending(prev) && (action.t === "auto.captureOutgoing" || action.t === "auto.swap")) return fail(I, `${action.t} while the prep of epoch ${prev.ghost.epoch} is pending (r3.3g)`, next.step);
  if (windowOpen(prev)) {
    if (action.t === "net.send") return fail(I, `${action.request.kind} sent while restore window is open (r3.4)`, next.step);
    // r3.4b (Opus check N4): HELD INPUT. No event applied and no answer taken while the window is open (R1); Flux keeps both until after.
    if (action.t === "auto.applyEvent" || action.t === "net.answer") return fail(I, `${action.t} taken while restore window is open: held until the job is prepared or aborted (r3.4b)`, next.step); // MUTANT window-takes-input
    // r3.3h, r3.4: the ONE window-refusal rule, from phase armed on (Astra r3.3i #4): every owner decision, restore included, is refused
    // (no queue); the refusal changes nothing in the world but the surface and shows the restore-finishing line.
    if (WINDOW_DECISIONS.has(action.t)) {
      const o = ownerOutcomeOf(action);
      if (o.ok) return fail(I, action.t === "owner.restore" ? `owner.restore admitted while a restore window is open: refused, never queued (r3.3h)` : `owner ${action.t} acted while a restore window is open (r3.3g)`, next.step); // MUTANTS window-admits-restore, window-admits-owner
      if (!o.ok) {
        if (windowDurable(prev) !== windowDurable(next)) return fail(I, `window refusal of ${action.t} changed durable state (r3.3h)`, next.step); // MUTANT window-purity-omits-savedkeys
        if (!windowLineShown(next, actionBot(action))) return fail(I, `window refusal of ${action.t} shows no restore-finishing line (r3.3h)`, next.step); // MUTANT window-refusal-no-line
      }
    }
  }
  // r3.3h, r3.4: every owner view while the window is open (from phase armed on) shows the home line, so after a crash it shows again (a
  // refusal leaves no replay obligation). MUTANT window-view-skips-line.
  if (action.t === "owner.viewSurface" && windowOpen(next) && !windowLineShown(next, null)) return fail(I, `owner view while a restore window is open shows no restore-finishing line (r3.3h)`, next.step);
  const windowEnds = prepPending(prev) && ((action.t === "auto.restorePrepare" && action.outcome === "committed") || (action.t === "auto.bootPrep" && action.outcome === "ok"));
  // r3.3h (Astra r3.3g #1): BOTH preps consume the carry: the restore prep, and the boot prep that ends the window after a crash.
  // r3.4b (Opus check N1, N3): only the prep that ENDS the window (a prep pending) consumes the carry, and only the carry its own job's
  // armed capture made. A stray prep with no prep pending, or a foreign carry, gets no carried authority. MUTANTS stray-prep-consumes-carry,
  // prep-consumes-foreign-carry.
  const consumesCarry = carryOfJob(prev) && windowEnds; // MUTANT carried-checks-restore-prep-only
  // r3.4 (Astra r3.3i #2): a restore step is the swap or EITHER prep that consumes the carry (the boot prep after a crash included).
  const restoreStep = action.t === "auto.swap" || consumesCarry; // MUTANT bootprep-carry-not-authority
  for (const k of Object.keys(next.local.keptKeys)) {
    if (next.local.keptKeys[k] === prev.local.keptKeys[k]) continue;
    const a = authorityById(next, next.local.keptKeys[k]);
    if (!a || a.kind !== "keep" || !a.scope.keyIds.includes(k)) return fail(I, `key ${k} marked kept without an owner Keep naming it`, next.step);
    // r3.2 (A6-M3): the swapped-in archive may name an older Keep; the CARRIED protection is judged below. r3.3 (A7-M2): only for a key
    // the carry holds; an uncarried key (no carry, e.g. after a blind restore, or a key the carry lacks) keeps the older-Keep rule.
    // r3.4 (R4, Astra r3.3i #2): the SEALED carry is the authority: the swap may bring the archive's value for a carried key, and the
    // consuming prep may set a carried key to exactly its carried Keep (re-created when the archive lacks it), below the high-water or not.
    if (action.t === "auto.swap" && prev.carry && k in prev.carry.keptKeys) continue;
    if (restoreStep && prev.carry && prev.carry.keptKeys[k] === next.local.keptKeys[k]) continue;
    // r3.4b (Opus check N3): a prep that does not consume its job's carry never (re)creates an entry under a Keep that a later owner
    // Remove naming the key has ended (a stray prep re-applying a carry). Other steps keep the high-water rule below. MUTANT rekeep-under-removed-keep.
    if (!(k in prev.local.keptKeys) && (action.t === "auto.restorePrepare" || action.t === "auto.bootPrep") && next.ghost.authorities.some(r => REMOVE_KINDS.has(r.kind) && r.scope.keyIds.includes(k) && r.verifiedAtStep > a.verifiedAtStep))
      return fail(I, `key ${k} re-kept under Keep ${a.authorityId}, which a later owner Remove naming it ended (r3.4b)`, next.step);
    // r3.3f (ruling b, swap window): the swap renames the archive into place with the store CLOSED; its uncarried entries may still name
    // a Keep older than the key's high-water until the epoch's prep, which must clamp them (below). Nothing acts on them in between: the
    // store cannot open before that prep (everyReplacementPreparedBeforeStore, crash or not), and a drop / revoke is judged on the
    // high-water, never on the stale entry. A swap that leaves the store open gets no window. MUTANT swap-window-ignores-phase.
    if (action.t === "auto.swap" && SWAP_WINDOW_PHASES.has(next.proc.phase)) continue;
    const was = keptHighWater(prev, k); // r3.3a (A8-M1): the high-water, not only the live entry, so a drop cannot reset it
    if (was && a.verifiedAtStep < was.verifiedAtStep) return fail(I, `kept key ${k} re-attributed to a Keep older than its high-water`, next.step);
  }
  // r3.3g (Astra r3.3f #2, design (i) FAIL CLOSED): a marked (unconfirmed) entry, mark step s: its entry changes only to an owner Keep naming
  // the key verified after s; it leaves only once the key is revoked at Flux or an owner Remove naming it was verified after s; the mark
  // clears only with that new Keep or the entry's departure (MUTANT unconfirmed-mark-unguarded). A swap replaces the database: it is judged
  // at its carry (below) and at the epoch's prep.
  const uPrev = unconfirmedKept(prev), uNext = unconfirmedKept(next);
  const freshRemoveOf = (k: KeyId, s: number) => next.ghost.authorities.some(a => REMOVE_KINDS.has(a.kind) && a.scope.keyIds.includes(k) && a.verifiedAtStep > s);
  for (const k of Object.keys(uPrev)) {
    if (action.t === "auto.swap") continue;
    const s = uPrev[k], na = authorityById(next, next.local.keptKeys[k] ?? null);
    const freshKeep = !!na && na.verifiedAtStep > s;
    const freshRemove = freshRemoveOf(k, s), revoked = next.flux.keys[k]?.state === "revoked";
    if (k in prev.local.keptKeys && !(k in next.local.keptKeys) && !revoked && !freshRemove)
      return fail(I, `unconfirmed kept key ${k} dropped with no revoke and no owner Remove after step ${s} (r3.3g)`, next.step);
    // r3.3i (design check A, B): the window-ending prep re-stamps every mark (judged below); immutability holds at every OTHER step.
    if (windowEnds) continue; // MUTANT window-end-mark-immutable
    if (k in next.local.keptKeys && next.local.keptKeys[k] !== prev.local.keptKeys[k] && !freshKeep) return fail(I, `unconfirmed kept key ${k} re-attributed with no owner Keep after step ${s} (r3.3g)`, next.step);
    // r3.3i (design check C): on an entry that STAYS kept only a fresh owner Keep (verified strictly after the mark) ends the mark; a Remove
    // or a revoke ends it only together with the entry leaving keptKeys (the drop rule above), so a Remove still owed keeps the mark.
    // MUTANTS unconfirmed-mark-unguarded, remove-clears-mark-kept-key.
    if (!(k in uNext) && k in next.local.keptKeys && !freshKeep) return fail(I, `unconfirmed mark on kept key ${k} cleared with no new owner Keep (r3.3i)`, next.step);
    // r3.3h (Astra r3.3g #2): the value is the marking step, immutable while present. MUTANT unconfirmed-mark-value-mutable.
    if (k in uNext && uNext[k] !== s) return fail(I, `unconfirmed mark on kept key ${k} changed from step ${s} to ${uNext[k]} (r3.3h)`, next.step);
  }
  // r3.3h (Astra r3.3g #2): a mark is BORN only as the step that made it: a window-ending prep stamps its own step or restores a carried
  // mark with its carried value; a swap may bring an archive's EARLIER mark. No other step creates one and none is future-dated.
  // MUTANT unconfirmed-mark-stamp-unchecked.
  // r3.3i: the window-ending prep is judged by the re-stamp rule below, not here.
  for (const k of Object.keys(uNext)) {
    if (k in uPrev || windowEnds) continue;
    const v = uNext[k];
    const born = action.t === "auto.swap" && v < next.step;
    if (!born) return fail(I, `unconfirmed mark on kept key ${k} created at step ${v} by ${action.t} (r3.3h)`, next.step);
  }
  // r3.3i (design check A, B): the window-ending prep RE-STAMPS every mark it leaves: a carried mark keeps its carried value, every other
  // mark (one the swap brought from the archive included) becomes the prep's own step, so a stale archive mark can never make an older Keep
  // look fresh, and an archive mark that differs from the carried one is never a wedge. MUTANT prep-keeps-swap-mark.
  if (windowEnds) for (const k of Object.keys(uNext)) {
    const want = (consumesCarry ? prev.carry?.unconfirmedKept?.[k] : undefined) ?? next.step;
    if (uNext[k] !== want) return fail(I, `window-ending prep left the mark on kept key ${k} at step ${uNext[k]}, not re-stamped to ${want} (r3.3i)`, next.step);
  }
  // r3.3i (design check C): capture copies the mark of every kept key, a key whose Remove is still owed included. MUTANT capture-drops-owed-remove-mark.
  if (action.t === "auto.captureOutgoing") for (const k of Object.keys(uPrev))
    if (k in prev.local.keptKeys && next.carry?.unconfirmedKept?.[k] !== uPrev[k]) return fail(I, `capture dropped the unconfirmed mark on kept key ${k} (r3.3i)`, next.step);
  if (action.t === "net.send" && action.request.kind === "REVOKE_KEY" && action.request.target in uPrev) {
    const a = authorityById(prev, action.request.authorityId); // MUTANT unconfirmed-revoke-on-old-remove
    if (!a || !REMOVE_KINDS.has(a.kind) || a.verifiedAtStep <= uPrev[action.request.target]) return fail(I, `unconfirmed kept key ${action.request.target} revoked under no owner Remove after its mark (r3.3g)`, next.step);
  }
  // r3.3g: a non-blind swap's carry holds every mark; the prep that consumes it restores each mark whose key it keeps under no newer Keep.
  if (action.t === "auto.swap" && !action.blind) for (const k of Object.keys(uPrev))
    if (prev.carry?.unconfirmedKept?.[k] !== uPrev[k]) return fail(I, `swap without a carry preserving the unconfirmed mark on kept key ${k} (r3.3g)`, next.step);
  // r3.3h (Astra r3.3g #1, #2): BOTH preps (consumesCarry) restore each carried mark with its carried VALUE, unless R3 ended it.
  if (consumesCarry && prev.carry?.unconfirmedKept) for (const k of Object.keys(prev.carry.unconfirmedKept)) {
    const s = prev.carry.unconfirmedKept[k], a = authorityById(next, next.local.keptKeys[k] ?? null);
    const ended = !!a && a.verifiedAtStep > s; // r3.3i (C): only a fresh Keep ends a mark on an entry that stays kept
    if (k in next.local.keptKeys && uNext[k] !== s && !ended) return fail(I, `prep dropped or changed the carried unconfirmed mark on kept key ${k} (r3.3h)`, next.step);
  }
  // r3.3g, r3.3i (G): while marked, every owner view shows RECONFIRM_KEPT_LINE on a "bot" section row: the key's bot, or, for a key no bot
  // holds, a bot row naming the key. MUTANTS unconfirmed-look-again-skipped, reconfirm-line-uses-look-again.
  if (action.t === "owner.viewSurface") for (const k of Object.keys(uNext)) {
    if (!(k in next.local.keptKeys)) continue;
    const b = Object.keys(next.local.savedKeys).find(x => next.local.savedKeys[x] === k) ?? null;
    if (!next.surface.some(r => r.visible && r.section === "bot" && r.line === RECONFIRM_KEPT_LINE && (b !== null ? r.botId === b : r.keyIds.includes(k))))
      return fail(I, `unconfirmed kept key ${k} shown without the reconfirm line (r3.3i)`, next.step);
  }
  // r3.3a (A8-M1): the recorder keeps the high-water; it is never removed or lowered.
  for (const k of new Set([...Object.keys(prev.ghost.keptHighWater), ...Object.keys(prev.local.keptKeys)])) {
    const p = keptHighWater(prev, k), n = keptHighWater(next, k);
    if (p && (!n || n.verifiedAtStep < p.verifiedAtStep)) return fail(I, `kept key ${k} high-water lowered or lost`, next.step);
  }
  // r3.3b (Astra r3.3a Low): the GHOST entry itself is never deleted and never moved to an authority with an earlier verifiedAtStep,
  // even while the live entry still holds the newer Keep (the max above would hide it).
  for (const k of Object.keys(prev.ghost.keptHighWater)) {
    const p = authorityById(prev, prev.ghost.keptHighWater[k]), n = authorityById(next, next.ghost.keptHighWater[k] ?? null);
    if (!n || (p && n.verifiedAtStep < p.verifiedAtStep)) return fail(I, `ghost high-water of kept key ${k} deleted or lowered`, next.step);
  }
  // r3.2 (A6-M3): a non-blind swap needs a carry holding every outgoing kept key with its (newest) authority; the prep that consumes the
  // carry restores, for every carried kept key, an authority at least as recent as the carried one.
  if (action.t === "auto.swap" && !action.blind) for (const k of Object.keys(prev.local.keptKeys))
    if (!prev.carry || prev.carry.keptKeys[k] !== prev.local.keptKeys[k]) return fail(I, `swap without a carry preserving kept key ${k}'s authority`, next.step);
  if (consumesCarry) for (const k of Object.keys(prev.carry!.keptKeys)) { // r3.3h #1: both preps
    const carried = authorityById(next, prev.carry!.keptKeys[k]), now = authorityById(next, next.local.keptKeys[k] ?? null);
    if (!now || (carried && now.verifiedAtStep < carried.verifiedAtStep)) return fail(I, `prep left kept key ${k} without its carried (newer) Keep`, next.step);
  }
  // r3.3f clamp, r3.3g form (Astra r3.3f #2, #4): ONLY the prep that ends an OUTSTANDING swap window (prepPending(prev): the restore prep,
  // or the boot prep after a crash) is judged, so an ordinary later boot owes nothing (MUTANT boot-clamp-unconditional). Every UNCARRIED
  // kept entry it leaves is at least as recent as the ghost high-water OR marked unconfirmed (design (i): the reducer cannot read the
  // high-water, so it marks every uncarried entry; MUTANT prep-skips-high-water-clamp). Keys that left keptKeys (revoked, or a Remove
  // after the high-water, judged by the drop rule below) owe nothing here (MUTANT clamp-checks-departed-keys).
  if (windowEnds) for (const k of Object.keys(next.local.keptKeys)) { // r3.3g window-ending prep
      if (carryOfJob(prev) && k in prev.carry!.keptKeys) continue; // r3.4b (N1): only the job's own carry exempts a key from the clamp
      const now = authorityById(next, next.local.keptKeys[k] ?? null), hw = authorityById(next, next.ghost.keptHighWater[k] ?? null);
      if (hw && (!now || now.verifiedAtStep < hw.verifiedAtStep) && !(k in uNext)) return fail(I, `prep left uncarried kept key ${k} below its high-water, not unconfirmed`, next.step); // r3.3f clamp
    }
  // r3.3a (A8-M1): a swap / prep drop is exempt only for a key the carry holds; every other drop needs a revoke or a later Remove.
  for (const k of Object.keys(prev.local.keptKeys)) {
    if (k in next.local.keptKeys || (restoreStep && prev.carry && k in prev.carry.keptKeys)) continue;
    const keepA = keptHighWater(prev, k); // r3.3f: the high-water, so a stale swap-window entry cannot license a drop
    const laterRemove = next.ghost.authorities.some(a => REMOVE_KINDS.has(a.kind) && a.scope.keyIds.includes(k) && (!keepA || a.verifiedAtStep > keepA.verifiedAtStep));
    if (next.flux.keys[k]?.state !== "revoked" && !laterRemove) return fail(I, `kept key ${k} entry dropped with no revoke and no later owner Remove`, next.step);
  }
  if (action.t === "net.send" && action.request.kind === "REVOKE_KEY" && action.request.target in prev.local.keptKeys) {
    const keepA = keptHighWater(prev, action.request.target); // r3.3f: judged on the high-water, never on a stale swap-window entry
    const a = authorityById(prev, action.request.authorityId);
    if (!a || !REMOVE_KINDS.has(a.kind) || !keepA || a.verifiedAtStep <= keepA.verifiedAtStep) return fail(I, `kept key ${action.request.target} revoked without a later owner Remove`, next.step);
  }
  return OK;
};

/** (b, R3-Q4, r3.1) deletedBotAuthorityDead. An ok owner.deleteBot kills, IN ITS OWN STEP, every authority, token and lease scoped to
 *  each bot it names; none is used afterwards. The recorder writes ghost.botDeletedAtStep[b] = that step for exactly the named bots of
 *  an ok owner deleteBot, once, never changed. From then on, for a deleted bot b: no request is sent under an authority of b verified
 *  before the delete (only the delete's own bot_delete_with_token authorities live), nor under a lease of b or a Keep op of b whose
 *  authority predates it; no lease of b under such an authority starts a new send claim; no authority is created with a token
 *  minted for b (b token of b, or p token on a park of b) at or before the delete step, other than the delete's own. Other bots'
 *  authorities, tokens and leases are untouched.
 *  MUTANT: dropping the tie (this predicate returning OK) must fail must-reject `deleteBot-authority-reused`. */
// PERMITTED ACTION: after an ok owner.deleteBot, send under another bot's authority / lease, or under the delete's own authority.
// r3.4d SHADOW deletions: #6 `action.t !== owner.deleteBot` and #11 `action.t === owner.deleteBot` (implied by the Action type at :1581: okDelete already names owner.deleteBot, deleteIds reads its botIds); #8 `botDeletedAtStep[b] !== next.step` (dead branch at :1588, the not-recorded loop already fails a wrong step).
export const deletedBotAuthorityDead: StepInvariant = (prev, action, next) => {
  const I = "deletedBotAuthorityDead";
  const okDelete = action.t === "owner.deleteBot" && OWNER_PRINCIPALS.has(action.principal) && action.outcome.ok;
  const deleteIds: readonly BotId[] = (action as { botIds?: readonly BotId[] }).botIds ?? [];
  for (const b of Object.keys(prev.ghost.botDeletedAtStep)) if (next.ghost.botDeletedAtStep[b] !== prev.ghost.botDeletedAtStep[b]) return fail(I, `deletion step of ${b} rewritten`, next.step);
  for (const b of Object.keys(next.ghost.botDeletedAtStep)) {
    if (b in prev.ghost.botDeletedAtStep) continue;
    if (!okDelete || !deleteIds.includes(b)) return fail(I, `bot ${b} recorded deleted outside its ok owner delete`, next.step);
  }
  if (okDelete) for (const b of deleteIds) if (next.ghost.botDeletedAtStep[b] !== next.step && !(b in prev.ghost.botDeletedAtStep)) return fail(I, `ok delete of ${b} not recorded`, next.step);
  const del = next.ghost.botDeletedAtStep;
  const dead = (a: AuthorityRecord | undefined): boolean => !!a && a.botId !== null && del[a.botId] !== undefined && a.verifiedAtStep < del[a.botId];
  if (action.t === "net.send") {
    const r = action.request;
    const a = authorityById(prev, r.authorityId);
    if (dead(a)) return fail(I, `${r.kind} ${r.target} under ${a!.authorityId} of deleted bot ${a!.botId}`, next.step);
    const l = r.removalId ? prev.local.leases[r.removalId] : undefined;
    if (l && l.botId !== null && del[l.botId] !== undefined && dead(authorityById(prev, l.authorityId))) return fail(I, `${r.kind} under lease ${l.removalId} of deleted bot ${l.botId}`, next.step);
    const k = r.keepOp ? prev.ghost.keeps.find(x => x.keepOp === r.keepOp) : undefined;
    if (k && dead(authorityById(prev, k.authorityId))) return fail(I, `${r.kind} under Keep ${k.keepOp} of deleted bot ${k.botId}`, next.step);
  }
  for (const l of values(next.local.leases)) {
    const p = prev.local.leases[l.removalId];
    if (l.phase === "sending" && (!p || p.phase !== "sending" || p.attemptId !== l.attemptId) && dead(authorityById(next, l.authorityId)))
      return fail(I, `lease ${l.removalId} of deleted bot ${l.botId} claimed a new send`, next.step);
  }
  for (const a of newAuthorities(prev, next)) {
    const t = tokenById(prev, a.tokenId);
    if (!t) continue;
    const tokBot = tokenBot(prev, t); // r3.3e: the shared resolution
    for (const b of [a.botId, tokBot]) {
      if (b === null || del[b] === undefined || t.issuedAtStep > del[b]) continue;
      if (a.verifiedAtStep === del[b] && a.kind === "bot_delete_with_token") continue; // the delete's own authority
      return fail(I, `authority ${a.authorityId} created with token ${t.tokenId} of deleted bot ${b}`, next.step);
    }
  }
  return OK;
};

// ---------- (c) Nothing automatic un-parks --------------------------------------------------------------------------------------------

/** (c) nothingAutomaticUnparks. On every non-owner step other than a restore swap/prep (r3.3: those may drop an admitted Keep only for an
 *  owner restore requested after its claim): a parked park stays parked (pk -> pkE allowed,
 *  never back), its binding stays removal_parked, no lease or authority appears for its target, and no DELETE, revoke or restore is
 *  sent for its inbox or keys. Automatic moves out of keep_pending / remove_authorized / key_release only finish the owner's choice.
 *  Owner steps move only the parks they name (a bulk delete names a bot list, F4-L5), and a parked park leaves parked / parked_evidence
 *  only through an ok owner Keep, Remove or bot delete (F5-L3: Reconnect, Try again now or a refused action never un-park). */
// r3.2 (A6-H1): an admitted Keep is never rolled back automatically: keep_pending -> parked / parked_evidence is forbidden to every
// non-owner step (it only completes, key_release, or ends with its park dropped after success or a Flux refusal, judged by (h)).
// PERMITTED ACTION: a swap / prep for an owner restore requested after the Keep claim drops that Keep; automatic pk -> pkE on evidence; automatic progress of a park the owner already moved (keep_pending -> key_release);
// an ok owner Keep / Remove / bot delete moving the park it names.
// r3.4d SHADOW deletions: #14 `"botId" in action` and #15 `action.botId` as chain operands (implied by the Action type at :1649: only the actions that carry a botId have one, read through botIdOfAction; consumed by the origin === owner branch at :1653).
export const nothingAutomaticUnparks: StepInvariant = (prev, action, next) => {
  const I = "nothingAutomaticUnparks";
  if (action.t === "auto.swap" || action.t === "auto.restorePrepare") {
    // r3.3 (A7-H1, ruling 1): a swap / prep may end an admitted (not yet succeeded) Keep only for an OWNER restore requested after the
    // Keep's claim; everything else on these steps is governed by restorePrepParksEverything.
    const r = next.ghost.restores[next.ghost.restores.length - 1];
    for (const p of values(prev.local.parks)) {
      if (p.state !== "keep_pending" || parksOn(next, p.target).some(x => x.state === "keep_pending" || x.state === "key_release")) continue;
      const claims = next.ghost.keeps.filter(k => k.target === p.target);
      if (claims.length && claims.every(k => k.succeededAtStep !== null)) continue;
      const claim = Math.max(-1, ...claims.map(k => k.claimedAtStep));
      if (!r || r.epochAfter !== next.ghost.epoch || r.ownerRequestStep === null || r.ownerRequestStep <= claim)
        return fail(I, `${action.t} dropped the admitted Keep on ${p.target} without an owner restore requested after its claim (A7-H1)`, next.step);
    }
    return OK;
  }
  const origin = originOf(action);
  const botIdOfAction = (action as { botId?: BotId | null }).botId;
  const namedBots: BotId[] = action.t === "owner.deleteBot" ? action.botIds : botIdOfAction ? [botIdOfAction] : [];
  const namedTarget: TargetRef | null = "target" in action ? action.target : null;
  for (const p of values(prev.local.parks)) {
    const n = next.local.parks[p.parkId];
    if (origin === "owner") {
      // r3.2 (Fable L5): a bot delete names its bots' parks; any other owner action only the park on its own target.
      const named = action.t === "owner.deleteBot" ? p.botId !== null && namedBots.includes(p.botId) : namedTarget === p.target;
      if (!named && (!n || n.state !== p.state || n.parkRev !== p.parkRev)) return fail(I, `owner ${action.t} moved unnamed park ${p.parkId}`, next.step);
      const exitOk = (action.t === "owner.keep" || action.t === "owner.remove" || action.t === "owner.deleteBot") && action.outcome.ok;
      if (isParked(p.state) && (!n || !isParked(n.state)) && !exitOk) return fail(I, `owner ${action.t} un-parked ${p.parkId} without an ok Keep or Remove`, next.step);
      continue;
    }
    if (isParked(p.state)) {
      if (!n || !isParked(n.state)) return fail(I, `automatic ${action.t} moved park ${p.parkId} out of ${p.state}`, next.step);
      if (p.state === "parked_evidence" && n.state === "parked") return fail(I, `automatic ${action.t} dropped deletion evidence`, next.step);
      if (p.botId !== null && prev.local.bindings[p.botId]?.state === "removal_parked" && next.local.bindings[p.botId] && next.local.bindings[p.botId].state !== "removal_parked")
        return fail(I, `automatic ${action.t} moved parked binding ${p.botId}`, next.step);
      if (values(next.local.leases).some(l => !prev.local.leases[l.removalId] && l.target === p.target)) return fail(I, `automatic lease on parked ${p.parkId}`, next.step);
      if (action.t === "net.send" && ["DELETE_INBOX", "REVOKE_KEY", "RESTORE_INBOX"].includes(action.request.kind)) {
        const tg = action.request.target;
        if (tg === p.inboxId || p.keyTargets.some(k => k.keyId === tg)) return fail(I, `automatic ${action.request.kind} on parked ${p.parkId}`, next.step);
      }
    } else if (n) {
      const allowed: Record<ParkState, ParkState[]> = {
        parked: [], parked_evidence: [], keep_pending: ["keep_pending", "key_release"], // r3.2 A6-H1: never back to parked
        remove_authorized: ["remove_authorized"], key_release: ["key_release"],
      };
      if (!allowed[p.state].includes(n.state)) return fail(I, `automatic ${action.t} moved park ${p.parkId} ${p.state} -> ${n.state}`, next.step);
    }
  }
  if (origin !== "owner" && newAuthorities(prev, next).length) return fail(I, `automatic ${action.t} created an authority`, next.step);
  return OK;
};

/** (c, A3-M14) keptStaysKept. After a Keep succeeds, no automatic step other than a restore prep parks that target again. */
// PERMITTED ACTION: an automatic step parks a target that was never kept (or parks with origin kept).
export const keptStaysKept: StepInvariant = (prev, action, next) => {
  // r3.4d-s23 (page S14, MurageMain 2026-11-11): the old owner exemption was SHADOW (dead branch: owner.tryAgainNow is bot:* only, restore-reducer :445; implied by the Action type) and is deleted; only an owner Remove of the target is exempt.
  if (action.t === "owner.remove" || action.t === "auto.restorePrepare" || action.t === "auto.swap") return OK;
  for (const p of values(next.local.parks)) {
    if (prev.local.parks[p.parkId]) continue;
    const kept = next.ghost.keeps.find(k => k.succeededAtStep !== null && k.target === p.target);
    if (kept && !next.ghost.restores.some(r => r.atStep > kept.succeededAtStep!) && p.origin !== "kept") return fail("keptStaysKept", `automatic ${action.t} re-parked kept ${p.target}`, next.step);
  }
  return OK;
};

/** (c, A4-H7, F4-H1, F4-M5) outgoingCapturedBeforeSwap. A swap that replaces a live database with email tables happens only after a
 *  COMPLETE carry of that database was captured in an earlier step outside the restored tree, and the swap is then not blind; a swap
 *  with no live database is blind. The carry is deleted only after the prep of its epoch committed. r3: the carry covers every queued
 *  removal with its evidence and the guard / kept-key CONTENTS (carryCovers, A5-H2, A5-H3), and records a pending blind fence (F5-M2). */
// PERMITTED ACTION: swap after a complete carry; delete the carry once its epoch's prep committed.
export const outgoingCapturedBeforeSwap: StepInvariant = (prev, action, next) => {
  const I = "outgoingCapturedBeforeSwap";
  if (action.t === "auto.swap") {
    const hadDb = prev.fs.messagesDbPresent && prev.local.tablesPresent;
    if (hadDb) {
      if (action.blind) return fail(I, "swap of a live database declared blind", next.step);
      if (!prev.carry || prev.carry.capturedAtStep >= next.step || prev.carry.forEpoch !== prev.ghost.epoch || !carryCovers(prev.local, prev.carry))
        return fail(I, "swap without a complete pre-swap carry of the outgoing database", next.step);
      if (blindFenced(prev) && !prev.carry.blindPending) return fail(I, "carry drops the pending blind-restore fence (F5-M2)", next.step);
    } else if (!action.blind) return fail(I, "swap with no outgoing database must be blind", next.step);
    else if (prev.carry) return fail(I, `blind swap with carry ${prev.carry.carryId} present: a blind job has no outgoing database and runs with no carry (r3.4b)`, next.step); // MUTANT blind-swap-with-carry
  }
  // r3.4 (Fable F3): the clear of an ABORTED job (no swap ever happened) deletes its carry too.
  const abortedClear = action.t === "auto.restoreJobClear" && jobOf(prev)?.phase === "aborted";
  if (prev.carry && !next.carry && !abortedClear && !next.ghost.preparedEpochs.includes(prev.carry.forEpoch + 1))
    return fail(I, "carry deleted before its prep committed", next.step);
  return OK;
};

/** (c) restorePrepParksEverything. A committed prep (on the swapped-in database `prev.local`, with `prev.carry`): every removal in flight
 *  or queued in the archive (removing / remove_requested / removal_parked binding, intent, park, bot lease) is a parked park for its
 *  target, keeping its deletion evidence, UNLESS the carry holds a guard for that inbox (a later owner Keep wins, R2-Q1); every key,
 *  inbox id and provisioning op of the archive and of the carry stays referenced; every carried guard and kept key survives; every
 *  carried outstanding DELETE leaves its inbox under a guard or a park; no lease (a foreign lease is dropped, F3-M2), keep op or
 *  pending lifecycle row survives. r3 (A5-H2, A5-H3): the removals are the archive's queuedRemovals PLUS the carry's `removals`
 *  (authorized-but-unsent included), merged per target, and EACH target needs its own parked park (one park no longer stands in for
 *  several); carried guards keep their Keep op, generation and attempts (guardAtLeast); carried kept keys keep their authority. */
// PERMITTED ACTION: commit a prep that parks every archived and carried removal per target and keeps every key, inbox, op, guard and kept key.
// r3.4d SHADOW deletions: #1 `action.t === auto.bootPrep` (implied by the Action type at :1733: only the boot prep carries outcome "ok"); #22 `!(k in c.keptKeys)` (dead branch at :1772, a carried kept key may not be lost); #24 `!(k in next.local.keptKeys)` (dead branch at :1765, a key still in next.local.keptKeys is in keys); #38 `!keepGuards[g.inboxId]` (dead branch at :1770, guardAtLeast rejects a missing guard).
export const restorePrepParksEverything: StepInvariant = (prev, action, next) => {
  const I = "restorePrepParksEverything";
  // r3.4d (page C1, M-4): the BOOT prep after a crash that ends the window owes the same duties as the restore prep.
  const endsByBoot = (action as { outcome?: unknown }).outcome === "ok" && prepPending(prev); // M-4 MUTANT boot-prep-exempt // cast guarded by ASSERT_OK_OUTCOME_ONLY_BOOT_PREP (end of file)
  if (!(action.t === "auto.restorePrepare" && action.outcome === "committed") && !endsByBoot) return OK;
  // r3.4c (Opus check M1): the carry duties bind ONLY the prep that ends the window for the carry's own job; a stray prep owes none.
  const carryDuty = prepPending(prev) && carryOfJob(prev);
  const src = prev.local, c = carryDuty ? prev.carry : null; // MUTANT stray-prep-owes-carry
  if (!src.tablesPresent && !c) return OK;
  const guarded = new Set<InboxId>((c?.keepGuards ?? []).map(g => g.inboxId));
  // A5-H2: archived AND carried removals (queued-but-unsent included), merged per target; each target needs ITS OWN parked park.
  const byTarget = new Map<TargetRef, CarriedRemoval>();
  for (const m of [...queuedRemovals(src), ...(c?.removals ?? [])]) {
    const x = byTarget.get(m.target);
    if (x) x.evidence = x.evidence || m.evidence; else byTarget.set(m.target, { ...m });
  }
  for (const m of byTarget.values()) {
    if (m.inboxId !== null && guarded.has(m.inboxId)) {
      if (values(next.local.parks).some(p => p.inboxId === m.inboxId)) return fail(I, `inbox ${m.inboxId} parked although the outgoing home had Kept it`, next.step);
      continue;
    }
    const p = parksOn(next, m.target).find(x => isParked(x.state));
    if (!p) return fail(I, `restored removal of ${m.target} (${m.botId}) not parked`, next.step);
    if (m.evidence && p.state !== "parked_evidence") return fail(I, `deletion evidence of ${m.target} lost`, next.step);
    const bind = m.botId !== null ? next.local.bindings[m.botId] : undefined;
    if (bind && bind.gen.inboxId === m.inboxId && bind.state !== "removal_parked") return fail(I, `binding ${m.botId} left in ${bind.state}`, next.step);
  }
  const keys = locallyReferencedKeys(next.local), inboxes = locallyReferencedInboxes(next.local), ops = locallyReferencedOps(next.local);
  // r3.4 (Astra r3.3i #5, ruling): an archived kept key that has DEPARTED may leave with its entry: revoked at Flux (nothing is left to
  // protect or clean), or, after a blind restore whose discovery is still pending, under an owner Remove verified after its high-water
  // (keptKeysProtected licenses that drop; the blind fence's discovery pass, listing or owner inventory confirm, re-finds the live key and
  // the Remove's revoke stays owed). A carried key never departs here. MUTANT prep-departed-key-must-stay.
  const departed = (k: KeyId): boolean => !(c?.keyIds ?? []).includes(k) && k in src.keptKeys &&
    (next.flux.keys[k]?.state === "revoked" || (discoveryPending(next) && next.ghost.authorities.some(a => REMOVE_KINDS.has(a.kind) && a.scope.keyIds.includes(k) &&
      a.verifiedAtStep > (authorityById(next, next.ghost.keptHighWater[k] ?? src.keptKeys[k])?.verifiedAtStep ?? Infinity))));
  for (const k of [...locallyReferencedKeys(src), ...(c?.keyIds ?? [])]) if (!keys.has(k) && !departed(k)) return fail(I, `key ${k} lost by prep`, next.step);
  const foreignInboxes = new Set(values(src.leases).filter(l => l.foreign && l.inboxId).map(l => l.inboxId as InboxId));
  for (const i of [...locallyReferencedInboxes(src), ...(c?.inboxIds ?? [])]) if (!foreignInboxes.has(i) && !inboxes.has(i)) return fail(I, `inbox id ${i} lost by prep`, next.step);
  for (const o of [...locallyReferencedOps(src), ...(c?.provisionOps ?? [])]) if (!ops.has(o)) return fail(I, `provisioning op ${o} lost by prep`, next.step);
  for (const g of c?.keepGuards ?? []) {
    if (!guardAtLeast(g, next.local.keepGuards[g.inboxId])) return fail(I, `carried guard ${g.inboxId} weakened by prep (A5-H3)`, next.step);
  }
  for (const k of Object.keys(c?.keptKeys ?? {})) if (next.local.keptKeys[k] !== c!.keptKeys[k]) return fail(I, `carried kept key ${k} lost or re-attributed`, next.step);
  for (const d of c?.outstandingDeletes ?? []) if (!next.local.keepGuards[d.inboxId] && !values(next.local.parks).some(p => p.inboxId === d.inboxId))
    return fail(I, `outstanding DELETE on ${d.inboxId} left unguarded and unparked`, next.step);
  if (Object.keys(next.local.leases).length) return fail(I, "a lease survived prep", next.step);
  if (Object.keys(next.local.keepOps).length) return fail(I, "a keep op survived prep", next.step);
  if (next.local.pendingLifecycle.length) return fail(I, "pending lifecycle rows survived prep", next.step);
  return OK;
};

/** (c, F3-M2) restorePrepNeverThrows. Prep and boot prep never throw on an archive with the email tables (e.g. a foreign lease). */
// PERMITTED ACTION: commit the restore prep / boot prep.
// r3.4d SHADOW deletions: #1 `action.t === auto.restorePrepare` and #4 `action.t === auto.bootPrep` (implied by the Action type at :1785: only the two preps carry outcome "threw"; the two guards merged into one with a ternary message).
export const restorePrepNeverThrows: StepInvariant = (_p, action, next) => {
  if ((action as { outcome?: unknown }).outcome === "threw") return fail("restorePrepNeverThrows", action.t === "auto.bootPrep" ? "boot prep threw; home stays closed" : "restore prep threw", next.step); // cast guarded by ASSERT_THREW_OUTCOME_ONLY_PREPS (end of file)
  return OK;
};

// ---------- (d) Every orphan has an executable owner action, visible on the surface -----------------------------------------------

/**
 * (d) everyOrphanHasExecutableAction. Orphans come from ground truth (A3-H6): every non-purged inbox of this install no present bot's
 * live binding names; every live key of this install no present bot uses; every key-only binding or park of an absent bot. Each has a
 * visible row with a plain line and an ENABLED keep or remove (A4-H9); a row names an inbox by id OR by the provisioning op it was
 * created under (A4-H8: the home cannot know an id whose create answer was lost). A key-only park offers Keep and Remove (F3-M3). Not
 * orphans: an inbox closing under a valid owner Remove with no later Keep (F4-M3). A present bot's inbox that Flux is closing shows
 * Keep on its bot row (F4-H1 ii). `try_again_now` is enabled only while work is pending on its target. After a blind, unconfirmed
 * restore, things the home has no record of are covered by the restore-check row. Token freshness is the view's job (viewMintsScopedTokens).
 */
export const everyOrphanHasExecutableAction: StateInvariant = w => {
  const I = "everyOrphanHasExecutableAction";
  if (w.proc.phase !== "running") return OK;
  const rows = w.surface.filter(r => r.visible && r.line.length > 0);
  const enabledKR = (r: SurfaceRow) => r.actions.some(a => a.enabled && (a.kind === "keep" || a.kind === "remove"));
  const pending = (t: TargetRef) => keepsOn(w, t).length > 0 || leasesOn(w, t).length > 0 || parksOn(w, t).some(p => !isParked(p.state));
  for (const r of rows) for (const a of r.actions) if (a.kind === "try_again_now" && a.enabled && (!r.target || !pending(r.target)))
    return fail(I, `row ${r.target} offers Try again now with nothing pending`, w.step);
  const covered = (pred: (r: SurfaceRow) => boolean, what: string, unknownToHome: boolean): Verdict => {
    const row = rows.find(pred);
    if (row && (enabledKR(row) || (row.target !== null && pending(row.target) && row.actions.some(a => a.enabled)))) return OK;
    if (unknownToHome && unknownExcused(w)) return OK; // A5-H5, F5-M1: restore-check row, or owner-confirmed with discovery pending
    return fail(I, `${what} has no visible row with an enabled action`, w.step);
  };
  const refInboxes = locallyReferencedInboxes(w.local), refKeys = locallyReferencedKeys(w.local), refOps = locallyReferencedOps(w.local);
  // A5-H7: only a CURRENT-epoch Remove (a restore invalidates older ones) on an inbox with no park, and no later Keep, exempts it.
  const removedByOwner = (fi: FluxInbox) => {
    if (fi.state !== "closing" || fi.closingCause?.kind !== "delete") return false;
    const req = w.flux.requests.find(r => r.requestId === (fi.closingCause as { requestId: RequestId }).requestId);
    const a = req ? authorityById(w, req.authorityId) : undefined;
    return !!a && REMOVE_KINDS.has(a.kind) && a.epoch === w.ghost.epoch && !parksOn(w, inboxTarget(fi.inboxId)).length &&
      !w.ghost.keeps.some(k => k.inboxId === fi.inboxId && k.claimedAtStep > a.verifiedAtStep);
  };
  for (const fi of values(w.flux.inboxes)) {
    if (!fi.installOwned || fi.state === "purged" || removedByOwner(fi)) continue;
    const owner = values(w.local.bindings).find(b => b.gen.inboxId === fi.inboxId && botPresent(w, b.botId) && b.state !== "removal_parked");
    if (owner) {
      // F5-M3: a guard answers only a DELETE closing; a Flux closing is always offered on the bot row.
      const guardHandles = !!w.local.keepGuards[fi.inboxId] && fi.closingCause?.kind === "delete";
      if (fi.state === "closing" && !leasesOn(w, inboxTarget(fi.inboxId)).length && !guardHandles) {
        const v = covered(r => r.section === "bot" && r.botId === owner.botId && r.actions.some(a => a.enabled && a.kind === "keep"), `closing inbox ${fi.inboxId} of a present bot`, false);
        if (!v.ok) return v;
      }
      continue;
    }
    const v = covered(r => r.inboxId === fi.inboxId || (fi.createdUnderOp !== null && r.provisionOpId === fi.createdUnderOp), `orphan inbox ${fi.inboxId}`,
      !refInboxes.has(fi.inboxId) && !(fi.createdUnderOp && refOps.has(fi.createdUnderOp)));
    if (!v.ok) return v;
  }
  for (const k of values(w.flux.keys)) {
    if (!k.installOwned || k.state !== "live" || keyInUse(w, k.keyId, null)) continue;
    if (values(w.local.bindings).some(b => b.gen.emailKeyRef === k.keyId && botPresent(w, b.botId) && b.state !== "removal_parked")) continue;
    const v = covered(r => r.keyIds.includes(k.keyId) || (k.mintedUnderOp !== null && r.provisionOpId === k.mintedUnderOp), `orphan key ${k.keyId}`,
      !refKeys.has(k.keyId) && !(k.mintedUnderOp && refOps.has(k.mintedUnderOp)));
    if (!v.ok) return v;
  }
  for (const p of values(w.local.parks)) {
    if (p.inboxId !== null || botPresent(w, p.botId) || !isParked(p.state)) continue;
    const row = rows.find(r => r.section === "key_only" && r.target === p.target);
    if (!row || !row.actions.some(a => a.enabled && a.kind === "keep") || !row.actions.some(a => a.enabled && a.kind === "remove"))
      return fail(I, `key-only park ${p.parkId} must show enabled Keep and Remove`, w.step);
  }
  for (const b of values(w.local.bindings)) {
    if (b.state !== "provisioning" || b.gen.inboxId !== null || botPresent(w, b.botId)) continue;
    const v = covered(r => r.section === "key_only" && r.botId === b.botId, `key-only orphan ${b.botId}`, false);
    if (!v.ok) return v;
  }
  return OK;
};

/** (d, A4-H8, A4-H9, F4-L2, A5-H1) viewMintsScopedTokens. Tokens are minted ONLY by an owner view, and only for an enabled action on
 *  a visible row of that view. When the owner views the surface, every enabled Remove, and every enabled Keep on an orphan or key-only
 *  row, carries a token minted in that step by this process and epoch for that owner, showing EXACTLY that row: target, inbox, key set
 *  (no undisplayed key, A5-H1), bot, and the address the binding (b) or park (p) holds; at the CURRENT generation (b) or park revision (p).
 *  r3.3 (FA-L7): a bot-row Keep needs no token (R2-Q5) but MAY carry a fresh one, judged like any other. */
// PERMITTED ACTION: at an owner view, mint a fresh token per enabled Keep/Remove action showing exactly its row.
export const viewMintsScopedTokens: StepInvariant = (prev, action, next) => {
  const I = "viewMintsScopedTokens";
  const fresh = next.ghost.tokens.slice(prev.ghost.tokens.length);
  if (action.t !== "owner.viewSurface") return fresh.length ? fail(I, `token minted by ${action.t}, not by an owner view`, next.step) : OK;
  const sameKeys = (a: KeyId[], b: KeyId[]) => a.length === b.length && a.every(k => b.includes(k));
  const carriedBy = new Set<TokenId>();
  for (const r of next.surface) {
    if (!r.visible) continue;
    for (const a of r.actions) {
      if (!a.enabled || a.kind === "try_again_now") continue;
      if (a.kind === "keep" && r.section === "bot" && a.tokenId === null) continue; // R2-Q5; r3.3 (FA-L7): a carried token is judged
      const t = tokenById(next, a.tokenId);
      if (!t) return fail(I, `${a.kind} on ${r.target} has no token`, next.step);
      carriedBy.add(t.tokenId);
      if (t.issuedAtStep !== next.step || t.processId !== next.proc.processId || t.epoch !== next.ghost.epoch || t.issuedTo !== action.principal)
        return fail(I, `${a.kind} token on ${r.target} not minted fresh for this owner`, next.step);
      if (t.shown.target !== r.target) return fail(I, `${a.kind} token on ${r.target} shows another target`, next.step);
      if (t.shown.inboxId !== r.inboxId || !sameKeys(t.shown.keyIds, r.keyIds)) return fail(I, `${a.kind} token on ${r.target} shows other inbox or keys than its row`, next.step);
      if (t.kind === "b") {
        const b = t.botId ? next.local.bindings[t.botId] : undefined;
        if (!b || t.botId !== r.botId || !sameGeneration(t.gen, b.gen)) return fail(I, "b token not at the row bot's current generation", next.step);
        if (t.shown.address !== b.address) return fail(I, "b token shows another address", next.step);
      }
      if (t.kind === "p") {
        const p = t.park ? next.local.parks[t.park.parkId] : undefined;
        if (!p || !t.park || p.parkRev !== t.park.parkRev || p.target !== r.target) return fail(I, "p token not at the row park's current revision", next.step);
        if (t.shown.address !== p.address) return fail(I, "p token shows another address", next.step);
      }
    }
  }
  for (const t of fresh) if (!carriedBy.has(t.tokenId)) return fail(I, `token ${t.tokenId} minted for no visible enabled action`, next.step);
  return OK;
};

/** (d, F3-M3) keyOnlyActionsTouchNoInbox. Key-only Keep and Remove send no GET, RESTORE or DELETE. */
// PERMITTED ACTION: a key-only Remove sends a revoke (never GET / RESTORE / DELETE).
export const keyOnlyActionsTouchNoInbox: StepInvariant = (prev, action, next) => {
  if (action.t !== "net.send" || !["DELETE_INBOX", "RESTORE_INBOX", "GET_INBOX"].includes(action.request.kind)) return OK;
  const k = action.request.keepOp ? prev.local.keepOps[action.request.keepOp] : undefined;
  if (k && k.inboxId === null) return fail("keyOnlyActionsTouchNoInbox", `key-only Keep sent ${action.request.kind}`, next.step);
  const a = authorityById(prev, action.request.authorityId);
  if (a && a.kind === "remove_key_only") return fail("keyOnlyActionsTouchNoInbox", `key-only Remove sent ${action.request.kind}`, next.step);
  return OK;
};

/** (d, a, point 1) blindRestoreIsOwnerVisible. While the latest restore is blind and unconfirmed, the running home shows a visible
 *  restore-check row with an enabled confirm action: a lost guard or key is never silent. */
export const blindRestoreIsOwnerVisible: StateInvariant = w => {
  if (w.proc.phase !== "running" || !blindUnconfirmed(w)) return OK;
  return w.surface.some(r => r.visible && r.section === "restore_check" && r.actions.some(a => a.enabled && a.kind === "confirm_inventory"))
    ? OK : fail("blindRestoreIsOwnerVisible", "blind restore with no owner-visible restore check", w.step);
};

// ---------- (e) Keep and Remove for one target are serialized -------------------------------------------------------------------------

/** (e, A4-H3) keepAndRemoveSerialized. Per target (inbox, provisioning op or bot keys): at most one open Keep op; an open Keep op
 *  excludes a lease in authorized/sending/unknown/acked; at most one lease per inbox. */
export const keepAndRemoveSerialized: StateInvariant = w => {
  const I = "keepAndRemoveSerialized";
  for (const t of new Set(values(w.local.keepOps).map(k => k.target))) {
    if (keepsOn(w, t).length > 1) return fail(I, `two open Keep ops on ${t}`, w.step);
    if (leasesOn(w, t).some(l => l.phase !== "keeping" && l.phase !== "gone")) return fail(I, `open Keep and active removal on ${t}`, w.step);
  }
  const seen = new Set<InboxId>();
  for (const l of values(w.local.leases)) if (l.inboxId) { if (seen.has(l.inboxId)) return fail(I, `two leases on ${l.inboxId}`, w.step); seen.add(l.inboxId); }
  return OK;
};

/** (e) noRemoveDuringKeep. While a Keep op is open on a target, no Remove authority is created for it and no DELETE or revoke under a
 *  Remove authority is sent for it (key-only targets included, A4-H3). */
// PERMITTED ACTION: create a Remove authority on a target with no open Keep op.
export const noRemoveDuringKeep: StepInvariant = (prev, action, next) => {
  const I = "noRemoveDuringKeep";
  for (const a of newAuthorities(prev, next)) if (REMOVE_KINDS.has(a.kind) && a.scope.target && keepsOn(prev, a.scope.target).length)
    return fail(I, `Remove authorized on ${a.scope.target} while a Keep is open`, next.step);
  if (action.t === "net.send" && (action.request.kind === "DELETE_INBOX" || action.request.kind === "REVOKE_KEY")) {
    const a = authorityById(prev, action.request.authorityId);
    const t = requestTarget(prev, action.request);
    if (a && REMOVE_KINDS.has(a.kind) && t && keepsOn(prev, t).length) return fail(I, `${action.request.kind} on ${t} while a Keep is open`, next.step);
  }
  return OK;
};

/** (e, A3-H2) keepNetworkNeedsClaim. Every Keep GET or RESTORE (including OW12's Flux-closing Keep) runs under an open Keep op claimed
 *  earlier for that inbox. */
// PERMITTED ACTION: send a Keep GET / RESTORE under an open Keep op for that inbox.
export const keepNetworkNeedsClaim: StepInvariant = (prev, action, next) => {
  if (action.t !== "net.send" || action.request.purpose !== "keep") return OK;
  const op = action.request.keepOp ? prev.local.keepOps[action.request.keepOp] : undefined;
  return op && op.inboxId === action.request.target ? OK : fail("keepNetworkNeedsClaim", `Keep ${action.request.kind} on ${action.request.target} without a claim`, next.step);
};

/** (e, A3-M8) keepOpsFreshAndCasChecked. A new Keep op id was never used before; an answer for a Keep op no longer open changes no park,
 *  lease, binding or guard. */
// PERMITTED ACTION: open a Keep op with a never-used id.
export const keepOpsFreshAndCasChecked: StepInvariant = (prev, action, next) => {
  const I = "keepOpsFreshAndCasChecked";
  for (const id of Object.keys(next.local.keepOps)) if (!prev.local.keepOps[id] && prev.ghost.usedKeepOps.includes(id)) return fail(I, `Keep op ${id} reused`, next.step);
  if (action.t === "net.answer") {
    const r = prev.flux.requests.find(x => x.requestId === action.requestId);
    const snap = (w: World) => JSON.stringify([w.local.parks, w.local.leases, w.local.bindings, w.local.keepGuards]);
    if (r?.keepOp && !prev.local.keepOps[r.keepOp] && snap(prev) !== snap(next)) return fail(I, `stale answer for closed Keep op ${r.keepOp} changed state`, next.step);
  }
  return OK;
};

/** Legal refusal codes and their preconditions (F4-H2, point 2). Any other refusal, or a listed one without its precondition, is a
 *  violation; so an owner action with a valid token on an admissible target MUST succeed. No code depends on a clock (F3-M1). */
export const KEEP_REFUSALS = ["removal_sending", "keep_pending", "confirm_expired", "inbox_gone", "bot_present"] as const;
/** r3.3b: the owner-visible line a stale untokened Keep refusal shows on the bot's row (SurfaceRow.line; no new state field). */
export const LOOK_AGAIN_LINE = "This bot's email changed since you looked. Look again, then choose.";
/** r3.3b: the bot's CURRENT LIVE binding target: a present bot whose binding is not removal_parked, named by its inbox, else its
 *  provisioning op, else the bot (queuedRemovals' target rule), with no park on that target. */
function currentLiveBindingTarget(prev: World, b: BotId): TargetRef | null {
  const bind = prev.local.bindings[b];
  if (!bind || !botPresent(prev, b) || bind.state === "removal_parked") return null;
  const t = bind.gen.inboxId ? inboxTarget(bind.gen.inboxId) : bind.gen.opId ? opTarget(bind.gen.opId) : botTarget(b);
  return parksOn(prev, t).length ? null : t;
}
export const REMOVE_REFUSALS = ["keep_pending", "confirm_expired", "bot_present"] as const;
function tokenProblem(prev: World, tokenId: TokenId | null, target: TargetRef, needed: boolean): boolean {
  if (tokenId === null) return needed;
  const t = tokenById(prev, tokenId);
  if (!t || !OWNER_PRINCIPALS.has(t.issuedTo) || t.processId !== prev.proc.processId || t.epoch !== prev.ghost.epoch || prev.nowMs > t.issuedAtMs + TOKEN_TTL_MS || t.shown.target !== target) return true;
  if (t.botId !== null && t.issuedAtStep <= (prev.ghost.lastParkOrRestoreStep[t.botId] ?? -1)) return true; // r3.2 Fable L3: as authorityCreationVerdict
  const tb = tokenBot(prev, t); // r3.3e (Astra r3.3d Medium): a p token speaks for its park's bot. MUTANT token-bot-ignores-park (t.botId only)
  if (tb !== null && t.issuedAtStep <= (prev.ghost.botDeletedAtStep[tb] ?? -1)) return true; // r3.3d (R3-Q4): killed by an ok deleteBot. MUTANT token-ignores-bot-delete
  if (t.kind === "b" && (!t.botId || !sameGeneration(t.gen, prev.local.bindings[t.botId]?.gen ?? null))) return true;
  if (t.kind === "p" && (!t.park || prev.local.parks[t.park.parkId]?.parkRev !== t.park.parkRev)) return true;
  return false;
}
/** (e) admissionPinned. Keep is admitted while a removal is authorized / unknown / acked and refused (code removal_sending) only while
 *  a lease on the target is `sending`; Remove is admitted unless a Keep is open; Try again now succeeds whenever work is pending.
 *  r3 (A5-H6, F5-H1): an ADMITTED (ok) action must do its work in the same step: an ok Keep creates a valid Keep authority on its target,
 *  a fresh Keep op naming it (or completes inline, key-only) and the Keep history record; an ok Remove creates a valid Remove authority
 *  on its target and a fresh lease naming it. `bot_present` is legal only where the row's premise is an ABSENT bot (other-setup or
 *  key-only row, or an orphan / key-only Keep, with no park on the target); `inbox_gone` only on evidence the home has seen (a
 *  parked_evidence park, a gone lease, a delivered not_found answer, a delivered deleted event). */
// PERMITTED ACTION: refuse with a listed code while its precondition holds (r3.3b: refuse a stale untokened Keep confirm_expired, purely,
// with the look-again line); admit an owner Keep / Remove by creating its authority,
// Keep op + history (Keep) or lease (Remove) in the same step; admit an owner bot delete with a delete authority and lease per bot.
// r3.4d SHADOW deletions (admissionPinned, 13 of 16): #9 `o.ok` and #19 `o.ok` (dead branch at :2024 and :2032: an ok outcome has code undefined, the code test already fails it); #26 `kinds.has(a.kind)`, #27 `a.scope.target === t`, #43 `a.kind === bot_delete_with_token` (implied by authorityCreationVerdict kindOk / target checks at :858); #38 #57 `OWNER_PRINCIPALS.has(action.principal)` on the deleteBot and Keep ok branches (dead branch at :2011: a non-owner ok outcome fails there first); #59 #74 `!as.length` (dead branch at the next guard: no new authority means no Keep record and no lease); #80 #98 `action.outcome.ok` (dead branch at the ok branches above, which return first; the code is read through a cast); #104 #106 keepsOn / parksOn in the Try-again-now pending test (dead branch at :2128: only a lease can be pending on a bot:* target). NOT removed: #72 (the Remove ok branch keeps its owner test: it is the only path that kills the line-2010 guard, witness s23-owner-ok-remove-by-bot-principal; dropping both leaves that guard a survivor), #108 #110 (witness try-again-refused-while-pending needs the pending test).
// r3.4d SHADOW deletions (admissionPinned, #62 `OWNER_PRINCIPALS.has(action.principal)` of the owner.remove admission block): dead branch at :2012, the owner-principal rule returns first for every non-owner ok decision. The principal rule is kept alive by witness cm-admissionPinned-5-try-again-ok-by-bot-principal-lease-pending (an ok Try again now by a bot principal). #108/#110 (now #90/#92) are KILLED by cm-admissionPinned-90-try-again-bot-ok-lease-pending, not SHADOW.
export const admissionPinned: StepInvariant = (prev, action, next) => {
  const I = "admissionPinned";
  // r3.4d-s23 (page S20, Q#34): owner.* decisions are admitted ONLY for an owner principal; any other principal's ok outcome is a violation. MUTANT owner-principal-unchecked
  if ("principal" in action && action.t !== "owner.viewSurface" && !OWNER_PRINCIPALS.has(action.principal) && ownerOutcomeOf(action).ok) return fail(I, `${action.t} admitted for non-owner principal ${action.principal}`, next.step);
  // r3.3h (Astra r3.3g #5): ONE window-refusal rule. While a replacement prep is pending (prepPending(prev); reducer R1 reads the restore
  // marker, never proc.phase) every owner decision (keep, remove, deleteBot, tryAgainNow, reconnect, confirmInventory, restore, r3.4b backup) is
  // refused (only restore_finishing, below); keptKeysProtected makes it pure and visible. Outside the window the per-kind rules below
  // apply unchanged, so an ordinary boot refuses nothing. MUTANTS window-refusal-not-legal, window-refusal-by-phase.
  // r3.3i (D): keyed on R1's flag span (windowOpen: a pending prep or an armed owner restore).
  // r3.4 (Astra r3.3i #4, Fable F2): the window opens at phase armed; inside it the ONLY legal outcome of an owner decision is a
  // restore_finishing refusal (an admitted decision, or any other code such as confirm_expired, is wrong).
  // r3.4c (Opus check L3): "Try again" while the job is prepared or aborted but not yet cleared: refused restore_finishing, pure, with
  // RESTORE_FINISHING_LINE on the home row. MUTANT finished-job-restore-any-code.
  const fj = jobOf(prev);
  if (action.t === "owner.restore" && fj && (fj.phase === "prepared" || fj.phase === "aborted")) {
    const o = ownerOutcomeOf(action);
    const oc = (o as { code: string }).code; // an ok outcome has no code (undefined), so the one test below also fails it
    if (oc !== "restore_finishing") return fail(I, `owner.restore ${o.ok ? "admitted" : "refused " + oc} while job ${fj.id} is ${fj.phase} and not cleared: only restore_finishing (r3.4c)`, next.step);
    if (windowDurable(prev) !== windowDurable(next)) return fail(I, `restore_finishing refusal of a finished job changed state (r3.4c)`, next.step);
    if (!next.surface.some(r => r.visible && r.section === "home" && r.line === RESTORE_FINISHING_LINE)) return fail(I, `restore_finishing refusal of a finished job shows no line (r3.4c)`, next.step);
    return OK;
  }
  if (windowOpen(prev) && WINDOW_DECISIONS.has(action.t)) {
    const o = ownerOutcomeOf(action);
    const wc = (o as { code: string }).code; // an ok outcome has no code (undefined): not in WINDOW_REFUSAL_CODES, so it fails here
    if (!(WINDOW_REFUSAL_CODES as readonly string[]).includes(wc)) return fail(I, `owner ${action.t} ${o.ok ? "admitted" : "refused " + wc} while a restore window is open: only restore_finishing (r3.4)`, next.step);
    return OK;
  }
  // r3.2 (Fable M2, L1): `bot_present` keys on the TARGET row's premise, not the action's bot: legal only while some present bot's live
  // (not removal_parked) binding names the target's inbox or provisioning op, and no park holds the target.
  const premiseAbsentBot = (absentPremise: boolean, _bot: BotId | null, t: TargetRef) => {
    if (!absentPremise || parksOn(prev, t).length) return false;
    const ib = inboxOfTarget(prev, t), op = t.startsWith("op:") ? t.slice(3) : null;
    return values(prev.local.bindings).some(b => botPresent(prev, b.botId) && b.state !== "removal_parked" && ((ib !== null && b.gen.inboxId === ib) || (op !== null && b.gen.opId === op)));
  };
  const created = () =>
    newAuthorities(prev, next).filter(a => authorityCreationVerdict(prev, action, next, a) === null);
  // r3.2 (Fable M3): `inbox_gone` only on PURGE evidence (a delivered not_found answer or a delivered deleted event). A parked_evidence
  // park or a gone lease is CLOSING evidence: the inbox is restorable for 30 d, and Keep on it is the standing order's main path.
  const inboxGone = (t: TargetRef): boolean => {
    const ib = inboxOfTarget(prev, t);
    if (ib === null) return false;
    return prev.flux.requests.some(r => r.target === ib && r.answer === "delivered" && r.answerSeen?.result === "not_found") ||
      prev.flux.events.some(e => e.inboxId === ib && e.type === "email.inbox.deleted" && e.deliveredToHome);
  };
  // r3.2 (A6-M5, R3-Q4): an ok owner.deleteBot does its work in the same step, PER NAMED BOT that holds anything (binding with an inbox,
  // op or key, a saved key, or a park): a valid bot_delete_with_token authority of that bot; for each such authority a fresh lease of
  // that bot on the authority's target naming it; and every park on that target leaves parked / keep_pending for remove_authorized
  // (the delete's parks never wait for ever). Parks of the bot on OTHER targets were not shown in the delete and stay owner choices ((d)).
  if (action.t === "owner.deleteBot" && action.outcome.ok) {
    for (const b of action.botIds) {
      const bind = prev.local.bindings[b];
      const holds = (!!bind && (bind.gen.inboxId !== null || bind.gen.opId !== null || bind.gen.emailKeyRef !== null)) || !!prev.local.savedKeys[b] || values(prev.local.parks).some(p => p.botId === b);
      if (!holds) continue;
      const as = newAuthorities(prev, next).filter(a => a.botId === b && authorityCreationVerdict(prev, action, next, a) === null);
      if (!as.length) return fail(I, `bot ${b} deleted without a valid delete authority (A6-M5)`, next.step);
      for (const a of as) {
        const t = a.scope.target;
        if (t === null) return fail(I, `delete authority ${a.authorityId} of ${b} names no target (A6-M5)`, next.step);
        if (!values(next.local.leases).some(l => !prev.local.leases[l.removalId] && l.target === t && l.botId === b && l.authorityId === a.authorityId))
          return fail(I, `bot ${b} deleted without removal work (lease) on ${t} (A6-M5)`, next.step);
        for (const p of parksOn(prev, t)) { const n = next.local.parks[p.parkId]; if (n && n.state !== "remove_authorized") return fail(I, `park ${p.parkId} on deleted ${t} left ${n.state} (A6-M5)`, next.step); }
      }
    }
    return OK;
  }
  if (action.t === "owner.keep" && action.outcome.ok) {
    const t = action.target, as = created();
    const rec = next.ghost.keeps.slice(prev.ghost.keeps.length).find(k => k.target === t && k.claimedAtStep === next.step && as.some(a => a.authorityId === k.authorityId));
    if (!rec) return fail(I, `Keep on ${t} admitted without a Keep history record (A5-H6)`, next.step);
    const op = next.local.keepOps[rec.keepOp];
    const opened = !!op && !prev.local.keepOps[rec.keepOp] && op.target === t && op.authorityId === rec.authorityId;
    if (!opened && rec.succeededAtStep !== next.step) return fail(I, `Keep on ${t} admitted without opening its Keep op (A5-H6)`, next.step);
    return OK;
  }
  if (action.t === "owner.remove" && action.outcome.ok) {
    const t = action.target, as = created();
    if (!values(next.local.leases).some(l => !prev.local.leases[l.removalId] && l.target === t && as.some(a => a.authorityId === l.authorityId)))
      return fail(I, `Remove on ${t} admitted without a lease naming its authority (A5-H6)`, next.step);
    return OK;
  }
  if (action.t === "owner.keep") {
    if (!OWNER_PRINCIPALS.has(action.principal)) return OK;
    const code = (action.outcome as { code: string }).code, t = action.target;
    const needsToken = action.mode === "orphan" || action.mode === "key_only";
    // r3.3b (ruling): an UNTOKENED bot-row Keep whose target is not the bot's current live binding (the owner's screen is stale: the
    // bot was re-bound or parked) may be refused confirm_expired; it must then be pure and tell the owner to look again.
    const staleUntokened = !needsToken && action.tokenId === null && currentLiveBindingTarget(prev, action.botId) !== t;
    const pre: Record<string, boolean> = {
      removal_sending: leasesOn(prev, t).some(l => l.phase === "sending"),
      keep_pending: keepsOn(prev, t).length > 0,
      confirm_expired: staleUntokened || tokenProblem(prev, action.tokenId, t, needsToken),
      inbox_gone: inboxGone(t),
      bot_present: premiseAbsentBot(needsToken, action.botId, t),
    };
    if (!(KEEP_REFUSALS as readonly string[]).includes(code) || !pre[code]) return fail(I, `Keep on ${t} refused "${code}" without its precondition`, next.step);
    if (code === "confirm_expired" && staleUntokened) {
      const snap = (w: World) => JSON.stringify([w.local.parks, w.local.bindings, w.local.keepOps, w.ghost.authorities, w.ghost.keeps, w.ghost.usedKeepOps]);
      if (snap(prev) !== snap(next)) return fail(I, `stale Keep refusal on ${t} changed a park, binding, authority or Keep obligation (r3.3b)`, next.step);
      // r3.3c (Astra r3.3b Low): the look-again line must sit on the bot's own row. MUTANT look-again-any-section.
      if (!next.surface.some(r => r.visible && r.section === "bot" && r.botId === action.botId && r.line === LOOK_AGAIN_LINE))
        return fail(I, `stale Keep refusal on ${t} shows the owner no look-again line (r3.3b)`, next.step);
    }
    return OK;
  }
  if (action.t === "owner.remove") {
    if (!OWNER_PRINCIPALS.has(action.principal)) return OK;
    const code = (action.outcome as { code: string }).code, t = action.target;
    const pre: Record<string, boolean> = {
      keep_pending: keepsOn(prev, t).length > 0,
      confirm_expired: tokenProblem(prev, action.tokenId, t, true),
      bot_present: premiseAbsentBot(action.section === "other_setup" || action.section === "key_only", action.botId, t),
    };
    if (!(REMOVE_REFUSALS as readonly string[]).includes(code) || !pre[code]) return fail(I, `Remove on ${t} refused "${code}" without its precondition`, next.step);
    return OK;
  }
  if (action.t === "owner.tryAgainNow") {
    const t = action.target;
    // r3.4d-s23 (page S20, restore-reducer :445): Try again now is admitted only for a bot target; any other target is refused not_a_bot_target (pure). MUTANT try-again-non-bot-admitted
    if (!t.startsWith("bot:")) return action.outcome.ok ? fail(I, `Try again now admitted on non-bot target ${t}`, next.step) : OK;
    const pending = leasesOn(prev, t).length > 0; // a keep op or park cannot be pending on a bot:* target, only a lease
    if (pending && !action.outcome.ok) return fail(I, `Try again now refused on pending ${t}`, next.step);
    if (!pending && action.outcome.ok) return fail(I, `Try again now "succeeded" with nothing pending on ${t}`, next.step);
  }
  return OK;
};

// ---------- (f) Key targets are never lost ---------------------------------------------------------------------------------------------

/** (f) keyTargetsNeverLost. Every live key of this install stays reachable from a durable local record or from a provisioning op one
 *  names. After a blind restore, a key unknown to the home is excused by the SAME rule as (d) (unknownExcused, A5-H5): the restore-check
 *  row while unconfirmed; after confirmation, while discovery is pending (listing not shipped, or no complete listing answered yet;
 *  ruling Q2, R2-Q4). Once a complete listing is answered every listed key needs a record; (h) requires that pass to run. */
export const keyTargetsNeverLost: StateInvariant = w => {
  if (w.proc.phase === "down" || w.proc.phase === "boot_prep") return OK;
  const keys = locallyReferencedKeys(w.local), ops = locallyReferencedOps(w.local);
  for (const k of values(w.flux.keys)) {
    if (!k.installOwned || k.state !== "live") continue;
    if (keys.has(k.keyId) || (k.mintedUnderOp !== null && ops.has(k.mintedUnderOp))) continue;
    if (unknownExcused(w)) continue;
    return fail("keyTargetsNeverLost", `live key ${k.keyId} has no local record`, w.step);
  }
  return OK;
};

/** (f, A3-M7) keyTargetEntriesNeverDropped. A pending key target leaves its park or lease only once revoked at Flux AND its secret is no
 *  longer saved, or because the key is still referenced elsewhere. */
// PERMITTED ACTION: drop a key target once the key is revoked at Flux (or referenced elsewhere).
export const keyTargetEntriesNeverDropped: StepInvariant = (prev, action, next) => {
  if (action.t === "auto.swap" || action.t === "auto.restorePrepare") return OK;
  const refs = locallyReferencedKeys(next.local);
  const targets = [...values(prev.local.parks).flatMap(p => p.keyTargets), ...values(prev.local.leases).flatMap(l => l.keyTargets)];
  for (const t of targets) {
    if ((t.status !== "pending" && t.status !== "revoked_clear_pending") || refs.has(t.keyId)) continue;
    if (next.flux.keys[t.keyId]?.state === "live") return fail("keyTargetEntriesNeverDropped", `target ${t.keyId} dropped while live at Flux`, next.step);
  }
  return OK;
};

/** (f, A3-M10, A4-H10) savedKeyNeverOutlivesRevokeWithoutWork. A saved secret whose key Flux has revoked is always covered by a durable
 *  pending or revoked_clear_pending target (an unanswered revoke is legitimate work); a target becomes `revoked` only after the secret
 *  is gone. At quiescence no revoked key is saved (quiescentModuloWaiting). */
// PERMITTED ACTION: Flux revokes a saved key while a durable pending key target covers it.
export const savedKeyNeverOutlivesRevokeWithoutWork: StepInvariant = (_prev, _a, next) => {
  const I = "savedKeyNeverOutlivesRevokeWithoutWork";
  const targets = [...values(next.local.parks).flatMap(p => p.keyTargets), ...values(next.local.leases).flatMap(l => l.keyTargets)];
  const rotating = (k: KeyId) => values(next.local.rotations).some(r => r.oldKeyId === k);
  for (const bot of Object.keys(next.local.savedKeys)) {
    const k = next.local.savedKeys[bot];
    if (!k) continue;
    if (next.flux.keys[k]?.state === "revoked" && !rotating(k) && !targets.some(t => t.keyId === k && (t.status === "pending" || t.status === "revoked_clear_pending")))
      return fail(I, `bot ${bot} keeps revoked key ${k} with no durable work`, next.step);
    if (targets.some(t => t.keyId === k && t.status === "revoked")) return fail(I, `target ${k} marked revoked while its secret is saved`, next.step);
  }
  return OK;
};

// ---------- (g) The Cloud marker and preparation ------------------------------------------------------------------------------------

/** (g) markerNeverArchivedAndConsumedAtBoot. No archive of any kind carries the marker (A3-M16); the store never opens with a live
 *  marker; the marker is unlinked only after its prep committed; boot prep never ends with the marker present. */
// PERMITTED ACTION: write an archive without the marker; unlink the marker after its prep.
// r3.4d SHADOW deletions: #12 `action.t === auto.bootPrep` (implied by the Action type at :2196: only auto.bootPrep carries outcome "ok"; read through a cast).
export const markerNeverArchivedAndConsumedAtBoot: StepInvariant = (prev, action, next) => {
  const I = "markerNeverArchivedAndConsumedAtBoot";
  for (const a of next.archives) if (a.topLevelNames.some(n => n === MARKER_NAME || n.endsWith("/" + MARKER_NAME))) return fail(I, `archive ${a.archiveId} carries the marker`, next.step);
  if ((next.proc.phase === "store_open" || next.proc.phase === "running") && next.fs.liveMarker) return fail(I, "store opened with a live marker", next.step);
  if (prev.fs.liveMarker && !next.fs.liveMarker && next.fs.messagesDbPresent && !next.ghost.preparedResets.includes(prev.fs.liveMarker.resetId)) return fail(I, "marker unlinked before its prep", next.step);
  if ((action as { outcome?: unknown }).outcome === "ok" && next.fs.liveMarker) return fail(I, "boot prep left the marker", next.step); // cast guarded by ASSERT_OK_OUTCOME_ONLY_BOOT_PREP (end of file)
  return OK;
};

/** (g, r3.4 redesign; Astra r3.3i #3, Fable F1) restoreJobMatchesReality, the replacement for r3.3i's restorePendingTracksPrep. At every
 *  reachable state and every crash point the job's durable phase matches the world (the archive installed or not, the carry present or
 *  not, the prep committed or not):
 *    no job   : no prep pending, no carry;
 *    armed    : this job's archive not installed; a carry may exist only as a capture whose W26 was lost (R1: capture again);
 *    captured : not installed; a complete carry present;
 *    swapped  : installed in the current epoch, its prep not committed; a non-blind swap keeps its carry;
 *    prepared : installed and its prep committed (the carry may remain until the clear deletes it);
 *    aborted  : not installed;
 *  and a pending prep exists only in phase swapped. */
// PERMITTED STATE: a job in the phase its last durable write recorded, with the carry, archive and prep that phase implies.
export const restoreJobMatchesReality: StateInvariant = w => {
  const I = "restoreJobMatchesReality", j = jobOf(w);
  if (!j) {
    if (prepPending(w)) return fail(I, `prep of epoch ${w.ghost.epoch} pending with no restore job (r3.4)`, w.step); // MUTANT job-reality-unchecked
    if (w.carry) return fail(I, `carry ${w.carry.carryId} with no restore job (r3.4)`, w.step);
    return OK;
  }
  // r3.4b (Opus check N2): the journal stores only armed / captured / aborted; swapped and prepared are the database marks (W27, W28).
  const jr = journalOf(w)!;
  if (jr.phase === "swapped" || jr.phase === "prepared") return fail(I, `journal of job ${jr.id} holds phase ${jr.phase}: only the database marks W27 / W28 may say so (r3.4b)`, w.step); // MUTANT journal-holds-db-phase
  if (jr.phase === "aborted" && j.phase !== "aborted") return fail(I, `job ${j.id} aborted in its journal but ${j.phase} in the database (r3.4b)`, w.step);
  // r3.4b (Opus check N1): a carry belongs to the job whose armed capture made it.
  if (w.carry && w.carry.jobId !== j.id) return fail(I, `carry ${w.carry.carryId} belongs to job ${w.carry.jobId ?? "none"}, not job ${j.id} (r3.4b)`, w.step); // MUTANT carry-job-unchecked
  const rec = w.ghost.restores.find(r => r.jobId === j.id);
  const prepared = !!rec && w.ghost.preparedEpochs.includes(rec.epochAfter);
  if (prepPending(w) && j.phase !== "swapped") return fail(I, `prep of epoch ${w.ghost.epoch} pending while job ${j.id} is ${j.phase} (r3.4)`, w.step);
  switch (j.phase) {
    case "armed": case "aborted":
      if (rec) return fail(I, `job ${j.id} is ${j.phase} but its archive ${rec.archiveId} was installed (r3.4)`, w.step);
      break;
    case "captured":
      if (rec) return fail(I, `job ${j.id} is captured but its archive was installed (r3.4)`, w.step);
      if (!w.carry || !w.carry.complete) return fail(I, `job ${j.id} is captured with no complete carry (r3.4)`, w.step);
      break;
    case "swapped":
      if (!rec || rec.epochAfter !== w.ghost.epoch) return fail(I, `job ${j.id} is swapped but its archive is not the installed epoch (r3.4)`, w.step);
      if (prepared) return fail(I, `job ${j.id} is swapped but its prep committed (r3.4)`, w.step);
      if (!rec.blind && !w.carry) return fail(I, `job ${j.id} is swapped (not blind) and lost its carry (r3.4)`, w.step);
      if (rec.blind && w.carry) return fail(I, `job ${j.id} is swapped blind but holds carry ${w.carry.carryId} (r3.4b)`, w.step);
      break;
    case "prepared":
      if (!prepared) return fail(I, `job ${j.id} is prepared but no prep of its epoch committed (r3.4)`, w.step);
      break;
  }
  return OK;
};

/** (g, r3.4 redesign) restoreJobProtocol. The job changes only by its named steps (R1), each in its own durable write:
 *    none / finished -> armed  : an admitted owner.restore (same archive and source) or auto.restoreArm, at = this step, a new id;
 *    armed -> captured         : auto.captureOutgoing (a carry present);
 *    armed / captured -> swapped: auto.swap of the job's archive and source (from armed only when blind), the new restore record names the job;
 *    swapped -> prepared       : the prep that commits its epoch (restore prep, or boot prep after a crash);
 *    armed / captured -> aborted: auto.restoreAbort, which changes NOTHING else but the surface and shows RESTORE_FAILED_LINE on the home row;
 *    prepared / aborted -> none: auto.restoreJobClear, the carry deleted.
 *  id, archive and source never change; no other step (a crash or boot included) changes the job. A capture or swap that does not belong
 *  to the open job is refused; an admitted owner.restore always arms; nothing arms over an open job. */
// PERMITTED ACTION: arm, capture, swap, prep, abort and clear a job in this order; abort an armed or captured job purely.
// r3.4d SHADOW deletions: #10 `action.t === auto.restoreAbort` (implied by the Action type at :2268: only auto.restoreAbort carries that reason; read through a cast); #71 `!!p` (dead branch at :2295: same(p,n) returns first, so !n implies p); #79 `p.id !== n.id` (dead branch at :2298: the identity guard rejects a non-armed id change first); #80 `p.phase === armed` (dead branch at :2261: a capture needs an armed p). NOT removed: #62 (deleting it makes `p` in the armed-n guard a survivor: no witness has a present p arming a same-identity n).
// r3.4d SHADOW deletions (restoreJobProtocol, #62 `n.phase !== armed` of the identity guard): dead branch at :2307, an armed n with p present is already rejected by `p` in `if (p || prev.carry)`; that `p` is kept alive by witness cm-restoreJobProtocol-60-armed-job-rearmed-same-identity (a present job re-armed under the same identity).
export const restoreJobProtocol: StepInvariant = (prev, action, next) => {
  const I = "restoreJobProtocol", p = jobOf(prev), n = jobOf(next), at = next.step;
  if (action.t === "auto.captureOutgoing" && p?.phase !== "armed") return fail(I, `capture with no armed restore job (r3.4)`, at);
  if (action.t === "auto.swap" && (!p || p.archiveId !== action.archiveId || p.source !== action.source || !(p.phase === "captured" || (p.phase === "armed" && action.blind))))
    return fail(I, `swap of ${action.archiveId} does not belong to the open restore job (r3.4)`, at); // MUTANT job-swap-any-archive
  // r3.4d (page A1, M-3): the swap re-checks the job's archive is local; its id is its digest, so the same id is the same verified bytes.
  if (action.t === "auto.swap" && !(prev.fs.localArchives ?? []).includes(action.archiveId)) return fail(I, `swap of ${action.archiveId}: the job's archive is not local (r3.4d)`, at); // MUTANT swap-no-archive-recheck
  // r3.4c (M3): the download is before the arm. A fetch writes no job; a verified one adds its archive to fs.localArchives; a failed one
  // changes nothing and shows RESTORE_FAILED_LINE; no abort is a download failure.
  if ((action as { reason?: unknown }).reason === "download_failed") return fail(I, `download_failed abort inside the window: the download is before the arm (r3.4c)`, at); // cast guarded by ASSERT_DOWNLOAD_FAILED_REASON_ONLY_ABORT (end of file)
  if (action.t === "auto.archiveFetch") {
    if (!same(p, n)) return fail(I, `archive fetch wrote the restore job (r3.4c)`, at);
    const la = (w: World) => w.fs.localArchives ?? [];
    // r3.4d (page A1, M-3): while a job exists its archive is FROZEN: no fetch re-downloads (replaces) or drops it. MUTANT archive-not-frozen
    const jb = journalOf(prev);
    if (jb && (action.archiveId === jb.archiveId || (la(prev).includes(jb.archiveId) && !la(next).includes(jb.archiveId)))) return fail(I, `fetch of ${action.archiveId} replaces or drops job ${jb.id}'s archive ${jb.archiveId} (r3.4d)`, at);
    if (action.outcome === "verified" && !la(next).includes(action.archiveId)) return fail(I, `verified archive ${action.archiveId} not local (r3.4c)`, at);
    if (action.outcome === "download_failed") {
      if (windowDurable(prev) !== windowDurable(next)) return fail(I, `failed download changed state (r3.4c)`, at);
      // r3.4d (page A1, Low d): the line shows exactly when the fetch serves an owner restore request not yet answered by a restore.
      const shown = next.surface.some(r => r.section === "home" && r.visible && r.line === RESTORE_FAILED_LINE);
      const ownerAsked = !jb && prev.ghost.ownerRestoreRequests.some(r => r.archiveId === action.archiveId && !prev.ghost.restores.some(x => x.archiveId === r.archiveId && x.atStep >= r.atStep));
      if (ownerAsked && !shown) return fail(I, `failed download of an owner restore shows no restore-failed line (r3.4d)`, at);
      if (!ownerAsked && shown) return fail(I, `failed background prefetch shows the restore-failed line (r3.4d)`, at); // MUTANT fetch-line-always
    }
    return OK;
  }
  const admittedRestore = action.t === "owner.restore" && ownerOutcomeOf(action).ok;
  if (admittedRestore && (!n || n.phase !== "armed" || same(p, n))) return fail(I, `admitted owner.restore armed no restore job (r3.4)`, at);
  if (action.t === "auto.restoreArm" && (!n || n.phase !== "armed" || same(p, n))) return fail(I, `system restore armed no restore job (r3.4)`, at);
  // each named step writes its phase (no step that does the work leaves the job behind it)
  const commitsPrep = (action.t === "auto.restorePrepare" && action.outcome === "committed") || (action.t === "auto.bootPrep" && action.outcome === "ok");
  if (action.t === "auto.captureOutgoing" && n?.phase !== "captured") return fail(I, `capture did not write phase captured (r3.4)`, at);
  if (action.t === "auto.swap" && n?.phase !== "swapped") return fail(I, `swap did not write phase swapped (r3.4)`, at);
  if (commitsPrep && p?.phase === "swapped" && n?.phase !== "prepared") return fail(I, `the prep ending job ${p.id}'s window did not write phase prepared (r3.4)`, at); // MUTANT prep-skips-job-phase
  if (same(p, n)) {
    if (action.t === "auto.restoreAbort" || action.t === "auto.restoreJobClear") return fail(I, `${action.t} with nothing to do (r3.4)`, at);
    return OK;
  }
  if (p && n && (p.id !== n.id || p.archiveId !== n.archiveId || p.source !== n.source)) return fail(I, `restore job identity changed (r3.4)`, at);
  const jn = journalOf(next); // r3.4b (N2): `at` is the journal's; the database marks W27 / W28 do not rewrite it
  if (jn && !same(journalOf(prev), jn) && jn.at !== at) return fail(I, `restore journal phase ${jn.phase} written with at ${jn.at}, not this step (r3.4b)`, at);
  const commits = (action.t === "auto.restorePrepare" && action.outcome === "committed") || (action.t === "auto.bootPrep" && action.outcome === "ok");
  const ok = (() => {
    if (!n) return action.t === "auto.restoreJobClear" && (p?.phase === "prepared" || p?.phase === "aborted") && !next.carry;
    if (n.phase === "armed") {
      if (p || prev.carry) return false; // r3.4b (N1): nothing arms before the previous job is cleared and its carry gone
      if (!(prev.fs.localArchives ?? []).includes(n.archiveId)) return false; // r3.4c (M3): only a local, verified archive. MUTANT download-inside-window
      if (next.ghost.restores.some(r => r.jobId === n.id)) return false; // a new id
      return (admittedRestore && action.t === "owner.restore" && n.archiveId === action.archiveId && n.source === action.source) ||
        (action.t === "auto.restoreArm" && n.archiveId === action.archiveId && n.source === action.source);
    }
    if (!p) return false;
    if (n.phase === "captured") return action.t === "auto.captureOutgoing" && !!next.carry;
    if (n.phase === "swapped") return action.t === "auto.swap" && next.ghost.restores.slice(prev.ghost.restores.length).some(r => r.jobId === n.id);
    if (n.phase === "prepared") return p.phase === "swapped" && commits && next.ghost.preparedEpochs.includes(next.ghost.epoch);
    if (n.phase === "aborted") return (p.phase === "armed" || p.phase === "captured") && action.t === "auto.restoreAbort";
    return false;
  })();
  if (!ok) return fail(I, `restore job ${p?.phase ?? "none"} -> ${n?.phase ?? "none"} by ${action.t} is not a legal phase write (r3.4)`, at); // MUTANT job-phase-any-step
  if (action.t === "auto.restoreAbort") {
    // r3.4 (Fable F3): the abort changes nothing else, and says so on the home row. MUTANTS abort-not-pure, abort-no-line.
    const rest = (w: World) => windowDurable({ ...w, fs: { ...w.fs, restoreJob: null } });
    if (rest(prev) !== rest(next)) return fail(I, `restore abort changed state other than the job (r3.4)`, at);
    if (!next.surface.some(r => r.visible && r.section === "home" && r.line === RESTORE_FAILED_LINE)) return fail(I, `restore abort shows no restore-failed line (r3.4)`, at);
  }
  return OK;
};

/** (c, r3.4 redesign; Astra r3.3i #1) carryImmutable. The carry is SEALED from its capture until the prep consumes it (or the clear of an
 *  aborted job deletes it): no step changes any field of it, its marks included. Only a capture of a still-ARMED job may replace it (that
 *  carry's W26 was lost, R1). Creation is judged by keptKeysProtected and outgoingCapturedBeforeSwap, deletion by the latter. */
// PERMITTED ACTION: capture the carry once (again only while the job is still armed); delete it after its prep or the abort.
export const carryImmutable: StepInvariant = (prev, action, next) => {
  // r3.4b (Opus check N1): CARRY PROVENANCE. Only the ARMED job's own capture creates or replaces a carry, stamped with that job's id.
  // A crash just before W26 (the capture's own carry write W23 landed, its phase write did not) is that capture's step.
  const armedJob = jobOf(prev)?.phase === "armed" ? jobOf(prev) : null;
  const capturing = action.t === "auto.captureOutgoing" || (action.t === "fault.crash" && action.at === "W26_job_captured" && action.when === "before");
  if (next.carry && !same(prev.carry, next.carry)) {
    if (!capturing || !armedJob) {
      if (!prev.carry) return fail("carryImmutable", `carry ${next.carry.carryId} created by ${action.t}: only the armed job's capture creates a carry (r3.4b)`, next.step); // MUTANT carry-created-by-any-step
    } else if (next.carry.jobId !== armedJob.id) return fail("carryImmutable", `carry ${next.carry.carryId} stamped for job ${next.carry.jobId ?? "none"}, not the capturing job ${armedJob.id} (r3.4b)`, next.step);
  }
  if (!prev.carry || !next.carry) return OK;
  if (action.t === "auto.captureOutgoing" && jobOf(prev)?.phase === "armed") return OK;
  if (!same(prev.carry, next.carry)) return fail("carryImmutable", `carry ${prev.carry.carryId} changed by ${action.t} after its capture: it is sealed until consumed (r3.4)`, next.step); // MUTANT carry-mutable
  return OK;
};

/** (g, A4-M14) everyReplacementPreparedBeforeStore. Whenever the store is open after any database replacement (restore, reset, undo,
 *  including a staged marker lost to a crash), the prep of the current epoch has committed. */
export const everyReplacementPreparedBeforeStore: StateInvariant = w => {
  if (w.proc.phase !== "store_open" && w.proc.phase !== "running") return OK;
  if (w.ghost.restores.length && !w.ghost.preparedEpochs.includes(w.ghost.epoch)) return fail("everyReplacementPreparedBeforeStore", `store open in epoch ${w.ghost.epoch} without its prep`, w.step);
  return OK;
};

// ---------- (h) Liveness -----------------------------------------------------------------------------------------------------------------

/** (h) quiescenceReachable. A FAIR fault-free suffix (suffixIsFair) of at least `bound` steps after the last owner or fault step ends
 *  quiescent modulo legitimate waiting. If the last owner step was an ok Keep, Remove or Try again now, its target has no transient
 *  work left (open keep op, lease other than acked-while-closing, park in kp/ra/kr). A refused action is never progress (A4-H9,
 *  point 2): admissionPinned makes refusals transient. A suffix that is not fair proves nothing (OK).
 *  r3 (A5-H6): an admitted Keep ends with its history record SUCCEEDED or Flux-refused (refused / not_found answer to its RESTORE or
 *  GET); an admitted Remove ends with its inbox no longer active and its keys revoked or still in use, or a Flux refusal. A no-op
 *  "success" is therefore never quiescent. (A5-M9) Fairness is judged on the drained end; LIVELOCK: a prompt environment for
 *  CHECKER.fairRecoverySteps steps in which the home never once drained fails. (R2-Q4) quiescentModuloWaiting requires the discovery
 *  pass once the listing exists.
 *  r3.2 (A6-H1): EVERY admitted (ok, owner-principal) Keep, Remove, Try again now and bot delete in the trace is judged, not only the
 *  last one, so a later view cannot make an admitted Keep's obligation vanish. The only ends besides success / Flux refusal are
 *  owner-caused: an ok owner.deleteBot of the op's bot after its claim (deletedBotAuthorityDead kills the op), a later owner Keep claim on
 *  a Remove's target (Keep always wins), and a later restore (its prep drops keep ops and leases and re-parks, restorePrepParksEverything).
 *  The model has NO owner action that withdraws or cancels a Keep, so there is no such end. (A6-M5) an admitted bot delete ends with
 *  each delete authority's inbox no longer active and its keys revoked, in use or kept, or a Flux refusal. (A6-M4) LIVELOCK is judged on
 *  the part of the suffix AFTER its last drained step: one early drained tick no longer disables it. */
/*  r3.3 (A7-M3): LIVELOCK is judged on the part of the suffix after its last drained step AND after the last step at which any item was
 *  late (itemLate): a recovered delay no longer disables it. It fails when that prompt window lasts fairRecoverySteps steps or MORE
 *  than LIVELOCK_WINDOW_MS (exactly the window is still allowed). (A7-H1, ruling 1) the restore end is OWNER-only and ordered: an
 *  ok owner.restore REQUESTED AFTER the op's own step (ownerRestoredAfter); an automatic / system swap, or an owner restore requested
 *  before the op's claim, ends nothing. */
// r3.4d SHADOW deletions (quiescenceReachable): #22 `k in end.local.keptKeys` (dead branch at :2421: keptBy is undefined when k is not a kept key, so !!keptBy implies it); #36 `keepsOn(end, t).length`, #37 the leasesOn(...).some(...) operand with its #40 `l.phase === acked` and #41 `closing(l.inboxId)`, and #42 `p.state === keep_pending` and #43 `p.state === key_release` (dead branches at :2406: quiescentModuloWaiting returns first for any open keep op, any lease that is not acked under a closing inbox, and any park other than remove_authorized under an acked closing lease). #44 stays.
export function quiescenceReachable(trace: readonly TraceStep[], bound: number): Verdict {
  const I = "quiescenceReachable";
  let last = -1;
  trace.forEach((s, i) => { const o = originOf(s.action); if (o === "fault" || o === "owner") last = i; });
  const suffix = trace.slice(last + 1);
  if (suffix.length < bound) return OK;
  const end = trace[trace.length - 1].next;
  // r3.4c (Opus check M2b): JOB PROGRESS. On the owner-free, fault-free suffix no restore job stays unfinished (armed / captured /
  // swapped) for `bound` steps: it reaches prepared or aborted, whatever Flux or held input does. MUTANT job-progress-unchecked.
  // r3.4d (page L2): from arm until CLEARED the job takes at most `bound` of the home's own automatic steps; Flux and clock steps do not count.
  { let n = 0; for (const s of suffix) { const j = jobOf(s.next); if (!j) { n = 0; continue; } // MUTANT job-bound-stops-at-finished (M-2)
    if (originOf(s.action) === "automatic") n++; // MUTANT job-progress-counts-all-steps (M-1)
    if (n >= bound) return fail(I, `restore job ${j.id} still ${j.phase} (not cleared) after ${bound} automatic owner-free fault-free steps (r3.4d)`, s.next.step); } }
  if (!suffixIsFair(suffix)) {
    let lastDrained = -1;
    for (let i = 0; i < suffix.length; i++) if (drainedAt(suffix, i)) lastDrained = i;
    const tail = suffix.slice(lastDrained + 1); // A6-M4: judged on the suffix after the last drained step
    const late = itemLate(tail);
    const win = tail.slice(late.length ? late[late.length - 1] + 1 : 0); // A7-M3: and after the last late item
    if (win.length && (win.length >= CHECKER.fairRecoverySteps || win[win.length - 1].next.nowMs - win[0].prev.nowMs > LIVELOCK_WINDOW_MS))
      return fail(I, `livelock: environment prompt for ${win.length} steps since the home last drained and the last delay`, end.step);
    return OK;
  }
  const q = quiescentModuloWaiting(end);
  if (!q.ok) return fail(I, `not quiescent after ${suffix.length} fair steps: ${q.why}`, end.step);
  const closing = (i: InboxId | null) => i !== null && end.flux.inboxes[i]?.state === "closing";
  const fluxRefused = (pred: (r: RemoteRequest) => boolean) => end.flux.requests.some(r => pred(r) && (r.answerSeen?.result === "refused" || r.answerSeen?.result === "not_found"));
  const restoredAfter = (step: number) => ownerRestoredAfter(end, step); // r3.3 (A7-H1, ruling 1)
  const deletedAfter = (b: BotId | null, step: number) => b !== null && end.ghost.botDeletedAtStep[b] !== undefined && end.ghost.botDeletedAtStep[b] > step;
  const laterKeep = (t: TargetRef | null, step: number) => t !== null && end.ghost.keeps.some(k => k.target === t && k.claimedAtStep > step);
  /** A Remove-kind authority's work is done: inbox no longer active, keys revoked / in use / kept, or Flux refused it. */
  const removalDone = (au: AuthorityRecord): string | null => {
    if (fluxRefused(r => r.authorityId === au.authorityId)) return null;
    if (au.scope.inboxId !== null && end.flux.inboxes[au.scope.inboxId]?.state === "active") return `inbox ${au.scope.inboxId} active`;
    for (const k of au.scope.keyIds) {
      // r3.3h (Astra r3.3g #3): a kept entry counts as done only when its Keep is NEWER than this Remove (Keep wins); a Keep that predates
      // the Remove (an unconfirmed mark's old Keep included) leaves the revoke owed. MUTANT removal-done-counts-older-keep.
      const keptBy = authorityById(end, end.local.keptKeys[k] ?? null);
      const keptAfter = !!keptBy && keptBy.verifiedAtStep > au.verifiedAtStep;
      if (end.flux.keys[k]?.state === "live" && !keyInUse(end, k, null) && !keptAfter) return `key ${k} live and unused`;
    }
    return null;
  };
  for (const s0 of trace) { // A6-H1: every admitted owner op, not only the last
    const a = s0.action, at = s0.next.step;
    if (a.t !== "owner.keep" && a.t !== "owner.remove" && a.t !== "owner.tryAgainNow" && a.t !== "owner.deleteBot") continue;
    if (!a.outcome.ok || !OWNER_PRINCIPALS.has(a.principal) || restoredAfter(at)) continue;
    if (a.t !== "owner.deleteBot") {
      const t = a.target;
      if (parksOn(end, t).some(p => p.state === "remove_authorized" && !closing(inboxOfTarget(end, t))))
        return fail(I, `owner ${a.t} on ${t} (step ${at}) did not complete in ${suffix.length} fair steps`, end.step);
    }
    if (a.t === "owner.keep") {
      const recs = s0.next.ghost.keeps.slice(s0.prev.ghost.keeps.length).filter(k => k.target === a.target);
      if (!recs.length) return fail(I, `admitted Keep on ${a.target} left no Keep record (A5-H6)`, end.step);
      for (const rec of recs) {
        const now = end.ghost.keeps.find(k => k.keepOp === rec.keepOp);
        if (now && now.succeededAtStep !== null) continue;
        if (fluxRefused(r => r.keepOp === rec.keepOp) || deletedAfter(rec.botId, at)) continue; // owner-caused end: bot deleted after the claim
        return fail(I, `admitted Keep ${rec.keepOp} on ${a.target} (step ${at}) neither succeeded nor was refused by Flux (A6-H1)`, end.step);
      }
    }
    if (a.t === "owner.remove") {
      const as = newAuthorities(s0.prev, s0.next).filter(x => REMOVE_KINDS.has(x.kind) && x.scope.target === a.target);
      if (!as.length) return fail(I, `admitted Remove on ${a.target} left no Remove authority (A5-H6)`, end.step);
      for (const au of as) {
        if (laterKeep(au.scope.target, au.verifiedAtStep) || deletedAfter(au.botId, at)) continue;
        const why = removalDone(au);
        if (why) return fail(I, `admitted Remove on ${a.target} (step ${at}) left ${why} (A5-H6)`, end.step);
      }
    }
    if (a.t === "owner.deleteBot") {
      for (const au of newAuthorities(s0.prev, s0.next).filter(x => x.kind === "bot_delete_with_token")) {
        if (laterKeep(au.scope.target, au.verifiedAtStep)) continue;
        const why = removalDone(au);
        if (why) return fail(I, `admitted bot delete of ${au.botId} (step ${at}) left ${why} (A6-M5)`, end.step);
      }
    }
  }
  return OK;
}

// ---------- Check 2 -----------------------------------------------------------------------------------------------------------------------

/** Check 2 (A4-L15) opsLinesNeverNameAddress. Every new ops line names a binding id and generation and no address; blip and guard
 *  restore lines carry the window; every guard restore raises one. */
// PERMITTED ACTION: write an ops line with binding id, generation and window, and no address.
export const opsLinesNeverNameAddress: StepInvariant = (prev, action, next) => {
  const I = "opsLinesNeverNameAddress";
  const addrs = new Set<string>();
  for (const w of [prev, next]) {
    for (const b of values(w.local.bindings)) if (b.address) addrs.add(b.address.toLowerCase());
    for (const p of values(w.local.parks)) if (p.address) addrs.add(p.address.toLowerCase());
    for (const f of values(w.flux.inboxes)) addrs.add(f.address.toLowerCase());
  }
  const fresh = next.ops.slice(prev.ops.length);
  for (const l of fresh) {
    for (const a of addrs) if (a && l.text.toLowerCase().includes(a)) return fail(I, "ops line names an address", next.step);
    if (l.bindingId === null || l.gen === null) return fail(I, `ops ${l.kind} line lacks binding id or generation`, next.step);
    if ((l.kind === "blip" || l.kind === "guard_restore") && !l.window) return fail(I, `ops ${l.kind} line lacks the blip window`, next.step);
  }
  if (action.t === "net.send" && action.request.kind === "RESTORE_INBOX" && action.request.purpose === "guard" && !fresh.some(l => l.kind === "guard_restore" || l.kind === "blip"))
    return fail(I, "guard restore without an ops alert", next.step);
  return OK;
};

// ---------- Trusted boundary self-check -------------------------------------------------------------------------------------------------

/** environmentWellFormed (A4-M12, F4-M1, FLUX FACTS). The checker's recorder never erases a request (restore included) or rewrites one
 *  already sent; ghost history is append-only (Keep success and confirmation filled once); a binding's generation serial increases on
 *  any field change; a swap never touches Flux; purge only after FLUX_PURGE_MS of closing; a DELETE on an active inbox closes it with
 *  cause delete; a DELETE on a closing inbox changes nothing and emits no second closing event (one event per closing).
 *  r3: (A5-M11) a Keep's success step, time and confirmation are written together, once; (F5-L2) usedKeepOps, preparedEpochs and
 *  inventoryConfirmedEpochs are append-only, a prepared epoch is recorded only by a committed prep / ok boot prep, a confirmed epoch
 *  only by an ok owner.confirmInventory that created a valid confirm_inventory authority; lastParkOrRestoreStep never decreases; a
 *  deleted event only for a purged inbox; (A5-H8, R2-Q2) with the DELETE idempotency key honoured, a duplicate of an already executed
 *  DELETE changes nothing and emits nothing; without it, a duplicate acts as a fresh DELETE.
 */
// PERMITTED ACTION: the recorder appends history (r3.3: an owner restore request in its owner.restore step), applies a DELETE (closing an active inbox once, or a silent duplicate), purges after 30 d.
// r3.4d SHADOW deletions (environmentWellFormed): #8 `a.length <= b.length` (dead branch at :2510: a longer a reaches an undefined b[i], every eq is false, so the every() operand rejects first); #29 `action.outcome.ok` and #26 `action.t === owner.confirmInventory` (dead branches at :2525: a confirm_inventory authority passes authorityCreationVerdict only for an ok owner.confirmInventory). #31 `a.kind === confirm_inventory` is the clause that stays (it carries both).
export const environmentWellFormed: StepInvariant = (prev, action, next) => {
  const I = "environmentWellFormed";
  const fixed = (r: RemoteRequest) => JSON.stringify([r.requestId, r.copyOf, r.kind, r.purpose, r.target, r.credential, r.removalId, r.attemptId, r.authorityId, r.keepOp, r.sentAtStep, r.sentAtMs, r.sentInProcess, r.sentInEpoch]);
  for (const r of prev.flux.requests) { const n = next.flux.requests.find(x => x.requestId === r.requestId); if (!n || fixed(n) !== fixed(r)) return fail(I, `request ${r.requestId} erased or rewritten`, next.step); }
  for (const [id, outcome] of Object.entries(prev.flux.restoreOutcomes ?? {})) if (!same(outcome, next.flux.restoreOutcomes?.[id]))
    return fail(I, "committed RESTORE outcome erased or rewritten", next.step);
  // r3.4d-s23 (page S28): a copy names an existing request. MUTANT copy-names-no-request
  if (next.flux.requests.some(r => r.copyOf !== null && !next.flux.requests.some(x => x.requestId === r.copyOf))) return fail(I, "a copy names no existing request", next.step);
  // r3.4d-s23 (page S28): inbox ids and key ids are disjoint. MUTANT inbox-key-ids-overlap
  if (Object.keys(next.flux.inboxes).some(i => i in next.flux.keys)) return fail(I, "an inbox id is also a key id", next.step);
  const prefix = <T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) => a.every((x, i) => eq(x, b[i]));
  const succ = (k: KeepRecord) => ({ ...k, succeededAtStep: null, succeededAtMs: null, confirmedBy: null });
  const keepEq = (x: KeepRecord, y: KeepRecord) => same(succ(x), succ(y)) &&
    (x.succeededAtStep === null || (x.succeededAtStep === y.succeededAtStep && x.succeededAtMs === y.succeededAtMs && same(x.confirmedBy, y.confirmedBy)));
  if (!prefix(prev.ghost.authorities, next.ghost.authorities, same) || !prefix(prev.ghost.tokens, next.ghost.tokens, same) || !prefix(prev.ghost.restores, next.ghost.restores, same) || !prefix(prev.ghost.keeps, next.ghost.keeps, keepEq))
    return fail(I, "ghost history rewritten", next.step);
  if (next.ghost.keeps.some(k => (k.succeededAtStep === null) !== (k.succeededAtMs === null))) return fail(I, "Keep success step and time not written together (A5-M11)", next.step);
  const eqv = (x: unknown, y: unknown) => x === y;
  if (!prefix(prev.ghost.usedKeepOps, next.ghost.usedKeepOps, eqv) || !prefix(prev.ghost.preparedEpochs, next.ghost.preparedEpochs, eqv) ||
      !prefix(prev.ghost.inventoryConfirmedEpochs, next.ghost.inventoryConfirmedEpochs, eqv) || !prefix(prev.ghost.preparedResets, next.ghost.preparedResets, eqv))
    return fail(I, "recorder list rewritten (F5-L2)", next.step);
  const prepStep = (action.t === "auto.restorePrepare" && action.outcome === "committed") || (action.t === "auto.bootPrep" && action.outcome === "ok");
  if (next.ghost.preparedEpochs.slice(prev.ghost.preparedEpochs.length).some(e => !prepStep || e !== next.ghost.epoch)) return fail(I, "prepared epoch recorded outside a committed prep (F5-L2)", next.step);
  const newConfirms = next.ghost.inventoryConfirmedEpochs.slice(prev.ghost.inventoryConfirmedEpochs.length);
  if (newConfirms.length) {
    const valid = newAuthorities(prev, next).some(a => a.kind === "confirm_inventory" && authorityCreationVerdict(prev, action, next, a) === null);
    if (!valid || newConfirms.some(e => e !== prev.ghost.epoch)) return fail(I, "inventory confirmation recorded without a valid owner confirm (F5-L2)", next.step);
  }
  for (const b of Object.keys(prev.ghost.lastParkOrRestoreStep)) if ((next.ghost.lastParkOrRestoreStep[b] ?? -1) < prev.ghost.lastParkOrRestoreStep[b]) return fail(I, `lastParkOrRestoreStep of ${b} went back`, next.step);
  for (const e of next.flux.events.slice(prev.flux.events.length)) if (e.type === "email.inbox.deleted" && next.flux.inboxes[e.inboxId]?.state !== "purged") return fail(I, `deleted event for ${e.inboxId} that is not purged (F5-L2)`, next.step);
  if (next.ghost.epoch < prev.ghost.epoch) return fail(I, "epoch went back", next.step);
  // r3.3 (A7-H1): owner restore requests are append-only and written only by the owner.restore step itself; a restore record names an
  // owner request only on a swap of the same source and archive, after it, and no earlier record names the same request.
  if (!prefix(prev.ghost.ownerRestoreRequests, next.ghost.ownerRestoreRequests, same)) return fail(I, "owner restore requests rewritten", next.step);
  const newReqs = next.ghost.ownerRestoreRequests.slice(prev.ghost.ownerRestoreRequests.length);
  if (newReqs.length && (action.t !== "owner.restore" || !ownerOutcomeOf(action).ok || newReqs.length !== 1 || newReqs[0].atStep !== next.step || newReqs[0].source !== action.source || newReqs[0].archiveId !== action.archiveId))
    return fail(I, "owner restore request recorded outside its owner.restore step (A7-H1)", next.step);
  for (const r of next.ghost.restores.slice(prev.ghost.restores.length)) {
    if (r.atStep !== next.step) return fail(I, "a new restore record does not carry the current step (r3.4d-s23)", next.step); // MUTANT restore-record-stale-step
    if (r.ownerRequestStep === null) continue;
    const q = next.ghost.ownerRestoreRequests.find(x => x.atStep === r.ownerRequestStep);
    if (action.t !== "auto.swap" || !q || q.atStep >= next.step || q.source !== r.source || q.archiveId !== r.archiveId ||
        prev.ghost.restores.some(x => x.ownerRequestStep === r.ownerRequestStep))
      return fail(I, "restore record names no unused owner restore request (A7-H1)", next.step);
  }
  if (action.t !== "auto.swap" && action.t !== "auto.restorePrepare") for (const b of Object.keys(prev.local.bindings)) {
    const p = prev.local.bindings[b].gen, n = next.local.bindings[b]?.gen;
    if (n && (p.inboxId !== n.inboxId || p.opId !== n.opId || p.emailKeyRef !== n.emailKeyRef) && n.serial <= p.serial) return fail(I, `generation of ${b} changed without a new serial`, next.step);
  }
  if (action.t === "auto.swap" && !same(prev.flux, next.flux)) return fail(I, "a swap changed Flux", next.step);
  if (action.t === "flux.purge") { const fi = prev.flux.inboxes[action.inboxId]; if (!fi || fi.state !== "closing" || fi.closingSinceMs === null || next.nowMs - fi.closingSinceMs < FLUX_PURGE_MS) return fail(I, "purge before 30 days of closing", next.step); }
  if (action.t === "flux.apply") {
    const r = prev.flux.requests.find(x => x.requestId === action.requestId);
    // MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md.
    // An arbitrarily late transport copy may be delivered, but cannot execute the RESTORE again.
    if (r?.kind === "RESTORE_INBOX") {
      const id = r.copyOf ?? r.requestId, stored = prev.flux.restoreOutcomes?.[id];
      if (stored && (!same(prev.flux.inboxes, next.flux.inboxes) || !same(prev.flux.events, next.flux.events) || !same(stored, next.flux.restoreOutcomes?.[id])))
        return fail(I, "duplicate RESTORE executed again instead of replaying its stored outcome", next.step);
    }
    if (r && r.kind === "DELETE_INBOX") {
      const before = prev.flux.inboxes[r.target], after = next.flux.inboxes[r.target];
      const newClosingEvents = next.flux.events.slice(prev.flux.events.length).filter(e => e.type === "email.inbox.closing" && e.inboxId === r.target);
      const orig = r.copyOf ?? r.requestId;
      const executedBefore = prev.flux.requests.some(x => x.requestId !== r.requestId && (x.requestId === orig || x.copyOf === orig) && x.flux === "applied");
      if (prev.flux.semantics.deleteIdempotencyKeyHonoured && executedBefore) { // A5-H8: same idempotency key, no second execution
        if (!same(before, after) || newClosingEvents.length) return fail(I, "duplicate DELETE executed again although its idempotency key is honoured", next.step);
        return OK;
      }
      if (before?.state === "active" && (after?.state !== "closing" || after.closingCause?.kind !== "delete" || newClosingEvents.length > 1)) return fail(I, "DELETE on an active inbox did not close it once", next.step);
      if (before?.state === "closing" && (!same(before, after) || newClosingEvents.length)) return fail(I, "DELETE on a closing inbox changed it or emitted a second closing event", next.step);
    }
  }
  return OK;
};

// ===================================================================================================================================
// 6. Registries, checker depth, fault model
// ===================================================================================================================================

/** (page L3, r3.4d Low b) heldInputDrains. Input HELD by a restore window (an event not delivered to the home, an answer Flux
 *  delivered that the home did not take) is applied or taken within `bound` of the home's automatic steps after the window ends (the job
 *  leaves armed / captured / swapped). A fault or a new window before the bound judges nothing. */
// r3.4d SHADOW deletions (heldInputDrains): #3 `!x.deliveredToHome` and #6 `!r.answerSeen` in the held filters, #12 `r.answer === delivered` in the re-check (dead branches at :2591 and :2592: the re-check re-requires the event undelivered and the answer unseen, both flags only ever go one way, and a held answer stays delivered).
export function heldInputDrains(trace: readonly TraceStep[], bound: number): Verdict {
  const I = "heldInputDrains";
  for (let e = 0; e < trace.length; e++) {
    const s = trace[e];
    if (!(jobOpen(s.prev) && !jobOpen(s.next))) continue;
    const held = s.next.flux.events.filter(x => x.atStep <= s.prev.step).map(x => x.eventId);
    const heldAns = s.next.flux.requests.filter(r => r.answer === "delivered").map(r => r.requestId);
    let n = 0;
    for (let i = e + 1; i < trace.length; i++) {
      const t = trace[i], o = originOf(t.action);
      if (o === "fault" || jobOpen(t.next)) break;
      if (o === "automatic") n++;
      if (n < bound) continue;
      const ev = held.find(id => t.next.flux.events.some(x => x.eventId === id && !x.deliveredToHome));
      const an = heldAns.find(id => t.next.flux.requests.some(r => r.requestId === id && !r.answerSeen));
      if (ev || an) return fail(I, `held ${ev ? "event " + ev : "answer " + an} not applied within ${bound} automatic steps after the window ended (r3.4d)`, t.next.step); // MUTANT held-input-never-checked
      break;
    }
  }
  return OK;
}

export const STEP_INVARIANTS: Record<string, StepInvariant> = {
  keepSuccessIsConfirmed, guardArmedForEveryKeep, guardLivesUntilEveryDeleteResolved, guardDiesOnFreshRemove, guardActsOnlyOnGuardRecord,
  restoreUsesOwnerCredentialAndKeepPurpose,
  authorityCreatedByValidOwnerAction, ownerAuthorityForEveryDestructiveSend, removalSendNeedsSendingLease, noDestructiveSendAfterBlindRestore, keptKeysProtected, deletedBotAuthorityDead,
  nothingAutomaticUnparks, keptStaysKept, outgoingCapturedBeforeSwap, restorePrepParksEverything, restorePrepNeverThrows,
  viewMintsScopedTokens, keyOnlyActionsTouchNoInbox,
  noRemoveDuringKeep, keepNetworkNeedsClaim, keepOpsFreshAndCasChecked, admissionPinned,
  keyTargetEntriesNeverDropped, savedKeyNeverOutlivesRevokeWithoutWork,
  markerNeverArchivedAndConsumedAtBoot, restoreJobProtocol, carryImmutable,
  opsLinesNeverNameAddress, environmentWellFormed,
};
export const STATE_INVARIANTS: Record<string, StateInvariant> = {
  everyOrphanHasExecutableAction, blindRestoreIsOwnerVisible, keepAndRemoveSerialized, keyTargetsNeverLost, everyReplacementPreparedBeforeStore, restoreJobMatchesReality,
};
export const TRACE_INVARIANTS = { keepEndsActive, quiescenceReachable, heldInputDrains } as const;
/** r3.4d: every registered predicate's ONE line on INVARIANTS-PAGE-r34d.md. */
export const PAGE_MAP: Record<string, string> = {
  keepSuccessIsConfirmed: "S1",
  guardArmedForEveryKeep: "S2",
  guardLivesUntilEveryDeleteResolved: "S3",
  guardDiesOnFreshRemove: "S4",
  guardActsOnlyOnGuardRecord: "S5",
  restoreUsesOwnerCredentialAndKeepPurpose: "S6",
  authorityCreatedByValidOwnerAction: "S7",
  ownerAuthorityForEveryDestructiveSend: "S8",
  removalSendNeedsSendingLease: "S9",
  noDestructiveSendAfterBlindRestore: "S10",
  keptKeysProtected: "S11",
  deletedBotAuthorityDead: "S12",
  nothingAutomaticUnparks: "S13",
  keptStaysKept: "S14",
  viewMintsScopedTokens: "S15",
  keyOnlyActionsTouchNoInbox: "S16",
  noRemoveDuringKeep: "S17",
  keepNetworkNeedsClaim: "S18",
  keepOpsFreshAndCasChecked: "S19",
  admissionPinned: "S20",
  keyTargetEntriesNeverDropped: "S21",
  savedKeyNeverOutlivesRevokeWithoutWork: "S22",
  opsLinesNeverNameAddress: "S23",
  everyOrphanHasExecutableAction: "S24",
  blindRestoreIsOwnerVisible: "S25",
  keepAndRemoveSerialized: "S26",
  keyTargetsNeverLost: "S27",
  environmentWellFormed: "S28",
  keepEndsActive: "L1",
  quiescenceReachable: "L2",
  heldInputDrains: "L3",
  restoreJobProtocol: "A1",
  carryImmutable: "A2",
  outgoingCapturedBeforeSwap: "A3",
  restorePrepParksEverything: "C1",
  restorePrepNeverThrows: "C2",
  markerNeverArchivedAndConsumedAtBoot: "C3",
  everyReplacementPreparedBeforeStore: "C4",
  restoreJobMatchesReality: "C5",
};

export function checkStep(prev: World, action: Action, next: World): Verdict[] {
  const out: Verdict[] = [];
  for (const k of Object.keys(STEP_INVARIANTS)) { const v = STEP_INVARIANTS[k](prev, action, next); if (!v.ok) out.push(v); }
  for (const k of Object.keys(STATE_INVARIANTS)) { const v = STATE_INVARIANTS[k](next); if (!v.ok) out.push(v); }
  return out;
}
export function checkTrace(trace: readonly TraceStep[], settled: boolean): Verdict[] {
  const out: Verdict[] = [];
  for (const s of trace) out.push(...checkStep(s.prev, s.action, s.next));
  const a = keepEndsActive(trace, settled); if (!a.ok) out.push(a);
  const h = quiescenceReachable(trace, CHECKER.livenessBound); if (!h.ok) out.push(h);
  const d = heldInputDrains(trace, CHECKER.livenessBound); if (!d.ok) out.push(d);
  return out;
}
/** Evaluates ONE named invariant over a trace (used by the witness runner). */
export function verdictOf(name: string, trace: readonly TraceStep[], settled: boolean): Verdict {
  if (name === "keepEndsActive") return keepEndsActive(trace, settled);
  if (name === "quiescenceReachable") return quiescenceReachable(trace, CHECKER.livenessBound);
  if (name === "heldInputDrains") return heldInputDrains(trace, CHECKER.livenessBound);
  const st = STEP_INVARIANTS[name], sa = STATE_INVARIANTS[name];
  if (!st && !sa) return fail("verdictOf", `unknown invariant ${name}`, -1);
  for (const s of trace) { const v = st ? st(s.prev, s.action, s.next) : sa(s.next); if (!v.ok) return v; }
  return OK;
}

/**
 * Checker (A4-M13, F4-L5, point 4).
 *   0. WITNESSES FIRST (witnesses.ts): every must-reject trace must fail its invariant, every must-accept trace must pass it; any
 *      disagreement aborts the run. The longest witness (A5-M9 recovery-livelock) is 43 steps. r3: the `r2` set is also run against
 *      the r2 predicates (fail-before / pass-after), and one over-strict mutant per step invariant (forbidding its PERMITTED ACTION)
 *      must fail at least one must-accept.
 *   1. exhaustive BFS to depth 14 on the 1-address universe (1 bot, 1 inbox, keys k1 + rotated k2, 1 provisioning op), state hashing;
 *   2. exhaustive BFS to depth 8 on the 2-address universe (adds a second bot and a foreign inbox);
 *   3. from EVERY explored state, a deterministic fair recovery run (apply every held request, deliver every answer and event, tick)
 *      of up to 40 steps, checked by quiescenceReachable and keepEndsActive(settled = true);
 *   4. 20,000 seeded random walks of depth 80 (seed printed), clock jumps hitting 60 s, 24 h, 30 d and 31 d;
 *   5. initial states include pre-preparation shapes (1.0.18 R/Q with no lease, committed intent on active, provisioning with no
 *      inbox id, foreign lease, two generations of one bot);
 *   6. bounds per trace: 2 restores, 3 crashes, 3 copies of one request, 2 owner views; coverage gate over every W point, every
 *      witness id and every refusal code.
 */
export const CHECKER = {
  exhaustiveDepthOneAddress: 14, exhaustiveDepthTwoAddress: 8, fairRecoverySteps: 40, randomWalks: 20_000, randomWalkDepth: 80,
  maxRestoresPerTrace: 2, maxCrashesPerTrace: 3, maxCopiesInFlight: 3, maxOwnerViews: 2, livenessBound: 6, longestWitness: 44, promptSteps: PROMPT_STEPS,
} as const;

/**
 * Fault model: crash before and after every durable write W1-W24 (W2/W3 driven by the T20 shell harness); lost answers, duplicate
 * copies, delays of any length (incl. 31 d), reorders, delivery after restore/reset/undo; Flux per FLUX FACTS: soft delete, restore with
 * the owner key (409 not_closing, 410 restore_window_passed, 403 account_email_disabled), closing reasons owner | bot_deleted |
 * account_disabled | billing | support, ONE closing event per closing (a DELETE on a closing inbox is silent and repeats the window),
 * purge after 30 d, events delayed and redelivered; lost createInbox / mintKey answers; deleteIdempotencyKeyHonoured and listingShipped
 * both ways; concurrency: boot vs tick, inline route vs resumer, two owner devices on one target.
 */
export const FAULT_MODEL: readonly Action["t"][] = [
  "fault.crash", "fault.loseAnswer", "fault.duplicate", "fault.reorder", "fault.delayEvent", "flux.apply", "flux.emit", "flux.close", "flux.purge", "clock.advance",
];

// ---------------------------------------------------------------------------
// RULINGS 2026-11-10 20:31Z (MurageMain for Sean, BINDING; the author encodes these after the invariant review)
// Q1-Q5 YES as recommended; the Fable M1 Keep admission change (admit while the lease is unknown,
// refuse only while sending) is ACCEPTED.
// Q1: owner Reconnect carries a token over the FULL generation; (b) has no exemption for it.
// Q2: restore prep carries key targets and inbox ids forward from the outgoing live DB. When there is
//     NO outgoing live DB (new machine, disk loss), a Flux per-install key and inbox listing is
//     REQUIRED before any destructive action. If Flux has no such listing, (f) states: no DELETE and
//     no revoke after such a restore until the owner confirms. The listing is requested of FluxMain.
// Q3: the guard keys on the closing reason values FluxMain supplies (pending).
// Q4: the keep-guard record lasts until Flux's 30-day purge; event-only after 24 h, no polling.
// Q5: (a) is measured from the later of closing and boot, and the ops alert records the window
//     (binding + generation only). Invariant (a)'s comment must state the dependency: mail delivered
//     while closing is only made lossless by Flux F-BACKFILL (replay on restore). A home that is down
//     cannot restore promptly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RULING 2026-11-10 20:36Z (MurageMain for Sean, BINDING): Astra round 4 finding 6, guard lifetime
// The keep-guard has NO fixed expiry. It lives while any DELETE we sent in that generation is
// UNRESOLVED. A DELETE is resolved only by one of: (1) its delivered answer is seen; (2) an
// email.inbox.closing attributable to it; (3) an inbox purge.
// First 24 h after Keep: events + the 60 s GET backstop. After 24 h: events only, kept on a tiny
// durable row, with no polling.
// New predicate guardLivesUntilEveryDeleteResolved, with witnesses:
//   must-reject: a DELETE delivered at Keep+31d while the guard row is gone;
//   must-accept: a guard released only by one of the three resolutions.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider authentication, closing and listing contract (fixed for the fault model)
// POST restore authenticates with the OWNER key only (routes.py:311-313; service.py:902-903). bot_id
// is only a string match (403 inbox_account_mismatch), so a revoked bot key does NOT block restore.
// Restore refusals: 409 not_closing, 410 restore_window_passed (after closing_until),
// 403 account_email_disabled.
// email.inbox.closing reasons: owner | bot_deleted | account_disabled | billing | support
// (lifecycle.py:24). A DELETE carries only "owner" or "bot_deleted" (service.py:791-793). So a
// DELETE-caused closing is ALWAYS distinguishable, and the guard keys on {owner, bot_deleted}.
// LISTING (r3.4: FluxMain correction 2026-11-10 22:18Z folded): closing is a live state and is ALREADY in the default owner list;
// include=closing (F-BACKFILL, owner-only) is an explicit ask; there is no
// bot-key GET. Both are being built as part of F-BACKFILL: inboxes?include=closing, plus
// GET /api/desktop/bot-keys. Flux has NO install concept, so listings are PER ACCOUNT and can include
// other homes' keys and inboxes. An unknown live entry is never destroyed (same as keystore I11).
// Until the listing ships, the no-outgoing-DB restore takes NO DELETE or revoke until the owner confirms.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider DELETE contract: repeated deletion during one closing window is idempotent.
// A DELETE landing on an inbox ALREADY closing emits NO second email.inbox.closing; the duplicate is silent and its response
// repeats the first closing window (state, closing_until, reason). ONE closing event per inbox closing, not one per DELETE.
// Encoded: guardLivesUntilEveryDeleteResolved (a closing event resolves at most the single remaining attempt), environmentWellFormed.
// ---------------------------------------------------------------------------

// RULINGS 2026-11-10T21:30Z (date -u; MurageMain for Sean, BINDING, on r3; encoded as r3.1): R3-Q1 ACCEPT; R3-Q2 ACCEPT; R3-Q3 ACCEPT on condition (initialStateValid + generator replay, see authorityValidInTrace); R3-Q4 NOT deferred: an ok owner.deleteBot kills that bot's authorities, tokens and leases in the same step (deletedBotAuthorityDead, ghost.botDeletedAtStep).
// RULINGS 2026-11-10T21:44Z (date -u; MurageMain for Sean, BINDING, on r3.1; encoded as r3.2): every admitted owner op completes (success or a listed Flux refusal) except the owner-caused ends (bot delete after the claim; no Keep-cancel action exists); nothing automatic rolls keep_pending back to parked, absolute; an ok owner.deleteBot is pinned per bot; FA-M1..M3 folded with no r4.
// RULINGS 2026-11-10T21:57Z (date -u; MurageMain for Sean, BINDING, on r3.2; encoded as r3.3): a later restore ends an admitted Keep ONLY when OWNER-initiated and requested AFTER the Keep claim (automatic / system swap and stale owner restore end nothing; swap/prep no longer exempt from the keep_pending ban); A7-M2 prep keeps the older-Keep rule for uncarried keys; A7-M3 livelock window derived from the named assumptions, judged after the last delay; FA-L2 and FA-L7 folded.
// RULINGS 2026-11-10T22:04Z (date -u; MurageMain for Sean, BINDING, on r3.3; encoded as r3.3a): A8-M1 close BOTH steps: swap / prep may drop a kept-key entry ONLY if the carry covers it; no step re-keeps a key under an authority older than the newest it ever held (per-key high-water, ghost.keptHighWater; carried restores judged on the carry as before).
// RULINGS 2026-11-10T22:09Z (date -u; MurageMain for Sean, BINDING, on r3.3a; encoded as r3.3b): an UNTOKENED Keep whose target is not the bot's current live binding may be refused confirm_expired (pure, with a look-again line; retry on the current binding is admitted); tokened Keeps keep tokenProblem. Astra r3.3a Low folded: ghost.keptHighWater is never deleted or lowered, checked directly.
// RULINGS 2026-11-10T22:12Z (date -u; Astra r3.3b Low, no ruling needed; encoded as r3.3c): the stale-Keep look-again line must be on the bot's own row (section "bot").
// RULINGS 2026-11-10T23:21Z (date -u; reducer-builder gap, follows R3-Q4, no new ruling; encoded as r3.3d): tokenProblem counts a token of a bot deleted by an ok owner deleteBot at or after its issue step, so a Keep / Remove with that token may be refused confirm_expired.
// RULINGS 2026-11-10T23:26Z (date -u; Astra r3.3d Medium, no new ruling; encoded as r3.3e): tokenProblem resolves a token's bot through the shared tokenBot (a p token's park's bot), exactly as deletedBotAuthorityDead does, so a park token of a deleted bot may be refused confirm_expired.
// RULINGS 2026-11-11T00:02Z (date -u; Opus design ruling (b) on the reducer-builder case 'blind swap holds an older per-key Keep than ghost.keptHighWater'; encoded as r3.3f): the swap may hold the archive's older attribution ONLY in the swap window (store closed: boot_prep / down); the prep that ends it (restore prep, or boot prep after a crash) clamps every uncarried kept entry to at least the ghost high-water; drops and REVOKE_KEY are judged on the high-water, so no step acts on the stale entry. Not the same item as 'rebuild nolive swap-step prev inside the step chain' (that is trace continuity; this violation survives it).
// RULINGS 2026-11-11T00:18Z (date -u; Opus design pass on Astra r3.3f #1 High, encoded as r3.3g): later restores are SERIALIZED behind a pending replacement prep: no capture and no swap while prepPending (r3.3h supersedes: the later owner.restore is REFUSED, no queue), so no carry can capture a swap-window entry. Witness nolive-second-restore-inside-window; mutant window-allows-second-restore.
// RULINGS 2026-11-11T00:18Z (date -u; Opus design pass on Astra r3.3f #2 High, encoded as r3.3g): design (i) FAIL CLOSED, no new production store. The home cannot learn a lost Keep authority (Flux holds only the key's live / revoked state, not who kept it or when), and (ii) would add a CP/Flux ledger written before every Keep ack. So a window-ending prep marks every uncarried kept entry unconfirmed (LocalDb.unconfirmedKept, carried by later restores); a marked entry is never dropped or revoked except revoked-at-Flux or under an owner Remove after the mark, clears only with a new owner Keep, and each owner view shows LOOK_AGAIN_LINE. The checker accepts at/above the high-water OR marked. Witnesses nolive-prep-marks-unconfirmed-then-owner-decides, nolive-unconfirmed-*, unconfirmed-mark-lost-across-later-restore; mutants prep-skips-high-water-clamp, unconfirmed-mark-unguarded, unconfirmed-revoke-on-old-remove, unconfirmed-look-again-skipped.
// RULINGS 2026-11-11T00:18Z (date -u; Opus design pass on Astra r3.3f #3 Medium, encoded as r3.3g): window isolation while prepPending: no net.send of any kind; every owner decision (keep, remove, deleteBot, tryAgainNow, reconnect, confirmInventory) is refused with no state change, and confirm_expired is a legal refusal then (admissionPinned); the owner acts again once the store opens. Witnesses nolive-window-poll-send, nolive-window-owner-keep-admitted, nolive-window-owner-keep-refused-then-prep-marks, nolive-window-keep-refused-confirm-expired; mutants window-allows-send, window-admits-owner, window-refusal-not-legal.
// RULINGS 2026-11-11T00:18Z (date -u; Opus design pass on Astra r3.3f #4 Medium, encoded as r3.3g): the swap-window obligation is explicit: prepPending (a restore whose epoch has no committed prep); the clamp judges only the prep that ends it, so the accepted carried-prep-keeps-carried-kept-key stays accepted through a later crash, boot and boot prep. Witness carried-prep-then-crash-boot-prep-ok; mutant boot-clamp-unconditional.
// RULINGS 2026-11-11T00:18Z (date -u; Opus design pass on Astra r3.3f #5, encoded as r3.3g): a revoked key, or a key under a Remove verified after its high-water, may leave keptKeys at the window-ending prep and owes no clamp; clamping to the high-water never raises the authority, so a Remove after the high-water still revokes. Witnesses nolive-revoked-key-leaves-before-clamp, nolive-later-remove-leaves-before-clamp, nolive-revoked-key-clamped-not-raised, nolive-later-remove-clamped-not-raised-revoke; mutant clamp-checks-departed-keys.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #1 High, encoded as r3.3h): both preps that end the window (restore prep committed, boot prep ok while prepPending) consume the carry: carried kept keys at least at the carried Keep, carried marks with their carried value; the clamp judges both. Witnesses carried-mark-lost-across-boot-prep, carried-mark-kept-across-boot-prep; mutant carried-checks-restore-prep-only.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #2 High, encoded as r3.3h): a mark's value is the step that made it (window-ending prep stamps its own step or restores the carried value; a swap may bring an earlier archive mark), immutable while present; only an owner Keep or Remove verified after it, or Flux answering revoked, ends it; preservation compares the value through the carry and both preps. Witnesses nolive-unconfirmed-mark-rewritten-by-tick, nolive-unconfirmed-mark-future-dated; mutants unconfirmed-mark-value-mutable, unconfirmed-mark-stamp-unchecked.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #3 High, encoded as r3.3h): removalDone counts a kept entry only when its Keep is newer than the Remove; a Remove after an older Keep (a marked key included) is done only by revoking the key (or while in use). Witnesses fresh-remove-of-marked-key-not-revoked, fresh-remove-of-marked-key-revoked; mutant removal-done-counts-older-keep.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #4 Medium, encoded as r3.3h): the queue is DROPPED: while prepPending owner.restore is refused with no state change and nothing recorded (environmentWellFormed), showing RESTORE_FINISHING_LINE; no service obligation. Witnesses nolive-window-restore-admitted, nolive-window-capture-after-refused-restore, nolive-window-restore-refused-then-served; mutant window-admits-restore.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #5 Medium, encoded as r3.3h): one window-refusal rule: while prepPending every owner decision (keep, remove, deleteBot, tryAgainNow, reconnect, confirmInventory, restore) may be refused restore_finishing / confirm_expired (admissionPinned); R1 keys on the restore marker, not proc.phase, so an ordinary boot refuses nothing. Witnesses nolive-window-try-again-refused, nolive-window-remove-refused, nolive-window-restore-refused, ordinary-boot-refusal-not-window; combined-predicate gate; mutants window-refusal-not-legal, window-refusal-by-phase.
// RULINGS 2026-11-11T00:34Z (date -u; Opus design pass on Astra r3.3g #6 Medium, encoded as r3.3h): a window refusal leaves every durable field unchanged (all of LocalDb incl. savedKeys, carry, fs, proc, owner ledgers) and shows RESTORE_FINISHING_LINE (home row, or the bot's row where LOOK_AGAIN_LINE also fits); every owner view while prepPending shows it, so it shows again after a crash; no replay obligation. Witnesses nolive-window-keep-refused-clears-savedkeys, nolive-window-refusal-without-line, nolive-window-refusal-crash-view-without-line, nolive-window-refusal-crash-view-shows-line; mutants window-purity-omits-savedkeys, window-refusal-no-line, window-view-skips-line.
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item A Partial #2, encoded as r3.3i): the prep that ends the window RE-STAMPS every mark: a carried key gets the carried mark value, every other kept entry it marks gets the prep's own step; mark immutability applies at every step EXCEPT that prep; a fresh Keep / Remove ends a mark only when verified strictly after the mark's step. Witnesses nolive-stale-swap-mark-cleared-by-tick, nolive-swap-mark-restamped-by-prep, nolive-unconfirmed-mark-born-on-tick; mutants prep-keeps-swap-mark, unconfirmed-mark-stamp-unchecked (re-aimed).
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item B High, encoded as r3.3i): the archive-mark versus carry-mark wedge is resolved by A: the carried value wins at the window-ending prep. Witness carried-mark-differs-from-archive-mark-prep-commits-carried; mutant window-end-mark-immutable.
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item C High, encoded as r3.3i): a Remove ends a mark ONLY together with the key leaving keptKeys (a revoke or a completed removal); a Remove still owed keeps the mark; capture copies the mark of a key whose Remove is owed; a carried mark is ended at the prep only by a fresh Keep. Witnesses marked-key-remove-owed-mark-cleared-by-tick, owed-remove-mark-dropped-at-capture, owed-remove-mark-captured; mutants remove-clears-mark-kept-key, capture-drops-owed-remove-mark.
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item D Medium/High, encoded as r3.3i): durable HomeFs.restorePending (beside the install, outside the restored tree) is written BEFORE the capture or swap of an owner restore and cleared only in the step that commits the window-ending prep; state invariant restorePendingTracksPrep (prepPending implies set; set implies prepPending or an armed owner restore) at every state and crash point; R1 keys on it; reset / undo markers no longer imply refusals; nolive witnesses set it through the window. Witnesses nolive-restore-pending-missing-in-window, restore-pending-left-after-prep, nolive-restore-pending-lost-across-crash, nolive-restore-pending-through-crash-boot-prep; mutants restore-pending-unchecked, restore-pending-stale-allowed.
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item E Low, encoded as r3.3i): windowDurable also covers the archives, the ops log and ghost.keptHighWater. Witnesses nolive-window-refusal-writes-ops-line, nolive-window-refusal-writes-archive, nolive-window-refusal-moves-high-water; mutant window-purity-omits-ops-archives-highwater.
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item F Low, encoded as r3.3i): the combined-predicate gate claimed in the r3.3h RULINGS did not exist (it ran 6 witnesses x 3 predicates). spec-r3.test.ts now runs EVERY registered predicate over EVERY must-accept witness and requires 0 failures; the accept witnesses it exposed were made realistic (listed in the witnesses header).
// RULINGS 2026-11-11T00:49Z (date -u; Opus design pass on the independent Opus design check of r3.3h item G copy, Sol copy check, encoded as r3.3i): RECONFIRM_KEPT_LINE "Choose Keep or Remove again for this bot's email." shows on a "bot" section row on every owner view while a key is marked; LOOK_AGAIN_LINE stays ONLY for the binding-changed Keep refusal and no longer explains a window refusal; RESTORE_FINISHING_LINE passed and stays. Witnesses nolive-unconfirmed-view-look-again-wording, nolive-window-refusal-look-again-only; mutants reconfirm-line-uses-look-again, window-line-accepts-look-again.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #1 High, encoded as r3.4): the carry is SEALED from capture until the prep consumes it (or the clear of an aborted job deletes it): new step invariant carryImmutable rejects any change to any carry field, marks included; only a capture of a still-armed job (its W26 lost) may replace it, so a tick can no longer rewrite carry.unconfirmedKept and launder a mark. Witnesses carry-mark-rewritten-after-swap (reject), carry-recaptured-while-armed (accept); mutant carry-mutable.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #2 High, encoded as r3.4): the sealed carried Keep is the authority at BOTH consuming preps: restoreStep now includes the window-ending boot prep, and a carried key set to exactly its carried value passes the attribution check below the high-water; a carried key the archive lacks is re-created from the carry with its carried mark. Witnesses carried-key-missing-from-archive-rebuilt-at-boot-prep (accept), carried-key-missing-from-archive-left-absent (reject); mutant bootprep-carry-not-authority.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #3 High, encoded as r3.4): the boolean flag is replaced by the durable job LocalDb.restoreJob carrying id, archive, source and phase; a crash before capture leaves phase armed with the archive named, so boot recovery resumes (capture, swap) or aborts from ReducerView alone; quiescentModuloWaiting is not quiescent while any job exists, so a job stuck in a phase fails liveness; restoreJobMatchesReality replaces restorePendingTracksPrep and ties each phase to the archive, carry and prep. Witnesses job-armed-lost-across-boot (reject), job-stuck-armed-never-finishes (reject), job-armed-aborted-cleared-quiescent (accept); crash witnesses job-crash-w25-armed-resumes, job-crash-w26-captured-resumes, job-crash-w27-staged-swap-resumes, job-crash-w28-after-boot-clears, job-crash-w29-aborted-clears, job-crash-w30-cleared; mutants quiescence-ignores-job, job-reality-unchecked, job-phase-any-step.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #4 Medium, encoded as r3.4): ONE window from phase armed to prepared or aborted; confirm_expired is no longer a legal window refusal (WINDOW_REFUSAL_CODES = restore_finishing only, admissionPinned also rejects an admitted decision in the window); the purity and line checks run on the whole window, armed span included; an admitted second restore cannot arm over an open job (restoreJobProtocol) and is refused restore_finishing (keptKeysProtected). Witnesses armed-keep-refused-confirm-expired-impure (reject), armed-keep-refused-restore-finishing (accept), armed-second-restore-admitted (reject), armed-view-without-line (reject), armed-view-shows-line (accept); VERDICT CHANGED: nolive-window-keep-refused-confirm-expired accept -> reject (it left the r3.3f comparison set); mutants window-accepts-confirm-expired, job-arm-over-open.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #5 Medium, encoded as r3.4): the three departed-key witnesses are back on their ORIGINAL actions. Conflict resolved in restorePrepParksEverything: an archived kept key that has DEPARTED may leave with its entry at the prep: revoked at Flux (nothing left to protect or clean), or, while the blind restore's discovery is pending, under an owner Remove verified after its high-water (keptKeysProtected licenses the drop; the discovery pass re-finds a live key; the Remove's revoke stays owed); a carried key never departs there. The third witness (nolive-later-remove-clamped-not-raised-revoke) ENDS IN A REAL REVOKE_KEY SEND again (r3.4a, T=2026-11-11T01:34Z): its original revoke was barred by ownerAuthorityForEveryDestructiveSend (the Remove was verified in epoch 0, before the restore; a Remove authority dies at a later restore epoch) and by the blind fence, so it is rebuilt AFTER the restore with no predicate change: the prep clamps k9 to aKn (never raised), then an owner view (key-only row, restore-check row), a fresh epoch-1 owner Remove of k9 verified after the restore and the clamp, the owner confirms the inventory (lifts the blind fence), the lease claims sending naming that Remove, the revoke leaves under it, Flux applies, the answer lands, and the work retires with the entry gone; k9 is revoked only under that fresh post-restore Remove. Witnesses prep-departed-revoked-key-not-lost, prep-departed-removed-key-not-lost (accept), prep-live-unremoved-key-lost (reject); mutant prep-departed-key-must-stay.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Astra r3.3i #6 Medium, encoded as r3.4): windowDurable covers the whole world except the recorder history, clock and surface: bots and all of Flux added. Witness window-refusal-deletes-bot (reject); mutant window-purity-omits-bots.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F1 High, encoded as r3.4): no file-versus-transaction gap remains: phase prepared is a row of the prep's own transaction (W28 inside W4), and the job is cleared only after the carry delete (W24, then W30); a crash between them leaves a FINISHED job (prepared) that refuses nothing and is cleared at boot. Witnesses job-crash-w28-after-boot-clears (accept), job-prepared-left-swapped (reject).
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F2 Medium, encoded as r3.4): closed with Astra #4: on the armed span a confirm_expired refusal is rejected by admissionPinned, and every refusal there is held to the purity and line checks; views in phase armed show the line.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F3 Medium, encoded as r3.4): auto.restoreAbort (download failed, archive unreadable, owner cancel) from armed or captured writes phase aborted (W29) and nothing else, with RESTORE_FAILED_LINE on the home row (no dashes, no safe / free / will fail); auto.restoreJobClear then deletes the aborted job's carry (outgoingCapturedBeforeSwap exempts it) and clears the job (W30). Witnesses abort-after-capture-clears (accept), abort-not-pure (reject), abort-without-failed-line (reject), abort-after-swap (reject); mutants abort-not-pure, abort-no-line.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F4 Low, encoded as r3.4): R1 now says every restore, owner, system or blind, runs as the job; a system restore arms by auto.restoreArm; the blind swap goes armed to swapped with no capture. Witness system-restore-armed-swapped-prepared (accept).
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F5 Low, encoded as r3.4): R3 text aligned with the drop rule: the entry may leave keptKeys under an owner Remove verified after the mark before the revoke is answered; the revoke stays owed (removalDone). No predicate change.
// RULINGS 2026-11-11T01:19Z (date -u; Opus redesign pass on Fable r3.3i F6 Low copy, encoded as r3.4): a Remove that ends skipped_in_use keeps the entry and the mark, and the row keeps RECONFIRM_KEPT_LINE until a Keep; accepted as fail-closed copy. Witness marked-key-remove-skipped-in-use-keeps-reconfirm-line (accept).
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, N1 High, encoded as r3.4b): carry provenance: CarryRecord.jobId; carryImmutable lets only the ARMED job's capture (or a crash just before its W26) create or replace a carry, stamped with that job's id; consumesCarry needs carryOfJob (carry.jobId === job id); outgoingCapturedBeforeSwap refuses a blind swap with any carry; restoreJobProtocol arms only with no journal and no carry; restoreJobMatchesReality rejects a carry of another job and a blind swapped job holding a carry. Witnesses tick-creates-carry, stale-aborted-carry-armed-over, stale-carry-under-new-job, stale-aborted-carry-blind-swap, stale-aborted-carry-launders-at-prep (reject), capture-then-prep-own-carry (accept); mutants carry-created-by-any-step, job-arm-over-finished, blind-swap-with-carry, carry-job-unchecked, prep-consumes-foreign-carry.
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, N2 Medium, encoded as r3.4b): the job lives in the sidecar journal HomeFs.restoreJob (JOURNAL_NAME restore-job.json, atomic replace, every restore, blind included); swapped and prepared are database marks LocalDb.swappedJobId (W27, staged DB, lands with W3) and preparedJobId (W28, a row of W4); jobOf derives the effective phase; boot reconciles journal plus database. ReducerView exposes it through fs. This is Fable r3.3i F1 (an id-carrying flag, the prepared id in the tx, boot unlinks the stale one). Witnesses blind-journal-crash-between-w4-and-unlink-reconciles, blind-journal-crash-after-w27-resumes (accept; the r3.4 crash witnesses job-crash-w25..w30 now run on journal plus database), journal-written-prepared-outside-w4 (reject); mutant journal-holds-db-phase.
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, N3 Medium, encoded as r3.4b): consumesCarry requires windowEnds (prepPending and a committed prep) and carryOfJob; keptKeysProtected rejects an entry a non-consuming prep re-creates under a Keep that a later owner Remove naming the key ended. Witnesses stray-prep-after-remove-restores-key (reject), window-ending-prep-takes-own-carry-then-clear (accept); mutants stray-prep-consumes-carry, rekeep-under-removed-keep.
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, N4 Low, encoded as r3.4b): HELD INPUT chosen over 'apply events to the carry and tolerate them at the swap': holding is simpler and sound because Flux already keeps an unacked event and an open request is still answerable, so no new queue and no change to the sealed carry or carryCovers are needed; queueing into the outgoing database would be lost at the swap. keptKeysProtected rejects auto.applyEvent and net.answer while the window is open; R1 says so; the purity snapshot already covers flux and local. Witnesses window-event-applied-mid-job (reject), window-event-held-applied-after-prepared (accept); mutant window-takes-input.
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, N5 Low, encoded as r3.4b): the stale confirm_expired text in admissionPinned and keptKeysProtected is gone; owner.backup (outcome optional) is a window decision: refused restore_finishing, pure, with the line. Witnesses window-backup-admitted (reject), window-backup-refused-with-line (accept); mutant window-admits-backup.
// RULINGS 2026-11-11T01:56Z (date -u; Opus design pass on the Opus design check of r3.4, R2 note, encoded as r3.4b): the reducer cannot see ghost.keptHighWater, so keeping a kept (marked) entry is always legal for it; the Remove-after-high-water departure is the checker's allowance only. No predicate change.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b M1, encoded as r3.4c): restorePrepParksEverything judges the carry duties only while prepPending and carry.jobId names the job; any other committed restore prep is a plain prep and may leave a removed key out. Witnesses stray-prep-after-remove-leaves-key-out (accept), stray-prep-reapplies-carry-after-remove (reject); mutant stray-prep-owes-carry.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b M2, encoded as r3.4c): (a) an item held by an open restore window is not late (itemLate), so the livelock clause still sees it; (b) JOB PROGRESS in quiescenceReachable: on the owner-free, fault-free suffix an unfinished job reaches prepared or aborted within livenessBound steps, and held items then drain. Witnesses job-armed-forever-held-event (r3.4b accepts it), sys-armed-held-event-livelock, job-armed-forever-flux-held-request, job-held-event-prepared-then-drained; mutants held-counts-late, job-progress-unchecked.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b M3, encoded as r3.4c): the archive is downloaded and verified BEFORE the arm (auto.archiveFetch, HomeFs.localArchives); a job arms only a local verified archive; download_failed is a pre-arm refusal (no job, nothing changed, RESTORE_FAILED_LINE), never an in-window abort; the window stays short and the 120 s keepEndsActive bound is unchanged. Witnesses arm-before-archive-local, abort-download-failed-in-window, download-failed-pre-arm-refusal, slow-download-before-arm-keep-blip-restored; mutant download-inside-window.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b L1, encoded as r3.4c): the stale confirm_expired text in the keptKeysProtected PERMITTED ACTION header is replaced by restore_finishing while the window is open.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b L2, encoded as r3.4c): R1: the abort first deletes any staged incoming database (it may hold swappedJobId from W27), then writes W29. Witness abort-discards-staged-marked-db.
// RULINGS 2026-11-11T02:14Z (date -u; Opus design check of r3.4b L3, encoded as r3.4c): owner.restore ("Try again") while the job is prepared or aborted and not yet cleared is refused restore_finishing, pure, with RESTORE_FINISHING_LINE. Witnesses try-again-before-clear-refused-finishing (accept), try-again-before-clear-other-code (reject); mutant finished-job-restore-any-code.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-M1, encoded as r3.4d): page L2: the job bound counts only the home's automatic steps; Flux and clock steps do not count. Witnesses owner-restore-many-env-steps-accepted, system-restore-many-env-steps-accepted; mutant job-progress-counts-all-steps.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-M2, encoded as r3.4d): page L2: the bound runs until the job is CLEARED; a prepared or aborted job left uncleared fails. Witness job-prepared-or-aborted-never-cleared-event-pending; mutant job-bound-stops-at-finished.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-M3, encoded as r3.4d): page A1: archiveId IS the verified content digest (A-ARCHIVE-DIGEST); while a job exists no archiveFetch drops or replaces its archive; the swap re-checks the archive is local. Witnesses fetch-replaces-job-archive-mid-job, swap-archive-missing; mutants archive-not-frozen, swap-no-archive-recheck.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-M4, encoded as r3.4d): page C1: the boot prep after a crash that ends the window and consumes its own job's carry owes the window-ending prep's duties. No other r3.4c predicate caught it (comparison log). Witnesses boot-prep-leaves-carried-removal-unparked, boot-prep-drops-carried-guard, boot-prep-parks-carried-removal; mutant boot-prep-exempt.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-L1, encoded as r3.4d): the 120 s livelock clause is the named assumption A-RESTORE-WINDOW (RESTORE_ASSUMPTIONS, header ASSUMPTIONS).
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-L2, encoded as r3.4d): page L3 heldInputDrains: held input is applied or taken within livenessBound automatic steps after the window ends. Witnesses held-event-dropped-after-window, held-event-applied-after-window; mutant held-input-never-checked.
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-L3, encoded as r3.4d): L2 cannot be tested in the model: header CODE-LANE CHECKS T20 shell-harness (crash after W27, abort, assert no staged incoming DB file remains).
// RULINGS 2026-11-11T02:34Z (date -u; MurageMain on the Opus design check of r3.4c N-L4, encoded as r3.4d): page A1: RESTORE_FAILED_LINE only when the failed fetch serves an owner restore request; a background prefetch shows no line. Witnesses background-prefetch-fails-no-line, background-prefetch-fails-shows-line, owner-fetch-fails-no-line; mutant fetch-line-always. No new user-facing strings.

// Type-level guards for the `(action as { outcome?: unknown })` / `{ reason?: unknown }` casts above: a future Action with a string outcome "ok"/"threw" or a
// `reason` "download_failed" makes one of these constants fail tsc instead of silently widening a cast.
type ActionTWith<A, K extends "outcome" | "reason", V> = A extends { t: infer T } ? (K extends keyof A ? (V extends Extract<A[K & keyof A], string> ? T : never) : never) : never;
type SameUnion<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : never) : never;
export const ASSERT_OK_OUTCOME_ONLY_BOOT_PREP: SameUnion<ActionTWith<Action, "outcome", "ok">, "auto.bootPrep"> = true;
export const ASSERT_THREW_OUTCOME_ONLY_PREPS: SameUnion<ActionTWith<Action, "outcome", "threw">, "auto.bootPrep" | "auto.restorePrepare"> = true;
export const ASSERT_DOWNLOAD_FAILED_REASON_ONLY_ABORT: SameUnion<ActionTWith<Action, "reason", "download_failed">, "auto.restoreAbort"> = true;
