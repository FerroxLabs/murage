# L14 evidence fixture correction

The save refusal is correct. These fixtures used `captureSource` to name a message that they had never stored. They did not model a legitimate production save.

Production writes the anchor with `replaceRow` in `server/message-db.ts:1018`, then calls `captureMessage` at line 1026 in the same write. `server/memory/capture.ts:204` captures that stored message. The save route calls `saveGroundedMemory` at `server/memory/routes.ts:113`, which calls `saveMemoryCandidate` at `server/memory/authority.ts:128`. The anchor check in `server/murage-anchor.ts:32` refuses a missing row. Removing that refusal would admit evidence whose origin cannot be checked.

| Existing test file | Unreachable fixture state | Correction |
| --- | --- | --- |
| `server/writetime-s2.test.ts` | `ownerFact` captured key `k1` without a stored owner line | Use its existing `say` writer, which persists and captures once |
| `server/memory/lineage-cache.test.ts` | `seeded` captured `older/m1` without the message | Store the owner anchor with the existing legacy fixture helper |
| `server/memory/backfill-ancestry.test.ts` | `secretRecord` captured `older/m1` without the message | Same |
| `server/memory/idle-lane-fairness.test.ts` | The forget scenario captured `older/m1` without the message | Same |
| `server/direct-replay-without-memory.test.ts` | Captured `dax-older/m0` without the message | Same |
| `server/memory/receipt-sequence.test.ts` | `secretRecord` captured `older/m1` without the message | Same |
| `server/memory/session-prefix-flat.test.ts` | `secretRecord` captured `older/m1` without the message | Same |
| `server/room-transcript.test.ts` | The ancestor-receipt case captured `dax-direct/m-dax-direct` without the bot reply | Store the bot anchor with the existing legacy fixture helper |
| `server/steer-lineage.test.ts` | `memoryDerivedReply` captured `older/m1` without the message | Same |
| `server/memory/pip-epoch-fence.test.ts` | Direct `captureMessage` calls named unstored owner and bot messages | Store the exact message before capture with `captureStoredMessage` |
| `server/memory/pip-epoch.test.ts` | Initial owner and reply helpers captured unstored messages | Same; deliberate re-originating mutation still uses the original capture function |
| `server/memory/pip-paid-calls.test.ts` | Paid-call setup captured unstored owner and bot messages | Store before capture |
| `server/memory/pip-result-held.test.ts` | Held-result setup captured unstored owner and bot messages | Store before capture |
| `server/memory/pip-result-revoked.test.ts` | Revoked-result setup captured unstored owner and bot messages | Store before capture |

The same production ordering applies to PIP. `heldRefsCurrent` in `server/memory/learning-send.ts:176` now checks source anchors before release. A source with a missing anchor cannot reach that release through the real message writer. All 104 tests in the five PIP files pass (`../evidence/l14-pip-anchors-after.log`), including unchanged paid-call, denial, crash and stop assertions.

The legacy helper writes only the anchor, preserving the older receipt and lineage model these tests exercise. No existing assertion was removed or weakened. No production code changed. Deleted, revoked, pending and tombstoned evidence still passes through the same refusal.

Targeted proof: the first seven files passed 69 tests (`../evidence/l14-fixtures-final.log`); steer lineage passed five (`../evidence/l14-steer-final.log`); room transcript passed 22 (`../evidence/l14-room-transcript-final.log`). All 96 tests across these nine files passed. Twelve neighbouring files passed 204 tests, including deleted and pending evidence refusals and correction evidence revalidation (`../evidence/l14-neighbours.log`). The direct-caller comparison reproduced 37 refusals in nine files at original HEAD (34 files, 648 tests total), with all 639 tests present in 32 base files passing. The corrected direct-caller run passed all 648 tests (`l14-pristine-candidates.log`, `l14-base-candidates.log`, `l14-final-candidates.log`). Commands and final comparison results are recorded in the round report in `../evidence`.
