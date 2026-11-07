import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { carryRoomShareLogMark, redactRoomShareArguments as redact, roomShareAcpLog } from "./room-share-log.ts";
import { loggedRuntimeEvent } from "./runtime-event-out.ts";
const query = "private search words", name = "ask_owner_to_share";
const markRoomShareLog = <T extends object>(call: unknown, event: T): T => roomShareAcpLog().mark(call, event);
const input = { query };
const shapes: [string, (name: string, server?: string) => any][] = [
  ["elicitation", (tool, server = "agents") => ({ jsonrpc: "2.0", id: 101, method: "mcpServer/elicitation/request", params: { serverName: server, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: tool, tool_params: input, keep: 1 }, keep: 2 } })],
  ...["item/started", "item/completed"].map(method => [method, (tool: string, server = "agents") => ({ method, params: { item: { type: "mcpToolCall", server, tool, arguments: input, keep: 1 } } })] as [string, (name: string, server?: string) => any]),
  ["runtime start", tool => ({ type: "item.started", itemType: "tool", toolIdentity: { name: tool }, input, keep: 1 })],
  ["runtime identity approval", tool => ({ type: "request.opened", toolIdentity: { name: tool }, toolInput: input, keep: 1 })],
  ["runtime approval", tool => ({ type: "request.opened", tool, toolInput: input, toolCall: { name: tool, input }, keep: 1 })],
  ["Claude", tool => ({ type: "assistant", message: { content: [{ type: "text", text: "keep" }, { type: "tool_use", name: tool, input, keep: 1 }] } })],
  ["hook delivery", tool => ({ tool_name: tool, tool_input: input, keep: 1 })],
  ["Claude stream block", tool => ({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: tool, input, keep: 1 } } })],
  ["ACP stamped update", tool => ({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: tool } }, title: "display", rawInput: input, keep: 1 } } })],
  ["ACP Grok stamp", tool => ({ method: "session/request_permission", params: { toolCall: { _meta: { "x.ai/tool": { version: 1, namespace: "mcp", name: tool } }, title: "display", rawInput: input, keep: 1 } } })],
  ["Antigravity MCP step", (tool, server = "agents") => ({ event: "step_update", step_update: { step_type: "tool", tool_name: "call_mcp_tool", tool_info: { parameters: { ServerName: server, ToolName: tool, Arguments: input, keep: 1 } } } })],
  ["Antigravity MCP hook", (tool, server = "agents") => ({ tool_name: "call_mcp_tool", tool_input: { ServerName: server, ToolName: tool, Arguments: input, keep: 1 } })],
  ["chat assistant replay", tool => ({ role: "assistant", tool_calls: [{ id: "call", type: "function", function: { name: tool, arguments: JSON.stringify(input), keep: 1 } }] })],
  ["Pi", tool => ({ type: "tool_execution_start", toolName: tool, args: input, keep: 1 })],
  ["ACP permission", tool => ({ method: "session/request_permission", params: { toolCall: { title: tool, rawInput: input, keep: 1 } } })],
  ["ACP update", tool => ({ method: "session/update", params: { update: { sessionUpdate: "tool_call", title: tool, rawInput: input, keep: 1 } } })],
];
it.each(shapes)("%s: only exact identity loses arguments, preserves live data and siblings", (_label, shape) => {
  const live = shape(name), before = structuredClone(live);
  const clean = redact(live);
  expect(JSON.stringify(clean)).not.toContain(query);
  expect(JSON.stringify(clean)).toContain('"keep"');
  expect(live).toEqual(before);
  const foreign = shape("mcp__other__ask_owner_to_share", "other");
  expect(redact(foreign)).toBe(foreign);
  const otherServer = shape(name, "other");
  if (_label === "elicitation" || _label.startsWith("item/") || _label.startsWith("Antigravity")) expect(redact(otherServer)).toBe(otherServer);
});
it("does not walk unrelated results, deep payloads or cycles", () => {
  const collision = { type: "item.completed", itemType: "tool", ok: true, result: { name, input: "ordinary data" } };
  expect(redact(collision)).toBe(collision);
});
it("deep and cyclic payloads are constant-depth reads", () => {
  let deep: any = { name, input }; for (let i = 0; i < 200000; i++) deep = { child: deep };
  const start = performance.now(); expect(() => { if (redact(deep) !== deep) throw new Error("identity changed"); }).not.toThrow(); expect(performance.now() - start).toBeLessThan(100);
  const cycle: any = {}; cycle.self = cycle; expect(redact(cycle)).toBe(cycle);
});
it("runtime logs use the exact agents prefix and preserve unrelated prefixes", () => {
  const event = { type: "item.started", itemType: "tool", title: "mcp__agents__ask_owner_to_share", input };
  expect(JSON.stringify(loggedRuntimeEvent(event))).not.toContain(query);
  for (const title of ["mcp__murage__ask_owner_to_share", "prefix__ask_owner_to_share"]) {
    const other = { ...event, title }; expect(loggedRuntimeEvent(other)).toBe(other);
  }
});

it("real Codex stdout handler tees a redacted elicitation and dispatches unchanged live arguments", async () => {
  const { handleCodexStdoutLine } = await import("./drivers/codex.ts");
  const { NATIVE_DIR } = await import("./config.ts");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(NATIVE_DIR, { recursive: true });
  const frame = shapes[0][1](name);
  const receive = vi.fn();
  handleCodexStdoutLine("share-log", JSON.stringify(frame), receive);
  expect(receive).toHaveBeenCalledWith(frame);
  expect(receive.mock.calls[0][0].params._meta.tool_params.query).toBe(query);
  const log = readFileSync(join(NATIVE_DIR, "share-log.ndjson"), "utf8");
  expect(log).toContain("mcpServer/elicitation/request"); expect(log).not.toContain(query);
}, 30000);

it("retains the approval call identity and siblings while dropping only its input", () => {
  const event = { type: "request.opened", tool: name, toolCall: { name, input, keep: 1 } };
  expect(redact(event)).toEqual({ ...event, toolCall: { name, keep: 1 } });
});

it("real Claude approval summary stays live but cannot enter the runtime log", async () => {
  const { askSummary } = await import("./drivers/claude.ts");
  const ask = { id: "ask", at: 0, kind: "permission" as const, tool: "mcp__agents__ask_owner_to_share", input };
  const live = { type: "request.opened", requestId: ask.id, requestType: ask.kind, tool: ask.tool,
    summary: askSummary(ask), toolInput: JSON.stringify(input), toolCall: { name: ask.tool, input } };
  expect(live.summary).toContain(query);
  expect(JSON.stringify(loggedRuntimeEvent(live))).not.toContain(query);
  expect(live.summary).toContain(query);
  expect(live.toolCall.input).toBe(input);
});

