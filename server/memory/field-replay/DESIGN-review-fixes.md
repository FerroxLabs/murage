G-NL-s2m-r4 review corrections (addendum to ../DESIGN-S2M-r4.md)

Scope: only the four BLOCKs in arev-bld-s2m-r4/REVIEW-from-last.txt.

B1: run both assigned HANDOFF suites in full at the delivered tip. handoff-gate.md
names the suites and logs; any later integration failure needs its own run or
an explicit design. Neither suite's assertions are weakened.

B2 / R8: schedule_routine has no host-computer target. Instructions mentioning
that computer cannot test the denial resolver. Keep a real routine proposal
through its mounted agents MCP -> routine-requests.ts, assert its unlimited
positive effect, then call the same turn's mounted permission MCP with the
actual tool name mcp__murage_host_computer__click. That name creates the
host-computer target in decision/action.ts. Persist hostComputerConsent=declined
through the desktop API and read it back first. Assert one deny card in SSE,
transcript and decisions; answer deny and join the MCP reply. This is a paired
routine-plus-engine-denial control, not a claim that schedule_routine itself
can express a host target. No host-computer tool is executed or mounted by the
replay; it only submits an engine permission request. MR7 still removes the
real S4 deny resolver and can qualify as killed only from a GREEN R8 on TW.
A unit tripwire rejects the former schedule/prose request shape; it does not
substitute for the TW MR7 proof when S1 blocks server startup.

Fix round 2: R8 calls Surface.nextPhase after applied() and before the host
permission request. The boundary rechecks all current exact expectations before
retiring them. R8's zero-card proposal checkpoint therefore cannot be rechecked
against the later deny card. The next phase asserts exactly one cumulative card
in all three surfaces, with deny evidence, and keeps that expectation through
interrupt/idle settlement. No other R case changes its assertions or lifecycle.
The harness regression exercises real HTTP/SSE recording and a temporary journal;
its successful sequence and missing-deny/stray-applied-card mutants test phase
accounting without replacing any product decision implementation. A third
mutant reinstates the original persistent assertion and must fail settlement.

B3 / R5: before runNow, set the target bot's default cwd to the registered
synthetic clone through the desktop API. This covers both the owner bot and
a fresh forBot target. Capture the timestamp before dispatch; inspect the
run thread's own outside journal mark (cloned folder, or outside-derived
memory if it precedes cwd on the owner's bot), turn/session/open generation and thread
identity before using that run's memory mount. Include runMark in successful
and failed evidence. R5-mark runs the same real proposal and dispatch and
asserts this precondition independently of the S1 sync memory dependency.
The behavioral RED mutant suppresses the cloned-folder mark on routine
dispatch only; the fresh forBot run must fail its own mark precondition.

B4: BehavioralRed is RED. Only an identifiable decision NotBuilt or the mounted
memory service's NotBuilt is BLOCKED-BY-S1. All other exceptions (including
500s/timeouts without that evidence) are ERROR, never RED/GREEN or an S1
exemption. Missing mutation anchors/files, child launch failures, missing rows
and ERROR replay rows produce ERROR in the mutation report. Only explicit RED
rows whose matching unmutated case was GREEN can kill a product mutant.
