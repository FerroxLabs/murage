# Room share receipt retention

Finished room share receipts (`shared`, `declined`, `unavailable`) are kept until
30 days after `expires_at`. This preserves recent outcomes for the owner, well
beyond the ten-minute draft lifetime. For 1.0.18, share maintenance is queued
only after boot share recovery succeeds, off the boot path. `bootRoomShares`
performs recovery before scheduling maintenance; the boot step retains its catch. Each guarded
callback deletes at most 500 rows. A full batch queues another callback after a
1 ms yield until a batch is short; only then does the next run wait 24 hours.
Each prune runs in the `recovery` I/O source: the instrumented serving handle
uses the 50 ms background wait and restores both its 1000 ms timeout and the
I/O budget timeout tracking. SQLite contention returns `null`, distinct from an empty batch, and retries after
one second. A guard that does not enter the callback also retries after one second.
No transaction or writer guard is held across the yield. The existing
`(status, expires_at)` index selects eligible rowids without scanning history;
no schema or downgrade inventory change is needed.

`pending` is owned by expiration and boot recovery. `sharing` is owned by recovery,
which checks the room message using `stable_id` before settling it. Neither is
eligible for pruning, however old. Unexpired and recently expired rows also stay.
A recovered row becomes eligible only after recovery has settled its state.

The transcript request line contains only Murage's fixed request sentence and the
share ID. GET for an unknown or removed receipt returns 404; the card
shows its original sentence and the existing localized “This request is no longer
open.” It has no spinner or action buttons. A pending card already on screen also
closes at its expiry, so it cannot retain a live Share button until pruning. A
failed fetch uses the existing failure text rather than claiming a known outcome.
All eight locales already contain both messages.

## Text ownership checked

- `server/room-shares.ts`: frozen preview text lives only in `room_shares.excerpts`;
  expiry, decline, drop, successful release and recovery clear it. Deleting the row
  also removes the row's query, nonce and hashes. No secondary preview file is written.
  The row is not the only copy a bot's share call leaves: the bot's own conversation
  and logs are covered under "Display-text audit" below, with what stays.
- `server/index.ts` (`postShareAsk`, `serveShareAsk`, `serveShareRelease`): the card
  transcript and fixed tool response contain no excerpts. Release deliberately
  writes selected text as an owner room message, using the stable ID.
- `server/message-db.ts` and `server/store.ts`: released messages and their
  `copyOf`/lineage remain ordinary transcript content. The originals also remain.
  Receipt retention must not erase text the owner chose to publish or its search
  index entries. Lineage references use message IDs, not a live share receipt.
- `server/memory/capture.ts`: request cards and `sharedFrom` messages are excluded
  from memory capture. `GroupView.tsx` renders released messages independently of
  the receipt, including the source label.
- `server/database.ts`: secure_delete is enabled. This is logical receipt cleanup,
  not a claim of immediate forensic erasure from WAL files or existing backups.
  Pruning creates no new archive or copy. Existing backups are not rewritten.
- `installation-app-schema-downgrade.ts`: the card table can already be removed
  while transcript cards remain; missing receipts use the closed-card state.

- `room-share-log.ts` reads only the fixed paths below. It does not search tool
  results or arbitrary children. Unchanged frames retain object identity; changed
  paths are copied, preserving live approval input. The server identity is
  `OWN_BUILTINS.agents` (`agents`), the mount of `agents-proxy.ts`'s
  `ask_owner_to_share`, not the proxy's descriptive `serverInfo.name`.
  Matching is exact, against whole strings: bare `ask_owner_to_share` without a
  server field or on the `agents` or `murage-agents` server,
  `mcp__agents__ask_owner_to_share` (Claude, Codex), `agents__ask_owner_to_share`
  (Fuigo and Grok stamps and titles), `agents_ask_owner_to_share` (Pi and chat callable),
  and `agents-ask_owner_to_share: ask_owner_to_share` (Cursor's title form, recorded from
  real cursor-agent 2026.10.19 for another tool of this server). Antigravity's mount key
  `murage-agents` counts only on frames only it sends: `call_mcp_tool`, and a runtime event
  with `provider: "antigravityAgent"`. A custom server of that name on another engine keeps its
  arguments. Another named server or prefix is retained. No suffix matching or recursive
  traversal occurs.
  Accepted limit, not a leak path in practice: Pi and chat's `_2` clash suffix is not
  matched, because it needs another mount whose sanitized name clashes. The proposal
  server's random alias is not listed because the tool is not mounted on a proposal turn.

### Unstamped ACP titles (coordinator's ruling, native log only)

