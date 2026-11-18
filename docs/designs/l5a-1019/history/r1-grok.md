## Findings

### 1. High — H-SR stays open
Design §3. Code: `server/drivers/native.ts:225-239` and `:296-302`; the frames that sit between a split label and its value are `server/drivers/native-md-stream.test.ts:110-155` and `:185-191`.

The cold rule latches only when this process's first protocol entry for the thread is a stream delta, and it latches only the fields on that entry. `seenThreads` then treats the thread as warm. Row 18 already writes non-delta frames in that gap: ping, `content_block_stop`, `tool_progress`, `assistant`, `control_request`.

Sequence A. Process A appends the delta `**pass` (the file contains `**pass`, `pendingStreams` holds the unfinished line). After restart the maps are empty. Process B's first `appendNative` is `{type:"stream_event", event:{type:"ping"}}` (`native-md-stream.test.ts:151`) or `content_block_stop` (`:153`) or `tool_progress` (`:114`). `streamDelta` (`native.ts:243-249`) returns null, so §3 marks the thread warm. The next delta `word**: hunter2` takes `freshPending` (`native.ts:229`) on an empty line. That slice has no wrapped label, `maskWithTail` stores it, and the file reads `**password**: hunter2`.

Sequence B. The restart follows `**pass` on field `text`. The first entry is a thinking delta. §3 latches `thinking` only and records the thread. The following text delta `word**: hunter2` is a warm field with no latch and is stored in the clear.

Sequence C, written into T-X as success. The same crash follows `**pass`. In-process, row 18 (`native-md-stream.test.ts:185-191`) requires a `type:"user"` entry to keep `word**: hunter2` masked, because a tool result is `type:"user"` (`native.ts:298-301`). T-X's second clause says the new process's first entry is `{type:"user"}` and the following `hunter2` is clean text and is written. `resetStreams` (`native.ts:201-206`) finds no pending line. The continuation is stored.

T5 and T-R start the new process on the continuation delta itself. §3 also says `seenThreads` is updated on every `appendNative`, while the cold branch is at the top of `maskStreamField`. `appendNative` classifies the entry (`native.ts:301`) before `maskStreamDelta` (`:302`). An update at that classification site puts the thread in the set before the cold check, so T5's first delta `: hunter2` is warm and is written.

### 2. High — the Stop transition contradicts the reset §3 says to leave unchanged
Design §3 Stop and test T-S. Code: `shared/md-secret-label.mjs:150-152`; `server/drivers/native.ts:181-186`, `:201-206`, `:235-238`. Ledger L1567 and L1612. Guard G3 is `native-md-stream.test.ts:157-164`.

Sequence. A delta `**password**: ` (no newline) hits `if (st.d >= 0) return sepEnd` (`md-secret-label.mjs:152`). `maskStreamField` calls `latchStream` (`native.ts:237-238`), which deletes the pending entry. Stop logs `{dir:"out", msg:{type:"control_request", request:{subtype:"interrupt"}}}`. That is not `type:"user"`, so the latch holds and `hunter2` is masked. The next prompt is `type:"user"`. `resetStreams` sees a latched key, deletes it, and calls `freshPending` (`native.ts:205`). The pending-unfinished branch (`:204`) does not run. The delta `still hunter2` is a new empty line and is written. T-S expects that delta to stay masked until a second `sendIn`.

Holding that latch across the first `type:"user"` also holds the finished latch in row 18 (`native-md-stream.test.ts:157-164`): `**password**: x\n`, then `hunter2` masked, then `sendIn`, then `clean text` written. G3 requires those rows byte-identical, and L1612 confirms that reset. T-S and G3 cannot both pass on the code §3 says is unchanged.

### 3. High — the live reply never enters `redactSecretsInText`
Design §0 H-UT, §2.4, and §8. Code: `server/drivers/claude.ts:4966-4971`; `server/drivers/pi.ts:1019` and `:1232-1238`; `server/drivers/acp/core.ts:4156-4158` and `:4172-4176`; `server/index.ts:8683-8686` and `:8781`; `server/runtime-event-out.ts:80-84`; `src/state/store.tsx:6418-6422`; `src/components/ChatView.tsx:1674`.

