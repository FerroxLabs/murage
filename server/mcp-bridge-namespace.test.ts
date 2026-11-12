// C11 note 3.1 section 6: the real bridge, spawned, against a scripted child (server/testing/bridge-id-child.mjs).
// The child records every line it gets and holds its answers until told, so the order of answers is the test's.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { bridgeBusyFrame } from "./mcp-bridge.ts";

const CHILD = fileURLToPath(new URL("./testing/bridge-id-child.mjs", import.meta.url));
const BRIDGE_ID = /^mb\.[0-9a-f]{12}\.[1-9]\d*$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONTROL = new Set(["x/release", "x/dup", "x/raw", "x/closestdin"]);
const REVOKED = "bridge revoked an answer that was waiting to be written";

let bridges: ChildProcess[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const b of bridges) if (b.exitCode === null && b.signalCode === null) b.kill("SIGKILL");
  bridges = [];
  for (const s of servers) await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
  servers = [];
});

/** A catalog endpoint with the production URL shape. `hold(n)` makes POST n wait until release(). */
async function catalogStub(hold: (n: number) => boolean) {
  const posts: any[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const n = posts.length; posts.push(JSON.parse(body));
    if (hold(n)) await held;
    res.writeHead(200).end("{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/internal/mcp-catalog/${randomUUID()}`;
  return { url, posts, release };
}

function startBridge(opts: { maxInFlight?: number; stub?: { url: string }; child?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "c11-ns-"));
  const record = join(dir, "child.record");
  const options = `{command:process.execPath,args:[${JSON.stringify(opts.child ?? CHILD)}],label:'fixture'${opts.maxInFlight ? `,maxInFlight:${opts.maxInFlight}` : ""}}`;
  const script = `import {runMcpBridge} from './server/mcp-bridge.ts'; runMcpBridge(${options});`;
  const env: Record<string, string | undefined> = { ...process.env, CHILD_RECORD: record };
  if (opts.stub) Object.assign(env, { MURAGE_MCP_LISTED_FILE: join(dir, "generation.mount"), MURAGE_MCP_LISTED_URL: opts.stub.url, MURAGE_MCP_TOKEN: "t" });
  const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"], env });
  bridges.push(bridge);
  let output = "", errors = "";
  bridge.stdout.on("data", (c) => { output += c; });
  bridge.stderr.on("data", (c) => { errors += c; });
  const closed = new Promise<number | null>((resolve) => bridge.on("close", resolve));
  const lines = (text: string) => text.split("\n").filter(Boolean);
  const raw = () => (existsSync(record) ? lines(readFileSync(record, "utf8")) : []);
  const api = {
    closed,
    send: (frame: unknown) => { bridge.stdin.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n"); },
    end: () => bridge.stdin.end(),
    frames: () => lines(output).map((l) => JSON.parse(l)),
    outputLines: () => lines(output),
    seen: () => raw().map((l) => JSON.parse(l)),
    seenRaw: raw,
    errors: () => errors,
    /** every request the child received (has a method and an id), in order */
    requests: () => api.seen().filter((m: any) => typeof m.method === "string" && !CONTROL.has(m.method) && m.id !== undefined),
    release: (n: number) => api.send({ jsonrpc: "2.0", method: "x/release", params: { n } }),
    waitFor: async (what: string, cond: () => boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() > end) throw new Error(`watchdog: ${what}\nframes=${output}\nseen=${raw().length}\nerr=${errors}`); await sleep(20); }
    },
  };
  return api;
}
const echo = (id: number | string, n: number, hold = false) => ({ jsonrpc: "2.0", id, method: "x/echo", params: { n, ...(hold ? { hold: true } : {}) } });
const list = (id: number | string, n: number) => ({ jsonrpc: "2.0", id, method: "tools/list", params: { n, hold: true } });
const result = (id: unknown, n: number) => ({ jsonrpc: "2.0", id, result: { n } });
const idOf = (m: any) => m.id;

