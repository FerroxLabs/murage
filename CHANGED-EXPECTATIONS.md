# Scrub expectations

Authority: leakscrub2's user instruction makes the shared shell guard and its
shared POSIX ERE file the only guard. Production behavior must remain unchanged;
changes to test expectations must be recorded here.

The old guard's working-tree, filename, binary, symlink and arbitrary-diff
expectations are replaced by the shared guard's committed-HEAD text scan and
base-to-HEAD added-line scan. Tests create actual temporary commits, exercise
every shared rule using split-string fixtures, verify safe summary output,
and check configuration errors. The former public-switch exemption is removed.
The repository release assertion still requires exit 0, so the unresolved
runtime inventory keeps it red until MAIN rules. No expected failure or
runtime-name exemption was added to that assertion.

Two test descriptions now use a generic route-switch label:

- `cloudflare/control-plane/test/b4-flux.test.ts:4526`
- `cloudflare/control-plane/test/grants-d1-d3.test.ts:690`

Their assertions, test inputs and executable bodies are unchanged.
`server/cloud-home/engine-render-launcher.test.ts:456` constructs the same
endpoint value from two strings. This preserves hostname-normalization
coverage and the existing expected URL at line 460.

All other scrub edits are comments or documentation. No product assertion,
runtime configuration key, environment lookup or deployment value changed.


---

# Changed expectations — cfix-askcards

Binding: `/root/fuigo-builds/swarm-b/askcards1/RULING-askcards-hl-MAIN.md`.

No expectation is loosened.

- Item 4: `thread-marks.test.ts` uses `marked`/`unmarked` instead of booleans and requires `unreadable` on read failure. It additionally asserts denial of a proven native call. `engines-native.test.ts` passes those typed states with every existing allow/deny assertion unchanged.
- Item 4: runtime fixtures (`runtime.test.ts`, `native-wins.test.ts`) explicitly supply confirmed marks. The new mounted-capability regression requires refusal and no extra provider or lease calls after a storage fault, then successful recovery with the same capability.
- Item 3: new restore witnesses require union of backup/destination marks on reopen and refusal before replacement when preservation cannot be proved. This intentionally tightens restoration of a damaged destination database, whose marks cannot be recovered.
- The separate restore activation helper also merges marks before selection, under item 3's permanent-mark requirement.

The incoming HighLevel branch's expectation changes are separately retained in `docs/verification/hlint1-CHANGED-EXPECTATIONS.md`, copied from its MAIN-reviewed integration record.

- Item 4: the incoming `cfix-f02.test.ts` runtime-construction fixture supplies a confirmed mark, matching the other native runtime fixtures; all dispatch/journal/replay assertions remain unchanged. `auto-approve.ts` passes typed `unmarked` instead of the former `false`, preserving ordinary policy behavior.
- Frozen F0 anchored-file contract (`server/highlevel/F0.md:20`, `server/highlevel/frozen-contract.json`, `AnchoredRefusal`/`AnchoredReadRefused`): `c2-fixes.test.ts` FIFO refusal checks the actual exception class and exactly `not_regular` or `unsupported`, replacing the obsolete human-message regex. These are the same two refusal reasons as before; timeout/nonblocking and child exit assertions are unchanged. This strengthens the assertion against arbitrary errors with matching text.
- The existing lifecycle inventory equality assertion remains unchanged. `phone_ask_optins`, already in the schema inventory, is registered with its actual per-phone lifecycle from `PhoneRegistry.setDeviceIdOptIn`/`remove` (no table behavior changes).

## Imported HighLevel integration expectation record

The following is the complete reviewed record from hlint1; MAIN item 2 retains these rulings.

# Changed expectations

Binding sources: MAIN hlint1 rulings in the user instruction; `/root/fuigo-builds/swarm-b/hls0/F0.2.4-FROZEN.txt`; `/root/fuigo-builds/swarm-b/hls0/RULING-hlf-r2-MAIN.md`.

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

---

# Changed expectations

## Browser owner waits release execution (1.0.19 field item 4)

