// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Tool names in text a bot reads must be callable on that bot's engine. On
// Fuigo and Grok Build Murage's tools are reached only through use_tool with
// "<server>__<tool>"; a bare "Call generate_image again" is "Tool not found".
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { MURAGE_MCP_TOOLS, murageToolName, murageToolText, parseToolCallStyle, toolCallStyleFor, type ToolCallStyle } from "../shared/murage-tool-names.ts";
import { withToolCallStyle } from "./tool-call-context.ts";
import { getPromptBlock, resolveReferencePack } from "./image-library.ts";
import { pollImageJob } from "./image-delivery.ts";
import { imagePublishRecoveryMessage } from "./image-operations.ts";
import { TOOLS as BROWSER_TOOLS, engineText as browserEngineText } from "./drivers/browser-proxy.ts";
import { allocateToolName } from "./drivers/pi-mcp-extension.ts";
import { TURN_PROMPTS, directTurnLayers, joinShapeLayers, skillLayers } from "./bot-shapes.ts";
import { chiefOfStaffSystemPrompt, individualAssistantSystemPrompt } from "./chief-of-staff.ts";
import { expandLearnTurnText } from "./skill-learn.ts";
import { capabilitiesPrimer, turnCapabilityFacts } from "./capabilities-primer.ts";
import { loadBundledSkills } from "./skill-library.ts";
import { outputDestinationInstructions } from "./output-publication.ts";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTS_PROXY = join(here, "drivers", "agents-proxy.ts");

/** tools/list of the real agents proxy, spawned the way a driver mounts it. */
async function agentsTools(extraEnv: Record<string, string> = {}): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  const child = spawn(process.execPath, [AGENTS_PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: "http://127.0.0.1:9", MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t",
    MURAGE_COMMS_TOKEN: "x", MURAGE_SKILL_AUTHORING_ENABLED: "1", ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] });
  const reply = new Promise<string>(resolve => { let out = ""; child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.split("\n")[0]!); }); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const line = await reply; child.kill();
  return JSON.parse(line).result.tools;
}

/** Engines Murage mounts its agents tools on, and how each lists them. */
const ENGINES: Array<{ kind: string; listed: (tool: string) => string }> = [
  { kind: "claude", listed: tool => `mcp__agents__${tool}` },
  { kind: "codex", listed: tool => `mcp__agents__${tool}` },
  { kind: "pi", listed: tool => allocateToolName("agents", tool, new Set()) },
  ...["fuigoAgent", "grokAgent"].map(kind => ({ kind, listed: (tool: string) => `agents__${tool}` })),
  ...["kimiAgent", "geminiAgent", "cursorAgent", "droidAgent", "opencodeGo", "customAcp"].map(kind => ({ kind, listed: (tool: string) => tool })),
];
const ALL_NAMES = Object.values(MURAGE_MCP_TOOLS).flat() as string[];
const barePattern = new RegExp(`(?<![A-Za-z0-9_])(${ALL_NAMES.join("|")})(?![A-Za-z0-9_])`, "g");

/** Every tool the text names resolves on that engine's surface. */
function expectCallableOn(kind: string, text: string, known: readonly string[]) {
  const style = toolCallStyleFor(kind);
  const qualified = [...text.matchAll(/tool_name "([a-z-]+)__([a-z_]+)"/g)];
  const rest = text.replace(/use_tool with tool_name "[^"]+"/g, "");
  const bare = [...rest.matchAll(barePattern)].map(match => match[1]!);
  if (style === "use-tool") {
    expect(bare, `${kind}: bare Murage tool names in ${JSON.stringify(text)}`).toEqual([]);
    expect(qualified.length, `${kind}: no qualified name in ${JSON.stringify(text)}`).toBeGreaterThan(0);
    for (const [, server, tool] of qualified) {
      expect(Object.keys(MURAGE_MCP_TOOLS)).toContain(server);
      expect(known).toContain(tool);
    }
  } else {
    expect(qualified, `${kind}: use_tool wording on an engine that lists tools`).toEqual([]);
    expect(bare.length).toBeGreaterThan(0);
    const engine = ENGINES.find(item => item.kind === kind)!;
    // The bare name is what the primer tells these engines to call; each one
    // lists the tool under a name that ends with it.
    for (const tool of bare) { expect(known).toContain(tool); expect(engine.listed(tool).endsWith(tool)).toBe(true); }
  }
}

