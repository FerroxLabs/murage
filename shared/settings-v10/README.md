# Settings v10 frozen contracts (SEAT)

Written by lane core in the SEAT commit from the producer's spec (BUILD-PLAN §4).
After SEAT the PRODUCER lane owns each type file below. A type change after SEAT
needs the consumer owner's ack line in both lanes' last.txt.

| File | Contract | Producer (owner) | Consumers (owner) |
|---|---|---|---|
| no-limits-plan.ts | C2 | core G1 | roster A9-bots |
| access-revision.ts | C3 | access | roster, botpages, find |
| account-audience.ts | C4 | access AG0 | access AC1, accept |
| archive-review.ts | C5 | roster | botpages B2/B3, shell Sidebar |
| archive-guard.ts | C6 | roster | core (seated PATCH hook) |
| reach.ts | C7 | access R0 | botpages B1, find L1, access A4 |
| ../setting-ref.ts | C8 | core L0 | every page lane, find L1 |
| page-registry.ts | C9 | shell | every page lane, find A1/J1 |
| leave-draft.ts | C10 | shell X2 | devices A7, find A8 |
| purchase.ts | C11 | devices X1 | find A1/S1, botpages A2 |
| journal.ts | C12 | core J0 | access, devices, shell X2, roster |
| memory-head.ts | C13 | core M0 | find A8/M1, botpages B6 |
| skill-search.ts | C14 | skills K6 | find S1 |
| dictation.ts, voice.ts | C15 | tools A3 (dictation) ; botpages B6 (voice) | find A8 ; tools A3 |
| tool-truth.ts | C16 | tools T1/T2/G4 | access R0 |

C1 (the SEAT sha itself) and C17 (design fixture, read-only) have no type file.
