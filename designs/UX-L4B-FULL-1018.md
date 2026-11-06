# Ask about this screen, answered in the panel (UX-L4B-FULL, 1.0.18) r3

Written by Opus (lane UX-L4B-FULL), Wed 4 Nov 2026. Redesign after two BLOCKs (House rule 5). Needs Astra + GrokBuild AGREE by Thu 5 Nov 12:00Z. Base: int/1016 92322865a.
Replaces designs/UX-ASK-THIS-SCREEN-1014.md r2 (BLOCK reviews: designs/reviews/UX-1014-ASTRA-L4B-r1.md, -r2.md). The 1.0.17 fallback lane (ask opens the Chief's chat with the screen named) is not touched; this builds on its path.

## 1. Every BLOCK reason, and the one root cause

| Round | Sev | Reason (review file:line) | Status in r3 |
|---|---|---|---|
| r1 | High | help-turn isolation: memory, workspace, native tools, `register_artifact` reachable (r1:5) | gone: no help turn exists |
| r1 | High | `routeHasTools` does not prove a bot can call `murage_help`; arbitrary bot pick (r1:6) | gone: the ordinary Chief chat turn, whatever its tools |
| r1 | High | level check enforces "above current", not "above what the question needs" (r1:7) | gone: no level claim is made or checked (3.6) |
| r1 | High | 30 s pages answer hides a live billable turn; Stop, 409, late replies unsettled (r1:8) | gone: no timer; the panel is a view of a chat turn with the chat's own Stop |
| r1 | High | engine session retention vs message deletion (r1:9) | gone: no hidden thread, no new retention |
| r1 | Med | name matching for buttons (r1:10) | cut: no new link resolver |
| r1 | Med | R17 handoff (r1:11) | restated: the question is a chat message, said so before Send |
| r1 | Med | 500 vs 400 characters (r1:12) | moot: chat message limit applies; panel caps at 400 for layout |
| r1 | Med | inventory (r1:13) | one new body flag, declared (3.8) |
| r1 | Low | fixed "Nova" copy (r1:14) | the answering bot's real name |
| r2 | High | native tools only "Ask plus decline", calls without an ask unproven (r2:5) | gone |
| r2 | High | `max(minLevel)` measures retrieved material, not the operation (r2:7) | gone |
| r2 | High | Stop and Clear do not retire the askId or fence late writes (r2:8) | gone: the panel stores nothing; the transcript is the only record |
| r2 | High | trimming 20 turns leaves the engine session holding more (r2:9) | gone |
| r2 | Low | "Nova is still thinking" (r2:14) | gone |

**Root cause.** Both designs built a second, hidden conversation system beside chat: a hidden `help` thread with its own engine session, its own tool surface, its own lifecycle (askId, 30 s timer, late replies), its own retention, and its own level policy. Every High is one of those parallel systems failing to match what the ordinary chat already guarantees (r2 section 7 even notes "the chat already has Stop, a visible level, approval cards and memory controls, so none of the four open items applies to it"). r2's own diagnosis ("isolation as a policy sentence") named one symptom, not the cause.

**Removal.** r3 builds no new turn kind. The panel's ask is an ordinary owner message to the Chief, sent down the exact send path the composer uses, and the panel shows that chat's reply as a live view of the store. Everything the reviews asked for (tool limits, Stop, approvals, memory, retention, deletion, backups, usage) is the chat's existing, shipped behaviour, not new code.

## 2. Verified facts this rests on (int/1016)

- The fallback's target rule exists: `askBotTarget` = visible Chief, else first visible bot (src/lib/health-actions.ts:58-61). HelpOpen's own askBot (src/components/help/HelpPanel.tsx:279-288) prefers the bot on a chat screen; r3 uses `askBotTarget` only, the same bot as the 1.0.17 fallback.
- The panel slot exists and is lazy: `askSlot` (HelpPanel.tsx:145, :213; HelpHost.tsx:262, :295); the panel chunk loads only on open (HelpHost.tsx:225-226), so panel code does not count against the 670 KiB entry budget.
- The store's `send` action takes `botId, text, threadId, sendId, onSent, onError` without the composer (store.tsx:1531-1558) and submits through the durable outbox (`deliveryRef.current.submit`, store.tsx:5098-5135): exactly-once by sendId, a "Sending" line, queued or refused chips in the chat.
- Client `Message` carries `sendId`, `role`, `kind`, `text`, `turnId`, `turnTerminal` (store.tsx:268-335); streamed rows reach every bot's transcript through `messageAdded`/`messagePatched` (store.tsx:1161, 1859).
- Stop is `dispatch({type:"interrupt", botId, threadId})` (store.tsx:5605-5607), the chat's own Stop.
- The server never steers a `queueOnly` send into a running turn; it waits in the queue and runs alone (server/index.ts:10218, :10272-10276). The owner route does not take it from the body today (index.ts:28999-29021).

## 3. The design

### 3.1 Who answers
`askBotTarget(state.bots)`: the Chief, else the first visible bot. The panel header names it with its avatar: "<Name> answers". No bot: the panel shows the existing no-engine / hire line (HelpPanel.tsx:213-220), never an input that cannot send.

### 3.2 What is sent
One chat message to that bot's current thread (`bot.threadId`):
`<question>` then a blank line then `(Asked from help on the <screen title> screen.)`
- `screen title` is the panel's own title (HelpPanel.tsx HelpOpen `title`), which is the catalogue title, never a chat name, draft or file.
- No envelope JSON and no scrub pipeline: nothing leaves except what the owner typed and a catalogue title, into the owner's own chat. Above Send, one line: "Your question goes to <Name> in your chat, like any message."
- 1 to 400 characters (panel layout cap; the chat limit is far above).
- `sendId = newSendId()`, minted once per press; the outbox retries with it.
- **Never steered:** the panel passes `noSteer: true`. Store: `send` action gains `noSteer?: true`, carried on the outbox entry and posted as `noSteer: true`. Server route (index.ts ~29020): `noSteer === true` on a fresh owner send adds `queueOnly: true` to `acceptBotSend` and sets `typedStop: false` (a typed "stop" in help is a question, not a Stop). It only removes a behaviour (steering); origin, `ownerActs` and every gate are unchanged. If the Chief is mid-turn the question waits its turn, the receipt says queued, and the chat shows its queued chip.

### 3.3 How the answer reaches the panel
The panel keeps one module-level record in the lazy chunk: `{botId, threadId, sendId, question}` (survives close and reopen, not reload). Every render derives the view from the store, nothing else:
1. `asked` = the user message in `bot` with `sendId === record.sendId` (absent: "Sending"; queued receipt: "<Name> is finishing something. Your question is next.").
2. `reply` = the bot messages after `asked` up to the next user message, text kinds rendered with the chat's own message text renderer (same links, same deep-link handling as chat).
3. Done when a reply row has `turnTerminal`, or the bot is not busy on that thread.
Below the answer: [Open in chat] (select the bot's thread, the 1.0.17 fallback path) and [Ask another].

### 3.4 Stop, queued, approvals, failures
- Running: [Stop] dispatches the chat's `interrupt` for that bot and thread. It is shown only while `asked` exists and the reply is not done, so it never stops an unrelated turn started before our question (queued questions show [Remove from line] = the existing `cancelQueued` with the receipt's queueId).
- A card in the reply (`kind` options, secret, connector, mcpSignIn, or an approval waiting on the thread): the panel never answers it. It shows "<Name> needs your answer in the chat." with [Open in chat].
- Refused or failed send: the chat's chip already holds the words; the panel says "This did not send. [Open in chat]".
- Thread changed (owner switched the Chief's task, or the thread was deleted): `asked` is not in `bot.messages`; the panel shows "The answer is in <Name>'s chat. [Open in chat]". Never a blank.
- Late replies cannot corrupt anything: the panel writes nothing; it only reads the transcript. A new ask replaces `record`; an old answer stays where it belongs, in the chat.

### 3.5 Retention, deletion, memory, usage, privacy
All exactly the chat's: the question and answer are ordinary transcript rows, deleted with the chat or the bot, in backups like any chat, counted as a reply, seen by memory like any chat message (the chat's memory controls apply). Nothing is hidden, so House rule 6 has no new copy to follow.

### 3.6 Level advice (R1-05), restated
The panel makes no level claim and holds no control that changes a level; the answer is the bot's ordinary chat reply under its current level, and anything above that level still goes through the chat's approval card and the level picker's own confirm. r1/r2 tried to rewrite model text against `minLevel` and could not prove it; r3 cuts that layer rather than claim protection it cannot give. Follow-up for L-COPY-D: the `murage_help` entries state the level each action needs, so the bot quotes the help.

### 3.7 Copy (src/locales/en-ux/l4b.json, `ux.l4b.*`)
"<Name> answers" · "Ask about this screen" · placeholder "What do you want to know?" · "Your question goes to <Name> in your chat, like any message." · "Sending" · "<Name> is finishing something. Your question is next." · "<Name> needs your answer in the chat." · "This did not send." · "The answer is in <Name>'s chat." · [Ask] [Stop] [Remove from line] [Open in chat] [Ask another]. No em dashes, no banned words.

### 3.8 Inventory (House rule 7)
New: the `noSteer` body flag on `POST /api/bots/:id/messages` (route inventory row, why: help questions never join a running turn). No new route, thread kind, tool list or schema.

### 3.9 Files and size
- `src/components/help/HelpAsk.tsx` new (~150 lines, lazy chunk), plugged as the default ask in `HelpOpen` (HelpPanel.tsx ~295) when `askSlot` is not given.
- `src/state/store.tsx` `send` action + effect: `noSteer`, and `onReceipt?({queued, queueId})` mirroring the existing receipt hook at store.tsx:5538-5543 (a few lines, entry bundle, under 200 bytes); `src/state/send-delivery.ts` posts `noSteer`.
- `server/index.ts` route ~29000-29021: read `noSteer`.
- Bundle: entry chunk growth under 0.3 KiB; the gate's entry budget is not raised. If it would cross 670, the store change moves the flag into the outbox entry only (no new code path).

## 4. Tests (build host)
1. **Fails on base:** HelpOpen renders the ask; typing and Ask dispatches `send` to the Chief's thread with the question plus the screen line and `noSteer`; a streamed bot reply with that sendId's user row renders in the panel (base: no ask in the panel).
2. Route: `noSteer:true` on an owner send while the bot is busy queues (receipt queued), never steers; `typedStop` is not taken; origin unchanged; without the flag behaviour is byte for byte the old one.
3. Panel states from store fixtures: sending, queued (Remove from line calls cancelQueued with queueId), running (Stop dispatches interrupt with that thread), done, card in reply (Open in chat, no inline answer), thread switched, refused.
4. Stop is not drawn before our user row exists (no Stop of an earlier turn).
5. Target: Chief chosen over the bot on screen; no bots shows the no-engine line, no input.
6. Copy gate: i18n keys present, no em dashes; bundle gate unchanged budget.
7. Real engine (Check-Ahead row): on fuigo, claude, codex, "?" on Routines, ask "why did this run fail", the answer streams in the panel and the same rows are in the Chief's chat.

## 5. Cut, on purpose
Hidden help thread, help-mode tool list, pages-after-30 s, server pre-search of HELP_INDEX, envelope JSON in the message, `[Open: id]` link grammar and resolver, `minLevel` rewrite. Each was a source of a High. The panel's existing help search (HelpPanel.tsx HelpSearch) still answers without any bot.

## 6. House rules
1 works by default on every engine (it is a chat turn); 2 and 3 limits are the chat's own harness limits; 4 no dead ends (every state has Open in chat); 5 whole, no third patch of r2; 6 no new data; 7 one flag declared; 9 real bot name and reason.

## 7. Merge with Astra's independent design (scratch l4bfull-astra-design.md), Wed 4 Nov

Astra reached the same core independently: a panel view of an ordinary Chief chat turn, queue-only admission, ordinary chat retention and permissions, no hidden thread. Taken from Astra, these OVERRIDE sections 3.1 to 3.4 where they differ:
- **Chief only (overrides 3.1).** The visible Chief, never "first visible bot". No Chief: help search plus "Add a Chief to ask questions." (`askBotTarget` stays as is for Health; the panel uses a Chief-only lookup.)
- **Answer identity (overrides 3.3 step 2-3).** Find our user row by `sendId`; bind to its server-written `dispatchedIn` turn id (server/index.ts:2605-2613, :10179, :10415); answer rows are the bot rows with that `turnId`; done on `turnTerminal` for that turn. Add `dispatchedIn?: string` to the client `Message` type. Never "latest bot message", never timestamps.
- **Transcript present (new).** On Ask the panel asks the store to load the Chief's current thread through the existing bot-detail path (`ensureBotDetail` / `verifyBots`, store.tsx ~1158-1163), so the answer renders when the Chief was never opened this session. If the rows still are not in the store, the panel says "The answer is in <Name>'s chat. [Open in chat]": no new lookup route.
- **Targeted Stop (overrides 3.4 Stop).** Stop posts the existing `/api/bots/:id/interrupt` (index.ts:29419) with `{threadId, turnId}`; new: when `turnId` is given, the route stops only if the thread's live direct run is that turn (the generation guard pattern of `interruptDirectThread`, index.ts:2824-2825), else answers `{ok:true, stopped:false}`. Stop is drawn only once `dispatchedIn` is known and that turn is not terminal; before that the question is queued and the button is [Remove from line] (`cancelQueued` with the receipt's queueId, with onDone/onError callbacks). "Stopping" until the route answers; a 409 `provider_stop_unconfirmed` shows the chat's own unconfirmed line with [Try again].
- **Local generation.** Each Ask bumps a panel generation; receipts and callbacks of an older generation never repaint the panel. The panel writes nothing to the transcript, so a late answer is only ever a chat row.
- **Approvals.** "<Name> needs your approval" with [Open in chat]; the panel never approves or rejects (Astra allowed this explicit handoff).
- **Copy before Send (overrides 3.2 line).** "Your question and this screen's name go to <Name>'s chat. Its usual memory and permissions apply. Replies count toward usage."
- **Dismiss.** [Done] clears only the panel view and says "Saved in <Name>'s chat"; disabled while the turn runs.

