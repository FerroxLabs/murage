# 1022-GROKWARM: warm Grok/Fuigo turns in Murage (DESIGN r2)

Owners, first lines (OWNERSHIP rule):
- Side F, Fuigo engine: the prompt-scope change (section A) and its Fuigo witnesses WF-1..WF-7, plus the recorded fixture stream handed to Murage. Owner: the FUIGO-1048-PSCOPE builder (to be seated by MAIN). **OPEN NO-OWNER F** until it is seated.
- Side M, Murage: reuse (B), pool rules applied to ACP (P), MCP gate (C), resume (D), witnesses WM-*. Owner: the GROKWARM-1022 builder (to be seated by MAIN). **OPEN NO-OWNER M** until it is seated. Section D edits memory-fence code, so the memv2/fence reviewer reads it.
- Shared warm pool rules (`server/drivers/warm-pool.ts`: activity window, per-bot keep, spare ceiling, memory budget, MAIN-RULING warm-active-only): owner = W1 r3.5's WARM-1021-DRIVER builder (pool owner). Side M never forks them; it registers ACP members with their bot id and carries the ACP-kind witnesses (section P, contract C7).
- MAIN owns both flag flips (`warm.s2r` per Sean D1 G1-G5, `warm.acpReuse` per gate G) and the relay-scope ruling (contract C6). Sean owns the parked product choice P-1.
- Fixture contract (F to M): Side F records the stream. Side M consumes it read-only.

Design only. Nothing is built or run. Code anchors: Murage `rc/1021-r3` @ b41c759197 (the installed lineage the triage used); W1 r3.5 @ 516ce12b49 (`designs/WARM-W1-1022-r3.5.md`, "d.md" below). The branch base is `dev/1022` @ b45d0259e6. **Base fact for Side M:** the last-resort replay that section D changes (`recentReplayPrompt`, `lastResortReplay`, `index.ts:18264-18279`, `:18441-18449`) exists on the rc/1021-r3 lineage and NOT on dev/1022 b45d0259e6 (its `:18543` is the older message-only-only path). Side M bases on a branch that contains it (rc/1021-r3 or the 1.0.22 integration branch once merged) and re-anchors there; if its base lacks it, D is not buildable and the builder writes OPEN BASE-D in last.txt. Fuigo anchors: `lane/u47-tmisc` source (fuigo-version 1.0.46). The hub tip `lane/u47-final` is 1.0.47.

r2 closes ASTRA-DESIGN grokwarm af19c2b1b1 (3H 5M) and FABLE-DESIGN grokwarm af19c2b1b1 (4H 6M), takes W1 r3.5 GROKWARM COORD C1-C6 as requirements, and applies MAIN-RULING local-memory-budget (2026-11-22T03:06:03Z) and MAIN-RULING warm-active-only (2026-11-22T04:30:19Z). The per-finding map is section R at the end.

## 0. PURPOSE and USER PROMISES

PURPOSE: a Grok or Fuigo turn on an owner thread should start the way a Claude turn does. It keeps the conversation, does not re-pay a cold start or an MCP wait for servers that are already up, and reuses the Fuigo process only when that is provably safe and only while the owner is actively using that bot. Evidence: TRIAGE-GROK-SPEED-1122 item (3). Each Grok turn was a cold, context-free last-resort start that spent 7.5-9.6 s on setup plus 47-85 s re-finding context.

- **U1 Conversation.** Grok/Fuigo turn N+1 resumes turn N's native session (`resumed=true`) whenever the memory check would let a Claude turn resume. A session started from a shortened replay is resumed only while the check that shortened it is still pending; once it settles the next turn gets the full conversation (D4).
- **U2 No repeat cold loop.** A Grok/Fuigo turn that started as the last resort with a replay of the conversation leaves a session the next turn can resume. The next turn therefore is not refused and rebuilt again for the same pending check.
- **U3 Fuigo process reuse.** On a Fuigo build that advertises prompt scope, with BOTH `warm.s2r` and `warm.acpReuse` ON, turn N+1 reuses the process and its MCP servers (`process=reused`). It skips spawn, initialize, authenticate and the MCP gate. Turns holding computer or browser mounts, and fullAuto turns, stay cold-process (unchanged exclusion, M1 note in B1).
- **U4 No needless MCP wait.** On an engine proven to load tools lazily, the first prompt waits only for Murage's required servers. A turn never waits for a server that is already ready. A slow non-required server never refuses a turn.
- **U5 Safety unchanged.** Work caused by turn N never acts in turn N+1: no card, no tool call through Murage's mounts, no tool result, no text. Memory revoke, fence, Stop and Stop-vs-refusal rules apply to a reused or resumed session exactly as they do to Claude's.
- **U6 Never slower, never refused for warmth.** Warm resources are used only if they are ready now. Any warm failure falls back to cold in the same turn. No warm-pool limit, memory budget or memory wait refuses, truncates or delays an owner turn (MAIN-RULING local-memory-budget); budgets only decide which idle engine is retired.
- **U7 Warm only where active (MAIN-RULING warm-active-only).** A Fuigo engine is kept idle only for a bot that had an owner turn in the last 15 minutes, at most one per bot, at most 3 per engine kind across bots, inside the pool memory budget min(25% RAM, RAM - 6 GB); after 15 minutes with no owner turn on that bot it is retired (no process), and under memory pressure the least-recently-active bot's engine goes first.

## 1. Facts this design rests on

- **F1. Murage's "Grok" row runs xAI's `grok` binary, not Fuigo.** `server/drivers/acp/grok.ts:558` has `defaultCli: "grok"`. The Fuigo row runs ours: `fuigo.ts:775` has `defaultCli: "fuigo"` and `fuigo.ts:908` has `pooledSessions: true`. We can change only Fuigo. Consequences:
  - U1, U2 and the C3 refusal scope are Murage-side and apply to both rows. C2 (required-only release) applies only to an engine with proven lazy tools (Fuigo), not to the Grok row (Astra M3).
  - U3 needs the engine change in A. Murage gates it on the engine's advertised capability, never on the driver name or a version.
  - With P-1 parked, Sean's slow-turn evidence (Grok row) is fixed by D and C3 only; process reuse reaches Fuigo rows only (Fable parked note, Astra M5).
