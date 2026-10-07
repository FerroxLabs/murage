import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cdpUrlFromReply, startTargetGuard } from "./headless-target-guard.ts";
import { closeHeadlessAuthority, createHeadlessAuthorityReader, createHeadlessBrowserProxy, startHeadlessEngine } from "./headless-browser-proxy.ts";

const spec = { command: "/fixture/engine", args: ["mcp"], env: { AGENT_BROWSER_SESSION: "owned", AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64) } };
const call = { id: 1, method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://example.com" } } };
function fixture(authorize = vi.fn(async () => ({ spec, held: false }))) {
  const request = vi.fn(async (method: string) => method === "tools/list"
    ? { tools: [{ name: "agent_browser_open", inputSchema: { properties: { extraArgs: {} } } }, { name: "agent_browser_eval" }] }
    : { content: [{ type: "text", text: "fixture page" }] });
  const close = vi.fn(async () => {});
  const closeSession = vi.fn(async () => {});
  const start = vi.fn(() => ({ request, close }));
  const proxy = createHeadlessBrowserProxy({ authorize, start, closeSession });
  return { proxy, authorize, start, request, close, closeSession };
}
describe("headless MCP scope", () => {
  it("validates scope before spawning and publishes only owned schemas", async () => {
    const f = fixture();
    const denied = await f.proxy.handle({ ...call, params: { ...call.params, arguments: { url: "https://example.com", extraArgs: ["--session", "other"] } } });
    expect(denied).toMatchObject({ result: { isError: true } });
    expect(f.start).not.toHaveBeenCalled();
    const listed = await f.proxy.handle({ id: 2, method: "tools/list" }) as any;
    expect(listed.result.tools).toHaveLength(1);
    expect(listed.result.tools[0].inputSchema.additionalProperties).toBe(false);
    expect(listed.result.tools[0].inputSchema.properties.extraArgs).toBeUndefined();
    await f.proxy.close();
  });
  it("refuses human-held or unavailable authority before any engine starts", async () => {
    for (const authorize of [async () => ({ spec, held: true }), async () => { throw new Error("private-token"); }]) {
      const f = fixture(vi.fn(authorize));
      expect(await f.proxy.handle(call)).toMatchObject({ result: { isError: true } });
      expect(f.start).not.toHaveBeenCalled();
      await f.proxy.close();
      expect(f.closeSession).not.toHaveBeenCalled();
    }
  });
  it("rechecks cancellation after initialization before issuing a browser action", async () => {
    let checks = 0;
    const f = fixture(vi.fn(async () => {
      if (++checks > 1) throw new Error("revoked");
      return { spec, held: false };
    }));
    expect(await f.proxy.handle(call)).toMatchObject({ result: { isError: true } });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
    await f.proxy.close();
  });
  it("withholds an in-flight result after revocation or changed installation spec", async () => {
    let checks = 0;
    const f = fixture(vi.fn(async () => ({ spec: ++checks === 3 ? { ...spec, env: { ...spec.env, AGENT_BROWSER_SESSION: "other" } } : spec, held: false })));
    const result = await f.proxy.handle(call);
    expect(result).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(result)).not.toContain("fixture page");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "tools/call"]);
    await f.proxy.close();
  });
  it("closes one exact owned child/session and never starts work after close", async () => {
    const f = fixture();
    expect(await f.proxy.handle(call)).toMatchObject({ result: { content: [{ text: "fixture page" }] } });
    await Promise.all([f.proxy.close(), f.proxy.close()]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.closeSession).toHaveBeenCalledExactlyOnceWith(spec);
    expect(await f.proxy.handle(call)).toMatchObject({ result: { isError: true } });
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("redacts child errors and engine key from results", async () => {
    const request = vi.fn(async () => ({ content: [{ type: "text", text: spec.env.AGENT_BROWSER_ENCRYPTION_KEY }] }));
    const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {} });
    expect(JSON.stringify(await proxy.handle(call))).not.toContain(spec.env.AGENT_BROWSER_ENCRYPTION_KEY);
    await proxy.close();
  });
});

