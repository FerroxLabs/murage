import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpDriver } from "./core.ts";
import { fuigoMemoryAllowOnce, newFuigoMemoryAlias } from "./fuigo-memory-permission.ts";
import { recordEvents } from "../../testing/events.ts";
import { NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";

const roots: string[] = [], instances: ProviderInstance[] = [];
afterEach(async () => { for (const instance of instances.splice(0)) await instance.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const names = ["memory_search", "memory_get", "memory_save", "memory_propose_correction"];
it("requires exact canonical identity and a unique one-time option", () => {
  const alias = newFuigoMemoryAlias(), call = { _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: `${alias}__memory_search` } } };
  expect(`${alias}__memory_propose_correction`).toHaveLength(61);
  expect(fuigoMemoryAllowOnce(call, [{ optionId: "once", kind: "allow_once" }], alias)).toBe("once");
  for (const options of [[], [{ optionId: "", kind: "allow_once" }], [{ optionId: "same", kind: "allow_once" }, { optionId: "same", kind: "allow_always" }], [{ optionId: "one", kind: "allow_once" }, { optionId: "two", kind: "allow_once" }]]) expect(fuigoMemoryAllowOnce(call, options, alias)).toBeNull();
  expect(fuigoMemoryAllowOnce({ title: `${alias}__memory_search`, rawInput: call }, [{ optionId: "once", kind: "allow_once" }], alias)).toBeNull();
  for (const identity of [{ version: "1", namespace: "mcp", name: `${alias}__memory_search` }, { version: 1, namespace: "mcp", name: `${alias}__memory_search_extra` }, { version: 1, namespace: "mcp", name: "use_tool" }]) {
    expect(fuigoMemoryAllowOnce({ _meta: { "fuigo/tool": identity } }, [{ optionId: "once", kind: "allow_once" }], alias)).toBeNull();
  }
});

it("unwraps only canonical typed UseTool memory targets and ignores display claims", () => {
  const alias = newFuigoMemoryAlias(), once = [{optionId:"once",kind:"allow_once"}];
  const wrapped = (name = `${alias}__memory_search`) => ({title:"untrusted display text",_meta:{"fuigo/tool":{version:1,namespace:"fuigo_build",name:"use_tool",kind:"use_tool",read_only:false}},rawInput:{variant:"UseTool",tool_name:name,tool_input:{query:"synthetic"}}});
  for(const tool of names)expect(fuigoMemoryAllowOnce(wrapped(`${alias}__${tool}`),once,alias)).toBe("once");
  for(const [key,value] of [["version",2],["version","1"],["namespace","mcp"],["namespace","builtin"],["name","run_terminal_cmd"],["kind","execute"],["read_only",true]]){
    const call=wrapped();Object.assign(call._meta["fuigo/tool"],{[String(key)]:value});expect(fuigoMemoryAllowOnce(call,once,alias)).toBeNull();
  }
  for(const rawInput of [null,[],"{}",{variant:"MCP",tool_name:`${alias}__memory_get`,tool_input:{}},{variant:"UseTool",tool_name:`${alias}__memory_get`},{variant:"UseTool",tool_name:`${alias}__memory_get`,tool_input:[]},{variant:"UseTool",tool_name:`${alias}__memory_get`,tool_input:{},command:"echo unsafe"}]){
    expect(fuigoMemoryAllowOnce({...wrapped(),rawInput},once,alias)).toBeNull();
  }
  for(const tool of [`${alias}__memory_delete`,`${alias}__memory_get_extra`,`${alias}__memory_get\n`,"run_terminal_cmd","other__memory_get","murage-memory-00000000000000000000__memory_get"])
    expect(fuigoMemoryAllowOnce(wrapped(tool),once,alias)).toBeNull();
  expect(fuigoMemoryAllowOnce({title:`${alias}__memory_get`,rawInput:wrapped().rawInput},once,alias)).toBeNull();
  for(const options of [[],[{optionId:"standing",kind:"allow_always"}],[{optionId:"once",kind:"allow_once"},{optionId:"once",kind:"allow_always"}],[{optionId:"a",kind:"allow_once"},{optionId:"b",kind:"allow_once"}]])
    expect(fuigoMemoryAllowOnce(wrapped(),options,alias)).toBeNull();
});

async function fixture(scenario: string, tool = "memory_search", wrapped = false) {
  const root = mkdtempSync(join(tmpdir(), "murage-memory-acp-")); roots.push(root);
  const home = join(root, "native-home"); mkdirSync(home); writeFileSync(join(home, "config.toml"), "# unchanged native settings\n");
  const dump = join(root, "wire.json"), originalCli = fileURLToPath(new URL("../../testing/fake-fuigo-memory-acp.mjs", import.meta.url));
  let cli = originalCli;
  if (wrapped) {
    // Reuse the same accepted ACP lifecycle peer, changing only its wire envelope
    // in this test-owned copy. No new shared fixture or production transport.
    const source=readFileSync(originalCli,"utf8"),anchor="  const options = ";expect(source.split(anchor)).toHaveLength(2);
    const envelope=`  if(toolCall._meta)toolCall._meta["fuigo/tool"]={version:identity.version,namespace:identity.namespace==="mcp"?"fuigo_build":identity.namespace,name:"use_tool",kind:"use_tool",read_only:false};
  toolCall.rawInput={variant:"UseTool",tool_name:identity.name,tool_input:{query:"synthetic"}};
`;
    cli=join(root,"wrapped-memory-peer.mjs");writeFileSync(cli,source.replace(anchor,envelope+anchor));
  }
  const driver = createAcpDriver({ driverKind: scenario === "other-engine" ? "other-fixture" : scenario.startsWith("grok") ? "grokAgent" : "fuigoAgent", displayName: "Memory wire fixture", defaultCli: process.execPath,
    nativeSource: "fuigo.acp", models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }, loginNote: "unused", isAuthenticated: () => true, pickAuthMethod: () => null, authFailure: "continue",
    spawnArgs: () => [cli, scenario, dump, tool], transformEnv: env => { env.HOME = home; env.USERPROFILE = home; env.FUIGO_HOME = home; } });
  const instance = await driver.create({ instanceId: "memory-wire", displayName: "Memory wire", environment: {}, enabled: true, config: { cli: process.execPath, fullAuto: false } }); instances.push(instance);
  const recorder = recordEvents(instance.adapter), threadId = `memory-${basename(root)}`;
  const memory = { command: process.execPath, args: ["unused-fixture-proxy"], env: { MURAGE_MEMORY_TOKEN: "synthetic-memory-capability" } };
  const turn: SendTurnInput = { threadId, text: "Use scoped memory", cwd: root, ...(scenario === "no-integration" ? {} : { integrations: { memory } }),
    ...scenario.startsWith("load") ? { resumeCursor: "old-session" } : {},
    ...["routed", "grok-routed"].includes(scenario) ? { providerRoute: { connectionId: "fixture", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "synthetic-unused-key", model: "fixture", revision: "1" } as const } : {} };
  return { root, home, dump, instance, recorder, threadId, turn, memory };
}

