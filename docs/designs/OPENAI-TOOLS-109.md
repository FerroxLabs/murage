# OPENAI-TOOLS-109: real tools for the OpenAI-chat engines

Status: DRAFT r5, 2026-10-28 (Astra r1 + r2 + r3 REVISE and Grok r5 REVISE folded, see 13 and "Changes in rev 3" / "Changes in rev 4" / "Changes in rev 5" at the end). Lane `fix/109-openai-tools`, worktree `/Volumes/Scratch/work/wt-109-openai-tools`,
base `dev/int/108` = `d4192c1625b51e20bea3b7f4251ba9c5417bacc8`. Security lane: tools mean approvals, the stop line and secrets.

## 0. The gap

`server/drivers/openai-chat.ts` is the runtime for `openai-compat.ts` (OpenRouter, Groq, Together, llama.cpp, Ollama, vLLM, any
custom URL, Local models servers), `grok.ts` (xAI API) and `minimax.ts`. It sends no `tools` field
(`renderMurageTurn(turn, NO_TOOL_SURFACE, {})` at :848, `mcpToolSurface: NO_TOOL_SURFACE` at :1053, `respondToRequest` returns
"unavailable"). A bot on these engines can only chat: no memory/thread recall tools, no agents (list_bots/ask_bot), no phone, no
connected apps, no custom MCP servers, no ask_user. That breaks "every feature works on whatever engine is the default".

Upstream OpenMausBot (origin/main 700f66297) has a working loop in its openai-chat.ts plus `chat-mcp-tools.ts`,
`chat-tool-approval.ts`, `openai-chat-protocol.ts`. We port the loop and the protocol accumulator, but NOT upstream's approval
module or its MCP mount list: our fork decides approvals centrally in the server and already has a reviewed MCP mount builder and
stdio client for Pi. The design below keeps one approval path.

## 1. Principles (non-negotiable)

1. **No new approval logic in the driver.** The driver never decides allow/deny. Every MCP tool call raises `request.opened`
   (requestType "permission") with the same structured facts Pi's gate sends, and waits for `respondToRequest`. The server's
   `case "request.opened"` (server/index.ts:~8116) applies, in its existing order: partition refusal, draft-only deny, question
   routing, stop line (`stopLineFor` → `classifyAsk`), routine approval, `autoVerdict`, narrow deny, auto allow. Ask / Auto /
   Full access / No limits therefore behave exactly as on Pi and the ACP engines, including always-ask commands
   (`server/always-ask.ts`), own-server rules (`shared/own-servers.ts` OWN_UNASKED / OWN_ALWAYS_ASK) and "Always allow".
2. **Same mounts as Pi.** Tools come only from the integrations Murage already hands engines, built by the existing
   `buildMcpServers(turn, { askBeforeCustom: true })` (server/drivers/pi.ts:203) and recorded by `piMountRecords` (:254). Both move,
   unchanged, to `server/drivers/mcp-mounts.ts` and pi.ts re-imports them (pure move, Pi tests unchanged). No built-in shell or
   file tools (see 12).
3. **Same Murage tool surface.** `renderMurageTurn(turn, CHAT_TOOL_SURFACE, mounts)` with `CHAT_TOOL_SURFACE = PI_TOOL_SURFACE`
   (direct, `${server}_${tool}` lowercased, 64 chars) so persona/how-to text names the tools exactly as advertised.
   `mcpToolSurface: CHAT_TOOL_SURFACE` on the adapter. Tool names are allocated with the existing `allocateToolName` rules.
4. **Fail closed.** Anything unknown (unparseable arguments, a tool not advertised this turn, a reused call id, an MCP transport
   error mid-call) never runs or never re-runs. A dispatched call is never replayed by a retry.

## 2. Which drivers and models get tools