Not taken from Astra, with reasons:
- **Server-selected reviewed answer blocks only, no generated prose.** About 900 to 1,300 new lines with a new answer inventory; does not fit Fri 22:00Z and changes the product (the owner asked the Chief; the Chief answers). R1-05 is defined as a **help copy lint over help-index answers and the scripted questions** (UX-OVERHAUL-BUILD-PLAN.md:536; UX-OVERHAUL-REVIEW-R1.md:23). r3 meets it where it is defined: (a) that lint, owned by L-COPY-D, over HELP_INDEX which `murage_help` returns; (b) a release-gate row, not a runtime claim: the R1 scripted questions including the Dana email case run on fuigo, claude and codex through the panel and fail the gate if any answer proposes a higher level than the help entry says; (c) the panel has no control that changes a level, and any action above the bot's level still raises the chat's approval card. The panel makes no runtime claim that it filters model text.
- **Envelope JSON and two scrubs.** r3 attaches only the catalogue screen title, never names, drafts or files, so there is nothing to scrub but what the owner typed into their own chat, which the composer does not scrub either. The preview is the exact message text.
- **30 s slow line.** The running state already shows Stop and the streaming answer.

Revised builder tests (replace section 4 items 1, 3, 4; add 8 to 10):
1. Fails on base: from Routines, Ask dispatches `send` to the Chief's thread with `noSteer`; a two-paragraph reply with that row's `dispatchedIn` turn renders fully inside `[data-help-panel]`, Routines still selected.
3. States from fixtures: sending, queued (Remove from line), running (Stop posts turnId), approval, done, refused, rows missing (Open in chat).
4. Wrong-answer guards: an earlier unrelated bot reply, a later turn's reply, and a reply on another task never render as our answer.
8. Route: `turnId` Stop on a thread now running a different turn stops nothing.
9. Chief never opened this session: the answer still renders after the detail load.
10. Real-engine R1-05 gate row (b) above.

