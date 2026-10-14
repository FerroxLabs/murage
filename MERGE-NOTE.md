# Merge note: turnctx with lineage-cold (lincold2 d94b0ffb4)

Both lanes change `server/working-context.ts` and the working-context call in
`server/index.ts`. They combine as follows.

## working-context.ts

- Take turnctx's file as the base. Its structure is: discovery (which threads
  and which reply in each) is kept; every shown line is judged on every build
  in `shownLine`, and the one lineage call is `judgeReply`.
- turnctx already threads an optional `allowance` through every entry point,
  as the LAST parameter: `workingContext(input, db?, allowance?)`,
  `workingContextPrompt(ownerAudience, input, db?, allowance?)`,
  `workingContextBlock(ownerAudience, input, db?, allowance?)`, then
  `buildWorkingContext` -> `shownLine` -> `judgeReply(..., allowance)`.
- On merge:
  1. Replace `export type WorkingContextAllowance = unknown;` with
     `import type { LineageAllowance } from "./memory/replay-lineage.ts"` and use
     `LineageAllowance` (or alias it).
  2. In `judgeReply`, call lincold2's judge:
     `const verdict = capturedMessageVerdict(allowance, threadId, messageId);`
     return `"unproven"` when `verdict.unproven`, `"withheld"` when
     `verdict.withheld` or `messageSourceForgotten(...)`, else the copy check.
  3. Decide parameter order once. lincold2 puts `allowance` FIRST; turnctx has it
     last and optional. Either keep turnctx's order and change lincold2's two
     index.ts call sites and its tests, or move it first everywhere. Do not keep
     both.
  4. Drop lincold2's `lastOwnReply(allowance, ...)` hunk: turnctx replaced that
     function with `lastOwnReplyId` (discovery, no verdict) plus `shownLine`
     (verdict every build).
- Unproven verdicts are not kept: `shownLine` keeps only the reply's message
  id, never a verdict, so an `"unproven"` line is left out of this block and
  asked again on the next turn (Fable P2-2). Nothing else needs changing for
  that.
- turnctx no longer reads `temp.lineage_epoch` or any memory stamp, so
  lincold2's NOTE-only tombstones (Fable P1-2) need nothing here: the judge's
  own dirty-key cache answers each turn.

## index.ts

- Owner turn (turnctx ~9150, lincold2 ~9184): keep turnctx's input
  (`routines: () => routines?.listRoutineNames() ?? []`, `trigger:
  opts?.automationSource`) and add lincold2's allowance in the agreed position.
- Room member turn (turnctx ~13428, lincold2 ~13498): same, keep turnctx's
  `trigger: turnAutomation?.kind` so a scheduled or webhook room turn does no
  work for the block.

## Tests

- `server/working-context-fresh.test.ts` mocks `capturedMessageWithheld` from
  `./memory/replay-lineage.ts`. After the merge, mock `capturedMessageVerdict`
  (or whichever judge `judgeReply` calls) the same way, with the allowance
  argument first.
- lincold2's `working-context.test.ts` edits that only add the allowance to
  calls apply on top of turnctx's file.