describe("runMcpBridge id namespace (C11 note 3.1 section 6)", () => {
  it("B-1 an answered id that the engine reuses: the old duplicate never takes the new request's handle", async () => {
    const b = startBridge();
    b.send(echo(5, 1));
    await b.waitFor("first answer", () => b.frames().length === 1);
    b.send(echo(5, 2, true)); // the child holds this answer
    await b.waitFor("second request at the child", () => b.requests().length === 2);
    b.send({ jsonrpc: "2.0", method: "x/dup", params: { n: 1 } }); // the child re-emits its stored first answer
    await b.waitFor("duplicate emitted", () => b.seen().some((m) => m.method === "x/dup"));
    await sleep(300);
    b.release(2);
    await b.waitFor("second answer", () => b.frames().length >= 2);
    await sleep(300);
    expect(b.frames()).toEqual([result(5, 1), result(5, 2)]);
  }, 30_000);

  it("B-2 an answered id is not forgotten after 4,100 other ids: its late duplicate is never written", async () => {
    const b = startBridge();
    b.send(echo(7, 7));
    await b.waitFor("id 7 answered", () => b.frames().length === 1);
    for (let batch = 0; batch < 41; batch++) {
      for (let i = 0; i < 100; i++) b.send(echo(1000 + batch * 100 + i, 100_000 + batch * 100 + i));
      await b.waitFor(`batch ${batch}`, () => b.frames().length === 1 + (batch + 1) * 100, 15_000);
    }
    b.send({ jsonrpc: "2.0", method: "x/dup", params: { n: 7 } });
    await b.waitFor("duplicate emitted", () => b.seen().some((m) => m.method === "x/dup"));
    await sleep(400);
    expect(b.frames().filter((f) => f.id === 7)).toEqual([result(7, 7)]);
    expect(b.frames()).toHaveLength(4101);
  }, 60_000);

  it("B-3 in-flight reuse: the older request is cancelled and the engine gets exactly one id-7 frame, the newer one's", async () => {
    const b = startBridge();
    b.send(echo(7, 1, true));
    b.send(echo(7, 2, true));
    await b.waitFor("both at the child", () => b.requests().length === 2);
    b.release(1);
    b.release(2);
    await b.waitFor("an answer", () => b.frames().length >= 1);
    await sleep(400);
    expect(b.frames()).toEqual([result(7, 2)]);
  }, 30_000);

  it("B-4 a cancel carries the id the child saw, and a late answer to the cancelled request is never written", async () => {
    const b = startBridge();
    b.send(echo(7, 1, true));
    await b.waitFor("request at the child", () => b.requests().length === 1);
    b.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "test" } });
    await b.waitFor("cancel at the child", () => b.seen().some((m) => m.method === "notifications/cancelled"));
    const asked = idOf(b.requests()[0]);
    expect(b.seen().find((m) => m.method === "notifications/cancelled")?.params).toEqual({ requestId: asked, reason: "test" });
    expect(String(asked)).toMatch(BRIDGE_ID);
    b.release(1); // the child answers anyway
    await sleep(500);
    expect(b.frames().filter((f) => f.id === 7)).toEqual([]);
  }, 30_000);

  it("B-5 a cancel with nothing live never reaches the child", async () => {
    const b = startBridge();
    b.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    b.send(echo(1, 1));
    await b.waitFor("the marker request", () => b.frames().length === 1);
    expect(b.seen().filter((m) => m.method === "notifications/cancelled")).toEqual([]);
  }, 30_000);

  it("B-6 every request id the child sees is a bridge id, strictly increasing, and different when the engine reuses an id", async () => {
    const b = startBridge();
    let answered = 0;
    for (const [id, n] of [[5, 1], [5, 2], [6, 3], ["s", 4], [5, 5]] as const) {
      b.send(echo(id, n));
      answered++;
      await b.waitFor(`answer ${n}`, () => b.frames().length === answered);
    }
    const asked = b.requests().map(idOf);
    expect(asked).toHaveLength(5);
    for (const id of asked) expect(id).toMatch(BRIDGE_ID);
    const seqs = asked.map((id: string) => Number(id.split(".")[2]));
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(asked).size).toBe(5);
    expect(new Set(asked.map((id: string) => id.split(".")[1])).size).toBe(1); // one nonce per bridge
    expect(b.frames().map((f) => f.id).sort()).toEqual([5, 5, 5, 6, "s"].sort());
  }, 30_000);

  it("B-7 forgeries: a namespace id never issued and a raw id equal to a live engine id are dropped, only the real answer is delivered", async () => {
    const b = startBridge();
    b.send(echo(4, 4, true));
    await b.waitFor("request at the child", () => b.requests().length === 1);
    const [, nonce, seq] = String(idOf(b.requests()[0])).split(".");
    b.send({ jsonrpc: "2.0", method: "x/raw", params: { line: JSON.stringify({ jsonrpc: "2.0", id: `mb.${nonce}.${Number(seq) + 5}`, result: { forged: 1 } }) } });
    b.send({ jsonrpc: "2.0", method: "x/raw", params: { line: JSON.stringify({ jsonrpc: "2.0", id: 4, result: { forged: 2 } }) } });
    await sleep(500);
    b.release(4);
    await b.waitFor("the real answer", () => b.frames().some((f) => f.result?.n === 4));
    await sleep(400);
    expect(b.frames()).toEqual([result(4, 4)]);
    expect(b.errors()).toContain("dropped a response that answers no waiting request");
  }, 30_000);

  it("B-8 at the default cap the 4,097th live request is answered busy and the child never sees it", async () => {
    const b = startBridge();
    for (let i = 1; i <= 4096; i++) b.send(echo(i, i, true));
    b.send(echo(5000, 5000, true));
    await b.waitFor("the busy answer", () => b.frames().length === 1, 20_000);
    expect(b.frames()).toEqual([bridgeBusyFrame(5000)]);
    await b.waitFor("all 4,096 at the child", () => b.requests().length >= 4096, 20_000);
    await sleep(300);
    expect(b.requests()).toHaveLength(4096);
    expect(b.requests().some((m: any) => m.params?.n === 5000)).toBe(false);
  }, 60_000);

  it("B-9a a busy answer stalls the engine's next line until it is written; then the next request is admitted", async () => {
    const stub = await catalogStub((n) => n >= 3); // request POSTs 0-2 pass, every response-side POST is held
    const b = startBridge({ maxInFlight: 3, stub });
    for (const id of [1, 2, 3]) b.send(list(id, id));
    await b.waitFor("three lists at the child", () => b.requests().length === 3);
    for (const n of [1, 2, 3]) b.release(n);
    await b.waitFor("a held response POST", () => stub.posts.length >= 4);
    await sleep(500); // all three answers are claimed, their frames wait behind the held publication
    b.send(echo(4, 4));
    b.send(echo(5, 5));
    await sleep(700);
    expect(b.requests().map((m: any) => m.params.n)).toEqual([1, 2, 3]); // neither 4 nor 5 reached the child
    expect(b.frames()).toEqual([]);
    stub.release();
    await b.waitFor("five frames", () => b.frames().length === 5, 15_000);
    expect(b.frames().map(idOf)).toEqual([1, 2, 3, 4, 5]);
    expect(b.frames()[3]).toEqual(bridgeBusyFrame(4, 3));
    expect(b.frames()[4]).toEqual(result(5, 5));
    expect(b.requests().map((m: any) => m.params.n)).toEqual([1, 2, 3, 5]);
  }, 40_000);

  /** Two overlapping tools/list requests taint A (id 7); the child answers A while the stub holds A's response-side POST. */
  async function claimedWindow() {
    const stub = await catalogStub((n) => n === 2);
    const b = startBridge({ stub });
    b.send(list(7, 1));
    b.send(list(8, 2));
    await b.waitFor("both lists at the child", () => b.requests().length === 2);
    b.release(1);
    await b.waitFor("A's response POST held", () => stub.posts.length === 3);
    await sleep(300);
    return { b, stub };
  }

  it("B-3h reuse inside the claimed window: A is revoked, the engine gets exactly one id-7 frame, B's", async () => {
    const { b, stub } = await claimedWindow();
    b.send(list(7, 3)); // the engine reuses id 7 while A's frame waits on its publication
    await b.waitFor("A revoked", () => b.errors().includes(REVOKED), 2500);
    stub.release();
    await b.waitFor("B at the child", () => b.requests().length === 3);
    b.release(3);
    await b.waitFor("B's answer", () => b.frames().some((f) => f.id === 7));
    await sleep(500);
    const seven = b.frames().filter((f) => f.id === 7);
    expect(seven).toHaveLength(1);
    expect(seven[0].result).toMatchObject({ tools: [{ name: "t3" }] });
  }, 40_000);

  it("B-3h (cancel of B) after A settles, the engine cancels B: the child gets a cancel for B's bridge id and the engine no id-7 frame", async () => {
    const { b, stub } = await claimedWindow();
    b.send(list(7, 3));
    await b.waitFor("A revoked", () => b.errors().includes(REVOKED), 2500);
    stub.release();
    await b.waitFor("B at the child", () => b.requests().length === 3);
    await sleep(300); // A's respond promise has settled
    b.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    await b.waitFor("cancel at the child", () => b.seen().some((m) => m.method === "notifications/cancelled"));
    expect(b.seen().find((m) => m.method === "notifications/cancelled")?.params.requestId).toBe(idOf(b.requests()[2]));
    b.release(3);
    await sleep(500);
    expect(b.frames().filter((f) => f.id === 7)).toEqual([]);
  }, 40_000);

  it("B-4h cancel inside the claimed window: the engine gets no id-7 frame and the child gets no cancel", async () => {
    const { b, stub } = await claimedWindow();
    b.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    await b.waitFor("A revoked", () => b.errors().includes(REVOKED), 2500);
    stub.release();
    await sleep(700);
    expect(b.frames().filter((f) => f.id === 7)).toEqual([]);
    expect(b.seen().filter((m) => m.method === "notifications/cancelled")).toEqual([]);
  }, 40_000);

  it("B-10 guard: the child closes stdin before a request; that request gets no frame and the bridge exits through close", async () => {
    const b = startBridge();
    b.send({ jsonrpc: "2.0", method: "x/closestdin" });
    await b.waitFor("the child saw it", () => b.seen().length === 1);
    await sleep(200);
    b.send(echo(3, 3));
    b.end();
    expect(await Promise.race([b.closed, sleep(10_000).then(() => "watchdog")])).toBe(0);
    expect(b.frames()).toEqual([]);
  }, 30_000);

  it("B-11 guard: integers beyond 2^53 reach the child and the engine byte-identical, apart from the id member", async () => {
    const b = startBridge();
    const request = '{"jsonrpc":"2.0","id":5,"method":"x/big","params":{"n":12345678901234567890,"s":"a\\"id\\":1"}}';
    b.send(request);
    await b.waitFor("an answer", () => b.outputLines().length === 1);
    const asked = idOf(b.requests()[0]);
    expect(b.seenRaw()[0]).toBe(request.replace('"id":5,', `"id":${JSON.stringify(asked)},`));
    expect(b.outputLines()[0]).toBe('{"jsonrpc":"2.0","id":5,"result":{"big":98765432109876543210}}');
  }, 30_000);
});
