import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { applyOpenCodeTurnPermission, applyToolCatalogDenies } from "./opencode-go.ts";
import { publicationFailureFrame, publishCloudMcpCatalog, readMcpCatalog, registerCloudMcpCatalog } from "../../mcp-listed.ts";
import { readToolLimit } from "./opencode-tool-budget.ts";
import version from "../../testing/fixtures/opencode-pinned/version.json" with { type: "json" };

const binary = process.env.MURAGE_OPENCODE_PINNED_BIN;
const fixture = resolve("server/testing/fixtures/opencode-pinned/mcp.mjs");
const ordinary = ["bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "skill"];
function connection(child: ChildProcessWithoutNullStreams) {
  let id = 0, buffer = "", stderr = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const msg = JSON.parse(line); const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); entry.resolve(msg); } } catch { /* diagnostic */ }
    }
  });
  child.on("exit", () => { for (const entry of pending.values()) entry.reject(new Error(`Fixture engine closed: ${stderr.slice(-3000)}`)); });
  return { rpc: (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: seq, method, params }) + "\n"); }), close: async () => { if (child.exitCode !== null) return; const closed = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGTERM"); await closed; } };
}

it.skipIf(!binary)("T21 pinned 1.19.5 provider catalog, permissions, native accounting and error history", async () => {
  expect(execFileSync(binary!, ["--version"], { encoding: "utf8" }).trim()).toBe(version.version);
  if (process.platform === "linux" && process.arch === "x64") expect(createHash("sha256").update(readFileSync(binary!)).digest("hex")).toBe(version.linuxX64Sha256);
  const root = mkdtempSync(join(tmpdir(), "c11-pinned-"));
  for (const part of ["home", "work"]) mkdirSync(join(root, part));
  const captured: any[] = []; let rejection = false;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    captured.push(JSON.parse(body));
    if (rejection) { rejection = false; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "tools: array too long. Expected an array with maximum length 40, but got 64.", type: "invalid_request_error" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{role:'assistant',content:'Fixture complete'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: join(root, "home"), USERPROFILE: join(root, "home"), TMPDIR: root, XDG_CONFIG_HOME: join(root, "home/config"), XDG_DATA_HOME: join(root, "home/data"), XDG_CACHE_HOME: join(root, "home/cache"), XDG_STATE_HOME: join(root, "home/state"), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_PURE: "true" };
  const provider = { npm: "@ai-sdk/openai-compatible", name: "Offline fixture", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-only" }, models: { mock: { name: "Mock", limit: { context: 32000, output: 1000 } }, "gpt-5-mock": { name: "GPT mock", limit: { context: 32000, output: 1000 } } } };
  const mount = (name: string, names: string[], resources = false) => ({ name, command: process.execPath, args: [fixture], env: [{ name: "FIXTURE_TOOLS", value: JSON.stringify(names) }, { name: "FIXTURE_RESOURCES", value: resources ? "1" : "0" }] });
  const mounts = [mount("alpha", Array.from({ length: 10 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`)), mount("beta-x.y", ["t.1", ...Array.from({ length: 7 }, (_, i) => `b${i}`)])];
  let active: ReturnType<typeof connection> | undefined;
  try {
    for (const scenario of [
      ...["fixture", "opencode"].flatMap(providerId => ["mock", "gpt-5-mock"].map(model => ({ providerId, model, resources: false, flags: false }))),
      { providerId: "fixture", model: "mock", resources: true, flags: false },
      { providerId: "fixture", model: "mock", resources: false, flags: true },
      { providerId: "fixture", model: "mock", resources: false, flags: false, code: true },
      { providerId: "fixture", model: "mock", resources: false, flags: false, search: true },
    ]) {
      const { providerId, model } = scenario;
      const code = "code" in scenario && scenario.code, search = "search" in scenario && scenario.search;
      env.OPENCODE_EXPERIMENTAL_CODE_MODE = code ? "true" : "false";
      env.OPENCODE_ENABLE_EXA = search ? "true" : "false";
      env.OPENCODE_ENABLE_QUESTION_TOOL = scenario.flags ? "true" : "false";
      env.OPENCODE_EXPERIMENTAL_LSP_TOOL = scenario.flags ? "true" : "false";
      const activeMounts = mounts.map(m => scenario.resources && m.name === "beta-x.y" ? { ...m, env: m.env.map(e => e.name === "FIXTURE_RESOURCES" ? { ...e, value: "1" } : e) } : m);
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `${providerId}/${model}`, small_model: `${providerId}/${model}`, provider: { [providerId]: provider } });
      applyOpenCodeTurnPermission(env); applyToolCatalogDenies(env, [["beta-x_y_*", "deny"], ["alpha_a09", "deny"], ["alpha_a10", "deny"]]);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      // Make the two built-in subagents selectable to exercise their actual permission copies.
      config.agent.general.mode = "primary"; config.agent.explore.mode = "primary";
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      active = connection(spawn(binary!, ["acp"], { cwd: join(root, "work"), env }));
      expect((await active.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} })).error).toBeUndefined();
      const opened = await active.rpc("session/new", { cwd: join(root, "work"), mcpServers: activeMounts });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId;
      const natives = model === "mock" ? ordinary : [...ordinary.filter(n => n !== "edit" && n !== "write"), "apply_patch"];
      const expected = [...natives, ...(providerId === "opencode" || search ? ["websearch"] : []), ...(scenario.resources ? ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] : []), ...(scenario.flags ? ["question", "lsp"] : []), ...(code ? ["execute"] : []), ...Array.from({ length: code ? 0 : 8 }, (_, i) => `alpha_a${String(i + 1).padStart(2, "0")}`)].sort();
      for (const mode of ["build", "plan", "general", "explore"]) {
        expect((await active.rpc("session/set_mode", { sessionId, modeId: mode })).error).toBeUndefined();
        const response = await active.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Offline catalog fixture" }] });
        expect(response.error).toBeUndefined();
        const names = captured.at(-1).tools.map((tool: any) => tool.function.name).sort();
        expect(names).toEqual(expected);
        expect(names).not.toContain("codesearch");
      }
      if (providerId === "fixture" && model === "mock" && !scenario.resources && !scenario.flags && !code && !search) {
        rejection = true;
        const failed = await active.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Failed original fixture message" }] });
        expect(failed.error).toMatchObject({ code: -32603, data: { errorName: "APIError" } });
        expect(readToolLimit({ ...failed.error, acpMethod: "session/prompt" })).toBe(40);
        await active.close();
        active = connection(spawn(binary!, ["acp"], { cwd: join(root, "work"), env }));
        await active.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
        expect((await active.rpc("session/load", { sessionId, cwd: join(root, "work"), mcpServers: activeMounts })).error).toBeUndefined();
        const prefix = "Murage is sending the previous message again after the provider rejected the tool count. The engine already stored that message.";
        await active.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: `${prefix} Failed original fixture message` }] });
        const messages = captured.at(-1).messages;
        expect(JSON.stringify(messages)).toContain("Failed original fixture message");
        expect(messages.at(-1).content).toContain(prefix);
        expect(messages.filter((m: any) => m.role === "assistant" && !m.content && !m.tool_calls)).toEqual([]);
      }
      await active.close(); active = undefined;
    }
    // Actual OpenCode refreshes: overlapping generations cannot certify whichever finishes last.
    const { readMcpCatalog } = await import("../../mcp-listed.ts");
    for (const order of [[2, 1], [1, 2], [1]]) {
      const growth = order.length === 1;
      const control = mkdtempSync(join(root, "refresh-")), marker = join(control, "generation.race");
      env.OPENCODE_ENABLE_QUESTION_TOOL = "false"; env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "false";
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/mock", small_model: "fixture/mock", provider: { fixture: provider } });
      applyOpenCodeTurnPermission(env);
      if (growth) applyToolCatalogDenies(env, [["race_*", "deny"], ["race_final_0", "ask"]]);
      const raceMount = { name: "race", command: process.execPath, args: [fixture], env: [{ name: "FIXTURE_TOOLS", value: "[]" }, { name: "FIXTURE_PAGE_SIZE", value: "100" }, { name: "FIXTURE_REFRESH_DIR", value: control }, { name: "FIXTURE_GROWTH", value: growth ? "1" : "0" }, { name: "MURAGE_MCP_LISTED_FILE", value: marker }] };
      active = connection(spawn(binary!, ["acp"], { cwd: join(root, "work"), env }));
      await active.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const opened = await active.rpc("session/new", { cwd: join(root, "work"), mcpServers: [raceMount] });
      const sessionId = opened.result.sessionId;
      const wait = async (file: string) => { await expect.poll(() => existsSync(join(control, file)), { timeout: 10000 }).toBe(true); };
      const capture = async () => { const response = await active!.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Refresh catalog fixture" }] }); expect(response.error).toBeUndefined(); return captured.at(-1).tools.map((t: any) => t.function.name).filter((n: string) => n.startsWith("race_")); };
      await wait("completed-0");
      expect(readMcpCatalog(marker)?.complete).toBe(true);
      writeFileSync(join(control, "notify-1"), ""); await wait("started-1");
      if (growth) {
        await wait("completed-1");
        expect(await capture()).toEqual(["race_final_0"]);
      } else {
        expect(readMcpCatalog(marker)?.complete).toBe(false);
        writeFileSync(join(control, "notify-2"), ""); await wait("started-2");
        expect(readMcpCatalog(marker)?.complete).toBe(false);
        for (const n of order) { writeFileSync(join(control, `release-${n}`), ""); await wait(`completed-${n}`); expect(readMcpCatalog(marker)?.complete).toBe(false); }
        const installed = await capture();
        expect(installed.sort()).toEqual((order.at(-1) === 1 ? Array.from({ length: 12 }, (_, i) => `race_large_${i}`) : ["race_small_0", "race_small_1"]).sort());
        writeFileSync(join(control, "notify-3"), ""); await wait("completed-3");
        expect(readMcpCatalog(marker)).toMatchObject({ complete: true, tools: ["final_0", "final_1", "final_2"] });
        expect((await capture()).sort()).toEqual(["race_final_0", "race_final_1", "race_final_2"]);
      }
      await active.close(); active = undefined;
    }
  } finally { await active?.close(); await new Promise<void>(r => server.close(() => r())); }
}, 180000);

it.skipIf(!binary)("W3 isolated Zen cardinality rejection learns, loads and sends one labelled recovery", async () => {
  const { createAcpDriver } = await import("./core.ts");
  const { ToolLimitStore, REQUIRED_CONTROLS } = await import("./opencode-tool-budget.ts");
  const { NATIVE_DIR, ensureDirs } = await import("../../config.ts");
  ensureDirs();
  const { recordEvents } = await import("../../testing/events.ts");
  const root = mkdtempSync(join(tmpdir(), "c11-zen-")); mkdirSync(join(root, "work"));
  const key = createHash("sha256").update(root).digest("hex"), requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const captured = JSON.parse(body); if (Array.isArray(captured.tools)) requests.push(captured);
    const count = captured.tools?.length ?? 0;
    if (count > 128) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `tools: array too long. Expected an array with maximum length 128, but got ${count}.`, type: "invalid_request_error" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{role:'assistant',content:'Fixture complete'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const driver = createAcpDriver({ driverKind: "c11ZenPinned", displayName: "Pinned Zen fixture", models: { default: "opencode/mock", options: [] }, defaultCli: binary!, nativeSource: "c11.pinned", loginNote: "unused", spawnArgs: () => ["acp"], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, mcpListedWait: true, toolBudget: { routeKey: () => key }, transformEnv: env => applyOpenCodeTurnPermission(env) });
  const instance = await driver.create({ instanceId: key, displayName: "Pinned fixture", enabled: true, config: { cli: binary!, fullAuto: false }, environment: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_PURE: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "opencode/mock", small_model: "opencode/mock", provider: { opencode: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-only" }, models: { mock: { name: "Mock", limit: { context: 32000, output: 1000 } } } } } }) } });
  const events = recordEvents(instance.adapter);
  const controls = REQUIRED_CONTROLS.filter(n => n !== "project_propose"), names = [...controls, ...Array.from({ length: 130 }, (_, i) => `extra_${i}`)];
  try {
    await instance.adapter.sendTurn({ threadId: key, cwd: join(root, "work"), text: "Local Zen fixture request", integrations: { agents: { command: process.execPath, args: [fixture], env: { FIXTURE_TOOLS: JSON.stringify(names), FIXTURE_PAGE_SIZE: "29" } } } });
    const terminal = await events.until(e => e.type === "turn.completed", 90000);
    expect(terminal).toMatchObject({ ok: true });
    console.info("W3 captured tool counts", requests.map(r => r.tools.length));
    expect(requests.map(r => r.tools.length)).toEqual([156, 124]);
    expect(await new ToolLimitStore(join(NATIVE_DIR, "opencode-tool-limits.json")).get(key)).toMatchObject({ limit: 128, margin: 4 });
    const wire = [join(NATIVE_DIR, `${key}.previous.ndjson`), join(NATIVE_DIR, `${key}.ndjson`)].filter(existsSync).flatMap(file => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)));
    const methods = wire.filter(row => row.dir === "out" && row.msg?.method).map(row => row.msg.method);
    const finalReply = wire.find(row => row.dir === "in" && row.msg?.result?.stopReason === "end_turn");
    const rejected = wire.find(row => row.dir === "in" && row.msg?.error?.code === -32603)?.msg.error;
    expect(methods.filter(method => method === "session/prompt")).toHaveLength(2);
    expect(methods.filter(method => method === "session/load")).toHaveLength(1);
    expect(finalReply).toBeDefined();
    expect(readToolLimit({ ...rejected, acpMethod: "session/prompt" })).toBe(128);
    if (process.env.MURAGE_EVIDENCE_DIR) writeFileSync(join(process.env.MURAGE_EVIDENCE_DIR, "w3-capture.json"), JSON.stringify({ version: version.version, counts: requests.map(r => r.tools.length), methods, stopReason: finalReply.msg.result.stopReason, rejection: `tools: array too long. Expected an array with maximum length 128, but got ${requests[0].tools.length}.`, learned: await new ToolLimitStore(join(NATIVE_DIR, "opencode-tool-limits.json")).get(key), terminal, notices: events.events.filter(e => e.type === "item.started" && e.itemId?.startsWith("tool-limit-")) }, null, 2));
    const last = requests[1].messages.at(-1);
    expect(last.content).toContain("Murage is sending the previous message again after the provider rejected the tool count.");
    expect(requests[1].messages.filter((m: any) => m.role === "user")).toHaveLength(2);
    const visible = requests[1].tools.map((t: any) => t.function.name);
    for (const control of controls) expect(visible).toContain(`agents_${control}`);
    expect(events.events.filter(e => e.type === "item.started" && e.itemId?.startsWith("tool-limit-"))).toHaveLength(1);
  } finally { events.stop(); await instance.dispose(); await new Promise<void>(r => server.close(() => r())); }
}, 120000);

it("P-3 pinned fixture with a refusing catalog stub: tools/list gets exactly the publication envelope then certifies; a refused notify-1 leaves the process serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "c11-p3-"));
  let refuse = 0, stub: ReturnType<typeof createServer> | undefined, active: ReturnType<typeof connection> | undefined, child: ChildProcessWithoutNullStreams | undefined;
  const run = async (marker: string, extra: Record<string, string>) => {
    stub = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      const url = req.url ?? "";
      const ok = refuse > 0 ? (refuse--, false) : req.headers.authorization === "Bearer turn-token-0123" && publishCloudMcpCatalog(url.split("/").at(-1)!, "owner-thread", JSON.parse(body));
      res.writeHead(ok ? 200 : 403, { "content-type": "application/json" }); res.end("{}");
    });
    await new Promise<void>(r => stub!.listen(0, "127.0.0.1", r));
    const url = registerCloudMcpCatalog(marker, "owner-thread", `http://127.0.0.1:${(stub.address() as { port: number }).port}`);
    child = spawn(process.execPath, ["--experimental-strip-types", fixture], { env: { PATH: process.env.PATH!, MURAGE_MCP_LISTED_FILE: marker, MURAGE_MCP_LISTED_URL: url, MURAGE_MCP_TOKEN: "turn-token-0123", FIXTURE_TOOLS: JSON.stringify(["a", "b"]), ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    active = connection(child);
    expect((await active.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} })).error).toBeUndefined();
  };
  const stop = async () => { await active?.close(); await new Promise<void>(r => stub ? stub.close(() => r()) : r()); stub = undefined; };
  try {
    // (i) the list whose request publication is refused, then the next list
    const markerI = join(root, "generation.i");
    await run(markerI, {});
    refuse = 1;
    expect(await active!.rpc("tools/list", {})).toEqual(publicationFailureFrame(2));
    const next = await active!.rpc("tools/list", {});
    expect(next).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: ["a", "b"].map(name => ({ name, description: "Offline fixture tool", inputSchema: { type: "object", properties: {} } })) } });
    await expect.poll(() => readMcpCatalog(markerI)).toMatchObject({ complete: true, tools: ["a", "b"] });
    expect(child!.exitCode).toBeNull();
    await stop();
    // (ii) a list_changed notification whose publication is refused
    const control = join(root, "control"); mkdirSync(control);
    await run(join(root, "generation.ii"), { FIXTURE_REFRESH_DIR: control });
    refuse = 1;
    writeFileSync(join(control, "notify-1"), "");
    await expect.poll(() => refuse).toBe(0);
    const answered = await active!.rpc("tools/call", { name: "x" });
    expect(answered).toMatchObject({ id: 2, error: { code: -32601, message: "Fixture method unavailable" } });
    expect(child!.exitCode).toBeNull();
  } finally { await stop(); }
}, 30_000);