for (const wrapped of [false, true]) {
it.each(names)(`${wrapped?"wrapped ":""}native Fuigo allows only this injected memory call once, without an approval card: %s`, async tool => {
  const f = await fixture("valid", tool, wrapped), sent = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.prompt.map((part: { text?: string }) => part.text ?? "").join("\n")).toContain(`tool_name "${observed.alias}__memory_search"`);
  expect(observed.alias).toMatch(/^murage-memory-[a-f0-9]{20}$/);
  expect(observed.definitions[0].servers[0]).toEqual({ name: observed.alias, command: f.memory.command, args: f.memory.args, env: [{ name: "MURAGE_MEMORY_TOKEN", value: "synthetic-memory-capability" }] });
  expect(observed.decisions).toEqual([{ outcome: { outcome: "selected", optionId: "once" } }]);
  expect(f.recorder.events.some(event => event.type === "request.opened")).toBe(false);
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe("# unchanged native settings\n");
});

it.each(["old-alias", "wrong-alias", "missing-meta", "wrong-version", "wrong-namespace", "missing-session", "wrong-session", "question", "no-once", "ambiguous-option", "before-prompt", "grok", "other-engine", "no-integration", "routed", "unregistered-tool"])(`${wrapped?"wrapped ":""}retains ordinary owner permission handling for %s`, async scenario => {
  const f = await fixture(scenario, scenario === "unregistered-tool" ? "memory_delete" : "memory_search", wrapped), sent = await f.instance.adapter.sendTurn(f.turn);
  const opened = await f.recorder.until(event => event.type === "request.opened");
  if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
  await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.decisions[0].outcome).toEqual({ outcome: "selected", optionId: "deny" });
  if (scenario === "routed" || scenario === "grok" || scenario === "other-engine") expect(observed.alias).toBe("murage-memory");
  const prompt = observed.prompt.map((part: { text?: string }) => part.text ?? "").join("\n");
  if (scenario === "routed" || scenario === "grok") expect(prompt).toContain(`tool_name "${observed.alias}__memory_search"`);
  if (scenario === "other-engine" || scenario === "no-integration") expect(prompt).not.toContain("Call use_tool");
});