describe("headless authority transport", () => {
  const env = { MURAGE_CONTROL_URL: "http://127.0.0.1:5555/api/internal/control?botId=one", MURAGE_CONTROL_TOKEN: "private", MURAGE_BOT_ID: "bot one", MURAGE_THREAD_ID: "thread/one" };
  it("uses only authenticated loopback with bound bot/thread and refuses ambiguous state", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ spec, held: false })));
    expect(await createHeadlessAuthorityReader(env, fetchImpl)()).toEqual({ spec, held: false });
    const [url, options] = fetchImpl.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/internal/headless-browser");
    expect(url.searchParams.get("threadId")).toBe("thread/one");
    expect(options.headers).toEqual({ authorization: "Bearer private" });
    expect(options.redirect).toBe("error");
    await expect(createHeadlessAuthorityReader(env, async () => new Response(JSON.stringify({ spec })))()).rejects.toThrow(/refused/u);
    expect(() => createHeadlessAuthorityReader({ ...env, MURAGE_CONTROL_URL: "https://public.example" })).toThrow(/refused/u);
  });
  it("centralizes session close through authenticated DELETE and requires a cleanup receipt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ closed: true })));
    await closeHeadlessAuthority(env, fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/internal/headless-browser");
    expect(options.method).toBe("DELETE");
    expect(options.headers).toEqual({ authorization: "Bearer private" });
    await expect(closeHeadlessAuthority(env, async () => new Response("{}", { status: 401 }))).rejects.toThrow(/refused/u);
    await expect(closeHeadlessAuthority(env, async () => new Response('{"closed":false}'))).rejects.toThrow(/refused/u);
  });
});

describe("real isolated engine subprocess", () => {
  it("uses exact environment, joins fragmented frames and confirms child close", async () => {
    const script = `let buf='';process.stdin.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){let m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);let s=JSON.stringify({id:m.id,result:{session:process.env.AGENT_BROWSER_SESSION,keys:Object.keys(process.env).sort()}});process.stdout.write(s.slice(0,8));process.stdout.write(s.slice(8)+'\\n');}});`;
    const forbiddenParent = {
      AGENT_BROWSER_CDP: "http://parent-browser.invalid",
      AGENT_BROWSER_PROFILE: "parent-private-profile",
      MURAGE_CONTROL_TOKEN: "parent-private-token",
      HEADLESS_PARENT_ONLY: "must-not-be-inherited",
    };
    const saved = Object.fromEntries(Object.keys(forbiddenParent).map(key => [key, process.env[key]]));
    Object.assign(process.env, forbiddenParent);
    try {
      // libuv supplies these required Windows variables even for env:{}:
      // https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L47-L59
      // An independent empty-env child establishes the exact subset added by
      // THIS runtime. Unknown variables are still rejected, never filtered away.
      const runtimeKeys = new Set(process.platform === "win32"
        ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]
        : process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);
      const { stdout } = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(JSON.stringify({keys:Object.keys(process.env).sort(),uv:process.versions.uv}))"], {
        env: {}, windowsHide: true, encoding: "utf8", timeout: 5000,
      });
      const control = JSON.parse(stdout) as { keys: string[]; uv: string };
      expect(control.uv).toBe(process.versions.uv);
      expect(control.keys.filter(key => !runtimeKeys.has(key))).toEqual([]);
      const client = startHeadlessEngine({ command: process.execPath, args: ["-e", script], env: { AGENT_BROWSER_SESSION: "isolated-fixture" } });
      try {
        const result = await client.request("tools/list") as { session: string; keys: string[] };
        expect(result.session).toBe("isolated-fixture");
        expect(result.keys).toEqual([...control.keys, "AGENT_BROWSER_SESSION"].sort());
        for (const key of Object.keys(forbiddenParent)) expect(result.keys).not.toContain(key);
      } finally { await client.close(); }
      await expect(client.request("tools/list")).rejects.toThrow(/refused/u);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it("withdraws a request with MCP notifications/cancelled naming its own id, and still waits for the peer", async () => {
    // The peer answers the withdrawn call only when the cancel arrives, and
    // echoes both the id it was working on and the notification it received.
    const script = `let buf='',held;process.stdin.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(m.method==='tools/call'&&m.params.name==='slow'){held=m.id;continue;}if(m.method==='notifications/cancelled'){process.stdout.write(JSON.stringify({id:held,result:{held,cancel:m}})+'\\n');continue;}if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});`;
    const client = startHeadlessEngine({ command: process.execPath, args: ["-e", script], env: {} });
    try {
      await client.request("initialize");
      const stop = new AbortController();
      const call = client.request("tools/call", { name: "slow" }, { signal: stop.signal });
      await new Promise(resolve => setTimeout(resolve, 50));
      stop.abort();
      const echoed = await call as { held: number; cancel: { jsonrpc: string; id?: unknown; method: string; params: { requestId: unknown; reason?: unknown } } };
      expect(echoed.cancel.method).toBe("notifications/cancelled");
      expect(echoed.cancel.jsonrpc).toBe("2.0");
      expect(echoed.cancel).not.toHaveProperty("id");
      expect(echoed.cancel.params.requestId).toBe(echoed.held);
      // A signal that is already aborted never sends the request at all.
      await expect(client.request("tools/call", { name: "slow" }, { signal: AbortSignal.abort() })).rejects.toThrow();
    } finally { await client.close(); }
  });
  it("a request with no clock (a host computer action) outlives the 60 s watchdog, and a Stop still ends it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // the peer never answers an action
    const script = `let buf='';process.stdin.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});`;
    const client = startHeadlessEngine({ command: process.execPath, args: ["-e", script], env: {} });
    try {
      await client.request("initialize");
      const stop = new AbortController();
      let settled = false;
      const call = client.request("tools/call", { name: "long" }, { signal: stop.signal, timeoutMs: null });
      const outcome = call.then(() => "resolved", () => "rejected").finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      stop.abort();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toBe("rejected");
    } finally { vi.useRealTimers(); await client.close(); }
  });
});

