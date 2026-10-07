// DRV contract: the mounted stdio proxy must defer extension floor decisions to
// the executor, preserve refusals, and retain built-in preflight by default.
// Isolated loopback route + real executor; declared CDP/engine fixture, no Chrome.
// C2 owns the production mount: MURAGE_BROWSER_TRANSPORT: "extension".
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserExtensionExecutor, type ExtensionDocument, type ExtensionExecutorOptions } from "../browser-extension-executor.ts";
import type { FloorFacts } from "../browser-floor.ts";
import { COMPOSED_ACTIVE_SOURCE, COMPOSED_HIT_TEST_SOURCE, DESCRIBE_TARGET_SOURCE } from "../browser-extension-page-scripts.ts";

const proxyPath = fileURLToPath(new URL("./unified-browser-proxy.ts", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function mount(dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const names: string[] = [];
  const server: Server = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      expect(new URL(req.url!, "http://127.0.0.1").pathname).toBe("/api/internal/unified-browser");
      let body = "";
      for await (const part of req) body += part;
      const rpc = JSON.parse(body);
      names.push(rpc.params.name);
      const result = await dispatch(rpc.params.name, rpc.params.arguments ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const failure = error as Error & { code?: string };
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: failure.message, code: failure.code }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    names,
    async exchange(calls: Array<{ name: string; arguments: Record<string, unknown> }>, transport?: string) {
      const child = spawn(process.execPath, [proxyPath], {
        env: { PATH: process.env.PATH, MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "bot", MURAGE_THREAD_ID: "thread", ...(transport ? { MURAGE_BROWSER_TRANSPORT: transport } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
      child.stdin.end(calls.map((params, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }) + "\n").join(""));
      expect(await closed, stderr).toBe(0);
      const replies = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(replies).toHaveLength(calls.length);
      return replies;
    },
  };
}

function executorFixture(facts: Partial<FloorFacts> = {}) {
  const document: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" };
  const effects: string[] = [];
  const resolveTarget = vi.fn(async (_selector: string) => ({ backendNodeId: 12, document }));
  const collector = vi.fn<NonNullable<ExtensionExecutorOptions["collectFacts"]>>(async (_io, _target, operation, extra) => {
    if (facts.factsFailed) throw new Error("Fixture collector unavailable");
    return { operation, tag: "button", role: "button", name: "Next", ...extra, ...facts };
  });
  const executor = new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async () => true, collectFacts: collector,
    transport: {
      document: async () => ({ ...document }),
      async send(method, params) {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "loader" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12, nodeName: "BUTTON" } };
        if (method === "Runtime.evaluate") return params.returnByValue === false ? { result: { objectId: "target" } } : { result: { type: "boolean", value: false } };
        if (method === "Runtime.callFunctionOn") {
          if (params.functionDeclaration === COMPOSED_ACTIVE_SOURCE) return { result: { objectId: "target" } };
          if (params.functionDeclaration === COMPOSED_HIT_TEST_SOURCE) return { result: { value: true } };
          if (params.functionDeclaration === DESCRIBE_TARGET_SOURCE) return { result: { value: JSON.stringify({ display: { tag: "button", label: "Next" }, bound: {} }) } };
        }
        // Round 8/9 closed-root check: the browser's own tree, here a plain document with no closed root.
        if (method === "DOM.enable") return {};
        if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: "#document", children: [] } };
        if (["Page.enable", "Page.addScriptToEvaluateOnNewDocument"].includes(method)) return {};
        throw new Error(`Undeclared fixture command: ${method}`);
      },
    },
    createEngine: hooks => ({
      resolveTarget, resolveTab: async () => document, event() {}, async close() {},
      async call(name, args) {
        // Deliberately stale snapshot words: the server collector judges the current node.
        if (name === "agent_browser_snapshot") return { content: [{ type: "text", text: '- button "Verify you are human" [ref=e1]' }] };
        const method = name === "agent_browser_click" ? "Input.dispatchMouseEvent" : "Input.dispatchKeyEvent";
        await hooks.beforeCommand(document, method, name === "agent_browser_click" ? { type: "mousePressed", x: 20, y: 30 } : { type: "keyDown", key: args.key });
        effects.push(name);
        return { content: [{ type: "text", text: "Fixture action completed" }] };
      },
    }),
  });
  cleanup.push(() => executor.close());
  return { executor, collector, effects, resolveTarget };
}

it.each([
  ["CSS selector", [{ name: "agent_browser_click", arguments: { selector: "#next" } }]],
  ["snapshot ref", [{ name: "agent_browser_snapshot", arguments: {} }, { name: "agent_browser_click", arguments: { selector: "@e1" } }]],
  ["focused key", [{ name: "agent_browser_press", arguments: { key: "Enter" } }]],
] as const)("extension mount sends a %s to the executor without get_html", async (_label, calls) => {
  const f = executorFixture();
  const proxy = await mount((name, args) => f.executor.call(name, args));
  const replies = await proxy.exchange([...calls], "extension");
  expect(replies.at(-1).result.content[0].text).toBe("Fixture action completed");
  expect(f.effects).toEqual([calls.at(-1)!.name]);
  expect(proxy.names).toEqual(calls.map(call => call.name));
  expect(proxy.names).not.toContain("agent_browser_get_html");
  expect(f.collector).toHaveBeenCalledTimes(3); // round 8: the target is described and the floor re-run again before the press
  expect(f.collector.mock.calls[0][1]).toMatchObject({ backendNodeId: 12 });
});

it.each([{ name: "Verify you are human" }, { factsFailed: true }])("extension collector hands control to the owner on %j", async facts => {
  const f = executorFixture(facts);
  const proxy = await mount((name, args) => f.executor.call(name, args));
  const [reply] = await proxy.exchange([{ name: "agent_browser_click", arguments: { selector: "#next" } }], "extension");
  expect(reply.result).toMatchObject({ isError: true, code: "browser_extension_refused" });
  expect(reply.result.content[0].text).toMatch(/^YOUR TURN:/);
  expect(f.collector).toHaveBeenCalledOnce();
  expect(f.effects).toEqual([]);
  expect(proxy.names).toEqual(["agent_browser_click"]);
});

it.each([undefined, "builtin"])("built-in mount (%s) still reads the target before a click", async transport => {
  const proxy = await mount(async name => ({ content: [{ type: "text", text: name === "agent_browser_get_html" ? '<button type="button">Next</button>' : "Clicked" }] }));
  const [reply] = await proxy.exchange([{ name: "agent_browser_click", arguments: { selector: "#next" } }], transport);
  expect(proxy.names).toEqual(["agent_browser_get_html", "agent_browser_click"]);
  expect(reply.result.content[0].text).toBe("Clicked");
});

it("built-in mount stops an unreadable target before execution", async () => {
  const proxy = await mount(async () => { throw new Error("fixture read unavailable"); });
  const [reply] = await proxy.exchange([{ name: "agent_browser_click", arguments: { selector: "#next" } }]);
  expect(reply.result.content[0].text).toMatch(/^YOUR TURN:/);
  expect(proxy.names).toEqual(["agent_browser_get_html"]);
});
