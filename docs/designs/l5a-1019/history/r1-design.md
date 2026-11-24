# D-REDACT-MD-1018 (target 1.0.18), 2026-11-06. Design only, no code. Fresh pass from first principles.
**GROK-LED lane, but grok is NOT available on this host** (`which grok` finds nothing; the run.sh allowlist has no grok tool). Per the brief, Fable wrote the full design alone. GrokBuild and Astra review it next; both must agree.
**Inputs read:** REDACT-MD-REDESIGN-3-1104.md (BLOCK x2), REDACT-MD-SINKS-1104.md (FINAL, shipped), FIX-LEDGER L1469, L1513, L1527, L1536, L1552, L1561, L1566, L1582, L1612; shipped head feat/1018-redact-sinks 344b578a5 (server/redact.ts, shared/md-secret-label.mjs, server/drivers/native.ts, native-md-stream.test.ts, md-secret-label.test.ts, testing/md-secret-label-user-text.base.json, store.ts:829-983, index.ts callers, drivers/pi.ts:204, drivers/acp/core.ts:2200, claude.ts:3220/4774). **feat/1016-redact-md-labels dea23a383 is not in the mirror** (no ref, `unknown revision`); its content is taken from L1513/L1527 (MD_KEY_VALUE rule; dropped after Astra r2 found brackets, double-backtick tail, `«` skip, 1024 cap, next-label leaks). Nothing of it is reused: those five leaks are all value-parsing leaks and this design parses no value.

