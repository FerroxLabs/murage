# q1024-memgate: real-data memory gate (rig sources)

Owners: rig, verdict, kit step 05m = lane q1024-memgate; the fix it gates = lane q1024-memsave; Sean's store snapshot, rulings, waivers = MAIN.
The live copies run from `_small/` on the build host (`_small/memgate.sh`, `_small/bannergate-rig/memgate-1024.test.ts`, `_small/kit-publish-1024/05m-memgate.sh`);
these are reviewable copies. The test is named `.rig.ts` so no CI tier picks it up: it needs the private store copy and runs only inside `memgate.sh`.

## What it does
On a COPY of the owner's real store (never the live one), in a `--network none` container, with start-up background work running (no settle wait after listen):
1. START 1: memory turned on through the Settings call (`POST /api/memory/action configure active`), the owner's busiest real bot raised to no-limits, one real engine turn (fake engine executable, real server, real mounted MCP shim).
2. While that turn is held, the 3 saves go through the mounted `memory_save` tool (fixture tool mailbox of the fake engine, as server/memory/field-replay/harness.ts): one attempt each; any refusal fails the gate.
3. Recall of each fact through the mounted `memory_search` until FULL search answers (hit, not partial, no keyword recallMode, nothing missed) within 30 s; each call within 5 s.
4. Turn released: the scripted engine reads the search results back and answers by quoting them, so the bot's ACTUAL ANSWER must state all 3 saved facts (3/3), 0 approval cards, 0 own-write hold lines. SIGTERM, START 2 on the same store, a new held turn, the same 3 searches.
Verdict line (counts and codes only): `MEMGATE-1024 <sha10> PASS|FAIL saved=a/3 refused=n cards=n recall1=a/3 recall2=a/3 keywordFirst=n maxSearchMs=n pendingCaptureAtSave=n [fails=...]`.

## DECISIONS (fail-closed, MAIN need not answer)
- D1 zero refusals means the FIRST attempt: a save that succeeds only after a retry is a FAIL (the retry loop only measures how long it keeps refusing).
- D2 "full search" is waited for up to 30 s after a save and after a start (the word index may still be warming); `keywordFirst` reports how many first searches were still keyword. Never-full inside the window = FAIL.
- D3 the bot is raised to no-limits (Sean's setup) so a held own-write card is a defect, not the expected path. `MG_NO_RAISE=1` (rig self-test) leaves the default level and must turn the gate FAIL with approval-card + own-write-hold-lines + turn not completed.
- D6 (MAIN memsweep J, RULINGS.md) the `turn dispatch recall=` log line is recorded but NOT gated; the gate is the bot's answer containing the saved facts plus the search outcomes.
- D4 `BG_SYNTH=1` runs the rig on a store it makes itself; never a gate result.
- D5 no local embedding model exists in the container, so "full" there means the lexical path answered (`degraded=local-model-unavailable` is not a failure); keyword fallback / MEMORY_RECALL_* partial is.

## CHECKLIST (requirement -> file:line, entry point = production route/tool)
| requirement | where | entry point |
|---|---|---|
| real engine turn on the data copy, start-up work running | memgate-1024.rig.ts:216-229 (no settle wait, pendingCapture counted) | POST /api/bots/:id/messages |
| 3 saves via the bot's own save tool, zero refusals | memgate-1024.rig.ts:230-247, verdict `save-refused` memgate-verdict.py:12 | mounted memory_save over the engine MCP shim |
| no approval card | rig.ts:133, verdict.py:16 | transcript rows |
| the bot's answer contains the saved facts (turn 1 and after restart) | rig.ts waitReply answerFacts, verdict.py `turnN-answer-facts` | scripted engine quoting the real memory_search results |
| no turn stop / own-write hold abort | rig.ts:249-252, verdict.py:17-20 | held turn must end with its reply |
| recall by FULL search within budget | rig.ts:98-123 (recall loop), verdict.py:27-30 | mounted memory_search |
| again after a restart | rig.ts:254-267, verdict.py:27,32 | START 2 same store |
| FAILS on dev/1024 33ca3f5410 | MEMGATE-1024 board lines (real store: save-refused CAPTURE_PENDING=3) | memgate.sh 33ca3f5410 |
| kit step 05m | 05m-memgate.sh, run-all.sh loop + HARD GATE, 00-preflight.sh | kit-publish-1024 |
| MG_NO_RAISE=1 on the REAL store copy, base 33ca3f5410: approval-card=1, turn1-not-completed, save MAILBOX_TIMEOUT x3 (own-write hold) | MEMGATE-1024 run 33ca3f5410-20261127T211249Z | memgate.sh |
| recall after the 30 s window fails | memgate-verdict.py `full-after-deadline`, selfcheck case `late` | verdict |
| receipts (machine-checked) | receipts.py -> receipts.tsv, RECEIPT-CHECK PASS 11/11 | memgate-selfcheck.py |

## Known findings the gate reports (not gate defects)
- Real store, base 33ca3f5410: 3/3 saves refused with "Source capture is still pending" (23076 capture jobs queued); recall finds 0/3 (keyword fallback / MEMORY_RECALL_UNAVAILABLE).
- Real store, fix/1024-q1024-memsave-fable 2844c3997d: saves refused on the first call with the mounted memory server closing its output (MCP_SERVER_CLOSED); the synthetic store PASSes. Cause not diagnosed here (MAIN rulings F/I class: a memory route error must never close the mount).
- Synthetic store (BG_SYNTH=1) prints SYNTH-PASS, never PASS; 05m accepts only `PASS store=real`.
