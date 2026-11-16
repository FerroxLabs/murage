# Routines and tool identity: English inventory

Base: `7c9ce6fe3e783b19a9cda1969d7aa9de676ec356`. This conservative inventory includes English string literals on added production lines, including moved existing copy. Tests, fixture transcripts, source comments, import paths and non-English identifiers are excluded. Protocol diagnostics are distinguished from owner-facing copy. No new controls or permission labels are introduced.

The three ACP runtime errors below are emitted to the active conversation. They describe a rejected/unavailable action and do not promise that it executed. Their source locations are included in the complete inventory.

- “Hermes permission could not be bound to the approved action; Murage rejected it.”
- “Hermes bot turns require the default approval mode. The prompt was not sent.”
- “The saved approval differs from the engine request. Murage rejected it.”

## Release-note additions

Routine scheduling stays responsive as past runs accumulate.

- Stopping a file-watch run now records its cancellation before aborting the read; a failed save leaves the read available to retry.
- Routine history is trimmed in small steps across scheduler ticks. A large backlog can take several ticks to reach the usual history target.
- A time zone change updates daily routines in small steps. New dispatch waits until those steps finish.
- Answering a routine card continues the newest open run holding that card. Settled runs no longer claim the continuation.
- Automatically permitted routine and webhook changes stay responsive as old runs and confirmation receipts accumulate.
- Inbox connection badges recover when older routine cards leave the history window, and routine links follow new messages.

## Production string inventory

