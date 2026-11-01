# A slow resume check no longer costs a chat its session (WIN-CLAUDE-RESUME, CLAUDE-RESUME-ONCE-1012, 1.0.13)

Base: tmp/int1013-trial 78baa4295. Rev 2, 2026-11-01.

## 1. Problem and cause
A chat can start a new native session on its first turn after a restart. Murage replays the history, so the reply is right, but the
native context is lost and a long chat costs more. Packaged 1.0.11 on Windows read FRESH once and PASS on the repeat.

Proven cause of the mechanism: every resume check runs on a lineage allowance with a wall-clock budget, 50 ms for a turn
(lineage-allowance.ts TURN_LINEAGE_MS), 100 ms for a tool check. `timed()` charges the whole check, cold statement prepare included.
Once `overTime()` is true the next spend throws MEMORY_REPLAY_LIMIT, the check reports `lineage-warming` (or `checking`), and
index.ts:12317 or 12487 (or the after-recall recheck at 12411) drops the cursor: `resumeCursor=undefined; sessionReset=true`. The
session had nothing wrong with it. The check ran out of time, on a clean session with a handful of rows.

The first turn after a restart is the coldest read the process makes, and the allowance is shared with the turn's other lineage work,
so one slow read decides. No platform branch: any slow machine can do this. Vitest hides it in-process (`defaultMs` returns Infinity
under VITEST). A child server has no VITEST, so server/claude-isolation-contract.test.ts:133 meets the real budget: on the build host at
0.5 CPU it failed there with no --resume, and server/claude-resume-slow-check.test.ts fails the same way with one 120 ms read.

Ruled out by code: pending tools leave no cursor (the MCP gate only prefixes the prompt; the cursor is saved at `system/init`, and the
test's second case passes on the trial). A hard kill at quit: the cursor reaches disk 250 ms after init, the desktop's close message
flushes first (index.ts closeRequested), and the rig quits long after the reply.

## 2. Fix: one second look, on its own allowance
When a resume check reports `lineage-warming` or `checking` AND its allowance is over time with nodes left, run the same check once
more on a separate allowance: same scope, same nodes, RESUME_SECOND_LOOK_MS (500 ms) of time.
- The second look passes: the session resumes, and the original allowance's clock restarts once (msUsed 0, hit false), so the turn's
  memory block is not starved by the cold read.
- The second look fails for any reason: the session resets exactly as today, with the second look's reason logged.
- A check that failed for a real reason (revoked, memory-changed, deny, seal, no-receipts) never gets a second look. A nodes
  exhaustion never gets one: a read that is too big stays too big.
- Every second look of an allowance draws on ONE second allowance, so a turn's looks add at most one allowance in all. Rev 1 allowed one
  look per allowance: at 0.5 CPU the early check used it and the after-recall recheck then reset the session (2 of 6 runs, reason
  `after-recall lineage-warming`). A turn makes up to three checks. A closed allowance gets none. `renew()` is untouched, so the reset
  path's fresh rebuild allowance (RESUME-RACE) stays whole.

Where: inside the three exported wrappers that already call `timed()`: `continuationMemoryRevoked`, `retainedSessionInvalid`, and through
them `resumedSessionInvalid`. Every caller is covered, the tool allowance at the submission boundary included, with no call site edited.
`setLineageTimeBudgetForTest` still governs both budgets, so a test that sets 0 still resets.

## 3. What does not change
Fail closed holds: a session resumes only on a check that finished and passed. No revoke, forget, seal or policy check is skipped or
weakened. The second look reads through the same functions. Work stays bounded and does not grow with history: nodes bound it (3,000),
500 ms bounds its time, one extra allowance per turn at most, only where the cost today is a full reset and replay. A clean look seeds the
session hold, so the next turn is O(1). The UPDATE that marks a receipt revoked already skips when `allowance.hit`, and the first look
stopped on the limit, so a second look does not double a write.

## 4. Tests
- server/claude-resume-slow-check.test.ts (GATE, all OSes): real harness, real budget, fake CLI, restart, one slow read: same session
  by --resume, no replay, no reset line. Fails on the trial. Second case: approvals pending on the first turn keeps its cursor.
- Unit, server/memory/resume-second-look.test.ts: a real reason gets no second look; nodes exhaustion gets none; a second look that
  fails resets with its reason; all looks draw on one allowance; a 0 budget still resets.
- Existing lineage time tests (lineage-r3, dispatch-prepare-limit-107) still pass.

## 5. Kill criterion
Metric: `memory continuation reset` lines with reason lineage-warming or checking in server.log, first turn after a start. Target: none
on a chat with under 1,024 receipts over a week of beta. If they remain, the budget is not the whole cause: read the reason and fix the
named read, never raise the 500 ms.

## 6. House rules check
Rule 1: works on every OS and engine by default, no setting, and per-turn work does not grow with history. Rule 3: limits stay in the
harness. Rule 5: small, fixed scope. Rule 8: the gate's RESUME-RESTART row names the packaged proof. Rule 9: no copy changes.
