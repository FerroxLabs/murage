import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { memoryHealth } from "./health.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  setMemoryMode("capture");
});

function access() {
  const registry = new InternalCapabilities();
  const generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

function capture(id = `source:${randomUUID()}`, text = "Durable evidence") {
  captureSource(database(), { id, threadId: "thread", messageId: randomUUID(), kind: "text", speaker: "owner", outcome: "recorded", text });
  return id;
}

function publish() {
  const work = claimMemoryJob("health-test");
  if (!work) throw new Error("Expected a captured source to produce a memory job");
  publishMemoryWork(work, "health-test", captureWork(work));
  return work;
}

function publishedBridge(): MemorySearchBridge {
  const record = database().prepare("SELECT id,version FROM memory_records WHERE state='active' ORDER BY rowid DESC LIMIT 1").get();
  if (!record) throw new Error("Expected real capture publication to create a record");
  return { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 1 }) };
}

it("reports current v2 sources as captured before their real capture job is published, then as processed", () => {
  const id = capture("source:revision", "Initial evidence");
  // A new source version retires the old pending job. Health must describe the
  // current source only, rather than count both historical revisions.
  capture(id, "Current evidence");

  expect(database().prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()).toEqual({ schema_version: 2 });
  expect(memoryHealth("extractor")).toMatchObject({
    captured: { sources: 1 },
    processed: { sources: 0, lastAt: null },
  });

  publish();
  const health = memoryHealth("extractor");
  expect(health.captured.sources).toBe(1);
  expect(health.processed.sources).toBe(1);
  expect(health.processed.lastAt).not.toBeNull();
});

it("keeps retrieval, prepared disclosure, and accepted supplied context as distinct evidence", async () => {
  capture();
  publish();
  setMemoryMode("active");
  const db = database();
  db.prepare("UPDATE memory_records SET owner_pinned=1 WHERE state='active'").run();
  const currentAccess = access();

  const retrieved = await searchMemory("durable", currentAccess, publishedBridge());
  expect(retrieved.hits).toHaveLength(1);
  expect(memoryHealth("extractor")).toMatchObject({
    retrieved: { available: true, queries: 1, hits: 1 },
    supplied: { turns: 0, references: 0, lastAt: null },
  });

  const supplied = await buildMemoryBundle("durable", currentAccess, publishedBridge());
  expect(supplied.recordVersions).toHaveLength(1);
  const receipt = new MemoryDispatchReceipt(supplied, currentAccess, "health-engine");
  expect(memoryHealth("extractor").supplied).toMatchObject({ turns: 0, references: 0, lastAt: null });
  receipt.completed(true);
  expect(memoryHealth("extractor").supplied).toMatchObject({ turns: 1, references: 1 });
});

it("does not count even an accepted empty bundle as supplying memories", async () => {
  setMemoryMode("active");
  const currentAccess=access();
  const empty=await buildMemoryBundle("nothing matches",currentAccess,{search:async()=>({hits:[],vectorRows:0})});
  expect(empty.recordVersions).toEqual([]);
  const receipt=new MemoryDispatchReceipt(empty,currentAccess,"health-engine");
  receipt.completed(true);
  expect(memoryHealth("extractor").supplied).toMatchObject({turns:0,references:0,lastAt:null});
});

it("reports unavailable counters when no observability binding exists and preserves successful work when its write fails", async () => {
  const db = database();
  expect(memoryHealth("extractor").retrieved).toEqual({ available: false, queries: 0, hits: 0, lastAt: null });
  db.exec(`CREATE TRIGGER fail_memory_observability BEFORE INSERT ON memory_scope_bindings
    WHEN NEW.id='memory-observability' BEGIN SELECT RAISE(ABORT, 'injected observability failure'); END;`);

  capture();
  publish();
  setMemoryMode("active");
  const currentAccess = access();
  await expect(searchMemory("durable", currentAccess, publishedBridge())).resolves.toMatchObject({ hits: expect.any(Array) });
  expect(db.prepare("SELECT status FROM memory_jobs").get()).toEqual({ status: "complete" });
  expect(memoryHealth("extractor").retrieved).toEqual({ available: false, queries: 0, hits: 0, lastAt: null });
});

it("states disabled, unconfigured, configured, and budget-limited synthesis truthfully", () => {
  const db = database();
  const update = (patch: unknown) => updateMemoryLearning(db, patch, readMemoryLearning(db).revision);

  update({ automaticFacts: false, automaticProcedures: false });
  expect(memoryHealth("extractor").synthesis).toMatchObject({ state: "disabled", reason: "Automatic learning is disabled." });

  update({ automaticFacts: true });
  expect(memoryHealth(null).synthesis.state).toBe("not-configured");
  expect(memoryHealth("extractor").synthesis.state).toBe("configured");

  update({ callsPerMinute: 0 });
  expect(memoryHealth("extractor").synthesis).toMatchObject({ state: "budget-limited", reason: "A configured token or call limit prevents synthesis." });
});
