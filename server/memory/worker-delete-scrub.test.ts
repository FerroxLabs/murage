// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeTempDirSync } from "../testing/cleanup.ts";

const state = vi.hoisted(() => ({ scrubbed: false, pending: false, blocked: true, attempts: [] as number[], throws: false, calls: [] as string[], indexFactory: null as null | ((path: string) => unknown) }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class {
  identity = "fixture";
  embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); }
} }));
vi.mock("./index.ts", () => ({ MemoryIndex: function(path: string) {
  if (state.indexFactory) return state.indexFactory(path);
  return {
    rebuilt: false,
    prepareModel() {},
    upsert(records: Array<{deleted:boolean;rolled?:boolean}>) { state.calls.push("remove"); if(records.some(row=>row.deleted&&!row.rolled))state.pending=true; },
    vector() {},
    deletionScrubPending() { return state.pending; },
    get scrubBlocked() { return state.blocked; },
    scrubDeleted() { state.calls.push("scrub"); state.attempts.push(Date.now()); if (state.throws) throw new Error("fixture scrub failure"); if(state.scrubbed)state.pending=false; return state.scrubbed; },
    purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; },
    maintenanceOwed() { return false; },
    purgeRecords() {},
    close() {},
  };
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

type Reply = { type: string; requestId?: string; scrubOwed?: boolean; records?: Array<{ id: string; deleted: boolean }> };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

async function fixture(options: { indexPath: string; indexFactory: (path: string) => unknown } | undefined = undefined) {
  vi.resetModules(); state.scrubbed = false; state.throws = false; state.pending = false; state.blocked = true; state.attempts.length = 0; state.calls.length = 0;
  state.indexFactory = options?.indexFactory ?? null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Reply[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { listeners.set(event, listener); return workerProcess; } },
    send: { value: (message: Reply) => { if (message.type !== "io") state.calls.push(message.type); /* io is write telemetry, not part of the order under test */ sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  await import("./worker.ts");
  const emit = listeners.get("message")!;
  emit({ type: "init", indexPath: options?.indexPath ?? "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  state.calls.length = 0;
  return { emit, sent };
}
const row = (id: string, extra: object = {}) => ({ id, version: 1, scopeId: "scope", text: "", deleted: true, ...extra });

// MEMDEL-SIMPLIFY-109: a batch is acknowledged as soon as its rows are written or removed. An owner forget's physical scrub is the
// index's own durable debt (written with the removal) and is drained by the helper's scrub timer, apart from every batch.
it("acknowledges every row at once, an owner forget included, and drains its scrub on the timer", async () => {
  const { emit, sent } = await fixture();
  state.blocked = false; state.scrubbed = false;
  emit({ type: "index", requestId: "batch", records: [row("gone"), row("rolled", { rolled: true }), row("live", { deleted: false, text: "retained" })] });
  await vi.advanceTimersByTimeAsync(1);
  const result = sent.find(message => message.requestId === "batch")!;
  expect(result.records?.map(record => record.id)).toEqual(["gone", "rolled", "live"]);
  expect(result.scrubOwed).toBe(true);
  expect(state.calls).toEqual(["remove", "index-result"]);
  await vi.advanceTimersByTimeAsync(50);
  expect(state.calls).toEqual(["remove", "index-result", "scrub"]);
  state.scrubbed = true;
  await vi.advanceTimersByTimeAsync(50);
  expect(state.calls).toEqual(["remove", "index-result", "scrub", "scrub", "scrub-done"]);
});

it("ordinary checkpoint rollover retains stepped maintenance without an owner-deletion scrub", async () => {
  const { emit, sent } = await fixture();
  emit({ type: "index", requestId: "roll", records: [row("rolled", { rolled: true })] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent.find(message => message.requestId === "roll")).toMatchObject({ scrubOwed: false, records: [{ id: "rolled" }] });
  expect(state.calls).toEqual(["remove", "index-result"]);
});

it("a blocked or failing scrub backs off 1 s doubling to one minute while captures and index batches keep running", async () => {
  const {emit,sent}=await fixture();
  vi.spyOn(console,"error").mockImplementation(()=>{});
  emit({type:"index",requestId:"forget",records:[row("gone")]});
  await vi.advanceTimersByTimeAsync(60);
  expect(state.attempts).toHaveLength(1);
  state.throws=true;
  for(let n=0;n<3;n++){
    emit({type:"index",requestId:`live-${n}`,records:[row(`live-${n}`,{deleted:false,text:"retained capture"})]});
    await vi.advanceTimersByTimeAsync(250);
  }
  emit({id:"capture-other-chat",sourceId:"fixture-source",revision:1,leaseGeneration:1,policyRevision:0,deletionEpoch:0,
    scopeId:"another-chat",stage:"capture",kind:"text",speaker:"owner",outcome:"recorded",cursor:0,totalBytes:8,text:"retained"});
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(()=>expect(sent.some(message=>message.type==='result')).toBe(true));
  expect(sent.filter(message=>message.requestId?.startsWith("live-")).every(message=>message.records?.length===1)).toBe(true);
  await vi.advanceTimersByTimeAsync(200_000);
  const gaps=state.attempts.slice(1).map((at,n)=>at-state.attempts[n]!);
  expect(gaps.slice(0,7)).toEqual([1000,2000,4000,8000,16000,32000,60000]);
  expect(state.pending).toBe(true);
  // The idle retry finishes without requiring another forget batch.
  state.throws=false;state.scrubbed=true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.pending).toBe(false);
  expect(sent.some(message=>message.type==='scrub-done')).toBe(true);
});

it("the real worker acknowledges a forget at once and its scrub timer erases database, WAL and SHM bytes once a reader lets go", async () => {
  const { MemoryIndex } = await vi.importActual<typeof import("./index.ts")>("./index.ts");
  const root = mkdtempSync(join(tmpdir(), "worker-delete-scrub-")), path = join(root, "index.db");
  let index: InstanceType<typeof MemoryIndex> | undefined, reader: DatabaseSync | undefined;
  const marker = "orchidworkerfixture";
  const copies = () => [path, `${path}-wal`, `${path}-shm`].map(file => ({ file, found: existsSync(file) && readFileSync(file).includes(Buffer.from(marker)) }));
  try {
    const { emit, sent } = await fixture({ indexPath: path, indexFactory: file => (index = new MemoryIndex(file)) });
    expect(sent.find(message => message.type === "initialised")?.scrubOwed).toBe(false);
    emit({ type: "index", requestId: "seed", records: [row("gone", { deleted: false, text: marker }), row("kept", { deleted: false, text: "retained fixture" })] });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.find(message => message.requestId === "seed")?.records).toHaveLength(2);
    expect(copies().some(copy => copy.found)).toBe(true);
    reader = new DatabaseSync(path); reader.exec("BEGIN"); reader.prepare("SELECT text FROM entries").all();
    emit({ type: "index", requestId: "forget", records: [row("gone")] });
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.find(message => message.requestId === "forget")).toMatchObject({ scrubOwed: true, records: [{ id: "gone", version: 1, deleted: true }] });
    // The pinned reader holds the checkpoint: the debt stays and retries; other batches are acknowledged meanwhile.
    await vi.advanceTimersByTimeAsync(5000);
    emit({type:"index",requestId:"retained-while-blocked",records:[row("other-live",{deleted:false,text:"other retained capture"})]});
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.find(message=>message.requestId==='retained-while-blocked')?.records).toHaveLength(1);
    expect(index!.deletionScrubPending()).toBe(true);
    expect(sent.some(message => message.type === "scrub-done")).toBe(false);
    reader.exec("COMMIT"); reader.close(); reader = undefined;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(index!.deletionScrubPending()).toBe(false);
    expect(sent.some(message => message.type === "scrub-done")).toBe(true);
    // The writer remains open so last-close checkpointing cannot hide a missed scrub.
    for (const copy of copies()) expect(copy.found, copy.file).toBe(false);
    expect(index!.search("retained", [{ id: "kept", version: 1 }], null, "unused").hits.map(hit => hit.id)).toEqual(["kept"]);
  } finally {
    vi.clearAllTimers(); reader?.close(); index?.close(); removeTempDirSync(root);
  }
});

it("boot resumes durable merge debt without a projection batch and scrubs raw bytes", async () => {
  const {MemoryIndex}=await vi.importActual<typeof import("./index.ts")>("./index.ts");
  const root=mkdtempSync(join(tmpdir(),"worker-scrub-boot-")),path=join(root,"index.db"),marker="orchidworkerbootfixture";
  let index:InstanceType<typeof MemoryIndex>|undefined;
  try{
    const seed=new MemoryIndex(path);
    seed.upsert([row("gone",{deleted:false,text:marker})]);
    seed.upsert([row("gone")]);
    expect(seed.deletionScrubPending()).toBe(true);
    seed.close();
    const {sent}=await fixture({indexPath:path,indexFactory:file=>(index=new MemoryIndex(file))});
    expect(sent.find(message=>message.type==='initialised')?.scrubOwed).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.some(message=>message.type==='scrub-done')).toBe(true);
    expect(index!.deletionScrubPending()).toBe(false);
    expect(sent.some(message=>message.type==='index-result')).toBe(false);
    for(const file of [path,`${path}-wal`,`${path}-shm`]){
      expect(existsSync(file)&&readFileSync(file).includes(Buffer.from(marker)),file).toBe(false);
    }
  }finally{vi.clearAllTimers();index?.close();removeTempDirSync(root);}
});
