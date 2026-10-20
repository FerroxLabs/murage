import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOX_RELAY_FRAME_PATH, BOX_RELAY_MAX_FRAME_BYTES, BOX_RELAY_MAX_JSON_BYTES, BOX_RELAY_MAX_REQUEST_BYTES,
  BOX_RELAY_PREFIX, cloudBoxComputersAllowed, cloudBoxRelayEnv, isCloudHome, relayBoxCall,
  type BoxRelayDeps, type BoxRelayInput,
} from "./box-relay.ts";
import { computerProxyEnv } from "./container-computer.ts";
import { antigravityComputerMcpServer } from "./drivers/antigravity.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";

const REAL_KEY = "box_live_ACCOUNTKEY_do_not_leak";
const BOX = "bx_mine";
const CONTROL = { url: "http://127.0.0.1:8799/api/internal/computer-control?botId=bot-a", token: "" };

function rig(over: Partial<BoxRelayDeps> = {}) {
  const caps = new InternalCapabilities();
  caps.begin("bot-a", "thread-a", "gen-a");
  const token = caps.mint({ botId: "bot-a", threadId: "thread-a", generation: "gen-a", kind: "computer", depth: 0, skillAuthoring: false });
  caps.begin("bot-b", "thread-b", "gen-b");
  const otherToken = caps.mint({ botId: "bot-b", threadId: "thread-b", generation: "gen-b", kind: "computer", depth: 0, skillAuthoring: false });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const upstream = vi.fn(async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout: "hi" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const logs: string[] = [];
  const deps: BoxRelayDeps = {
    resolveClaim: (h) => caps.resolve(h),
    isActive: (c) => caps.isActive(c),
    boundBoxId: (bot) => (bot === "bot-a" ? BOX : "bx_theirs"),
    accountToken: () => REAL_KEY,
    enabled: () => true,
    upstreamBase: "https://ascii.test/api/box/v1",
    fetch: upstream as unknown as typeof fetch,
    log: (l) => logs.push(l),
    ...over,
  };
  const call = (input: Partial<BoxRelayInput> & { path: string }) =>
    relayBoxCall({
      method: "GET", search: "", authorization: `Bearer ${token}`,
      readJson: async () => ({}), ...input, pathname: `${BOX_RELAY_PREFIX}${input.path}`,
    }, deps);
  return { call, calls, logs, token, otherToken, upstream, deps };
}
const cmd = (command = "echo hi") => ({ method: "POST", path: `/boxes/${BOX}/commands`, readJson: async () => ({ command }) });
const FRAME_Q = `path=${encodeURIComponent(BOX_RELAY_FRAME_PATH)}`;

describe("box relay", () => {
  it("rejects a missing, wrong or non-hex token with 401 and never calls upstream", async () => {
    const r = rig();
    for (const authorization of [undefined, `Bearer ${"0".repeat(48)}`, "Bearer nope", r.token]) {
      expect((await r.call({ ...cmd(), authorization })).status).toBe(401);
    }
    expect(r.upstream).not.toHaveBeenCalled();
  });

  it("refuses a token of another capability kind", async () => {
    const caps = new InternalCapabilities();
    caps.begin("bot-a", "t", "g");
    const agents = caps.mint({ botId: "bot-a", threadId: "t", generation: "g", kind: "agents", depth: 0, skillAuthoring: false });
    const r = rig({ resolveClaim: (h) => caps.resolve(h), isActive: (c) => caps.isActive(c) });
    expect((await r.call({ ...cmd(), authorization: `Bearer ${agents}` })).status).toBe(404);
    expect(r.upstream).not.toHaveBeenCalled();
  });

  it("answers 404 with no detail for another bot's box id", async () => {
    const r = rig();
    const res = await r.call({ method: "POST", path: "/boxes/bx_theirs/commands", readJson: async () => ({ command: "id" }) });
    expect(res.status).toBe(404);
    expect(res.body.toString()).toBe(JSON.stringify({ error: "not found" }));
    expect(r.upstream).not.toHaveBeenCalled();
    expect(r.logs).toEqual(["box relay refused bot=bot-a reason=other-box"]);
    // the bot B token cannot reach bot A's box either
    expect((await r.call({ ...cmd(), authorization: `Bearer ${r.otherToken}` })).status).toBe(404);
  });

  it("allows only the five known method+path shapes", async () => {
    const r = rig();
    const refused: Array<[string, string, string?]> = [
      ["POST", "/boxes"], ["GET", "/boxes"], ["DELETE", `/boxes/${BOX}`], ["POST", `/boxes/${BOX}`],
      ["PUT", `/boxes/${BOX}/commands`], ["GET", `/boxes/${BOX}/commands`], ["POST", `/boxes/${BOX}/stop`],
      ["POST", `/boxes/${BOX}/archive`], ["GET", `/boxes/${BOX}/billing`], ["GET", "/account"], ["GET", "/me"],
      ["POST", `/boxes/${BOX}/resume/extra`], ["GET", `/boxes/${BOX}/files`], ["GET", `/boxes/${BOX}/artifacts`, "path=%2Fetc%2Fpasswd"],
      ["GET", `/boxes/${BOX}/files`, `${FRAME_Q}&encoding=utf8`], ["GET", `/boxes/${BOX}/artifacts`, `${FRAME_Q}&x=1`],
      ["GET", `/boxes/${BOX}/../boxes`], ["GET", `/boxes/${BOX}%2F..`],
    ];
    for (const [method, path, search] of refused) {
      expect((await r.call({ method, path, search: search ?? "" })).status, `${method} ${path}`).toBe(404);
    }
    expect(r.upstream).not.toHaveBeenCalled();
    const allowed: Array<[string, string, string?]> = [
      ["POST", `/boxes/${BOX}/resume`], ["GET", `/boxes/${BOX}`], ["POST", `/boxes/${BOX}/commands`],
      ["GET", `/boxes/${BOX}/artifacts`, FRAME_Q], ["GET", `/boxes/${BOX}/files`, `${FRAME_Q}&encoding=base64`],
    ];
    for (const [method, path, search] of allowed) {
      const res = await r.call({ method, path, search: search ?? "", readJson: async () => ({ command: "ls" }) });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(r.upstream).toHaveBeenCalledTimes(5);
  });

  it("replaces the caller's Authorization with the real key and forwards no cookies or hop-by-hop headers", async () => {
    const r = rig();
    await r.call(cmd("uname"));
    const [{ url, init }] = r.calls;
    expect(url).toBe(`https://ascii.test/api/box/v1/boxes/${BOX}/commands`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBe(JSON.stringify({ command: "uname" }));
    expect(init.headers).toEqual({ authorization: `Bearer ${REAL_KEY}`, "content-type": "application/json" });
    expect(JSON.stringify(init.headers)).not.toContain(r.token);
  });

  it("round-trips an allowed call and the upstream status (409 wake signal included)", async () => {
    const r = rig({ fetch: (async () => new Response('{"code":"machine_not_running"}', { status: 409, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    const res = await r.call(cmd());
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body.toString())).toEqual({ code: "machine_not_running" });
    expect(res.contentType).toBe("application/json");
    const ok = rig();
    expect(JSON.parse((await ok.call(cmd())).body.toString())).toEqual({ ok: true, exitCode: 0, stdout: "hi" });
  });

  it("refuses an oversized body (413), a body with extra fields, and never forwards them", async () => {
    const r = rig();
    const big = await r.call({ ...cmd(), readJson: async () => { throw Object.assign(new Error("body too large"), { status: 413 }); } });
    expect(big.status).toBe(413);
    let asked = 0;
    await r.call({ ...cmd(), readJson: async (max) => { asked = max; return { command: "x" }; } });
    expect(asked).toBe(BOX_RELAY_MAX_REQUEST_BYTES);
    expect((await r.call({ ...cmd(), readJson: async () => ({ command: "x".repeat(BOX_RELAY_MAX_REQUEST_BYTES) }) })).status).toBe(413);
    expect((await r.call({ ...cmd(), readJson: async () => ({ command: "x", env: {} }) })).status).toBe(404);
    expect((await r.call({ ...cmd(), readJson: async () => ({}) })).status).toBe(404);
    expect(r.upstream).toHaveBeenCalledTimes(1);
  });

  it("caps the response size", async () => {
    const huge = new Uint8Array(BOX_RELAY_MAX_JSON_BYTES + 1);
    const r = rig({ fetch: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch });
    expect((await r.call(cmd())).status).toBe(502);
    const frame = new Uint8Array(BOX_RELAY_MAX_JSON_BYTES + 10);
    const f = rig({ fetch: (async () => new Response(frame, { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch });
    const ok = await f.call({ path: `/boxes/${BOX}/artifacts`, search: FRAME_Q });
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBe(frame.length);
    expect(BOX_RELAY_MAX_FRAME_BYTES).toBeGreaterThan(BOX_RELAY_MAX_JSON_BYTES);
    const tooBig = rig({ fetch: (async () => new Response(new Uint8Array(BOX_RELAY_MAX_FRAME_BYTES + 1), { status: 200 })) as unknown as typeof fetch });
    expect((await tooBig.call({ path: `/boxes/${BOX}/artifacts`, search: FRAME_Q })).status).toBe(502);
  });

  it("follows a download redirect only on the provider's host and never sends the key elsewhere", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const mk = (location: string) => (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization });
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("jpg", { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const same = rig({ fetch: mk("https://files.ascii.test/dl/abc") });
    expect((await same.call({ path: `/boxes/${BOX}/artifacts`, search: FRAME_Q })).status).toBe(200);
    expect(seen[1]).toEqual({ url: "https://files.ascii.test/dl/abc", auth: undefined });
    seen.length = 0;
    const foreign = rig({ fetch: mk("https://bucket.s3.amazonaws.com/x?sig=1") });
    expect((await foreign.call({ path: `/boxes/${BOX}/artifacts`, search: FRAME_Q })).status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("is a 404 when hosted computers are off, and when no key is configured", async () => {
    expect((await rig({ enabled: () => false }).call(cmd())).status).toBe(404);
    expect((await rig({ accountToken: () => undefined }).call(cmd())).status).toBe(404);
  });

  it("logs refusals without bodies or the key", async () => {
    const r = rig();
    await r.call({ method: "DELETE", path: `/boxes/${BOX}`, readJson: async () => ({ command: REAL_KEY }) });
    expect(r.logs.join("\n")).not.toContain(REAL_KEY);
    expect(r.logs).toHaveLength(1);
  });
});

describe("cloud-home turn env", () => {
  const computer = { kind: "box" as const, boxId: BOX, token: REAL_KEY, control: { url: CONTROL.url, token: "c".repeat(48) } };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("computerProxyEnv never contains the account key on a cloud home and points at the relay", () => {
    const env = computerProxyEnv(computer, { MURAGE_CLOUD_ROLE: "home" });
    expect(JSON.stringify(env)).not.toContain(REAL_KEY);
    expect(env).toEqual({
      MURAGEBOX_BOX_ID: BOX,
      MURAGEBOX_BOX_API: "http://127.0.0.1:8799/api/internal/box/v1",
      MURAGEBOX_BOX_TOKEN: "c".repeat(48),
      MURAGE_CONTROL_URL: CONTROL.url,
      MURAGE_CONTROL_TOKEN: "c".repeat(48),
    });
    // a computer with no control channel gets nothing usable, still not the key
    expect(JSON.stringify(computerProxyEnv({ boxId: BOX, token: REAL_KEY }, { MURAGE_CLOUD_ROLE: "home" }))).not.toContain(REAL_KEY);
    expect(cloudBoxRelayEnv(undefined).MURAGEBOX_BOX_TOKEN).toBe("");
  });

  it("the Antigravity builder carries the relay env, not the key, on a cloud home", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const spec = antigravityComputerMcpServer({ computer })!;
    expect(JSON.stringify(spec)).not.toContain(REAL_KEY);
    expect(spec.env).toMatchObject({ MURAGEBOX_BOX_API: "http://127.0.0.1:8799/api/internal/box/v1", MURAGEBOX_BOX_TOKEN: "c".repeat(48) });
  });

  it("no driver builds MURAGEBOX_BOX_TOKEN from anything but computerProxyEnv", () => {
    const dir = fileURLToPath(new URL("./drivers/", import.meta.url));
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);
    const offenders: string[] = [];
    for (const file of files(dir)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/MURAGEBOX_BOX_TOKEN\s*:/.test(line) && !/proxyEnv\.MURAGEBOX_BOX_TOKEN/.test(line)) offenders.push(`${file}: ${line.trim()}`);
        if (/computer\??\.token\b/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("boxes on a cloud home are opt-in and default off", () => {
    expect(cloudBoxComputersAllowed({})).toBe(false);
    expect(cloudBoxComputersAllowed({ features: {} })).toBe(false);
    expect(cloudBoxComputersAllowed({ features: { cloudBoxComputers: false } })).toBe(false);
    expect(cloudBoxComputersAllowed({ features: { cloudBoxComputers: true } })).toBe(true);
    expect(isCloudHome({ MURAGE_CLOUD_ROLE: "home" })).toBe(true);
    expect(isCloudHome({})).toBe(false);
  });

  it("desktop env is unchanged", () => {
    expect(computerProxyEnv({ boxId: "bx_1", token: "t" }, {})).toEqual({ MURAGEBOX_BOX_ID: "bx_1", MURAGEBOX_BOX_TOKEN: "t" });
    expect(computerProxyEnv(computer, {})).toEqual({
      MURAGEBOX_BOX_ID: BOX, MURAGEBOX_BOX_TOKEN: REAL_KEY, MURAGE_CONTROL_URL: CONTROL.url, MURAGE_CONTROL_TOKEN: "c".repeat(48),
    });
    expect(antigravityComputerMcpServer({ computer })!.env).not.toHaveProperty("MURAGEBOX_BOX_API");
  });
});

describe("turn setup wiring (index.ts)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("gates box provisioning on the opt-in and mounts no account key on a cloud home", () => {
    expect(source).toContain("const boxesAllowed = !isCloudHome() || cloudBoxComputersAllowed(cfg);");
    expect(source).toContain("if (boxesAllowed && (wants === \"cloud\" || wants === undefined) && cloudBackend === \"box\" && box.boxConfigured(cfg))");
    expect(source).toContain('token: isCloudHome() ? "" : cfg.box!.token!,');
    expect(source).toContain("cloudHomeCopy.boxComputersOff");
    expect(source).not.toContain("cloudHomeCopy.vpsComputerUnavailable");
    expect(source).toContain("vpsRelayBindings");
    expect(source).toContain("cloudHomeCopy.boxEngineUnavailable");
  });
});