On an ACP frame with no readable stamp, a title holding `ask_owner_to_share` as a whole
word, in any case, loses its arguments in the native log. `-`, `:`, `.` and spaces end a
word, so `agents-ask_owner_to_share` matches. `_` and letters join one, so
`ask_owner_to_share_v2` and `other__ask_owner_to_share` don't. A title over 512 characters
counts as this tool. This is the one place matching isn't exact: another server's
same-named tool on these engines loses its arguments in this diagnostic log only, never on
a live card, call, gate or permission.

Residual: Gemini, Kimi, Qwen, Cline, Droid, Hermes, opencode-go and custom ACP have no
recorded title for this server's tools. An engine that titles this tool with entirely
different words still logs the query, so the native log isn't proven clean on those 8.

### Diagnostic shape inventory

| Receiver / shape | Identity path | Argument fields removed |
| --- | --- | --- |
| Codex `mcpServer/elicitation/request` | `params.serverName` + `params._meta.tool_name` | `params._meta.tool_params` |
| Codex `item/started`, `item/completed`, MCP `params.item.type=mcpToolCall` | `params.item.server` + `params.item.tool` (driver fallback: `name`) | `params.item.arguments` |
| Runtime `item.started`, `itemType=tool` | `toolIdentity.name` + optional `server`, otherwise `title` | `input`, diagnostic `raw` |
| Runtime `request.opened` and `item.started` for `use_tool` | `tool_name` in `toolCall.input`, else `input`, else parsed `toolInput`; text it can't read names no tool, so only the driver's own decision can remove it | same fields as the row below |
| Runtime `request.opened` | `tool`, otherwise `toolIdentity.name`, with optional identity `server` | `toolInput`, `input`, diagnostic `raw`, `toolCall.input` (call identity and siblings remain) |
| Codex hook delivery object | `tool_name` | `tool_input` |
| Claude `assistant` | `message.content[i].name` on `type=tool_use` | block `input` |
| Claude `stream_event`, `event.type=content_block_start` | `event.content_block.name` on `type=tool_use` | block `input` |
| Antigravity `step_update`, tool step `call_mcp_tool` | `step_update.tool_info.parameters.ServerName` + `ToolName` | parameters `Arguments` |
| Antigravity hook `tool_name=call_mcp_tool` | `tool_input.ServerName` + `ToolName` | `tool_input.Arguments` |
| Chat assistant replay (passed individually from `openai-chat.nativeOut`) | `tool_calls[i].function.name` | function `arguments` |
| Pi `tool_execution_start`, `_update`, `_end` | `toolName` | `args` |
| Pi `message_start`, `message_update`, `message_end`, `turn_end` | `message.content[i].name` on `type=toolCall` | the block keeps `type`, `id`, `name` only (providers add `partialArgs`, `argumentsError`, `customInput`) |
| Pi `message_update.assistantMessageEvent` | `toolCall.name`; `partial.content[i].name`; for `toolcall_delta`, the block at `contentIndex` in `partial` or `message` | same block rule, and `delta` |
| Pi `agent_end` | `messages[m].content[i].name` on `type=toolCall` | same block rule |
| Pi gate `extension_ui_request`, `method=editor`, title `murage-gate:` | parsed `prefill`: `mcpTool` + `mount`, otherwise `tool` | `prefill` (also when over 1 MiB or unreadable) |
| ACP `session/request_permission` | `params.toolCall._meta["fuigo/tool"].name` / Grok `"x.ai/tool"` stamp, otherwise `title`; when that is `use_tool` (how Fuigo and Grok file every MCP call), `rawInput.tool_name` | `params.toolCall.rawInput` |
| ACP `session/update`, `sessionUpdate=tool_call` / `tool_call_update` | same stamp or title at `params.update` | `params.update.rawInput` |

