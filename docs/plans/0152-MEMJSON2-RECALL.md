# MEMJSON2 — recall quality after the remembered-context framing change

Lane MEMJSON2, 2026-09-11. MEMJSON1 verifier finding 4: re-measure native
recall quality cheaply after the framing change (attributed remembered lines
instead of provenance JSON; MEMJSON2 adds a turn-local handle per line and
keeps the dispatching message's own chunk out of recall).

## 1. Non-paid retrieval eval (`scripts/eval-memory.ts`, local model, no provider calls)

Same frozen corpus (`server/memory/testing/corpus.json`, sha256 `7dc0a4d0690c…`),
same pinned local model (`Xenova/paraphrase-multilingual-MiniLM-L12-v2` @ `2c4055b1`),
same machine, run back to back. "Before" ran in the untouched MEMJSON1 worktree
(memory sources identical to `ef23d4a2`); "after" ran in this lane's worktree.

| run | status | cases | recall@10 | final evidence precision | no-answer abstention | emitted evidence | pins | error cases |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| before (ef23d4a2, MEMJSON1 worktree) | BLOCKED | 240 | 0.9875 | 1 | 0.9875 | 158 | 40/40 | private-13, language-13, long-28 |
| after (lane/0152-MEMJSON2) | ACCEPTED | 240 | 1 | 1 | 1 | 160 | 40/40 | — |

Per family (recall@10 / precision): exact-paraphrase 1/1 → 1/1, temporal-corrections
1/1 → 1/1, long-history 0.975/1 → 1/1, privacy –/1 → –/1, multilingual 0.975/1 → 1/1,
no-answer-negation –/1 → –/1. Exact-baseline regressions: none in either run.

Per-case comparison (delivered source set + score): **237/237 comparable cases
identical, no drops, no other differences.** The three "before" error cases are
`MEMORY_QUERY_DEADLINE` (the 500 ms search deadline) hit while the shared Mac was
at load average ~40–50 with eight lanes running; they did not recur in the
"after" run (load ~27–32) and are a load artefact, not a framing effect. The
framing change touches only the rendered text (a handle prefix per line, one
extra preamble sentence), which enters the byte budget; no case moved across
the budget boundary.

## 2. Paid native case (≤ 5 turns, FluxRouter gate key)

`src/e2e/memory-provenance-fuigo.human.spec.ts` (the MEMJSON1 real-app proof)
with `MURAGE_MEMJSON1_TURNS=5`, the bundled Fuigo 1.0.12 on Flux Auto through
FluxRouter (`~/.murage-gates/flux-customer.key`, added through the app), Vite
dev renderer, isolated harness on the lane ports:

- 5/5 turns answered in the expected form (`pong`, `4`, `pong`, `Paris`, `pong`); incidents: 0.
- 5 Fuigo `chat_history.jsonl` files, 5 prompts recorded, 5 carrying `<remembered-context>`; no provenance token in any prompt or reply.
- Every remembered line carries its handle in frame order (`m1 (earlier assistant inference; checkpoint) …`, `m1 (the owner said; source) …`).
- The own-chunk exclusion is visible in the real app: turn 5 (the third "pong" request) remembers exactly two owner "Reply with exactly the single word: pong" lines (turns 1 and 3); before MEMJSON2 the same turn of the MEMJSON1 run remembered its own request as well (evidence-MEMJSON1 `fuigo-chat_history-10.jsonl`: five copies for the fifth request).

Cost: five short Flux Auto turns. Evidence (prompts, replies, screenshot,
`turns.json`) is in the lane's scratchpad `evidence-MEMJSON2/`; the spec copies
it there on every run and is the way to reproduce.

## Verdict

No recall drop after the framing change on the non-paid eval (identical
delivered sets on every comparable case; the "after" run is the first ACCEPTED
run of the pair) and the five-turn native case answers normally with the new
frame. Nothing further is deferred.
