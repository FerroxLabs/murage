import { describe, expect, it, vi } from "vitest";
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
    const client = startHeadlessEngine({ command: process.execPath, args: ["-e", script], env: { AGENT_BROWSER_SESSION: "isolated-fixture" } });
    try {
      const result = await client.request("tools/list") as { session: string; keys: string[] };
      expect(result.session).toBe("isolated-fixture");
      // macOS adds this locale variable inside the runtime even when spawn
      // receives an exact env. It is not a leaked parent browser setting.
      expect(result.keys.filter((key) => process.platform !== "darwin" || key !== "__CF_USER_TEXT_ENCODING")).toEqual(["AGENT_BROWSER_SESSION"]);
      expect(result.keys).not.toContain("AGENT_BROWSER_CDP");
      expect(result.keys).not.toContain("AGENT_BROWSER_PROFILE");
      expect(result.keys).not.toContain("MURAGE_CONTROL_TOKEN");
    } finally { await client.close(); }
    await expect(client.request("tools/list")).rejects.toThrow(/refused/u);
  });
});