Authority: the browser-lock release task and item 4 of the browser-lock triage,
“release the browser execution claim on ordinary owner waits.”

`server/independent-thread-runs.test.ts` previously required the waiting routine
to keep owning `browser:profile`, and required its sibling to return `yielded`
without browser access. The replacement requires the waiting generation to
release its browser and browser-only screen after dispatch is fenced and drained;
the sibling receives both. A resumed waiter can reclaim the same selected route
only while it is free, and must take a fresh snapshot before acting. A busy route
produces a plain retry explanation. The turn's browser-selection lease survives
the wait; explicit owner control, protected documents, and computer screen claims
are unchanged. The corresponding queued-sibling test now expects admission after
the waiting holder releases, rather than `yielded`.


Review fix round 1 extends the same ownership rule to extension site/action
approval waits. The exact RPC awaiting its card is parked; other active calls
still drain. Its continuation reclaims the pinned route before consuming the
unchanged answer, and Stop cannot revive it. Extension bootstrap recovery may
navigate only from a live `about:blank` document; a successful fresh snapshot is
still required before subsequent page actions. Approval/card policy is unchanged.

## int19m2-C browser handback merge

The MurageCloud B2 no-owner regression is retained alongside Wave B's owned-close and legacy-receipt tests. Current recovery calls `createNativeBrowser(spec, { closeOnly: true })`, which immediately refuses a missing ownership record. The merged fake-time test awaits that complete refusal and verifies both recorded PIDs remain alive; it does not assert the older 70-second implementation detail. The stale-pid case retains its no-exit assertion and adds an exact ownership-refusal and liveness assertion.

## int19m2-C stopped-task copy

Sol's supplied review explicitly rejects telling users to start a new browser task in the extension, which has no such control. The corrected Spanish, Hindi, and Brazilian Portuguese `.23`/`.24` instructions ask the bot to start the task and then choose Continue. The copy regression now checks both actions and rejects the obsolete extension destination for those keys. The displayed-name checks remain unchanged for `browser.profileWaiting` and `.21`, where they apply. This change implements the user's instruction to apply Sol's exact corrections; it does not change a review verdict.

## Room routine lifecycle (r2-room-turns-c)

Lifecycle observation producer and fixture consumer owner: r2-room-turns-c. Native lifecycle owner: tri3-g1.

// MAIN RULING request ROOM-ROUTINE-SINGLE-USE-EVICTION: replace the optional
// spare-eviction log oracle with background:true at the actual adapter submission
// and a confirmed close receipt for the exact native turn; retain completion,
// receipt, room-task selection, user-activity policy and the five-second bound.

The current driver closes mounted turns as `mounted-single-use`
(`server/drivers/claude.ts`), and calls `live.spare?.lost("background turn")`
only if a spare exists. The observer calls the real adapter unchanged. The test
now requires one background dispatch and one matching confirmed teardown, so a
foreground dispatch or retained native child fails. No permission, privacy,
completion, partition, timeout or resource-bound assertion is relaxed.

## Scripted room result wakes (r2-room-turns-c)

Wake-text producer owner: r2-comms-chain-b. Scripted-engine consumer owner: r2-room-turns-c.

// MAIN RULING request ROOM-FAKE-WAKE-SHAPES: model the current direct asker wake
// (asker-wake.ts) and room result continuation (project-prompt.ts); distinguish
// replayed history from the continuation after the current room reply frame.
// Keep every result-delivery, privacy, step-cap and deadline assertion unchanged.

The delegated room fixture failed to consume the reviewed room result heading,
so it handed work over again on every result until the real six-step cap stopped
it. It now consumes that continuation and the direct control-plane wake. Actual
ACP process tests cover direct wakes, room wakes and quoted-history negatives.
No assertion in the Phantom scenario or the assigned 72 IDs changes.

## Quiet-build readiness fixture startup

// MAIN RULING request text: "Update fixtures only to match the current reviewed product contract, never loosening an assertion."

