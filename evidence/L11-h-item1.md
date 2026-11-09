# L11 relay 6: attachment inventory

Starting HEAD: 8f30212c286114b36c06b70e9af162aca833c4cc.

The reported 505 versus 504 failure exactly matches ../evidence/L11-g-red-gates.log,
recorded before that commit. The missing grouped key was
server/installation-memory-downgrade.ts:155 and :158,
preservePhoneCallsForDowngrade / openSync, count 2, root data-dir-parent.
These open the preserved database copy and its directories for fsync.
HEAD already registers that key at server/attachment-read-gate.inventory.json:2229.
Reading the committed JSON with git show HEAD:server/attachment-read-gate.inventory.json
confirms 505 entries. A run against those bytes cannot expect 504 entries.

Fresh verification, before any source edit:
node_modules/.bin/vitest run server/attachment-read-gate.test.ts server/write-tx.structure.test.ts electron/cloud-step-up-label.test.mjs
Both server files passed (6 tests); only the Electron coverage test failed.
Log: ../evidence/L11-h-initial.log.
The read gate builds its own program from tsconfig.server.json and scans server sources;
the Vitest selection does not limit that program to selected tests.

No second missing read is established. No inventory or check changes are warranted.
The external rig workspace/log is unavailable here; the discrepancy is between its
reported input state and the committed bytes, not a demonstrated file-list difference.
The supplied prior report is at ../evidence/L11-fix-g.md, outside this repository.
The memory prelude tool and .ijfw/memory are absent in this session.

## Cause of the rig discrepancy (build driver 7A, 2026-11-07)

The wide-rig results that showed this red were stale. The rig run named L11t on r2 wrote its Vitest results at 19:51Z on 2026-11-06. Its SHA file (8f30212c28) was written at 20:32Z, when that head was archived. So the results came from an earlier head of this lane, not from 8f30212c28. On the exact rig tree of 8f30212c28, this test passes alone. For the read gate, a run with ATTACHMENT_GATE_WRITE=1 regenerates an inventory byte-identical to the committed one (504 sites). A fresh exact-sha rig run of 3f7922251a (L11u) replaces the old result.
