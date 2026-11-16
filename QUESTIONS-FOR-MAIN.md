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

# S4 retained membership and Sable witness
Owners: nolim-s4-port-b owns retained channel-turn membership and the Sable production witness; nolim-s4-port-a owns server/index.ts, narrow-denials.ts and decision-wiring/runtime-fixture.ts.

Sable uses a local test-only sable-runtime-fixture.ts with the strict fake CLI acknowledgement adapter extracted from 0c3e96a4b7. No runtime-fixture.ts change is needed for this witness. MAIN/port-a may consolidate the duplicate adapter after seating both lanes. The train implements S1 contracts, so Sable needs no legacy missing-contract stubs.

The unrelated M21/R19b mutation bundled in the old sable-server-mutant.mjs belongs to port-a's ancestor-save/spread work. This lane ports the Sable drop-producer mutant only, using fixture module loading to leave server/index.ts untouched.

The explicit lane instruction “Do NOT merge integration branches” takes precedence over the generic host merge rule; this branch remains based on f9367db4a56.

Sable adaptations retain every original assertion: resolve all relative fake-CLI imports; use a FAKE_ manifest variable preserved by the train launcher; forward the EventBus SourceContext; omit decorative fake tool-use/result frames (the unchanged full MCP permission request is the witness) so display stays inside the existing stream budget; enable the real browser capability for the three browser request shapes because the train correctly refuses disabled capabilities before No limits. No decision stubs, production hooks or raised budgets.

MAIN owns the three existing routines-tracked-save failures: inheritAllPermissions persistence parity, R5 run identity rollback (Nested full transaction), and R5 alternating owner-view creation (720 history reads). All three reproduce unchanged on f9367db4a56; this lane does not change those tests.
