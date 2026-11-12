# Changed expectations

Binding sources: MAIN hlint1 rulings in the user instruction; `/work/fuigo-builds/swarm-b/hls0/F0.2.4-FROZEN.txt`; `/work/fuigo-builds/swarm-b/hls0/RULING-hlf-r2-MAIN.md`.

No expectation is relaxed. Journal fixture property names adopt `approvalJournal`/`callJournal` under MAIN (3). Fixtures supplying a plain approval journal now supply the frozen RPC journal subclass, required by the single integrated host. Existing assertions are retained unless enumerated below.

- MAIN (1): a provider's negative recovery confirmation is unconfirmed, rather than applied or authoritative absence. Recovery tests expecting `not_applied` solely from a negative provider flag must expect `outcome_unknown`. Proven absence remains `not_applied`.
- MAIN (4), frozen identity policy: follower removal recovery cannot confirm an empty current set against an approval naming `u1`. It remains `outcome_unknown`; no provider current set can replace the approved set. Add recovery with the exact approved set remains applied; `u_old/u_new` union is rejected.

Exact test edits so far:

- `server/highlevel/contacts-dispatch.f024.test.ts`: table mode `negative` for all 16 operations → `outcome_unknown` (MAIN 1); `followers.remove` mode `accepted`, including the fresh-process witness → `outcome_unknown` (MAIN 4).
- `server/highlevel/cfix3-recovery.test.ts`: `negative confirmation` collection row → `outcome_unknown` (MAIN 1).
- No expected read/send counts, identity assertions, replay assertions or approval requirements were reduced.
- `server/highlevel/opportunities-dispatch.test.ts`: CFIX6 `negative sibling` recovery row → `outcome_unknown` (MAIN 1). Immediate write-response negative confirmation tests remain unchanged.
- Historical R4 fixture now sends the declared notes/tasks pre-state GET instead of silently returning a local empty list; the existing read-count and rate-admission expectations remain unchanged.
- `server/highlevel/cfix3-recovery.test.ts`: `wrong name` and `wrong position` recovery rows lack the created stage IDs required by the frozen whole-response binder. They now remain `outcome_unknown` under MAIN (1)'s missing-confirmation rule. New positive tests supply complete stage IDs and continue to require `not_applied` for both proven mismatches.
- `server/highlevel/contacts-dispatch.f02.test.ts`: pending recovery `negative` journal reason → `unconfirmed` (MAIN 1).
- `server/highlevel/contacts-dispatch.f022.test.ts`: restart recovery `negative` outcome/reason → `outcome_unknown`/`unconfirmed` (MAIN 1); all read counts, no-resend, durable identity and terminal-cache assertions remain.
- Merge resolution `server/highlevel/c2-review.test.ts`, T7: retained hlf1's stronger assertion that zero-attempt restart keeps the original approval ID, and that `beginDispatch` refuses after recovery. This adds checks to hlc2's `outcome_unknown` assertion; F0.2.4 actions recovery instructions require those properties.
- RV7 adoption (`hl-int4`): `server/highlevel/opportunities-dispatch.test.ts` collection rows `negative unrelated`, `negative error`, and `negative sibling`, plus deletion mode `hidden negative`, require `outcome_unknown` instead of `not_applied`. Binding design: MAIN (1), `/work/fuigo-builds/swarm-b/hlint1/prompt.txt:2`: "Validate the WHOLE provider response, including nonmatching collection members, before any reconstruction. A negative or missing confirmation means unconfirmed, never applied." This is the recovery-specific amendment already recorded at line 7 above. The later hlf2 merge retained the shared guard but imported expectations from before that amendment. No product behavior changes: a negative recovery flag proves neither application nor authoritative absence. Existing proven-absence and present-target expectations remain. Both RV7 tables additionally require exactly the declared pipeline lookup, identical terminal replay on the same and a fresh host, no replay reads, and the original single mutation.