## 8. Fix round (the only one) for Astra AGREE r1 BLOCK (scratch l4bfull-astra-agree-r1.md). Astra accepted the architecture and the R1-05 treatment.

- **H1 queueOnly batches with neighbours (steer-queue.ts:88, index.ts:10517).** A persisted `queueOnly` owner row is a singleton batch boundary in both directions: the drain never batches it with an earlier or later owner row, and keeps owner provenance and every gate. Tests: owner, help, owner queued in that order give three turns; restart recovery keeps the boundary.
- **H2 detail load does not load transcripts (store.tsx:5743, :2773, :3765).** On Ask the panel calls the existing transcript first-page loader for the pinned Chief thread without selecting its chat, with its page-generation checks and retry. Builder: name that loader in the patch; test 9 asserts the answer renders for a Chief never opened this session, with no selection change.
- **H3 titles carry owner names (HelpPanel.tsx:274, screens.json:14).** Send the fixed catalogue title (the uninterpolated title form, as screen-envelope.ts:287 uses), never `{name}`. The preview above Send shows the complete outgoing message. Test: a bot named like a key or a private name never appears in the sent text.
- **M1 Stop.** A separate guarded branch on the interrupt route: validate bot, thread and provider turn id, capture that run's generation, then call `interruptDirectThread(bot, thread, generation)`; it never runs `stopDirectThreadForOwner`'s queue-wide and call-wide effects. Declared as the second route field beside `noSteer` (3.8).
- **M2 completion.** Done is any of: a `turnTerminal` row for the turn, the thread's run for that turn ended (busy cleared or a stopped/failed line), or cancel answered (404 on Remove from line means it already started: the panel follows the turn). Each has a state and a next step; no state waits forever.
- **L citations** corrected for the builder: POST serialization store.tsx:4734, `cancelQueued` at :1567/:5078 gains callbacks, `sendId` at :344.