describe("alerts where the engine does not auto-answer (Windows)", () => {
  const winSpec = { ...spec, env: { ...spec.env, AGENT_BROWSER_NO_AUTO_DIALOG: "1" } };
  const status = (hasDialog: boolean, type = "alert") => ({ structuredContent: { response: { data: hasDialog ? { hasDialog, type, message: "m" } : { hasDialog } } }, content: [{ type: "text", text: JSON.stringify(hasDialog ? { hasDialog, type } : { hasDialog }) }] });
  function run(statuses: unknown[]) {
    const queue = [...statuses];
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "tools/call" && params?.name === "agent_browser_dialog_status") return queue.shift() ?? status(false);
      return { content: [{ type: "text", text: "fixture page" }] };
    });
    const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec: winSpec, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {} });
    return { proxy, request, names: () => request.mock.calls.filter(([m]) => m === "tools/call").map(([, p]) => (p as { name: string }).name) };
  }
  it("accepts an alert the click opened, then returns the click result", async () => {
    const f = run([status(false), status(true, "alert"), status(false)]);
    expect(await f.proxy.handle({ ...call, params: { name: "agent_browser_open", arguments: { url: "https://example.com" } } })).toMatchObject({ result: { content: [{ text: "fixture page" }] } });
    expect(f.names()).toEqual(["agent_browser_dialog_status", "agent_browser_open", "agent_browser_dialog_status", "agent_browser_dialog_accept", "agent_browser_dialog_status"]);
    await f.proxy.close();
  });
  it("never asks about dialogs when the engine answers them itself", async () => {
    const f = fixture();
    await f.proxy.handle(call);
    expect(f.request.mock.calls.map(([m]) => m)).toEqual(["initialize", "tools/call"]);
    await f.proxy.close();
  });
});