Existing reviewed contract: INT-CONFLICT-DEFAULT eb01447e7d, already cited in
this test: retain the short quiet-build wait and refuse consuming mounts
without readiness. This applies that contract; it requests no new ruling.

`server/drivers/acp/mcp-listed-wait.test.ts` removes the artificial 150 ms
connection delay only from the recovery attempt after two silent attempts.
That attempt still starts the actual agents and memory proxies, completes
real MCP listing, and must be heard inside the unchanged 500 ms short wait.
Every assertion is unchanged, including the silent refusals, zero prompt
writes, short wait, marker observation, and restored full wait. The separate
cold-start control retains its 1500 ms connection delay and timing assertions.
No expectation or product timeout changes.

## MAIN RULING 1115-ACP-MOUNTED-SINGLEUSE

Test implementation owner: ci-reds-ff3a-g. Product contract and native release qualification owner: MAIN.

- `server/host-power.test.ts`, "uses a fresh caged ACP wrapper for each mounted turn and cleans matching-argv descendants": the stale mounted three-turn reuse/idle expectation now requires three fresh wrappers, three handshakes and zero idle entries after every turn. Nonempty integrations are single-use under `cli-mount-relay.ts` and `acp/core.ts`, consistent with MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d in `acp/pool.test.ts`. The integration rotation, real helper permissions and cmdline, engine identity, MCP parentage, session/load `noReplay`, matching-argv grandchild and confirmed whole-tree cleanup assertions remain. Cold continuation replaces resident-session reconciliation: the matching-argv grandchild is cleaned with its single-use tree instead of triggering a reused-process replacement. The fake engine starts/replaces its native transport shim twice on cold session/load; both launches are counted. The actual integration runs in its own cage, so the retained exact server/grandchild argv and parentage checks resolve against that owned tree. Both cages and all observed descendants must be gone.
- `server/host-power.test.ts`, "reuses one caged ACP wrapper across three non-mounted turns with no integrations": a separate real-cage control requires one wrapper, one initialize/authenticate handshake, three successful prompts and one idle entry between turns. It verifies stable engine identity and the physical wrapper cmdline, no redundant session/load, and confirmed cleanup on disposal. No integration is supplied on any turn.

Both native cases carry `// MAIN RULING 1115-ACP-MOUNTED-SINGLEUSE`. No other lifecycle, policy or platform expectation is changed. The anchored-reader diagnostic preserves refusal codes and guards; its Linux diagnostic unit does not qualify the macOS packaged job (B3 remains open).

## redact2-1020 (fix/1020-redact2-n2)
- server/transcript-page.test.ts "an old marker keeps its field without blanking its owner-only row siblings": the owner-only read of an
  assistant text row stored as ONLY «redacted» now expects REPLY_WITHHELD (owner-display.ts), not the bare marker. Sean reported those
  bubbles in a routine thread (1.0.20 pre9); the sibling field (removedText) assertion and the shared-audience assertions are unchanged.

## userbug-sealed-1022 (fix/1022-userbug-sealed-fable)
- server/drivers/cause22-owner-caps-relay-1021.test.ts "R6 owner turn": the two replies that meet a pending memory check on the owner's
  running turn are now delivered whole and in order (1024 bytes and 19 MiB); before, each was held to the bound and answered with the
  -32000 "still checking" error. Reason: owner report (turns refused or tools dead while a memory check never settled); memory readiness
  never refuses or drops the owner's own turn. The no-seal and no-refusal assertions are unchanged, and the hold-then-drop at the bound is
  still asserted for every other turn (server/drivers/mount-pending-defer-1020.test.ts REVKILL2 bound).
- server/drivers/cause22-owner-mount-budget-1021.test.ts "W22-1 owner turn": the 200 tool results (over 20 MiB) that meet a pending memory
  check on the owner's running turn are now delivered whole (dropped 0, no "was dropped" log line, more than 20 MiB reaches the engine);
  before, each was held to the bound and answered with the -32000 error. Same reason as R6 above. Unchanged: no refusal, no seal, no stop
  line, the budget does not degrade, nothing of the results is retained in the ledger, the turn completes.
