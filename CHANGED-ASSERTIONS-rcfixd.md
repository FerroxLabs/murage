# CHANGED-ASSERTIONS (q1023-rcfixd-r2, base f887a65c45; all 9 files red on tip, green on 1.0.22 base d11e43d8c6)

| file | class | what changed | ruling / reason |
|---|---|---|---|
| server/memory/strip-only-syntax.test.ts | (b) REAL BUG | product fix: server/mailbox/testing/wire.ts used a constructor parameter property (not runnable with node strip-types); now a plain field. Test unchanged. | the test's own contract (9105a6faf8 lane) |
| src/lib/tokens.test.ts | (b) REAL BUG | product fix: FolderTrustRecords.tsx used `border-line`, a token that does not exist (class never generated); now `border-hairline`. Test unchanged. | token-drift guard |
| server/web-read-routing-inventory.test.ts | (b) REAL BUG | product fix: shared/web-read-routing.ts had no row for the shipped devinAgent driver; added the same fail-closed row as its ACP siblings (web_read mounted + visible "no verified native exclusion" limitation) and its display name. Existing assertions unchanged; added a Devin-specific limitation witness (web-read-routing-inventory.test.ts:13-16). | fail-closed: unverified engines surface their limit |
| src/state/deletion-owed.test.ts | (a) DRIFT | onOpen source pattern now includes the Ask-card resync prefix `attentionGen = ++attentionStreamGeneration; forwardAttentionResync(attentionGen);`; refreshOwed on connect/reconnect still asserted, in order. | Ask-card recovery (bld-N3-1021 e582703a7c) |
| src/lib/tts/reply-integration.test.ts | (a) DRIFT | harness passes `forwardAttentionControl` (new first step of the store's onFrame) as a spy and asserts it ran once; reply tap/pendingFrames assertions unchanged. | Ask-card recovery (bld-N3-1021) |
| server/owner-limit-write-receipt.test.ts | (a) DRIFT | harness context gets `codexEffortAtWrite: undefined` (new free variable in attemptWritten); write/receipt/replay counts unchanged. | codex effort stamp at write (N5 dd2b64641f) |
| server/ux-l4b-isolation.test.ts | (a) DRIFT | harness gets a real PendingTurnKeys as `confirmedStopGenerations`; stale-cleanup assertions unchanged. | JOINT RULING STOP-VS-REFUSAL (confirmed-stop set) |
| server/memory/resume-after-recall.test.ts | (a) DRIFT | receipt marker is a prefix match; production now passes a trailing `!engineCommand` argument. Ordering (await < recheck < reset < receipt) unchanged. | engine-command turns (N5) |
| server/phone-calls/phone-mount-audience.test.ts | (a) DRIFT | harness follows the launcher's refactor: section now declares commandEngine/commsDepth/bot itself, so the wrapper's duplicate declarations were removed and the names it reads (registry, phoneReadyService, phoneKeyPresent, phoneAdmission, codexDefaultEffort, threadHumanPrincipal) are stubbed with an engine-less / phone-ready fixture. Every audience expectation (owner, chain, routine, No-limits, restart) unchanged. | none weakened: same toEqual([]) / OWNER_TOOLS rows |

No security/privacy assertion was weakened. No option-B (shown/masked-in-place) assertion is in these files.