Claude content, Pi message content and chat replay tool-call arrays up to 1024 entries are inspected
once, one level; no arguments or results are walked. Before reading any element
or copying an array, larger arrays become
`{omitted: "tool-call array exceeds limit", size: N}` in the logged copy. This
also omits ordinary oversized assistant content: an uninspected tail cannot be
proven free of a share call. Pi `agent_end` holds a run's messages, so its cap is
1024 messages and 1024 content entries across them together, and over that the
whole list becomes the marker. Only these tool-call positions have this policy;
unrelated arrays and ordinary under-cap frames retain identity. Chat nativeOut
accepts this marker without trying to map it as an array. Codex's notification switch does not read
legacy `codex/event` or raw-item argument frames, so those are not invented
entries in this inventory. Its legacy approval methods are command/patch asks,
not MCP calls. Hooks arrive on the hook socket and become runtime approvals;
they are not invented app-server hook notifications. Runtime `item.completed`
carries a result and no tool-name/argument field;
its result (including a nested name/input collision) remains the same object.
Text deltas are not argument paths. Claude's `input_json_delta` carries only a
block index, so `partial_json` is removed from the native copy for every tool:
the complete input follows in the assistant message, which is judged by name.
Box exposes its computer
loop, not MCP; lifecycle diagnostic rows carry no MCP arguments. Chat incoming
log projections contain text/usage, not tool calls; its outgoing replay messages
are redacted before projection. The fake-ask driver emits only its fixed phone
fixture. Claude, Pi, Antigravity, chat replay,
and ACP apply the same helper before their native tees, as Codex already did.

- Existing log files are not rewritten by receipt pruning. Event logs rotate at
  16 MiB per segment with a 256 MiB folder budget and 30-day age policy; native
  logs rotate at 4 MiB with a 256 MiB folder budget and seven-day age policy.
  Age is measured from **file modification time**, not each record's timestamp:
  continued writes can keep an older query in the active segment until rotation
  or conversation deletion. Budget/age sweeps delete whole files. This is not a
  promise that historical logged queries disappear 30 days after receipt expiry.

## Packaged-app rows

Run in an isolated packaged-app fixture, never the owner's installation.

| Exact action | Pass oracle |
| --- | --- |
| Mount a pending room-share card, keep it visible, and wait through its `expiresAt` without navigating or refreshing. | The subscription re-renders the mounted card: preview excerpts and Share/Don't share buttons disappear, the existing closed-request text appears, and no spinner remains. |
| Mount a card whose receipt GET returns 404 (delete only that finished receipt in the isolated fixture, then reopen its transcript). | The original request sentence remains; the existing localized closed-request text appears with no spinner or action buttons. No successful/declined outcome is invented. |

## Verification on this box (1.0.18, X2 fix round)

Tests precede their fixes. Evidence is under `.test-tmp/x2-*` (local artifacts,
not shipped files). The initial real lock regression measured 1011 ms against
its 400 ms ceiling; the old redactor leaked elicitation arguments, changed an
unrelated nested result, and overflowed on a 200000-deep payload. The scheduler
failed with an alternate exported batch limit, and the boot helper was missing.
Removing `changed(value)` made all six lifecycle tests fail; it was restored.
The lifecycle suite asserts subscriber calls, including open, expiry, closed,
and busy transitions; it does not mount React.

The Codex integration fixture calls `handleCodexStdoutLine`, the actual parsing,
native tee, and live dispatch handler used by the driver, with an isolated
home/data directory. No process or sink is mocked. With the old redactor the
real native file contained `private search words`; after the fix it must not,
and the callback receiving the live elicitation must retain those arguments.
An attempted full fake-process fixture could not complete its launch/shutdown
in this sandbox; the handler fixture isolates the requested native tee path.

The standard requested Vitest command is blocked before tests by
`freePortBlock`: this sandbox refuses listening ports. The HTTP test still uses
`launchVerificationServer`; its owner 404 and anonymous refusal-before-lookup
assertions are left for the shepherd. Anonymous access must return the gate's
`404 {error:"no such route"}`, not the receipt lookup's `no such share request`.
No live app or user data was used. Packaged-app rows above remain manual.

Commands (offline; all temporary artifacts and npm cache within this worktree):

```sh
export TMPDIR="$PWD/.test-tmp" npm_config_cache="$PWD/.test-tmp/npm"
npx --offline vitest run server/room-share-maintenance.test.ts server/room-shares-prune.test.ts server/room-shares-log.test.ts server/room-shares-api.test.ts src/components/RoomShareCard.test.ts
npx --offline vitest run --config .test-tmp/unit.config.mts server/room-share-maintenance.test.ts server/room-shares-prune.test.ts server/room-shares-log.test.ts src/components/RoomShareCard.test.ts
NODE_OPTIONS=--max-old-space-size=12288 npx --offline tsc -p tsconfig.server.json
git diff --check
```

The supplemental config omits the port-dependent suite setup and supplies an
isolated home/data directory and the suite's native process-exclusion fixture.
It does not stub port allocation or HTTP behavior. Changes remain uncommitted.

