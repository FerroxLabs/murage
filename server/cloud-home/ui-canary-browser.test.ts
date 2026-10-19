// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createChildSpawner, type CanarySpawner } from "./ui-canary.ts";
import * as processes from "./browser-process.ts";
import { cloudRelayConnection } from "./browser-relay.ts";
import { canaryRequestAllowed, createCloudUiLauncher, fulfilHeaders, proxyGetOverUnix, CANARY_ORIGIN } from "./ui-canary-browser.ts";
import { trustedCloudSocket } from "./proxy-socket.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

vi.mock("./browser-process.ts", () => ({
  cleanupCanaryBrowser: vi.fn(async () => {}), cleanupCloudBrowser: vi.fn(async () => {}),
  spawnCanaryBrowser: vi.fn(() => null), spawnCloudBrowser: vi.fn(() => null),
}));
const O = CANARY_ORIGIN;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

it("allows only GET of the page, built static files and door state", () => {
  for (const u of ["/", "/assets/index-abc.js", "/assets/x/y.css", "/favicon.ico", "/app-icon.svg", "/api/cloud/door-state"]) expect(canaryRequestAllowed("GET", O + u)).toBe(true);
});
it("refuses other APIs, writes, queries, traversal and every other origin", () => {
  expect(canaryRequestAllowed("GET", O + "/api/threads")).toBe(false);
  expect(canaryRequestAllowed("GET", O + "/api/health")).toBe(false);
  expect(canaryRequestAllowed("GET", O + "/enter")).toBe(false);
  expect(canaryRequestAllowed("POST", O + "/")).toBe(false);
  expect(canaryRequestAllowed("POST", O + "/api/cloud/door-state")).toBe(false);
  expect(canaryRequestAllowed("GET", O + "/?token=x")).toBe(false);
  expect(canaryRequestAllowed("GET", O + "/assets/../api/threads")).toBe(false);
  expect(canaryRequestAllowed("GET", O + "/assets/%2e%2e/x")).toBe(false);
  for (const u of ["https://example.com/", "http://127.0.0.1:8799/", "http://murage-canary.invalid:8080/", "https://murage-canary.invalid/", "http://evil.test/assets/a.js", "not a url"]) expect(canaryRequestAllowed("GET", u)).toBe(false);
});
it("fulfils over the Unix socket as an anonymous visitor: no TCP peer, no credentials, fixed source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-")); const socketPath = join(dir, "p.sock");
  const seen: { remote: string | undefined; headers: Record<string, unknown>; url?: string }[] = [];
  const server = createServer((req, res) => { seen.push({ remote: req.socket.remoteAddress, headers: req.headers, url: req.url }); res.setHeader("content-type", "text/html"); res.end("<html>x</html>"); });
  await new Promise<void>(r => server.listen(socketPath, r));
  cleanup = () => { server.close(); removeTempDirSync(dir); };
  const answer = await proxyGetOverUnix(socketPath)("/", "murage-control-canary/1", new AbortController().signal);
  expect(answer.status).toBe(200); expect(answer.body.toString()).toBe("<html>x</html>");
  const s = seen[0]!;
  expect(s.remote).toBeFalsy();   // no TCP peer address, so never the "service" scope
  expect(s.headers.cookie).toBeUndefined(); expect(s.headers.authorization).toBeUndefined();
  expect(s.headers["x-forwarded-for"]).toBe("127.0.0.1"); expect(s.headers["user-agent"]).toBe("murage-control-canary/1");
  expect(trustedCloudSocket({ socket: { remoteAddress: s.remote } } as never, undefined)).toBe(false);
});
it("fails when the socket is unreachable instead of falling back to TCP", async () => {
  await expect(proxyGetOverUnix("/nonexistent/p.sock")("/", "ua", new AbortController().signal)).rejects.toThrow();
});

it("fulfils with the real security headers, never Set-Cookie or hop-by-hop headers", () => {
  const out = fulfilHeaders({ status: 200, contentType: "text/html", body: Buffer.alloc(0), headers: {
    "content-type": "text/html", "content-security-policy": "default-src 'self'; require-trusted-types-for 'script'", "x-content-type-options": "nosniff",
    "set-cookie": ["a=b", "c=d"], "connection": "keep-alive", "keep-alive": "timeout=5", "transfer-encoding": "chunked", "content-length": "9", authorization: "x",
  } });
  const names = out.map(h => h.name.toLowerCase());
  expect(names).toEqual(expect.arrayContaining(["content-type", "content-security-policy", "x-content-type-options"]));
  for (const bad of ["set-cookie", "connection", "keep-alive", "transfer-encoding", "content-length", "authorization"]) expect(names).not.toContain(bad);
  expect(out.find(h => h.name === "content-security-policy")!.value).toContain("require-trusted-types-for");
});

// A fake CDP browser: Runtime.evaluate never answers, so only abort or disconnect can end the check.
async function hungBrowser() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(r => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  let evaluated!: () => void; const gotEvaluate = new Promise<void>(r => { evaluated = r; });
  wss.on("connection", sock => sock.on("message", raw => {
    const m = JSON.parse(raw.toString());
    const reply = (result: object) => sock.send(JSON.stringify({ id: m.id, result }));
    if (m.method === "Target.getTargets") reply({ targetInfos: [{ targetId: "t", type: "page" }] });
    else if (m.method === "Target.attachToTarget") reply({ sessionId: "s" });
    else if (m.method === "Runtime.evaluate") evaluated();
    else reply({});
  }));
  cleanup = () => { for (const c of wss.clients) c.terminate(); wss.close(); };
  return { port, gotEvaluate };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, kill: vi.fn(() => true) });
  return child as unknown as import("node:child_process").ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> };
}
const closeWith = (child: EventEmitter, code = 0) => child.emit("close", code);