it.each(["agents", "other"])("Codex item normalization to runtime log preserves server %s", async server => {
  const { codexItemToolIdentity } = await import("./drivers/codex.ts");
  const item = { type: "mcpToolCall", tool: name, server, arguments: input };
  const live = { type: "item.started", itemType: "tool", title: item.tool,
    toolIdentity: codexItemToolIdentity(item, item.tool), input: item.arguments };
  expect(live.toolIdentity.name).toBe(name);
  expect(JSON.stringify(loggedRuntimeEvent(live)).includes(query)).toBe(server === "other");
  expect(live.input).toBe(input);
});
it("another server's tool that happens to be called use_tool isn't the dispatcher, whatever its arguments name", async () => {
  const { codexItemToolIdentity } = await import("./drivers/codex.ts");
  const item = { type: "mcpToolCall", tool: "use_tool", server: "other", arguments: { tool_name: `agents__${name}`, tool_input: { query: foreign } } };
  const start = { type: "item.started", itemType: "tool", title: item.tool, toolIdentity: codexItemToolIdentity(item, item.tool), input: item.arguments };
  expect(redact(start)).toBe(start);
  const native = { method: "item/started", params: { item } };
  expect(redact(native)).toBe(native);
  const dispatcher = { ...start, toolIdentity: { name: "use_tool" }, input: { tool_name: `agents__${name}`, tool_input: input } };
  expect(JSON.stringify(redact(dispatcher))).not.toContain(query);
});
it("a foreign tool whose arguments name this tool keeps its runtime log, on each engine's shape", () => {
  const args = { tool_name: `agents__${name}`, tool_input: { query: foreign } };
  for (const frame of [
    // Codex elicitation and hook asks: bare `use_tool`, qualified only on toolCall.name, no identity
    { type: "request.opened", tool: "use_tool", summary: "use_tool", toolInput: JSON.stringify(args), toolCall: { name: "mcp__other__use_tool", input: args } },
    { type: "request.opened", tool: "use_tool", toolInput: JSON.stringify(args), toolCall: { name: "other__use_tool" } },
    // Claude: a start titled with the real tool, no identity
    { type: "item.started", itemType: "tool", title: "mcp__other__lookup", input: args },
    { type: "item.started", itemType: "tool", title: "mcp__other__use_tool", input: args },
    // a start titled with an unqualified real tool is that tool (rule 2)
    { type: "item.started", itemType: "tool", title: "lookup", input: args },
    // an identity naming another tool is that tool, even under the dispatcher's title or tool field (rule 1)
    { type: "item.started", itemType: "tool", title: "use_tool", toolIdentity: { namespace: "fuigo_build", name: "lookup" }, input: args },
    { type: "request.opened", tool: "use_tool", toolIdentity: { name: "lookup" }, toolInput: JSON.stringify(args) },
    { type: "request.opened", tool: name, toolIdentity: { name: "lookup" }, toolInput: JSON.stringify({ query: foreign }) },
    // a start titled with a real tool isn't made the dispatcher by its tool field (rule 2)
    { type: "item.started", itemType: "tool", tool: "use_tool", title: "lookup", input: args },
    // Codex: another server's tool of the same bare name, qualified only on toolCall.name
    { type: "request.opened", tool: name, toolInput: JSON.stringify({ query: foreign }), toolCall: { name: `mcp__other__${name}`, input: { query: foreign } } },
    // a custom server called murage-agents is Murage's only on Antigravity
    { type: "request.opened", tool: "use_tool", toolInput: JSON.stringify(args), toolCall: { name: "mcp__murage-agents__use_tool", input: args } },
  ]) expect(redact(frame)).toBe(frame);
  for (const frame of [
    { type: "request.opened", tool: name, toolInput: JSON.stringify(input), toolCall: { name: `mcp__agents__${name}`, input } },
    { type: "request.opened", provider: "antigravityAgent", tool: `mcp__murage-agents__${name}`, toolCall: { name: `mcp__murage-agents__${name}`, input } },
  ]) expect(JSON.stringify(redact(frame))).not.toContain(query);
  // still this tool: the dispatcher's own bare name, a start titled with the bare inner name, and this server's own qualification
  for (const frame of [
    { type: "request.opened", tool: "use_tool", toolInput: JSON.stringify({ tool_name: `agents__${name}`, tool_input: input }) },
    { type: "item.started", itemType: "tool", title: name, input: { tool_name: `agents__${name}`, tool_input: input } },
    { type: "item.started", itemType: "tool", title: "Use Tool", input: { tool_name: `agents__${name}`, tool_input: input } },
    { type: "request.opened", tool: "use_tool", toolInput: JSON.stringify({ tool_name: `agents__${name}`, tool_input: input }), toolCall: { name: "mcp__agents__use_tool" } },
  ]) expect(JSON.stringify(redact(frame))).not.toContain(query);
});

it.each([0, 1024])("oversized tool positions are omitted before inspecting or copying, match at %s", index => {
  for (const chat of [false, true]) {
    const entries: any[] = Array.from({ length: 1025 }, () => chat ? { function: { name: "ordinary" } } : { type: "text", text: "ordinary" });
    entries[index] = chat ? { function: { name, arguments: input } } : { type: "tool_use", name, input };
    const live = chat ? { role: "assistant", tool_calls: entries } : { type: "assistant", message: { content: entries } };
    const clean: any = redact(live);
    expect(JSON.stringify(clean)).not.toContain(query);
    expect(chat ? clean.tool_calls : clean.message.content).toEqual({ omitted: "tool-call array exceeds limit", size: 1025 });
    expect(entries[index]).toHaveProperty(chat ? "function.arguments" : "input", input);
  }
});
it("ordinary arrays under the cap retain identity; oversized unknown tails are omitted", () => {
  for (const chat of [false, true]) {
    const entries = Array.from({ length: 1024 }, () => ({ type: "text", text: "ordinary" }));
    const live = chat ? { role: "assistant", tool_calls: entries } : { type: "assistant", message: { content: entries } };
    expect(redact(live)).toBe(live);
    entries.push({ type: "text", text: "ordinary" });
    expect(redact(live)).not.toBe(live);
  }
});

const textFields = { summary: query, title: query, command: query, description: query, message: query, reason: query, text: query, spoken: query };
it.each(["runtime", "ACP", "Codex item", "Pi", "hook", "Claude block", "chat call", "Antigravity"])("%s argument-derived display text is log-only redacted", shape => {
  const call = { ...textFields };
  const live: any = shape === "runtime" ? { ...call, type: "request.opened", tool: name, toolInput: input }
    : shape === "ACP" ? { method: "session/update", params: { update: { ...call, sessionUpdate: "tool_call", _meta: { "fuigo/tool": { name } }, rawInput: input, content: [{ type: "content", content: { type: "text", text: query } }] } } }
    : shape === "Codex item" ? { method: "item/started", params: { item: { ...call, type: "mcpToolCall", server: "agents", tool: name, arguments: input } } }
    : shape === "Pi" ? { ...call, type: "tool_execution_start", toolName: name, args: input }
    : shape === "hook" ? { ...call, tool_name: name, tool_input: input }
    : shape === "Claude block" ? { type: "assistant", message: { content: [{ ...call, type: "tool_use", name, input }] } }
    : shape === "chat call" ? { role: "assistant", tool_calls: [{ ...call, function: { ...call, name, arguments: input } }] }
    : { event: "step_update", step_update: { ...call, step_type: "tool", tool_name: "call_mcp_tool", tool_info: { ...call, parameters: { ServerName: "agents", ToolName: name, Arguments: input } } } };
  const before = structuredClone(live);
  expect(JSON.stringify(redact(live))).not.toContain(query);
  expect(live).toEqual(before);
});

it("ACP stamped server survives permission normalization", async () => {
  const { acpStampedIdentity } = await import("./drivers/acp/core.ts");
  for (const server of ["agents", "other"]) {
    const toolIdentity = acpStampedIdentity({ _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name, server } } });
    const live = { type: "request.opened", tool: name, toolIdentity, summary: query, toolInput: input };
    expect(JSON.stringify(loggedRuntimeEvent(live)).includes(query)).toBe(server === "other");
  }
});
it("display-only tool frames are sanitized even when argument fields are absent", () => {
  for (const live of [
    { method: "mcpServer/elicitation/request", params: { serverName: "agents", message: query, _meta: { tool_name: name } } },
    { tool_name: "call_mcp_tool", description: query, tool_input: { ServerName: "agents", ToolName: name } },
    { event: "step_update", step_update: { step_type: "tool", tool_name: "call_mcp_tool", description: query, tool_info: { parameters: { ServerName: "agents", ToolName: name } } } },
    { role: "assistant", tool_calls: [{ description: query, function: { name } }] },
  ]) expect(JSON.stringify(redact(live))).not.toContain(query);
});
it("server-qualified MCP runtime stamps identify chat tool starts exactly", () => {
  for (const server of ["agents", "other"]) {
    const live = { type: "item.started", itemType: "tool", title: `${server}_ask_owner_to_share`,
      toolIdentity: { namespace: "mcp", name: `${server}__${name}` }, input, summary: query };
    expect(JSON.stringify(loggedRuntimeEvent(live)).includes(query)).toBe(server === "other");
  }
});

