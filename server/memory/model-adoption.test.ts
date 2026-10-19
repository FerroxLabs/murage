import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ADOPTION_MARKER, adoptBundledModel, adoptionComplete, semanticIndexStatus } from "./model-adoption.ts";
import { semanticStatusPhrase } from "../../shared/memory-learning-contract.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const manifest = { revision: "b".repeat(40) };
function seed(count: number, status = "unavailable") {
  const db = database(); db.exec("PRAGMA foreign_keys=OFF");
  const insert = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'indexed',?,NULL)");
  for (let i = 0; i < count; i++) insert.run(`adopt-${i}`, status);
}
const pending = () => Number((database().prepare("SELECT COUNT(*) AS n FROM memory_projection_receipts WHERE embedding_status='pending'").get() as { n: number }).n);
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

it("re-queues every lexical-only record in bounded batches, yielding between them, then marks completion durably", async () => {
  seed(25);
  let yields = 0; const real = globalThis.setImmediate;
  (globalThis as any).setImmediate = (fn: () => void) => { yields += 1; return real(fn); };
  try { await adoptBundledModel(manifest, { batch: 10 }); } finally { globalThis.setImmediate = real; }
  expect(pending()).toBe(25);
  expect(yields).toBeGreaterThanOrEqual(2);
  expect(existsSync(join(DATA_DIR, ADOPTION_MARKER))).toBe(true);
  expect(adoptionComplete(manifest.revision)).toBe(true);
});

it("does nothing more once marked, and attaches exactly one run to concurrent callers", async () => {
  seed(5);
  const [a, b, c] = [adoptBundledModel(manifest), adoptBundledModel(manifest), adoptBundledModel(manifest)];
  expect(a).toBe(b); expect(b).toBe(c);
  await a;
  database().prepare("UPDATE memory_projection_receipts SET embedding_status='unavailable'").run();
  await adoptBundledModel(manifest);
  expect(pending()).toBe(0); // marker present: later unavailable records are left to the normal flow
});

it("leaves records that are not lexical-only alone", async () => {
  seed(3, "indexed");
  await adoptBundledModel(manifest);
  expect(pending()).toBe(0);
});

// 1.0.3 I0: status.semantic, "Indexing for smart search, N of M" while the adopted records embed.
const ready = { nativeSupported: true, model: "ready" as const, revision: manifest.revision };
const indexed = (count: number) => database().prepare(`UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed'
  WHERE rowid IN (SELECT rowid FROM memory_projection_receipts WHERE embedding_status='pending' LIMIT ?)`).run(count);

it("semantic: keyword-only without the native model, and getting ready while the model is checked or not yet adopted", () => {
  expect(semanticIndexStatus({ ...ready, nativeSupported: false })).toEqual({ state: "keyword-only", done: 0, total: 0 });
  for (const model of ["missing", "failed", "downloading"] as const) expect(semanticIndexStatus({ ...ready, model }).state).toBe("keyword-only");
  expect(semanticIndexStatus({ ...ready, model: "unverified" })).toEqual({ state: "indexing", done: 0, total: 0 });
  expect(semanticIndexStatus(ready)).toEqual({ state: "indexing", done: 0, total: 0 });
  expect(semanticStatusPhrase(semanticIndexStatus(ready))).toBe("Getting smart search ready.");
});

it("semantic: counts the adopted records as they embed, then stays ready for everyday indexing", async () => {
  seed(25);
  await adoptBundledModel(manifest, { batch: 10 });
  expect(semanticIndexStatus(ready)).toEqual({ state: "indexing", done: 0, total: 25 });
  indexed(10);
  expect(semanticIndexStatus(ready)).toEqual({ state: "indexing", done: 10, total: 25 });
  expect(semanticStatusPhrase(semanticIndexStatus(ready))).toBe("Indexing for smart search, 10 of 25.");
  indexed(15);
  expect(semanticIndexStatus(ready)).toEqual({ state: "ready", done: 25, total: 25 });
  // a memory learned afterwards is everyday indexing, not "indexing for smart search"
  database().prepare("INSERT INTO memory_projection_receipts VALUES('later',1,0,'pending','pending',NULL)").run();
  expect(semanticIndexStatus(ready)).toEqual({ state: "ready", done: 25, total: 25 });
  expect(semanticIndexStatus({ ...ready, model: "unverified" }).state).toBe("ready"); // the next start's check, already caught up
  // another revision has not been adopted
  expect(semanticIndexStatus({ ...ready, revision: "c".repeat(40) })).toEqual({ state: "indexing", done: 0, total: 0 });
});
