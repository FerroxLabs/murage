import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createMcpCatalogObserver, createMcpCatalogWriter, guardHandle, publicationFailureFrame, readMcpCatalog } from "./mcp-listed.ts";

/** C11 v3.1: publication failure is a per-operation result, never a shared rejection.
 *  The catalog endpoint is a local stub with the production URL shape; it can refuse, reset, or hold a POST. */
type Plan = "ok" | 403 | "reset" | "hold" | "hold403" | "store-then-hang" | "delay";
let servers: Server[] = [];
afterEach(async () => { for (const s of servers) await new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }); servers = []; });
async function stub(plan: (n: number, doc: any) => Plan) {
  const posts: any[] = []; let stored = 0; let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const doc = JSON.parse(body); const n = posts.length; posts.push(doc);
    const verdict = plan(n, doc);
    if (verdict === "reset") { req.socket.destroy(); return; }
    if (verdict === 403) { res.writeHead(403).end(); return; }
    if (verdict === "hold" || verdict === "hold403") await held;
    if (verdict === "delay") await new Promise(r => setTimeout(r, 5_600)); // arrives after the sender gave up and retried
    if (verdict === "hold403") { res.writeHead(403).end(); return; }
    if (doc.revision <= stored) { res.writeHead(403).end(); return; } // the :187 rule
    stored = doc.revision; (stub as any).last = doc;
    if (verdict === "store-then-hang") return;
    res.writeHead(200).end("{}");
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/internal/mcp-catalog/${randomUUID()}`;
  return { url, posts, release, stored: () => (stub as any).last };
}
function rig(url: string, output?: Writable) {
  const frames: any[] = [];
  const out = output ?? new Writable({ write(chunk, _e, cb) { for (const line of String(chunk).split("\n").filter(Boolean)) frames.push(JSON.parse(line)); cb(); } });
  const path = join(mkdtempSync(join(tmpdir(), "c11-fail-")), "generation.mount");
  const writer = createMcpCatalogWriter({ MURAGE_MCP_LISTED_FILE: path, MURAGE_MCP_LISTED_URL: url }, out);
  return { writer, frames, path };
}
/** C11 note 3.1 sections 6.5 and 6.6: the request and result frames are CAPTURED from a real testing/fake-c11-mcp.mjs exchange
 *  (initialize, then tools/list), and the expected tools are taken from the captured result, so the shape under test is the
 *  one a real mount writes, not one synthesized here. */
let captured: { request: any; result: any } | undefined;
beforeAll(async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-c11-mcp.mjs")],
    { env: { PATH: process.env.PATH ?? "", FIXTURE_TOOLS: JSON.stringify(["captured_a"]) }, stdio: ["pipe", "pipe", "inherit"] });
  const frames: any[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake-c11-mcp exchange watchdog")), 20_000);
    readline.createInterface({ input: child.stdout }).on("line", line => { frames.push(JSON.parse(line)); if (frames.length === 2) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { if (frames.length < 2) { clearTimeout(timer); reject(new Error("fake-c11-mcp exited early")); } });
  });
  const request = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" + JSON.stringify(request) + "\n");
  try { await done; } finally { child.kill(); }
  captured = { request, result: frames.find(frame => frame.id === 2) };
  expect(captured.result.result.tools).toEqual([{ name: "captured_a", inputSchema: { type: "object", properties: {} } }]);
}, 30_000);
const list = (id: number | string, cursor?: string) => ({ ...captured!.request, id, params: cursor === undefined ? {} : { cursor } });
const result = (id: number | string, names: string[]) => ({ ...captured!.result, id, result: { tools: names.map(name => ({ ...captured!.result.result.tools[0], name })) } });
const bounded = <T,>(p: Promise<T>, ms = 12_000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("watchdog")), ms))]);

describe("C11 v3.1 publication failure", () => {
  it("W-a 403 on list A's request POST: A gets exactly one frame (its replacement), B then certifies, a tools/call is answered", async () => {
    const s = await stub(n => n === 0 ? 403 : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    await bounded(a.respond(result(1, ["a"])));
    expect(frames.filter(f => f.id === 1)).toHaveLength(1);
    expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id));
    const b = writer.observeRequest(list(2)); await b.published;
    await bounded(b.respond(result(2, ["b"])));
    const c = writer.observeRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }); await bounded(c.respond({ jsonrpc: "2.0", id: 3, result: {} }));
    expect(frames.map(f => [f.id, f.error ? "error" : "result"])).toEqual([[1, "error"], [2, "result"], [3, "result"]]);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
    const revisions = s.posts.map(p => p.revision); expect(revisions).toEqual([...revisions].sort((x, y) => x - y)); expect(new Set(revisions).size).toBe(revisions.length);
  });
  it("W-b a socket reset on a TAINTED RESPONSE's own dirty POST: that response is replaced by its error, the others are untouched, and a later chain certifies", async () => {
    // posts: 0 = A's request, 1 = B's request, 2 = B's response (tainted: another list is active), reset.
    const s = await stub(n => n === 2 ? "reset" : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    const b = writer.observeRequest(list(2)); await b.published;
    await bounded(b.respond(result(2, ["b"])));
    await bounded(a.respond(result(1, ["a"])));
    const c = writer.observeRequest(list(3)); await c.published; await bounded(c.respond(result(3, ["c"])));
    expect(frames.map(f => [f.id, f.error ? "error" : "result"])).toEqual([[2, "error"], [1, "result"], [3, "result"]]);
    expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id));
    expect(s.stored()).toMatchObject({ complete: true, tools: ["c"] });
  });
  it("W-d 403 on A's completion POST after delivery: the same content is posted again at a higher revision, before B's POSTs", async () => {
    let completeSeen = 0; const s = await stub((_n, doc) => doc.complete && completeSeen++ === 0 ? 403 : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published; await bounded(a.respond(result(1, ["a"])));
    expect(frames.filter(f => f.id === 1 && f.result)).toHaveLength(1);
    const completes = s.posts.filter(p => p.complete); expect(completes).toHaveLength(2);
    expect(completes[1].revision).toBeGreaterThan(completes[0].revision); expect(completes[1].tools).toEqual(["a"]);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["a"] });
    // G-1 guard: a late error for A (what a catch would send) is dropped, A still has one frame
    await a.respond({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "late" } });
    expect(frames.filter(f => f.id === 1)).toHaveLength(1);
  });
  it("W-d2 a completion POST that landed but timed out: the retry at a new revision is accepted and the stored document stays complete", async () => {
    let n = 0; const s = await stub((_i, doc) => doc.complete && n++ === 0 ? "store-then-hang" : "ok"); const { writer } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published; await bounded(a.respond(result(1, ["a"])), 20_000);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["a"] });
    expect(s.posts.filter(p => p.complete)).toHaveLength(2);
  }, 30_000);
  it("W-d3 a completion POST that arrives LATE (after the sender timed out and retried): the stale document is refused and the stored catalog is the retry's", async () => {
    let n = 0; const s = await stub((_i, doc) => doc.complete && n++ === 0 ? "delay" : "ok"); const { writer } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published; await bounded(a.respond(result(1, ["a"])), 20_000);
    const stored = s.stored(); expect(stored).toMatchObject({ complete: true, tools: ["a"] });
    await new Promise(r => setTimeout(r, 1_500)); // the delayed first document is processed now
    expect(s.stored().revision).toBe(stored.revision); expect(s.posts.filter(p => p.complete)).toHaveLength(2);
  }, 30_000);
  it("W-d queued: list B is observed while A's completion retry is pending; B's request POST goes out only after A's retry, and the stored document ends as B's", async () => {
    let completeSeen = 0; const s = await stub((_n, doc) => doc.complete && completeSeen++ === 0 ? "hold403" : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    const aDone = a.respond(result(1, ["a"]));            // A's completion POST is held, then refused, then retried inline
    await vi.waitFor(() => expect(s.posts.filter(p => p.complete)).toHaveLength(1));
    const b = writer.observeRequest(list(2));              // B arrives while A's first completion attempt is in flight
    s.release();
    await bounded(aDone); await b.published; await bounded(b.respond(result(2, ["b"])));
    const shape = s.posts.map(p => [p.complete, p.revision]);
    // A request, A completion (refused), A completion retry, and only then B's request POST (an incomplete document).
    expect(shape.slice(0, 4).map(([c]) => c)).toEqual([false, true, true, false]);
    const revisions = s.posts.map(p => p.revision); expect(new Set(revisions).size).toBe(revisions.length); expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
    expect(frames.map(f => [f.id, f.error ? "error" : "result"])).toEqual([[1, "result"], [2, "result"]]);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  }, 30_000);
  it("W-c the stub stays silent past the 5 s bound on A's request POST: A gets one replacement frame, and the next list certifies", async () => {
    const s = await stub(n => n === 0 ? "hold" : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await bounded(a.published, 20_000);
    await bounded(a.respond(result(1, ["a"])), 20_000);
    expect(frames.filter(f => f.id === 1)).toHaveLength(1); expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id));
    const b = writer.observeRequest(list(2)); await b.published; await bounded(b.respond(result(2, ["b"])));
    const c = writer.observeRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }); await bounded(c.respond({ jsonrpc: "2.0", id: 3, result: {} }));
    expect(frames.map(f => [f.id, f.error ? "error" : "result"])).toEqual([[1, "error"], [2, "result"], [3, "result"]]);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  }, 40_000);
  it("W-e A's request POST is held then refused, with list B and ping C already sent behind it: output is A's replacement, B's list, C; B's chain is built and every promise settles", async () => {
    const s = await stub(n => n === 0 ? "hold403" : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); const pa = a.respond(result(1, ["a"]));
    const b = writer.observeRequest(list(2)); const pb = b.respond(result(2, ["b"]));
    const c = writer.observeRequest({ jsonrpc: "2.0", id: 3, method: "ping" }); const pc = c.respond({ jsonrpc: "2.0", id: 3, result: {} });
    await new Promise(r => setTimeout(r, 100)); expect(frames).toHaveLength(0); s.release();
    await bounded(Promise.all([pa, pb, pc]));
    expect(frames.map(f => f.id)).toEqual([1, 2, 3]);
    expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id)); expect(frames[1].result.tools).toEqual(result(2, ["b"]).result.tools); expect(frames[2].result).toEqual({});
    // B was built behind a tainted A, so it cannot certify; a fresh chain D does, and is the stored catalog.
    expect(s.stored()?.complete).not.toBe(true);
    const d = writer.observeRequest(list(4)); await d.published; await bounded(d.respond(result(4, ["d"])));
    expect(s.stored()).toMatchObject({ complete: true, tools: ["d"] });
  });
  it("W-f1 a write error: respond rejects, and W-f2 a later chain on the same observer still certifies", async () => {
    const s = await stub(() => "ok"); let fail = true;
    const out = { write: (_chunk: unknown, cb: (error?: Error | null) => void) => { if (fail) { fail = false; cb(new Error("fixture flush failure")); } else cb(); return true; } } as unknown as Writable;
    const { writer } = rig(s.url, out);
    const a = writer.observeRequest(list(1)); await a.published;
    await expect(a.respond(result(1, ["a"]))).rejects.toThrow();
    const b = writer.observeRequest(list(2)); await b.published; await bounded(b.respond(result(2, ["b"])));
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  });
  it("W-g flush resolves after a failed POST", async () => {
    const s = await stub(() => 403); const { writer } = rig(s.url);
    const a = writer.observeRequest(list(1)); await expect(bounded(a.published)).resolves.toBe(false);
    await expect(bounded(writer.flush())).resolves.toBeUndefined();
  });
  it("P-5 while the first id-7 answer's completion POST is still held, the engine reuses id 7: the old handler's late fallback is dropped and the new 7 gets exactly its own answer", async () => {
    let completes = 0; const s = await stub((_n, doc) => doc.complete && completes++ === 0 ? "hold" : "ok"); const { writer, frames } = rig(s.url);
    const first = writer.observeRequest(list(7)); await first.published;
    const firstDone = first.respond(result(7, ["old"]));
    await expect.poll(() => frames.length, { timeout: 5_000 }).toBe(1); // delivered; its completion POST is held
    const second = writer.observeRequest(list(7)); // the engine reuses the id before the first one has finished publishing
    await first.respond({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "stale fallback" } });
    expect(frames).toHaveLength(1);
    s.release(); await bounded(firstDone); await second.published;
    await bounded(second.respond(result(7, ["new"])));
    expect(frames).toHaveLength(2); expect(frames[1].result.tools).toEqual(result(7, ["new"]).result.tools);
  });
  it("replacement followed by cancellation retires the replaced request once: later lists still certify", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(7)); await a.published;
    const b = writer.observeRequest(list(7)); await b.published; // replaces a
    a.cancel(); // the engine now cancels the old one: no second retirement
    await bounded(b.respond(result(7, ["b"])));
    const c = writer.observeRequest(list(8)); await c.published; await bounded(c.respond(result(8, ["c"])));
    expect(frames.map(f => f.id)).toEqual([7, 8]); expect(s.stored()).toMatchObject({ complete: true, tools: ["c"] });
  });
  it("a response that cannot be serialised is answered with its error and does not wedge the chain", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    const circular: any = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } }; circular.result.self = circular;
    await bounded(a.respond(circular));
    expect(frames).toHaveLength(1); expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id));
    const b = writer.observeRequest(list(2)); await b.published; await bounded(b.respond(result(2, ["b"])));
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  });
  it("a SYNCHRONOUS throw from output.write aborts the attempt: respond rejects and a later chain certifies", async () => {
    const s = await stub(() => "ok"); let fail = true;
    const out = { write: (_chunk: unknown, cb: (error?: Error | null) => void) => { if (fail) { fail = false; throw new Error("fixture sync write failure"); } cb(); return true; } } as unknown as Writable;
    const { writer } = rig(s.url, out);
    const a = writer.observeRequest(list(1)); await a.published;
    await expect(a.respond(result(1, ["a"]))).rejects.toThrow("fixture sync write failure");
    const b = writer.observeRequest(list(2)); await b.published; await bounded(b.respond(result(2, ["b"])));
    expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  });
  it("there is ONE delivery mechanism: the writer has no id-keyed answer, and no server code answers by id", () => {
    const { writer } = rig("http://127.0.0.1:9/api/internal/mcp-catalog/" + randomUUID());
    expect(Object.keys(writer).sort()).toEqual(["flush", "observeRequest", "send"]);
    const banned = ["answer", "By", "Id"].join("");
    const here = dirname(fileURLToPath(import.meta.url)); const hits: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (name === "node_modules") continue; if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name) && readFileSync(full, "utf8").includes(banned)) hits.push(full); } };
    walk(here); expect(hits).toEqual([]);
  });
  it("P-4 a cancelled tools/list gets no frame and its chain leaves active, so the next list certifies", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published; a.cancel();
    const b = writer.observeRequest(list(2)); await b.published; await bounded(b.respond(result(2, ["b"])));
    expect(frames.map(f => f.id)).toEqual([2]); expect(s.stored()).toMatchObject({ complete: true, tools: ["b"] });
  });
  it("an inert handle (a frame with no method) writes nothing and has no request state", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const inert = writer.observeRequest({ jsonrpc: "2.0", id: 9, result: {} });
    await inert.respond({ jsonrpc: "2.0", id: 9, error: { code: -32603, message: "must not be written" } }); inert.cancel();
    expect(frames).toHaveLength(0); expect(s.posts).toHaveLength(0);
  });
  it("a second respond for the same request is dropped (no id reuse needed), and a throwing replacer falls back to the default error", async () => {
    const s = await stub(n => n === 0 ? 403 : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(5)); await a.published;
    await bounded(a.respond(result(5, ["x"]), () => { throw new Error("replacer bug"); }));
    await a.respond({ jsonrpc: "2.0", id: 5, error: { code: -32603, message: "late fallback" } });
    expect(frames).toHaveLength(1); expect(frames[0]).toEqual(publicationFailureFrame(frames[0].id));
  });
  it("eviction cannot let a duplicate through: after thousands of other requests, an old handle still answers once", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest({ jsonrpc: "2.0", id: "first", method: "ping" });
    await bounded(a.respond({ jsonrpc: "2.0", id: "first", result: {} }));
    for (let i = 0; i < 4200; i++) writer.observeRequest({ jsonrpc: "2.0", id: i, method: "ping" });
    await a.respond({ jsonrpc: "2.0", id: "first", error: { code: -32603, message: "late fallback" } });
    expect(frames).toHaveLength(1);
  });
  it("initialize: commit after abort is inert", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "c11-init-")), "generation.mount");
    const o = createMcpCatalogObserver({ MURAGE_MCP_LISTED_FILE: path });
    o.observeRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const t = o.beforeResponse({ jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {}, resources: {} } } }); t.abort(); await t.commit();
    o.observeRequest(list(2)); const l = o.beforeResponse(result(2, ["a"])); await l.published; await l.commit(); await o.flush();
    expect(readMcpCatalog(path)).toMatchObject({ complete: true, resources: "unknown" });
  });
  it("framing: a string frame with trailing CR/LF is written with exactly one newline", async () => {
    const chunks: string[] = []; const out = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const path = join(mkdtempSync(join(tmpdir(), "c11-frame-")), "generation.mount");
    const writer = createMcpCatalogWriter({ MURAGE_MCP_LISTED_FILE: path }, out);
    await writer.send('{"jsonrpc":"2.0","method":"notifications/x"}\r\n'); await writer.send({ jsonrpc: "2.0", method: "notifications/y" });
    expect(chunks).toEqual(['{"jsonrpc":"2.0","method":"notifications/x"}\n', '{"jsonrpc":"2.0","method":"notifications/y"}\n']);
  });
  it("a local filesystem publication error resolves false instead of rejecting", async () => {
    const o = createMcpCatalogObserver({ MURAGE_MCP_LISTED_FILE: join(tmpdir(), "c11-missing-dir-" + randomUUID(), "generation.mount") });
    await expect(o.observeRequest(list(1)).published).resolves.toBe(false);
    await expect(o.flush()).resolves.toBeUndefined();
    expect(readMcpCatalog(join(tmpdir(), "nothing"))).toBeUndefined();
  });
});

describe("C11 v3.1 output failure is fatal where it happens", () => {
  it("guardHandle reports a failed write once, and a caller's fallback through the claimed handle cannot swallow it", async () => {
    const s = await stub(() => "ok");
    const out = { write: (_chunk: unknown, cb: (error?: Error | null) => void) => { cb(new Error("fixture flush failure")); return true; } } as unknown as Writable;
    const { writer } = rig(s.url, out);
    const failures: unknown[] = [];
    const req = guardHandle(writer.observeRequest({ jsonrpc: "2.0", id: 1, method: "ping" }), error => failures.push(error));
    await req.respond({ jsonrpc: "2.0", id: 1, result: {} }); // the write fails: reported, not thrown
    await req.respond({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "fallback" } }); // the caller's catch answers again: dropped silently
    expect(failures).toHaveLength(1);
  });
});

describe("C11 note 3.1 section 6 W-rev: a claimed response can be revoked until it is written", () => {
  it("a respond whose stillWanted turns false while its publication is held writes nothing, aborts its transaction, and resolves", async () => {
    // posts: 0 = A's request, 1 = B's request, 2 = A's response (tainted by B's overlap), held.
    const s = await stub(n => n === 2 ? "hold" : "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    const b = writer.observeRequest(list(2)); await b.published;
    let wanted = true;
    const done = a.respond(result(1, ["a"]), undefined, { stillWanted: () => wanted });
    await vi.waitFor(() => expect(s.posts).toHaveLength(3));
    wanted = false; s.release();
    await bounded(done);
    expect(frames).toEqual([]);
    await bounded(b.respond(result(2, ["b"])));
    const c = writer.observeRequest(list(3)); await c.published; await bounded(c.respond(result(3, ["c"])));
    expect(frames.map(f => f.id)).toEqual([2, 3]);
    expect(s.stored()).toMatchObject({ complete: true, tools: ["c"] }); // a later chain certifies: the revoked A did not leave the catalog tainted for good
  });
  it("a respond whose stillWanted stays true is written as before", async () => {
    const s = await stub(() => "ok"); const { writer, frames } = rig(s.url);
    const a = writer.observeRequest(list(1)); await a.published;
    await bounded(a.respond(result(1, ["a"]), undefined, { stillWanted: () => true }));
    expect(frames).toEqual([result(1, ["a"])]);
  });
});

describe("C11 v3.1 P-2: the bridge, caller-level, with its first catalog POST refused", () => {
  it("tools/list 1, tools/list 2 and ping 3: exactly one answer per id (1 an error, 2 and 3 results) and the bridge stays alive to the end of input", async () => {
    const s = await stub(n => n === 0 ? 403 : "ok");
    const driver = `process.stdin.on('data', c => { for (const l of String(c).split('\\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{tools:[{name:'t'}]}}) + '\\n'); } });`;
    const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
      runMcpBridge({command:process.execPath,args:['-e',${JSON.stringify(driver)}],label:'fixture'});`;
    const marker = join(mkdtempSync(join(tmpdir(), "c11-p2-")), "generation.mount");
    const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MURAGE_MCP_LISTED_FILE: marker, MURAGE_MCP_LISTED_URL: s.url, MURAGE_MCP_TOKEN: "t" } });
    let output = ""; bridge.stdout.on("data", (chunk) => { output += chunk; });
    const frames = () => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const closed = new Promise<number | null>((resolve) => bridge.on("close", resolve));
    const timer = setTimeout(() => bridge.kill("SIGKILL"), 25_000);
    try {
      bridge.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      await new Promise(r => setTimeout(r, 400));
      bridge.stdin.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
      expect(await closed).toBe(0);
      const byId = new Map<number, any[]>(); for (const f of frames()) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
      expect([...byId.keys()].sort()).toEqual([1, 2, 3]);
      for (const id of [1, 2, 3]) expect(byId.get(id)).toHaveLength(1);
      expect(byId.get(1)![0]).toEqual(publicationFailureFrame(1));
      expect(byId.get(2)![0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["t"]);
      expect(byId.get(3)![0].result).toBeDefined();
      expect(s.stored()).toMatchObject({ complete: true, tools: ["t"] });
    } finally { clearTimeout(timer); bridge.kill("SIGKILL"); }
  }, 40_000);
});