it("oversized arrays are not read or sliced, and unrelated arrays stay untouched", () => {
  const entries = new Array(1_000_000);
  Object.defineProperty(entries, 0, { get() { throw new Error("must not inspect oversized arrays"); } });
  entries.slice = () => { throw new Error("must not copy oversized arrays"); };
  for (const live of [
    { type: "assistant", message: { content: entries } },
    { role: "assistant", tool_calls: entries },
  ]) expect(JSON.stringify(redact(live))).toContain('"size":1000000');
  const unrelated = { role: "user", content: entries };
  expect(redact(unrelated)).toBe(unrelated);
});

// The engines' own native tees, driven through the real drivers with their fake CLIs. The tests above call the
// helper directly, so they would still pass if a driver stopped calling it: these fail if claude.ts or pi.ts does.
const foreign = "foreign search words";
async function teedLog(threadId: string, turn: () => Promise<void>) {
  const { NATIVE_DIR, ensureDirs } = await import("./config.ts");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  ensureDirs();
  await turn();
  return readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
}
async function fakeCli(file: string) {
  const { chmodSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL(`./testing/${file}`, import.meta.url));
  chmodSync(path, 0o755);
  return path;
}

it("real Claude driver tee: the native log holds the share call without its query, another server keeps its own", async () => {
  const { ClaudeDriver } = await import("./drivers/claude.ts");
  const { recordEvents } = await import("./testing/events.ts");
  const shared = "mcp__agents__ask_owner_to_share";
  process.env.FAKE_CLAUDE_EXTRA_FRAMES = JSON.stringify([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: shared, input }] } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "s2", name: shared, input } } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "o1", name: "mcp__other__ask_owner_to_share", input: { query: foreign } }] } },
  ]);
  const instance = await ClaudeDriver.create({ instanceId: "claude-share-tee", displayName: "Claude", environment: {}, enabled: true,
    config: { cli: await fakeCli("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } });
  const recorder = recordEvents(instance.adapter);
  try {
    const log = await teedLog("share-tee-claude", async () => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "share-tee-claude", text: "hi" });
      await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId);
    });
    expect(log).toContain(shared);
    expect(log).toContain(foreign);
    expect(log).not.toContain(query);
    const started = recorder.events.filter((event: any) => event.type === "item.started" && event.itemType === "tool") as any[];
    expect(started.length).toBeGreaterThan(0);
    for (const event of started) expect(event.summary).toBeUndefined();
  } finally {
    delete process.env.FAKE_CLAUDE_EXTRA_FRAMES;
    recorder.stop();
    await instance.dispose();
  }
}, 60000);

// Pi's real callable name (pi-mcp-extension allocateToolName) and its toolCall block (pi-ai 1.4.0).
const piName = "agents_ask_owner_to_share";
const piBlock = { type: "toolCall", id: "s1", name: piName, arguments: input, partialArgs: JSON.stringify(input), argumentsError: `bad: ${query}`, customInput: { query } };
const piMessage = { role: "assistant", content: [{ type: "text", text: "keep" }, piBlock] };

it("real Pi driver tee: the native log holds the share call without its query, another server keeps its own", async () => {
  const { PiDriver } = await import("./drivers/pi.ts");
  const { recordEvents } = await import("./testing/events.ts");
  const instance = await PiDriver.create({ instanceId: "pi-share-tee", displayName: "pi", enabled: true,
    environment: { FAKE_PI_EXTRA_FRAMES: JSON.stringify([
      { type: "tool_execution_start", toolCallId: "s1", toolName: piName, args: input },
      { type: "tool_execution_update", toolCallId: "s1", toolName: piName, args: input, partialResult: {} },
      { type: "message_end", message: piMessage },
      { type: "message_update", message: piMessage, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: piBlock, partial: piMessage } },
      { type: "message_update", message: piMessage, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: query, partial: piMessage } },
      { type: "turn_end", message: piMessage, toolResults: [] },
      { type: "agent_end", messages: [piMessage] },
      { type: "tool_execution_start", toolCallId: "o1", toolName: "other_ask_owner_to_share", args: { query: foreign } },
    ]) },
    config: { cli: await fakeCli("fake-pi-cli.ts"), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const log = await teedLog("share-tee-pi", async () => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "share-tee-pi", text: "hi", model: "ollama-cloud/glm-5.2" });
      await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId);
    });
    expect(log).toContain(piName);
    expect(log).toContain(foreign);
    expect(log).not.toContain(query);
    const started = recorder.events.filter((event: any) => event.type === "item.started" && event.itemType === "tool") as any[];
    expect(started.length).toBeGreaterThan(0);
    for (const event of started) expect(event.summary).toBeUndefined();
  } finally {
    recorder.stop();
    await instance.dispose();
  }
}, 60000);

it("the other engines' tees still call the helper before they log", async () => {
  const { readFileSync } = await import("node:fs");
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  expect(source("./drivers/antigravity.ts")).toContain('source: "agy.stream", msg: redactRoomShareArguments(o) }');
  expect(source("./drivers/acp/core.ts")).toMatch(/const nativeLogMessage = \(msg: any\): unknown => \{\s*msg = roomShareLog\.copy\(msg\);/);
  expect(source("./drivers/openai-chat.ts")).toContain("const message = redactRoomShareArguments(liveMessage);");
});

it("every name a mounted engine gives this tool is matched whole, and only those", async () => {
  const { ANTIGRAVITY_AGENTS_MCP_KEY } = await import("./drivers/antigravity.ts");
  const { allocateToolName } = await import("./drivers/pi-mcp-extension.ts");
  const mounted = [`mcp__agents__${name}`, `agents__${name}`, allocateToolName("agents", name, new Set()), `agents-${name}: ${name}`];
  for (const [, shape] of shapes) {
    for (const alias of mounted) expect(JSON.stringify(redact(shape(alias)))).not.toContain(query);
    for (const other of ["other_ask_owner_to_share", "other__ask_owner_to_share", "agents_ask_owner_to_share_2", "xagents_ask_owner_to_share", "mcp__other__ask_owner_to_share"]) {
      const live = shape(other, "other");
      expect(redact(live)).toBe(live);
    }
  }
  // Antigravity's key counts on its own frames only: a custom server of that name on another engine keeps its arguments.
  for (const label of ["Antigravity MCP step", "Antigravity MCP hook"]) {
    const antigravity = shapes.find(([shape]) => shape === label)![1];
    expect(JSON.stringify(redact(antigravity(name, ANTIGRAVITY_AGENTS_MCP_KEY)))).not.toContain(query);
  }
  for (const tool of [`mcp__${ANTIGRAVITY_AGENTS_MCP_KEY}__${name}`, `${ANTIGRAVITY_AGENTS_MCP_KEY}__${name}`]) {
    const event = { type: "request.opened", tool, toolIdentity: { namespace: "mcp", name: `${ANTIGRAVITY_AGENTS_MCP_KEY}__${name}` }, toolInput: input };
    expect(JSON.stringify(redact({ ...event, provider: "antigravityAgent" }))).not.toContain(query);
    const custom = { ...event, provider: "claudeAgent" };
    expect(redact(custom)).toBe(custom);
  }
  for (const [label, shape] of shapes.filter(([label]) => label === "Claude" || label === "hook delivery" || label === "Claude stream block")) {
    const custom = shape(`mcp__${ANTIGRAVITY_AGENTS_MCP_KEY}__${name}`);
    expect(redact(custom), label).toBe(custom);
  }
  const fuigo = { type: "request.opened", tool: `mcp__agents__${name}`, toolIdentity: { namespace: "mcp", name: `agents__${name}` }, toolInput: input };
  expect(JSON.stringify(loggedRuntimeEvent(fuigo))).not.toContain(query);
});

it("Pi assistant copies keep identity, drop arguments, and leave another tool alone", () => {
  const foreignBlock = { type: "toolCall", id: "o", name: "other_ask_owner_to_share", arguments: input };
  const foreignMessage = { role: "assistant", content: [foreignBlock] };
  const before = structuredClone(piMessage);
  for (const live of [
    { type: "message_start", message: piMessage }, { type: "message_end", message: piMessage }, { type: "turn_end", message: piMessage },
    { type: "agent_end", messages: [{ role: "user", content: "hi" }, piMessage] },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: piBlock } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: query, partial: piMessage } },
    { type: "message_update", message: piMessage, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: query } },
  ]) {
    const clean = JSON.stringify(redact(live));
    expect(clean).not.toContain(query);
    expect(clean).toContain(piName);
  }
  expect(piMessage).toEqual(before);
  for (const live of [
    { type: "message_end", message: foreignMessage }, { type: "agent_end", messages: [foreignMessage] },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: foreignBlock, partial: foreignMessage } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "other args", partial: foreignMessage } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "words", partial: { role: "assistant", content: [{ type: "text", text: "words" }] } } },
  ]) expect(redact(live)).toBe(live);
});