### 8.1 GrokBuild AGREE r1 (BLOCK, scratch l4bfull-grok-agree-r1.md), folded into the same fix round
Grok accepts the architecture, `noSteer` (no steering, no new authority) and the R1-05 treatment. Its Highs match section 8: (1) transcript load is H2; the panel reads the Chief's rows only once `messagesUnloaded` is clear (store.tsx:3765-3772), keeping Open in chat until then. (2) Stop: `dispatchedIn` is the provider turn id (server/store.ts:390-392, index.ts:12919), not `run.generation` (index.ts:11718). The guarded branch compares `turnId` to the live run's `providerTurnId`; on a miss it returns `{ok:true, stopped:false}` before `markSendsStopped` or `botCalls.cancel` (index.ts:10053-10055); on a match it calls `interruptDirectThread` with that run's own generation. Never pass `turnId` as `expectedGeneration`. Mediums: fixed title (`fixedTitle`, screen-envelope.ts:283-288) is H3; `turnId` gets its own route-inventory row and CI check; bot `cancelQueued` gains onDone/onError like the group action (store.tsx:1569-1574); done also when that turn is no longer the live run (M2).

## 9. Opus design pass after the second BLOCK (Astra AGREE r2b, scratch l4bfull-astra-agree-r2b.md), Wed 4 Nov. Base int/1016 0bd0f2dbb