- **F2. The cold loop (root of item 3).** The last resort marks the dispatch message-only even when it sends a replay of recent lines (`index.ts:18449`, `lastResortReplay` set at `:18279`). A message-only session's cursor is never saved (`:13291`). The next turn has no cursor, so the owner-pending keep (`:17796-17800`) cannot apply; the prompt is refused and rebuilt, waits for the verdict (`:4703`), and goes out as the last resort again.
- **F2b. The legacy heal would undo a saved cursor (Astra H1).** A tier-2 last resort writes the `MESSAGE_ONLY_NOTE` activity line (`fence-recovery.ts` `recoveryNote` tier 2, `prepareFenceNotice` `index.ts:4625`) whether or not it carried a replay. On the next turn `isLegacyMessageOnlySession` (`turn-context.ts:130-150`, called at `index.ts:16695`) finds that note on the session's starting input and calls `commitFenceReset` + `engineFresh`. Fixing only `:18449` would save a cursor that the next turn drops.
- **F2c. The replay is a window (Fable H4).** The replay holds the last `LAST_RESORT_REPLAY_LINES = 40` transcript entries minus pending/withheld ones (`index.ts:18268`). A session started from it lacks everything older.
- **F3. Pooling exclusions.** All in `acp/core.ts`: `poolable = !mounted && idleHeld === 0 && ... && support.driverKind !== "grokAgent" && ... && !turnConfig.fullAuto && !integrations?.computer && !integrations?.localComputer && !integrations?.browser` (`:6623-6625`); a reused process on a mounted turn is refused (`:6937-6940`); a new relay per turn with `cred = null` (`:6942`); `prewarm` excludes Grok (`:8154`); park conditions `:4199-4204`.
- **F4. MCP gate.** `awaitMcpReady` (`:6243-6300`) releases on `connected >= ownMounts` or after `MCP_OWN_READY_WAIT_MS = 4_000` (`:1862`). The listed-file wait is already limited to `requiredMountNames` (`:3343-3344`), so part of r1's C2 may already hold on base (Fable M4; C4 step 0 decides). A bound mounted turn whose gate times out while any active mount is unready is refused (`:7439-7444`). The CLI only sees relay shims (`:3340`); each shim's env carries that relay's `MURAGE_RELAY_TICKET`/`MURAGE_RELAY_SOCKET` (`cli-mount-shim.ts:10-11`, `cli-mount-relay.ts:366`), so a new relay per turn means new specs and the engine restarts every shim.
- **F5. Relay admission is by ticket and server name only** (`cli-mount-relay.ts:537-548`). Fuigo's MCP `tools/call` carries only name + arguments (`fuigo-mcp/src/servers.rs:2002-2003`), no prompt id. So the ACP prompt id does not cover calls into Murage's mounts (Astra H3, Fable H1).
- **F6. Fuigo today: the id is read at emit time, not bound at origin.** `session/update` `_meta.promptId` comes from the session-global `current_prompt_id` (`fuigo-shell/src/session/acp_session_impl/updates.rs:333`). `session/request_permission` carries no prompt id (`fuigo-workspace/src/permission/prompter.rs:801-811`, `hub_permission.rs:1219`, `sandbox_gate.rs:300`/`:408`). Work after end_turn is real: `notification_drain.rs:845-857` starts an internal turn; `tools/notification_bridge.rs:790-815` sends monitor events; subagent progress goes through `forward_fire_and_forget` (`agent/subagent/mod.rs:2185-2199`). The client `_meta.promptId` on `session/prompt` already wins (`agent/mvp_agent/acp_agent.rs:1360-1367`). Capabilities at `acp_agent.rs:598-612`.
- **F7. The warm pool's activity window is global today.** `warm-pool.ts` keeps one `lastActivity` (`:301`, `noteUserActivity` `:583-590`), evicts all idle engines after the 15-min window (`:474-476`), keeps one spare per engine kind while active (`:478-485`), and evicts oldest-idle on budget min(25% RAM, RAM - 6 GB) (`:324-329`, `:487-488`). MAIN-RULING warm-active-only makes the window, the keep and the eviction order per bot; W1 r3.5 E1 raises the per-kind ceiling to 3 (d.md:951-953). Those edits are the pool owner's (C7).

## A. Fuigo side: prompt scope bound at origin (Fuigo 1.0.48)

The smallest change that makes reuse safe: one capability key, one notification kind, two `_meta` fields, one count on `turn_completed`.