it("a matched Pi block keeps its identity and nothing else", () => {
  const clean: any = redact({ type: "message_update", message: piMessage, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: piBlock, partial: piMessage } });
  const kept = { type: "toolCall", id: "s1", name: piName };
  expect(clean.message.content[1]).toEqual(kept);
  expect(clean.assistantMessageEvent.toolCall).toEqual(kept);
  expect(clean.assistantMessageEvent.partial.content[1]).toEqual(kept);
  expect(clean.message.content[0]).toBe(piMessage.content[0]);
  expect(piBlock.partialArgs).toContain(query);
});

it("Pi arrays over the cap are not forwarded: one message, or a run's messages together", () => {
  const tail = Array.from({ length: 1024 }, () => ({ type: "text", text: "ordinary" }));
  const big = { role: "assistant", content: [...tail, piBlock] };
  for (const live of [{ type: "message_end", message: big }, { type: "agent_end", messages: [big] },
    { type: "agent_end", messages: Array.from({ length: 1025 }, () => piMessage) },
    { type: "agent_end", messages: Array.from({ length: 600 }, () => ({ role: "assistant", content: [{ type: "text", text: "a" }, piBlock] })) },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1024, delta: "fragment", partial: big } },
  ]) {
    const clean = JSON.stringify(redact(live));
    expect(clean).not.toContain(query);
    expect(clean).toContain('"omitted"');
  }
});

it("a Pi gate ask's prefill is dropped for the share call and kept for any other call", async () => {
  const { piGateMessage } = await import("./drivers/pi-permission-gate.ts");
  const entry = { mount: "agents", mcpTool: name } as Parameters<typeof piGateMessage>[2];
  const ask = (prefill: string, title = "murage-gate:secret") => ({ type: "extension_ui_request", id: "g", method: "editor", title, prefill });
  const share = ask(piGateMessage(piName, input, entry));
  expect(share.prefill).toContain(query);
  expect(JSON.stringify(redact(share))).not.toContain(query);
  expect(JSON.stringify(redact(ask(`{"tool":"${piName}","input":{"query":"${query}`)))).not.toContain(query);
  expect(JSON.stringify(redact(ask("x".repeat(1024 * 1024 + 1))))).not.toContain("xxxx");
  for (const live of [ask(piGateMessage("bash", { command: "ls" })), ask(piGateMessage("other_ask_owner_to_share", input, { mount: "other", mcpTool: name } as typeof entry)), ask("not json", "Your own title")]) expect(redact(live)).toBe(live);
});

// Fuigo and Grok's real call: every MCP tool goes through use_tool (drivers/acp/grok-own-tools.test.ts, testing/fake-acp-cli.ts).
describe.each([
  ["Fuigo", "fuigo/tool", "fuigo_build"],
  ["Grok", "x.ai/tool", "grok_build"],
])("%s use_tool", (_engine, key, namespace) => {
  const stamp = { [key]: { version: 1, namespace, name: "use_tool", kind: "use_tool" } };
  const raw = (tool: string) => ({ variant: "UseTool", tool_name: tool, tool_input: input });
  // As production sends them. The engine titles the frame "Use Tool" (Grok) or with the inner tool (Fuigo). The driver's runtime
  // events carry `tool` = the kind and `title` = the inner tool's bare name (acp/core.ts, shared/tool-activity.ts resolveToolLabel).
  const identity = { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" };
  const frames = (tool: string): any[] => {
    const title = _engine === "Grok" ? "Use Tool" : tool;
    const bare = tool.split("__").at(-1);
    return [
      { method: "session/request_permission", params: { toolCall: { toolCallId: "u", title, kind: "other", rawInput: raw(tool), _meta: stamp } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "u", title, kind: "other", rawInput: raw(tool), _meta: stamp } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "u", title, rawInput: raw(tool), _meta: stamp } } },
      { method: "session/request_permission", params: { toolCall: { title: "use_tool", rawInput: raw(tool) } } },
      { type: "request.opened", tool: "other", toolKind: "other", summary: "Use Tool", toolIdentity: identity, toolInput: JSON.stringify(raw(tool)), toolCall: { name: "other", input: raw(tool) } },
      { type: "request.opened", tool: "other", toolKind: "other", summary: "Use Tool", toolIdentity: identity, toolInput: JSON.stringify(raw(tool)) },
      { type: "item.started", itemType: "tool", title: bare, toolKind: "other", toolIdentity: identity, input: raw(tool) },
      { type: "item.started", itemType: "tool", title: bare, toolKind: "other", input: raw(tool) },
    ];
  };
  it("drops the share call's arguments on every frame and keeps the live call", () => {
    for (const live of frames(`agents__${name}`)) {
      const before = structuredClone(live);
      const logged = live.type ? loggedRuntimeEvent(live) : redact(live);
      expect(JSON.stringify(logged)).not.toContain(query);
      expect(live).toEqual(before);
    }
  });
  it("keeps another tool's arguments on every frame", () => {
    for (const tool of ["other__ask_owner_to_share", "agents__list_bots", "agents__ask_owner_to_share_2"]) {
      for (const live of frames(tool)) expect(redact(live)).toBe(live);
    }
  });
  it("text it can't read names no tool: another tool keeps its log, and only the driver's mark removes a share call's", () => {
    const opened = (toolInput: unknown) => ({ type: "request.opened", tool: "other", toolKind: "other", toolIdentity: identity, toolInput });
    const huge = `{"tool_name":"other__lookup","tool_input":{"text":"${"x".repeat(1024 * 1024 + 1)}"}}`;
    for (const text of [`{"tool_name":"other__lookup","tool_input":{"query":"${foreign}…[truncated, 9 bytes more]`, "not json", huge, "[1,2]", "null", '"text"']) {
      const live = opened(text);
      expect(redact(live)).toBe(live);
    }
    const cut = opened(`{"tool_name":"agents__${name}","tool_input":{"query":"${query}…[truncated, 9 bytes more]`);
    expect(redact(cut)).toBe(cut);
    const marked = markRoomShareLog({ title: "Use Tool", rawInput: raw(`agents__${name}`), _meta: stamp }, { ...cut });
    expect(JSON.stringify(redact(marked))).not.toContain(query);
    expect(marked.toolInput).toContain(query);
  });
});

