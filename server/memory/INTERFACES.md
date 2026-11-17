G-NL s2m round 4 handoffs

H-S4: S4 owns server/index.ts. At its POST /api/internal/memory/* route,
inside withBotLearningFolder(internalClaim.botId, ...), replace the invocation
memoryAgentRoute(path, await readBody(req), access, memoryWorker,
memoryDispatches.get(internalClaim.threadId), extractor, {...}) with
authenticatedMemoryAgentRoute(internalCapabilities, internalClaim, path,
await readBody(req), access, memoryWorker,
memoryDispatches.get(internalClaim.threadId), extractor, {...}). Import the
adapter from ./memory/http-authority.ts. On faf647845 this is line 24955;
on the s2m input 35af0066e it is line 24714. The published S4
a8103608af80b77bb58a03ad0b026bf3cc4e717f now has this adapter at line 24988;
retain it in the integration merge. Keep the existing request lifetime,
budgetGate, executingRequestId, and onRead options. The authenticated adapter
registers the capability-bound execution claim. R6 is the real-boundary gate;
field-policy.fixture.ts's HTTP caller regex remains the static tripwire.

H-S1: implement CONTRACT-ADD executeServiceSync and answerApprovalSync from
e95008508, including the final recheck and captured delivery. No bridge or
snapshot overlay qualifies for field-replay. Only identifiable decision or
mounted-memory NotBuilt results are BLOCKED-BY-S1. Other 500s, timeouts,
missing mutation targets and harness exceptions are ERROR; none is behavioral
RED or GREEN.

H-s2p: routine ProducerApprovalQueue execution must pass the black-box
field-replay.e2e.test.ts on Wave A with S1 + s2p + S4 + s2m. Do not depend on
e512acb4b or pin S1's uncommitted implementation. Preserve ServiceAuthority
when resolving the legacy ownerNoLimits authority collision.

A13b: R1-R10 and MR1-MR8 plus MS on the integrated throwaway Wave A tree are
the acceptance gate. The six RoutineManager callback cases are unit cases and
are excluded from Field 7 workflow claims.

Fix-round HANDOFF suite gate: field-replay/transfer-gate.md records full runs
of lineage-allowance-reads.test.ts and upgrade-fix-r3.test.ts.
field-replay/DESIGN-review-fixes.md specifies the corrected R8 actual denial
target and R5 execution-thread mark precondition.