it(`${wrapped?"wrapped ":""}a resumed turn gets a fresh alias and cannot reuse the preceding turn's automatic permission`, async () => {
  const f = await fixture("two-turns", "memory_search", wrapped), first = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
  const second = await f.instance.adapter.sendTurn({ ...f.turn, resumeCursor: "memory-fixture-session" });
  const opened = await f.recorder.until(event => event.type === "request.opened" && event.turnId === second.turnId);
  if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
  await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId);
  const turns = JSON.parse(readFileSync(f.dump, "utf8"));
  for (const turn of turns) expectCurrentInstruction(turn);
  expect(promptText(turns[1])).not.toContain(turns[0].alias);
  expect(turns).toHaveLength(2);expect(turns[0].alias).not.toBe(turns[1].alias);
  expect(turns[0].decisions[0].outcome.optionId).toBe("once");expect(turns[1].decisions[0].outcome.optionId).toBe("deny");
});

it(`${wrapped?"wrapped ":""}uses the same fresh alias through session/load then session/new fallback`, async () => {
  const f = await fixture("load-fallback", "memory_search", wrapped);
  const first = await f.instance.adapter.sendTurn({ ...f.turn, resumeCursor: undefined });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
  const sent = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const turns = JSON.parse(readFileSync(f.dump, "utf8"));
  expect(turns).toHaveLength(2);
  const observed = turns[1];
  expectCurrentInstruction(observed);
  expect(observed.alias).not.toBe(turns[0].alias);
  expect(promptText(observed)).not.toContain(turns[0].alias);
  expect(observed.definitions.map((item: { method: string }) => item.method)).toEqual(["session/load", "session/new"]);
  expect(observed.definitions[0].servers).toEqual(observed.definitions[1].servers);
  expect(observed.decisions[0].outcome.optionId).toBe("once");
});

