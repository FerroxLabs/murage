# STEPS VIEW r3 (refresh r3.1): one plain-English step chain per turn (target 1.0.22)
Owners: SERVER side (StepLog, engine mapping, labeler, redaction, step stores, step routes and frames): the steps-view build lane (feat/1022-steps-view; PARTIAL 9c156c2fad, its successor continues after AGREE). CLIENT side (StepsGroup, detail panes, settings, locales): the same build lane. Contract between them: the `steps.v1` snapshot, the `step.upsert` / `stepgroup.upsert` frames and the routes in §6. Design owner: rvd-1022-x17-steps (r3.1 refresh of steps-design-r3). Fuigo ACP emitter side (F1-F18, §3.6): the Fuigo coordinator, landing in Fuigo 1.0.48 after 1.0.22 (MAIN-RULING 2026-11-21T14:59Z, `Fuigo/coord-notes/MURAGE-STEPS-ACP-EMIT-1022.md`); the Murage consumer side of §3.6 is the build lane. r3.1 is read at hub dev/1022 **6d4b5932a8** (r3 was read at b45d0259e6; line numbers below are 6d4b5932a8's) and at the PARTIAL build feat/1022-steps-view **9c156c2fad**. Binding inputs: SEAN-ADDENDUM.md, THRUST-RULES, GAP-CHECK-BAR, the UX bar, JOINT RULING STOP-VS-REFUSAL. r2 is kept as `STEPS-VIEW-1022-r2.md`; `STEPS-VIEW-1022-R3-DELTA.md` maps every audit finding to its change.

**PURPOSE.** While a bot works, the owner can tell at a glance what it is doing, which step it is on and what happened, in plain words, on every engine and in every chat. One click shows exactly what was run and what came back.

**USER PROMISES.**
- P1 One live line. A working turn has exactly one status line: what the bot is doing now and for how long. It says "Waiting for your OK" when it is waiting on you. No second clock, no second wording anywhere in the chat.
- P2 Plain rows. Each step is one row in plain words: present tense while it runs, past tense once done. A failed step says "Failed" in red, a step you refused says "Not allowed" (never red), and the chain carries on. A row never claims less than what happened ("Listed" for a command that also deleted).
- P3 The real thing on one click. A row opens to what was asked and what came back: a terminal block for a command, a diff for an edit, the request and response for everything else.
- P4 Exactly once. Each tool call is one row. Two identical calls are two rows.
- P5 No secrets. Secrets never show in a label, a detail, a search hit or a spoken line. Step output is deleted with its chat.
- P6 Always smooth. A 500+ step turn stays smooth; disk use is bounded.
- P7 Nothing new asks. Under No limits the chain only reports.
- P8 Everywhere the same. Dark and Light, desktop and phone, keyboard and screen reader, all eight languages, all engines, direct chats, rooms, tasks and old chats.

## 0. For the builder: what r3 changes in code already built
r3 read the build at f1b5cc30cf. r3.1 re-read the PARTIAL commit **9c156c2fad** (on b45d0259e6). The rows below still apply in full: 9c156c2fad still has `argsHash` identity and a FIFO in `step-log.ts`, `parentSeq`, `commandLabel`, `formatDuration`, the grey hint and `?sinceRev` sync. It has no `turn_step_groups`, `firstRetainedSeq`, `epoch`, `asOfRev` or `TextEncoder`, and nothing hooks `markTurnToolsUnrecorded`. It does not touch `acp/core.ts`, `codex.ts` or `openai-chat.ts`. Keep the architecture.

**Merge first (r3.1).** `git merge-tree` of 9c156c2fad onto dev/1022 6d4b5932a8 conflicts in three files:
- `ci/gate-tests.txt`: take the union.
- `server/testing/fake-acp-cli.ts:~2394`: keep dev's `FAKE_ACP_PROMPT_SCOPE` turn_completed block **and** the build's `ITEM_FIRST` frame. They are independent.
- `server/index.ts` (dev line 13799, the merge-tree hunk at ~13839): dev now computes `terminalOutcome = commandRefusal ? (confirmedCommandStop ? "cancelled" : "failed") : …`. Keep dev's line, then settle the steps by the **Stop fact**, never by `terminalOutcome === "cancelled"`:
  - Stop already confirmed (`confirmedCommandStop`, or `confirmedStopGenerations.has(gen)`, read before `consume` at `index.ts:13868`): `stopped`.
  - Stop asked but not yet confirmed (`directRun.phase === "stopping"` or `releasedStop`, `index.ts:13102-13103`): **hold**. The fold can run before the close receipt, because `confirmedStopGenerations.add` happens only after `await stopCall` (`index.ts:5125-5136`). Held rows stay open and the header reads "Stopping…". They settle at the confirmation site (`index.ts:5136` → `stopped`) or on the unconfirmed or refused path (`index.ts:5126-5132` → `no_result`). Either way it happens once, keyed by the same generation `noteOwnerStopTerminal` uses (`directRun?.generation ?? terminalDispatchFor(executionEvent)?.identity.dispatchGeneration`, `index.ts:13834`).
  - No Stop asked: `no_result`, group `interrupted`.
  - A caller-side `finish` is a stopgap. §3.3's hook inside `markTurnToolsUnrecorded` (both call sites, `index.ts:3504` and `13815`) is the target, with the same three cases. The ACP core settles **every** interrupter as `cancelled` (`acp/core.ts:~8050`: room deadline, stall watchdog, provider-settings change), so the build's test would print "Stopped" for a turn nobody stopped (JOINT RULING; §3.3).

Then change these:

| File (built) | Keep | Change in r3 | § |
|---|---|---|---|
| `shared/step-label.ts` | one shared table, `{key, object, app}` labels, tense by status | Replace `commandLabel` with the tokenizer and the "never understate" rule. Resolve the `mcp__` **tail** name against the built-in table before the app branch. Add kinds `delete`, `move`, `helper`, `ask`, `handoff`, `question`, `memory`, `phone`. Remove `hint`. Add forms `want` / `wanted`. Web host only. Words move to the eight locale files. `Buffer` → `TextEncoder`. `formatDuration` → the app's `formatElapsed`. `phaseOfKind` names the single app. `stepWords` uses a function replacement | 4, 5.9 |
| `server/step-log.ts` | status machine, `waitMs`, provisional rows, FIFO queues, frame cap 512 B | ID-less asks attach only on a **unique** match (FIFO per source removed). Provisional row made by an id is adopted only by that id. Cards tracked by request id. Identity by operation token, not `(engineId, argsHash)`. Children go to a child group (`childRef`), `parentSeq` removed. Add `stat`, `result`, `child`, group record and group `rev`. Turn-wide caps; the 16 KB request cap also covers command text (`argsText` bypasses it today). Hook `markTurnToolsUnrecorded` | 2, 3 |
| `server/step-redact.ts` | scan → mask → cut → store order, 8 K + 24 K cut | Scan each string value, never the pretty-printed blob. A label masks to the end of its **line**. 16 KB windows with their own budget. Replace both quadratic regexes with linear scans. Add the rules in §7.3. Typed text is always masked. Fix the test arithmetic (93 K / 107 K, not 112 / 128) | 7 |
| `server/step-store.ts` | both tables, `secure_delete`, ring, cap, WAL scrub | Add `turn_step_groups`. Detail row is written at step **start** (request) and updated at end (response). The delete hook **stays** in `message-db.ts deleteThread` (every delete path reaches it); add the write fence. Boot sweep by committed step keys. Physical size budget. `search_text` in the app language. Wire `setCap` to the setting | 6 |
| `server/step-hub.ts`, `server/index.ts` | per-ask writers removed, `appendDecision` kept, routes class `companion`, frames desktop-only | `finish` takes the confirmed-Stop fact from `confirmedStopGenerations`, never from the `cancelled` outcome (merge note above). One `messages.db` transaction for group + row + rev, then publish. Step frames never enter the shared replay buffer. Snapshot route. Boot recovery **awaits** the deletion task. Feed notes. `childRef` set for all three delegations. Group message text is generic | 3, 6 |
| Claude driver files | `tool_use_id`, `askSource`, `parentItemId` | Map `ask_user` ↔ `mcp__…__ask_user`. Drop a sub-agent's completed text block from the parent turn. Read `system/permission_denied` and the leading "Exit code N" | 3.3, 3.4 |
| `server/drivers/acp/core.ts`, `codex.ts`, `openai-chat.ts` (not touched yet) | | ACP: emit `item.updated`, content before `rawOutput`, exit code, plan, sub-agent notifications, all against **today's** Fuigo emits per §3.6. That includes the no-`retryDiscard` hosted-row close and in-progress frames kept out of rows and frames. Codex: `aggregatedOutput`, item types, collab agents, plan updates. API: mint the call counter first | 3.4, 3.6 |
| `src/state/steps-store.ts` | external store, per-row `rev` check | Epoch, snapshot hydrate with frame buffering, `firstRetainedSeq`, group records, refetch on SSE reconnect, dispose on conversation change | 6.3 |
| `src/components/StepsGroup.tsx`, settings | three-way Steps control, fold switch, details cap | Everything in §5: tokens and components, one live line, folds, panes, scroll rules, phone, keyboard, locales. Mount in GroupView too. Remove the six old indicators per §1 | 1, 5 |
| Tests | all | List every new test file in `ci/gate-tests.txt` or `ci/extended-tests.txt` (none is listed today) | 11 |

## 1. What is there today, and the one-indicator rule
- **The wall.** `noteFullAccessStep` adds one string per auto-answered **ask** to `tool.steps[]`; `ApprovedStepsRow` draws them as monospace lines. Tool chips (`ActivityChip`) are a second renderer for the same calls. Tool output is not kept. The builder has already removed the per-ask writers; that stays.
- **Six more live indicators.** The chat also shows what the bot is doing through TurnPresence, LiveThinking, LivePlanCard, HelpersLine / HelpersSummary, TaskTimeline and the TurnNarrationRun / ActivityRun folds, and rooms have their own `RoomToolChip` path. r2 did not mention them. Left alone they give two clocks and two wordings beside the new header, which breaks P1.

**Rule: while a StepsGroup is live in a turn, it is the only status line of that turn.** One clock (the header), one format: `formatElapsed` from `src/lib/working-time.ts` (`42s`, `1m 05s`), moved to `shared/` so the server's anchor text uses the same function, and extended once with hours (`2h 05m`; today it would print `125m 00s`). The builder's `formatDuration` is dropped.

| Today | In 1.0.22 |
|---|---|
| TurnPresence (mascot, shimmering label, `WorkingTimer`) | The mascot stays. Its label and timer are not drawn while a StepsGroup is live in that turn. It shows with label and timer only before the first step, and under Steps: Off |
| LiveThinking chip ("Thinking" / "Thought" + timer) | Becomes the header phase "Thinking" and one row in the list: "Thinking" while it streams, "Thought for 12s" after (§5.5). The row opens to the same text, with the same guards and lifetime, the chip has today; no reasoning text is newly stored. In a turn with no group yet (no tool call so far), and under Off, the chip shows as today |
| LivePlanCard | Folded into the group as the **plan row** (§5.4): one line, "Plan · 2 of 5 done · Compare October with September", that opens to the same checklist. It sits under the now-line while the turn is live and stays in the list afterwards (today the card vanishes when the turn ends). `TodoWrite`, `update_plan`, ACP `plan` and Codex `turn/plan/updated` make **no step rows** and are not counted. No spinner of its own. Under Off the card shows as today |
| HelpersLine / HelpersSummary | Replaced by helper rows (§5.6). Unchanged under Off |
| TaskTimeline | Removed; its switch is gone |
| TurnNarrationRun, ActivityRun, InterimStepsRow, ApprovedStepsRow, tool ActivityChip, RoomToolChip | Replaced by StepsGroup in ChatView **and** GroupView (rooms, tasks, helper conversations) |
| Murage notices (`origin:"murage"`, `notice:true`: "Preparing Codex…", "Waking up…", compact, retry, `error:` rows) | Unchanged. Never step rows, never counted, always outside the group |
| Approval panel above the composer, `ApprovalWaitingRow`, question cards | Unchanged in place and behaviour (§5.7) |
| Bot-to-bot comm chips, done-when receipt lines, voice events | Unchanged, outside the group, in every mode (they show today with tool calls off) |

Witness: a live fixture turn with thinking, a plan, two helpers and 12 steps renders exactly one element with a running clock and one phase text; under Off it renders today's set unchanged.

## 2. The duplicate lines: one row per call, by construction
**What is proven.** A line was added per accepted **ask**, with no call id, appended unconditionally (`full-access-steps.ts`, index.ts:3003-3021), and `ApprovedStepsRow` drew every entry whether or not tool chips were on. Two asks for one call therefore give two lines inside the list; a chip beside the list gives a third. **What is not proven** is which pair of asks produced Sean's screenshot. The first build task stays the broker-level capture, and r3 widens it:
- **Capture witness (RED first, before any claim that the incident is fixed).** For one Bash call and one non-Bash call (Read) on CLI 2.1.310, under No limits, with Steps Collapsed and Off: record every broker ask (request id, source, `tool_use_id`), every normalised item id, every stored row and every rendered row. Add two crossed cases: two identical calls where one is asked by the hook and the other by the CLI tool, and a replayed `started`. The witness names the real pair. DONE quotes the capture.

**Rule: rows come only from tool executions. An ask never creates a second row; it attaches to exactly one step or to none.**
1. **Delivery is deduplicated by broker request id.** The same request id seen twice is one ask.
2. **An ask with a call id** (Claude `tool_use_id`, Codex `itemId`, ACP `toolCall.toolCallId`, Murage's own counter on API engines) attaches to the row of that id. If the row does not exist yet, the ask opens a **provisional row keyed by that id**. Only an item with the same id adopts it. If no item ever arrives, the row settles from the decision: refused → `denied`; allowed → `no_result` at turn end.
3. **An ask without a call id** (only possible on Claude, if 2.1.310 omits it on some path; the capture says whether it ever does) attaches by content key (`callKey`) **only when exactly one open step in the turn has that key and that step has no ask from the same source yet**. Otherwise it attaches to no row: the card and the header's "Waiting for your OK" still show, the decision log still records it, and no row is marked. r2's "oldest row per source" guess is removed: it could put two different calls' asks on one row.
4. **An ID-less ask never opens a row.** With no unique match it is unattributed. (A provisional row keyed by content could never be adopted safely: two identical parallel calls asked before their items would leave two phantom rows.)
5. The existing driver wait `CLAUDE_ASK_ITEM_WAIT_MS = 2000` (owner: the Claude driver) is unchanged. StepLog adds no timer and accepts either order.

Counts follow. A row carries at most one `approval` tag however many asks it had, and the tag is set only when the answer was **accepted by the engine** (today's code un-tags an ask whose delivery failed; that stays). Each group counts `auto` = counted rows tagged `no-limits` or `full-access`, and `unattributed` = automatic asks tied to no counted row (rule 3, or an ask for a tool that makes no step row). The No limits line (§8) uses `auto` as its number and drops the numbers when `unattributed` is above zero, so it can never read "33 of 31".

**Witnesses.** Two identical No limits Bash calls → 2 rows, 2 approval tags. Hook + CLI ask with the same `tool_use_id` → 1 row, 1 tag. Ask before item (id) → 1 row. Ask with an id and no item, refused → 1 `denied` row; allowed → 1 `no_result` row. Two identical calls, one hook ask and one CLI ask, no ids → 2 rows, 0 row tags, `unattributed` 2. Two identical parallel calls, both asks before both items, no ids → 2 rows, no phantom row. Same request id delivered twice → 1 tag. AskUserQuestion and `ask_user` → 1 row each, `waiting` while the question card is open.

## 3. Event model (one shape for all engines)
### 3.1 Shapes
```ts
type StepKind = "command"|"read"|"write"|"edit"|"delete"|"move"|"search"|"list"|"web_search"|"web_fetch"
  |"app"|"skill"|"helper"|"ask"|"handoff"|"question"|"memory"|"browser"|"computer"|"phone"|"other"
  |"note"|"plan"|"thought";            // these three are rows but not steps: never counted, never asked about
type StepStatus = "waiting"|"running"|"done"|"failed"|"denied"|"stopped"|"no_result";
interface Step {                       // one row in turn_steps and one step.upsert frame, <= 512 B
  threadId: string; groupId: string; seq: number;   // server-minted; seq = first-seen order in the group
  rev: number;                         // the group's rev when this row last changed
  kind: StepKind;
  label: { key: string; object?: string; app?: string; n?: number };  // §4; object <= 96 B, app <= 32 B
  stat?: { added: number; removed: number; files: number };            // edit and write rows
  result?: string;                     // <= 32 B, from structured engine fields only: "3 matches", "no matches", "5 results"
  status: StepStatus; startedAt?: number; endedAt?: number; waitMs?: number;  // no startedAt = no duration shown
  waitingFor?: "ok"|"answer";
  approval?: "no-limits"|"full-access"|"owner"|"rule"|"own-files";   // from the decision that answered the ask; own-files and rule show as "Allowed by your rule"
  deniedBy?: "owner"|"rule"|"no-answer"|"refused";
  error?: string;                      // first line, masked, <= 160 B
  hasDetail: boolean;
  childRef?: { threadId: string; groupId: string };  // helper, ask, handoff: where the child's steps are
  child?: { state: "live"|"waiting"|"done"|"failed"|"stopped"; phase?: string; steps?: number };  // one-line child summary; phase is a phase KEY, never an object
}
interface StepGroup {                  // one row in turn_step_groups and one stepgroup.upsert frame
  threadId: string; groupId: string; turnId: string; rev: number;
  state: "live"|"done"|"stopped"|"interrupted";
  startedAt: number; endedAt?: number; waitMs: number;      // worked time = end - start - waitMs
  counts: { steps: number; failed: number; denied: number; auto: number; unattributed: number };
  firstRetainedSeq: number; lastSeq: number;
  parent?: { threadId: string; groupId: string; seq?: number };  // set on a child group; seq is filled when the parent row is known
  lastOfTurn: boolean;
}
interface StepDetail {
  tool: string;                        // sanitised raw tool name: [A-Za-z0-9_.:-], <= 64 chars, else "tool"
  request: DetailBody; response?: DetailBody;          // response absent until the step ends
  locations?: { path: string; line?: number }[];       // masked; shown as chips
  exit?: { code?: number; timedOut?: boolean };
  withheld?: "too-large-to-check"|"binary"|"image"|"masked-turn"|"not-kept"|"unavailable";   // "older-step" exists only in the client's old-chat adapter (§10)
}
type DetailBody =
  | { type: "terminal"; command: string; cwd?: string }                         // request of a command
  | { type: "diff"; files: { path: string; change: "create"|"update"|"delete"|"move"; oldText?: string; newText?: string; unified?: string }[] }
  | { type: "text"; text: string; lang: string; omitted?: { lines: number; bytes: number }; partial?: number /* bytes not checked */ };
```
`kind` drives the icon, the fold and the phase. `label.key` drives the words. A group has at most one `plan` row; its entries are its detail.

### 3.2 Identity
Engine ids are strings chosen by an engine or a model endpoint. They are never a file name, a route segment or a storage key. The stored key is `(threadId, groupId, seq)`, server-minted, always bound as SQL parameters.
- **Operation token.** Inside a turn, a call is known by `(turn generation, attempt epoch, operation token)`. The turn generation is the server's; the attempt epoch is the driver's (it changes when a driver discards and resends an attempt, as the ACP core does); the token is the engine id where the engine guarantees one id per execution, and a driver-minted counter otherwise. API engines (`openai-chat.ts`: Grok API, OpenAI-compatible) mint the counter **before** argument validation and the permission ask and carry it through to the result; the provider's own id check stays as it is.
- **A second `started` for a token whose row is open is an update** (ACP sends sparse updates; warm sessions replay `started`). Fields present replace the stored ones; `content` and `locations` replace whole arrays and are never appended (ACP spec); a final status always wins. **A non-final row may be re-labelled** by an update that changes its kind, object or files: one row update, one frame, `rev` + 1. This is required, not optional: Fuigo opens every call as its wire name with kind `other` and sends the real kind, locations and diff in a second, status-less frame. A final row is never re-labelled, except that a hosted tool whose start had no arguments (a web search whose query arrives only at the end) takes its object from the completion.
- **A `started` for a token whose row is final** is a new execution only if the driver says so by giving it a new token. Otherwise it is a replay and is ignored. r2's `(engineId, argsHash)` rule is removed: it merged two real identical calls and let a late result settle the wrong row.
- **A result with no open row for its token is an orphan.** It is dropped (counted, never shown). If a driver cannot tell which of two open rows a result belongs to, neither row takes it; both close as `no_result` when the attempt closes.
- **Fence.** After a turn generation settles, late starts, results and answers for it are ignored. Witness: all transitions with a newer generation live on the same thread.
- **Bounded.** The token map holds open rows plus the newest 5,000 final tokens of the turn.

### 3.3 Status rules
`running ⇄ waiting`; `running | waiting → denied | stopped | no_result`; `running → done | failed`. Final states are never left.
- **Waiting.** A row is `waiting` while its set of open cards (by request id) is not empty. `waitMs` is the union of those intervals, so two overlapping cards are not counted twice and one answered card does not un-pause a row that still has another.
- **Decision outcomes** (`handleDecisionRequest`): `card` → `waiting`, `waitingFor:"ok"`; `question` → `waiting`, `waitingFor:"answer"`; `run` → stays `running`, sets `approval`; `refuse` → `denied`.
- **Denied** is final and never red. `deniedBy`: `owner` (Don't allow), `rule`, `no-answer` (card closed unanswered), `refused` (Murage refused for another reason; the footer shows that refusal's own message). **Engine evidence that a call never ran is `denied`, not `failed`, even when no ask was matched**: Claude `system/permission_denied` for that `tool_use_id`; Codex item status `declined`; an ACP `failed` for a call whose ask Murage itself answered Deny or cancelled (by `toolCallId`); an API call refused by Murage's gate. Never by matching English error text. The engine's error result that follows is stored as the response.
- **Failed** is an explicit tool error, a non-zero exit, a signal or a timeout, **whatever the engine's status says** (Fuigo reports a command that exited 1 as `completed` and puts the code in `rawOutput.exit_code`; Claude puts "Exit code N" at the start of an error result). An ACP status Murage does not know means still running, never failed. **Not failed:** a search command (`grep`, `rg`, `findstr`) that exits 1 with no output is `done`, and its detail says "No matches".
- **Invalid calls.** A model call Murage rejects before running (unknown tool, arguments that do not parse) is one `failed` row with the error "The request wasn't valid", so a refused attempt is never invisible. A protocol frame that is itself broken or incomplete creates nothing.
- **Stop.** `stopped` only when the owner's Stop is confirmed (its close receipt exists for that generation, JOINT RULING). A tool result that says "interrupted" and arrives while a Stop is held is kept pending: confirmed Stop → `stopped`; turn ends without it → `failed` with that result. At turn end, open rows become `stopped` when the Stop is confirmed, are **held** (header "Stopping…") while a Stop is asked but not yet confirmed, and become `no_result` otherwise. A held turn settles once, when the close receipt lands (`stopped`) or the Stop is unconfirmed or refused (`no_result`) (§0 merge note). "Confirmed" means the generation is in `confirmedStopGenerations` (or `confirmedCommandStop` for a command refusal), read before it is consumed. A `cancelled` outcome is not a Stop: the ACP core reports a room deadline, the stall watchdog and a provider-settings change as `cancelled` too (`acp/core.ts:~8050`). Those turns end `interrupted`, with `no_result` rows. Witnesses:
- A stall-watchdog cancel and a room-deadline cancel each give "Interrupted after …", never "Stopped".
- An owner Stop whose close receipt lands **after** the turn's terminal fold gives "Stopped after …" with `stopped` rows.
- An owner Stop that is never confirmed gives "Interrupted after …" with `no_result` rows.
- **Turn end.** StepLog settles open rows inside `store.markTurnToolsUnrecorded` itself (it has two call sites: normal turn end and ledger-refusal settlement), not at one caller.
- A first frame that is already final (ACP adapters send some calls this way), or a `completed` with no `started`, creates the row final. It has no `startedAt`, so no duration is shown. A step ends on its own end event or at turn end; it is never closed by inference from the next unrelated event.

### 3.4 Engine mapping
Every registered driver is qualified against one normalised contract: `attempted` (an ask with no item yet), `started`, `updated`, `completed`. Each gets a fixture of **real recorded frames** (names and paths neutralised) that includes: an unsupported tool, invalid arguments, a denied call, a final-first event, an image result and two identical calls. Synthetic frames are not enough: a hand-written ACP fixture puts the real title on the first frame and passes, while a real Fuigo turn would read "Used a tool" on every row.

| Engine (driver) | Token | Request | Response | Ask link | Driver work |
|---|---|---|---|---|---|
| Claude stream-json (`claude.ts`) | `tool_use.id` | `tool_use.input` | `tool_result.content` text parts; `is_error` → failed, with the exit code read from a leading "Exit code N"; images → "Image, shown in the chat" when attached, else "Image (N KB), not shown" | `tool_use_id` on permission, question and hook asks (built); else §2 rule 3 | Built: ids forwarded, `parentItemId`. To do: `ask_user` ↔ `mcp__…__ask_user` name mapping; a sub-agent's **completed** text block is dropped from the parent turn as its deltas already are (it is a note in the child group if short) |
| Codex app-server (`codex.ts`) | `item.id` | by **item type**, never by `title` (the driver sets `title` to the command text): commandExecution `command` (shell wrapper removed) + `cwd`; fileChange per-path diff; mcpToolCall `server/tool/arguments`; webSearch action | `aggregatedOutput` (new: today only `exitCode` is carried); `exitCode ≠ 0` → failed; status `declined` → denied; `failed`, `cancelled` preserved | approval `itemId` | Carry `aggregatedOutput`. Use Codex's own `commandActions` (read / list / search) for the label when present. `collabAgentToolCall` → helper row + child group (today it feeds only `SubtaskTracker`). Tag summary deltas apart from raw reasoning (§3.5). `outputDelta` live tail is the last build item |
| ACP agents: Fuigo, Grok Build and the wider ACP fleet (`acp/core.ts`) | `toolCallId` within the driver's attempt epoch | `rawInput`, `kind`, `locations` (§4.4); `title` is never a label | `content[]` **before** `rawOutput` (today `core.ts:6071` keeps `rawOutput ?? content`, which drops Fuigo's diffs): `diff {path, oldText, newText}` → diff body; text → text body; then `rawOutput`. `rawOutput.exit_code ≠ 0`, `timed_out` or a signal → failed. Murage does not run engine terminals and does not rely on vendor `_meta` terminal output | `request_permission.toolCall.toolCallId` | Emit `updated` for every `tool_call_update` that brings kind, locations, content or rawInput (today `core.ts:~6030-6045` merges them for the No limits judge only and emits nothing). Accept a final status on the first frame. `plan` → the plan row, replace-whole (keep entry `_meta.cancelled`). Thought chunks tagged `fuigo/retryStatus` are notices, never thoughts. Fuigo sub-agents: `_fuigo/session_notification` `subagent_spawned` (matched to the open task step in start order, since no parent call id is sent), `subagent_progress`, `subagent_finished`; child-session calls become the child group. `content` of type `session` → `childRef`. No ACP duration exists: Murage times steps itself |
| Grok API, OpenAI-compatible (`openai-chat.ts`) | Murage's call counter | parsed `arguments` | the result string Murage produced (the same text it sends the model) | Murage's own gate, same counter | Mint the counter before validation and permission; emit a row for invalid, unknown and denied calls; unwrap `use_tool` |
| Pi (`pi.ts`), Antigravity (`antigravity.ts`) | the driver's item id | as their `item.started` gives | as their `item.completed` gives | none sent | Recorded fixtures; where a field is missing the pane says "Request unavailable" or "Response unavailable" |

What Fuigo should send better over ACP is listed as F1-F18 in `stepsref-fable/REFERENCE.md` section d (one final first frame, exit code and duration, a denied outcome, a parent call id for sub-agents, and more). Per MAIN-RULING 2026-11-21T14:59Z these land in Fuigo 1.0.48, **after** 1.0.22. §3.6 is the binding contract: every row of it renders fully with what Fuigo sends today, and each later field only adds to it.

### 3.5 Narration rows (`kind:"note"`)
Sources, and nothing else:
1. **Short interim assistant text**: one line, at most 160 chars, with another step after it in the same turn. Works on every engine. Longer interim text stays a bubble and splits the chain into two groups.
2. **Provider-marked reasoning summaries**: a Codex summary title, only once the driver tags summary deltas apart from raw reasoning (today both arrive as `reasoning_text`). Until then Codex gives none.
Raw reasoning (`reasoning_text`), ACP `agent_thought_chunk` and Claude thinking blocks are **never** notes: a fragment of raw reasoning is not narration. They are the thought row (§5.5). Notices and retries that ride a thought channel stay notices.
Guards, unchanged from r2: the newest note shows on the live line under the collapsed header; if the turn ends with no closing reply the last note is shown again as a bubble; Settings has "Fold short in-between messages into steps" (on). Folding is **display only**: interim text is stored as the assistant message it is today with one flag `stepNote:{groupId, afterSeq}`; it is not a `turn_steps` row. Only source 2 (a provider summary title) is stored as a `note` row. **Under Steps: Off nothing is folded**: every assistant message is a bubble, so no finding is hidden with the chain.

### 3.6 Today's Fuigo emits, and what lights up later (MAIN-RULING 2026-11-21T14:59Z, binding)
The step view must render **fully** with what the Fuigo bundled in dev/1022 sends today:
- `in_progress` only for hosted tools and bash;
- no retry segment ids (`retryDiscard` / `streamStartMs` absent);
- full-buffer bash output.

The F1-F18 fields (Fuigo 1.0.48) are optional extras. Rule: **no row, state, label or pane may need an F-field to be correct. An F-field may only replace a Murage-derived value with an exact one.** Murage never parses English prose to get any value in this table.

| # | Today (no F-field) | Murage 1.0.22 renders | When the F-field is present |
|---|---|---|---|
| F1 | First `tool_call` = wire name, kind `other`. The real kind, locations and diff come in a later update with no status | The row opens from the tool-name table (`run_terminal_cmd`, `search_replace`, `use_tool`, … are in §4.2). It is re-labelled once by the update: one row write, one frame (§3.2) | One final first frame, no re-label |
| F5 | Non-shell tools go `pending` → `completed`/`failed`; only bash and hosted tools send `in_progress` | `pending` and `in_progress` both mean **running**: present tense, dots, from the first frame. Nothing waits for `in_progress`. Step time = first frame to end, minus `waitMs` (the owner's card time, from Murage's own ask) | `in_progress` after `pending` is a no-op: no write, no frame |
| F2, F18 | Exit code, timeout, signal and truncation exist only in `rawOutput` (`exit_code`, `timed_out`, `signal`, `truncated`); `status` says `completed` for exit 1 | Read from `rawOutput` (§3.3: a non-zero exit is `failed`). With none of these fields, the status is taken as sent. A truncated output says "Output was cut by the engine" in the pane footer | `_meta["fuigo/exec"]` is read first, `rawOutput` second, same rules |
| F3 | No duration | Murage's clock (§5.1) | `fuigo/durationMs` is the shown duration |
| F4 | Denied, cancelled and policy-refused calls are `failed` + prose | `denied` only for a call whose ask **Murage** answered Deny or cancelled, matched by `toolCallId` (§3.3). A `failed` that arrives after Murage sent `session/cancel` for the turn is held, like an interrupted result under a held Stop. Confirmed Stop → `stopped`. Otherwise `no_result` at turn end: the cancel may come from a room deadline, the watchdog or a Flux refusal (`core.ts:5606`), and the call was cut, not broken. Anything else Fuigo refuses by its own policy reads "Failed" with its masked first line as the error. This is honest, never parsed | `fuigo/outcome` `denied`/`policy` → `denied` (`deniedBy` `owner`/`refused`); `cancelled` → `stopped` if the Stop is confirmed, else `no_result`; `error` → `failed` |
| F6 | `request_permission` has no content and no locations | The waiting now-line uses the row's own object (same `toolCallId`). If the ask comes before the refinement update, it reads the want form without an object ("Wants to edit a file") until the update lands | Object and diff from the ask itself |
| F7, F8 | Weak kinds (ListDir, MemorySearch, Task and MCP calls arrive as `other`; todo as `think`). Grep's title is the bare pattern. `apply_patch` has no locations at start | Labels follow §4.4's order and never use `title`. An `apply_patch` row reads "Editing files" while it runs. The **completing frame's** fields (its diff content, locations) are applied first, then the row becomes final: "Edited **core.ts** `+12 −3`". "A final row is never re-labelled" (§3.2) applies only to frames **after** the final one | Kinds and locations from the start |
| F9 | A hosted web search starts as "Web search:" with no query; the query is only in the end `rawOutput` | "Searching the web" (no object). On completion: "Searched the web for **"q"**", plus "· 5 results" when `rawOutput` has a structured count (§3.2 exception) | Query at start |
| F10 | ListDir, web search, MCP and task results exist only in `rawOutput` | The Response pane shows the `content` text blocks when there are any. Otherwise it shows the masked `rawOutput` as JSON text. "Response unavailable" appears only when both are absent | Plain text `content` is shown first |
| F11 | Bash streams the **whole buffer so far** in `content` about every 100 ms. Murage does **not** set `fuigo/incrementalBashOutput` in 1.0.22 | A non-final update that brings only output (kind, locations, rawInput and title unchanged) makes **no** StepLog write, row update, step frame or detail write. The driver keeps only the newest buffer per open call, replaced and never appended, and drops it at the end. The Response comes from the **completing frame** only. The live tail (§6.5, last build item) reads the newest buffer at most 4 times a second, and only while someone is subscribed. New text is the part past the previous length when the 256 bytes before that length are unchanged. Otherwise, the tail latches "Live output hidden; it shows when the step finishes, if safe" (§7.4) for the rest of the step. A tail that starts when someone subscribes mid-command scans the newest buffer **from byte 0** before it releases anything (bounded by the 64 MB pending cap, §7.2). The scanner therefore always starts at the first byte: a private key that began before the subscription is still masked | `output_delta` feeds the tail scanner directly |
| F12 | `subagent_spawned` has no parent call id; child calls come under another session id | Matched to the open `task` step in start order (§3.4). An unmatched child group shows under a grey "Helper" heading, like a ring-dropped parent (§5.6) | `parent_tool_call_id` is matched exactly |
| F13 | Thoughts are raw deltas with no segment id and no duration. Retry lines ride the thought channel tagged `fuigo/retryStatus`. Without `retryDiscard`, a `retry_state` `retrying` voids all buffered text (`resetForRetry`, `core.ts:~5500`), and a hosted row of the voided attempt is left open or closed `failed` with no output | Thought segments and their times are Murage's (§5.5). A chunk tagged `fuigo/retryStatus` never enters a thought row or a note, **with or without** `retryDiscard`. Today `core.ts:5948` drops it only with `retryDiscard`; the LiveThinking stream under Off keeps today's behaviour. **Retry without `retryDiscard`:** the driver tracks hosted (`_meta.backend`) rows with or without the capability. At a `retrying` it closes every open hosted row exactly as `discardForRetry` does (`core.ts:5528-5536`: `item.completed ok:false detail HOSTED_ROW_INTERRUPTED`, id into `interruptedRows`, so Fuigo's later `failed` is ignored), and the attempt epoch moves (§3.2), so a resend that reuses the id is a new row. StepLog maps `HOSTED_ROW_INTERRUPTED` to `no_result` on **both** paths ("No result", grey; pane "The engine retried this step"), never `failed`. The order is not assumed: Fuigo may close a voided hosted row itself **before** the `retry_state`, and that close is `failed` with no `rawOutput` and no `content`. Any `_meta.backend` row ending that way is also `no_result`; a real hosted failure carries its provider payload in `rawOutput`. A new `tool_call` that reuses an id in `interruptedRows` removes the id from that set, so the resend's updates are not dropped (`core.ts:6050`). Client-executed rows are never touched by a retry | `retryDiscard` + `streamStartMs` select the exact attempt (the existing path) |
| F14 | Cancelled plan entries arrive as `completed` + entry `_meta.cancelled`; entries have no id | `normalizeAgentPlan` (`shared/agent-plan.ts:28`, which drops `_meta` today) is extended to carry `cancelled` (grey X, §5.4). The plan is replaced whole on each update | Entry ids are not needed (still replaced whole) |
| F15 | An auto-backgrounded shell call ends with an update that has no status | The row stays running. Its newest buffer becomes the Response at turn end and the row reads "No result", never "Failed". The header phase follows later steps (§5.1) | `completed` + `backgrounded` → done |
| F16 | `session/cancel` during a local tool sends no final update for calls in flight | Turn-end rule (§3.3): confirmed Stop → `stopped`, else `no_result` | `failed` + `fuigo/outcome:"cancelled"` → the same mapping |
| F17 | Batch calls skipped after a rejection get no frame | No row. Counts are rows, so the header and the No limits line (§2, §8) still agree | One `failed` + `cancelled` row each → `no_result` |

**Witnesses (on the §11 item 0 capture of the dev/1022-bundled Fuigo, `retryDiscard` absent):**
- Every row of the capture has a label other than "Using a tool", a final status and a Request pane. The shell call with exit 1 is "Failed", the edit has its diff, the grep has its pattern, the web search gets its query at completion.
- A cumulative stream of 600 frames and 2 MB makes 0 row updates and 0 step frames between start and end, and exactly one detail write.
- A hosted web search followed by `retrying` gives 1 `no_result` row plus the resend's own row, in both orders (Fuigo's own `failed` before or after the `retry_state`) and with a reused id.
- A subscriber that joins mid-command after a private key has started sees the key masked.
- A `fuigo/retryStatus` chunk makes no thought row.
- The same capture with F2/F3/F4/F9 fields added on top shows the exact exit code, duration, "Not allowed" and query.
- Mutants, each RED at its own assertion: (1) map `HOSTED_ROW_INTERRUPTED` to `failed`; (2) write a row update per in-progress frame; (3) require `in_progress` before showing running; (4) drop the `rawOutput` fallback in the Response pane.

## 4. Plain-English labels: deterministic, no model call
One table in `shared/step-label.ts`, used by the server (stored label, `search_text`, the voice line) and the client (legacy adapter). No Node-only API in it.
### 4.1 Forms and words
Each label key has five forms in every locale: **spoken** ("reading a file": no placeholders, used only by voice, §5.13), and four written ones: **want** ("Wants to run tests", while waiting), **wanted** ("Wanted to run tests", not allowed), **present** ("Running tests"), **past** ("Ran tests", done or failed, stopped, no result). The words live in the eight locale files as `step.<key>.<form>` with `{object}`, `{app}` and `{n}` placeholders. The object is bold; bold comes from splitting the translated string at `{object}`, never from concatenation. Count forms use `…One` / `…Other` key pairs.
**A row never shows a raw command, an id, JSON or SHOUTY_SNAKE.** The grey mono hint of r2 is removed everywhere. Objects are basenames or short phrases; quoted search terms are at most 40 chars. A cut object carries its full masked text in `title`. When two rows in a group share a basename, both show the parent folder in grey (`src/` **index.ts**). Ranges read "lines 40-90" and are inclusive.
**Order of resolution.** (1) Unwrap `use_tool` and connected-app execute wrappers. (2) Engine structure first: a command field (`rawInput.command`, Codex commandExecution) → §4.3; Codex item type and `commandActions`; ACP `kind` (§4.4). (3) The **tail** tool name (after the last `__`) in the built-in table below. Murage's own server names never appear as an app. (4) Only a real third-party server falls to "Used App: action". (5) The unknown-tool row.

### 4.2 The table
| Tool (any engine spelling) | Running | Done | Object |
|---|---|---|---|
| Read, read_file, view, ACP read | Reading **notes.md** | Read **notes.md** | basename (+ "lines 40-90") |
| Write, create_file | Writing **plan.md** | Wrote **plan.md** | basename |
| Edit, MultiEdit, apply_patch, str_replace, search_replace, ACP edit | Editing **core.ts** | Edited **core.ts** `+12 −3` (or **3 files** `+40 −9`); Wrote **plan.md** `+40` | path(s); stat computed by Murage from the diff (no engine sends counts) |
| delete, remove, ACP delete / move, rename, ACP move | Deleting **x** / Moving **x** | Deleted **x** / Moved **x** | basename |
| Grep, rg, search_file_content, ACP search | Searching files for **"Poindexter"** | Searched files for **"Poindexter"** · 3 matches | `pattern`; the grey result ("3 matches", "no matches", "5 results" on a web search) shows only when the engine gives a count |
| Glob, find, ls, list_dir | Listing **.sable** / Finding **\*.md** | Listed **.sable** / Found **\*.md** | path / pattern |
| Bash, shell, exec, PowerShell, commandExecution, ACP execute | by §4.3 | | |
| BashOutput / KillShell | Checking a running command / Stopping a running command | past forms | |
| WebSearch, web_search | Searching the web for **"best flour ratio"** | Searched the web for **"…"** | `query`, 40 chars |
| WebFetch, fetch, web_read, ACP fetch | Reading **example.com** | Read **example.com** | **host only**; the path is only in the detail |
| Skill, or a read of `*/SKILL.md` | Loading the **gmail-triage** skill | Loaded the **gmail-triage** skill | skill name |
| skills_list, skill_manage, ToolSearch, search_tools | Finding the right tool | Found the right tool | |
| third-party `mcp__S__T`, connected-app execute | Using **Gmail**: Fetch emails | Used **Gmail**: Fetch emails | app = the connector's display name (`claude_ai_` stripped, brand casing: "Google Calendar", "GitHub"); action = T humanised. A batch reads "Used **Gmail**: 5 actions" |
| Task, Agent, Codex collab agent, ACP sub-session | Running a helper: **Find vendor files** | Ran a helper: **Find vendor files** | the call's `description`, never `subagent_type` |
| ask_bot | Asking **Kessler** | Asked **Kessler** | bot name from the roster |
| delegate_bot | Handing work to **Kessler** | Handed work to **Kessler** | bot name |
| check_delegation, wait_delegation | Checking on **Kessler** | Checked on **Kessler** | bot name |
| list_bots, get_bot | Checking who's around | Checked who's around | |
| ask_user, AskUserQuestion, needs_owner_now | Asking you a question | Asked you a question | |
| ExitPlanMode | Proposing a plan | Proposed a plan | |
| memory_search, memory_get | Searching memory for **"…"** | Searched memory for **"…"** | query |
| memory_save, memory_propose_correction | Saving to memory | Saved to memory | |
| thread_search, thread_read, venue_read_messages | Reading earlier chats | Read earlier chats | |
| browser_navigate, open_url / click / type, fill / read, snapshot / other `browser_*` | Opening **site.com** / Clicking **"Save"** / Typing on the page / Reading the page / Using the browser | past forms | host / element label; typed text is never an object |
| phone tap, swipe, press, type_text, read_screen | Using the phone | Used the phone | |
| screenshot, `computer_*` | Looking at the screen / Using the computer | past forms | |
| email_list, email_read / email_reply, email_send | Reading email / Sending an email to **name** | past forms | recipient display name |
| generate_image / send_voice_note | Making an image / Recording a voice note | past forms | |
| register_artifact / publish_site | Saving **name** / Publishing **site** | past forms | |
| `project_*` | Updating the project | Updated the project | |
| TodoWrite, update_plan, ACP plan, Codex plan update | no step row; the plan row (§5.4); phase "Updating the plan" | | |
| unknown `foo_bar` / `KillSwitch` | Using foo bar | Used foo bar | snake and camel case split; "Using a tool" when the name is not plain words |

### 4.3 Shell commands: never understate
A quote-aware tokenizer (no regex split; linear time; the command is cut to 4 KB before labelling).
1. **Unwrap** `bash|zsh|sh -c|-lc '<cmd>'`, `powershell … -Command`, `cmd /c`, a leading `cd X &&`, and the prefixes `sudo`, `env`, `NAME=value`, `timeout N`, `time`, `nohup`, `npx`.
2. **Split** into segments on `&&`, `||`, `;`, `|` outside quotes.
3. **Quiet labels are earned.** "Read", "Listed", "Searched" are allowed only when **every** segment's program is on the read-only list (`cat head tail less more bat ls dir tree find grep rg wc sort uniq cut jq pwd which echo Get-Content type Get-ChildItem Select-String findstr`) **and** the command has no `>`, `>>`, `tee`, `xargs`, `-exec`, `-delete`, `-fprint*`, `-fls`, `sort -o/--output`, `uniq` with two file arguments, `$(`, backtick or `sudo`. Then the first segment names the row.
4. **Otherwise the most consequential segment names it**, in this order: delete (`rm`, `rmdir`, `find … -delete`, `xargs rm`, `Remove-Item`, `del`) → "Deleted **x**"; move (`mv`, `Move-Item`) → "Moved **x**"; write (`>`, `>>`, `tee`, `sed -i`, `cp` → "Copied **x**", `mkdir` → "Created folder **x**") → "Wrote / Edited **f**"; then the known programs; then the generic row.
5. **Known programs:** tests (`npm|pnpm|yarn|bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`) → "Ran tests"; `… install`, `pip install` → "Installed packages"; `… build`, `make` → "Built the project"; script runners with a file → "Ran **f.py**"; `-c` / `-e` inline code → "Ran a short script" (no object); `curl`, `wget` with a URL → "Fetched **host**", but with `-X` other than GET, `-d`, `--data*`, `-F`, `-T`, `--upload-file` or `--post-*` → "Sent a request to **host**"; git: status → "Checked git status", diff → "Compared changes", commit → "Committed changes", push → "Pushed changes", pull → "Pulled the latest changes", other → "Ran git **x**".
6. **Flags.** A flag that takes a value is skipped with its value (`-n 20`, `-A 3`, `-C path`, `-maxdepth 2`, `-name` is the pattern). Read verbs take the **last** path-like argument.
7. **Kind follows the words, the pane follows the tool.** A command that earns "Read", "Listed" or "Searched" has kind read, list or search (so it folds with other look-ups, which matters on Codex where everything is a shell call); every other command has kind `command`. Whatever its kind, a shell execution always opens to the terminal block.
8. **Generic row.** "Ran **ffmpeg**": the program's basename, shown only when it matches `[A-Za-z0-9._-]{1,24}` after masking; otherwise "Ran a command". Never raw text.

Witness table (the build asserts every line, and adds the 27 commands of Sean's own block):

| Command | Row |
|---|---|
| `ls ~/.sable/ \| head -120` | Listed **.sable** |
| `cd ~/proj && npm test` | Ran tests |
| `head -n 20 notes.md` | Read **notes.md** |
| `grep -A 3 foo src/core.ts` | Searched files for **"foo"** |
| `git -C /p status` | Checked git status |
| `find . -name '*.md'` | Found **\*.md** |
| `cat "My Notes.md"` | Read **My Notes.md** |
| `rg "a\|b" dir` | Searched files for **"a\|b"** |
| `bash -lc "npm test"` and `/bin/zsh -lc 'npm test'` | Ran tests |
| `python3 -c "import os"` | Ran a short script |
| `timeout 60 npm run build` | Built the project |
| `env X=1 node server.js` | Ran **server.js** |
| `npx vitest run` | Ran tests |
| `powershell -Command "Get-Content notes.md"` | Read **notes.md** |
| `cmd /c dir C:\Users\me\Docs` | Listed **Docs** |
| `ls ~/exports && rm -rf ~/exports/old` | Deleted **old** |
| `find ~/x -name '*.csv' -delete` | Deleted **\*.csv** |
| `cat a.txt > b.txt` | Wrote **b.txt** |
| `grep -l foo * \| xargs rm` | Deleted files |
| `mv draft.md final.md` | Moved **draft.md** |
| `cp a.md b.md` | Copied **a.md** |
| `mkdir -p out/reports` | Created folder **reports** |
| `sed -i 's/a/b/' config.yml` | Edited **config.yml** |
| `npm install` and `pip install requests` | Installed packages |
| `curl -s https://example.com/hook/abc123` | Fetched **example.com** |
| `git commit -m "msg"` | Committed changes |
| `ffmpeg -i in.mov out.mp4` | Ran **ffmpeg** |
| `sudo systemctl restart nginx` | Ran **systemctl** |
| `tail -f log.txt \| grep ERROR` | Read **log.txt** |
| `sort -o data.csv data.csv` | Ran **sort** |
| `curl -X DELETE https://api.example.com/items/42` | Sent a request to **api.example.com** |
| `Remove-Item old -Recurse` | Deleted **old** |
| 1 MiB of `a-a-a-…` | "Ran a command", labelled and masked in under 50 ms |

### 4.4 ACP: label from structure, never from `title`
Across six ACP agents the `title` is developer text, a raw command or a wire name (`run_terminal_cmd`, ``Read `x` (1 - 50)``, `Tool: server/tool`). **It is never shown on a row and never picks the kind.** It is kept, masked, in the detail. For ACP the label comes from, in order: (1) `rawInput.command` → a command, by §4.3; (2) ACP `kind`: read → read, edit → edit, delete → "Deleted **x**", move → "Moved **a**", search → search, fetch → web, execute → command; (3) the `fuigo/tool` stamp's kind when ACP `kind` is `other` or `think`; (4) the tool name in the table (Fuigo's `run_terminal_cmd`, `search_replace`, `use_tool`, `memory_search` are in it). The object is `locations[0].path` (basename) when present, else from `rawInput`. Witness: the six real title shapes of REFERENCE.md table a.2 for a read, an edit and a shell call each give "Read **notes.md**", "Edited **core.ts**", "Listed **notes**".

## 5. The view
### 5.1 The live line (collapsed, the default)
```
[dots] Running commands · step 12 · 1m 12s                         [›]
       Searching files for "Poindexter"
```
- **Line 1, the header** (today's "Worked for" pill): `WorkingDots` in the accent, the **phase**, "step N" (top-level steps started), the turn's worked time, a chevron. `tabular-nums` on the numbers.
- **Line 2, the now-line**: always present while the group is live **and collapsed** (an open list already shows the same row, so it is not drawn twice), fixed height, one line, ellipsis. It shows the newest of: the running step's own row text, or the latest note. It is why the collapsed line answers "what is it doing" without opening anything.
- **Line 3, the plan row**, only when the bot has a plan (§5.4).
- The mascot sits at the left of the live line, where its label used to be.
- **Phase** = the group form of the most recently started open step: "Running commands", "Reading files", "Editing files", "Searching", "Searching the web", "Reading the web", "Working in Gmail" ("Working in your connected apps" when two or more apps are open), "Asking Kessler", "Running a helper", "Using the browser", "Using the phone", "Using the computer", "Checking memory", "Updating the plan", "Working". With no open step for 1.5 s: "Thinking". While the reply streams: "Writing". A phase is held at least 1 s so the pill does not flicker.
- **Waiting wins.** Any step `waiting` (in this group or in a child, §5.6): steady amber `Pause` icon, "Waiting for your OK" or "Waiting for your answer", **no clock** (nothing is running). The now-line says what is asked: "Wants to delete the folder **old-exports**". The header still only opens and closes the list.
- **Stopping.** "Stopping…" shows in the window where Stop was pressed, from the press until the group next changes state. Confirmed Stop → "Stopped after …" everywhere. A turn that ends without a confirmed Stop is `interrupted` ("Interrupted after …"); a turn that goes on returns to its live phase.
- **Finished headers.** "Worked for 5m 35s · 27 steps", plus "· 1 failed" in the danger colour and "· 1 not allowed" in grey. Stopped: "Stopped after 2m 10s · 9 steps". Ended without a result: "Interrupted after 2m 10s · 9 steps" (the error card under it says why). Worked time excludes time spent waiting on the owner. Counts are top-level steps.
- **Several groups in one turn.** Long interim text splits a turn into groups. Each finished group shows its own span; only the last is live; the No limits line (§8) appears once, on the turn's last group.
- **Clock.** The client ticks from `startedAt` and `waitMs` using the server's `now` from the last snapshot or frame as the offset, so a phone whose clock is 30 s off is still right. One shared 1 s ticker per on-screen live group.

### 5.2 The open list
Press the header → one row per step, in order. List width is capped at 40rem. No scroller inside the chat.
```
[icon] Verb object                                   status-or-duration [›]
```
| State | Icon slot | Words | Right column |
|---|---|---|---|
| Running | `WorkingDots`, accent | present form | nothing: the header's clock is the only one that ticks (P1). The step's time shows when it ends |
| Done | the kind's icon, grey | past form (+ `+12 −3` on edits, + a grey result such as "3 matches") | duration, only when 2 s or more |
| Failed | lucide `X`, danger | past form | "Failed" in danger |
| Waiting | lucide `Pause`, warning | want form | "Waiting for your OK" / "Waiting for your answer" in warning |
| Not allowed | lucide `Ban`, grey | wanted form | "Not allowed" in grey |
| Stopped / No result | lucide `Square` / `Minus`, grey | past form | "Stopped" / "No result" in grey |
| Note | none | the note, grey, normal weight, on the text column | |
Status is always a word, never only a colour. Done rows carry a quiet kind icon instead of a tick, so colour is left for the rows that need the eye. One icon per kind (lucide): command `Terminal`, read `FileText`, write `FilePlus`, edit `Pencil`, delete `Trash2`, move `FolderInput`, search `Search`, list `FolderOpen`, web `Globe`, app `Plug`, skill `BookOpen`, helper and ask `Bot`, handoff `Forward`, question `MessageCircleQuestion`, memory `Brain`, browser `AppWindow`, phone `Smartphone`, computer `Monitor`, other `Wrench`, quiet run `Layers`, plan `ListChecks`, thought `Lightbulb`.
- **Quiet runs fold (so 40 steps are not a wall).** Four or more consecutive **done** rows of the look-up kinds (read, list, search, web search, web read, memory search), with no note between, show as one row that opens to them in place: "Read 12 files", or "Read 5 files, searched 2 patterns" for a mixed run, with the summed time. **Commands, edits, deletes, moves, app actions and helpers never fold**: each thing that changes something keeps its own row. Running, failed, waiting, not-allowed and stopped rows never fold and break a run. In a live group the newest row is never inside a fold. Folding is display only and keyed by the first row's `seq`; `turn_steps` keeps one row per call, so every call still appears exactly once, one level down (P4). Decision D5.
- **What was done, in one line.** A finished list starts with a grey line naming the work by its most consequential kinds: "Edited 2 files, ran 4 commands, read 14 files" (distinct files; commands counted, never quoted). The header keeps Sean's wording, "Worked for 5m 35s · 27 steps". Decision D4.
- **Length.** A live list shows the newest 12 rows under "Show 28 earlier steps". A finished list shows the first 30 rows and "Show 170 more steps". A list longer than 12 rows ends with a quiet "Hide steps" button. Rows are virtualised only past 200 mounted.
- **Empty and partial.** "312 earlier steps not kept" starts a list whose ring has dropped rows. A group whose rows cannot load says "Steps aren't available right now" with Retry.
- **Finished group's last line** is the No limits line when it applies (§8).

### 5.3 The detail panes (P3)
A row with a chevron always opens something real. Panes are the app's shared code block (`ChatMarkdown` block: `bg-inset`, hairline border, language label, line count, Wrap, Copy, the Shiki light and dark themes). Copy copies the masked text. A pane first shows at most 12 lines, then "Show all 240 lines" (up to the kept size); the button appears only when lines are hidden; no fixed-height scroll trap.
- **Command → a terminal block.** First line `$ <the full masked command>`, wrapped, shell-highlighted; under it "in ~/proj" in grey when the folder is known. Then the output, **the last 12 lines first in view** (the end is where the answer and the error are), with "Show all". Empty output reads "(no output)". Success shows only the time in the footer. Failure adds "Exit code 1" or "Timed out" in danger and a danger left edge on the block, not red body text. "Stopped" is neutral. A cut output says "Showing the first 8 KB and the last 24 KB · 1,240 lines not shown".
- **Edit → a diff.** One section per file: the file name (parent folder in grey), `+12 −3`, then a unified diff: added lines on `success-soft`, removed on `danger-soft`, each with a `+` or `−` gutter character so it does not depend on colour, line numbers when the engine gives them, 3 lines of context, longer unchanged runs collapsed to "40 unchanged lines". With several files the first is open. The raw arguments are a second, closed "Request" disclosure under the diff. A new file shows as highlighted content, not as a diff. Sources: Claude `old_string` / `new_string` (MultiEdit: each pair), Codex per-path unified diffs, ACP `diff` content; the client computes the line diff where only old and new text exist.
- **Write** → "Created" (or "Replaced") and the file text highlighted by its extension. **Read** → the path chip and range, then the text read. **Search** → the pattern and where, then the matches, or "No matches". **Web** → the full masked URL, then the page text. **Connected app** → the action as JSON, then the result; the footer says "Connected apps: Gmail · Fetch emails" and never a vendor name. **Anything else** → Request (JSON) and Response.
- **Other tools show the head** (first 12 lines); commands show the tail. One rule each, everywhere.
- **File chips.** `locations` (ACP) and paths show as chips above the pane: basename with the parent folder in grey, the path relative to the bot's folder (`~` for home) in `title`, and Copy path. A masked turn stores none.
- **Footer line** (grey, micro size): how it was allowed ("Ran without asking (No limits)", "You approved this", "Allowed by your rule", or nothing), then the tool name. Not allowed: "You didn't allow this", "Blocked by your rule", "Closed with no answer", or the refusal's own message.
- **States, each with its own words.** Running or waiting: the Request pane only, then "Output appears when the step finishes" (or the live tail on engines that stream, §6.5). Loading: nothing for 300 ms, then one skeleton line. Failed with no output: "Failed with no output" and the error line. Withheld: "Not shown: too large to check for secrets (3.2 MB)", "Binary output (12 KB), not shown", "Image, shown in the chat". Not kept: "Details weren't kept" (cap, restore, or setting Off). Hidden turn: "Details are hidden for this turn". Fetch failed: "Details aren't available right now" with Retry. Engine gave nothing: "Request unavailable" / "Response unavailable".

### 5.4 The plan row
```
[list] Plan · 2 of 5 done · Compare October with September          [›]
```
One per group, kind `plan`, never counted as a step. Its text is the count and the in-progress entry ("Plan · all 5 done" at the end). It opens to the checklist the LivePlanCard draws today: done items struck through with a check, a still accent dot for the item in progress, an empty circle for pending, a grey X for cancelled. Each update replaces the whole list (one frame per update); priority is never drawn. While the turn is live it sits under the now-line, visible with the group collapsed; afterwards it is the first row of the list, right under the summary line, so the plan of an old turn can still be read. Entries go through the projector like any text (at most 50 entries of 200 chars). Decision D6: it starts as one line; say "keep it open" and it starts open while live, as the card does today.

### 5.5 Thinking
Phase "Thinking" on the header. In the list, one thought segment (the reasoning between two other events) is one row, kind `thought`: "Thinking" with the running dots while it streams, then "Thought for 12s". A segment under 2 s makes no row. The row stores its label and times only. It opens to the reasoning text only where the app holds that text today (the live turn, as the LiveThinking chip does); otherwise it has no chevron. Thought rows are never counted, never start a new group, and are never notes (§3.5). Keeping reasoning text with the turn is parked: it is a new data surface.

### 5.6 Helpers and other bots: three different things
All three carry `childRef`, read under the same authorisation as any step read (§7.5), checked again on every child read.
1. **A helper inside the turn** (Claude `Task` / `Agent`, Codex collab agent, ACP sub-session). Row "Running a helper: **Find vendor files**" → "Ran a helper: **Find vendor files** · 14 steps". Its steps are a **child group in the same thread**. Opening the row shows them indented one level, loaded only then. Child rows that arrive before the parent row wait in their child group and are linked when the parent arrives; if the parent row was dropped by the ring, the children show under a grey "Earlier helper" heading. A helper's steps count toward the turn's caps (§6.4), not the header's count.
2. **`ask_bot`** runs the other bot in **its own conversation** and waits at most 15 s (`ASK_BOT_TIMEOUT_MS`). Row "Asking **Kessler**". While Kessler's turn is live the row has a grey second line with Kessler's own phase ("Kessler: Searching files"). After the hand-back the row reads "Asked **Kessler** · still working" until Kessler's turn ends, then "Asked **Kessler** · 2m 10s". Opening it shows Kessler's group read-only, plus "Open Kessler's conversation" only where today's comm chip can open it (never on the phone when the channel is Mac-only, and never for a hidden helper thread: there the row has no chevron).
3. **`delegate_bot`** queues work that runs **after** this turn. Row "Handed work to **Kessler**", no nested steps, the same link. The work shows later as Kessler's own turn in Kessler's conversation.
- **Waiting crosses the delegation.** If a child is waiting on the owner, `child.state` is `waiting`: the row's second line is amber "Kessler is waiting for your OK", and the parent header becomes "Waiting for your OK". The server sends a child summary only when its state or phase changes, at most once a second. The summary is a phase key and a count, never an object, so nothing from another conversation's files or searches is copied into this one.
- A helper inside the turn also gets the grey second line while it runs (its phase), and reads "· 14 steps · 1m 02s" when done; an asked bot reads "Asked **Kessler** · 12 steps · 2m 10s" when its turn ends.
- One level is shown inline. Deeper levels are the link.
- Witnesses, one per kind: an engine helper (Claude, Codex, Fuigo), `ask_bot` answered inside 15 s, `ask_bot` handed back and still working, `delegate_bot`; plus interleaved sibling calls, a child before its parent, a parent dropped by the ring, a child waiting on the owner, and two bots working at once in a room.
- **Rooms.** Each bot turn has its own group, under the `RoomSpeakerLabel` that already starts that turn; no avatar on the pill. The header's accessible name starts with the bot's name. Parallel turns never share a group.

### 5.7 Cards and approvals (unchanged in place)
Approvals stay where they are today: the panel above the composer (`PendingApprovalQueue`: "N requests waiting", Allow once, Don't allow, Approve all) and the one-line `ApprovalWaitingRow` in the transcript ("{bot} is waiting for you." with Answer). That row renders directly **under** the group, never inside it, whether the group is collapsed, open or Off. Question cards and wipe cards stay inline under the group. The step row has no buttons (P7), and the header and rows only open and close. The way to the panel is the waiting row's existing "Answer" button, directly under the group; a question is answered in its inline card, also directly under the group.

### 5.8 Scroll rules
1. Opening or closing a group or a row by hand **breaks follow mode** and keeps the pressed row at the same place on screen (the existing row-anchor capture and restore). "Jump to latest" re-arms follow, as today.
2. New rows never move the viewport unless follow is armed.
3. "Open while working" closes a group at turn end **only if the owner never touched it**, with the viewport anchored on the reply. A group the owner opened stays open.
4. Closing a group whose header is off screen scrolls the header into view first.
5. Focus and scroll anchors survive row insertion, ring eviction and a detail changing height.
Witnesses: press a row at step 10 of a live 40-step fixture and its top offset is unchanged after 5 more steps; auto-close does not shift the reply.

### 5.9 Tokens and components (Dark and Light)
No colour, radius or font literal in StepsGroup. Both skins come from the same tokens in `src/styles.css`; the mockup uses them verbatim.
| Part | Token / component |
|---|---|
| Header pill | today's "Worked for" pill, unchanged: `rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control`, focus ring as it has |
| Live dots, live clock | `WorkingDots`, `text-accent-text` (Forge Orange `#ff8255` in Dark, `#a83c14` in Light) |
| Verb text, durations, notes, footers | `text-ink-secondary` (the only grey; there is no third ink) |
| Object | `text-ink`, semibold |
| Failed | `text-danger`; failed pane: `border-danger` left edge |
| Waiting | `text-warning`; a waiting header pill sits on `bg-warning-soft` |
| Not allowed, stopped, no result | `text-ink-secondary` |
| Edit stat, diff lines | `text-success` / `text-danger` on `bg-success-soft` / `bg-danger-soft` |
| List rule, pane border | `border-hairline/40` |
| Panes | the shared code block on `bg-inset`; masked spans on `bg-control` |
| Icons | lucide at the transcript's sizes: `size={13}` in the pill, `size={14}` in rows, default stroke; chevron = `ChevronRight` with the existing `rotate-90` |
| Type | chat 15, rows and pill 13, code 13 (the shared block), right column 12, footers and pane chrome 11; the app's sans and mono stacks; no half-pixel sizes |
| Focus | `:focus-visible` with the house ring (`--color-focus`) |
| Motion | `WorkingDots` and `animate-status-pulse` only; both already honour reduced motion |
The build's evidence includes screenshots in both skins at 1280 and at 390, and the build-time contrast check passes.

### 5.10 Phone (the app's real breakpoint, `max-width: 767.98px`)
1. **One line per row.** Glyph left, verb + object as one ellipsised line, a fixed right column for the status word or duration and the chevron. No forced second line, no hint.
2. If a status phrase does not fit ("Waiting for your OK"), it goes to a second line **aligned with the text column**, in its colour. Only waiting, failed and not-allowed rows can be two lines.
3. Header segments never break inside (`white-space: nowrap` per segment). At narrow width the pill shows "Worked for 5m 35s · 27 steps" and the failed / not-allowed counts sit on a second line inside the pill.
4. Rows and the header use the existing `.tap-area` (44 px under a coarse pointer).
5. Detail panes open full width under the row; code wraps by default.
6. The phone gets rows by polling (§6.3); it shows no live tail in 1.0.22.

### 5.11 Keyboard and screen reader
- The header is a native `<button aria-expanded>`. The plan row, while it sits under the now-line, is a button and its own tab stop. The list is one tab stop with roving focus: ↑ / ↓ move, Home / End jump, Enter or Space opens or closes the row, → opens, ← closes, Esc closes the group and returns focus to the header. Focus survives virtualisation and new rows.
- Every row is a native button whose accessible name carries the status: "Done. Read notes.md. 2 seconds." / "Failed. Ran tests." / "Waiting for your OK. Wants to delete old-exports."
- Announcements (one live region per group): "started working" (polite), **"waiting for your OK"** (assertive: it needs action), a failure (polite), the finished summary (polite). Never a tick, never every step.
- Copy, Wrap, Show all, Hide steps and Retry are real buttons. Icons are `aria-hidden`; no icon stands without words.

### 5.12 Languages (en, de, es, fr, hi, ja, pt-br, zh)
- Every string is a key in all eight locale files in the same push; the locale parity test covers them. Nothing is built by concatenating English.
- The 1.0.22 client renders the header from the group's `counts` with keys (`…One` / `…Other`); the stored header text is only for older clients.
- Lists ("Read 5 files, searched 2 patterns"; "Edited 2 files, ran 4 commands") are translated parts joined with `Intl.ListFormat(locale, {type:"conjunction"})`.
- Objects and names are wrapped in `<bdi>`. Word order belongs to the translation (`{object}` may come first).
- "Ran without asking (No limits)" and the other No limits strings are checked against `copy-frozen-names.test.ts`; "connected apps" wording is checked by `no-composio-in-user-text.test.ts`.

### 5.13 Settings (Settings → Bot defaults; the "Tool calls" card becomes "Steps")
- **Steps: Collapsed (default) · Open while working · Off.** Stored as `features.stepsView`. The old boolean `features.showToolCalls` keeps its key and value and is read only while `stepsView` is unset: `true` → Open while working; `false` → Off; never set → Collapsed. Every existing "Show tool calls" switch becomes this control.
- **Off keeps the chat as quiet as it is today, and keeps the trace.** Under Off there is no step line, the six indicators of §1 show as today, nothing is folded, and rows are still recorded. One thing still shows, because it shows today with tool calls off: a turn in which steps ran without asking gets the one-line trace, in the words of §8 ("No limits: all 27 steps ran without asking you ›"), which opens the list.
- **Fold short in-between messages into steps** (on). **Step details kept** (Advanced): Off · 250 MB · 1 GB (default) · 5 GB.
- **Voice.** The spoken line is the label's `spoken` form, which has no object ("reading a file"), as today. File names and search terms are never read aloud.

## 6. Storage, sync, lifecycle and limits
### 6.1 Three tables, two files
- `messages.db`: `turn_steps` (as built) and new `turn_step_groups (thread_id, group_id, turn_id, rev, state, started_at, ended_at, wait_ms, counts, first_retained_seq, last_seq, parent, last_of_turn)`, primary key `(thread_id, group_id)`. Both are registered in the schema additions, `ADDED_TABLE_LIFECYCLE` and the downgrade list, and are deleted in `mdb.deleteThread`'s transaction.
- `step-details.db` (a sidecar; the only place tool output is kept): `step_detail`, with `secure_delete=ON`, WAL, `auto_vacuum=INCREMENTAL`.
- **Commit order.** Every change is one `messages.db` transaction: the step row, the group row (`rev`, counts, state, `first_retained_seq`) and, at group start and end, the transcript anchor message. **Then** the frame is published. A frame is never sent for a change that is not committed. The detail write follows; it is recoverable and never gates the row.
- **The anchor message** is one `kind:"activity"` message per group with `tool.stepsRef = {groupId}` and `tool.name` = a generic line in the app language ("Worked for 5m 35s · 27 steps"): a phase, a time and counts only, never an object. An older client shows it as the chip it knows.
- **Detail writes.** At step start: the masked request (so a running step opens to its Request). At step end: the masked response. A detail is served only when its step row is committed, the reader is authorised and the sidecar row exists; anything else is a `withheld` reason, never an error page.

### 6.2 Deleting and bounding
- **Deleted with the chat, room, task and bot.** The details hook stays where the builder put it: in `message-db.ts deleteThread`, right after the transaction that deletes the step rows. Every delete path reaches that function: `store.deleteThreadRecord` (chat, room, task, bot) **and** the boot deletion triage, which calls it directly and does not go through `deleteThreadRecord`. r2 named `deleteThreadRecord` as the funnel; that was wrong and moving the hook there would leave details behind after a delete finished at boot.
- **Write fence.** A detail write checks the thread's deletion marker and the store epoch (§6.3) inside its own transaction and writes nothing for a thread that is being or has been deleted. A turn that finishes during a delete therefore cannot re-create output.
- **Boot order.** Deletion markers are processed first and **awaited**; then open groups of turns with no live engine are closed (`no_result` rows, state `interrupted`, counts recomputed from `turn_steps`, anchor patched once); then a sweep deletes every detail whose `(thread, group, seq)` is not a committed step row (this covers deleted threads **and** rows the ring dropped). Step routes answer only after that.
- **After every delete** the sidecar gets the WAL scrub `messages.db` gets (checkpoint, then prove the bytes are gone).
- **Cap.** "Step details kept" bounds the **payload** bytes (a running total updated with each write; oldest details evicted in batches of 64; the row stays and opens to "Details weren't kept"). The **physical** budget is separate and stated: file + WAL ≤ cap × 1.25 + 64 MB, kept by a checkpoint after each eviction batch and incremental vacuum of at most 256 pages per pass, off the turn's path. The builder measures both and writes them in DONE. Lowering the cap evicts at once, in paced batches.
- **Crash witnesses.** A hard kill between each pair of steps in the commit order (row commit, frame, detail write), a delete during a turn's finalisation, a cap reduction under load, and a restore or downgrade followed by a delete: each ends with no detail for a missing step, no step frame for an uncommitted row, and counts equal to the rows.
- **Not in backups, sync, diagnostics, feedback or logs.** Step text, masked or not, is never written to a log line.
- **Backups.** As r2: explicit `excluded` inventory entries for the file, `-wal` and `-shm`; the snapshot's membership check ignores them; restore and erase delete the file and mint a new epoch.

### 6.3 Sync: snapshot first, frames after (`steps.v1`)
- `GET /api/threads/:threadId/steps/:groupId?after=<seq>&limit=200` returns `{v:"steps.v1", epoch, now, group, asOfRev, rows, nextAfter}`. `epoch` is a random id minted when the step tables are created or restored. `group` carries state, counts and `firstRetainedSeq`. The page is read in one transaction, so `asOfRev` is consistent with its rows. `?match=<text>` returns the `seq` of up to 50 rows whose `search_text` matches (for a search hit).
- `GET …/steps/:groupId/:seq/detail` → one `StepDetail`.
- `POST …/steps/:groupId/:seq/tail` → subscribe or unsubscribe this connection to a running step's live tail.
- **Frames.** `step.upsert {step}` and `stepgroup.upsert {group}`, each ≤ 512 B (cut `object` first, then `error`), each carrying `epoch` and `now`.
- **Client rules.** (1) A frame is applied to a row only if its `rev` is newer than the row's. (2) On mount, on SSE reconnect, on wake and on an `epoch` change, the client refetches a snapshot for each group that is live or open, **buffers frames while it loads**, then applies the buffered frames newer than `asOfRev`. It never trusts a `sinceRev` filter to repair a gap. (3) `firstRetainedSeq` moving up drops the rows below it. (4) A 404 for a group removes it, except on a child read: there the parent row stays and its pane says "Kessler's steps aren't available"; an epoch change clears every cached page, detail and tail. (5) Cached groups and details are disposed when the conversation changes.
- **Phone.** A paired phone gets no step frames. While a live group is on screen and the page is visible it polls the snapshot route every 2 s (5 s after two minutes), and once when the turn ends.
- Witnesses: a gap, a reorder, a duplicate frame, ring eviction, group deletion, a server restart and a restore, each **during paging**, leave the client equal to a fresh snapshot.

### 6.4 Size limits (per turn, across all its groups and child groups)
- Request kept up to 16 KB. For an edit or write, each file's before and after text is masked, then cut to 16 KB each, before the diff is computed; diff bodies count toward the turn's 8 MB. Response kept as head 8 KB + tail 24 KB of the already masked text, cut on line boundaries.
- A turn keeps at most 8 MB of detail; later steps keep their row and read "Output not kept: this turn is very large".
- A turn keeps its newest 5,000 rows across all its groups and child groups (a ring; dropping a row deletes its detail and advances that group's `firstRetainedSeq`). Header counts stay exact because they live in the group row.
- A helper bot's steps (`ask_bot`, `delegate_bot`) live in the helper's own thread under its own caps.

### 6.5 Live output (only where the engine streams it)
Two engines stream: Codex (`item/commandExecution/outputDelta`, new driver work) and Fuigo sends an in-progress `tool_call_update` about every 100 ms carrying the **whole buffer** (today's emit, MAIN-RULING 14:59Z). In 1.0.22 Murage does not set `fuigo/incrementalBashOutput`. It takes the new text from the cumulative buffer by the rule of §3.6 F11, never by concatenating, and those frames never write a row (§3.6). An open running step shows the tail if its engine streams; otherwise "Output appears when the step finishes." The tail is released text only (§7.4); frames are ≤ 4 KB, at most 4 a second, sent on the subscriber's own connection, never through the shared replay buffer, and the subscription ends on disconnect, revocation or step end. Desktop only. This is the last build item; the design is complete without it.

### 6.6 Search
The group's anchor message is already indexed by `tool.name`. At group end the server adds the group's distinct label words (each row's `search_text`, in the app language, at most 2 KB, nothing from a masked turn) to that message's indexed text (`message-search-index.ts`). A hit therefore lands on the group through the existing result path, follows the message's branch visibility and is removed with the message. The client opens the group (`forceOpen`) and asks `?match=` for the rows to scroll to and mark.

## 7. Privacy: project first, then cut, then store or send
### 7.1 One projection
StepLog takes the tool's request and result **at the internal execution fold**, before the outgoing event projector that drops results. Everything that leaves StepLog (a row, a frame, a detail, `search_text`, the anchor text, a spoken line) goes through one projector, in this order: (1) parse structure, (2) apply the turn's audience mask, (3) scan and mask every string, (4) cut to the kept size, (5) store or send. **Every displayed string is covered**: label object, app and action names, the tool name, error, locations, cwd, Request and Response fields.
### 7.2 How text is scanned
- **Per value, not per blob.** Each string value of the arguments is scanned on its own; the label is built from that structure; the pretty-printed JSON is assembled afterwards from masked values. (Today the builder scans the indented blob, where one `token:` word masks everything after it and the label falls back to "Ran a command".)
- **A label word masks its value to the end of its line**, never beyond.
- **Windows.** Text is scanned in 16 KB windows cut on line boundaries, with a 1 KB overlap, the multi-line private-key rule carried across windows, and a separate budget per window. A window that cannot be checked is replaced by "Part of this output isn't shown (16 KB couldn't be checked)". The whole text is withheld only when it is binary or over 1 MiB.
- **Linear time.** No rule may backtrack on a long run: bounded quantifiers or a hand scan. Witness: a 1 MiB `a-a-a-…` argument is labelled and masked in under 50 ms; a 64 KB build log containing `task-`, `disk-` and `npm_config` is shown in full; a private key across a window edge and across the 8 KB cut is masked whole.
- Scanning runs off the event fold in paced slices; pending text is capped at 64 MB per process (beyond that a step's output is withheld as too large).
### 7.3 Rules the step scanner has (each with a witness)
The existing composite scan (`scanTurnText`: provider tokens, bearer, JWT, private keys, `basic-auth-mask`, `financial-ids`, JSON keys matching `isSecretName`) **plus**, added in `step-redact.ts`: `Cookie:` / `Set-Cookie:` header values; URL query values for `token key sig signature code auth session jwt apikey x-amz-signature x-amz-security-token`; `user:password@` in URLs (built); `-u user:pw` (built); `-p<pw>`, `--password <pw>`, `sshpass -p <pw>`; `NAME=value` for any name matching `isSecretName`, **with no length floor**; `sk_live_` / `rk_live_` keys; `/bot<digits>:<token>/` URL paths; `.netrc` `password` fields. §6's r2 claim that `bot-package-scan` rules apply is withdrawn: they are not reachable from the scan.
**By construction, not by pattern:**
- A web row shows the **host only**. The path, where a webhook or magic-link secret lives, is never in a label, a frame, `messages.db` or `search_text`.
- **Typed text is always masked.** For `browser_type`, `fill`, `type_text` and their kin, the Request shows `text` as "•••••• (7 characters)".
- The generic command row shows a program name only when it is a plain name (§4.3 rule 8).
- A search pattern shown in bold has been through the scan like any other string.
- The spoken line never has an object (§5.13).
### 7.4 Live tail
Deltas feed one scanner per running step from the first byte: the release policy the reply text uses (`createTurnTextPolicy`), extended with the §7.3 rules, so the tail and the final detail mask the same things across line and delta boundaries. It releases only complete, checked lines. If it latches, the tail stops: "Live output hidden; it shows when the step finishes, if safe." At most 8 live scanners per turn and 32 per process; beyond that a step simply has no tail. At step end the final scan replaces the tail.
### 7.5 Who can see steps
- **Routes**: class `companion` (the desktop, or the phone's forwarded launch proof), **and** current access to that thread, checked independently, on every request, including each child-thread read and each tail subscription. A revoked phone is refused on its next request.
- **Frames**: `step.upsert`, `step.output` and `stepgroup.upsert`, scoped by exact kind (the existing room events `group` and `group.deleted` are untouched), go to **desktop connections only** (as built) and are **never added to the shared SSE replay buffer**. An ordinary conversation stream, a local door caller with access to the same thread, an MCP caller, a scoped Cloud stream, another bot and every outbound channel (WhatsApp, Telegram, webhooks) receive no step frame.
- **Masked turns** (`bus.audienceMaskedFor(event)`, default masked for an unknown event): stored and framed **verb only**: no object, no stat, no error, no locations, no detail (`withheld:"masked-turn"`), nothing in search.
- The anchor message and search hits carry only what §6.1 and §6.6 allow, so the transcript and search projections need no new rule.
- Witnesses: a door caller with access to the same thread gets no step route, no step frame and no replayed step frame; a revoked phone gets 403 on its next poll; a hidden helper thread is not readable through `childRef`; a masked turn's row, frame and search text have no object; "Copy" copies masked text.

## 8. No limits wording (no new prompt, ever)
The header never says "Approved". The last line of a finished turn's open list counts the steps whose ask was answered automatically (`auto`, §2): **"No limits: 27 of 31 steps ran without asking you."** ("all 27 steps" when equal; "Full access: …" likewise.) It links to Settings → Access. If some automatic ask could not be tied to a step (`unattributed` above zero) the line drops the numbers: "No limits: steps in this turn ran without asking you." The Off trace (§5.13) uses the same words. It appears once per turn, on the last group, and counts the turn's own steps (the same steps the header counts); a helper's steps are counted on the helper row. Under Steps: Off it is the one line that still shows (§5.13). Wipe cards are unchanged and stay outside the group. The decision log keeps one row per ask.

## 9. Performance at scale (murage-design-for-extreme-scale)
- **Server, per step:** a fixed number of indexed writes and at most two small frames, whatever the turn length. No history scan, no array copy. Eviction, the ring and vacuum are amortised and paced off the turn's path.
- **Bounded state:** token map (§3.2), live scanners (§7.4), pending scan bytes (§7.2), per-turn rows and detail bytes across split groups and child groups (§6.4).
- **Client:** a collapsed group renders its header and now-line only. An open group mounts at most the rows of §5.2; pages of 200; at most 3 pages and 20 details cached per group, disposed on conversation change. An upsert re-renders its row and the header through keyed subscriptions, without copying the list.
- **Witnesses (repo scale rig, `scripts/scale`):** the 600-step fixture plus a concurrent long-output workload assert: statements and frames per step are equal at step 10 and step 600; every frame ≤ 512 B; an open 600-step group mounts ≤ 60 row nodes before "Show more"; one upsert re-renders one row and the header. They also **measure and record** (numbers in DONE, with the rig's budgets): physical `step-details.db` + WAL size against §6.2, server heap, event-loop lag while scanning (budget: no slice over 50 ms), first paint of a reopened chat, scroll and typing latency with a live 600-step group, and reopen time. 20 bots × 600 steps stay within the cap's physical budget.

## 10. Old chats (before 1.0.22)
A client-side adapter, run only for rows that are mounted. No stored data is rewritten.
- Old `tool.steps: string[]` lines (one per **approval**, not per call) become a group with the header "27 steps" (no time was stored). Each `"Tool: summary"` line becomes a done row labelled by the same table. Its stored text is shown as the Request; the Response reads "Details weren't kept for older steps".
- **Adjacent identical lines fold into one row with "×2"**, and the open list starts with one grey line: "From an older version: one line per approval, so a step may appear more than once." This is the honest fix for Sean's doubled lines: they cannot be told from two real identical calls after the fact, so nothing is dropped and the count is shown.
- The old "Approved 27 steps (No limits)" text becomes the header plus the No limits line. Only 200 lines were kept: "127 earlier steps not kept" where the stored count says so.
- Old tool chips of a finished turn fold into that turn's group the same way. The group opens on a find hit (`forceOpen`, which `ApprovedStepsRow` never had).
- With the default now Collapsed, old turns that had chips or approval lines show a header pill. That is decision D3 for Sean.

## 11. Build order (each item RED first)
0. One un-masked turn of the Fuigo that dev/1022 bundles, with no F-fields and `retryDiscard` absent: read, edit, apply_patch, shell with output and a non-zero exit, a long streaming shell, grep, todo, task, hosted web search (and one retried), a denied ask. Captured to the builder's job dir (never the repo), names and paths neutralised, reduced frames committed as the ACP fixture. Claude and Codex fixtures are recorded frames likewise (§3.4).
1. The capture witness (§2): not started today; it is first.
2. Merge dev/1022 with the three conflicts of §0 resolved, then the r3 corrections to the built server files (§0): the confirmed-Stop fact, matching, identity, group table, commit order, deletion funnel and fence, boot order, redaction rules and windows, linear scans.
3. Labels (§4) with the witness tables, all eight locales.
4. Engine mapping (§3.4) and the today's-Fuigo contract (§3.6) with its witnesses and mutants: Codex, ACP, API, Pi, Antigravity fixtures.
5. StepsGroup per §5 in ChatView and GroupView; remove or fold the old indicators per §1; settings and voice.
6. Detail panes (terminal, diff), plan row, thought row, snapshot sync, phone polling.
7. Old-chat adapter. 8. Helpers and delegation (child groups, `ask_bot`, `delegate_bot`, Fuigo sub-agents). 9. Search. 10. Live tail (Codex and Fuigo).
Evidence for the build: screenshots of the built UI in Dark and Light at 1280 × 800 and 390, the scale numbers of §9, every new test file listed in the CI tier lists. Gate before acceptance: transcript scrolling (§5.8), settings search, rooms and helper paths each have a witness.

## 12. Review closure
Every finding of the three r2 audits (STEPSAUDIT-UX H1-H11, M1-M14, P1-P9; STEPSAUDIT-ASTRA H1-H10 and four Mediums; STEPSREF adopt list) is closed or rejected with a reason in `STEPS-VIEW-1022-R3-DELTA.md`. The r1 closures of r2 §12 stand.

## 13. GAP-CHECK (one adversarial pass on r3)
**Fixed** (kind, promise, scenario):
- (a, P1) Sean runs a turn and sees the mascot line "Reading a file 1m 05s", a "Thinking 12s" chip, a plan card with a spinner, "2 helpers working" and the new pill: two clocks, two wordings. Now one status block; every other indicator is folded, replaced or silenced while a group is live (§1), and running rows carry no clock of their own.
- (a, P2) A bot runs `ls ~/exports && rm -rf ~/exports/old` and the row says "Listed exports"; `sort -o data.csv data.csv` says "Read"; `curl -X DELETE …` says "Fetched". Now a quiet label must be earned by every segment, and the most consequential segment names the row (§4.3).
- (a, P2) On Claude and Codex every Murage tool arrives as `mcp__server__tool`, so "Asked Kessler" read "Used murage: Ask bot", and on Fuigo every row would read "Used a tool" because the first ACP frame is a wire name. Now the tail name and the engine's structure pick the label; ACP titles never do (§4.1, §4.4).
- (a, P3) The owner opens "Edited core.ts" and gets JSON with `\n` escapes, or opens a failed test run and gets 32 KB of log. Now a diff, and a terminal block that starts at the last 12 lines (§5.3).
- (a, P2) A Fuigo bot's tests exit 1 but the engine reports "completed": the row showed done. Now a non-zero exit is a failure whatever the status says; and a call that never ran is "Not allowed", from engine evidence, never from error text (§3.3).
- (a, P4) Two identical parallel calls are asked before their items arrive with no ids: content-keyed provisional rows could never be adopted and left two phantom rows. Now an ID-less ask never opens a row and attaches only on a unique match (§2).
- (a, P7) A hook ask and a CLI ask for one call, or an ask for a todo tool that has no row, made the line read "33 of 31 steps ran without asking you". Now the number is rows tagged automatic, and the line drops its numbers when any ask is unattributed (§2, §8).
- (a, P1) Kessler is waiting for the owner's OK inside an `ask_bot`; the parent header said "Asking Kessler 4:12". Now a child's wait raises the parent header to "Waiting for your OK"; and `ask_bot` after its 15 s hand-back says "still working" instead of a false "done" (§5.6).
- (b, P3) Sean opens a step mid-turn; follow mode pins the chat to the bottom and the pane slides away every second. Now a hand open breaks follow and anchors the row (§5.8).
- (b, P1) Stop is pressed and never confirmed; the header stayed "Running". Now "Stopping…" locally, then "Stopped" only on the receipt, else "Interrupted" (§5.1, JOINT RULING).
- (b, P4/P6) The SSE drops; revision 12 arrives before 11; `sinceRev` skips 11 forever, and a ring eviction or a restore is never noticed. Now snapshot-first sync with epoch, `asOfRev`, `firstRetainedSeq` and frame buffering (§6.3).
- (b, P5) A crash between the row commit and the detail write, or a turn finishing while its chat is deleted, left output with no owner row. Now commit-then-publish, a fenced sidecar write, awaited boot order and a sweep by committed keys (§6.1, §6.2).
- (d, P5) r2 told the builder to move the details delete hook to `deleteThreadRecord`; the boot deletion triage bypasses that function, so a delete finished after a crash would keep Gmail bodies on disk until the next boot. Now the hook stays in `message-db.ts deleteThread`, which every path reaches (§6.2).
- (d, P5) A bot fetches a webhook or magic-link URL: its last path segment (the secret) was in the label, the frame, `messages.db` and search. A bot types a password into a page: it was in the Request. On a call, file names were read aloud. Now host only, typed text always masked, spoken line has no object (§7.3, §5.13).
- (d, P5) A local door caller with access to the thread read step frames from the shared SSE replay buffer. Now step frames are desktop-only by exact kind and never enter the replay buffer; routes check owner proof and thread access on every read, child reads included (§7.5).
- (d, P5) `child.phase` or a helper's row text could copy another conversation's file names into this one. Now the child summary is a phase key and a count only (§5.6).
- (b, P6) A 64 KB build log containing `task-` was withheld as "too large to check", and a 1 MiB `a-a-a-…` argument froze the app for minutes in a quadratic regex. Now 16 KB windows with their own budgets and linear scans (§7.2).
- (c, UX bar) The mockup was dark-only, blue-accented, with Unicode glyphs and a third grey under 4.5:1; at 390 px every row took two lines. Now tokens only, both skins, lucide, one line per row, 44 px targets (§5.9, §5.10, mockup).
- (c, UX bar: nothing relied on disappears) Under r2 an owner who had turned tool calls off lost the "ran without asking" trace, the plan vanished with the turn, and comm chips and done-when receipts were not mentioned. Now Off keeps the trace, the plan row stays in the turn, and those rows are listed as unchanged (§5.13, §5.4, §1).
- (c, room events) A frame named `group.upsert` would have been scoped with the room events `group` / `group.deleted` and broken the phone's sidebar. Now `stepgroup.upsert`, scoped by exact kind (§7.5).
- (a, P8) Forty rows as forty tab stops; a screen reader told about every step; plural and list strings built by English concatenation; a spoken line made by stripping `{object}`. Now roving focus, four announcements, keys with `Intl.ListFormat`, and a `spoken` form (§5.11, §5.12, §4.1).
- (a, P8) Sean's old doubled lines stayed doubled with no explanation. Now identical neighbours fold with "×2" and the list says why (§10).
- (b) Kessler's conversation is deleted and the child read returns 404; the parent row could vanish. Now the parent stays and says the steps are not available (§6.3).
- (e) The collapsed line now names the actual step ("Searching files for "Poindexter""), edits show `+12 −3`, searches show "3 matches", and a finished list starts with one line of what was done.

**Parked (for Sean):**
- Keeping reasoning text with the turn so "Thought for 12s" opens later: a new data surface.
- Opening a file from a path chip; accept or reject on a diff; a side panel of all files changed in a turn; per-step Stop: new surfaces or controls.
- Step frames to the phone over its own stream instead of polling: needs a proof on the event stream that does not exist; polling is the fail-closed choice for 1.0.22.
- Full untruncated output on demand; per-step cost and tokens; model-written summaries: new features (r2 list, unchanged).
- Nesting deeper than one level inline: rare; the link covers it.
- A 1.0.21 hotfix for the duplicate lines ahead of 1.0.22: scope call.
- Fuigo emitter improvements F1-F18: Fuigo 1.0.48 (MAIN-RULING 14:59Z). 1.0.22 renders fully without them (§3.6).
- Live tail on the phone, and for engines other than Codex and Fuigo: they do not stream it.

**Rejected** (one line each): one decimal on short durations (one format); folding commands, edits and app actions (things that change something stay visible); "Failed · exit 1" on the row (plain word on the surface, code in the pane); a note from the first line of raw reasoning (not narration); approvals inside the step card as Zed does (Murage has a docked queue with Approve all); the most-consequential-work wording in the finished header (Sean's own wording stays; the breakdown is the first line of the list).

### 13.1 GAP-CHECK r3.1 (one adversarial pass: refresh vs dev/1022 6d4b5932a8, build 9c156c2fad, MAIN-RULING 14:59Z)
**Fixed:**
- (c, JOINT RULING; P2) Sean's room bot hits the room deadline, or the stall watchdog cancels a hung Fuigo turn. The ACP core settles both as `cancelled` (`core.ts:~8050`), and the build's `stepHub.finish(…, terminalOutcome === "cancelled")` turns every open row "Stopped". The chat now claims an owner Stop that never happened. Now the confirmed-Stop fact comes from `confirmedStopGenerations`, read before consume; anything else is "Interrupted" (§0 merge note, §3.3).
- (b, P6/P1) A Fuigo bot runs a 2 MB build. Fuigo resends the whole buffer every 100 ms (today's emit). Under r3's "fields present replace the stored ones", each of ~600 frames was a row write, a 512 B frame and a detail rewrite: the 600-step-smooth promise breaks on one command. Now output-only in-progress updates write nothing; the Response comes from the completing frame (§3.6 F11).
- (b, P2) A rate-limited Fuigo turn with no `retryDiscard` retries during a hosted web search. The voided attempt's row spun until turn end, or turned red "Failed" with no output (only the `retryDiscard` path closes it today). Now the driver closes hosted rows at every `retrying`, and `HOSTED_ROW_INTERRUPTED` reads "No result" (§3.6 F13).
- (a, P2; ruling) r3 §6.5 told the builder to set `fuigo/incrementalBashOutput` and rely on `output_delta`, which is not today's emit. A builder following it would ship a tail that only works on Fuigo 1.0.48. Now the cumulative rule is the 1.0.22 path (§6.5, §3.6 F11).
- (a, P3) Today's Fuigo puts ListDir, web search, MCP and task results only in `rawOutput`. A "content before rawOutput" reader that stopped at empty `content` opened those rows to "Response unavailable". Now `rawOutput` is the fallback (§3.6 F10).
- (a, P2) Fuigo's `apply_patch` has no locations at start. Under "a final row is never re-labelled", the completing frame could not set its file, so it read "Edited files" forever. Now the completing frame's fields apply before the row turns final (§3.6 F7/F8).
- (b, P2) A non-shell Fuigo call never sends `in_progress`. A builder keying "running" on `in_progress` would show pending calls as not started. Now `pending` = running (§3.6 F5), with a mutant.
- (b, P2) Today's Fuigo reports a Stop during a local tool as `failed` + prose, or not at all. Now a `failed` after Murage's own `session/cancel` is held. It becomes `stopped` on a confirmed Stop, else `no_result`, never a red "Failed" for a watchdog or deadline cancel (§3.6 F4/F16).
- (c, JOINT RULING; found by the independent Opus pass) The owner presses Stop during a Fuigo bash call. The turn's terminal fold runs while the run is still "stopping", and the close receipt lands only after `await stopCall` (`index.ts:5125-5136`). Reading the receipt at the fold gives "Interrupted" with `no_result` rows, and final rows never change, so a real Stop never reads "Stopped". Now a turn whose Stop is asked but not confirmed holds its rows and settles once, at the receipt or at the unconfirmed or refused path (§0, §3.3).
- (d, P5; Opus pass) A live tail that restarted on the newest 4 KB, or started when someone subscribed mid-command, began scanning inside a private key: the key's body lines were released unmasked. Now a restart latches the tail hidden, and a late subscriber scans from byte 0 (§3.6 F11).
- (b, P2; Opus pass) Fuigo closes a voided hosted row `failed` before Murage sees the `retry_state`, or resends with the same id. The row read red "Failed", or the resend spun forever behind `interruptedRows`. Now both orders give `no_result`, and a reused id is cleared (§3.6 F13).
- (a) Ownership: the Fuigo emitter side was OPEN NO-OWNER. It is now the Fuigo coordinator for 1.0.48 (MAIN-RULING), and the consumer side is the build lane (header).
- (a) The builder delta now names the three merge conflicts with dev/1022 and how to keep both sides (§0).

**Parked (for Sean):** a "background" label for auto-backgrounded shells on today's Fuigo (needs F15; until then such a row reads "No result"). Showing Fuigo's policy-refusal prose as "Not allowed" (would need English matching, which is rejected; it reads "Failed" with its message until F4).

**Rejected:** setting `fuigo/incrementalBashOutput` in 1.0.22 anyway. The ruling binds the view to today's emits; even in delta mode `content` still carries the whole buffer (REFERENCE F11), so the write rule is needed either way.

**Decisions for Sean (defaults chosen, nothing blocks the build):**
- D1: short interim bot text folds into the chain as narration, with the three guards (§3.5). Say "keep all bot text as bubbles" and the switch ships off.
- D2: details cap default 1 GB; details are not in backups.
- D3: the default becomes Collapsed, so old turns that had tool chips or approval lines gain a header pill. Off stays quiet and keeps the No limits trace.
- D4: the finished header stays "Worked for 5m 35s · 27 steps"; the breakdown ("Edited 2 files, ran 4 commands") is the first grey line of the list. Say "put it in the header" and it moves.
- D5: runs of four or more quiet look-ups fold into one row. Say "never fold" and every step is always its own row.
- D6: the plan is one line that opens to the checklist. Say "keep it open" and it starts open while the bot works, as the card does today.