The r2b High: a singleton at the queue does not make the RUN exclusive. While the help turn runs, an ordinary owner send reaches admission with `currentAtStart.busy` (server/index.ts:10297), passes `blockedByEarlier` because the help row is already `started` (send-store.ts:781), and steers into the help run (index.ts:10339, :10365), which stamps it with the same `dispatchedIn` (:10415). The panel then shows mixed work and the turn-guarded Stop ends the owner's other request. Root fix: **the help turn is an isolated run, and isolation is a fact on the run record itself**, read wherever words could join a running turn. Sections 7 to 8.1 stand except where this section is more specific.

### 9.1 Where isolation lives (one fact, three readers)
- **Row.** New `owner_sends.isolated INTEGER NOT NULL DEFAULT 0` (added like `queue_only`, send-store.ts:268/:336), `SendRow.isolated: boolean`. Set only by the bot send route when the body has `noSteer: true` (the panel's send; the 3.8 route-inventory row). An isolated row is always also `queueOnly` (accept throws otherwise, as `via` does at :587), and is an ordinary OWNER row (origin and `ownerActs` exactly as typed in chat: no new authority, no lost authority). A replaced attempt of the same `sendId` (the :613 carry-forward) keeps `isolated`.
- **Queue (H1, made concrete).** `drainBatch` (steer-queue.ts:88) treats an isolated row like a via row: it is the whole batch when first, and ends a run of owner rows when later. The drain passes `isolated: first.isolated` in the batch info (steer-queue.ts:311) and the index.ts drain runner (:10491) passes it to `startTurn`.
- **Run record.** `DirectThreadRun` (independent-thread-runs.ts) gains `isolated?: true`, set by `admit(..., { isolated: true })` from `startTurn` (index.ts:11669) and nowhere else. A rebuild takeover (`takeOver`) keeps the held run's flag whatever the caller passes, so a help turn refused over memory and rebuilt is still isolated. The record dies with the run, so the flag cannot outlive the turn or leak into the next one.

### 9.2 Nothing joins an isolated run
- **Admission.** In `admitDirectSend`, before any steer decision (inside the `currentAtStart.busy` branch, ahead of `steerable`): when `directRuns.get(threadId)?.isolated`, the send is queued (`queueIt()` + `drainQueuedSends()`) and returns the normal queued receipt. No continuation-reset log, no `markDispatched`. The owner sees their message in line, and it runs as the next turn when the help turn ends (the drain runs on that turn's end, as now).
- **Submission fence.** The single steer call site (`steerWithQuoteLineage`, index.ts:10365; steer-lineage.ts:280) is the only way words enter a running turn (verified: no other caller). Its `holds` predicate (`steerSessionHolds`) gets the same check first: `if (directRuns.get(threadId)?.isolated) return false`. It runs again inside the write fence right before the engine write (steer-lineage.ts:303), so a send admitted into an ordinary run that has since ended, with an isolated run now live on the thread, is refused at the write: the existing refusal path returns "queue" and the row waits as its own turn (`sendStore.queue` clears the `dispatched` marker set at :10357, so it is never shown unconfirmed). After any refusal, a thread that still has a live run record (`directRuns.get(threadId)`, any phase) is queued, never `runIt()`: today that branch reads only `current.busy` (index.ts:10455), which can lag the run record, and a start there would fail `thread_busy` instead of waiting.
- **Question-card answers.** An answer whose `turnId` is the help turn's own provider turn may still steer into it (it is that turn's own continuation, already the QW Q1 rule). Every other answer is already queued unless its card's turn is live. The isolation check exempts exactly `answer.turnId === run.providerTurnId`, nothing else.
- **No other entry.** Group turns, routines and engine commands never steer a direct run (`isEngineCommand` already queues; group/routine turns use their own threads or are refused by `admit`'s `thread_busy`). Test 13 below enumerates the steer call sites so a new one fails CI until it reads the flag.

### 9.3 What this buys
- Every bot row stamped with the help turn's `dispatchedIn` is the answer to the help question and nothing else, so 7's answer identity is exact.
- The turn-guarded Stop (8.1) can only stop the help turn, and the guarded branch never touches the queue (`markSendsStopped`, `botCalls.cancel`): the owner's message queued behind it still runs next.

### 9.4 Remove from line: explicit states (the Medium, steer-queue.ts:352)
`DELETE /api/bots/:id/queue/:queueId` keeps 200 `{ok:true}` on success and 404 on failure (existing callers unchanged), and the 404 body gains `state`, read from the row (`byQueueId`) inside the same call:
- `"started"`: the row is `dispatched`, `started`, `delivered` or `unconfirmed` (with `messageId` when it has one). The panel follows the turn: it keeps watching for `dispatchedIn` on its `sendId` row and shows Running with Stop once it is known. It never shows "done" from the 404 alone.
- `"cancelled"`: already removed (another window). Panel: "Removed from the line." [Done].
- `"missing"`: no row for this bot (pruned, wrong bot). Panel: "That question is no longer in the line." [Open in chat] [Done].
- Network error, 5xx, or a body without `state` (an older server): Retry state, "Could not remove it." [Try again], and the panel keeps the question shown as queued. No state waits forever: each has a next step.
`cancelQueued` (store.tsx) passes the parsed body to `onError`, so the panel decides from `state`, not from the status code.

### 9.5 Tests added (build host), each failing on base
11. Isolation at admission: help row running (isolated run), an ordinary owner send on an engine that can steer is queued, never steered; it has no `dispatchedIn` of the help turn and runs as the next turn after the help turn ends.
12. Isolation at the fence: a send admitted while an ordinary run is live, held at the engine; the ordinary run ends and an isolated run takes the thread before the write; the fence refuses, the row is queued with `dispatched=0`, and it runs after the help turn, never inside it.
13. Steer call-site guard: a source check that `steerWithQuoteLineage` has one caller and that its `holds` reads `isolated`.
14. Rebuild takeover keeps `isolated`; a resend of an isolated row keeps `isolated`; restart: a queued isolated row is still isolated and still a singleton batch.
15. Help card answer for the help turn's own card still steers into it; an answer for another turn's card does not.
16. Cancel 404 states: started, cancelled, missing each return their `state`; the panel renders Running, Removed, Missing and Retry from fixtures, and never Done from a 404 alone.

### 9.6 Size
Server about 60 lines (column + migration, drainBatch, two option pass-throughs, run flag, two checks, cancel state). Client: the panel states of 9.4 within the section 3.9 budget. The bundle stays at or under 670 KiB with no budget raise.
