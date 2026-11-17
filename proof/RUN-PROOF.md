# Restore park proof

Run from the integration checkout on fixture-runner:

    bash proof/run-proof.sh <label> HEAD

The runner uses it-remote.sh with network disabled and a non-root container. It runs the registered proof and crash suites against isolated databases, fake Flux, and temporary restore-job sidecars. JSON results are written under `.test-tmp/proof-<label>/`.
The inventory confirmation uses the current RestoreJobStore check/confirm API. The proof asserts that the durable check was consumed by the route, then checks that the row disappeared.

The table below records the original source branch's historical results; run the current suite for this checkout's result.

## Steps (all assert owner-view rows and email_parks / binding state)
| Step | What | B tip 5fe9c8905 | int 0c2afcab7 |
| 1a | restore parks in-flight removal, Keep row present, 0 DELETEs | pass | pass |
| 1b | Keep: park gone, restored_unverified, 1 restore POST | pass | pass |
| 1c | kept key never re-parked (second prep + ticks) | FAIL (needs A3) | pass |
| 2 | parked Remove, fresh token: 1 DELETE, 1 revoke, park gone | pass | pass |
| 3, 3b | stale / expired token: 409 confirm_expired, look-again line, 0 DELETEs | pass | pass |
| 4a-4d | PHONE other-setup remove, thread email-owner, card, refused proof, bad tokens; parked/try-again proofs | pass | pass |
| 5 | restore_check then confirm_inventory returns 200 | FAIL (stub) | FAIL (stub restore_not_ready) |
| 5b | phone confirm_inventory proof on email-owner id restore | pass | pass |
| 6 | try_again_now on a bot removing row | pass | pass |
| 7a-7c | DELETE emailConfirm: valid = 1 DELETE; none/garbage/view token = email_parks dump byte-identical, 0 DELETEs | pass | pass |
| 7 route | handler diff vs base: 1 line changed (deleteBot call) | ok | ok |
| C4-C10, C12-C14 | restore-park-crash.test.ts, SIGKILL harness | not present | 13 pass |

## Gaps and findings
- Step 5 is BLOCKED-STUB on int: confirm_inventory still answers 409 restore_not_ready. The job batch must be wired before Batch D can pass; reviewers must treat it as FAIL.
- C1-C3 (Cloud swap, restore consumer) and C11 (Batch B delete commit) are NOT covered by email-crash-child.ts. Cover C11 via the 7a path plus a manual kill, or list as gaps.
- Step 7 checks the store hook layer; the HTTP handler itself (body read, ifArchived, bot credential) is only diffed, not driven. Needs a server-level test if reviewers want it.
- Desktop bot Keep returns the bot view, not rows; the contract's full-home-view rule is phone. Reviewers should confirm that is intended.