Sequence. The model streams `**password**: hunter2`. `claude.ts:4969` emits `content.delta` with `delta: d.text`. `pi.ts:1019` and `acp/core.ts:4158` emit the raw chunk the same way (`acp/core.ts:4156` marks it live-only). None of these drivers call `redactSecretsInText` on that path. `foldRuntimeEvent` broadcasts the event (`index.ts:8781`). `windowRuntimeEvent` returns a `content.delta` unchanged (`runtime-event-out.ts:84`). The only edit of the delta is the room speaker guard (`index.ts:8683-8685`). The client appends `event.delta` (`store.tsx:6422`) and ChatView paints it (`ChatView.tsx:1674`). The secret is on screen for the turn. The settled row later goes through `redactBotAuthored` (`store.ts:890`). `clearStream` (`store.tsx:4868-4876`) drops the bubble when the turn completes, after the text has already been shown.

§8 assigns the builder a grep and a follow-up row. The path is the chat bubble. Extent U inside `TEXT_RULES` does not run on it. Calling U on each delta still shows `**pass` before `word**: hunter2` completes a label, which is the split H-SR exists for.

### 4. Medium — T4's oracle fights the block mask
Design §2.2 and §7.1 T4. The Fuigo notice is `server/drivers/acp/core.ts:2237-2240`. Line 2200 is `openRequests`.

`Fuigo: **api key**: hunter2secret moved to ~/x` is one block. R is ` hunter2secret moved to ~/x`, and §2.2 replaces that whole span. T4 expects `~/x` kept. A passing test has to cut the value at a token boundary. That is value parsing, which §1 rules out and which ledger L1527 dropped after it leaked.

### 5. Medium — U13's exact string does not match §2.2
Design §2.2 and §7.3 U13, next to U12 and T2. `sepEnd` is the index after `:` (`shared/md-secret-label.mjs:45-56`), so the space after the colon is inside R, and the algorithm writes one more space before the marker. `blockEnd` stops on the last content character, so the line break after the block stays outside R. ` hunter2\nmore` is 12 characters. U13 expects `«redacted 13 chars»` and still `\n\nNext`. Counting that newline into R yields 13 and leaves one `\n` before `Next`. U12 (` a1b2c3` = 7, ` d4e5f6\nmore` = 12) and T2 (` hunter2` = 8) match the 12-character reading. The exact U13 compare fails either way.

U-1 through U-4 and S-1 match this algorithm and stay at the severities §6 gives them. In-process, a Stop with no following `type:"user"` keeps the latch (`native.ts:301`). Two threads use separate keys (`native.ts:178`). Masking runs before `appendFileSync` (`native.ts:302`, `:314`). `piToolErrorDetail` is `server/drivers/pi.ts:227-234` (one trimmed line, redact, path fold, slice 200). A wrapped label on that line is one block.

| Item | Status |
|---|---|
| H-UT stored text via `redactSecretsInText` | in progress: extent U is coherent; live bubble is open (finding 3) |
| H-UT `pi.ts` detail and ACP notice | done: one-line sinks follow U; T4 oracle is wrong (finding 4) |
| H-SR cold start | pending: rule and T-X/T5 do not close it (finding 1) |
| Crash mid-write | done: mask before `appendFileSync` |
| Restart | pending: same hole as H-SR |
| Stop | pending: T-S vs L1612 / row 18 (finding 2) |
| Concurrent turns | done: per-thread keys, T-C matches |
| U13 exact oracle | pending: finding 5 |
| Resources created | none |

Rewrite §3 so a `(thread, field)` with no in-process line stays masked through the first `type:"user"` this process sees (that entry latches; the next one resets), including when the first entry is a ping, a block stop, a tool result, or a delta on another field. Put `content.delta` in the design before calling H-UT closed. Point T-S at the latched-at-separator behavior row 18 already locks, and point T4 and U13 at the block mask.

VERDICT: BLOCK