| File and line | Surface | English |
|---|---|---|
| `server/drivers/acp/core.ts:4252` | Runtime error shown in the conversation | Hermes permission could not be bound to the approved action; Murage rejected it. |
| `server/drivers/acp/core.ts:6865` | Runtime error shown in the conversation | Hermes bot turns require the default approval mode. The prompt was not sent. |
| `server/drivers/acp/core.ts:7445` | Runtime error shown in the conversation | The saved approval differs from the engine request. Murage rejected it. |
| `server/drivers/acp/hermes.ts:249` | Internal diagnostic / protocol error | Hermes bot turn refused: administrator pre_tool_call hooks are configured. |
| `server/drivers/acp/tool-tripwire.ts:53` | User action summary | \n... (${points.length} chars total, truncated) |
| `server/drivers/acp/tool-tripwire.ts:54` | User action summary | Running Python helper script:\n\n\&#96;\&#96;\&#96;python\n${preview}\n\&#96;\&#96;\&#96; |
| `server/drivers/acp/tool-tripwire.ts:54` | User action summary | Running Python helper script |
| `server/drivers/acp/tool-tripwire.ts:89` | Internal diagnostic / protocol error | ask toolCallId reused |
| `server/drivers/acp/tool-tripwire.ts:114` | Internal diagnostic / protocol error | runtime.error: allow on ${reload === undefined ? a.classification.type : "reloaded"} ask ${a.tcid} sent as reject |
| `server/drivers/acp/tool-tripwire.ts:130` | Internal diagnostic / protocol error | start reuses an id |
| `server/drivers/acp/tool-tripwire.ts:132` | Internal diagnostic / protocol error | start identity unproven |
| `server/drivers/acp/tool-tripwire.ts:137` | Internal diagnostic / protocol error | edit start carries a diff: Hermes approved it itself |
| `server/drivers/acp/tool-tripwire.ts:155` | Internal diagnostic / protocol error | bad permission completion |
| `server/drivers/acp/tool-tripwire.ts:159` | Internal diagnostic / protocol error | update for an unknown execution |
| `server/drivers/acp/tool-tripwire.ts:160` | Internal diagnostic / protocol error | update after the execution ended |
| `server/drivers/acp/tool-tripwire.ts:161` | Internal diagnostic / protocol error | frozen kind changed |
| `server/drivers/acp/tool-tripwire.ts:164` | Internal diagnostic / protocol error | frozen title changed |
| `server/drivers/acp/tool-tripwire.ts:169` | Internal diagnostic / protocol error | edit completed without a bound edit allow |
| `server/drivers/acp/tool-tripwire.ts:207` | Internal diagnostic / protocol error | turn refused before prompt |
| `server/inbox-routine-aggregate.ts:47` | Internal diagnostic / protocol error | Inbox aggregate timestamp must be finite |
| `server/inbox-routine-aggregate.ts:171` | Internal diagnostic / protocol error | Inbox rollup rebuild exceeds source limits |
| `server/inbox-routine-aggregate.ts:208` | Internal diagnostic / protocol error | Inbox routine rollup consistency check failed |
| `server/inbox-routine-lifecycle.ts:125` | Internal diagnostic / protocol error | inbox: routine rollup rebuild failed |
| `server/inbox-routine-lifecycle.ts:220` | Internal diagnostic / protocol error | inbox: routine expiry update failed |
| `server/inbox-routine-lifecycle.ts:241` | Internal diagnostic / protocol error | inbox: routine link update failed |
| `server/index.ts:12138` | User-facing action refusal | The original routine run is no longer available. |
| `server/routine-message-links.ts:22` | Internal diagnostic / protocol error | (SELECT rowkey FROM routine_link_members WHERE thread_id=${row}.thread_id AND id=${row}.id) |
| `server/routine-runs-journal.ts:79` | Internal diagnostic / protocol error | Routine journal ${filename}: ${stage} failed after ${bytesWritten} bytes |
| `server/routine-runs-journal.ts:123` | Internal diagnostic / protocol error | Invalid routine proposal receipt |
| `server/routine-runs-journal.ts:310` | Internal diagnostic / protocol error | Commit tag range exhausted |
| `server/routine-runs-journal.ts:344` | Internal diagnostic / protocol error | routines.json is not an object |
| `server/routine-runs-journal.ts:374` | Internal diagnostic / protocol error | Invalid write progress |
| `server/routine-runs-journal.ts:453` | Internal diagnostic / protocol error | Proposal requires a published journal generation |
| `server/routine-runs-journal.ts:455` | Internal diagnostic / protocol error | Proposal escaped its journal file |
| `server/routine-runs-journal.ts:548` | Internal diagnostic / protocol error | Invalid published journal commit |
| `server/routines.ts:1277` | Internal diagnostic / protocol error | Scoped mutation escaped its declared objects |
| `server/routines.ts:1278` | Internal diagnostic / protocol error | Routine persistence requires quiescent lifecycle recovery |
| `server/routines.ts:1343` | Internal diagnostic / protocol error | List mutation inside scope |
| `server/routines.ts:1398` | Internal diagnostic / protocol error | Undeclared append |
| `server/routines.ts:1698` | Internal diagnostic / protocol error | Receipt replacement inside scope |
| `server/routines.ts:1705` | Internal diagnostic / protocol error | Undeclared proposal receipt |
| `server/routines.ts:2706` | Internal diagnostic / protocol error | The assigned bot was deleted |
| `server/routines.ts:2738` | Internal diagnostic / protocol error | The assigned room was deleted |
| `server/routines.ts:4543` | Internal diagnostic / protocol error | Aliased value belongs to an undeclared tracking root |
| `server/routines.ts:4552` | Internal diagnostic / protocol error | Write outside declared scope |
| `server/routines.ts:4555` | Internal diagnostic / protocol error | Irreversible record mutation |
| `server/routines.ts:4556` | Internal diagnostic / protocol error | Scoped identity change |
| `server/routines.ts:4562` | Internal diagnostic / protocol error | Irreversible descriptor change |
| `server/routines.ts:4571` | Internal diagnostic / protocol error | Nested transaction |
| `server/routines.ts:4577` | Internal diagnostic / protocol error | Run is not canonical |
| `server/routines.ts:4581` | Internal diagnostic / protocol error | Routine is not canonical |
| `server/routines.ts:4584` | Internal diagnostic / protocol error | Append uses a foreign tracking root |
| `server/routines.ts:4588` | Internal diagnostic / protocol error | Append ID is already present |
| `server/routines.ts:4591` | Internal diagnostic / protocol error | Scope must use one journal file |
| `server/routines.ts:4599` | Internal diagnostic / protocol error | Declared append was not inserted |
| `server/routines.ts:4630` | Internal diagnostic / protocol error | Nested proposal transaction |
| `server/routines.ts:4634` | Internal diagnostic / protocol error | Proposal has no journal location |
| `server/routines.ts:4637` | Internal diagnostic / protocol error | Proposal receipt moved files |
| `server/routines.ts:4638` | Internal diagnostic / protocol error | Proposal scope is not canonical |
| `server/routines.ts:4681` | Internal diagnostic / protocol error | Nested full transaction |
| `server/routines.ts:4812` | Internal diagnostic / protocol error | routine: lifecycle recovery remains held: ${error instanceof Error ? error.message : String(error)} |
| `shared/tool-identity.ts:163` | Internal diagnostic / protocol error | invalid native tool name |
| `shared/tool-identity.ts:166` | Internal diagnostic / protocol error | unproven MCP mount |
| `shared/tool-identity.ts:171` | Internal diagnostic / protocol error | unreadable engine frame |
| `shared/tool-identity.ts:175` | Internal diagnostic / protocol error | unknown Claude frame |
| `shared/tool-identity.ts:186` | Internal diagnostic / protocol error | invalid Codex MCP item |
| `shared/tool-identity.ts:192` | Internal diagnostic / protocol error | unpinned Codex hook or item |
| `shared/tool-identity.ts:195` | Internal diagnostic / protocol error | unpinned Hermes build |
| `shared/tool-identity.ts:199` | Internal diagnostic / protocol error | unproven Hermes start |
| `shared/tool-identity.ts:201` | Internal diagnostic / protocol error | Hermes update requires frozen identity |
| `shared/tool-identity.ts:207` | Internal diagnostic / protocol error | unproven Hermes ask |
| `shared/tool-identity.ts:207` | Internal diagnostic / protocol error | Hermes ask requires driver binding |
| `shared/tool-identity.ts:213` | Internal diagnostic / protocol error | unreadable or mismatched stamp |
| `shared/tool-identity.ts:217` | Internal diagnostic / protocol error | unknown stamped tool |
| `shared/tool-identity.ts:219` | Internal diagnostic / protocol error | unknown stamp namespace |
| `shared/tool-identity.ts:220` | Internal diagnostic / protocol error | stamp names no tool |
| `shared/tool-identity.ts:224` | Internal diagnostic / protocol error | unreadable dispatcher |
| `shared/tool-identity.ts:231` | Internal diagnostic / protocol error | unproven dispatch target |
| `shared/tool-identity.ts:233` | Internal diagnostic / protocol error | unreadable dispatch input |
| `shared/tool-identity.ts:236` | Internal diagnostic / protocol error | dispatcher depth exceeded |
| `shared/tool-identity.ts:239` | Internal diagnostic / protocol error | non-identifying ACP kind |
| `shared/tool-identity.ts:261` | Internal diagnostic / protocol error | identity did not re-derive |
