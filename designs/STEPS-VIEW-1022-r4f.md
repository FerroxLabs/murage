# STEPS VIEW r4f: the step chain is today's tool rows, drawn better (target 1.0.22)
Owners. SERVER side (the `tool.step` field, the labeler, `step_detail`, the detail route): the steps-view build lane (feat/1022-steps-view, successor of PARTIAL 9c156c2fad). CLIENT side (StepsGroup, panes, settings words, locales): the same build lane. Contract between them: §3 (the row field) and §6 (the route). ACP emitter side (Fuigo F1-F18): the Fuigo coordinator, Fuigo 1.0.48, after 1.0.22; nothing here needs it (§8). Design owner: steps-redesign-fable. Read at hub dev/1022 **6d4b5932a8** (line numbers are that sha's) and build **9c156c2fad**. Written under MAIN-RULING 2026-11-23T05:55:19Z: a fresh, smaller design; r3.1 (`STEPS-VIEW-1022.md`) is reference only and this file replaces it for the builder. Binding inputs: Sean's addendum (collapsed live header, verb + bold object rows, narration rows, red Failed, tense), the UX bar, GAP-CHECK-BAR, JOINT RULING STOP-VS-REFUSAL, MAIN-RULING 2026-11-21T14:59Z (today's Fuigo emits).

**PURPOSE.** While a bot works, the owner can tell at a glance what it is doing, which step it is on and what happened, in plain words. One click on a step shows what was run and what came back.

**USER PROMISES.**
- P1 One live line. A working turn shows one header: what the bot is doing now and for how long, or "Waiting for your OK".
- P2 Plain rows. One row per tool call: present tense while it runs, past tense after. "Failed" is red, "Not allowed" is grey, and the chain carries on. A row never says less than what happened.
- P3 One click. A row opens to its Request and its Response.
- P4 Exactly once. One call is one row. Two identical calls are two rows.
- P5 No secrets, and gone with the chat. Secrets are masked before anything is stored. Step output is deleted with its chat, in the same commit.
- P6 Smooth and bounded. A 500+ step turn stays smooth; disk use has a cap.
- P7 Nothing new asks. No new prompt, card or approval anywhere.
- P8 Everywhere. Direct chats, rooms, tasks, old chats, all engines, Dark and Light, desktop and phone, eight languages.

## 1. The one idea
dev/1022 already keeps **one transcript row per tool call**: `item.started` pushes one `kind:"activity"` message with a server-minted id (`server/index.ts:13583-13632`), `item.completed` patches that same message (`:13551-13565`), turn end marks rows still open as `unrecorded` (`store.markTurnToolsUnrecorded`, `server/store.ts:3794`, both callers `index.ts:3504` and `:13815`), and the row is deleted with its chat (`message-db.ts:1633`). It is paged, synced to the desktop and phone, projected per audience and restored from backups by code that ships today.

r2 to r3.1 built a second system beside it (StepLog rows, group rows, a sidecar file, frames, a snapshot protocol, epochs, a search feed, a live tail, a Stop hold). Every open High lives in that second system. **r4f has no second system.** A step is the tool row. 1.0.22 adds exactly four things:
1. one small field on the row, `tool.step` (§3);
2. one table in the same database, `step_detail`, removed by a trigger (§5);
3. one owner-only route for a detail (§6);
4. one client component, StepsGroup, that draws a turn's tool rows as the chain (§4).

**Not in 1.0.22** (each removal closes a High, §9): no `turn_steps` / `turn_step_groups` tables, no `step-details.db`, no `step.upsert` / `stepgroup.upsert` / `step.output` frames, no snapshot or paging route, no epoch, no step search text, no live output tail, no `stopped` or "Stopping…" step state, no child groups, no content-key ask matching, no shell-command classifier, no provisional rows.

## 2. Duplicate lines (P4)
The doubled lines came from a second writer: one string per accepted **ask** in `tool.steps[]`, drawn beside the per-call chips. The build already removed the per-ask writers (`full-access-steps.ts` deleted in 9c156c2fad); that stays. After it, the only writer of a row is `item.started`.
- **Replayed start.** Today `item.started` always pushes a new message. Change: when `toolMessageByItem` already holds an open row for `threadId:itemId` in the same turn, the start **patches** that row (label fields only) and pushes nothing. ACP `tool_call_update` refinements use the same path (§8).
- **An ask never creates a row.** §3.2.
- Witnesses, each through the real fold on a booted server with the fake engine CLIs: two identical Bash calls with different ids → 2 rows; one call with a hook ask and a CLI ask → 1 row; a replayed `started` → 1 row; No limits turn with 5 calls → 5 rows and no `tool.steps`. The build's first task is still the broker-level capture on the real Claude CLI (one Bash, one Read, under No limits), quoted in DONE, so the cause of Sean's screenshot is named, not assumed.

## 3. The row field
```ts
// on the existing Message.tool of a kind:"activity" row; every part optional; old rows have none
step?: {
  k: StepKind;                 // label key: command read write edit delete search list web_search web_fetch app skill helper question memory browser computer phone other
  object?: string;             // <= 96 bytes, masked (§7); absent on a masked turn
  app?: string;                // <= 32 bytes, connected-app display name
  state?: "waiting" | "denied";            // only these two; everything else is derived (§3.1)
  waitingFor?: "ok" | "answer";
  deniedBy?: "owner" | "rule" | "no-answer" | "refused";
  approval?: "no-limits" | "full-access" | "owner" | "rule";
  autoTurn?: true;             // §4.5
  endedAt?: number; waitMs?: number;       // start is the message's own time
  exit?: number; timedOut?: true;
  d?: 1;                       // a detail was written (§5)
}
```
The field holds enums, numbers and two short masked strings. It adds at most 300 bytes to a row. `tool.name`, `summary`, `spoken`, `ok` and `unrecorded` are written exactly as today, so an older client, a v1.0.20 rollback, the sidebar line, voice and search see what they see today.

### 3.1 Status is derived, with one rule per state
| Shown | From | Words |
|---|---|---|
| Running | `ok` undefined, not `unrecorded`, no `state`, **and its turn is the thread's live turn** | present tense, dots |
| Waiting | `state:"waiting"` and the turn is live | "Wants to …", amber, "Waiting for your OK" / "Waiting for your answer" |
| Done | `ok === true` | past tense, duration when 2 s or more |
| Failed | `ok === false` | past tense, red "Failed" |
| Not allowed | `state:"denied"` | "Wanted to …", grey "Not allowed" |
| Didn't finish | `unrecorded`, **or** an open row whose turn is not live | past tense, grey "Didn't finish" |

- **No stuck spinner, by construction.** A row can only look live while its turn is live. After a crash, a restart, a restore or a missed turn end, an open row reads "Didn't finish" without any recovery job.
- **Turn end needs no new code.** `markTurnToolsUnrecorded` already settles open rows at both of its call sites. A `waiting` row left at turn end is `unrecorded`, and `unrecorded` wins over `state`.
- **Stop is not a step state.** A row never says "Stopped" and the header never says "Stopping…". Whether a turn was stopped, refused or timed out is said once, by the transcript's existing Stop line, refusal row or error card, which are untouched and already follow the JOINT RULING. Steps read no Stop fact, no `confirmedStopGenerations`, no `terminalOutcome`, no `directRun`. So no row can be held, flipped later, or disagree with a refusal row, in a direct chat or a room, on any Stop exit.
- **Failed** is the engine's explicit error. The drivers also report failure for a non-zero exit code, a signal or a timeout when the engine gives those as structured fields, whatever its status word says (ACP `rawOutput.exit_code` / `timed_out`; Codex `exitCode`; Claude's `is_error`). Never from English text.
- **Not allowed** is set only from Murage's own decision for that call id (§3.2) or from structured engine evidence that the call did not run (Claude `system/permission_denied` for that `tool_use_id`; Codex item status `declined`). The engine's later error result does not turn it red.

### 3.2 Asks: exact call id or nothing
`handleDecisionRequest` knows the ask's call id when the engine sent one (Claude `tool_use_id`, Codex `itemId`, ACP `toolCall.toolCallId`, Murage's own call counter on API engines).
- **With an id whose row is open:** card opened → patch `state:"waiting"`, `waitingFor`; answered Allow → clear `state`, add the card's time to `waitMs`, set `approval`; refused → `state:"denied"`, `deniedBy`. A second card for the same row keeps it waiting until every card for that id is closed (a set of request ids per row, in memory, dropped at turn end).
- **With an id and no row yet:** the outcome is kept in a per-turn map (at most 256 entries) and applied when that id's `item.started` arrives. If the item never arrives, nothing is drawn as a step; the card and the decision log already record it.
- **Without an id:** it marks no row. **No content key, no FIFO, no "oldest open row".** Two identical calls can never share or swap an ask.
- **The header does not depend on attribution.** "Waiting for your OK" is driven by the thread's open cards (the state the approval panel already has), so it is right even when an ask marked no row.
- Cards, the approval panel and question cards stay where they are, outside the group. Nothing new asks (P7).
- Witnesses (real fold, fake CLIs): ask with id → the row waits, then runs, `waitMs` > 0; Don't allow → "Not allowed", never red, and the engine's error result after it leaves it grey; two identical parallel calls with ids, one refused → exactly that one is "Not allowed"; ask before item → applied on start; ask with no id while two identical calls are open → both rows unchanged, header waits; a hook ask and a CLI ask for one id → one row, waiting until both close.