describe("closing the engine child", () => {
  it("does not wait for a daemon that still holds the stdio pipes", async () => {
    // the child exits at once; a grandchild keeps its inherited stdout open for 30 s, like the engine's daemon
    const script = `require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:["ignore","inherit","inherit"],detached:true}).unref();process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.exit(0));`;
    const client = startHeadlessEngine({ command: process.execPath, args: ["-e", script], env: {} });
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("beforeunload guard for tabs opened later (Windows)", () => {
  const winSpec = { ...spec, env: { ...spec.env, AGENT_BROWSER_NO_AUTO_DIALOG: "1" } };
  const cdpReply = { content: [{ type: "text", text: JSON.stringify({ cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }) }] };
  function guarded(startGuard: (url: string, source: string) => Promise<{ close: () => void; installed: (id: string) => Promise<boolean>; alive: () => boolean }>, url: string | undefined = "ws://127.0.0.1:9222/devtools/browser/abc") {
    const request = vi.fn(async (_m: string, _p?: Record<string, unknown>) => ({ content: [{ type: "text", text: "page" }] }));
    const cdpUrl = vi.fn(async () => url);
    const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec: winSpec, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {}, startTargetGuard: startGuard, cdpUrl });
    return { proxy, request, cdpUrl, names: () => request.mock.calls.filter(([m]) => m === "tools/call").map(([, p]) => (p as { name: string }).name) };
  }
  it("opens the guard once after the first call, keeps it for the turn, and closes it with the proxy", async () => {
    const close = vi.fn();
    const start = vi.fn(async (_url: string, _source: string) => ({ close, installed: async () => true, alive: () => true }));
    const f = guarded(start);
    await f.proxy.handle(call); await f.proxy.handle({ ...call, id: 2 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(f.cdpUrl).toHaveBeenCalledTimes(1);
    expect(f.names()).not.toContain("agent_browser_get_cdp_url");
    await f.proxy.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("never starts where the engine answers dialogs itself, and survives an unavailable guard", async () => {
    const start = vi.fn(async () => ({ close: () => {}, installed: async () => true, alive: () => true }));
    const plain = fixture();
    await plain.proxy.handle(call);
    expect(start).not.toHaveBeenCalled();
    expect(plain.request.mock.calls.map(([m]) => m)).toEqual(["initialize", "tools/call"]);
    const failing = guarded(async () => { throw new Error("no socket"); });
    expect(await failing.proxy.handle(call)).toMatchObject({ result: { content: [{ text: "page" }] } });
    for (let i = 0; i < 5; i++) await failing.proxy.handle(call);
    expect(failing.cdpUrl).toHaveBeenCalledTimes(3);
    await failing.proxy.close();
  });
  it("creates a tab with a URL blank, waits for the guard on it, then opens the page", async () => {
    const order: string[] = [];
    const installed = vi.fn(async (id: string) => { order.push(`installed ${id}`); return true; });
    const f = guarded(async () => ({ close: () => {}, installed, alive: () => true }));
    const request = f.request;
    request.mockImplementation(async (_m: string, p?: Record<string, unknown>) => {
      order.push(`${String(p?.name)} ${JSON.stringify(p?.arguments)}`);
      return p?.name === "agent_browser_tab_new" ? { content: [{ type: "text", text: JSON.stringify({ tabId: "t2", targetId: "ABCDEF0123456789ABCDEF0123456789" }) }] } : { content: [{ type: "text", text: "page" }] };
    });
    await f.proxy.handle(call);
    order.length = 0;
    await f.proxy.handle({ id: 5, method: "tools/call", params: { name: "agent_browser_tab_new", arguments: { url: "https://example.com/a", label: "x" } } });
    const calls = order.filter((o) => !o.startsWith("agent_browser_dialog_status"));
    expect(calls).toEqual([
      'agent_browser_tab_new {"label":"x"}',
      "installed ABCDEF0123456789ABCDEF0123456789",
      'agent_browser_open {"url":"https://example.com/a"}',
    ]);
    await f.proxy.close();
  });
  it("after the guard's connection dies, tries one reconnect and then stops paying for it", async () => {
    let alive = true;
    const guards: Array<{ alive: () => boolean }> = [];
    const f = guarded(async () => { const g = { close: () => {}, installed: async () => true, alive: () => alive }; guards.push(g); return g; });
    await f.proxy.handle(call);
    expect(guards).toHaveLength(1);
    alive = false;
    for (let i = 0; i < 4; i++) await f.proxy.handle({ id: 6 + i, method: "tools/call", params: { name: "agent_browser_tab_new", arguments: { url: "https://example.com/a" } } });
    expect(f.cdpUrl).toHaveBeenCalledTimes(2); // the first connect and one reconnect, which itself came back dead
    expect(guards).toHaveLength(2);
    await f.proxy.close();
  });
  it("refuses a tool outside the list with its own plain message", async () => {
    const f = guarded(async () => ({ close: () => {}, installed: async () => true, alive: () => true }));
    const reply = await f.proxy.handle({ id: 9, method: "tools/call", params: { name: "agent_browser_get_html", arguments: { selector: "a" } } }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(reply.result).toEqual({ isError: true, content: [{ type: "text", text: "That browser tool is not available to bots." }] });
    await f.proxy.close();
  });
  it("leaves tab_new alone when no guard is running", async () => {
    const f = guarded(async () => { throw new Error("no socket"); });
    await f.proxy.handle({ id: 5, method: "tools/call", params: { name: "agent_browser_tab_new", arguments: { url: "https://example.com/a" } } });
    expect(f.request.mock.calls.filter(([, p]) => (p as { name?: string } | undefined)?.name === "agent_browser_tab_new").map(([, p]) => (p as { arguments: object }).arguments)).toEqual([{ url: "https://example.com/a" }]);
    await f.proxy.close();
  });
  it("accepts only a loopback browser endpoint", () => {
    expect(cdpUrlFromReply("ws://127.0.0.1:9222/devtools/browser/abc\n")).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(cdpUrlFromReply(cdpReply)).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(cdpUrlFromReply({ content: [{ text: "ws://evil.example/devtools/browser/x" }] })).toBeUndefined();
    expect(cdpUrlFromReply({ content: [{ text: "no endpoint" }] })).toBeUndefined();
  });
  it("pauses nothing: installs the script on each new page target before resuming it, and resumes other targets", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const log: Array<{ method: string; sessionId?: string; params: any }> = [];
    server.on("connection", (ws) => ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      log.push({ method: m.method, sessionId: m.sessionId, params: m.params });
      ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === "Target.setAutoAttach") {
        ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S-page", waitingForDebugger: true, targetInfo: { type: "page" } } }));
        ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S-worker", waitingForDebugger: true, targetInfo: { type: "service_worker" } } }));
      }
    }));
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as { port: number };
    const guard = await startTargetGuard(`ws://127.0.0.1:${port}/devtools/browser/x`, "GUARD_SOURCE");
    for (let i = 0; i < 50 && log.filter((l) => l.method === "Runtime.runIfWaitingForDebugger").length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    guard.close();
    server.close();
    expect(log[0]).toMatchObject({ method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    const page = log.filter((l) => l.sessionId === "S-page").map((l) => l.method);
    expect(page).toEqual(["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger"]);
    expect(log.find((l) => l.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source).toBe("GUARD_SOURCE");
    expect(log.filter((l) => l.sessionId === "S-worker").map((l) => l.method)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });
});

describe("the model-facing tool list is fixed", () => {
  const CORE_27 = ["open", "read", "snapshot", "click", "fill", "type", "press", "check", "uncheck", "select", "scroll", "wait_ms", "wait_for_selector", "wait_for_text", "wait_for_load", "screenshot", "get_text", "get_url", "get_title", "close", "back", "forward", "reload", "tab_new", "tab_list", "tab_switch", "tab_close"].map((n) => `agent_browser_${n}`);
  // what an engine started with --tools all (or anything wider) would offer, and the narrower profiles
  const upstream = [...CORE_27, "dblclick", "focus", "get_attr", "get_box", "get_count", "get_html", "get_styles", "get_value", "hover", "is_checked", "is_enabled", "is_visible", "keyboard_insert_text", "keyboard_type", "keydown", "keyup", "scroll_into_view", "wait_for_url", "eval", "get_cdp_url", "dialog_accept"].map((n) => n.startsWith("agent_browser_") ? n : `agent_browser_${n}`);
  for (const platform of ["win32", "darwin", "linux"] as const) {
    it(`lists exactly the 27 core tools on ${platform}, and refuses the rest`, async () => {
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        const env = platform === "win32" ? { ...spec.env, AGENT_BROWSER_NO_AUTO_DIALOG: "1" } : spec.env;
        const request = vi.fn(async (method: string, params?: Record<string, unknown>) => method === "tools/list" ? { tools: upstream.map((name) => ({ name })) } : { content: [{ type: "text", text: `ran ${String(params?.name)}` }] });
        const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec: { ...spec, env }, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {}, cdpUrl: async () => undefined });
        const listed = await proxy.handle({ id: 1, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
        expect(listed.result.tools.map((t) => t.name).sort()).toEqual([...CORE_27].sort());
        for (const name of ["agent_browser_get_html", "agent_browser_dblclick", "agent_browser_eval", "agent_browser_get_cdp_url", "agent_browser_dialog_accept"]) {
          expect(await proxy.handle({ id: 2, method: "tools/call", params: { name, arguments: { selector: "a" } } })).toMatchObject({ result: { isError: true } });
          expect(request.mock.calls.some(([, p]) => (p as { name?: string } | undefined)?.name === name)).toBe(false);
        }
        expect(await proxy.handle({ id: 3, method: "tools/call", params: { name: "agent_browser_tab_new", arguments: { url: "https://example.com" } } })).toMatchObject({ result: { content: [{ text: "ran agent_browser_tab_new" }] } });
        await proxy.close();
      } finally { Object.defineProperty(process, "platform", real); }
    });
  }
});
