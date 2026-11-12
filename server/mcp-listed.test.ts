import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { createMcpCatalogObserver, createMcpCatalogWriter, readMcpCatalog, mcpMarkerReady, registerCloudMcpCatalog, retireCloudMcpCatalog, publishCloudMcpCatalog } from "./mcp-listed.ts";
const fixture = () => { const path = join(mkdtempSync(join(tmpdir(), "c11-marker-")), "generation.mount"); return { path, observer: createMcpCatalogObserver({ MURAGE_MCP_LISTED_FILE: path }) }; };
type Obs = ReturnType<typeof createMcpCatalogObserver>;
const commitNow = async (o: Obs, frame: unknown) => { const t = o.beforeResponse(frame); await t.published; return t.commit(); };
const list = (id: number | string, cursor?: string) => ({ id, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
const response = (id: number | string, names: string[], nextCursor?: string) => ({ id, result: { tools: names.map(name => ({ name })), ...(nextCursor ? { nextCursor } : {}) } });
describe("C11 catalog generations", () => {
  it("c11-paginated-generation counts every page only after terminal flush", async () => {
    const { path, observer: o } = fixture();
    o.observeRequest({ id: 0, method: "initialize" }); await commitNow(o, { id: 0, result: { capabilities: { resources: {}, tools: {} } } });
    o.observeRequest(list(7)); await commitNow(o, response(7, ["a", "b"], "p2"));
    await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false);
    o.observeRequest(list("7", "p2")); await commitNow(o, response("7", ["b", "c"], "p3"));
    o.observeRequest(list(8, "p3")); const commit = o.beforeResponse(response(8, ["d"]));
    await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false); await commit.commit();
    await o.flush(); expect(readMcpCatalog(path)).toMatchObject({ complete: true, tools: ["a", "b", "c", "d"], resources: true });
    await commitNow(o, response(8, ["wrong"])); await o.flush(); expect(readMcpCatalog(path)?.tools).toEqual(["a", "b", "c", "d"]);
  });
  for (const reverse of [false, true]) it(`c11-overlap remains unknown in either completion order ${reverse}`, async () => {
    const { path, observer: o } = fixture();
    o.observeRequest(list(1)); o.observeRequest(list(2));
    for (const id of reverse ? [1, 2] : [2, 1]) { await commitNow(o, response(id, [String(id)])); await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false); }
    o.observeRequest(list(3)); await commitNow(o, response(3, ["later"])); await o.flush(); expect(readMcpCatalog(path)).toMatchObject({ complete: true, tools: ["later"] });
    const forward = o.beforeResponse({ method: "notifications/tools/list_changed" }); await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false); await forward.commit();
    o.observeRequest(list(4)); await commitNow(o, response(4, [])); await o.flush(); expect(readMcpCatalog(path)).toMatchObject({ complete: true, tools: [] });
  });
  it("c11-missing-page and repeated cursor cannot certify", async () => {
    const { path, observer: o } = fixture();
    o.observeRequest(list(1)); await commitNow(o, response(1, ["a"], "p"));
    o.observeRequest(list(2, "p")); await commitNow(o, response(2, ["b"], "p"));
    await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false);
    o.observeRequest(list(3)); await commitNow(o, response(3, ["c"])); await o.flush(); expect(readMcpCatalog(path)?.complete).toBe(false);
  });
  it("c11-unknown-catalog legacy and absent names never certify zero", async () => {
    const { path } = fixture(); writeFileSync(path, String(Date.now())); expect(mcpMarkerReady(path)).toBe(true); expect(readMcpCatalog(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ v: 2, processGeneration: "generation", catalogGeneration: 1, revision: 1, complete: true })); expect(readMcpCatalog(path)?.complete).toBe(false);
  });
  it("c11-marker-writers publish only at actual successful output flush", async () => {
    const { path } = fixture(); let release: ((error?: Error | null) => void) | undefined;
    const out = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
    const writer = createMcpCatalogWriter({ MURAGE_MCP_LISTED_FILE: path }, out);
    const r1 = writer.observeRequest(list(1)); const sent = r1.respond(response(1, ["served"]));
    await expect.poll(() => typeof release).toBe("function");
    await writer.flush(); expect(readMcpCatalog(path)?.complete).toBe(false); release!(); await sent; expect(readMcpCatalog(path)?.tools).toEqual(["served"]);
    release = undefined; const r2 = writer.observeRequest(list(2)); const failed = r2.respond(response(2, ["unserved"]));
    await expect.poll(() => typeof release).toBe("function");
    out.on("error", () => {}); release!(new Error("fixture flush failure")); await expect(failed).rejects.toThrow(); expect(readMcpCatalog(path)?.complete).toBe(false);
  });
});

it("first paginated response does not satisfy readiness before terminal flush", async () => {
  const { path, observer } = fixture();
  observer.observeRequest({ id: 1, method: "tools/list" });
  await commitNow(observer, { id: 1, result: { tools: [{ name: "first" }], nextCursor: "next" } });
  await observer.flush(); expect(readMcpCatalog(path)?.ready).toBe(false);
  observer.observeRequest({ id: 2, method: "tools/list", params: { cursor: "next" } });
  const flush = observer.beforeResponse({ id: 2, result: { tools: [{ name: "last" }] } });
  await observer.flush(); expect(readMcpCatalog(path)?.ready).toBe(false);
  await flush.commit();
  await observer.flush(); expect(readMcpCatalog(path)).toMatchObject({ ready: true, complete: true, tools: ["first", "last"] });
});

it("c11-review-4 historical and concurrent registrations never evict a live publisher", () => {
  const root = mkdtempSync(join(tmpdir(), "c11-live-catalog-"));
  const live = join(root, "live.mount");
  const key = registerCloudMcpCatalog(live, "owner", "http://127.0.0.1").split("/").at(-1)!;
  const paths: string[] = [];
  try {
    for (let i = 0; i < 4100; i++) {
      const path = join(root, `turn${i}.mount`); paths.push(path);
      registerCloudMcpCatalog(path, "history", "http://127.0.0.1");
    }
    for (const path of paths) retireCloudMcpCatalog(path);
    const doc = { v: 2, processGeneration: "live", catalogGeneration: 1, revision: 1, at: 1, ready: true, complete: true, tools: ["still-live"], resources: false };
    expect(publishCloudMcpCatalog(key, "owner", doc)).toBe(true);
    expect(readMcpCatalog(live)?.tools).toEqual(["still-live"]);
    retireCloudMcpCatalog(live);
    expect(publishCloudMcpCatalog(key, "owner", { ...doc, revision: 2 })).toBe(false);
  } finally { retireCloudMcpCatalog(live); for (const path of paths) retireCloudMcpCatalog(path); }
});