describe("an ACP update that names its call only by id", () => {
  const frame = (sessionUpdate: string, fields: object): any => ({ method: "session/update", params: { update: { sessionUpdate, toolCallId: "c1", ...fields } } });
  const output = [{ type: "content", content: { type: "text", text: "tool output" } }];
  const locations = [{ path: "/private/path" }];
  const dispatcher = { "x.ai/tool": { version: 1, namespace: "grok_build", name: "use_tool" } };
  it("loses its arguments and locations whichever tool it is, keeps its output, and leaves the live frame alone", () => {
    for (const update of [frame("tool_call_update", { rawInput: input, locations, content: output }), frame("tool_call_update", { title: "  ", rawInput: input, locations, content: output }), frame("tool_call_update", { rawInput: input, locations, content: output, _meta: dispatcher })]) {
      const before = structuredClone(update);
      const logged = redact(update);
      expect(logged.params.update.rawInput).toBeUndefined();
      expect(logged.params.update.locations).toBeUndefined();
      expect(logged.params.update.content).toEqual(output);
      expect(update).toEqual(before);
    }
  });
  it("is the same object when it has nothing to lose", () => {
    const update = frame("tool_call_update", { status: "completed", content: output });
    expect(redact(update)).toBe(update);
  });
  it("an update that names a tool stays exact", () => {
    for (const update of [
      frame("tool_call_update", { title: "other__lookup", rawInput: input, locations }),
      frame("tool_call_update", { rawInput: { tool_name: "other__lookup", tool_input: input }, _meta: dispatcher }),
      frame("tool_call_update", { rawInput: input, _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: "other__lookup" } } }),
      frame("tool_call", { rawInput: input, locations }),
      frame("tool_call_update", { title: "other__lookup", rawInput: input, locations, _meta: dispatcher }),
    ]) expect(redact(update)).toBe(update);
  });
  it("a dispatcher's own display title names no tool, and a share name in the title of a dispatcher stamp is this tool", () => {
    for (const title of ["Use Tool", "use_tool"]) {
      const logged = redact(frame("tool_call_update", { title, rawInput: input, locations, content: output, _meta: dispatcher }));
      expect(logged.params.update.rawInput).toBeUndefined();
      expect(logged.params.update.locations).toBeUndefined();
      expect(logged.params.update.content).toEqual(output);
    }
    expect(JSON.stringify(redact(frame("tool_call_update", { title: `agents-${name}`, rawInput: input, _meta: dispatcher })))).not.toContain(query);
  });
  it("an update naming this tool loses its output too, whether by title or, with no other name, by its inner tool name", () => {
    const content = [{ type: "content", content: { type: "text", text: query } }];
    expect(JSON.stringify(redact(frame("tool_call_update", { title: name, rawInput: input, content })))).not.toContain(query);
    expect(JSON.stringify(redact(frame("tool_call_update", { rawInput: { tool_name: `agents__${name}`, tool_input: input }, content })))).not.toContain(query);
  });
});

describe("a frame carrying both stamps", () => {
  const stamp = (toolName: string) => ({ version: 1, namespace: "grok_build", name: toolName });
  const ask = (_meta: object, rawInput: object) => ({ method: "session/request_permission", params: { toolCall: { title: "display", kind: "other", rawInput, _meta } } });
  const event = () => ({ type: "request.opened", tool: "other", toolKind: "other", toolInput: JSON.stringify(input) });
  const restamped = async (frame: any) => {
    const { acpRestampFrame } = await import("./drivers/acp/core.ts");
    const copy = structuredClone(frame);
    acpRestampFrame(copy, { key: "x.ai/tool", namespaces: { grok_build: "fuigo_build" } });
    return copy.params.toolCall;
  };
  it("the engine's own stamp decides both logs, before and after the restamp", async () => {
    const grok = roomShareAcpLog("x.ai/tool");
    const foreignOwn = ask({ "fuigo/tool": stamp(`agents__${name}`), "x.ai/tool": stamp("other__lookup") }, input);
    expect(grok.copy(foreignOwn)).toBe(foreignOwn);
    const kept = grok.mark(await restamped(foreignOwn), event());
    expect(redact(kept)).toBe(kept);
    const shareOwn = ask({ "fuigo/tool": stamp("other__lookup"), "x.ai/tool": stamp(`agents__${name}`) }, input);
    expect(JSON.stringify(grok.copy(shareOwn))).not.toContain(query);
    expect(JSON.stringify(redact(grok.mark(await restamped(shareOwn), event())))).not.toContain(query);
  });
  it("a stamp naming another tool isn't overridden by the dispatcher's title and a share name in the arguments", () => {
    const frame = { method: "session/request_permission", params: { toolCall: { title: "use_tool", rawInput: { tool_name: `agents__${name}`, query: foreign }, _meta: { "x.ai/tool": stamp("other__lookup") } } } };
    expect(roomShareAcpLog("x.ai/tool").copy(frame)).toBe(frame);
    const marked = roomShareAcpLog("x.ai/tool").mark(frame.params.toolCall, event());
    expect(redact(marked)).toBe(marked);
  });
  it("the summary goes only for this tool: a stamp naming another keeps it, tool_name outranks toolName", () => {
    const log = roomShareAcpLog("x.ai/tool");
    const inner = { tool_name: `agents__${name}`, tool_input: input };
    expect(log.summaryIsShare({ rawInput: inner, _meta: { "x.ai/tool": stamp("use_tool") } })).toBe(true);
    expect(log.summaryIsShare({ rawInput: inner })).toBe(true);
    expect(log.summaryIsShare({ title: "search", rawInput: input, _meta: { "x.ai/tool": stamp(`agents__${name}`) } })).toBe(true);
    expect(log.summaryIsShare({ rawInput: inner, _meta: { "x.ai/tool": stamp("other__lookup") } })).toBe(false);
    expect(log.summaryIsShare({ rawInput: { tool_name: "other__lookup", toolName: `agents__${name}` } })).toBe(false);
    // a real title is judged as itself, exactly, and never by its arguments
    expect(log.summaryIsShare({ title: name, rawInput: { tool_name: "other__lookup" } })).toBe(true);
    expect(log.summaryIsShare({ title: "mcp__other__lookup", rawInput: inner })).toBe(false);
    expect(log.summaryIsShare({ title: `agents-${name}`, rawInput: { tool_name: "other__lookup" } })).toBe(false);
    expect(log.summaryIsShare({ title: "Use Tool", rawInput: inner })).toBe(true);
    expect(log.summaryIsShare(null)).toBe(false);
  });
  it("another server's stamped use_tool is that server's tool, not the dispatcher: both logs and the summary keep it", () => {
    const own = { "x.ai/tool": { version: 1, namespace: "mcp", server: "other", name: "use_tool" } };
    const call = { title: "Use Tool", kind: "other", rawInput: { tool_name: `agents__${name}`, tool_input: { query: foreign } }, _meta: own };
    const log = roomShareAcpLog("x.ai/tool");
    const frame = { method: "session/request_permission", params: { toolCall: call } };
    expect(log.copy(frame)).toBe(frame);
    const update = { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "c", ...call } } };
    expect(log.copy(update)).toBe(update);
    const marked = log.mark(call, event());
    expect(redact(marked)).toBe(marked);
    expect(log.summaryIsShare(call)).toBe(false);
    // the engine's own dispatcher, no server, still decides by its inner name
    expect(log.summaryIsShare({ ...call, _meta: { "x.ai/tool": stamp("use_tool") } })).toBe(true);
  });
  it("the driver's decision settles the runtime event both ways: a kept event isn't stripped by the chip's bare inner title", () => {
    const call = { title: "mcp__other__lookup", kind: "other", rawInput: { tool_name: `agents__${name}`, tool_input: { query: foreign } } };
    const start = () => ({ type: "item.started", itemType: "tool", title: name, input: call.rawInput });
    expect(JSON.stringify(redact(start()))).not.toContain(foreign); // the name fallback alone would strip it
    const kept = roomShareAcpLog().mark(call, start());
    expect(redact(kept)).toBe(kept);
    const copy = carryRoomShareLogMark(kept, { ...kept, providerInstanceId: "p" });
    expect(redact(copy)).toBe(copy);
    expect(Object.keys(copy)).toEqual([...Object.keys(kept), "providerInstanceId"]);
  });
  it("a driver with no stamp of its own reads fuigo/tool, the stamp its live readers read", () => {
    const fuigo = roomShareAcpLog();
    const foreignFuigo = ask({ "fuigo/tool": stamp("other__lookup"), "x.ai/tool": stamp(`agents__${name}`) }, input);
    expect(fuigo.copy(foreignFuigo)).toBe(foreignFuigo);
    expect(JSON.stringify(fuigo.copy(ask({ "fuigo/tool": stamp(`agents__${name}`), "x.ai/tool": stamp("other__lookup") }, input)))).not.toContain(query);
  });
  it("an argument that looks like this tool doesn't override a stamp naming another", () => {
    const frame = ask({ "x.ai/tool": stamp("other__lookup") }, { tool_name: `agents__${name}`, query: foreign });
    expect(roomShareAcpLog("x.ai/tool").copy(frame)).toBe(frame);
  });
});