it.each(["after-result", "after-cancel"])(`${wrapped?"wrapped ":""}never automatically grants a request %s`, async scenario => {
  const f = await fixture(scenario, "memory_search", wrapped), sent = await f.instance.adapter.sendTurn(f.turn);
  if (scenario === "after-cancel") { await f.recorder.until(event => event.type === "content.delta"); await f.instance.adapter.interruptTurn(f.threadId, sent.turnId); }
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  await f.instance.dispose();
  const wire = readFileSync(join(NATIVE_DIR, `${f.threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(wire.some(item => item.dir === "in" && item.msg?.id === "memory-permission")).toBe(true);
  expect(wire.some(item => item.dir === "out" && item.msg?.id === "memory-permission" && item.msg?.result?.outcome?.optionId === "once")).toBe(false);
});

}

function promptText(observed: { prompt: Array<{ text?: string }> }): string {
  return observed.prompt.map(part => part.text ?? "").join("\n");
}
function expectCurrentInstruction(observed: { alias: string; prompt: Array<{ text?: string }> }) {
  const lines = promptText(observed).split("\n").filter(line => line.includes("use_tool") && line.includes(observed.alias));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("MCP servers this turn:");
  expect(lines[0]).toContain(`tool_name "${observed.alias}__memory_search"`);
}

it("Grok with a provider route instructs the memory name actually mounted", async () => {
  const f = await fixture("grok-routed"), sent = await f.instance.adapter.sendTurn(f.turn);
  const opened = await f.recorder.until(event => event.type === "request.opened");
  if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
  await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.alias).toBe("murage-memory");
  expectCurrentInstruction(observed);
});

it("a command with memory mounted remains only the command", async () => {
  const f = await fixture("valid"), sent = await f.instance.adapter.sendTurn({ ...f.turn, system: "Persona", engineCommand: { name: "compact", args: "" } });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.alias).toMatch(/^murage-memory-/);
  expect(promptText(observed)).toBe("/compact");
});

it.each([
  { scenario: "valid", memory: true }, { scenario: "grok", memory: true },
  { scenario: "valid", memory: false }, { scenario: "grok", memory: false },
])("$scenario lists exactly the mounted browser and custom servers (memory: $memory)", async ({ scenario, memory }) => {
  const f = await fixture(scenario);
  const stub = { command: process.execPath, args: ["unused-fixture-proxy"], env: {} };
  const sent = await f.instance.adapter.sendTurn({ ...f.turn, integrations: {
    agents: stub, ...(memory ? { memory: f.memory } : {}), browser: stub, localComputer: stub,
    custom: { browser: stub, research: stub, "murage-memory": stub },
  } });
  if (scenario === "grok" || !memory) {
    const opened = await f.recorder.until(event => event.type === "request.opened");
    if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  }
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  const mounted = observed.definitions[0].servers.map((server: { name: string }) => server.name);
  expect(mounted).toEqual(["agents", ...(memory ? [observed.alias] : []), "browser", "computer", "research"]);
  const lines = promptText(observed).split("\n").filter(line => line.startsWith("MCP servers this turn:"));
  expect(lines).toHaveLength(1);
  expect(lines[0].split(". Call")[0]).toBe(`MCP servers this turn: ${mounted.join(", ")}`);
  expect(lines[0]).toContain('"browser__browser_snapshot"');
  expect(promptText(observed)).not.toContain("memory tools use the prefix");
  // Server names are routing labels, never something to tell the owner.
  expect(lines[0]).toContain("These names are internal: never mention them to the person you are helping.");
});

it.each(["valid", "grok", "other-engine"])("%s tells Murage's own agents and browser servers how the engine calls their tools", async scenario => {
  const f = await fixture(scenario);
  const stub = { command: process.execPath, args: ["unused-fixture-proxy"], env: { MURAGE_BOT_ID: "fixture" } };
  const sent = await f.instance.adapter.sendTurn({ ...f.turn, integrations: { agents: stub, memory: f.memory, browser: stub, localComputer: stub, custom: { research: { ...stub, env: {} } } } });
  if (scenario !== "valid") {
    const opened = await f.recorder.until(event => event.type === "request.opened");
    if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  }
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  const env = (name: string) => observed.definitions[0].servers.find((server: { name: string }) => server.name === name).env as Array<{ name: string; value: string }>;
  const style = (name: string) => env(name).filter(entry => entry.name === "MURAGE_TOOL_CALL_STYLE" || entry.name === "MURAGE_MCP_SERVER_NAME");
  for (const name of ["agents", "browser"]) {
    expect(env(name)).toContainEqual({ name: "MURAGE_BOT_ID", value: "fixture" });
    expect(style(name)).toEqual(scenario === "other-engine" ? [] : [{ name: "MURAGE_TOOL_CALL_STYLE", value: "use-tool" }, { name: "MURAGE_MCP_SERVER_NAME", value: name }]);
  }
  // Not Murage's text: the owner's own servers, the external computer server and memory are left as they were.
  for (const name of ["research", "computer", observed.alias]) expect(style(name)).toEqual([]);
});
