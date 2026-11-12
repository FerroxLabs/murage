Field 7 real boundary replay (G-NL A13b, DESIGN-S2M-r4)

Run in a network-none Node 24 container:

    FIELD_REPLAY_TREE=T0 FIELD_REPLAY_SHA=<input-sha> pnpm exec vitest run server/memory/field-replay.e2e.test.ts

Each case launches its own real server/index.ts child, with no preloads, instrumentation,
module replacements, or decision fakes. It supplies an isolated temporary HOME
and MURAGE_DATA_DIR admitted by assertSafeToWipe, uses desktop HTTP to create
bots and raise permissions through preview/PATCH/refresh, and calls only mounted
MCP tools from the engine's real config and per-turn credential file. Only the
engine executable is fake. Clone cases first let the real server observe a synthetic local-clone
tool call, which populates the real download registry. A remote in .git/config
alone does not populate it. Web cases have a separate server without that
bootstrap, so clone windows cannot mask their web-page mark. The minimal ACP fake emits a hosted fetch and holds
the turn; the shared fake Claude CLI holds the other turns. Every outside case
checks the append-only outside store for the current turn and session
generation, joining the mark/marked-turn row to the real open/session binding.
The server uses synthetic outside turn IDs before provider acceptance; these
are recorded alongside the provider ID when the engine supplies it before proposing. Earlier-turn cases reset cwd before the second turn.

R1-R4 cover proposals, forBot and updates. R5 covers real owner run-now and the
run's mounted memory save, after checking that execution thread's own outside
mark and generation. R5-mark checks the same dispatch precondition independently
of memory activation. A fresh forBot run must have its cloned-folder mark; the
owner bot may first read outside-derived memory before its cloned cwd. R6 covers owner memory save/correction after all three
marks. Subscriptions remain open through the real interrupt/idle settlement, and every
recorded surface assertion is checked again after settlement, unless an explicit
phase boundary has already rechecked and completed it. R8 completes the applied
phase at zero cards before submitting the host request, then keeps the exact
one-deny-card cumulative expectation active through settlement. The zero-card
phase cannot absorb a stray card; a missing deny card cannot satisfy the next
phase. R7 compares unique card message IDs from SSE append/patch events (including
later-dismissed cards), the owner and run transcripts, and card-shown journal
rows. R8 covers deny and conditional wipe; R9 guest and Full BASE; R10 mark
preconditions. R7/MS creates a real routineRequest card and rejects an SSE-blind
counter. Neither openApprovals nor decision internals supply counters.

The agents MCP adapter returns prose, discarding the raw internal HTTP status
and applied field. Evidence records the tool response, HTTP-visible routine
record, unlimited ceiling and auto-approved/no-limits journal rows; it does not
invent an observed 201/applied value. Memory activation is confirmed with the
owner inspect API. Correction cases first seed an active unpinned record through
the same mounted memory_save tool; a blocked seed is explicitly recorded as
correction-seed, never as an executed correction. R8 persists a real declined
local-computer rule, applies a routine through routine-requests.ts, then submits
a genuine host-computer engine permission request through that turn's mounted
permission MCP and requires one deny card. Schedule prose cannot establish that
target. See DESIGN-review-fixes.md for the precise paired-control contract.
The guest control is a real asynchronous peer delegation: its source completes
on a separate fake-engine gate while the recipient stays held. Tool errors cannot satisfy positive-effect checks.

Evidence defaults to server/memory/evidence/field-replay/field-replay.jsonl and
server.log. Set FIELD_REPLAY_EVIDENCE to retain separate tree/mutant runs. Each
row names tree, input SHA, case, mark, counters and effect IDs, or its precise
failing assertion. RED is reserved for BehavioralRed surface/effect/precondition
assertions. Only identifiable S1 decision/mounted-memory NotBuilt failures are
BLOCKED-BY-S1. Other exceptions, 5xx responses and timeouts are ERROR, fail the
test process and receive no dependency exemption. The server log is retained after the
owned child exits and removeTempDir removes its isolated data. Dumps and turn
credentials remain inside the removed temporary HOME and are never evidence.

Three trees must be recorded: T0 input tip; TB 144a062a0^ with only these replay
files copied in; TW a separate throwaway merge of pushed S1 + s2p + S4 + s2m in
that order. Never push TW. Run mutants only there, with FIELD_REPLAY_SCRATCH=1:

    FIELD_REPLAY_TREE=TW FIELD_REPLAY_SCRATCH=1 node server/memory/field-replay/mutants.mjs

An installed Linux cage is required for ACP. FIELD_REPLAY_RESOURCES may name
a read-only resources directory containing the actual pinned cage/ artifacts;
no host-power or decision test overrides are installed. When running in a
container without the worktree Git metadata, pass FIELD_REPLAY_SHA explicitly.

The runner selects the legacy or ProducerApprovalQueue producer, restores all
patches in finally, and accepts only explicit behavioral assertion rows as kills on cases that were
GREEN in the unmutated Wave A run. Set FIELD_REPLAY_BASE_EVIDENCE to that
run's field-replay.jsonl when writing mutant evidence elsewhere.
Missing targets, compilation failures, 500s, NotBuilt and timeouts are not kills.
When S1 blocks startup, the matrix records that blocker instead of claiming a
mutation pass. The MS counter self-test belongs to the real-server R7 test.

transfer-gate.md records both assigned HANDOFF suite runs. review-regressions.test.ts
checks denial request shape and error/missing-mutation-target classification.
It also drives the R8 applied/deny/settlement sequence against an isolated
HTTP/SSE/journal fixture: zero cards before the request, exactly one deny card
afterwards, and rejection of cards added before the phase boundary or during
settlement. This proves the harness contract, independently of product policy.
review-mutants.mjs deliberately regresses each review finding in a designated
scratch checkout; these harness regression kills are distinct from MR1–MR8.
Its R8 mutants suppress the fixture's deny card, add a stray applied-phase card,
and retain the former cumulative zero-card assertion. Each must fail the same
otherwise GREEN R8 harness sequence with a behavioral assertion.
