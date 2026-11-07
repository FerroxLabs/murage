import { OWN_BUILTINS } from "../shared/own-servers.ts";

const SHARE = "ask_owner_to_share";
const PREFIXED_SHARE = `mcp__${OWN_BUILTINS.agents}__${SHARE}`;
// Antigravity mounts the same proxy under this key (ANTIGRAVITY_AGENTS_MCP_KEY; a test holds them equal).
const ANTIGRAVITY_AGENTS = "murage-agents";
// Every name a mounted engine really gives this one tool, as whole strings: Claude and Codex `mcp__agents__`, Fuigo and
// Grok stamps `agents__`, Pi and chat callable `agents_`, Cursor's recorded title form. Never a suffix or a pattern.
const SHARE_NAMES: ReadonlySet<unknown> = new Set([
  SHARE, PREFIXED_SHARE, `${OWN_BUILTINS.agents}__${SHARE}`, `${OWN_BUILTINS.agents}_${SHARE}`,
  `${OWN_BUILTINS.agents}-${SHARE}: ${SHARE}`,
]);
// Antigravity's own names, only on frames that only Antigravity sends: another engine may mount a custom server called this.
const ANTIGRAVITY_NAMES: ReadonlySet<unknown> = new Set([`mcp__${ANTIGRAVITY_AGENTS}__${SHARE}`, `${ANTIGRAVITY_AGENTS}__${SHARE}`]);
const PI_CALL_KEEP = ["type", "id", "name"] as const;
// piGateMessage never sends more than PI_GATE_MESSAGE_MAX; a longer prefill is not one this path can read, so it is not logged.
const GATE_PREFILL_LIMIT = 1024 * 1024;
const GATE_TITLE = "murage-gate:";
const CONTENT_LIMIT = 1024;
type Row = Record<string, any>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
function share(name: unknown, server?: unknown): boolean {
  if (server !== undefined && server !== OWN_BUILTINS.agents) return false;
  return SHARE_NAMES.has(name);
}
function without(value: Row, fields: readonly string[]): Row {
  if (!fields.some(field => Object.hasOwn(value, field))) return value;
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

// Diagnostic labels only: the live approval/card and transcript projection do not use this copy.
const DISPLAY_FIELDS = ["summary", "title", "command", "description", "message", "reason", "text", "spoken", "activity"] as const;
function cleanCall(value: Row, fields: readonly string[]): Row {
  let clean = without(value, fields);
  for (const field of DISPLAY_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (clean === value) clean = { ...value };
    clean[field] = PREFIXED_SHARE;
  }
  return clean;
}
/** The last `__` segment, as the ACP driver titles a dispatched start (bareToolName). */
const bareName = (name: string): string => { const parts = name.split("__").filter(Boolean); return (parts.length > 1 ? parts[parts.length - 1] : name).trim(); };
/** `mcp__<server>__<tool>` or `<server>__<tool>` with a server other than this tool's own mount. `murage-agents` is Murage's
 * only on Antigravity: another engine may mount a custom server called that. */
function qualifiedElsewhere(name: unknown, antigravity: boolean): boolean {
  if (typeof name !== "string") return false;
  const parts = name.replace(/^mcp__/, "").split("__");
  if (parts.length < 2 || !parts[0]) return false;
  return parts[0] !== OWN_BUILTINS.agents && !(antigravity && parts[0] === ANTIGRAVITY_AGENTS);
}
const overflow = (size: number) => ({ omitted: "tool-call array exceeds limit", size });

const antigravityShare = (name: unknown, server: unknown): boolean => server === ANTIGRAVITY_AGENTS ? name === SHARE : share(name, server);
/** Pi's providers keep the call in scratch fields of their own (partialArgs, argumentsError, customInput), so a matched
 *  block keeps its identity and nothing else, rather than naming each field to drop. */
function piCall(block: Row): Row {
  const clean: Row = {};
  for (const field of PI_CALL_KEEP) if (Object.hasOwn(block, field)) clean[field] = block[field];
  return clean;
}
/** A Pi assistant message: one level of content, capped, `toolCall` blocks by exact name. */
function cleanPiMessage(message: Row): Row {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  if (content.length > CONTENT_LIMIT) return { ...message, content: overflow(content.length) };
  let clean: unknown[] | undefined;
  for (let i = 0; i < content.length; i++) {
    const block = row(content[i]);
    if (block?.type !== "toolCall" || !share(block.name)) continue;
    clean ??= content.slice();
    clean[i] = piCall(block);
  }
  return clean ? { ...message, content: clean } : message;
}
const piShareAt = (message: Row | undefined, index: unknown): boolean => {
  const content = message?.content;
  if (!Array.isArray(content) || !Number.isInteger(index)) return false;
  const block = row(content[index as number]);
  return block?.type === "toolCall" && share(block.name);
};
/** JSON text a log path has to read; null when it is too long or can't be read, which its callers treat as unproven. */
function parsedRow(text: string): Row | null {
  if (text.length > GATE_PREFILL_LIMIT) return null;
  try { return row(JSON.parse(text)) ?? null; } catch { return null; }
}
/** A Pi gate ask's prefill is the whole call as JSON (piGateMessage). Dropped for the share tool, and whenever it can't be read. */
function gatePrefillIsShare(prefill: string): boolean {
  const call = parsedRow(prefill);
  if (!call) return true;
  return call.mcpTool !== undefined ? call.mcpTool === SHARE && share(SHARE, call.mount) : share(call.tool);
}
// Main's ruling for ACP frames with no stamp, native log only: several engines send a free title and no recorded spelling
// exists, so the name as a whole word counts, in any case. `_` joins a word, so `other__ask_owner_to_share` and
// `ask_owner_to_share_v2` don't match; `-`, `:` and spaces end one, so `agents-ask_owner_to_share` does. A title too long to
// read counts as this tool: length must not be a way past the match. The live frame is never touched.
const TITLE_MAX = 512;
const TITLE_WORD = new RegExp(`(?<![A-Za-z0-9_])${SHARE}(?![A-Za-z0-9_])`, "i");
const unstampedTitleIsShare = (title: unknown): boolean => typeof title === "string" && (title.length > TITLE_MAX || TITLE_WORD.test(title));
// Fuigo and Grok file every MCP call through this dispatcher: {variant, tool_name: "agents__...", tool_input}.
const USE_TOOL = "use_tool";
const useToolShare = (input: unknown): boolean => {
  const body = row(input);
  return !!body && share(body.tool_name ?? body.toolName); // the name resolveToolLabel shows: tool_name first
};
/** The runtime copy of a dispatcher call: the call itself, else the start's input, else the bounded text. Text it can't read
 * names no tool, so it is another tool's until proven: a share call cut by boundedToolInput is carried by the mark below. */
function runtimeUseToolShare(frame: Row): boolean {
  const direct = row(frame.toolCall)?.input ?? frame.input;
  if (row(direct)) return useToolShare(direct);
  if (typeof frame.toolInput !== "string") return useToolShare(frame.toolInput);
  const text = parsedRow(frame.toolInput);
  return text ? useToolShare(text) : false;
}
/** The stamp a frame's call is judged by, as the driver will restamp it (acpRestampFrame): the engine's own key wins over any
 * `fuigo/tool` beside it. The log copy is made before the restamp and the event after, so both logs read the same stamp. */
function acpStamp(call: Row, ownStamp?: string): Row | undefined {
  const meta = row(call._meta);
  if (ownStamp && meta && Object.hasOwn(meta, ownStamp)) return row(meta[ownStamp]);
  return row(meta?.["fuigo/tool"] ?? meta?.["x.ai/tool"]);
}
/** A title that names no tool: none, blank, or only the dispatcher's own display name ("use_tool", Grok's "Use Tool"). */
const titleNamesNoTool = (title: unknown): boolean => typeof title !== "string" || !title.trim() || /^use[ _-]?tool$/i.test(title.trim());
const innerToolName = (call: Row): unknown => { const body = row(call.rawInput); return body?.tool_name ?? body?.toolName; };
/** The engine's own dispatcher has no server; a stamped `use_tool` from another server is that server's tool. */
const dispatcherStamp = (stamp: Row | undefined): boolean => stamp?.name === USE_TOOL && stamp.server === undefined;
/** The frame's identity is only the dispatcher, or nothing, so its inner tool name is what names the call. A stamp naming a tool
 * settles it, and a title settles it only where there is no stamp. */
function identifiesOnlyDispatcher(call: Row, stamp: Row | undefined): boolean {
  return stamp && typeof stamp.name === "string" ? dispatcherStamp(stamp) : titleNamesNoTool(call.title);
}
/** An update that says nothing about which tool it belongs to: no title, no stamp, no inner tool name. A dispatcher's stamp or
 * display title names only the dispatcher, so it counts as none. */
function namesNoTool(call: Row, ownStamp?: string): boolean {
  if (typeof innerToolName(call) === "string") return false;
  const stamp = acpStamp(call, ownStamp);
  if (stamp && !dispatcherStamp(stamp)) return false;
  return titleNamesNoTool(call.title);
}
/** The one decision for an ACP tool call, made on the engine's whole call, for the native frame and the runtime event alike. */
function acpCallIsShare(call: Row, ownStamp?: string): boolean {
  const stamp = acpStamp(call, ownStamp);
  const name = stamp ? stamp.name : call.title;
  // the title rule is for a frame with no better name: no stamp, or a dispatcher's stamp with no inner tool name
  const titleCounts = !stamp || (dispatcherStamp(stamp) && typeof innerToolName(call) !== "string");
  return share(name, stamp?.server) || (identifiesOnlyDispatcher(call, stamp) && useToolShare(call.rawInput)) || (titleCounts && unstampedTitleIsShare(call.title));
}
/** Whether a start's query-derived `summary` must stay off: a stamp naming a tool settles it, else the inner tool name decides, by
 * exact name only (never the title rule, which is for logs). The query then isn't kept in the transcript past the share row's own prune. */
function acpSummaryIsShare(call: Row, ownStamp?: string): boolean {
  const stamp = acpStamp(call, ownStamp);
  if (typeof stamp?.name === "string" && !dispatcherStamp(stamp)) return share(stamp.name, stamp.server);
  // the inner name counts only where nothing else names the call: a real title is judged as itself, exactly
  return identifiesOnlyDispatcher(call, stamp) ? useToolShare(call.rawInput) : share(call.title);
}
// ACP's runtime event has no title or stamp the log copy can judge (`tool` is the kind, "other"), so the driver hands that
// decision over out of band: the event object is remembered here and nothing is added to it, so no listener, wire or stored form
// can see or hold it. EventBus.attach passes it to the copy it publishes. Only the log copy reads it. The decision settles the
// event both ways: one the driver judged another tool's is "kept", and the name fallback below never strips it, because the
// event's title is the chip's (resolveToolLabel) and may be the bare inner name of a call the whole frame says is foreign.
const logOmitted = new WeakSet<object>();
const logKept = new WeakSet<object>();
export function carryRoomShareLogMark<T extends object>(from: object, to: T): T {
  if (logOmitted.has(from)) logOmitted.add(to);
  if (logKept.has(from)) logKept.add(to);
  return to;
}

/** Fixed protocol paths only. Never descend into inputs, outputs, or arbitrary children.
 * Copies are made only along a changed path; the live approval arguments are untouched. */
export function redactRoomShareArguments<T>(value: T, ownStamp?: string): T {
  const frame = row(value);
  if (!frame) return value;
  let out = frame;
  const params = row(frame.params);
  if (frame.method === "mcpServer/elicitation/request" && params) {
    const meta = row(params._meta);
    if (meta && share(meta.tool_name, params.serverName)) {
      const clean = cleanCall(meta, ["tool_params"]);
      const cleanParams = cleanCall(params, []);
      if (clean !== meta || cleanParams !== params) out = { ...frame, params: { ...cleanParams, _meta: clean } };
    }
  }
  if ((frame.method === "item/started" || frame.method === "item/completed") && params) {
    const item = row(params.item);
    if (item?.type === "mcpToolCall" && share(item.tool ?? item.name, item.server)) {
      const clean = cleanCall(item, ["arguments"]);
      if (clean !== item) out = { ...frame, params: { ...params, item: clean } };
    }
  }
  if ((frame.type === "request.opened" || (frame.type === "item.started" && frame.itemType === "tool")) && !logKept.has(frame)) {
    // An identity naming a tool is that tool (rule 1); without one, an approval's tool and a start's title name it.
    const identity = row(frame.toolIdentity);
    const name = typeof identity?.name === "string" ? identity.name : frame.type === "request.opened" ? frame.tool : frame.title;
    // The dispatcher is the engine's own and has no server, so another server's tool with the same name is just that tool:
    // a server on the identity, or any of the frame's names qualified by a server other than this one's, settles it.
    const antigravity = frame.provider === "antigravityAgent";
    const foreignName = [row(frame.toolCall)?.name, frame.tool, identity?.name, frame.title].some(n => qualifiedElsewhere(n, antigravity));
    // The identity alone: an identity naming another tool is that tool, whatever the title or tool field says.
    // A start with no identity is the dispatcher only while its title names no tool (rule 2): a real title is that tool.
    const startTitleNames = frame.type === "item.started" && !identity && !titleNamesNoTool(frame.title);
    const dispatched = !foreignName && !startTitleNames && typeof identity?.server !== "string" && (identity ? identity.name === USE_TOOL : frame.tool === USE_TOOL || frame.title === USE_TOOL);
    // ACP titles a start through a dispatcher with the inner tool's bare name, which drops its server: the inner name decides.
    // A title that names some other tool is that tool, whatever its arguments say.
    const startInput = frame.type === "item.started" && !identity ? row(frame.input) : undefined;
    const inner = startInput ? startInput.tool_name ?? startInput.toolName : undefined;
    const bareTitle = typeof inner === "string" && (titleNamesNoTool(frame.title) || (typeof frame.title === "string" && frame.title.trim() === bareName(inner)));
    // A bare name keeps the server another field qualifies it with (Codex asks: bare `tool`, qualified `toolCall.name`).
    const named = !foreignName && (bareTitle ? useToolShare(startInput) : share(name, identity?.server));
    if (logOmitted.has(frame) || named || (frame.provider === "antigravityAgent" && ANTIGRAVITY_NAMES.has(name)) || (dispatched && runtimeUseToolShare(frame))) {
      out = cleanCall(frame, ["input", "toolInput", "raw", "choices", "questions", "filePaths"]);
      const call = row(frame.toolCall);
      if (call) {
        const clean = cleanCall(call, ["input"]);
        if (clean !== call) out = { ...out, toolCall: clean };
      }
    }
  }
  // Codex's hook socket delivers this object directly, not a JSON-RPC notification.
  if (share(frame.tool_name)) out = cleanCall(frame, ["tool_input"]);
  if ((frame.type === "tool_execution_start" || frame.type === "tool_execution_update" || frame.type === "tool_execution_end") && share(frame.toolName)) out = cleanCall(frame, ["args"]);
  // Pi repeats the call in its assistant message on these frames, at fixed paths.
  if (frame.type === "message_start" || frame.type === "message_end" || frame.type === "message_update" || frame.type === "turn_end") {
    const message = row(frame.message);
    const clean = message && cleanPiMessage(message);
    if (clean !== message) out = { ...out, message: clean };
    const event = frame.type === "message_update" ? row(frame.assistantMessageEvent) : undefined;
    if (event) {
      const partial = row(event.partial), call = row(event.toolCall);
      let next = event;
      const cleanPartial = partial && cleanPiMessage(partial);
      if (cleanPartial !== partial) next = { ...next, partial: cleanPartial };
      if (call && share(call.name)) next = { ...next, toolCall: piCall(call) };
      if (event.type === "toolcall_delta" && (piShareAt(partial, event.contentIndex) || piShareAt(message, event.contentIndex))) next = without(next, ["delta"]);
      if (next !== event) out = { ...out, assistantMessageEvent: next };
    }
  }
  if (frame.type === "agent_end" && Array.isArray(frame.messages)) {
    const messages = frame.messages;
    let blocks = 0;
    for (let i = 0; i < Math.min(messages.length, CONTENT_LIMIT + 1) && blocks <= CONTENT_LIMIT; i++) {
      const content = row(messages[i])?.content;
      if (Array.isArray(content)) blocks += content.length;
    }
    if (messages.length > CONTENT_LIMIT || blocks > CONTENT_LIMIT) out = { ...out, messages: overflow(messages.length) };
    else {
      let clean: unknown[] | undefined;
      for (let i = 0; i < messages.length; i++) {
        const message = row(messages[i]);
        const next = message && cleanPiMessage(message);
        if (next !== message) { clean ??= messages.slice(); clean[i] = next; }
      }
      if (clean) out = { ...out, messages: clean };
    }
  }
  if (frame.type === "extension_ui_request" && frame.method === "editor" && typeof frame.title === "string" && frame.title.startsWith(GATE_TITLE)
    && typeof frame.prefill === "string" && gatePrefillIsShare(frame.prefill)) out = without(out, ["prefill"]);

  if (frame.type === "stream_event") {
    const event = row(frame.event), block = row(event?.content_block);
    if (event?.type === "content_block_start" && block?.type === "tool_use" && share(block.name)) {
      const clean = cleanCall(block, ["input"]);
      if (clean !== block) out = { ...frame, event: { ...event, content_block: clean } };
    }
    // A delta carries only the block's index, so one frame can't say whose arguments these are. Every tool's go: the complete
    // input follows in the assistant message, so the log loses only the fragments.
    const delta = row(event?.delta);
    if (event?.type === "content_block_delta" && delta?.type === "input_json_delta" && Object.hasOwn(delta, "partial_json")) {
      out = { ...frame, event: { ...event, delta: without(delta, ["partial_json"]) } };
    }
  }
  if (frame.type === "assistant") {
    const message = row(frame.message), content = message?.content;
    if (Array.isArray(content) && content.length > CONTENT_LIMIT) {
      out = { ...frame, message: { ...message, content: overflow(content.length) } };
    } else if (Array.isArray(content)) {
      let clean: unknown[] | undefined;
      for (let i = 0; i < content.length; i++) {
        const block = row(content[i]);
        if (block?.type !== "tool_use" || !share(block.name)) continue;
        const next = cleanCall(block, ["input"]);
        if (next !== block) { clean ??= content.slice(); clean[i] = next; }
      }
      if (clean) out = { ...frame, message: { ...message, content: clean } };
    }
  }
  if (frame.tool_name === "call_mcp_tool") {
    const input = row(frame.tool_input);
    if (input && antigravityShare(input.ToolName, input.ServerName)) {
      const clean = cleanCall(input, ["Arguments"]);
      const cleanFrame = cleanCall(frame, []);
      if (clean !== input || cleanFrame !== frame) out = { ...cleanFrame, tool_input: clean };
    }
  }
  if (frame.event === "step_update") {
    const step = row(frame.step_update), info = row(step?.tool_info), input = row(info?.parameters);
    if (step?.step_type === "tool" && step.tool_name === "call_mcp_tool" && input && antigravityShare(input.ToolName, input.ServerName)) {
      const clean = cleanCall(input, ["Arguments"]);
      const cleanStep = cleanCall(step, []), cleanInfo = cleanCall(info!, []);
      if (clean !== input || cleanStep !== step || cleanInfo !== info) out = { ...frame, step_update: { ...cleanStep, tool_info: { ...cleanInfo, parameters: clean } } };
    }
  }
  // openai-chat's nativeOut hands each replay message here before building its diagnostic record.
  if (frame.role === "assistant" && Array.isArray(frame.tool_calls)) {
    const calls = frame.tool_calls;
    if (calls.length > CONTENT_LIMIT) {
      out = { ...frame, tool_calls: overflow(calls.length) };
    } else {
      let clean: unknown[] | undefined;
      for (let i = 0; i < calls.length; i++) {
        const call = row(calls[i]), fn = row(call?.function);
        if (!fn || !share(fn.name)) continue;
        const next = cleanCall(fn, ["arguments"]);
        const cleanCallRow = cleanCall(call!, []);
        if (next !== fn || cleanCallRow !== call) { clean ??= calls.slice(); clean[i] = { ...cleanCallRow, function: next }; }
      }
      if (clean) out = { ...frame, tool_calls: clean };
    }
  }
  if (params && (frame.method === "session/request_permission" || frame.method === "session/update")) {
    const key = frame.method === "session/request_permission" ? "toolCall" : "update";
    const call = row(params[key]);
    if (call && (key === "toolCall" || call.sessionUpdate === "tool_call" || call.sessionUpdate === "tool_call_update")) {
      if (acpCallIsShare(call, ownStamp)) {
        const clean = cleanCall(call, ["rawInput", "content", "locations"]);
        if (clean !== call) out = { ...frame, params: { ...params, [key]: clean } };
      } else if (key === "update" && call.sessionUpdate === "tool_call_update" && namesNoTool(call, ownStamp)) {
        // Any tool's: this can't be judged per frame, the driver never reads these on an update, and `content` keeps the tool's output.
        const clean = without(call, ["rawInput", "locations"]);
        if (clean !== call) out = { ...frame, params: { ...params, [key]: clean } };
      }
    }
  }
  return out as T;
}

/** One driver's stateless decision for both logs, made from one frame alone. `ownStamp` is the driver's restamped key, if any. */
export function roomShareAcpLog(ownStamp?: string) {
  return {
    /** The native log's copy of a frame, made before the driver restamps it. */
    copy<T>(message: T): T { return redactRoomShareArguments(message, ownStamp); },
    summaryIsShare(call: unknown): boolean { const body = row(call); return !!body && acpSummaryIsShare(body, ownStamp); },
    /** Hands the decision for this call to the runtime event built from it. Returns the event untouched. */
    mark<T extends object>(call: unknown, event: T): T {
      const body = row(call);
      if (body) (acpCallIsShare(body, ownStamp) ? logOmitted : logKept).add(event);
      return event;
    },
  };
}