describe("murageToolName / murageToolText", () => {
  it("names a tool bare for engines that list tools, and as a use_tool call for Fuigo and Grok", () => {
    expect(murageToolName("generate_image", "direct")).toBe("generate_image");
    expect(murageToolName("generate_image", undefined)).toBe("generate_image");
    expect(murageToolName("generate_image", "use-tool")).toBe('use_tool with tool_name "agents__generate_image"');
    expect(murageToolName("browser_request_takeover", "use-tool")).toBe('use_tool with tool_name "browser__browser_request_takeover"');
    expect(murageToolName("browser_snapshot", "use-tool", "web")).toBe('use_tool with tool_name "web__browser_snapshot"');
    expect(toolCallStyleFor("fuigoAgent")).toBe("use-tool");
    expect(toolCallStyleFor("grokAgent")).toBe("use-tool");
    for (const kind of ["claude", "codex", "pi", "kimiAgent", "geminiAgent", "customAcp"]) expect(toolCallStyleFor(kind)).toBe("direct");
    expect([parseToolCallStyle("use-tool"), parseToolCallStyle("USE-TOOL"), parseToolCallStyle(undefined), parseToolCallStyle(["use-tool"])]).toEqual(["use-tool", "direct", "direct", "direct"]);
  });
  it("rewrites whole names only, once, and leaves every other engine's text untouched", () => {
    const text = "Use list_routines first, then propose_routine_action; agents__ask_bot and my_list_bots stay; reference_ids is a field.";
    expect(murageToolText(text, "direct")).toBe(text);
    const once = murageToolText(text, "use-tool");
    expect(once).toBe('Use use_tool with tool_name "agents__list_routines" first, then use_tool with tool_name "agents__propose_routine_action"; agents__ask_bot and my_list_bots stay; reference_ids is a field.');
    expect(murageToolText(once, "use-tool")).toBe(once);
    expect(murageToolText("call browser_request_takeover", "use-tool")).toBe("call browser_request_takeover");
    expect(murageToolText("call browser_request_takeover", "use-tool", ["browser"])).toBe('call use_tool with tool_name "browser__browser_request_takeover"');
  });
});

describe("the tool name list follows the proxies", () => {
  it("matches the agents proxy's tools/list exactly", async () => {
    expect((await agentsTools()).map(tool => tool.name).sort()).toEqual([...MURAGE_MCP_TOOLS.agents].sort());
  });
  it("matches the built-in browser proxy's tools", () => {
    expect(BROWSER_TOOLS.map(tool => tool.name).filter(name => name.includes("_")).sort()).toEqual(MURAGE_MCP_TOOLS.browser.filter(name => !name.startsWith("agent_browser_")).sort());
  });
  it("matches Murage's computer proxy's tools", () => {
    const source = readFileSync(join(here, "computer-proxy.ts"), "utf8");
    expect([...source.matchAll(/^\s+name: "([a-z_]+)",$/gm)].map(match => match[1]).filter(name => name!.includes("_")).sort()).toEqual([...MURAGE_MCP_TOOLS.computer].sort());
  });
  it("matches the dweb proxy's tools", () => {
    const source = readFileSync(join(here, "drivers", "dweb-proxy.ts"), "utf8");
    expect([...source.matchAll(/name: "([a-z_]+)"/g)].map(match => match[1]).sort()).toEqual([...MURAGE_MCP_TOOLS.dweb].sort());
  });
});