describe("the log-only mark", () => {
  const share = { title: `agents-${name}`, rawInput: input };
  it("is set by the same decision as the native frame, and only for this tool", () => {
    const start = (call: unknown) => markRoomShareLog(call, { type: "item.started", itemType: "tool", title: "t", input });
    for (const call of [share, { title: name.toUpperCase(), rawInput: input }, { title: "display", rawInput: input, _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: `agents__${name}` } } }]) {
      expect(JSON.stringify(redact(start(call)))).not.toContain(query);
      expect(JSON.stringify(redact({ method: "session/request_permission", params: { toolCall: call } }))).not.toContain(query);
    }
    for (const call of [{ title: "list_bots", rawInput: input }, { title: `${name}_v2`, rawInput: input }, { title: name, rawInput: input, _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: "other__list" } } }, null, "text", []]) {
      const live = start(call);
      expect(redact(live)).toBe(live);
    }
  });
  it("adds nothing to the event, so no listener, wire or stored form can hold it, and a copy without it is ordinary", () => {
    const plain = { type: "item.started", itemType: "tool", title: "t", input };
    const live = markRoomShareLog(share, { ...plain });
    expect(Reflect.ownKeys(live)).toEqual(Reflect.ownKeys(plain));
    expect(live).toEqual(plain);
    expect(JSON.stringify(redact(live))).not.toContain(query);
    expect(JSON.stringify(loggedRuntimeEvent(live))).not.toContain(query);
    expect(live.input).toEqual(input);
    const copy = { ...live };
    expect(redact(copy)).toBe(copy);
    const carried = carryRoomShareLogMark(live, { ...live, providerInstanceId: "i" });
    expect(JSON.stringify(redact(carried))).not.toContain(query);
    const other = carryRoomShareLogMark(plain, { ...plain, providerInstanceId: "i" });
    expect(redact(other)).toBe(other);
  });
  it("the bus logs a marked event without the arguments and hands every listener the whole event", async () => {
    const { EventBus } = await import("./harness/bus.ts");
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    const delivered: any[] = [];
    bus.subscribe((event: any) => { delivered.push(event); }, { durable: false });
    bus.subscribe((event: any) => { delivered.push(event); }, { durable: true });
    const base = { provider: "grokAgent", kind: "runtime", eventId: "e", createdAt: "2026-11-06T00:00:00Z", threadId: "mark-bus" };
    bus.publish(markRoomShareLog(share, { ...base, type: "item.started", itemType: "tool", itemId: "i", title: "t", input }) as never);
    expect(writes.join("")).toContain('"item.started"');
    expect(writes.join("")).not.toContain(query);
    expect(delivered).toHaveLength(2);
    for (const event of delivered) {
      expect(Object.getOwnPropertySymbols(event)).toEqual([]);
      expect(event.input).toEqual(input);
    }
  });
});