it("T10 an abort between open and get cdp-url starts no second process", async () => {
  const children: ReturnType<typeof fakeChild>[] = []; const calls: string[][] = [];
  const base = vi.fn((args: string[]) => { calls.push(args); const child = fakeChild(); children.push(child); return child; });
  const abort = new AbortController();
  const spawner = createChildSpawner(base, abort.signal);
  const launcher = createCloudUiLauncher("/unused", { proxyGet: async () => { throw new Error("no"); } });
  const result = launcher({ path: "/", userAgent: "ua", signal: abort.signal, spawner }).then(() => "ok", e => String(e.message));
  expect(calls).toEqual([["--json", "open", "about:blank"]]);
  abort.abort();                                                 // between open and get cdp-url
  children[0]!.stdout.emit("data", Buffer.from("{}")); closeWith(children[0]!);
  expect(await result).toBe("aborted");
  expect(calls.length).toBe(1);                                  // no second spawn
  expect(() => spawner.spawn(["--json", "get", "cdp-url"], {})).toThrow("aborted");   // the fence itself refuses, synchronously
  expect(base).toHaveBeenCalledTimes(1);
});
it("T11 the CDP relay is spawned through the spawner and tracked", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const base = vi.fn((_args: string[]) => fakeChild());
  const spawner = createChildSpawner(base, new AbortController().signal);
  const connection = cloudRelayConnection("cdp", {}, spawner.spawn)!;
  const duplex = connection();
  expect(base).toHaveBeenCalledWith(["relay", "cdp"], {});
  const relay = base.mock.results[0]!.value as ReturnType<typeof fakeChild>;
  let drained: boolean | undefined; void spawner.drained(1000).then(v => { drained = v; });
  await Promise.resolve(); expect(drained).toBeUndefined();        // the relay child is tracked: not drained while it is open
  duplex.destroy(); closeWith(relay);
  await vi.waitFor(() => expect(drained).toBe(true));
  vi.unstubAllEnvs();
  // And the launcher itself: every command it runs, and the relay, reaches the spawner.
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const calls: string[][] = []; const abort = new AbortController();
  const traced = createChildSpawner(args => {
    calls.push(args); const child = fakeChild();
    if (args.includes("open")) queueMicrotask(() => closeWith(child));
    if (args.includes("cdp-url")) queueMicrotask(() => { child.stdout.emit("data", Buffer.from(JSON.stringify({ data: "ws://127.0.0.1:9" }))); closeWith(child); });
    return child;
  }, abort.signal);
  const run = createCloudUiLauncher("/unused", { proxyGet: async () => { throw new Error("no"); } })({ path: "/", userAgent: "ua", signal: abort.signal, spawner: traced }).then(() => "ok", () => "rejected");
  await vi.waitFor(() => expect(calls.some(a => a[0] === "relay")).toBe(true));
  abort.abort(); expect(await run).toBe("rejected");
  expect(calls.map(a => a.includes("open") ? "open" : a.includes("cdp-url") ? "cdp-url" : a[0])).toEqual(["open", "cdp-url", "relay"]);
  vi.unstubAllEnvs();
});
it("T12 the fence sends SIGTERM, then SIGKILL after 5 s, and drained waits for close", async () => {
  vi.useFakeTimers();
  try {
    const child = fakeChild(); const abort = new AbortController();
    const spawner = createChildSpawner(() => child, abort.signal);
    spawner.spawn(["x"], {});
    let drained: boolean | undefined; void spawner.drained(10_000).then(v => { drained = v; });
    abort.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(4_999); expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(drained).toBeUndefined();                              // a signal is not a close
    closeWith(child, 137); await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    // A child that never closes times out.
    const stuck = createChildSpawner(() => fakeChild(), new AbortController().signal); stuck.spawn(["y"], {});
    const timedOut = stuck.drained(10_000); await vi.advanceTimersByTimeAsync(10_000);
    expect(await timedOut).toBe(false);
  } finally { vi.useRealTimers(); }
});
it("T13 the launcher never calls cleanup: an aborted run only renders and rejects", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const { port, gotEvaluate } = await hungBrowser();
  const run = vi.fn(async (args: string[]) => args.includes("cdp-url") ? JSON.stringify({ data: `ws://127.0.0.1:${port}` }) : "{}");
  const abort = new AbortController();
  const spawner: CanarySpawner = { spawn: vi.fn(() => null), drained: vi.fn(async () => true) };
  const launcher = createCloudUiLauncher("/unused", { run, proxyGet: async () => { throw new Error("no"); } });
  const result = launcher({ path: "/", userAgent: "ua", signal: abort.signal, spawner }).then(() => "ok", e => String(e.message));
  await gotEvaluate; abort.abort();
  expect(await result).toBe("aborted");
  expect(processes.cleanupCanaryBrowser).not.toHaveBeenCalled(); expect(processes.cleanupCloudBrowser).not.toHaveBeenCalled();
  expect(run.mock.calls.some(call => call[0].includes("close"))).toBe(false);   // nothing is stopped by the launcher after an abort
  vi.unstubAllEnvs();
});