describe("image refusals name tools the calling engine can call", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DatabaseSync(":memory:"); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  const bot = { kind: "bot" as const, botId: "a" };
  const refusal = (run: () => unknown): string => { try { run(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
  const clock = () => { let now = 0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; };
  const messages = async (): Promise<string[]> => {
    const expired = vi.fn().mockResolvedValue({ status: 200, body: { kind: "image-job", status: "expired" } });
    const uncertain = await pollImageJob({ id: "j", get: expired, signal: new AbortController().signal, ...clock() }).then(() => "", (error: Error) => error.message);
    return [
      refusal(() => getPromptBlock(db, bot, "brand-lock")),
      refusal(() => resolveReferencePack(db, DATA_DIR, bot, "hero-pack")),
      uncertain,
      imagePublishRecoveryMessage("publish_failed"),
    ];
  };
  it.each(ENGINES.map(engine => engine.kind))("%s", async kind => {
    const known = MURAGE_MCP_TOOLS.agents;
    const texts = await withToolCallStyle(toolCallStyleFor(kind), messages);
    expect(texts).toHaveLength(4);
    for (const text of texts) expectCallableOn(kind, text, known);
  });
  it("with no turn context the text is the bare name, as before", async () => {
    const [block, pack, uncertain, recovery] = await messages();
    expect(block).toContain("list_prompt_blocks shows the ones you can use");
    expect(pack).toContain("list_reference_packs shows the ones you can use");
    expect(uncertain).toContain("Call generate_image again with the same request_id to check job j");
    expect(recovery).toContain("Call generate_image again with the same request_id during this turn");
  });
});

describe("the agents proxy speaks its engine's names", () => {
  const style = (value: ToolCallStyle) => ({ MURAGE_TOOL_CALL_STYLE: value, MURAGE_MCP_SERVER_NAME: "agents" });
  it("tool descriptions on Fuigo name sibling tools through use_tool, and are unchanged elsewhere", async () => {
    const direct = await agentsTools(), fuigo = await agentsTools(style("use-tool"));
    expect(await agentsTools(style("direct"))).toEqual(direct);
    expect(fuigo.map(tool => tool.name)).toEqual(direct.map(tool => tool.name));
    const text = (tools: typeof direct) => JSON.stringify(tools.map(tool => [tool.description, tool.inputSchema]));
    expect(text(direct)).toContain("(see list_prompt_blocks)");
    expect(text(fuigo)).toContain('(see use_tool with tool_name \\"agents__list_prompt_blocks\\")');
    for (const tool of fuigo) expectNoBareName(JSON.stringify([tool.description, tool.inputSchema]).replace(/\\"/g, '"'));
  });
});

describe("proxy results", () => {
  it("the agents proxy's own refusal names the tool the way Fuigo calls it", async () => {
    const call = async (env: Record<string, string>) => {
      const child = spawn(process.execPath, [AGENTS_PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: "http://127.0.0.1:9", MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t", MURAGE_COMMS_TOKEN: "x", ...env }, stdio: ["pipe", "pipe", "ignore"] });
      const reply = new Promise<string>(resolve => { let out = ""; child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.split("\n")[0]!); }); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delegate_bot", arguments: {} } })}\n`);
      const line = await reply; child.kill();
      return JSON.parse(line).result.content[0].text as string;
    };
    expect(await call({})).toBe("delegate_bot needs bot_id and message.");
    expect(await call({ MURAGE_TOOL_CALL_STYLE: "use-tool", MURAGE_MCP_SERVER_NAME: "agents" })).toBe('use_tool with tool_name "agents__delegate_bot" needs bot_id and message.');
  });
  it("the agents proxy tells the harness its style on every call, the long image call included", async () => {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const stub = createServer((req, res) => { seen.push({ url: req.url ?? "", headers: req.headers }); req.resume(); req.on("end", () => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "fixture" })); }); });
    await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(process.execPath, [AGENTS_PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t", MURAGE_COMMS_TOKEN: "x",
        MURAGE_TOOL_CALL_STYLE: "use-tool", MURAGE_MCP_SERVER_NAME: "agents" }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      const replies = (n: number) => new Promise<void>(resolve => { const check = () => { if (out.split("\n").filter(Boolean).length >= n) resolve(); }; child.stdout.on("data", chunk => { out += chunk; check(); }); });
      const done = replies(2);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bots", arguments: {} } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate_image", arguments: { request_id: "r1", prompt: "x" } } })}\n`);
      await done; child.kill();
      const calls = seen.filter(call => call.url.startsWith("/api/internal/agents") || call.url.startsWith("/api/internal/generate-image"));
      expect(calls.map(call => call.url.split("?")[0]).sort()).toEqual(["/api/internal/agents", "/api/internal/generate-image"]);
      for (const call of calls) expect(call.headers["x-murage-tool-call-style"]).toBe("use-tool");
    } finally { await new Promise(resolve => stub.close(resolve)); }
  });
  it("Murage's computer server names its tools in its descriptions the way Fuigo calls them", async () => {
    const list = async (env: Record<string, string>) => {
      const child = spawn(process.execPath, [join(here, "computer-proxy.ts")], { env: { ...process.env, MURAGEBOX_BOX_API: "http://127.0.0.1:9", MURAGEBOX_BOX_ID: "box-fixture", ...env }, stdio: ["pipe", "pipe", "ignore"] });
      const reply = new Promise<string>(resolve => { let out = ""; child.stdout.on("data", chunk => { out += chunk; const line = out.split("\n").find(item => item.includes('"id":7')); if (line) resolve(line); }); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`);
      const line = await reply; child.kill();
      return JSON.stringify(JSON.parse(line).result.tools);
    };
    expect(await list({})).toContain("from the most recent browser_snapshot");
    expect(await list({ MURAGE_TOOL_CALL_STYLE: "use-tool", MURAGE_MCP_SERVER_NAME: "computer" })).toContain('from the most recent use_tool with tool_name \\"computer__browser_snapshot\\"');
  });
  it("the browser proxy names its own tools under the mount it was given", () => {
    const text = "The browser tab is empty. Use browser_navigate to open a page.";
    vi.stubEnv("MURAGE_TOOL_CALL_STYLE", "");
    try {
      expect(browserEngineText(text)).toBe(text);
      vi.stubEnv("MURAGE_TOOL_CALL_STYLE", "use-tool"); vi.stubEnv("MURAGE_MCP_SERVER_NAME", "browser");
      expect(browserEngineText(text)).toBe('The browser tab is empty. Use use_tool with tool_name "browser__browser_navigate" to open a page.');
    } finally { vi.unstubAllEnvs(); }
  });
});