describe("real ACP driver through the real bus", () => {
  // boundedToolInput keeps the first 16 KB of the JSON: the words stay in that text, the tool's name falls past the cut.
  const cutCall = (tool: string, words: string) => ({ variant: "UseTool", tool_input: { query: words }, ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`pad${i}`, "y".repeat(1024)])), tool_name: tool });
  const grokMeta = { "x.ai/tool": { version: 1, namespace: "grok_build", name: "use_tool", kind: "use_tool", label: "Use Tool", read_only: false } };
  const fuigoMeta = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool" } };
  const wrapped = (tool: string, tool_input: object) => ({ variant: "UseTool", tool_name: tool, tool_input });
  const run = async (label: string, toolCall: object, behavior: "allow" | "deny" = "allow") => {
    const { GrokAgentDriver } = await import("./drivers/acp/grok.ts");
    const { EventBus } = await import("./harness/bus.ts");
    const { recordEvents } = await import("./testing/events.ts");
    const threadId = `share-bus-${label.replace(/\W/g, "-")}`;
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify(toolCall);
    process.env.FAKE_ACP_PERMISSION_ANNOUNCE = "1";
    const instance = await GrokAgentDriver.create({ instanceId: "acp-share-bus", displayName: "ACP", environment: {}, enabled: true,
      config: { cli: await fakeCli("fake-acp-cli.ts"), fullAuto: false } });
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    const delivered: any[] = [];
    bus.subscribe((event: any) => { delivered.push(event); }, { durable: false });
    bus.attach([instance]);
    const recorder = recordEvents(instance.adapter);
    try {
      const native = await teedLog(threadId, async () => {
        await instance.adapter.sendTurn({ threadId, text: "go" });
        const opened = await recorder.until(event => event.type === "request.opened") as any;
        await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior });
        await recorder.until(event => event.type === "turn.completed");
      });
      return { native, written: writes.join(""), delivered, raw: recorder.events as any[] };
    } finally {
      delete process.env.FAKE_ACP_MODE;
      delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
      delete process.env.FAKE_ACP_PERMISSION_ANNOUNCE;
      recorder.stop();
      await instance.dispose();
    }
  };
  const of = (events: any[], type: string) => events.find(event => event.type === type && (type !== "item.started" || event.toolKind === "other"));

  it.each([
    ["unstamped title", { toolCallId: "t", title: `agents-${name}: ${name}`, kind: "other", rawInput: input }],
    ["a title in other words holding the name", { toolCallId: "t", title: `Calling ${name} now`, kind: "other", rawInput: input }],
    ["Grok use_tool", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: wrapped(`agents__${name}`, input), _meta: grokMeta }],
    ["Fuigo use_tool", { toolCallId: "u", title: `agents__${name}`, kind: "other", rawInput: wrapped(`agents__${name}`, input), _meta: fuigoMeta }],
    // F1: the query sits in the kept part of the bounded text, and the tool's name is only readable on the whole call
    ["a share call cut by the card's bound", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: cutCall(`agents__${name}`, query), _meta: grokMeta }],
  ])("%s: neither log holds the query, and the live card, gate and call are whole and unmarked", async (label, toolCall) => {
    const { resolveCall } = await import("../shared/app-action-grant.ts");
    const { cardDetail } = await import("./approval-text.ts");
    const { requestOpenedOut, windowRuntimeEvent } = await import("./runtime-event-out.ts");
    const { native, written, delivered, raw } = await run(label, toolCall);
    for (const log of [native, written]) expect(log).not.toContain(query);
    expect(native).toContain("session/request_permission");
    expect(written).toContain('"request.opened"');
    expect(written).toContain('"item.started"');

    const opened = of(delivered, "request.opened"), started = of(delivered, "item.started");
    // adapter listeners (the hold and memory decorators, memory learning) and bus listeners alike
    for (const event of [...raw, ...delivered]) expect(Object.getOwnPropertySymbols(event)).toEqual([]);
    for (const out of [windowRuntimeEvent(opened), requestOpenedOut(opened), windowRuntimeEvent(started)]) expect(Object.getOwnPropertySymbols(out)).toEqual([]);
    // the live call reads the same with and without the mark, so a card, a grant and the stop line can't differ
    expect(JSON.stringify(opened.toolCall.input)).toContain(query);
    expect(JSON.stringify(started.input)).toContain(query);
    expect(opened.toolInput).toContain(query);
    if (label.includes("cut")) {
      expect(opened.toolInput).toMatch(/truncated, \d+ bytes more\]$/);
      expect(opened.toolInput).not.toContain(name);
    }
    const asCall = (event: any) => ({ toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine, inputMissing: event.toolInputMissing });
    expect(resolveCall(asCall(opened))).toEqual(resolveCall(asCall(of(raw, "request.opened"))));
    expect(cardDetail(opened)).toEqual(cardDetail(of(raw, "request.opened")));
    expect(delivered.some(event => event.type === "turn.completed")).toBe(true);
  }, 60000);

  it.each([
    ["another server's tool of the same name", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: wrapped(`other__${name}`, { query: foreign }), _meta: grokMeta }],
    ["another tool cut by the card's bound", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: cutCall("other__lookup", foreign), _meta: grokMeta }],
  ])("%s keeps its arguments in both logs, with no mark", async (label, toolCall) => {
    const { native, written, raw } = await run(label, toolCall);
    expect(native).toContain(foreign);
    expect(written).toContain(foreign);
    if (label.includes("cut")) expect(of(raw, "request.opened").toolInput).toMatch(/truncated, \d+ bytes more\]$/);
  }, 60000);

  it("an update naming no tool: the native log keeps its output and loses its arguments and locations, whichever tool it is", async () => {
    for (const toolCall of [
      { toolCallId: "t", title: `agents-${name}`, kind: "other", rawInput: input },
      { toolCallId: "t", title: "other__lookup", kind: "other", rawInput: input },
    ]) {
      const { native } = await run(`id-only ${toolCall.title}`, toolCall, "deny");
      const updates = native.split("\n").filter(line => line.includes("tool_call_update"));
      expect(updates.filter(line => line.includes("id-only output words"))).toHaveLength(1);
      for (const line of updates) {
        expect(line).not.toContain(query);
        expect(line).not.toContain("/id-only-location");
      }
    }
  }, 60000);

  it.each([
    ["the engine's stamp names another tool, fuigo/tool this one", { "fuigo/tool": { version: 1, namespace: "mcp", name: `agents__${name}` }, "x.ai/tool": { version: 1, namespace: "mcp", name: "other__lookup" } }, true],
    ["the engine's stamp names this tool, fuigo/tool another", { "fuigo/tool": { version: 1, namespace: "mcp", name: "other__lookup" }, "x.ai/tool": { version: 1, namespace: "mcp", name: `agents__${name}` } }, false],
  ])("both stamps on one frame, %s: the two logs agree, by the engine's own stamp", async (label, _meta, kept) => {
    const words = kept ? foreign : query;
    const { native, written } = await run(`both ${label}`, { toolCallId: "t", title: "display", kind: "other", rawInput: { query: words }, _meta }, "deny");
    expect(written).toContain('"request.opened"');
    expect(native).toContain("session/request_permission");
    for (const log of [native, written]) kept ? expect(log).toContain(words) : expect(log).not.toContain(words);
  }, 60000);

  it.each([
    ["Grok", grokMeta, "Use Tool"],
    ["Fuigo", fuigoMeta, `agents__${name}`],
  ])("%s: the start names the share tool with no query-derived summary; a foreign wrapper keeps its summary", async (engine, _meta, title) => {
    const { native: _n, delivered } = await run(`summary-${engine}`, { toolCallId: "u", title, kind: "other", rawInput: wrapped(`agents__${name}`, input), _meta }, "deny");
    const started = of(delivered, "item.started");
    expect(started.title).toBe(name);
    expect(started.summary).toBeUndefined();
    const other = await run(`summary-foreign-${engine}`, { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: wrapped(`other__${name}`, { query: foreign }), _meta }, "deny");
    expect(of(other.delivered, "item.started")).toMatchObject({ title: name, summary: foreign });
  }, 60000);
  it("an unstamped foreign tool titled as itself, its arguments naming this tool, keeps both logs and its summary through the real bus", async () => {
    const { native, written, delivered } = await run("kept-foreign", { toolCallId: "u", title: "mcp__other__lookup", kind: "other", rawInput: wrapped(`agents__${name}`, { query: foreign }) }, "deny");
    expect(of(delivered, "item.started").summary).toBe(foreign);
    expect(written).toContain('"item.started"');
    for (const log of [native, written]) expect(log).toContain(foreign);
  }, 60000);
  it("a call stamped as this tool directly, under a title that would borrow its query for a summary, keeps none", async () => {
    const { delivered } = await run("summary-direct", { toolCallId: "u", title: "search", kind: "other", rawInput: input, _meta: { "x.ai/tool": { version: 1, namespace: "mcp", name: `agents__${name}` } } }, "deny");
    expect(of(delivered, "item.started").summary).toBeUndefined();
    const other = await run("summary-direct-foreign", { toolCallId: "u", title: "search", kind: "other", rawInput: { query: foreign } }, "deny");
    expect(of(other.delivered, "item.started").summary).toBe(foreign);
  }, 60000);
  it("the title rule only ever removes from logs: a share name in a title leaves a wrapper's summary alone", async () => {
    const { delivered, written } = await run("summary-title", { toolCallId: "u", title: `agents-${name}`, kind: "other", rawInput: wrapped("other__lookup", { query: foreign }) }, "deny");
    expect(of(delivered, "item.started").summary).toBe(foreign);
    expect(written).not.toContain(foreign);
  }, 60000);
  it.each([
    ["a stamp naming another tool, with this tool's name in its arguments", { toolCallId: "u", title: "display", kind: "other", rawInput: wrapped(`agents__${name}`, { query: foreign }), _meta: { "x.ai/tool": { version: 1, namespace: "mcp", name: "other__lookup" } } }],
    ["a stamp naming another tool under the dispatcher's own title", { toolCallId: "u", title: "use_tool", kind: "other", rawInput: wrapped(`agents__${name}`, { query: foreign }), _meta: { "x.ai/tool": { version: 1, namespace: "mcp", name: "other__lookup" } } }],
    ["a wrapper whose tool_name is another tool, with this tool under the other spelling", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: { ...wrapped("other__lookup", { query: foreign }), toolName: `agents__${name}` }, _meta: grokMeta }],
  ])("%s keeps its summary and its native log", async (label, toolCall) => {
    const { delivered, native } = await run(`foreign-${label}`, toolCall, "deny");
    expect(of(delivered, "item.started").summary).toBe(foreign);
    expect(native).toContain(foreign);
  }, 60000);
});

describe("Claude's streamed tool arguments", () => {
  const delta = (body: object): any => ({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: body } });
  it("no fragment reaches the log, whichever tool it is: a delta names no tool and the full input follows", () => {
    const frame = delta({ type: "input_json_delta", partial_json: `{"query":"${query}"}` });
    const before = structuredClone(frame);
    const logged = redact(frame);
    expect(logged.event).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta" } });
    expect(frame).toEqual(before);
  });
  it("a text delta is the same object", () => {
    const frame = delta({ type: "text_delta", text: "words" });
    expect(redact(frame)).toBe(frame);
  });
  it("another tool's complete input still logs", () => {
    const frame = { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__lookup", input: { query: foreign } }] } };
    expect(redact(frame)).toBe(frame);
  });
});