- **A1. Id per prompt.** Murage sends `_meta.promptId` on every `session/prompt`, a fresh random id per dispatch. Fuigo already adopts it (F6).
- **A1b. Internal turns name their root (Fable H2, Astra H2).** An internal turn (drain `notifications-…`, `monitor-…`, `goal-summary-…`, interjection) keeps its own minted id and also carries `_meta.originPromptId` = the client prompt id whose work caused it (a drain caused by a task of P1 carries P1). Work not caused by any client prompt carries `originPromptId: null`.
- **A2. Bound at origin, carried, never re-read.** The (promptId, originPromptId) pair is captured when the work starts (the prompt's task, a background task, a subagent spawn, a monitor, a drain turn) and passed through the emit context; `send_update_full`, every request builder and the MCP call path (A7) use the captured pair instead of `current_prompt_id`.
- **A3. Every agent-to-client frame carries it.** Every `session/update`, `fuigo/session_notification`, `session/request_permission` (all three routes in F6), `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `fuigo/mcp/elicit`, and every `ext_method` request through `gateway.rs:394-462`. Frames not caused by any prompt carry `_meta.promptId: null` explicitly, so "session-level" is distinguishable from "missing".
- **A4. Turn start echo.** Before the first update of prompt P, `fuigo/session_notification {kind:"turn_started", prompt_id:P}`. `turn_completed` keeps its `prompt_id` (`turn_end.rs:470`, `turn_completion.rs:74`).
- **A7. MCP calls carry the origin (Fable H1, Astra H3).** Every outgoing MCP `tools/call` (`servers.rs:2002`, `CallToolRequestParams`) carries `params._meta = {promptId, originPromptId}` of the work that made the call. MCP allows `_meta` on request params; the Murage shim forwards the line unchanged to the relay.
- **A8. Quiet at completion (Astra H3 smallest rule).** `turn_completed` carries `background: n`, the count of live work items rooted in that prompt at completion (background tasks, subagents, monitors, a scheduled drain). Murage parks a process only when the field is present and 0 (B4b).
- **A5. Capability.** The `initialize` answer carries `agentCapabilities._meta["fuigo/promptScope"] = 1` (`acp_agent.rs:598-612`) only in a build where A1b-A4, A7 and A8 hold. Version **1.0.48** (`fuigo-version/Cargo.toml:4`).
- **A6. No barrier.** With origin-bound ids on every frame and every MCP call, Murage can classify everything it receives. The r3.4 ordering barrier is not needed for ACP.

**Fuigo witnesses.** Rust, `fuigo-shell` ACP harness tests, real agent loop with the model stubbed. One id = one mutant = one cell.
- **WF-1 background frame after its prompt ended.** P1 starts a background task and ends; P2 starts; the task completes and drives a drain turn that sends an update and a `request_permission`. Assert: those frames carry the drain id with `originPromptId = P1` (not P2), and P2's own frames carry P2. RED on 1.0.47 (label = current, request has no id). Mutant **MF-1**: read `current_prompt_id` at emit time.
- **WF-2 request coverage.** One recorded turn exercises each request method in A3; every frame has the key and it equals the origin id. RED on 1.0.47 at `request_permission`. Mutant **MF-2**: drop the id on the `sandbox_gate` route only.
- **WF-3 echo order.** For three prompts, `turn_started{P}` precedes P's first update, and `turn_completed.prompt_id` = P. RED on 1.0.47. Mutant **MF-3**: emit `turn_started` after the first chunk.
- **WF-4 capability bound to coverage (Fable M5).** A test enumerates every agent-to-client request builder registered with the gateway and every MCP call site, asserts each goes through the scoped emitter, and asserts `initialize` advertises the key. RED on 1.0.47 (absent). Mutant **MF-4**: register one extra request route that bypasses the scoped emitter while the key is still advertised -> WF-4 RED (the enumeration finds the unscoped route). (MF-4 is no longer MF-1 under another id.)
- **WF-5 subagent progress.** A subagent spawned in P1 still reports after P1 ended and P2 began: its frames carry P1. Mutant **MF-5**: subagent reads the current id at emit time.
- **WF-6 MCP call origin.** A P1 background task calls an MCP tool after P2 began: the outgoing `tools/call` line (captured at the stdio transport) carries `_meta.promptId`/`originPromptId` = P1's pair; a P2 call carries P2. Mutant **MF-6**: MCP call path reads the current id.
- **WF-7 background count.** P1 leaves a background task live at end_turn: `turn_completed.background = 1`; P2 with no background work: `background = 0`. Mutant **MF-7**: always report 0.
- **Fixture.** Side F records one 1.0.48 mounted stream: two prompts, background frames and a drain turn crossing the boundary, an MCP call from P1's task during P2, null-id session frames, `background` counts. Handed to Side M as `server/drivers/acp/__fixtures__/fuigo-1.0.48-pscope-1.jsonl` (neutral content, no hostnames or ids from real machines).

## B. Murage: Fuigo process reuse matching the Claude warm path

- **B1. Eligibility predicate** `promptScoped(proc)`: the process's `initialize` answer carries `fuigo/promptScope: 1`, AND the process holds no unfit mark, AND the driver is `fuigoAgent` or `grokAgent`. Where it runs (r2 review M3): `poolable` is computed before spawn (`core.ts:6623`), when no `initialize` answer exists. So `:6624` keeps a pre-spawn "may pool" check (driver `fuigoAgent`/`grokAgent`, the other exclusions below, and for a mounted turn both flags of B2); `promptScoped(proc)` and B2's `!mounted` lift are applied in the PARK condition (`:4199-4204`), where the answer is known. A process that turns out not `promptScoped` is simply not parked. **Prewarm (r2 review M1, corrected):** `:8154` excludes only `grokAgent`; Fuigo prewarm runs today for a thread with an unmounted last turn (`lastTurns.remember`, `:3135`), and `warmIntent` (`warm-pool.ts:593-596`) holds an idle engine for a window on focus or typing. r2 does not widen prewarm (r1's `:8154` change is withdrawn), and under C7 the pool owner allows a prewarm or an intent hold only for a bot inside its own activity window (WM-P5). The other `:6623-6625` exclusions stay: `!providerBinding` (provider-home teardown), `!turnConfig.fullAuto`, no computer / localComputer / browser mount (Fable M1: Sean's triage thread mounts computer and browser, so U3 does not reach that thread; lifting this is a new surface, parked P-5).
- **B2. Mounted reuse needs BOTH flags (contract C1).** A mounted Fuigo handoff happens only when `warm.s2r` is ON (Sean D1, G1-G5, unchanged) AND `warm.acpReuse` is ON (default OFF) AND `promptScoped`. Either flag OFF: the process is retired before handoff exactly as W1 F8 ships (W1 W-FG2 r3.4 (i''')), next turn cold `resumed=true` via `session/load`. Only then does `:6623` drop `!mounted` for this case and `:6937-6940` stop refusing a reused process on this path. Separating the flags is Sean's (parked in W1).
- **B3. Per-frame classification from generation 1 (contract C2, F8-UNPARK (2)).** Murage mints `promptId` per dispatch D and records it. On EVERY dispatch of a `promptScoped` process, generation 1 included, each agent-to-client frame is classified by its `_meta`:
  - (i) CURRENT: `promptId == D`, or `originPromptId == D` (an internal turn caused by D's own work). Handled as today. A first-seen internal id is NOT current by itself (r1's rule removed, Fable H2).
  - (ii) STATUS: `promptId === null` and the frame kind is on the CLOSED list `PSCOPE_STATUS_KINDS`, a single exported constant: `session/update` with `sessionUpdate` in {`available_commands_update`, `current_mode_update`} and `fuigo/session_notification` with `kind` in {`mcp_status`, `models_updated`}. The builder fixes the exact wire names from the 1.0.48 fixture once, in that constant; nothing else is status. An unknown kind, any request, or any other `null` counts as acting.
  - (iii) STALE: anything else (another dispatch's id, an unknown id, an internal id whose `originPromptId` is not D or is null, a missing key, `null` on an acting kind). A request is answered `cancelled` with no card, logged `frame-stale-prompt`; an update is dropped from the turn's reply and logged. The process is marked **unfit** (`:4199` already refuses to park an unfit process).
  - (2a) BEFORE THE FIRST HANDOFF: a generation-1 frame that is not (i) or (ii) is handled as today on that cold process (W1 r3.4 (h') COLD rule: a cold single-dispatch process is admitted), but marks the process unfit, so it is never handed off; turn 2 runs cold `resumed=true` via `session/load`.
  - (2b) AFTER HANDOFF (generation >= 2): (iii) never acts.
  - The id is captured with the frame's first byte (r3.4 (3c)(i)), so a frame split across a release still counts as stale (carried cell W-FG2 (j), M-FG8).
  - **Owner-visible outcome (Fable M2).** A REQUEST with a missing key or `null` on generation >= 2 cannot be told stale from current; it is denied, and the turn shows the existing denied-tool activity row (the same row an owner Deny writes: tool name, `ok:false`), so the owner sees the action did not run. A request carrying another dispatch's id or a foreign root is logged only (it is not the owner's current work). No new UI string.
- **B4. Memory and fence, same as Claude (contracts C4, C5).** A reused process is a resume of the same native session. Before reuse the thread's continuation check runs exactly as for any resume (`index.ts:17796`), in W1 C-R7 (b') order:
  - revoked: the existing reset path (`resetSession`, `core.ts:2550`) retires the parked process with confirmed exit; the turn runs cold `sessionReset`, `resumed=false`, new native id.
  - the owner-pending keep applies ONLY to exactly `checking:pending`; `late-attach` and `deny-session` retire the session (never kept, never handed off).
  - a session retired for memory (`retireAtEnd`, revokekeep ruling; `deny_session`; `late-attach`) is never parked or handed off (W1 state machine settling -> closed).
  - a partial-replay session whose check settled takes D4 (fresh, full transcript): the parked process is retired, never `session/load`ed onto the partial session.
- **B4b. Park only when quiet (Astra H3).** A `promptScoped` process is parked only if its last `turn_completed` for D carried `background: 0` (A8) AND no frame of an internal turn rooted in D arrived after it. Field missing, non-zero, or later internal activity: not parked (closed through the existing confirmed teardown); the next turn is cold `resumed=true`. This removes the H2/H3 scenarios at the source; B3 and B5 still guard in depth.
- **B5. One relay per process, admitted per turn, every call checked (contract C6, Fable H1, Fable M3).** The process keeps ONE relay for its lifetime (stable ticket and socket; byte-identical shim specs, F4).
  - At settle, `retireAdmission()`: in-flight upstream calls cancelled, mount children of that turn confirmed dead, admission disposed, receipt `{threadId, relayId, confirmedAt}`. Shim sockets stay open; **every shim call while no turn is admitted is refused** (`mount-unadmitted`).
  - The next turn calls `admit(turn, D, mounts)` with its own `assertConsumingMountAdmission` (`core.ts:3107`) before any prompt write. `mounts` = that turn's own mount entries.
  - Every `tools/call` reaching the relay is admitted only if (a) its server is in the admitted turn's `mounts` (a connector removed between turns is refused, `mount-not-admitted`), and (b) on generation >= 2 its `params._meta` (A7) is CURRENT by B3 (i). Otherwise refused `mount-stale-prompt` with 0 upstream calls, and the process is marked unfit. On generation 1 a missing `_meta` is admitted (cold rule) and marks unfit (2a).
  - No receipt means no reuse: the process is closed through the existing confirmed teardown and the turn goes cold. `finish()` stays for terminal close only (Stop, error, eviction, max age, activity window).
  - C6 (owner MAIN): this design's answer to W1's recorded lift scope ("a relay per turn") is: one lifetime relay is acceptable only with per-turn admission AND the per-call origin check (a)+(b); without them, a relay per turn. MAIN states its ruling when it flips `warm.acpReuse`; until then the flag stays OFF, so nothing ships on an unruled scope.
- **B6. Never delays (U6).** Reuse happens only if, at dispatch, a parked process for this thread and contract is idle, alive, `promptScoped`, its retire receipt exists, its contract key matches, and both flags are ON. Otherwise the turn spawns cold at once. It never waits on a park, a teardown, a pool lock or a pool measurement beyond what a cold turn waits today (`teardowns.wait`, `:3175-3181`, unchanged). A reused process that fails before the prompt write is replaced cold in the same turn (`replaceReused`) with `resumed=true`.
- **B7. Stop.** JOINT RULING STOP-VS-REFUSAL unchanged: interrupt, then confirmed receipt. A stopped turn's process is never parked (`:4199`, `!state.cancelRequested`).

## P. Pool rules for parked Fuigo processes (Astra M2, MAIN-RULING warm-active-only)

A parked `promptScoped` process is a `WarmMember` with `engine: "acp"` and a NEW field `bot: string` = the bot whose owner turn it served (`warm-pool.ts` member shape `:55-74`). `scope` is NOT reused for this: it is the login home (`bot: null` for a shared home) that `drainScope` (`:528-541`) drains on a login split, and it stays exactly as today (`core.ts:3065` passes `proc.scope`). The member is registered through the existing `warmPool.markIdle` (`core.ts:3064`). It obeys the shared pool rules, which the pool owner implements once for all kinds (C7):
- (1) kept only while its bot had an owner turn in the last 15 minutes (per-bot activity: the owner-turn call `warmPool.noteUserActivity` at `core.ts:3134` passes the bot id, and `markIdle` at `:3064` passes `bot` from the turn); no kept engine for an idle or never-used bot; a prewarm or `warmIntent` hold only for a bot inside its own window (B1, WM-P5);
- (2) at most ONE kept engine per active bot, across kinds (most recently used kept); at most 3 per engine kind across bots (W1 E1 ceiling);
- (3) 15 minutes with no owner turn on that bot: retired through `close` (confirmed teardown, no process left); next turn cold, `resumed=true` via `session/load` unless memory requires otherwise;
- (4) pool memory budget min(25% RAM, RAM - 6 GB) (`:324-329`) is the hard ceiling; on pressure the idle engine of the least-recently-active BOT is retired first; max age (`:40-51`) unchanged;
- (5) a pool limit only retires IDLE engines; it never refuses, truncates or delays a turn (MAIN-RULING local-memory-budget). A turn whose engine was retired runs cold at once.

## C. MCP gate: reuse ready servers, no needless wait

- **C1. Reused process: no gate.** On a B-reused process the shim specs are byte-identical (B5), and the session's readiness is already held (`proc.mcpReadySessions`). The gate resolves at once with outcome `reused-ready`, lifecycle `mcp_ready_reused`. A server whose upstream spec changed is re-admitted behind the stable shim; the relay sends `notifications/tools/list_changed` only if that server's `tools/list` digest changed. "Fuigo restarts only changed specs" is an engine claim (Fable M3): WM-C1 proves it on the 1.0.48 fixture (0 shim spawns), and B5 (a) refuses calls to a server not in the admitted turn regardless.
- **C2. Cold turn on a lazy-tool engine: required set only (Astra M3).** Applies only when the engine is proven to discover tools lazily: Fuigo with `promptScoped` (its tool search, `core.ts:1855-1858`, is exercised by WM-C2's late-listed server being usable in the same turn). The first prompt waits for the servers in `requiredMountNames` (agents, memory, connected apps; `:3343`), bound `mcpOwnReadyWaitMs`; the rest connect in the background. **The Grok row (xAI binary, no proof of lazy tools) keeps today's gate** (`connected >= ownMounts` or 4 s).
- **C3. The refusal stays scoped (both rows).** The bound-mounted refusal (`:7439-7444`) fires only when a REQUIRED active mount times out. A slow non-required server never refuses the turn. Reconnect-once and tell-the-bot for required servers unchanged.
- **C4. Step 0 is a requirement (Fable M4).** Before writing C code the builder runs WM-C2 and WM-C3 on its base and records the result. A cell GREEN on base is already true: it stays as a guard witness with its mutant, and the matching change is dropped (no code for a non-problem). Only cells RED on base get code. The gate time split (shim spawn, connect, upstream spawn, `tools/list`) is logged on WM-C1 turn 1 (diagnostic).

## D. Resume: a Grok/Fuigo turn has the conversation

Scope (Astra M4, Fable M6): D edits engine-agnostic code in `index.ts`/`turn-context.ts` and ships outside the flags. It changes the last resort for EVERY engine whose turn has no cursor (Claude and Codex first turns, Grok, Fuigo): a replay last resort now keeps a cursor. This is intended (U1 for all engines; same lineage safety). Guard: WM-D1, WM-D3, WM-D5, WM-D6 and WM-D7 run on the Grok, Fuigo AND Claude fixtures. D follows W1 C-R7 (b') order (C5), so W1's verdict order is unchanged.

- **D1. A replay session keeps its cursor.** At `index.ts:18449`, call `markMessageOnlyDispatch` only when the last resort sent the message alone (`!lastResortReplay`). A last resort that sent `recentReplayPrompt` starts a session whose cursor is saved by the normal `saveCursor` (`:13286-13297`).
- **D1b. The legacy heal does not undo it (Astra H1).** The note row written for a replay-carrying last resort gets `memoryReplay: true` (passed through `prepareFenceNotice` into the persisted `FenceNotice` file, and written by `releaseFenceNotice` on BOTH branches: the new-row `appendMessage` and the existing-row `patchMessage` at `index.ts:4613`, so a note re-released after a restart keeps the mark; WM-D1r). The visible note text is unchanged (no new UI string). `isLegacyMessageOnlySession` returns false when the matched note has `memoryReplay === true`. A 0-replay message-only last resort keeps today's note and today's heal (WM-D2). The existing mutant around `server/fence-pending-turn-api.test.ts:128` is re-read by the builder and its target recorded in CHECKLIST.md (it must still target the message-only heal, not the replay case).
- **D2. Its lineage covers what it holds.** The saved session's lineage records the last-resort lines (`turnLineage` with `lastResortLines`). The next turn's continuation check (`:17796`) judges exactly what the session holds: a later revoke of a replayed line revokes the session; a still-pending check takes the owner-pending keep (exactly `checking:pending`, C5). No rebuild, no 65 s wait, no last resort.
- **D3. Unchanged.** A message-only last resort still withholds its cursor. Grok's provider-binding receipts (`provider-routing.ts:70-81`) and Fuigo's resume preflight (`core.ts:3228`) are untouched.
- **D4. A partial session is temporary (Fable H4).** The cursor saved by D1 is stored with a `partialReplay` mark (beside the cursor in the task's resume record, the same record as `resumeContracts`). At the next turn:
  - verdict exactly `checking:pending`: resume it (D2 keep), mark kept;
  - verdict `shown` (the check settled): do not resume. Mechanism (r2 review M2): `engineFresh` is fixed before the verdict (`index.ts:16701`), so D4 hooks the continuation check itself: at `:17796`, when the cursor carries `partialReplay` and the check returns neither revoked nor kept, set `revoked = true` with `revokedWhy.reason = "partial-replay-settled"`. That takes the existing reset branch (`:17803-17810`, log `memory continuation reset ... reason=partial-replay-settled`) and `needsReplay` (`:17821`) in the SAME turn: the full authorized transcript through `filterDirectReplay`, with that path's existing preamble (`memoryRefreshed`), cold, no wait; the new session's cursor is saved without the mark. On a reused Fuigo process: B4 retires it first;
  - revoked / late-attach / deny-session: today's reset.
  One extra cold turn after the check settles buys the full conversation back; it never delays (the fresh path is the cold path every first turn takes).

**Resume witnesses.** Vitest on the real direct-turn path (`server/index.ts` turn harness used by the memv2 suites, engine recorder only), through `index.ts:16695` (the heal) and `:17796` (the keep). Fixtures: Grok, Fuigo, Claude.
- **WM-D1 two turns, check stuck pending.** Turn 1 goes out as the last resort with a replay; the `MESSAGE_ONLY_NOTE` row exists with `memoryReplay: true`; the cursor is saved. Turn 2 logs no legacy heal (`commitFenceReset` not called), logs `memory continuation kept ... reason=checking:pending`, `resumed=true`, no `context revoked`, no second `pending fence settle`. RED on base (turn 2 refused and rebuilt). Mutant **MD-1**: mark the replay dispatch message-only again -> RED (no cursor). Mutant **MD-1b**: `isLegacyMessageOnlySession` ignores `memoryReplay` -> RED (turn 2 heals, `resumed=false`).
- **WM-D1r re-release after restart (r2 review L1).** The note row exists from a first release; the fence notice file is released again (restart path, in-memory latch lost): the row still has `memoryReplay: true` and turn 2 does not heal. Mutant **MD-1r**: the `patchMessage` branch omits `memoryReplay` -> healed, RED.
- **WM-D2 message-only stays cursorless and healable.** A last resort with 0 replay lines saves no cursor; a legacy message-only cursor (note without `memoryReplay`) is still healed. Mutant **MD-2**: always save.
- **WM-D3 revoke of a replayed line.** After turn 1, revoke one replayed line: turn 2 revokes the session, drops the cursor, resets, nothing from the old session reaches the engine. Mutant **MD-3**: save the cursor without the last-resort lines in its lineage.
- **WM-D4 Stop during turn 1.** A Stop confirmed before the cursor commit: no cursor, turn 2 cold. Mutant **MD-4**: save on a stopped dispatch.
- **WM-D5 settle gives the full conversation (Fable H4).** A 60-entry thread; turn 1 replay last resort (40-window); turn 2 kept while pending; the check settles shown; turn 3 logs `memory continuation reset ... reason=partial-replay-settled`, its prompt carries the `memoryRefreshed` replay preamble and contains an entry older than the 40-window and the line that was pending, `resumed=false`, cursor saved without `partialReplay`; turn 4 `resumed=true`. RED on the D1-only build (turn 3 resumes the partial session). Mutant **MD-5**: the `partialReplay` mark is ignored.
- **WM-D6 late-attach is not kept (C5).** A replay session on a `late-attach` hold: retired, not kept (`resumed=false`, new native id). Mutant **MD-6**: keep on any `checking:*`.
- **WM-D7 deny-session is not kept (C5).** A replay session on a `deny-session` verdict: retired, not kept. Mutant **MD-7**: owner-pending keep applied to `deny-session`.

## WM witnesses (Murage reuse, pool, MCP)

Vitest. Real `createAcpDriver`, the real relay, real shims, the recorded 1.0.48 fixture agent (and the recorded 1.0.41 fixture where named). No mock of the code under test. One id = one mutant = one cell; receipts per THRUST RECEIPT TABLE (each mutant's failing assertion is the targeted file:line). Every cell names its flags; "both ON" = `warm.s2r` and `warm.acpReuse`.

- **WM-B0 flag OFF.** `warm.acpReuse` OFF (`warm.s2r` ON): mounted Fuigo turn 2 on 1.0.48 is retired before handoff, `spawned`, `resumed=true`. Mutant **MB-0**: `warm.acpReuse` default ON.
- **WM-B0s second flag (C1).** Capability fixture, `warm.acpReuse` ON, `warm.s2r` OFF: retired before handoff (process exit observed), turn 2 `spawned resumed=true`. Mutant **MB-0s**: handoff ignores `warm.s2r` -> reused, RED.
- **WM-B1 capability gate, 4 turns same pid (C3 "4 turns").** Both ON: turns 2-4 log `process=reused resumed=true` with the same ACP pid on 1.0.48. On 1.0.41 and on a Grok fixture without the key: `spawned reason=no-prompt-scope`. Mutant **MB-1**: predicate ignores the capability -> Grok reuses, RED.
- **WM-B2 stale request (generation 2).** During reused turn 2 the fixture writes `request_permission` with turn 1's id: `cancelled`, 0 cards, `frame-stale-prompt`, not parked after turn 2. Mutant **MB-2**: classification off.
- **WM-B2d drain from earlier work (Fable H2, Astra H2).** Both ON, B4b disabled by fixture (`background: 0` reported falsely) so the defence-in-depth path is reached: during turn 2 a drain turn with a new id and `originPromptId = P1` sends `request_permission` and a text chunk: `cancelled`, 0 cards, text absent from turn 2's reply, unfit. Mutant **MB-2d**: first-seen internal id = current.
- **WM-B3 missing / null id on an acting request (generation 2).** One with no key, one with `null`: denied, 0 cards, one denied-tool row in the turn per request (Fable M2), unfit. Mutant **MB-3**: a missing key is accepted.
- **WM-B3u unknown kind (C2 ii).** After handoff a frame of an unknown kind with `null` id: never acts, unfit. Mutant **MB-3u**: unknown kinds are status.
- **WM-B3g generation-1 check (C2 i).** Turn 1 on a fresh process receives a `request_permission` without the id: handled as today (cold rule), process unfit, not handed off; turn 2 `spawned resumed=true`. Mutant **MB-3g**: check from generation 2 only -> reused, RED.
- **WM-B4 stale update text.** A turn-1 `agent_message_chunk` written during turn 2 is not in turn 2's stored reply. Mutant **MB-4**: drop only for requests.
- **WM-B4q park only when quiet.** Turn 1 completes with `background: 1`: not parked, turn 2 `spawned resumed=true`; `background` absent: same. Mutant **MB-4q**: park ignoring `background`.
- **WM-B5 revoke between turns.** A shown line is revoked after turn 1: turn 2 retires the parked process (exit observed), cold `sessionReset`, `resumed=false`; the old process receives no prompt. Mutant **MB-5**: skip the retire.
- **WM-B6 never waits.** Parked process closing, or its receipt missing, at turn 2's dispatch: turn 2 spawns with 0 timers armed for the park before the spawn (fake clock). Mutant **MB-6**: await the park teardown.
- **WM-B7 between-turn shim call.** The relay refuses a shim call between turns (`mount-unadmitted`); turn 2's call is admitted under turn 2; no receipt means no reuse. Mutant **MB-7**: keep turn 1's admission after settle.
- **WM-B7s stale shim call during turn 2 (Fable H1, Astra H3).** B4b disabled by fixture; during reused turn 2 a P1-origin `tools/call` (A7 `_meta` = P1) to a card-less mount, and one with no `_meta`: both refused `mount-stale-prompt`, 0 upstream calls (backend recorder), process unfit. Mutant **MB-7s**: relay ignores `_meta`.
- **WM-B7m connector removed between turns (Fable M3).** Turn 1 mounts servers S1,S2; the owner removes S2; turn 2 (reused) gets a `tools/call` to S2: refused `mount-not-admitted`, 0 upstream calls. Mutant **MB-7m**: relay checks the ticket only.
- **WM-B8 Stop on a reused turn.** Confirmed receipt, next turn spawns cold. Mutant **MB-8**: park after Stop.
- **WM-B10 retireAtEnd (C4).** A memory revoke during a Fuigo turn under the revokekeep ruling (`retireAtEnd`): the turn completes; turn 2 `spawned`, `resumed=false`, cause memory reset, new native id; the process was never parked. Mutant **MB-10**: park after `retireAtEnd`.
- **Carried cells (C3), run on the 1.0.48 fixture as B adapts them:** W-FG2 (F8-i) stale same-session permission whose first byte arrives after N+1 is prompted -> cancelled, with M-FG2F8a (admit uncorrelated) and M-FG2F8b (toolCallId correlation accepted); W-FG2 r3.3 (i)/(j) with M-FG8, (k) cross-thread spare donors 0 with M-FG9, (l) replacement spawns 0 until teardown receipt with M-FG10. W-FG2 (a)-(h) of W1 r3.4 (g): the builder maps each to a WM cell above or marks it superseded by B5 (relay per process) with a one-line reason in CHECKLIST.md; none is silently dropped.
- **WM-P1 one active bot (warm-active-only (5a)).** Fake clock, timers fired. Bots 1-5 each run one Fuigo turn at t=0 (5 parked engines); bot 3 then has owner turns at t=5, 10, 15 and 19 min (which keeps a GLOBAL window alive). Assert at t=20 min: exactly 1 kept engine (bot 3's), the others' processes exited. Mutant **MP-1**: global activity window (today's `lastActivity`) -> engines of bots 1, 2, 4, 5 are still kept up to the per-kind ceiling (3 kept), RED at the "exactly 1" assertion.
- **WM-P2 idle 15 min (warm-active-only (5b)).** Fake clock, timers fired. Bot 3 runs a Fuigo turn at t=0; bot 4 (another bot) has owner turns at t=5, 10 and 15 min. Assert at t=16 min: bot 3 has 0 kept engines (process exit observed); bot 3's next turn cold, `resumed=true`. Mutant **MP-2**: an owner turn on any bot refreshes every bot's window -> bot 3's engine still kept, RED.
- **WM-P3 budget pressure, LRU bot first (warm-active-only (5c)).** Three bots with one parked Fuigo engine each, parked in order A (t=0), B (t=1 min), C (t=2 min); then bot A has an owner turn on ANOTHER engine/thread at t=10 min (A is now the most recently active bot while its Fuigo engine is the oldest idle), B's last owner turn stays t=1, C's t=2. Budget forced below the pool size so exactly one must go: B's engine is retired (least-recently-active bot), A's and C's kept; a turn running meanwhile is not delayed (prompt sent at its cold-spawn time on the fake clock). Mutant **MP-3**: evict by engine idle order (today's `evictOldest`) -> A's engine retired, RED.
- **WM-P5 no hold for an inactive bot (ruling (1), r2 review M1).** Bot 6 never had an owner turn (or its last was 20 min ago): a focus/typing `warmIntent` and a prewarm request for bot 6 keep 0 engines for it after the pool check. Mutant **MP-5**: intent hold ignores the bot's window -> 1 kept, RED.
- **WM-P4 one per bot.** Bot 3 has two idle Fuigo engines (two threads of the same bot, both inside the window): exactly one kept, the most recently used. Mutant **MP-4**: per-thread instead of per-bot keep.
- **WM-C1 reused, zero gate.** Turn 2 on a reused 1.0.48 fixture: 0 new shim spawns, gate `reused-ready`, gate time 0 (fake clock). Mutant **MC-1**: per-turn ticket back in the shim env -> all shims restart, RED.
- **WM-C2 required-only release (Fuigo) / unchanged (Grok).** Cold Fuigo turn: required servers listed at 300 ms, one non-required never listed: prompt at ~300 ms; a server listed afterwards is usable in the same turn. Grok fixture, same setup: today's gate (guard). Mutant **MC-2**: gate on all own mounts for Fuigo. Mutant **MC-2g**: required-only release applied to the Grok row. (C4 step 0 decides whether the Fuigo half is a change or a guard.)
- **WM-C3 slow non-required never refuses (both rows).** Only a non-required mount unready at the bound: turn runs, no refusal row. Mutant **MC-3**: refusal checks all active mounts.
- **WM-C4 required timeout unchanged.** The required memory mount unready at the bound: existing refusal/reconnect (guard). Mutant **MC-4**: required set empty.

## G. Flag gate (MAIN flips `warm.acpReuse`; `warm.s2r` is flipped only under Sean D1 G1-G5)

- Every WF, WM, carried and WM-P witness GREEN, every mutant RED, receipts machine-checked.
- On the Linux gate box, a real Fuigo 1.0.48 runs 4 mounted owner turns with mounts memory, connected apps and bot messaging only (no computer/browser: B1). Turns 2-4 log `process=reused resumed=true mcp_ready_reused`; median send-to-prompt-sent at least 2 s faster than cold turns on the same box. Then 16 min idle: 0 Fuigo processes for that bot.
- Same run on Mac and Windows through the MAIN relay (`_small/MACRUN-REQ`, `_small/WINRUN-REQ/grokwarm-1022.txt`).
- `warm.s2r` ON (Sean D1 conditions met) is a precondition; MAIN states the C6 relay scope with the flip.
- Any RED: the flag stays OFF. C3, D and (after step 0) C2 are not behind the flags: they ship with their witnesses.

## CONTRACT with W1 r3.5 (GROKWARM COORD C1-C6, AGREED at 516ce12b49) and C7

| contract | where satisfied here | witness + mutant |
|---|---|---|
| C1 both flags | B2 | WM-B0s / MB-0s (+ WM-B0 / MB-0) |
| C2 (2a) generation-1 check | B3 (2a) | WM-B3g / MB-3g |
| C2 closed status list, unknown = acting | B3 (ii) `PSCOPE_STATUS_KINDS` | WM-B3u / MB-3u |
| C3 carried cells | WM carried list; "4 turns same pid" = WM-B1 | W-FG2 (F8-i) M-FG2F8a/b; r3.3 (i)-(l) M-FG8/9/10 |
| C4 memory retire never pooled | B4 | WM-B10 / MB-10 (+ WM-B5) |
| C5 keep only exactly checking:pending | B4, D2 | WM-D6 / MD-6, WM-D7 / MD-7 |
| C6 relay scope (owner MAIN) | B5 answer; flag stays OFF until MAIN rules | WM-B7, WM-B7s, WM-B7m |
| C7 (new, grokwarm -> pool owner) per-bot window, one per bot, LRU-bot eviction, prewarm/intent only inside the bot's window, and the `WarmMember.bot` field live in warm-pool.ts, owned by WARM-1021-DRIVER; Side M sets `bot` on ACP members and passes the bot id to `noteUserActivity`. W1 says such requirements land in a W1 round, so this design asks MAIN for it (QUESTIONS-FOR-MAIN line with the DESIGN-READY) | P | WM-P1..P5 / MP-1..5 (RED until the pool owner's change is on Side M's base; gate G cannot pass without it) |

## Out of scope (named, not built here)

- Triage cause 1 (the first turn's 65 s fence wait) and cause 2 (the check that never settles). Other lanes own them. D removes the wait for every turn after the first.
- Cause 4 (model pin). Any change to xAI's `grok` binary. Grok pooling for unmounted turns beyond the B1 predicate.
- The pool's own per-bot implementation (C7, pool owner).

## GAP-CHECK (one adversarial pass, r2)

Fixed (kind, scenario):
1. (d) A Fuigo background task from turn N asks permission while reused turn N+1 runs; an emit-time label would show the card under N+1. Fixed: A2, B3, B4b (not parked while work is live), WF-1, WM-B2, WM-B4q.
2. (b) A build advertises the capability but omits the id on one route. Fixed: B3 (iii) + unfit; WF-4/MF-4 bind the key to full coverage.
3. (c) local-memory-budget: reuse waits on a closing parked process. Fixed: B6, WM-B6; pool limits only retire idle engines, P (5), WM-P3.
4. (a) The triage left open why Grok never has a cursor. Fixed: F2, D1, WM-D1.
5. (d) A saved replay session outlives a revoke of a line it holds. Fixed: D2, WM-D3.
6. (b) Reused process dies or `session/load` fails before the prompt. Fixed: B6 cold replacement, `resumed=true`.
7. (d) Parked process's shims call owner tools between turns. Fixed: B5 refusal while unadmitted, WM-B7.
8. (c) A slow non-required server refuses a turn. Fixed: C3, WM-C3; required refusal kept, WM-C4.
9. (b) Stop on a reused turn. Fixed: B7, WM-B8, D4/WM-D4.
10. (a) [Astra H1] The legacy heal drops D1's cursor on turn 2. Fixed: D1b `memoryReplay`, WM-D1 through `:16695`, MD-1b.
11. (d) [Fable H2, Astra H2] A drain turn from N's work is first seen in N+1 and shows a card. Fixed: A1b origin, B3 (i) rule, B4b, WM-B2d.
12. (d) [Fable H1, Astra H3] A turn-N subagent calls a card-less mount tool during N+1 under N+1's admission. Fixed: A7 + B5 per-call origin check, B4b, WM-B7s.
13. (c) [Fable H3, Astra M1] Flipping `warm.acpReuse` alone bypasses Sean's G1-G5. Fixed: B2 both flags, WM-B0s.
14. (d) [C2] A turn-1 frame without the id is never checked, and the process is handed off. Fixed: B3 (2a), WM-B3g; closed status list, WM-B3u.
15. (a) [Fable H4] A truncated replay session is resumed forever after the check settles. Fixed: D4, WM-D5.
16. (c) [warm-active-only] Focusing or typing in a never-used or idle bot holds a Fuigo engine (`warmIntent`, prewarm). Fixed: r1's `:8154` widening withdrawn; C7 hold only inside the bot's window; WM-P5.
17. (c) [warm-active-only] Five bots used today keep five Fuigo engines while only one is active (global window). Fixed: P via C7, WM-P1/P2/P4.
18. (d) [C4] A Fuigo session retired at turn end for memory is parked and reused. Fixed: B4, WM-B10.
19. (d) [Fable M3] A connector the owner removed stays callable through the kept relay. Fixed: B5 (a), WM-B7m.
20. (a) [Astra M3] A Grok-row first prompt released without its non-required servers finds no browser tool. Fixed: C2 only on proven-lazy engines, MC-2g.
21. (d) [r2 review H1] Two bots on one shared Fuigo login: a per-bot key on `scope` either merges the bots or stops a login split from draining the engine. Fixed: separate `WarmMember.bot`, `scope` unchanged.
22. (a) [r2 review M2] D4 named a fresh path decided before the verdict exists. Fixed: D4 hooks the `:17796` check (`partial-replay-settled`).

Parked (for Sean / MAIN):
- **P-1.** Process reuse (U3) cannot reach Murage's Grok row (xAI binary, F1). Running the Grok row on Fuigo is a product choice. With P-1 parked, the Grok row gets D and C3 only.
- **P-3.** The first Grok turn on a thread still pays the cause-1 wait until that lane lands.
- **P-4.** Cross-thread spare adoption stays excluded for mounted processes (r3.4 (3e), carried cell (k)).
- **P-5.** Turns holding computer/browser mounts, and fullAuto, stay unpoolable (`core.ts:6625`), so Sean's triage thread does not get process reuse; lifting it is a new surface (Fable M1).
- **P-6.** Stale background work using Fuigo's own in-process tools (no card, no relay) during the next turn: B4b removes the common case (not parked while work is live); a full fix is engine redesign (Fable parked).
- **P-7 (Astra M5).** Ship D + C3 first (flag-free, own witnesses) and A/B later: a sequencing choice for MAIN; this design keeps them independent so either order works.

Superseded from r1: P-2 (partial replay "rare") is replaced by D4. Rejected: an ACP ordering barrier (A6); version-gating reuse (the capability is the truthful signal).

## R. r1 -> r2 finding map

| finding | kind | fix (section) | witness / mutant | status |
|---|---|---|---|---|
| ASTRA H1 legacy heal undoes D1 | a | F2b, D1b | WM-D1 / MD-1b | FIXED |
| ASTRA H2 = FABLE H2 first-seen internal id current | d | A1b, B3 (i), B4b | WF-1 / MF-1; WM-B2d / MB-2d | FIXED |
| ASTRA H3 = FABLE H1 shim calls carry no turn | d | F5, A7, A8, B4b, B5 | WF-6 / MF-6; WF-7 / MF-7; WM-B7s / MB-7s; WM-B4q / MB-4q | FIXED |
| FABLE H3 = ASTRA M1 COORD C1-C5 | c | B2, B3, B4, carried cells, contract table | WM-B0s, B3g, B3u, B10, D6 + carried | FIXED |
| FABLE H4 partial session permanent | a | F2c, D4 (hook at the :17796 check) | WM-D5 / MD-5 | FIXED |
| ASTRA M2 pool parity / budget | c | P, C7 | WM-P1..P5 / MP-1..5 | FIXED |
| ASTRA M3 lazy tools not shown for Grok | a | F1, C2 | WM-C2 / MC-2g | FIXED |
| ASTRA M4 = FABLE M6 D is engine-agnostic | d | D scope line; Claude-fixture guard | WM-D1, D3, D5, D6 on Claude | ANSWERED + guard |
| ASTRA M5 Fuigo side large / ship D first | b | P-7 (sequencing, MAIN); A8 is the smaller rule and is adopted | n/a | PARKED (MAIN) |
| FABLE M1 computer/browser exclusion | a | B1 note, U3, gate G mounts, P-5 | n/a (unchanged code) | ANSWERED |
| FABLE M2 current request without id, no owner line | b | B3 owner-visible outcome | WM-B3 (denied row) / MB-3 | FIXED |
| FABLE M3 restart-only-changed is unverified; removed connector | d | C1 note, B5 (a) | WM-C1 / MC-1; WM-B7m / MB-7m | FIXED |
| FABLE M4 WM-C2/C3 may be GREEN on base | b | C4 step 0 required | WM-C2, WM-C3 | FIXED |
| FABLE M5 MF-4 = MF-1 | b | WF-4 / MF-4 redefined | WF-4 / MF-4 | FIXED |
| W1 C6 relay scope | c | B5 answer; MAIN rules with the flip | WM-B7, B7s, B7m | ANSWERED (MAIN) |
| MAIN-RULING local-memory-budget | c | U6, B6, P (5) | WM-B6, WM-P3 | FIXED |
| MAIN-RULING warm-active-only (1)-(5) | c | U7, B1 prewarm, P, C7 | WM-P1 (5 bots 1 active -> 1), WM-P2 (idle 15 min -> 0), WM-P3 (LRU bot), WM-P4, WM-P5 | FIXED |
| r2 self-review (Opus, read-only) H1 `scope.bot` overload | d | P: new `WarmMember.bot` | WM-P1..P5 | FIXED |
| r2 self-review H2 WM-P1/P2/P3 could not go RED | b | WM-P1/P2/P3 setups rewritten | MP-1/2/3 | FIXED |
| r2 self-review M1 prewarm claim false; warmIntent | c | B1 corrected; C7 hold rule | WM-P5 / MP-5 | FIXED |
| r2 self-review M2 D4 decision point | a | D4 hook at :17796 | WM-D5 / MD-5 | FIXED |
| r2 self-review M3 capability unknown before spawn | b | B1: promptScoped at the park condition | WM-B1 / MB-1 | FIXED |
| r2 self-review M4 C7 needs a W1/MAIN ask | c | QUESTIONS-FOR-MAIN line | n/a | FIXED |
| r2 self-review L1 re-release drops the mark | d | D1b both branches | WM-D1r / MD-1r | FIXED |
| r2 self-review L2 one mutant two scenarios | b | WM-D6 split into D6/D7 | MD-6, MD-7 | FIXED |