- Runtime option `tools?: boolean` (default true) on `createOpenAIChatRuntime`; all three wrappers keep the default.
- **Per-model capability, decided by trying, remembered:** round 0 of a turn sends `tools`. If the provider refuses the parameter
  itself (upstream `rejectsToolsParameter`: HTTP 400/422 with `param:"tools"`/`unsupported_parameter`, or "does not support
  tools/function calling", "tools is not supported", "unknown parameter tools"), and nothing has streamed and no call has run,
  the runtime records `(endpoint origin, model)` in an in-memory `textOnlyModels` set (bounded LRU, 256), resends the same round
  once without tools, and emits one `runtime.notice`: "This model cannot use tools, so this bot is answering without them. Choose a
  model with tool support to let it use its tools." Later turns on that model skip mounting entirely (no MCP processes started).
  This is the probe; no static allow-list to go stale. A catalog hint is used when present: an openai-compat model entry whose
  provider metadata lists `supported_parameters` without "tools" (OpenRouter /models) starts text-only.
- **Adapter capability declarations (Astra r1 M):** the server only delivers integrations an adapter declares
  (server/index.ts ~:11179). With `tools !== false` the adapter declares the same MCP capability set Pi declares (agentsMcp,
  memoryMcp, composioMcp, customMcp, phoneMcp, computerMcp, localComputerMcp: builder copies Pi's set; no browserMcp since
  buildMcpServers does not mount browser) plus `queueing: true`. Server-side audience restrictions on which integrations reach a
  non-owner turn are unchanged.
- Text-only fallback is exactly today's behaviour (`renderMurageTurn(turn, NO_TOOL_SURFACE, {})`, no tools field).
- **Turns that stay tool-less by rule:** `turn.draftOnly` (server/draft-only.ts:62-69 admits chat-completions as a draft-only
  surface *because* it sends no tools; that stays true: a draft-only turn mounts nothing and sends no tools), `turn.engineCommand`,
  and `generateText` / `textOnlyTurn`.
- `turn.proposalOnly`: mounts as Pi does (Pi gates it); the server's request handler already restricts what a proposal turn may
  run. Builder verifies against pi.ts:860 and mirrors Pi exactly.

## 3. MCP client

A NEW hardened client `server/drivers/chat-mcp-client.ts` is MANDATORY (Astra r1 H2). `StdioMcp` (pi-mcp-extension.ts:108) is a
reference for framing only and is NOT reused: it spawns with raw `spawn`, inherits `process.env` (:120) and its dispose (:338) kills
only the direct child without a confirmed tree stop. Hard rules:
- Spawn with `spawnCli(command, args, { stdio: pipe x3, env }, engineJob(...))` (server/procs.ts:317) so Windows job objects and
  `killCliTree` tree-kill apply. Never raw `spawn`.
- **Env is ALLOWLIST-built, never inherited-then-stripped (Astra r1 H3):** the enumerated strippers miss names such as
  `MURAGE_MCP_TOKEN` and `MURAGEBOX_BOX_TOKEN`. Child env = a fixed allowlist of non-secret system names copied from
  `process.env` when present (POSIX: HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR, TERM; Windows: SystemRoot,
  SystemDrive, WINDIR, COMSPEC, PATHEXT, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles,
  ProgramFiles(x86), HOMEDRIVE, HOMEPATH, USERNAME, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE, OS) + `PATH: augmentedPath()`, then
  the mount entry's own `env` (and `harnessEnv` for custom mounts) last: the only place a token may enter. Names compared
  case-insensitively on Windows. Builder checks each own mount still starts with only this base (e.g. a proxy needing
  ELECTRON_RUN_AS_NODE or NODE_OPTIONS gets it from its entry env, as buildMcpServers already sets NODE_ENV_FLAG). Test: sentinels
  MURAGE_MCP_TOKEN, MURAGEBOX_BOX_TOKEN, FLUX_API_KEY, OPENAI_COMPAT_API_KEY, XAI_API_KEY, ANTHROPIC_API_KEY and an arbitrary
  MURAGE_X in process.env never reach the child; a mount's own token does.
- stderr drained and discarded (may carry credentials). Newline JSON-RPC frames, frame cap 2 MiB, max 10,000 frames per session,
  server-initiated requests answered -32601, malformed envelope kills the session.
- initialize (8 s startup budget per server, all servers started concurrently, results consumed in config order), tools/list
  paging (max 100 pages, duplicate cursor = error), call timeout = `turn.mcpCallTimeoutMs` if present else 10 min, abort sends
  `notifications/cancelled` and closes. Close = `teardown.markStopRequested()` then `killCliTree(child)` (the order Pi uses,
  pi.ts:1007-1008). After a cancellation (abort or timeout) the close is graceful, the same on every OS: stdin ends, and the
  stop request and tree kill wait until the server exits or `CHAT_MCP_CANCEL_GRACE_MS` (1 s) passes, so the server reads its
  `notifications/cancelled` before it is killed (a Windows job kill otherwise lands in the same tick as the write).
- **Teardown ownership (rev 3, Astra r2 H1).** Every MCP child is tracked from spawn by a `ChildTeardown`
  (server/drivers/child-teardown.ts:84, default `awaitCliTreeStopped` confirm). `TurnTeardowns` (:253) keys ONE child per turnId
  (`#byTurn.set(turnId, …)`, :272), so it is not reused for N children; the driver keeps
  `mcpTeardowns: Map<turnId, {threadId, children: ChildTeardown[]}>` (entry dropped when every child's `onClosed` fired) and
  child-teardown.ts gains one additive change: `export` on the existing `combine()` (:324). The adapter then implements the
  existing contract (server/contracts.ts:689-694) exactly as Pi does (pi.ts:1492-1501, :1520-1534):
  - `awaitTurnTeardown(threadId, turnId)` = `combine(children of that turn (all turns of the thread when turnId is undefined),
    stopBudget(CLI_TERM_GRACE_MS))`; nothing tracked = confirmed.
  - `awaitTurnClose(threadId, turnId)` = `Promise.all(children.map(c => new Promise(r => c.onClosed(r))))`, captured at the call,
    no timer.
  - `interruptTurn` aborts, then awaits that wait and throws `ProviderStopUnconfirmedError("<driverKind>", result)` when
    `!closeConfirmed`; `stopAll` and `dispose` do the same over every tracked child.
  **`turn.completed` waits for the confirmed close (rev 4, Astra r3 H1).** `turn.completed` is not only the direct-run release:
  the server's fold also releases project-write leases (`projectTurnLeases.complete`, index.ts:7352), the local VM thread
  (`releaseLocalVmThread`, :7856) and room occupancy (`busyBotId: null`, :8921-8925) on it, independently of the teardown wait.
  So the turn's `finally` requests the stop of every child, then the driver emits `turn.completed` ONLY after
  `mcpTeardowns.closed(threadId, turnId)` resolves (every child's `onClosed`, observed only through its confirmed tree stop; no
  timer). A turn with no MCP children emits at once, as today. A child never confirmed stopped therefore never produces
  `turn.completed`: every lease above stays held, which is the fail-closed outcome. The bounded waits are the Stop and
  shutdown paths: `interruptTurn` / `stopAll` / `dispose` wait `stopBudget(CLI_TERM_GRACE_MS)` and reject
  `ProviderStopUnconfirmedError` when unconfirmed (the server's existing unconfirmed-stop handling, index.ts:17204, reports it);
  a late confirmed close then emits the held `turn.completed` exactly once (guarded by a per-turn `completed` flag). Because the adapter now exposes `awaitTurnTeardown`, server/index.ts:8849 no longer takes the `releaseDirect()`
  shortcut for these engines: the run is released only on `closeConfirmed`, otherwise `retain()` keeps it
  (`reportUnconfirmedDirectStop`, then `releaseOnLateClose` on the late confirmed close), and the Stop path (index.ts:17204) observes
  the same wait. No server change. Tests: a fake child that ignores the kill keeps the run retained (index-level test with a
  stub adapter is not needed: assert `awaitTurnTeardown` resolves `closeConfirmed:false` and `interruptTurn` rejects with
  `ProviderStopUnconfirmedError`); a child that exits releases; two servers in one turn are both awaited.
- A custom server that fails to start is skipped with a `runtime.notice` naming it; an own server (memory, agents, phone, computer,
  connector, dweb) that fails is skipped with a notice too (the turn still answers), never silently.
- Lifetime: one mount per turn, closed in the turn's `finally`. (Per-thread warm mounts are a later optimisation, not this lane.)

## 4. Per-turn tool list caps (upstream d6306866f lesson)

- Max 128 tools per turn total and per server; schema per tool ≤ 64 KiB; the whole `tools` JSON ≤ 256 KiB (tighter than
  upstream's 1 MiB: these requests go to small local models and metered routers). Over a cap: drop that server's tools with a
  notice naming the server, never truncate a server's list silently (a half-mounted server is worse than an absent one).
- Each advertised schema is rewritten with the existing `providerSafeInputSchema` (server/mcp-tool-schema.ts:65); the call is
  still validated against the server's own schema by the server. Arguments must parse to a JSON object; otherwise the call is
  refused without running and the model gets `{ok:false}` teaching text.
- Tool descriptions capped at 1,024 chars each.

## 5. The round loop

Constants: `MAX_CHAT_ROUNDS = 64`, `MAX_TURN_TOOL_CALLS = 200`, `MAX_REPLY_TOOL_CALLS = 32` (per reply, protocol), arguments ≤
256,000 chars per reply.

```
mount tools (unless tool-less by rule or textOnlyModels has the model)
for round in 0..63:
  splice queued steers into messages (5.3); turn.ending = (round == 63)
  stream one completion with tools (existing complete(): fence, redirects, idle budget, Flux memory, backpressure all unchanged)
  emit reply text item if non-empty (todo-block filter as today)
  no tool calls → final-answer rules (5.4); break or continue
  tool calls → validate ids for the whole batch BEFORE running any (reused id = fail turn, nothing runs)
             → seen > 200 → fail "Stopped after 200 tool calls..." without running the batch
             → push assistant {content|null, tool_calls, reasoning replay}
             → for each call in order: approve (6) → item.started → execute → item.completed → push role:"tool" result
if no final answer after 64 rounds → fail "Stopped after 64 steps without a final answer. The steps so far already ran, so ask only
for what's left."
```

### 5.1 Streaming parse of tool_calls

Port `openai-chat-protocol.ts` verbatim (no imports) with ONE deviation (rev 3, Astra r2 M): upstream tests
`delta.function !== undefined` (openai-chat-protocol.ts:59), which throws on a streamed `function: null`; ours uses
`if (!omitted(delta.function))`, so a streamed null function is omitted like every other streamed null field, and a non-streamed
`function: null` still throws. `ChatToolCalls` accumulates deltas by `index` (0..31), `id` may not change
once set, `type` must be "function", name ≤ 64 and `^[A-Za-z0-9_-]{1,64}$`, nulls on streamed fields mean omitted (test 5 pins
`function:null` in a stream). `finish()` refuses:
a malformed frame anywhere in the stream (our `unreadableFrames > 0` already fails the stream), legacy `function_call`, finish
"tool_calls" with no calls, calls with a finish other than null/"tool_calls"/"stop" (e.g. "length" = truncated arguments), missing or
duplicate ids. A reply that carries tool calls is refused if its unterminated EOF tail does not parse (Astra r1 M: today `atEof` tails are
not counted as unreadable; for a tool-bearing reply they are), so no call from a possibly truncated stream ever runs.
Assistant text is never parsed as a tool call (textual `<tool_call>` imitations stay text).
`isProgress` also counts a tool_calls delta as progress (idle budget). Non-streamed JSON replies (`wholeCompletionFrom`, gateways)
read `message.tool_calls` the same way; `content: null` is valid with tool calls.
`reasoning_details` (OpenRouter) kept in order via `ChatReasoningDetails` and replayed on the assistant message; `reasoning_content`
replayed on tool-call messages for DeepSeek-style servers, stripped once and remembered per model if the server rejects it
(`rejectsReasoningReplay`).

### 5.2 Retries

Today's transient retry stays, but only while `!sawOutput && seenCalls.size === 0`: once any call has been handled no round is
ever replayed. Groq `tool_use_failed` (a refused generated call, nothing ran) may resend the round up to RETRY_MAX_ATTEMPTS while no
answer text streamed. The submission fence (`beforeSubmit`) runs before every request write of every round, unchanged. **After any tool call has been
dispatched (seenCalls > 0) a fence refusal must never trigger a whole-turn rebuild (Astra r1 H1):** today `SubmissionRefused`
settles `stopReason:"submission_refused"`, and a `MEMORY_CONTEXT_REVOKED` refusal schedules `rebuildRefusedDirectTurn`
(server/index.ts ~:12210), which re-runs the user's message and would repeat dispatched actions. Rule: the driver settles
`submission_refused` only when `seenCalls.size === 0`; otherwise it settles `ok:false, stopReason:"error"` with "Murage stopped this
turn before its next step. The steps so far already ran, so ask only for what's left." Belt and braces: the harness's late-refusal
rebuild path also refuses to rebuild a turn for which a tool `item.started` was seen (per-turnId mark) and settles with the card
instead. Tests for both.

### 5.3 Steering during a turn

- `capabilities.queueing: true` and `adapter.steer(threadId, text, beforeWrite, interjectionId)`.
- A steer is parked on the running turn and **resolves only when it is spliced**. `completeWithin` serializes the body
  (openai-chat.ts:546) before the async address check (:563), so the splice point moves (Astra r1 M): `completeWithin` takes a
  `prepareWrite()` callback run after `checkLocalServerUrl` and in the same synchronous block as `beforeWrite`, immediately before
  `fetch`. It calls each parked steer's `beforeWrite()`; a throw drops that steer ("rejected"); accepted steers are appended to
  `messages`; then the body is serialized and fetched. "delivered" settles when that fetch gets a response. Redirect hops reuse
  the same messages (no new splice).
- **Failed write after a splice (rev 3, Astra r2 M).** `prepareWrite()` records the staged steers as
  `staged: {steer, message}[]` (the exact message objects appended, in order). If the fetch fails:
  - `neverConnected` (proved unsent): each staged message is removed from `messages` by object identity
    (`messages.splice(messages.indexOf(message), 1)`), then the steers return to the FRONT of the park in their original order.
    The next splice re-runs each `beforeWrite()` (a renewed fence); a throw then resolves it "rejected" and its message is never
    re-added. So a retry can neither duplicate a steer nor carry a copy its renewed fence refused.
  - any other failure (the request may have reached the provider): the messages stay in `messages`, and each staged steer
    resolves **"uncertain"** (contracts.ts:109, :733: the caller does not send a copy). If a later request of this turn that
    carries those messages gets a response, the driver emits `{type:"steer.confirmed", interjectionId}` (contracts.ts:199) for
    each steer that had an `interjectionId`. If the turn ends without such a response, they stay "uncertain" (never re-parked,
    never "rejected").
- Refused ("rejected", so the caller sends it as a normal next turn) when there is no live turn, when `ending` is set (last allowed
  step, upstream dad54b565), and every parked steer still unspliced when the turn ends resolves "rejected" in `finally` — so a steer is
  never lost and never duplicated (stronger than upstream 7617039ea's "send it again" notice, which becomes unnecessary).
- Never mid-batch: steers are spliced only between rounds.
- A steer that arrives while the model is writing its final answer (no tool calls) makes the loop push that answer (with its
  reasoning, upstream 2eac6af9a) and run one more round instead of ending (upstream 86f082c93), unless `ending`.
- Stop with parked steers: they resolve "rejected".

### 5.4 Final-step rules (upstream fixes)

- No tool calls + empty text → existing empty-answer failure. Finish reason other than "stop"/null → failure (existing).
- Any tool result `ok:false` from a person's or the server's denial: the turn ends ok with the model's answer but carries
  `denials` (see 7); never auto-retried. A tool *failure* (not a denial) may get `turn.toolErrorCorrectiveRounds ?? 0` corrective
  rounds (field exists upstream; if absent in our SendTurnInput, 0 = off, and we do not add it this lane).
- On the last allowed step (`ending`): no corrective round, no announcement nudge (upstream 2aa6ae57d); a steer is refused.
- Announcement nudges (upstream `announcesAction`, max 3, only after tool progress) are ported but OFF by default
  (`nudgeAnnouncedAction` option) — enabled for local endpoints only (`localEndpoint` models and loopback/LAN URLs), where small
  models announce and stop. Never nudges after a denial.

### 5.5 Stop mid-round

One `AbortController` per turn (today's), plus an `ending` flag and a `done` promise. `interruptTurn` aborts and awaits `done`;
`stopAll`/`dispose` abort all and await. Abort during: streaming → existing `StreamOutcomeError("cancelled")` path keeps partial
text; an open permission card → the driver resolves it `request.resolved {behavior:"deny", source:"system"}` and the tool does not
run; an MCP call in flight → `notifications/cancelled`, session closed, tool item completed `ok:false` "Tool interrupted; an operation
already dispatched may have taken effect. Verify its state before retrying."; between rounds → no new request is written. The turn
settles exactly once as `stopReason: "cancelled"`, `ok: true` (the STOP1 convention this driver already uses), after the stop of
every MCP child was requested and every child's close was confirmed (3, rev 4): `turn.completed` is held until then.
`interruptTurn` is bounded and rejects with `ProviderStopUnconfirmedError` when a child tree is not confirmed stopped within the
budget; the held `turn.completed` is emitted on the late confirmed close, so no lease, VM or room is released while a child may
still execute.

## 6. Approval path per call (the security core)

For each call, in order:
1. JSON-parse arguments; must be an object; tool name must be advertised this turn → else `{ok:false}` refusal, nothing runs, no
   card.
2. **No native ask_user (Astra r1 H4, simplified).** The driver adds no ask_user definition and never emits a requestType
   "question" of its own. Questions come only from the mounted agents server's ask_user (agents-proxy.ts → POST
   /api/internal/ask-user, server/index.ts ~:22784), which already refuses unattended and non-owner turns and room non-members. That
   call is an ordinary MCP call and goes through step 3. **Actual behaviour, two stages (rev 3, Astra r2 M), identical to Pi:**
   own-server rules do NOT decide it. `isQuestionTool("mcp__agents__ask_user")` is true (auto-approve.ts:101-105, the
   `mcp__<server>__` prefix is stripped), so the server files the permission ask as a question ask (index.ts:8146 `questionAsk`):
   no stop-line read, and `autoVerdict` returns `{approve:null, source:"question-tool"}` (auto-approve.ts:821) ahead of every mode,
   grant and OWN_UNASKED entry. Stage 1 is therefore a card the owner answers at every level (never auto-allowed, never
   remembered); only on Allow does the call run, and stage 2 is the endpoint's own question card, whose audience / unattended /
   room-member guards still apply. On an unattended turn stage 1 is never machine-answered and is settled by the server's
   existing unattended handling; if it were allowed, the endpoint still refuses. The driver adds nothing to either stage. Test 2
   pins: an `agents_ask_user` call raises a permission `request.opened` that the stubbed server answers only by hand.
3. Every MCP call → register the pending ask BEFORE emitting (the server may answer synchronously), then `request.opened`:
   `requestType:"permission"`, `requestId` (new id), `tool: "mcp__<server>__<tool>"`, `toolIdentity: {namespace:"mcp",
   name:"<server>__<tool>"}`, `toolCall: {name: tool, input: args}` (the EXACT parsed arguments, never scrubbed: this is the
   broker input the stop line, `autoVerdict`, `exactCommandForRequest` and grants read, index.ts:8173-8291),
   `toolInput: boundedToolInput(scrubKnown(args))` (16 KiB; known secrets removed from complete strings BEFORE the cap, see 8),
   `summary: approvalSummary(...)`, `mcpMounts: piMountRecords(turn, servers)`, `toolEngine`, and `approvalScope:"local-computer"`
   when the mount is the host computer — the same field set Pi's gate emits. `toolEngine`: add `"chat"` to `EngineKind`
   (shared/app-action-grant.ts:45) with the same `requiredFields` table as Pi's MCP asks (server/drivers/contracts.ts:194); builder
   checks every switch over EngineKind compiles and behaves as Pi.
4. Wait. No driver-side timeout: the server already owns deny timers / `holdPermissionAsks` for routines. Abort resolves the card
   as system deny.
5. `respondToRequest(threadId, requestId, decision)`: unknown/settled id → "unavailable"; deny → "rejected"; allow →
   "allowed-once"; `updatedInput` (narrowed call, rules 69e/73d) **replaces** the arguments that run, and the item shows the
   narrowed input. Emits `request.resolved` mapping the decision source exactly as Pi's respondToRequest does (pi.ts ~:1502-1518);
   `"narrow"` is never copied into `request.resolved.source` (not in that union, contracts.ts ~:314).
6. Allowed → `item.started` (tool, `input: boundedPreview(scrubKnown(runArgs))`) → `callTool(runArgs)` → `item.completed {ok,
   result}` (contracts.ts:171 field name; rev 3). `runArgs` = `updatedInput` when given, else the exact `args`. Denied → no call;
   `{ok:false, result:"Permission denied; the tool was not executed."}` to the model; denial name recorded for `turn.completed.denials`
   if the contract has it (else omitted).

There is no path in which a call runs without step 3–5, at any level. Full access/No limits are auto-allowed by the server (after
the stop line), not by the driver.

## 7. Events and transcript

- Field names come from the contract (contracts.ts ~:171: tool completion carries `result`, not `output`). `runtime.notice` is
  NOT in our event contract (Astra r1 M): every "notice" in this design is emitted the way Pi/ACP surface a non-fatal line today
  (builder finds that existing event); no new event type.
- Tool items: `item.started {itemType:"tool", itemId: call.id, title, input}` / `item.completed {itemType:"tool", itemId, ok,
  result}` with `origin:"engine"` where the contract requires it. Builder matches the item shapes Pi emits so the chat UI renders
  them identically.
- Usage summed across rounds into one `thread.token-usage.updated` per round and `turn.completed.usage` (charge summed too).
- Native log: `nativeLog.outgoing` gets the tools list *names only* (not schemas) per round; tool results in the native log are capped
  at 4 KiB each (upstream "keeps Grok's native log small").
- Transcript replay across turns: unchanged (text only). Tool rounds of earlier turns are not replayed (the model sees its earlier
  final answers, as on every other engine without a session).

## 8. Redaction

- Secrets set: the request key (route/local/options), plus every env value of every mounted server whose name matches
  `/key|token|password|secret|authorization|cookie/i`. `scrubKnown(x)` = deep walk of a structure (or a string), applying
  split/join of every known secret to each COMPLETE string, then `redactSecretsInText`; it returns a copy and never mutates.
- **Three copies, one authoritative (rev 3, Astra r2 H2).** (a) Broker copy: `request.opened.toolCall.input` and the `runArgs`
  handed to `callTool` are exact and unscrubbed (6.3), so the handler judges what will run. (b) Persisted copy: the canonical event
  log never keeps it. `loggedRuntimeEvent` (server/runtime-event-out.ts:90, called by harness/bus.ts:114) additionally replaces a
  `request.opened`'s `toolCall` with `{name: toolCall.name}` (input dropped) for every engine; the bounded, scrubbed `toolInput` is
  the logged/display text, and `windowRuntimeEvent` already drops `toolCall` from streams (:78). This is a pure reduction of what
  is written; no reader of the log needs the input (the log only feeds `readThreadEvents` for the Inspector, index.ts:28421).
  Test: a mounted token inside an ordinary field (`{"note":"<token>"}`) is absent from the written ndjson and present, exact, in the
  live `request.opened.toolCall.input`. (c) Display/model/log copies are separate scrubbed copies: `toolInput`, `item.started.input`,
  `item.completed.result`, the tool message to the model, native log, error messages and `details`.
- **Scrub before cap, everywhere (rev 3, Astra r2 H3).** `boundedToolInput` (approval-text.ts:61) masks by key name and generic
  shape, then caps each value and the whole; a known opaque token cut by a cap would survive as a near-complete prefix. Order is
  therefore always `scrubKnown` on the complete value → then any cap or serialization: `boundedToolInput(scrubKnown(args))`;
  tool result text: `scrubKnown(fullText)` → 50 KiB cap (UTF-8 boundary) → model / `result`; native log (rev 4, Astra r3 H2):
  `scrubKnown` deep-walks the native log RECORD OBJECT (request body, tool results, error text) and scrubs each complete string
  value BEFORE `JSON.stringify`, then the 4 KiB per-result cap applies; never a split/join over serialized JSON, where escaping
  (`"` → `\"`, `\` → `\\`) would change a secret's bytes so split/join misses it. The same rule holds for every copy:
  `scrubKnown` always runs on parsed values (strings inside objects), never on JSON text. Test: a mounted password containing
  `"` and `\` under an ordinary field is absent from the native log and the event log. MCP result text is read whole up to the frame cap (2 MiB) before scrubbing, so no secret is split
  by our own truncation. Streamed deltas keep the hold-back of a suffix that could be a secret's prefix across chunks (upstream).
  Test: a token straddling the 16 KiB / 50 KiB / 4 KiB boundary leaves no 8+ char prefix of it in any copy.
- MCP stderr never read into any event. MCP error objects reduced to "MCP request failed; inspect the configured integration".

## 9. Memory and PIP reflection stay tool-less

`textOnlyTurn` (http-text-only.ts) and `generateText` never mount, never send `tools`; a reply carrying tool_calls to them is an
error ("provider returned tool calls to a text-only helper"). Test pins: request body has no `tools`/`tool_choice` key.

## 10. Size and token caps

- Request: existing caps unchanged (SSE line 1 MiB, response 32 MiB). Per-turn: tools JSON ≤ 256 KiB; tool result ≤ 50 KiB each;
  images from MCP results are dropped with a text note in this lane (no image transport here yet), so a screenshot tool returns
  "Screenshot not shown: this engine reads text only".
- The growing per-turn `messages` array: if the provider refuses size (HTTP 413 / context-length error) after tool rounds, the turn
  fails with the existing provider copy plus "The steps so far already ran"; no automatic trimming in this lane.

## 11. Tests (vitest, build host only)

New `server/drivers/openai-chat-tools.test.ts`, `describe.each(["openai-compat","grok","minimax"])` where shape allows, fetch
stubbed, MCP = `server/testing/fake-custom-tool.ts` (real stdio child) or an in-test fake client:
1. advertises mounted tools (names, safe schemas) and runs an allowed call, result returned to the model, final answer item.
2. every MCP call raises `request.opened` with toolCall/toolIdentity/mcpMounts/toolEngine; nothing runs before the answer.
3. deny → tool not executed, `{ok:false}` to model; `updatedInput` runs the narrowed args.
4. server answers synchronously inside the emit (pending registered first).
5. streamed tool_calls split across many deltas, interleaved indexes, null fields; JSON (non-stream) tool calls with content null.
6. protocol refusals: reused id across rounds (nothing runs), finish "length" with calls, bad index, name too long, args not JSON.
7. text-only fallback: provider rejects `tools` → one resend without tools, notice once, next turn mounts nothing; network error
   does not trigger the fallback.
8. 64-step cap and 200-call cap (batch crossing it never runs); last step refuses a steer; no corrective/nudge on last step.
9. steer: spliced between rounds only, resolves on splice, beforeWrite throw → rejected; unspliced at end → rejected; steer during
   final answer → one more round with reasoning kept.
10. Stop during stream / open card / MCP call / between rounds → settles once cancelled, card resolved system deny, child stopped;
    a child that ignores the kill → `interruptTurn` rejects `ProviderStopUnconfirmedError`, `awaitTurnTeardown` resolves
    `closeConfirmed:false`, `awaitTurnClose` resolves only on its later close (rev 3); `turn.completed` is NOT emitted until that
    close, then exactly once (rev 4).
11. redaction: key split across deltas; tool echoing a mounted server's token; native log and events clean; token in an
    ordinary field is exact in live `toolCall.input` and absent from the written event log; token straddling every cap boundary
    leaves no prefix (rev 3).
11b. steer write failure: `neverConnected` → staged messages removed, steers re-parked in order, renewed fence throw → "rejected"
    and no copy in the retried body; ambiguous failure → "uncertain", one `steer.confirmed` after the next answered request (rev 3).
12. env scrub: sentinel secrets in process.env absent from the MCP child env.
13. draftOnly / engineCommand / textOnlyTurn / generateText send no tools (body has no `tools`).
14. no retry after a call ran; Groq tool_use_failed resend before any call.
15. caps: 129 tools / oversized schema / oversized catalog drop the server with a notice.
16. existing openai-chat*.test.ts, openai-compat*.test.ts, grok.test.ts, minimax.test.ts, http-text-only*.test.ts, pi*.test.ts,
    draft-only tests stay green. Both typechecks (`tsc -b`, `tsc -p tsconfig.server.json`), base comparison 0 NEW failures.
Real-turn proof: opt-in vitest (`MURAGE_REAL_CHAT_TOOLS_URL`/`_MODEL`, skipped otherwise) run on the build host against a private test machine's Ollama
(a tailnet `/v1` endpoint, keyless, tools-capable model) with the fake custom MCP tool, in Ask mode (card answered by
the test as the harness would) and Full mode; never the Flux test key.

## 12. Out of scope, stated plainly

- **No built-in shell/file tools.** ACP engines bring their own shell; these engines get shell/files only through the mounts Murage
  already provides (computer/localComputer/agents tools, custom MCP). A Murage-owned workspace tool server is its own security
  design (cage, always-ask, cwd confinement) and is not smuggled into this lane.
- Images to the model from tool results (computer screenshots) — text note only here.
- Warm per-thread MCP mounts.

## 13. Review log

r5 (reviews/openai-tools-109-r5-grok/): Grok REVISE, 2 High on the built slices 1 + 2, both folded in rev 5 (table at the end).

r4 (reviews/openai-tools-109-r4/): Astra APPROVE on the r3->r4 diff. r3 (reviews/openai-tools-109-r3/): Astra REVISE 2 High (folded
in rev 4); Grok r3 ran from the worktree cwd but produced no verdict in 45 min (stopped; only a one-line preamble in REVIEW.md).

r2 (reviews/openai-tools-109-r2/): Astra REVISE, 3 High + 3 Medium + 1 Low, all folded in rev 3 (table below). Grok r2 did not
run (`additionalDirectories is not supported`); r3 runs it with cwd = the lane worktree and no extra directories.

r1 (reviews/openai-tools-109-r1/): Astra REVISE, 4 High + 4 Medium, all folded (H1 no rebuild after dispatch, H2 mandatory
hardened client, H3 allowlist env, H4 native ask_user dropped for the guarded agents ask_user; M steer splice point, M EOF tail on
tool replies, M capability declarations, M contract field names). Grok r1: no verdict (headless run stopped at a permission prompt
for a git read); rerun in r2 with `--permission-mode plan`.

## Changes in rev 3

| Finding (Astra r2) | Sev | Fix in rev 3 | Where |
|---|---|---|---|
| Unconfirmed MCP shutdown releases the run (index.ts:8849 takes `releaseDirect()` when the adapter has no `awaitTurnTeardown`) | High | Every MCP child tracked by a `ChildTeardown` in a per-turn set; adapter implements `awaitTurnTeardown` / `awaitTurnClose`; `interruptTurn` / `stopAll` / `dispose` throw `ProviderStopUnconfirmedError` on unconfirmed; stop requested before `turn.completed`; server retains the run via its existing `retain()` / `releaseOnLateClose`. One additive change: `export` of `combine()` in child-teardown.ts | 3 (Teardown ownership), 5.5, test 10 |
| Redaction vs authoritative approval input (bus.ts:114 persists raw `toolCall.input`) | High | `toolCall.input` stays exact for the handler and `callTool`; `loggedRuntimeEvent` drops `toolCall.input` from persisted `request.opened` (all engines, pure reduction); display/model/log copies are separate `scrubKnown` copies | 6.3, 8 (Three copies), test 11 |
| `boundedToolInput` truncates before the known-secret scrub (approval-text.ts:61) | High | `scrubKnown` on complete strings before every cap/serialization: `boundedToolInput(scrubKnown(args))`, result scrub then 50 KiB cap, native log scrub then 4 KiB cap | 6.3, 6.6, 8 (Scrub before cap), test 11 |
| Steer re-park after `neverConnected` duplicates / keeps a stale copy; ambiguous failure unsettled | Medium | Staged messages removed by identity before re-park (front, in order), renewed fence on re-splice; ambiguous failure → "uncertain" + `steer.confirmed` after a later answered request | 5.3, test 11b |
| `ask_user` ordering vs own-server rules (auto-approve.ts:821) | Medium | Documented actual two-stage behaviour (question-tool permission card at every level, then the endpoint's question card); endpoint guards retained; driver adds nothing | 6.2, test 2 |
| `function:null` rejected by verbatim accumulator (protocol.ts:59) | Medium | One stated deviation: `if (!omitted(delta.function))` | 5.1, test 5 |
| §6.6 says `output` | Low | `item.completed {ok, result}` | 6.6 |

## Changes in rev 4

Astra r3 (reviews/openai-tools-109-r3/astra/REPORT.md): REVISE, 2 High; the r2 authoritative-input High, all three Mediums and
the Low confirmed closed.

| Finding (Astra r3) | Sev | Fix in rev 4 | Where |
|---|---|---|---|
| `turn.completed` emitted before confirmed child close; the server releases project-write leases (index.ts:7352), the local VM (:7856) and room occupancy (:8921-8925) on it, outside the teardown wait | High | `turn.completed` held until every MCP child's confirmed close (`onClosed`, no timer); Stop/shutdown waits stay bounded and reject unconfirmed; late close emits it once | 3 (Teardown ownership), 5.5, test 10 |
| Native log scrub over serialized JSON misses secrets changed by escaping | High | `scrubKnown` only on parsed string values, before `JSON.stringify`, then cap; never on JSON text | 8 (Scrub before cap), test 11 |

## Changes in rev 5

Grok r5 (reviews/openai-tools-109-r5-grok/REVIEW.md): REVISE, 2 High, against the built slices. Both are server paths that §3 and
§5.2 assumed were already covered. Rev 5 changes the server; §3's "no server change" no longer holds for these two paths.

| Finding (Grok r5) | Sev | Fix in rev 5 | Where |
|---|---|---|---|
| A room (group) turn that already started a tool is rebuilt after a late memory refusal: the room subscriber re-enters `runGroupMemberTurn` with no tool check, and `toolStartedTurns` is folded away before it runs | High | The room subscriber keeps its own `roomToolStarted` flag, set on a tool `item.started` for its turn. When it's set, a late refusal goes to the card branch (the same "could not start this reply" card as the direct turn) and is never rebuilt. The direct guard (`toolStartedTurns`) is unchanged | index.ts `runGroupMemberTurn`; test `memory-late-tool-started-api.test.ts` (direct and room; fake driver `FAKE_LATE_TOOL_FIRST`) |
| Fleet reload releases project-write leases, the direct run and the local VM while a child that ignored the kill may still be running: `disposeAll` swallowed `ProviderStopUnconfirmedError` | High | `disposeAll()` and `reload()` now return the instances whose dispose rejected. The reload asks each one's adapter (`awaitTurnClose`, captured after dispose, so it covers only the children still open) which retiring threads still have a child open (`reload-retain.ts unconfirmedCloses`). Those threads keep their project-write generations, their local VM and (for a direct run) the run itself until that confirmed close, never a timer. The turn still ends for the person at once (stop note, approvals closed), with the unconfirmed-stop line and later `ENGINE_CLOSED_LATE_NOTE`, exactly as an unconfirmed Stop does (`releaseOnLateClose`). Room turns keep their leases and VM the same way. The stranded-bot sweep skips a retained run's bot and VM. Applies to the whole-fleet and the scoped reload. Adapters with no `awaitTurnClose` (whose children the harness can't observe) keep the old release | index.ts `reloadProviders`, `reloadScopedProviders`, `retainRetiredRun`, `releaseRetainedOnClose`; registry.ts; project-turn-leases.ts `threadIds()`; test `reload-retain.test.ts` |
| Process shutdown: the same release follows the shutdown dispose | High (shutdown half) | No retain: the process is exiting, and nothing it holds outlives it. The real guarantee is that the child tree is killed, and it is: the shutdown job runs `registry.disposeAll()` in parallel with the other jobs (`createGracefulShutdown`, `SERVER_SHUTDOWN_TIMEOUT_MS` = 6 s). The adapter's dispose stops each MCP child through `killCliTree`. On POSIX that's a process-group SIGTERM, then SIGKILL at `CLI_TERM_GRACE_MS` (3 s), inside the 6 s limit, so a child that ignores SIGTERM, and its group, are gone before `exit`. On Windows the engine job object ends the whole tree. Proven by a test: a SIGTERM-ignoring child plus grandchild are both gone when the shutdown's `exit` runs H6: a descendant that left the group (setsid, a daemon) is not reached by the group signal, so `chat-mcp-client.ts ChatMcpDescendants` remembers every descendant with its start identity (after startup, after each answered call, and at the stop before stdin ends or the group is signalled), sends each one still running as itself the same SIGTERM then SIGKILL, and the server's teardown confirms only once the group AND those descendants are gone; a survivor makes dispose reject unconfirmed (logged), never a claimed success. Windows: the job holds them. A descendant reparented away before any snapshot is observed only through the pipes it holds. Proven by the escaped-descendant shutdown test | openai-chat-tools.test.ts (shutdown case) |

Also checked from Grok r5's notes and kept: `summary` stays the tool name (`approvalSummary(route.tool)`). `turn.completed` is emitted
exactly once (`settle()` checks `state.settled`, and the late-close path uses the same flag). The driver emits no `session.exited`.