function expectNoBareName(text: string) {
  const rest = text.replace(/use_tool with tool_name "[^"]+"/g, "");
  expect([...rest.matchAll(barePattern)].map(match => match[1]), text).toEqual([]);
}

describe("Murage-written prompt text names tools the turn's engine can call", () => {
  const layers = (driverKind: string, computerKind: "box" | null = null) => directTurnLayers({
    houseRules: "Owner rule: never call list_bots on Sundays.", persona: "You are Nova. Owner says: ask_bot is my favourite word.", computerKind, vmPerBot: false, driverKind,
    connectors: "", requiredApps: "", browser: " You have your own browser through the agent_browser tools. agent_browser_open opens a page.",
    coordination: "", credential: ` ${TURN_PROMPTS.credential}`, image: ` ${TURN_PROMPTS.imageTools}`, webSearchBackup: true,
    routines: ` ${TURN_PROMPTS.routines}`, learn: ` ${TURN_PROMPTS.learn}`, importedSkills: "", teamBrief: "", memory: "Remember: delegate_bot is how Sam works.",
    primer: "", skills: [], playbooks: "", outputFolder: "\nAfter creating each file, call register_artifact with its path relative to the file workspace.",
    tagged: [{ name: "Reed", id: "bot-reed" }],
  });
  const authored = ["computer", "browser", "credential", "images", "web-search", "routines", "learn", "tagged"];
  it.each(ENGINES.map(engine => engine.kind))("%s: the direct turn's own layers", kind => {
    const all = layers(kind, "box");
    const own = all.filter(layer => authored.includes(layer.id) && layer.text);
    expect(own.map(layer => layer.id).sort()).toEqual([...authored].sort());
    for (const layer of own.filter(layer => layer.id !== "computer")) expectCallableOn(kind, layer.text, [...MURAGE_MCP_TOOLS.agents, ...MURAGE_MCP_TOOLS.browser]);
    // The owner's own words are theirs, on every engine.
    expect(all.find(layer => layer.id === "house-rules")!.text).toBe("Owner rule: never call list_bots on Sundays.");
    expect(all.find(layer => layer.id === "persona")!.text).toBe("You are Nova. Owner says: ask_bot is my favourite word.");
    expect(all.find(layer => layer.id === "memory")!.text).toBe("Remember: delegate_bot is how Sam works.");
    expect(all.find(layer => layer.id === "output-folder")!.text).toBe("\nAfter creating each file, call register_artifact with its path relative to the file workspace.");
    // Every engine that lists tools gets exactly the text it had.
    if (toolCallStyleFor(kind) === "direct") {
      expect(all.find(layer => layer.id === "credential")!.text).toBe(` ${TURN_PROMPTS.credential}`);
      expect(all.find(layer => layer.id === "images")!.text).toBe(` ${TURN_PROMPTS.imageTools}`);
      expect(all.find(layer => layer.id === "routines")!.text).toBe(` ${TURN_PROMPTS.routines}`);
      expect(all.find(layer => layer.id === "tagged")!.text).toBe(" The user tagged @Reed (bot_id bot-reed) in their message. If they assigned independent work, use delegate_bot and finish your turn without waiting; use ask_bot only if their short reply is required in this answer.");
    }
  });
  it("a computer other than the cloud box is never rewritten: it speaks of the desktop, not a tool", () => {
    for (const kind of ["local", "vps", "vm"] as const) {
      const text = (driverKind: string) => directTurnLayers({ houseRules: "", persona: "", computerKind: kind, vmPerBot: false, driverKind,
        connectors: "", requiredApps: "", browser: "", coordination: "", credential: "", image: "", webSearchBackup: false, routines: "", learn: "", importedSkills: "", teamBrief: "", memory: "",
        primer: "", skills: [], playbooks: "", outputFolder: "", tagged: [] }).find(layer => layer.id === "computer")!.text;
      expect(text("fuigoAgent")).toBe(text("claude"));
      expect(text("fuigoAgent")).not.toContain("use_tool");
    }
  });
  it.each(ENGINES.map(engine => engine.kind))("%s: the file destination line, with the owner's folder word for word", kind => {
    const text = outputDestinationInstructions({ workspaceRoot: "/Users/o/web_search/generate_image", managed: false }, false, true, toolCallStyleFor(kind));
    expect(text).toContain('Murage file destination: "/Users/o/web_search/generate_image"');
    expectCallableOn(kind, text.replace('"/Users/o/web_search/generate_image"', ""), MURAGE_MCP_TOOLS.agents);
  });
  it("an owner's or learned skill is never rewritten, even on Fuigo", () => {
    const own = { manifest: { id: "web_search", name: "web_search", description: "x", requiredCapabilities: [] }, instructions: "Call generate_image with care.", directory: "/data/skills/web_search" } as never;
    const fuigo = skillLayers([own], { toolCallStyle: "use-tool", murageSkill: () => false })[0]!.text;
    expect(fuigo).toBe(skillLayers([own])[0]!.text);
    expect(fuigo).toContain("Call generate_image with care.");
  });
  it("names the cloud computer's own tools on its own server, and leaves Claude's line as it was", () => {
    const box = (kind: string) => layers(kind, "box").find(layer => layer.id === "computer")!.text;
    expect(box("claude")).toContain("prefer browser_snapshot with browser_click/browser_fill");
    expect(box("fuigoAgent")).toContain('prefer use_tool with tool_name "computer__browser_snapshot" with use_tool with tool_name "computer__browser_click"/use_tool with tool_name "computer__browser_fill"');
    expect(box("fuigoAgent")).toContain('use use_tool with tool_name "computer__screenshot"/use_tool with tool_name "computer__click"/use_tool with tool_name "computer__type_text"');
    expect(box("fuigoAgent")).not.toMatch(/(?<![_"])(screenshot|click|computer_exec|computer_batch|open_url)(?![A-Za-z_"])/);
    expect(joinShapeLayers(layers("claude", "box"))).toBe(joinShapeLayers(layers("codex", "box")));
  });
  it.each(ENGINES.map(engine => engine.kind))("%s: Chief, team lead and individual assistant lines", kind => {
    const style = toolCallStyleFor(kind);
    const bots = [
      { id: "chief", name: "Ada", chiefOfStaff: true, chiefScope: "workspace" as const, section: "HQ" },
      { id: "lead", name: "Bo", chiefOfStaff: true, section: "Design" },
      ...Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, name: `Spec list_bots ${index}`, section: "Design" })),
      { id: "solo", name: "Cy", individual: true, section: "Solo" },
    ];
    for (const text of [
      chiefOfStaffSystemPrompt("lead", bots as never, true, "", style),
      individualAssistantSystemPrompt("solo", bots as never, true, style),
    ]) {
      // Bot names are the owner's: only Murage's sentences are checked.
      expectCallableOn(kind, text.replace(/Spec list_bots \d+/g, "Spec"), MURAGE_MCP_TOOLS.agents);
    }
    expect(chiefOfStaffSystemPrompt("lead", bots as never, true, "", style)).toContain("Spec list_bots 1 (");
  });
  it.each(ENGINES.map(engine => engine.kind))("%s: /learn steps, with the request word for word", kind => {
    const text = expandLearnTurnText("/learn how I use skill_manage at work", toolCallStyleFor(kind));
    expect(text).toContain("THE REQUEST:\nhow I use skill_manage at work\n");
    expectCallableOn(kind, text.replace("how I use skill_manage at work", ""), MURAGE_MCP_TOOLS.agents);
  });
  it.each(ENGINES.map(engine => engine.kind))("%s: the bundled image-generation skill as the turn carries it", kind => {
    const skill = loadBundledSkills(join(here, "..", "skills")).find(item => item.manifest.id === "image-generation")!;
    const text = skillLayers([skill], { toolCallStyle: toolCallStyleFor(kind), murageSkill: item => item === skill })[0]!.text;
    for (const tool of ["list_image_models", "generate_image", "save_prompt_block", "list_prompt_blocks", "get_prompt_block", "resolve_image_reference", "save_reference_pack", "list_reference_packs"])
      expect(text).toContain(toolCallStyleFor(kind) === "use-tool" ? `tool_name "agents__${tool}"` : `\`${tool}\``);
    expectCallableOn(kind, text, MURAGE_MCP_TOOLS.agents);
  });
  it.each(ENGINES.map(engine => engine.kind))("%s: the capabilities primer's own sentences", kind => {
    const text = capabilitiesPrimer(turnCapabilityFacts({
      instance: { driverKind: kind, models: { default: "m", options: [] }, adapter: { capabilities: {} } } as never,
      integrations: { agents: { command: "node", args: [], env: {} } }, peers: 1, memory: "off", imageProvider: true, voice: true, canAskOwner: true, cwd: "/w",
      imageConnections: [{ label: "Flux Router generate_image", inUse: true, model: "gpt-image-2" }],
    } as never));
    // The tool-access line explains the rule with a bare example on purpose;
    // the connection label is the workspace's.
    const own = text.replace(/Murage's tools are not in your tool list here\.[^\n]*/, "").replace("Flux Router generate_image", "Flux Router");
    expectCallableOn(kind, own, MURAGE_MCP_TOOLS.agents);
    expect(text).toContain("Flux Router generate_image (in use");
  });
});