Final result: 36 supplemental tests pass (`x2-after-unit.log`), server TypeScript
passes with `NODE_OPTIONS=--max-old-space-size=12288` (`x2-tsc.log`), and
`git diff --check` passes. The standard suite (`x2-standard.log`) and isolated
HTTP launcher (`x2-http-fixture.log`) both stop at port allocation. No mounted
renderer verification is claimed. No shipped strings changed.


## Round 2 on ef684424a

All edits remain uncommitted. No network or live installation was used. Evidence
is in `.test-tmp/x2-round2-*.log`; temporary HOME/data and TMPDIR stay inside this
worktree. The project-memory prelude tool and `.ijfw/memory` were unavailable.

Tests preceded fixes: `before.log` records 13 failures (Claude approval summary,
Codex foreign-server identity, oversized arrays, and display text). The next
`audit-before.log` records two failures for ACP server loss and display-only
frames without arguments. `stamp-before.log` records the qualified chat runtime
identity leak. `route-mutant.log` fails when only the GET route-local owner guard
is deleted, independently of the outer gate; the guard was then restored.

### Display-text audit across the inventory

The fixed diagnostic label is `mcp__agents__ask_owner_to_share`. It is log-only;
it does not replace a live approval subtitle, activity row, or shipped UI string.
At the identified tool position, present `summary`, `title`, `command`,
`description`, `message`, `reason`, `text`, `spoken`, and `activity` fields use
that label, even if the argument field is absent. No arbitrary children are
searched. The shape-specific locations are:

- Codex elicitation: `_meta` and enclosing `params` (including elicitation
  `message`); MCP started/completed: the item. Runtime approval/start: the event
  and approval `toolCall`. Argument-derived choices/questions/file paths are
  omitted from share approvals in the log copy too.
- Claude: `askSummary` actually serializes ordinary input. Its exported production
  function supplies the regression's real permission summary; both live summary
  and input remain intact. Native assistant and stream shapes clean the identified
  `tool_use` block, retaining neighboring text blocks.
- ACP engines (including Fuigo/Grok stamps): permission `toolCall` and tool-call
  `update`, including titles and activity content. `content` and `locations` on
  those exact calls are omitted along with `rawInput`; summary/reason generated
  by the runtime projection are cleaned at the runtime event. Ordinary results
  and unrelated tool updates are not recursively searched.
- Antigravity: hook frame and its parameters, or step and `tool_info` and its
  parameters. This covers descriptions/activity text alongside `Arguments`.
- Pi: native tool-start frame and runtime approval/start. The mounted permission
  summary can include a note; the log copy replaces it. Chat: replay call and
  function, and runtime approval/start. Chat's native projection accepts the
  overflow marker. Box has no MCP shape; fake-ask has only fixed fixture text.
- The persisted activity tool line in `server/index.ts` is built from the live
  event, not `loggedRuntimeEvent` or this helper. This change does not rewrite
  released messages or historical logs. One live exception, per main's ruling: on an
  ACP start whose wrapper names this tool exactly (`use_tool` on Fuigo and Grok), the
  driver leaves off `summary`, the first 80 characters of the query, so the stored
  activity line, memory feedback and the tray never receive it. The chip still names
  the tool, and the query stays on the owner's card and receipt. A title match never
  does this. The tool is new in 1.0.18, so no stored line needs rewriting. No other
  driver's tool start carries a summary (`room-shares-log.test.ts`).

ACP's runtime events carry no title or stamp the log copy can judge, so the driver makes
one decision per engine call, on the whole call, for the native frame and the runtime
event alike. It passes that decision out of band: the event object is remembered in a
weak set and nothing is added to it, so no listener, client, card, gate or stored record
can hold it. `EventBus.attach` passes it to the copy it publishes, and only the log copy
reads it. It only ever removes from logs. The decision is stateless, made from one frame
alone. On a driver that restamps, the engine's own stamp decides, because that is the one
the driver's live readers get; the native copy is made before the restamp and the event
after, so both logs read the same stamp.

