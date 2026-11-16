# Restore park, Batch D review: <INT_SHA>

Reviewer: Opus (final review for the phase).

You review the integration line of the Murage restore park redesign (r3.1) at commit `<INT_SHA>` (branch feat/1019-restore-park-int). The base is fad83e823. Read ONLY by sha, never check anything out
(the working copy is a prod deploy worktree):

    git -C /fixture-home/murage-cloud-work/wt-ch1g-deploy show <INT_SHA>:<path>
    git -C /fixture-home/murage-cloud-work/wt-ch1g-deploy diff fad83e823 <INT_SHA> -- <path>

Use /usr/bin/git, not a wrapped git (the rtk hook truncates plain git diff). Do not build, test or run anything on this Mac. Do not touch prod, staging, mcq-* servers or any *-deploy worktree. No Co-Authored-By.
If the sha is not in that repo yet, say so and stop; do not guess.

## Spec and contracts (read first)
- `~/murage-cloud-work/review-asks/restore-park-r31-design/RESTORE-PARK-REDESIGN-r3.1.md` (sections 3 to 10, 12; N1 to N3 copy)
- `~/murage-cloud-work/review-asks/restore-park-r31-design/OWNER-VIEW-WIRE-CONTRACT.md` (rounds 1 to 5)
- Handoffs: HANDOFF-park-A3.md, HANDOFF-park-B.md (bottom: MurageMain rulings), HANDOFF-park-B3b.md, same dir.
- Proof evidence for this sha: the Batch D proof output (RUN-PROOF.md and the proof log named in the ask). Treat it as a claim to check, not as truth.

## Files in scope (diff fad83e823..<INT_SHA>)
server/email/{owner-routes,owner-view,park-port,removal-gate,removal-transport,binding-service,runtime,restore,email-store}.ts, server/index.ts (DELETE /api/bots/:id handler only), server/store.ts (deleteBot),
shared/email-copy.ts, shared/locales/* (emailPark.* keys), src/state/store.tsx (emailConfirm), src/components/BotEmailSettings.tsx and the email Keep/Remove client, server/testing/email-crash-child.ts, the new tests.

## You MUST cover each of these, by name, with a finding or an explicit "checked, clean" and the file:line that shows it
1. PHONE other-setups remove route (MurageMain merge condition, binding). `POST /api/email/other-setups/:inboxId/remove` on surface "phone": fresh device proof is asked on thread `email-owner` with
   requestId `email-owner-other_setup_remove-<id>` and the exact card (tool `bot_email`, title `Bot email: other setup remove`, subtitle bound to the string body fields); a refused proof sends no DELETE;
   the token is scoped to this inbox and expires; a tokenless, garbage, expired or other-row token sends no DELETE; the route cannot remove an inbox that is a bot binding or a park (A excludes park inbox ids);
   the id pattern is the router's `[\w-]{1,160}`; desktop behaviour unchanged. Try to find a way to delete a live or parked inbox through it.
2. Parked Keep/Remove authority by park_rev. Keep and Remove on a parked row bind to park_id AND park_rev: a stale rev (park moved while the phone proof was pending, a Keep attempt, an address fill) answers
   `confirm_expired` with the look-again line and touches nothing at Flux; the gate re-checks park_rev at act time; BindingService.remove(botId, parkRev) and the park port pass it; a token minted for one
   act (keep, remove, delete, confirm_inventory) never authorizes another. Look for a path that still calls remove with no parkRev.
3. DELETE /api/bots/:id emailConfirm path. Without `emailConfirm` the handler's behaviour is byte-identical to base (the only changed line is the `store.deleteBot` call); a bot or engine credential and
   `ifArchived=1` never read a body; with a valid confirmation exactly one inbox DELETE and one key revoke; wrong, expired, other-row, other-process, moved-rev, remote-deleted and keep_pending tokens send none;
   a delete that never commits (saveBots throws) never reaches the gate (T14); the 4 KiB body read cannot hang or throw past the route's catch.
4. restore_check and confirm_inventory. The restore_check row is emitted only when the restore job says so; confirm_inventory is tokened, phone-proofed on `email-owner` id `restore`, returns the full home view,
   and is NOT still the `restore_not_ready` stub at this sha (if it is, that is a FAIL/DISAGREE item: say whether the job batch is wired in index.ts).
5. Try-again path. `POST /api/email/bots/:botId/try-again`: only on a removing/remove_requested binding (else inbox_gone), phone proof on the bot's own threadId, runs the resumer once, never sends a second
   inbox DELETE, returns the full home view; a bot row with no removal gets no try_again_now action.
6. Copy: only the approved strings. Diff every user-visible string in shared/email-copy.ts and the client. Approved: N1 `ownerRouteLine("confirm_expired")` ("This confirmation is out of date. Open it again to see the current address."),
   N2 `removal_sending` ("Remove is still finishing. Try Keep address again in a moment."), N3, deleteAlsoRemoves, and the MurageMain-approved 11-11 set: parkedTitle, parkedOrphanLine, keepingLine, goneLine, inbox_gone,
   keep_pending, restoreCheckLine, confirmInventoryButton, tryAgainNowButton. Any other new or changed English string is a finding. Plain words, no jargon, nothing a grandma would not follow.
7. Translations cross-check. The copy reviewer was the SAME model that wrote the translations (records 2026-11-11-1019-park-b-l10n-feda55e1111e, the b3b record 2026-11-11-1019-park-b3b-l10n-5ca42da1f829 and
   the same-as-english.json record). You are the independent check: for the 9 emailPark.* keys in en.json and the 7 packs, verify meaning matches English, `${address}` and other placeholders survive, no
   English left where it should be translated (and the same-as-english list is justified), no string that promises more than the English does (for example "deleted" for "removed"). Report per locale.
8. No regression to desktop restore. A desktop restore with no parks behaves as at base: `prepareRestoredEmail` on a backup with no in-flight removals changes nothing; desktop `confirm:true` Keep/Remove on a bot
   row still works with no token; legacy otherSetups[] is still emitted for old clients; status rows do not appear for bots with no email; `EmailRuntime` start with the TEMP trigger and INSERT fence leaves a
   non-restore boot unchanged; the 5 branch-only files fixed in B (email-api, email-index, event-handoff-shared.api, shared-routine-unattended-api, shared-worker-chain-f3) still pass.

Also report anything else that could send an inbox DELETE the owner did not authorize, auto-unpark a parked row, or leak the owner token, the per-process HMAC key or a bot key into a row, log or refusal body.

## Output (15 to 30 lines, plain prose, no emojis, no em or en dashes)
For each of the 8 items: one line, CLEAN or FINDING plus file:line and a one-sentence repro. Then a list of findings with severity (blocker, must-fix before the server sha goes to MurageMobile, follow-up).
End with exactly one verdict line as the LAST line:

    VERDICT: PASS   or   VERDICT: FAIL   (FAIL if any blocker or must-fix remains; one reason after it)
