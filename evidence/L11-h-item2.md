# L11 relay 6: write transaction gate

The reported count mismatch is installation-app-schema-downgrade.ts: 2 openers
versus the allowed 1. The unguarded opener in the saved red log is line 227,
SAVEPOINT room_objects_downgrade. Both failures exactly match
../evidence/L11-g-red-gates.log from before starting HEAD 8f30212c28.

Starting HEAD already uses beginWrite at line 228, endWrite and undoWrite for that
frame. The only remaining deferred opener in this file is line 307:
SAVEPOINT phone_downgrade, on the nested branch of the db.isTransaction guard.
The allowlist remains count 1 and guarded: true. Both count and guard assertions
passed before any source edits in this session; all four write structure tests
passed in ../evidence/L11-h-initial.log.

The scanner recursively walks server/ independently of the Vitest file list.
No new opener or second site was found. The existing shared helper fix is retained,
and neither the allowlist nor the guard check is changed. This commit records the
verification rather than manufacturing a redundant implementation change.
The external rig's reported older source state cannot be explained further without
its workspace evidence.

## Cause of the rig discrepancy (build driver 7A, 2026-11-07)

The wide-rig results that showed this red were stale. The rig run named L11t on r2 wrote its Vitest results at 19:51Z on 2026-11-06. Its SHA file (8f30212c28) was written at 20:32Z, when that head was archived. So the results came from an earlier head of this lane, not from 8f30212c28. On the exact rig tree of 8f30212c28, this test passes alone. For the read gate, a run with ATTACHMENT_GATE_WRITE=1 regenerates an inventory byte-identical to the committed one (504 sites). A fresh exact-sha rig run of 3f7922251a (L11u) replaces the old result.