## 4. The view
### 4.1 Grouping
StepsGroup replaces the "Worked for" fold, `ApprovedStepsRow`, the tool `ActivityChip` and `RoomToolChip` in ChatView **and** GroupView. A group is what `src/lib/activity-runs.ts` already calls a run: consecutive tool rows of one turn, broken by a bot text bubble. Notices (`tool.notice`), cards, comm chips and done-when lines are never in a group, as today.
- **Narration rows (Sean's addendum).** A bot text row inside a turn that is one line, at most 160 characters, and has a tool row after it in the same turn does not break the run; it is drawn as a grey note row in the list. Display only: the message is stored and synced as the text it is. If the turn ends and that note was the bot's last text, it is drawn as a normal bubble. Under Steps: Off nothing is folded.
- The group is built from rows the transcript has loaded. No step is fetched separately.

### 4.2 The header (collapsed is the default)
```
[dots] Running commands · step 12 · 1m 12s                      [›]
       Reading report.md
```
- Live: the dots, the **phase** (group form of the newest open row's kind: "Running commands", "Reading files", "Editing files", "Searching", "Searching the web", "Working in Gmail", "Using the browser", "Working"; "Thinking" when no row is open), "step N", the turn's working time, a chevron. Line 2 is the newest row's own text or the newest note, one line, only while collapsed.
- **One clock.** The header uses the turn's existing working timer. While a group is live in a turn, `TurnPresence` hides its label and timer (the mascot stays), the `LiveThinking` chip is not drawn (the phase says "Thinking"), and `HelpersLine` hides its timer. `LivePlanCard` and the helper lines are otherwise unchanged in 1.0.22.
- Waiting: a steady amber pause icon, "Waiting for your OK" or "Waiting for your answer", no clock; line 2 says what is asked ("Wants to delete **old-exports**") when a row is marked, else nothing.
- Finished: "Worked for 5m 35s · 27 steps", plus "· 1 failed" in the danger colour, "· 1 not allowed" and "· 2 didn't finish" in grey. The time is last end minus first start minus the rows' `waitMs`. Any Stop wording stays what today's fold already derives from the transcript's Stop note.
- **Never a wrong number.** Count and time are shown only when the group's first row is known to be loaded (the row before it is loaded, or the transcript start is reached). Otherwise the header reads "Worked" and fills in as the page loads.

### 4.3 The open list
`[icon] Verb **object**   status-or-duration [›]`, one row per call, in order, one lucide icon per kind, status always a word. A live list shows the newest 12 rows under "Show N earlier steps"; a finished list shows the first 30 and "Show N more steps"; at most 60 rows are mounted before the owner asks for more. No scroller inside the chat. Old rows with no `step` field (before 1.0.22) are drawn by the same component with `tool.name` as their text and no chevron; an old `tool.steps[]` row keeps its stored lines under "Approved 27 steps", as today. No stored data is rewritten.

### 4.4 Labels: one table, no classifier
`shared/step-label.ts` (built; keep the table and the tense forms; words move to the eight locale files with `{object}` and `{app}` placeholders, bold made by splitting at the placeholder).
- The server picks `k` and `object` at `item.started`, the same place and inputs `narrateTool` uses today (tool kind, tool name, structured input). Order: engine structure (a command field; Codex item type; ACP `kind`), then the tool name's tail after the last `__` in the built-in table, then a real third-party app ("Used **Gmail**: fetch emails"), then "Used a tool".
- Objects: a file's basename; a search pattern cut to 40 characters; a web **host only** (never a path or query); an app action's display name.
- **Commands are never classified.** A command row reads "Running a command" / "Ran a command". Its object is the **whole** masked command, and only when that command is one line and at most 48 bytes; otherwise the row has no object. Nothing is cut and nothing is summarised, so the row cannot claim a read for a command that also wrote (P2). The command is always one click away in the terminal pane.
- An ACP `title` is never a label. A row never shows JSON or an id.

### 4.5 No limits line
The detail footer of a row says how it was allowed, from `approval`: "Ran without asking (No limits)", "You approved this", "Allowed by your rule". A finished turn's last group ends with one line when any of the turn's rows has an automatic `approval` or `autoTurn`: **"No limits: steps in this turn ran without asking you."** ("Full access: …" likewise), linking to Settings → Access. It has **no numbers**, so it can never miscount. An automatic answer that matched no row sets `autoTurn` on the turn's newest tool row; a turn with no tool row shows no line (the decision log has the ask). Under Steps: Off this line still shows after the turn's last chip, so the trace owners have today is not lost.

### 4.6 Settings
The built three-way control stays: Steps **Collapsed** (default) / Expanded / Off. Off draws today's chips and folds nothing. "Step details kept" (§5) is the one other control. Phone: the same component over the same synced rows; the pane opens full width.

## 5. Step details: one table in `messages.db`
```sql
CREATE TABLE IF NOT EXISTS step_detail(
  thread_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL,
  body TEXT NOT NULL,                      -- JSON: { tool, request, response?, exit?, withheld? }, already masked and cut
  PRIMARY KEY(thread_id, message_id));
CREATE INDEX IF NOT EXISTS step_detail_at ON step_detail(at);
CREATE TRIGGER IF NOT EXISTS step_detail_gone AFTER DELETE ON messages
  BEGIN DELETE FROM step_detail WHERE thread_id = OLD.thread_id AND message_id = OLD.id; END;
```
- **Same file, same transaction, every delete path.** The table lives in `messages.db`, which already has `secure_delete=ON` (`database.ts:324`) and the post-delete WAL scrub (`conversation-deletion.ts:772`). The trigger fires inside whatever statement deletes the message row, so the nested chat-delete funnel (`store.ts:2977` → `message-db.ts:1625-1633`), the boot deletion triage and any later delete site remove the detail in the **same** transaction: commit removes both, rollback restores both. There is no sidecar, no hook to place, no order to get wrong and no scrub obligation to carry across BUSY or a restart.
- **A rewrite keeps it, a delete removes it.** A row patch must not drop its detail: SQLite does not fire a DELETE trigger for a `REPLACE` while `recursive_triggers` is off (the repo relies on this, `memory/recall-view-races.test.ts:81`), and the builder states in DONE which statement the message writer uses. `mdb.deleteThread` also runs `DELETE FROM step_detail WHERE thread_id=?` in its transaction, so the chat delete does not rest on the trigger alone. Witness: a row patched three times still opens to its detail; a deleted row's detail is gone.
- **A write cannot outlive its chat.** The write is one statement, `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM messages WHERE thread_id=? AND id=?)` (the update at step end has the same guard). A turn finishing during or after a delete writes nothing. No fence or epoch is needed.
- **When.** The masked request is written at step start (so a running or waiting step opens to its Request); the masked response is merged at step end. Writes go through one in-process queue after the row patch and never block the fold; pending text is capped at 16 MB per process, beyond which that step's body is `withheld:"not-kept"`. A lost write (crash) leaves a row that opens to "Details weren't kept".
- **Sizes.** Request kept to 8 KB. Response kept as the first 4 KB and the last 12 KB, cut on line boundaries, **after** masking (§7). One turn keeps at most 2 MB; later steps keep their row and read "Output not kept: this turn is very large".
- **Global cap.** "Step details kept": 100 MB by default (50 MB to 1 GB, or Off). A running total of `bytes`; past the cap the oldest rows by `at` are deleted in batches of 64, off the turn's path. The row stays and opens to "Details weren't kept". Off writes nothing and deletes what is there, in batches.
- **Lifecycle registration.** `step_detail`, its index and its trigger are added to the schema additions, the v1.0.20 downgrade drop list (`installation-app-schema-downgrade.ts`) and `ADDED_TABLE_LIFECYCLE` as a trigger-removed table. After a rollback to v1.0.20 the table is gone and the unknown `tool.step` key is ignored; on upgrade again the table is recreated empty.
- **Backups.** A backup of `messages.db` carries the details with the chat they belong to and a restore brings back both, consistently, because they are one file; the cap bounds what that adds. No other artefact reads the table: export, phone and Cloud sync, sealed mailbox rows, diagnostics, feedback and logs take nothing from `step_detail`, and step text is never written to a log line.
- Witnesses: (1) delete a chat, a room, a task and a bot through their HTTP routes, and finish a marked delete at boot: 0 `step_detail` rows for the thread and a canary string absent from the db and WAL bytes after the existing scrub; (2) force the outer transaction at `store.ts:2977` to roll back: messages **and** details both still there; (3) a turn completing after its chat was deleted writes 0 rows; (4) the cap at N = 10 and N = 1000 details: total ≤ cap after the batch, statements per write constant; (5) rollback to v1.0.20 then upgrade: boots, chats read, table empty; (6) a canary in a tool output is found in the backup's `messages.db` only, and in none of: export, phone sync payload, diagnostics bundle, feedback payload, server log.

## 6. The detail route
`GET /api/threads/:threadId/steps/:messageId/detail` → `{ tool, request, response?, exit?, withheld? }`.
- Route class `companion` (the desktop, or the phone's forwarded launch proof) **and** current access to that thread, both checked on every request. Door, MCP, Cloud-scoped and bot callers get no step route. `:messageId` is a server-minted message id and is only ever a bound SQL parameter. Engine ids are never a key, a file name or a route segment; they live only in the per-turn `toolMessageByItem` map that exists today.
- A missing row is 200 with `withheld:"not-kept"`, never an error page. A masked turn has no detail (`withheld:"masked-turn"`).
- Panes, using the app's shared code block: **command** → `$ <masked command>` then the output, last 12 lines first, "Show all"; "Exit code 1" or "Timed out" in the footer. **edit / write** → a unified diff per file from the old and new text the engine gave. **everything else** → Request (JSON) and Response (text). Running or waiting → the Request and "Output appears when the step finishes". Copy copies the masked text.
- There is no other step route and no step frame. Rows reach every client through the transcript sync that carries tool rows today.

## 7. Privacy (P5)
- **Order, always:** (1) if the turn is audience-masked (`bus.audienceMaskedFor`, `index.ts:13334`), nothing is built: no `object`, no `app`, no detail; (2) each string value is scanned on its own with the reply text's composite scan (`scanTurnText`) plus the step rules in `step-redact.ts` (built: `-u user:pw` and `user:pw@host`; to add, each with a witness: cookie header values, secret URL query values, `--password` / `-p<pw>`, `NAME=value` for secret-like names); (3) hits are masked; (4) only then is the text cut to its kept size; (5) only then is it stored. A cut never runs before the scan, so a secret cannot be split by the cut and kept.
- **Bounded scan.** Text over 1 MiB, or binary, is not scanned and not kept (`withheld:"too-large-to-check"` / `"binary"`). No rule may backtrack on a long run; witness: 1 MiB of `a-a-a-…` is handled in under 50 ms.
- **No streaming scanner exists**, because no partial output is ever shown or sent: the response is scanned once, whole, at step end.
- **Typed text** (`browser_type`, `fill`, `type_text` and kin) is always shown as "•••••• (7 characters)".
- **What other readers see.** `object` and `app` are projected by the same rule and code path as `tool.summary` (`transcript-page.ts` display keys; a reader for whom `summary` is withheld gets no `object`). They are short reads of the same arguments `name` and `summary` already describe. `step` is **not** added to any search index: search matches and snippets are exactly today's, for every reader.
- Witnesses: a private key across the 4 KB and 12 KB cut points is masked whole; a secret in a JSON argument, a URL query, a cookie header and an env assignment is masked in the row and the detail; a masked turn's row has `k` only and its detail route says `masked-turn`; a door caller and an MCP caller with access to the thread get 403 on the detail route and the same search results as on dev/1022 for a query that matches only a step object.

## 8. Engines, with today's Fuigo emits (MAIN-RULING 2026-11-21T14:59Z)
Nothing in this design needs an F-field. Rows exist from an engine's first frame and are "running" until completed, because status is derived (§3.1).
| Today's emit | 1.0.22 |
|---|---|
| ACP first frame is the wire name with kind `other`; kind and locations come in a later status-less update | The row opens from the tool-name table (`run_terminal_cmd`, `search_replace`, `use_tool` …). The ACP driver emits one `item.updated` when an update brings a kind, locations or rawInput; the fold patches `k` / `object` on the open row (§2). The completing frame's fields are applied before the row is closed. A closed row is never re-labelled |
| `pending` with no `in_progress` | Running from the first frame |
| Exit code only in `rawOutput.exit_code`; status `completed` for exit 1 | Failed, with `exit` (§3.1) |
| Bash sends the whole buffer about every 100 ms | An update that brings only output makes **no** row patch and **no** detail write. The Response is the completing frame's, written once |
| ACP `content[]` and `rawOutput` | Response = `content` text and diffs when present, else `rawOutput` as JSON text, else "Response unavailable" |
| No retry segment ids; a hosted row of a voided attempt is left open, or closed by the driver as `HOSTED_ROW_INTERRUPTED` | Left open → "Didn't finish" at turn end. `HOSTED_ROW_INTERRUPTED` → `unrecorded` ("Didn't finish"), not Failed. A `failed` the engine itself sends is "Failed" as sent; nothing is inferred from a missing payload |
| `session/cancel` sends no final update for calls in flight | "Didn't finish" at turn end |
| Hosted web search has its query only at the end | "Searching the web", then "Searched the web for **"q"**" from the completing frame |

Claude (`tool_use.id`), Codex (`item.id`, `aggregatedOutput` carried for the Response) and the API engines (Murage's call counter, minted before validation so an invalid or refused call still gets one row) feed the same fold. Where an engine gives no request or no response the pane says so.
Witnesses: a recorded capture of the dev/1022-bundled Fuigo (names neutralised) through the real ACP driver: every row has a label other than "Used a tool" and a final state; exit 1 is Failed; 600 cumulative output frames (2 MB) make 0 row patches and 1 detail write; a voided hosted row reads "Didn't finish".

## 9. Every prior High, closed by construction
| High | Closed because |
|---|---|
| OPUS r1 H1 / FABLE r1 H5: content `callKey` merges identical calls | No content key exists. Exact call id or no row (§3.2) |
| OPUS r1 H2 / FABLE r1 H3: redaction order, streaming scanner, per-subscriber frames | Scan, mask, cut, store in that order (§7). No streamed output and no step frames exist |
| OPUS r1 H3 / FABLE r1 H4: output store without delete hook, cap, backup rule | One table in `messages.db`, removed by trigger; global and per-turn caps; backups stated (§5) |
| FABLE r1 H1: no waiting or denied state | `state` waiting / denied; cards stay outside (§3) |
| FABLE r1 H2: engine ids as file names and route keys | The key is the server's message id; no files (§6) |
| FABLE r3.1 H1 / ASTRA H1: Stop hold has no settle rule (void, false, joined, replaced exits) | There is no hold and no Stop state; rows settle through `markTurnToolsUnrecorded` as today (§3.1) |
| FABLE r3.1 H2 / ASTRA H2: room Stop never reads "Stopped"; watchdog shares the helper | Steps never say Stopped, in any chat; the transcript's own Stop line is the only Stop wording (§3.1) |
| ASTRA H3: nested delete funnel; sidecar erased before outer COMMIT | No sidecar. Trigger delete in the same transaction; rollback witness (§5) |
| ASTRA H4: step words in shared search reach door / MCP readers | Nothing is added to search (§7) |
| ASTRA H5: page watermark drops a buffered update | No step paging, snapshot or frame buffer; rows ride the transcript sync (§1, §4.1) |
| ASTRA H6: read-only label for a multiline or long command | No classifier; whole command or no object (§4.4) |
| ASTRA H7: cumulative prefix rewrite feeds a stale tail scanner | No live tail (§7, §8) |
Mediums carried: FABLE M1/M2 (refusal freeze, transaction at `index.ts:3504`) do not arise, since nothing is published or decided there by steps; FABLE M3 / ASTRA (payload-less hosted failure) → §8, nothing inferred; ASTRA (wire-name fallback) → §8 row 1; ASTRA (count the end detail write) → §8 witness says 1 write for output frames, 2 in all with the start Request.

## 10. For the builder: 9c156c2fad to r4f
Merge dev/1022 first (three conflicts: `ci/gate-tests.txt` union; `fake-acp-cli.ts` keep both blocks; `index.ts` near 13799 keep dev's `terminalOutcome` line and **delete** the build's step `finish` call).
| Built | r4f |
|---|---|
| `server/step-log.ts`, `step-hub.ts`, `src/state/steps-store.ts`, `turn_steps`, `step.upsert` / `step.output` cases in `sse-visibility.ts`, the group route | Remove. The fold patches `tool.step` on the message row |
| `server/step-store.ts`, `step-details.db`, `noteStepThreadDeleted`, the snapshot membership edit in `installation-state-snapshot.ts` | Replace with §5 (`step_detail` + trigger in `message-tables.ts`); revert the snapshot edit |
| `server/step-redact.ts` | Keep; scan per string value, then cut (§7) |
| `shared/step-label.ts` | Keep the table and forms; delete `commandLabel` and the hint; words to locale files (§4.4) |
| `permission-proxy.ts` / driver id forwarding, `runtime-event-out.ts` (`toolUseId`, `askSource` never on the stream) | Keep |
| `StepsGroup.tsx`, settings rows, harness | Keep; feed from transcript rows (§4); mount in GroupView |
| Route policy: detail route class `companion` | Keep, keyed by message id (§6) |
| Tests | Rewrite to the §2, §3.2, §5, §7, §8 witnesses on real entry points; list every test file in `ci/gate-tests.txt` or `ci/extended-tests.txt` |
Build order, each RED first: (1) broker capture; (2) `tool.step` + replayed-start patch + labels; (3) asks; (4) `step_detail`, trigger, cap, route; (5) StepsGroup in ChatView and GroupView; (6) ACP `item.updated` and the Fuigo capture; (7) scale run.

## 11. Scale (P6)
Counted unit: SQL statements and transcript events **per tool call**. Requirement: constant, whatever the turn length: one message insert, at most three row patches (label refinement, ask, completion), at most two detail statements. Trigger paths and fixtures: a fresh turn, a turn resumed after restart, a turn in a room, a turn with asks; each at N = 10 and N = 1000 calls on a non-empty database; one witness row per path asserting equal statements per call at call 10 and call 1000. Client: a collapsed group renders its header only; an open 1000-step group mounts at most 60 rows; one row patch re-renders that row and the header. In-memory state per turn is bounded: the existing item map, the 256-entry pending-ask map, the open-card sets.

## 12. GAP-CHECK (one adversarial pass on r4f)
**Fixed**
- (b) failure path: the server crashes mid-step; after restart the row would spin forever. → A row is live only while its turn is live; otherwise "Didn't finish" (§3.1).
- (d) data: a long turn finishes just after the owner deletes the chat; a queued detail write would re-create tool output for a deleted chat. → Guarded single-statement write (§5).
- (d) privacy: output is cut to 16 KB first and a private key straddling the cut survives as a fragment. → Mask before cut, with a witness at both cut points (§7).
- (a) purpose gap: a transcript page ends inside a 600-step group, so the header would say "200 steps". → No count or time until the group's start is loaded (§4.2).
- (c) rule conflict (P7 / today's trace): with the per-ask lines removed, a No limits turn under Steps: Off shows no sign that steps ran unasked. → The numberless No limits line shows in every mode (§4.5).
- (b) failure path: an automatic ask with no call id marks no row, so the No limits line would be missing for that turn. → `autoTurn` on the turn's newest tool row (§4.5).
- (c) UX bar "plain words": Sean's narration rows would hide a bot's only words when the turn ends on a short line. → The last note is drawn as a bubble (§4.1).
- (b) failure path: the detail queue backs up behind a 50 MB output. → 1 MiB scan bound and 16 MB pending cap; the row says why nothing was kept (§5, §7).

**Parked (for Sean)**
- D1 A command killed by a Stop or a timeout can read red "Failed" when the engine reports the kill as a plain error before the turn ends; the transcript's Stop line follows it. Making it grey needs a per-interrupter fact, the class r3.1 failed review on. Fuigo 1.0.48 `fuigo/outcome` gives it exactly.
- D2 Command rows show the whole command when it is short (§4.4). If Sean wants no command text on a row, drop the object: a one-line change.
- D3 Live output while a command runs, step search, helper steps nested under the helper row, the plan as a row, quiet-run folding: each is an addition on top of this design and each was a source of Highs. Later release.
- D4 Richer command labels ("Ran tests", "Committed changes") need a proof over the whole command; parked with D3.
- D5 Step details are inside backups of `messages.db` (bounded by the 100 MB cap). Excluding them needs the sidecar this design removes.

**Rejected**
- A provisional row for an ask whose item never arrives: the card and decision log already show it, and a row with no call behind it breaks P4.