## 0. The two Highs, and what already holds
- **H-UT, row REDACT-MD-USER-TEXT.** User-visible text keeps the base rule (`redactSecretsInText`, TEXT_RULES = PEM, BEARER, KEY_VALUE, QUERY_KEY, JWT, KEY_PREFIXES, FINANCIAL_ID). None of these sees a markdown-wrapped label: the base fixture (testing/md-secret-label-user-text.base.json, written from b47ece583) shows `**password**: correct(horse)9`, `**token**: data[abcdefghijklmnop]`, `**password**: "alpha1234\nTAILSECRET9"`, `**The password: correct horse**` and 40 more rows returned unchanged. Callers (verified at 344b578a5): store.ts:837 every stored bot message, forever; :829 removedText; :843-846 tool name/summary/spoken/errorDetails; :851-861 routine and goal rows; :866-882 cards and pushBody; :891-983 routine/skill/connector/secret card payloads; index.ts:13971/14026/14087/14169 channel replies through `channelReplyText`; index.ts:9161 error rows, :13122 notifications, :13912-13915 approval summaries, :14321-14323 routine output; inbox.ts:54 `text()` previews; **drivers/pi.ts:204** `piToolErrorDetail` (first line of a failed pi tool result, into the activity row); **drivers/acp/core.ts:2200** Fuigo one-time notice (one stderr line, into the owner's chat). ~40 sites, one function.
- **H-SR, row REDACT-STREAM-RESTART.** native.ts stream state (`pendingStreams`, `latchedStreams`, `latchedOverflow`) is process memory. After a restart a thread's first delta meets no entry, `freshPending` is created, and the delta is scanned with an empty line: a label begun before the restart and finished after it is written unmasked.
- **Already shipped and NOT reopened:** the shared detector `findSecretLabels` (§1 of REDESIGN-3), extent A on every machine sink (`redactSecretsForSink`, `redactSecretsForSinkWalk`, electron `redactSecretsInLine`), the native stream latch with fail-closed truncation, eviction, capacity and the `type: "user"`-only reset (GrokBuild PASS at 344b578a5). This design adds to them and changes none of their outputs (guard rows G1-G3).
- **Pass-3 findings on the user-visible extent, carried as acceptance criteria:** GrokBuild H1 (quote test must read the first non-blank, non-mark character of R, not R[0]); Astra: escaped quote over a line break, blank-value line then a quoted multi-line value, chained empty labels, the 8-line window overflow, and "A for outward delivery". Ruling at L1561: where they differ GrokBuild wins, the split by caller stands, so user-visible text gets ONE extent for every caller (transcript, cards, channels, notifications). This design makes that one extent fail closed on every shape Astra listed, so the outward-delivery concern is met without a second extent (§2.5).

## 1. Principles
1. **Detect by label, never parse a value.** Every pass that parsed a value leaked (L1527 x5, pass 1 8H, pass 2 4H, pass 3 H1). The detector is the shipped `findSecretLabels`; the only question left is the EXTENT of the mask.
2. **Extent follows markdown structure, not line count.** A bot writes a secret either on the label line, in the same paragraph or list item (a quoted or fenced value that wraps), or in the next block when the label stands alone. So the user-visible extent is the label's **block**, plus the next block while the span still holds no value, plus an unclosed quote/backtick span to its closer. No value grammar, no window, no cap.
3. **When context is unknown, mask.** Any state the masker cannot see (a restarted process, an evicted entry, an over-long line) is treated as "inside a secret" until the next prompt. H-SR is closed by the same rule the sinks already use (latch), extended to process start.
4. **One function per audience, no per-caller edits.** The user-visible rule lives inside `redactSecretsInText` so all ~40 sites, including pi.ts:204 and acp/core.ts:2200, change together; the sinks keep calling A first and lose nothing.

## 2. Extent U: `maskSecretLabelsInBlocks(text, mask) -> string` (shared/md-secret-label.mjs, no imports; .d.mts updated)
### 2.1 Structure (per line; a line's *content* is the line without its trailing `\r`)
- `blank(line)`: content is empty or only blanks.
- `fenceOpen(line)`: content, after at most 3 blanks, starts with 3+ backticks or 3+ `~`; that run is the fence. Its close is a later line whose content, after at most 3 blanks, is a run of the same character at least as long, and nothing else but blanks.
- `blockStart(line)`: content, after at most 3 blanks, starts with `-`, `+` or `*` followed by a blank; or `\d{1,9}` then `.` or `)` then a blank; or `>`; or 1-6 `#` then a blank; or `fenceOpen`.
- `block(i)`: lines i..j-1 where j is the first line after i with `blank(j)` or `blockStart(j)`; if line i is `fenceOpen`, the block runs to its closing fence line inclusive, or to the end of the text. `blockEnd` is the index just past the last content character of line j-1 (a trailing `\r` stays outside).
Lists are blocks of their own on purpose: `- **Password**: leave blank\n- **Click** Next\n- **Done**` masks ` leave blank` only. A lazy continuation (indented, or any line that does not start a block) stays inside: `- **Password**: alpha1234\n  TAILSECRET9` is masked whole.

### 2.2 Algorithm (one pass, left to right)
```
pos = 0; out = ""
loop:
  L = first line at or after pos with a wrapped label (findSecretLabels on its content; first wrapped match); none -> out += text[pos:]; return out
  sepEnd = absolute index of that label's sepEnd
  Rend = blockEnd(L)
  // label-only rule: eat the next block while R still holds no value
  while valueless(text[sepEnd:Rend]):
      next = first non-blank line after Rend; none -> Rend = len(text); break
      Rend = blockEnd(next)
  // quote rule (pass-3 H1 fixed): the opener is the first char of R that is not blank, \r, \n, *, ~, _, «, », >, -, +
  v = that char; run = v and its repeats if v is a backtick
  if v in {", '} : closer = same char NOT preceded by `\`
  if v is backtick: closer = a backtick run at least as long as `run`
  if an opener exists and no closer lies in text[v+len(run):Rend]:
      c = first closer after Rend (search to end of text); Rend = c + len(closer) if found else len(text)
  R = text[sepEnd:Rend]
  if R has no non-blank character and Rend == len(text): out += text[pos:]; return out   // nothing after the label, nothing to hide
  if isExactMarker(R.trim()): out += text[pos:Rend]                  // already masked: keep, so f(f(x)) = f(x)
  else out += text[pos:sepEnd] + " " + mask(R)
  pos = Rend                                                          // the rest of a cut line is scanned as a partial line
```
`valueless(span)`: normalize each line of the span as the detector does (marks, lead runs and lone `_` deleted), join, delete every `SECRET_LABEL` match, delete blanks: empty means no value yet. So `**token**:\n**password**:\nhunter2`, `**token**:\n\n**password**: hunter2` and `**password**:` + 9 blank lines + `hunter2` all mask from the FIRST label to past `hunter2`; `**password**:\n- hunter2` and `\n> hunter2` eat the item/quote block; `**Password**: leave blank, then click Next` has a value and stops at its block end.
`mask` is the caller's: redact.ts `mask` (`«redacted N chars»`, N = R.length). The output never ends with the opener's text or a `»` tail: R is replaced whole.

### 2.3 Why each pass-3 shape is now closed
| shape | what U does |
|---|---|
| `: "alpha1234\n\nTAILSECRET9"` (GrokBuild H1: R opens with a blank) | opener found after skipping the blank; no `"` in the block; closer search runs past the blank line; masked to `"` inclusive |
| `"alpha\"\n\nTAILSECRET9"` (Astra: escaped quote over a line break) | `\"` is not a closer; R extends to the final `"` |
| `**password**:\n\n"alpha1234\nTAILSECRET9"` (blank-value line, then quoted multi-line) | label-only rule eats the next block (both lines are one block); masked |
| `**token**:\n**password**:\n\n**api key**:\n\nhunter2` (chained empty labels) | each block is valueless (labels only) until `hunter2`; one mask from the first `:` |
| label + 9 blank lines + value (window overflow) | no window: the next non-blank block, however far |
| `**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret` | lines 1-2 are one block (masked); `- Hint:` starts a new block and is KEPT in user text (known limit U-1, §6); the sink (A) still masks to the end |
| `**password**: ``abcd1234`TAILSECRET9` (unclosed double backtick) | opener run of 2; the single backtick does not close; R runs to the end of the text (fail closed) |
| `**token**: "x «redacted 20 chars» TAIL9xyz"` | R is not exactly one marker: masked whole |

### 2.4 Where it runs
- **TEXT_RULES gains a FIRST entry** `["MD_LABEL", (t) => maskSecretLabelsInBlocks(t, mask)]` (redact.ts). First, so no other rule eats an opening mark or splits R (pass-1 H8); the shape rules then run over its output and see `label: «marker»`, which KEY_VALUE cannot match (`«` is outside its value class) and nothing else touches.
- `redactSecretsInText` keeps its `length < 8` early return (shortest wrapped label with a value, `*token*:x`, is 9).
- **Sinks unchanged in output:** `redactSecretsForSink` = `redactSecretsInText(maskSecretLabelsToEnd(text, sinkMask))`; A leaves either no wrapped label (then U finds none either) or `prefix + label + " " + marker` whose prefix has no wrapped label; U keeps the marker. Rows 1-24 of md-secret-label.test.ts stay exact (guard G1). Electron `redactSecretsInLine` does not import U (G2).
- **native.ts `maskWithTail`** calls `redactSecretsInText` on `tail + raw`; by the split-equivalence test a pending entry's text holds no wrapped label on any complete or partial line (else it latched), so MD_LABEL never fires there and the stream rows 14-18 are byte-identical (guard G3). The builder switches `maskWithTail` to `redactSecretsForSink` anyway (it is a sink) and proves G3 on both.
- **pi.ts:204**: no code change. `piToolErrorDetail` takes the first non-empty line, redacts, folds paths, cuts to 200. U on one line = block of one line; the PI_MASK round trip (`«redacted N chars»` to `«redacted-N-chars»` and back) is the same marker form. Test T3.
- **acp/core.ts:2200**: no code change. The Fuigo notice is one stderr line through `redactSecretsInText(...).trim().slice(0, 1200)`; redact before cut holds. Test T4.
- **Row 24 guard is replaced** (it pinned today's leaks). New: rows K (KEEP) equal the base fixture byte for byte; rows U carry their own expected output (§7).

### 2.5 One extent for every user-visible caller (Astra's "A for outward delivery")
Outward text (channel replies, push bodies, notifications, inbox previews) runs the same `redactSecretsInText`. Under U the only text that survives after a wrapped label and would not under A is text in a LATER block that the label-only and quote rules did not reach: a different list item, the paragraph after a blank line, a heading. Every credential shape this product masks (keys, tokens, JWTs, PEM, quoted or fenced values) is one block or one quoted/fenced span, so U and A agree on all of them; they differ only on prose, which is exactly what the owner's transcript and a channel member's reply must keep (`**Password**: leave blank, then click Next` as the first of five steps). Channel replies also keep their per-channel token scrubs (index.ts:14026/14087) before U.

## 3. H-SR: fail closed at process start (native.ts)
Today a (thread, field) with no entry gets a fresh pending entry on its first delta. New rule, **cold start**: a thread whose FIRST entry written by this process is a stream delta (`streamDelta(msg)` non-null) is treated as a continuation of unknown context: every field of it latches before the delta is masked (`latchStream(key)` then `maskLatched`), and it stays latched until the thread's next `type: "user"` entry, exactly like any other latch (reset rule unchanged: MurageMain 11-03, L1582/L1612).
- State: `seenThreads`, an insertion-ordered Set of thread ids this process has written any protocol entry for (updated on every `appendNative` that is not omitted and not `dir: "lifecycle"`; harness lifecycle rows are not protocol and do not warm a thread; delete+add keeps it LRU). Cap `SEEN_MAX = 65,536`; past it the oldest id is dropped, so a thread seen again with a bare delta is cold again (masked until its next prompt): fail closed, never open.
- A thread whose first entry is anything else (the Claude prompt at claude.ts:3220 is an `out` `type: "user"`; ACP `session/new`/`session/prompt`; Antigravity's request at antigravity.ts:1037; a lifecycle row) is warm and behaves as today.
- Why this closes H-SR: the leak needs a delta continuing a pre-restart line with no prompt in between; after a restart that delta is the thread's first entry in the new process, so it is masked. If a prompt comes first, the stream is a new response and starts a new line (also reset). Engine children die with the server (child-teardown.ts), so in practice the cold path never fires on a live turn; it costs nothing when it does not fire.
- Crash mid-write: `appendNative` masks BEFORE `appendFileSync`, so the file never holds an unmasked prefix; a partial last record is dropped by `capExisting` (invalid NDJSON). No disk state is added.
- Stop: the owner's Stop is a `control_request interrupt` (out), not `type: "user"`; it keeps the latch and the pending line (row 18). The next prompt resets a finished line or latches an unfinished one (shipped narrow latch); the prompt after that resets. Unchanged; tested as a transition (T-S).
- Concurrent turns: state is keyed by (thread, field) and `seenThreads` by thread; a `type: "user"` entry on thread A resets nothing on B; two fields on one thread keep separate lines (row 18 interleaved). Tested as a transition (T-C).

## 4. Module and files
- shared/md-secret-label.mjs: add `maskSecretLabelsInBlocks`; export unchanged otherwise (`findSecretLabels`, `maskSecretLabelsToEnd`, `isExactMarker`, `MD_STREAM_CAP`, `createLabelStream`, `scanLabelDelta`). shared/md-secret-label.d.mts updated. No imports (electron loads this file).
- server/redact.ts: MD_LABEL first in TEXT_RULES; `redactSecretsForSink` unchanged.
- server/drivers/native.ts: `seenThreads`, `SEEN_MAX` (exported for the test), cold branch at the top of `maskStreamField`, `maskWithTail` on the sink rule.
- Tests: server/md-secret-label-user-text.test.ts (new, rows U/K/T3/T4, clock), server/drivers/native-md-stream.test.ts (rows R and T-*), server/md-secret-label.test.ts row 24 replaced by the K guard. All on the gate tier (ci/gate-tests.txt).
- Complexity: U normalizes each line at most twice (detector, valueless) and each closer search consumes the span it scans; linear in the text. Stream: one Set op per entry.

## 5. Copy
No owner-facing strings. The marker stays `«redacted N chars»`.

## 6. Known limits (new rows for MurageMain, all Medium or lower, documented in code)
- **U-1** A bare value split across a block boundary after a non-empty label line (`**password**: alpha\n\nTAIL`, `\n- TAIL`, `\n> TAIL`) keeps the later block in user-visible text. Not a credential shape; the sink masks it (A). Known-shape keys there are still masked by KEY_PREFIXES/JWT.
- **U-2** An unbalanced `'` or `"` or backtick run after a label masks to the next closer anywhere later in the text, or to the end. Fail closed by design; costs prose only when the bot left a quote open.
- **U-3** A label whose value stands alone and is followed only by prose masks that prose block (`**password**:\n\nNext steps...`). Fail closed by design.
- **U-4** Table cells (`| **Password** | hunter2 |`) have no separator and are not labels (pre-existing, not a regression).
- **S-1** An engine that never logs a `type: "user"` entry and whose first entry in a process were a bare delta would stay masked in the native log until restart. No shipped driver does this (prompts/requests are logged first); fail closed if one did.

## 7. Test plan (every row fails on 344b578a5 on an assertion unless marked guard; f(f(x)) = f(x) on every row; `masked` = the secret text is absent and the label is kept; exact rows compare whole strings)
### 7.1 One test per High
| id | High | test |
|---|---|---|
| T1 | H-UT | the whole base fixture corpus through `redactSecretsInText`: no row that contains a wrapped label returns any of its secret pieces (list per row as in md-secret-label.test.ts ROWS), every such row ends in or contains exactly one marker after the label, second pass equal |
| T2 | H-UT, store | `store.append` of a bot message with text `**password**: hunter2\n\nNext step` reads back as `**password**: «redacted 8 chars»\n\nNext step`; a card with pushBody `**token**: abcdef12` masked; `channelReplyText` through the index.ts render closure on the same text masked (one test, three callers) |
| T3 | H-UT pi.ts:204 | `piToolErrorDetail({ result: "**token**: /tmp/sk-abcdefghijklmnop/rest more\nsecond" })` contains no `sk-`, no `rest`, no `/tmp`, exactly one marker in the `«redacted N chars»` form (the PI_MASK round trip restores it); `{ result: "**password**:\nhunter2" }` returns `**password**:` with no `hunter2` (first line only) |
| T4 | H-UT acp/core.ts:2200 | the Fuigo notice splitter fed `Fuigo: **api key**: hunter2secret moved to ~/x` calls `hooks.notice` with no `hunter2secret`, one marker, the path kept |
| T5 | H-SR | fresh native.ts (vi.resetModules) with the thread file ALREADY holding `**password**` from a previous module instance; first entry in the new instance is `: hunter2` as a delta; `raw(t)` has no `hunter2`; then `sendIn` + `clean text` is written |
### 7.2 One test per state transition (native-md-stream.test.ts)
| id | transition | test |
|---|---|---|
| T-X | crash | module A: `**pass`; drop the module (resetModules, no `in`); module B: `word**: hunter2` then 600 chars: nothing after `**pass` in the file but masks; also module B first entry `{type:"user"}` then `hunter2` as clean text: written (a prompt-first restart is warm) |
| T-R | restart | module A latched (`**password**: x` + 70 KiB, ends `«redacted»`); module B: a bare delta `tail hunter2` masked; `sendIn`; `clean` written; the file's two segments concatenate to no `hunter2` |
| T-S | Stop | `**password**: ` then `{dir:"out", msg:{type:"control_request", request:{subtype:"interrupt"}}}` then `hunter2`: masked; then `sendIn` (unfinished line latches), `still hunter2` masked; second `sendIn`, `clean` written |
| T-C | concurrent turn | threads A and B interleaved 1 char at a time: A `**password**: hunter2`, B `plain words`; `sendIn` on B only; A's next delta still masked, B's written; plus A text and A thinking fields split across each other (`**pass` text, `word` thinking, `word**: hunter2` text) |
| T-E | eviction (guard, shipped) | row 15 rerun with `seenThreads` full (`SEEN_MAX` + 1 threads): the evicted thread's next bare delta is masked, its prompt-first turn is clean |
### 7.3 Extent U table (server/md-secret-label-user-text.test.ts, through `redactSecretsInText`)
| # | input (`\n` = line break) | expect |
|---|---|---|
| U1 | `**password**: correct(horse)9`; `**token**: data[abcdefghijklmnop]`; `**token: s3cret.**`; `**password: abcd1234!TAILSECRET.**` | masked, one line |
| U2 | `**password**: abcd«TAILSECRET9`; `**password**: «redacted TAILSECRET9»`; `**password**: «redacted 7 chars»TAILSECRET9`; `**token**: "x «redacted 20 chars» TAIL9xyz"` | masked whole; `**password**: «redacted 8 chars»` kept exact |
| U3 | `**password**: "` + `a`x1100 + ` TAILSECRET9\n\nnext ok`; `**password**: "alpha1234\n\nTAILSECRET9"`; `**password**: "alpha1234\nTAILSECRET9"` | masked; `next ok` masked in the first (quote never closes); third exact `**password**: «redacted 24 chars»` |
| U4 | `**password**: "alpha123\" TAILSECRET9"`; `**password**: "alpha\"\nTAILSECRET9"`; `**password**: "alpha\"\n\nTAILSECRET9"` | masked to the closing quote |
| U5 | ``**password**:`alpha123 TAILSECRET9` ``; `**password**: ``abcd1234`TAILSECRET9`` `` with and without the closer; ```**token**:\n```\nhunter2\n\nmore\n```\nAfter``` | masked; `After` kept in the fence case |
| U6 | `**token**:\n**password**: hunter2`; `**token**:**password**: hunter2`; `**token**: **password**: hunter2`; `**token**:\n\n**password**:\n\n**api key**:\n\nhunter2` | one mask from the first label |
| U7 | `**password**:\n\nhunter2`; `\n- hunter2`; `\n> hunter2`; `\nNote: hunter2`; `\n* hunter2`; `\n1. hunter2`; label + `\n`x9 + `hunter2`; `**password**:\n\n"alpha1234\nTAILSECRET9"` | masked |
| U8 | `**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret` | `x1y2z3`, `abcdefghijklmnop` masked; `- Hint: hunter2secret` kept (U-1, exact) |
| U9 | `the token: note **password**: hunter2secret`; `token: prose; **password**: hunter2`; `**The password: correct horse**`; `**OpenAI API key: hunter2**`; `+ password: correct horse` | masked |
| U10 | `- **Password**: leave blank\n- **Click** Next\n- **Done**`; `**Password**: don't\n\nNext paragraph`; `1. **Token**: paste it\n2. Save` | second and later blocks kept exact; first value masked |
| U11 | LF and CRLF after `:`; `****password****: x9y8z7w6`; `~~**password**~~: x9y8z7w6`; `MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: **x9y8z7w6**`; `*Password*: leave blank`; `` `token`: string ``; `_token=4096`; `**API key**: https://hooks.example.com/T1/abcSECRET` | masked |
| U12 | two labels: `**password**: a1b2c3\n\nprose\n\n**token**: d4e5f6\nmore` | two masks, `prose` kept, exact `**password**: «redacted 7 chars»\n\nprose\n\n**token**: «redacted 12 chars»` |
| U13 | `**password**:` alone, end of text; `**password**: hunter2\nmore\n\nNext` | first unchanged; second exact `**password**: «redacted 13 chars»\n\nNext` |
| K | KEEP, guard, equals the base fixture byte for byte: `the token: leave this prose alone`; `const token = await getToken();`; `use a **strong password** here`; ``the `password` field``; `my_token: x`; `password=hunter2000`; `Authorization: Bearer abcdefghijklmnop`; `api_key: sk-proj-abcdefghijklmnopqrstuv`; `\| **Password** \| hunter2 \|` | unchanged vs base (the last one is U-4) |
| G1 | guard | md-secret-label.test.ts rows 1-23 and 21 exact through `redactSecretsForSink` unchanged after MD_LABEL is added |
| G2 | guard | electron/diagnostics.test.mjs rows 12, 13, 19 unchanged; electron does not import `maskSecretLabelsInBlocks` |
| G3 | guard | native-md-stream rows 14-18 byte-identical before and after (`maskWithTail` on the sink rule) |
| C | clock | U at 64 and 256 KiB: `**password**: alpha1234 ` x n on one line; `**token**:\n` x n; `**password**: "` + `a` x n (no closer); `- **x**: y\n` x n; `«` x n; `a_` x n; backtick x n; 1-char and 20-char stream deltas; ratio under 6, 256 KiB under 250 ms (Hetzner, best of 3) |
| I | idempotence | every U, K and T row: f(f(x)) = f(x) through `redactSecretsInText`, `redactSecretsForSink`, `redactBotAuthored` and `redactSecretsForCard` |

## 8. Out of scope (unchanged rows)
A `Bearer:` colon grammar (REDACT-TAILS-1013); the ACP per-chunk native log (each `agent_message_chunk` is one frame through the sink walk, no tail; pre-existing, not in this row); the live SSE delta to the owner's screen (replies are stored whole through `redactBotAuthored`; the builder confirms with one grep that no per-delta user path bypasses it and files a row if one exists); the 8-case table rows a value split by a block boundary (U-1).