On ACP the driver's decision from the whole call settles the runtime event both ways: a
call it judged another tool's carries a second private "kept" mark, which the bus carries like
the first, and the name fallback never strips a kept event. The runtime title is the chip's
and may be the bare inner name of a foreign call. A real title is judged as itself for the
summary too, never by its arguments. An identity naming another tool is that tool, whatever
the title or `tool` field says. On the runtime log, the dispatcher is the engine's own bare `use_tool`: a call with a
server on its identity, or any name qualified by another server (`mcp__other__use_tool` on
Codex's elicitation or hook ask), is that server's tool, and a Claude start titled with a
real tool is that tool, whatever its arguments name. A bare `tool` keeps the server its
`toolCall.name` gives it, so another server's `ask_owner_to_share` keeps its log. A server
called `murage-agents` is Murage's only on Antigravity. On ACP, a stamped `use_tool` with a
server is that server's tool, not the dispatcher. A stamp naming a tool settles it: a dispatcher's title or a share name in the arguments
can't override it, and such a call keeps its log and summary. A wrapper's `tool_name` is read
before `toolName`, as the chip reads them. A permission ask or a bare `tool_call` that names
no tool at all logs as ordinary, like the residual below.

A `tool_call_update` that names no tool (no title or only the dispatcher's display title, no
stamp or only the dispatcher's, no inner tool name) can't be judged from itself, so it loses `rawInput` and `locations` in the
native log for every tool: the driver never reads those on an update, so this costs only log
detail. It keeps `content`, which normal tool output logs rely on. A share call's `content`
holds no argument text from Murage: the only results are the fixed `SHARE_ASKED_LINE` and
fixed refusal lines (`server/room-shares.ts:23,25,186,190`, `server/index.ts` `serveShareAsk`
and the internal route's catch). The query and the excerpts are never in a tool result. An
engine that writes the arguments into its own update `content` isn't covered: no such frame
is on record. A call cut by `boundedToolInput` is judged before the cut. Text the log copy
can't read names no tool, so another tool's cut call keeps its log.

Residual, per main's ruling: an engine that titles this tool in entirely different words
still logs the query. No recorded titles exist for Gemini, Kimi, Qwen, Cline, Droid,
Hermes, opencode-go or custom ACP, so the log redaction isn't complete on those. Hermes
has `mcp__agents__list_bots` on record (`hermes-own-tools.test.ts:5`), which the exact
set already covers; that isn't a share title.

Codex's production `codexItemToolIdentity` now retains `item.server` without
changing `name`; driver-normalization-to-runtime-log tests exercise both agents
and other. ACP also retains optional stamped server on permission and start
identities. Claude uses qualified names; Pi/chat/Antigravity mounted permission
identities already retain server qualification. Exact runtime MCP stamps
`{namespace:"mcp",name:"agents__ask_owner_to_share"}` are recognized, including
chat starts whose display title is a sanitized alias; foreign qualified stamps
stay unchanged. This is not suffix matching.

Oversized-array regressions cover a share at index 1024, one at index 0, ordinary
1024-entry identity preservation, ordinary overflow, and a million-entry array
whose first-element getter and slice throw. Neither is touched for overflow.

The owner HTTP suite still needs ports and an isolated launcher. Shepherd must
run `server/room-shares-api.test.ts`, specifically “GET an unknown receipt returns
404 through the owner HTTP route” and “refuses a non-owner before looking up even
a missing receipt”. The added “pins the route-local owner check before receipt
lookup” runs without ports and catches removal of the inner check. The standard
HTTP command in `http.log` fails at `freePortBlock`; no HTTP behavior is claimed.
Packaged-app verification remains outstanding as above.

Round 2 commands (repository-installed tools, offline):

```sh
TMPDIR="$PWD/.test-tmp" ./node_modules/.bin/vitest run --config .test-tmp/unit.config.mts server/room-shares-log.test.ts server/room-share-maintenance.test.ts server/room-shares-prune.test.ts src/components/RoomShareCard.test.ts server/runtime-event-out.test.ts
TMPDIR="$PWD/.test-tmp" ./node_modules/.bin/vitest run --config .test-tmp/unit.config.mts server/room-shares-api.test.ts -t 'pins the route-local'
TMPDIR="$PWD/.test-tmp" ./node_modules/.bin/vitest run server/room-shares-api.test.ts
NODE_OPTIONS=--max-old-space-size=12288 TMPDIR="$PWD/.test-tmp" ./node_modules/.bin/tsc -p tsconfig.server.json
git diff --check
```

Results: all 40 logging tests pass (`overflow.log`); the other four targeted
suites contribute 23 passing tests (`unit.log`), and the route-local pin passes
(`route.log`): 64 tests total. Server tsc with the requested 12288 MiB heap passes
(`tsc.log`), and `git diff --check` passes. No shipped strings changed.

## Native tee tests

`server/room-shares-log.test.ts` drives the real Claude and Pi drivers with their fake CLIs and reads the native log back. The Pi test uses Pi's real callable name and its assistant message, delta and `agent_end` frames. Those two tests fail if `claude.ts` or `pi.ts` stops calling `redactRoomShareArguments` before `appendNative`, and they also prove another server's same-named tool keeps its arguments. The Antigravity, ACP and chat tees have a source pin in the same file.