it("no other engine's tool start carries a summary, so none can keep the query in the transcript", async () => {
  const { readFileSync } = await import("node:fs");
  let starts = 0;
  for (const file of ["claude", "codex", "pi", "openai-chat", "antigravity", "codex-hook", "boxagent", "turn-refusal"]) {
    const found = toolStartProblems(file, readFileSync(new URL(`./drivers/${file}.ts`, import.meta.url), "utf8"));
    starts += found.starts;
    expect(found.problems, file).toEqual([]);
  }
  expect(starts).toBeGreaterThan(10);
});
/** Every object literal that is a tool start, read by the TypeScript parser so strings and comments can't hide or fake anything.
 * A summary is a problem, and so is a spread other than the shared `base(...)`, which could bring one in unseen. */
function toolStartProblems(file: string, text: string): { starts: number; problems: string[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const problems: string[] = [];
  let starts = 0;
  const keyOf = (entry: ts.ObjectLiteralElementLike): string | undefined => {
    const key = entry.name;
    if (key && ts.isComputedPropertyName(key)) return ts.isStringLiteralLike(key.expression) ? key.expression.text : "summary"; // a key it can't read could be one
    return key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ? key.text : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(entry => ts.isPropertyAssignment(entry) && keyOf(entry) === "type" && ts.isStringLiteralLike(entry.initializer) && entry.initializer.text === "item.started")) {
      starts++;
      for (const entry of node.properties) {
        if (ts.isSpreadAssignment(entry)) {
          if (!ts.isCallExpression(entry.expression) || entry.expression.expression.getText(source) !== "base") problems.push(`spread ${entry.expression.getText(source).slice(0, 60)}`);
        } else if (keyOf(entry) === "summary") problems.push("summary");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { starts, problems };
}
it("that scan is not fooled by strings, comments, or where the spread sits", () => {
  const problems = (code: string) => toolStartProblems("t.ts", code).problems;
  expect(problems('emit({ ...helper(x), type: "item.started", title });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", ...helper(x) });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", title: "}", ...helper(x) });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", /* } */ summary: label.summary });')).toEqual(["summary"]);
  expect(problems('emit({ type: "item.started", "summary": x });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", ["summary"]: x });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", [key]: x });')).toHaveLength(1);
  expect(problems('emit({ type: "item.started", summary });')).toHaveLength(1);
  expect(problems('emit({ ...base(t), type: "item.started", title: "Preparing Codex...", note: "...summary" /* ...x summary */ });')).toEqual([]);
  expect(problems('const text = \'{ type: "item.started", summary: 1 }\'; // { type: "item.started", summary: 1 }')).toEqual([]);
});

describe("unstamped ACP titles (main's ruling, native log only)", () => {
  const permission = (title: string, _meta?: object) => ({ method: "session/request_permission", params: { toolCall: { title, rawInput: input, ...(_meta ? { _meta } : {}) } } });
  const update = (title: string) => ({ method: "session/update", params: { update: { sessionUpdate: "tool_call", title, rawInput: input } } });
  it.each([
    ["agents-ask_owner_to_share", "a hyphen ends a word"],
    ["agents-ask_owner_to_share: ask_owner_to_share", "Cursor's form"],
    ["ask_owner_to_share (agents MCP Server)", "a space ends a word"],
    ["agents.ask_owner_to_share", "a dot ends a word"],
    ["ASK_OWNER_TO_SHARE", "case is ignored"],
    ["Ask_Owner_To_Share", "case is ignored"],
    ["x".repeat(513), "too long to read counts as this tool"],
  ])("%s loses its arguments: %s", title => {
    for (const live of [permission(title), update(title)]) {
      const before = structuredClone(live);
      expect(JSON.stringify(redact(live))).not.toContain(query);
      expect(live).toEqual(before);
    }
  });
  it.each([
    ["ask_owner_to_share_v2", "an underscore joins a word"],
    ["other__ask_owner_to_share", "an underscore joins a word"],
    ["xask_owner_to_share", "a letter joins a word"],
    ["list_bots", "another tool"],
    ["x".repeat(512), "at the limit, read and not this tool"],
  ])("%s keeps its arguments: %s", title => {
    for (const live of [permission(title), update(title)]) expect(redact(live)).toBe(live);
  });
  it("a stamped frame stays exact whatever its title says", () => {
    const live = permission(name, { "fuigo/tool": { version: 1, namespace: "mcp", name: "other__list" } });
    expect(redact(live)).toBe(live);
  });
  it("a runtime event stays exact: the title rule is for native ACP frames", () => {
    const live = { type: "item.started", itemType: "tool", title: `agents-${name}`, input };
    expect(redact(live)).toBe(live);
  });
});

it.each([
  ["unstamped title", { toolCallId: "t", title: `agents-${name}: ${name}`, kind: "other", rawInput: input }],
  ["Grok use_tool", { toolCallId: "u", title: "Use Tool", kind: "other", rawInput: { variant: "UseTool", tool_name: `agents__${name}`, tool_input: input },
    _meta: { "x.ai/tool": { version: 1, namespace: "grok_build", name: "use_tool", kind: "use_tool" } } }],
])("real ACP driver: %s leaves the native log without the query and the live card and call whole", async (label, toolCall) => {
  const { GrokAgentDriver } = await import("./drivers/acp/grok.ts");
  const { recordEvents } = await import("./testing/events.ts");
  const threadId = `share-tee-acp-${label.replace(/\W/g, "-")}`;
  process.env.FAKE_ACP_MODE = "permission";
  process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify(toolCall);
  const instance = await GrokAgentDriver.create({ instanceId: "acp-share-tee", displayName: "ACP", environment: {}, enabled: true,
    config: { cli: await fakeCli("fake-acp-cli.ts"), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const log = await teedLog(threadId, async () => {
      await instance.adapter.sendTurn({ threadId, text: "go" });
      const opened = await recorder.until(event => event.type === "request.opened") as any;
      // the live card, call and gate still read the whole call
      expect(JSON.stringify(opened.toolCall?.input ?? opened.toolInput)).toContain(query);
      await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior: "deny" });
      await recorder.until(event => event.type === "turn.completed");
    });
    expect(log).toContain("session/request_permission");
    expect(log).not.toContain(query);
  } finally {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
    recorder.stop();
    await instance.dispose();
  }
}, 60000);

it("the helper runs only on log copies: every caller's result goes to a log, never to a live reader", async () => {
  const { readFileSync } = await import("node:fs");
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const calls = (text: string) => text.split("\n").filter(line => line.includes("redactRoomShareArguments(") && !line.includes("export function"));
  expect(calls(source("./drivers/claude.ts"))).toEqual([expect.stringContaining("appendNative(threadId, ")]);
  expect(calls(source("./drivers/pi.ts"))).toEqual([expect.stringContaining("appendNative(threadId, ")]);
  expect(calls(source("./drivers/antigravity.ts"))).toEqual([expect.stringContaining("appendNative(threadId, ")]);
  expect(calls(source("./drivers/codex.ts"))).toEqual([expect.stringContaining("appendNative(threadId, ")]);
  expect(calls(source("./drivers/acp/core.ts"))).toEqual([]);
  expect(source("./drivers/acp/core.ts").split("\n").filter(line => line.includes("roomShareLog.copy("))).toEqual([expect.stringContaining("msg = roomShareLog.copy(msg);")]);
  expect(calls(source("./drivers/openai-chat.ts"))).toEqual([expect.stringContaining("const message = redactRoomShareArguments(liveMessage);")]);
  expect(calls(source("./runtime-event-out.ts"))).toEqual([expect.stringContaining("event = redactRoomShareArguments(event);")]);
});

