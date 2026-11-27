// q1022-disk item 5: after a model change is adopted, the old model's vectors are deleted. Driven through MemoryIndex.vector,
// the write the worker's embedding loop makes for every re-queued record (worker.ts:299), on a real index file.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { IndexedMemory } from "./index.ts";
import { closeSealed, openTestIndex, put } from "./testing/open-index.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index-1022.db");
const entry = (id: string): IndexedMemory => ({ id, version: 1, scopeId: "s", text: `harbour lantern ${id}`, deleted: false });

it("Q22DISK-VEC re-embedding every record with the adopted model leaves no vector of the old model", async () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = await openTestIndex(INDEX_PATH());
  const records = Array.from({ length: 10 }, (_, i) => entry(`r${i}`));
  await put(index, records);
  for (const record of records) await index.vector(record, "model-old", 0, [1, 0, 0]);
  index.prepareModel("model-new");
  // the adoption re-queues every record; the worker embeds each with the new model
  for (const record of records.slice(0, 7)) await index.vector(record, "model-new", 0, [0, 1, 0]);
  const count = () => {
    const db = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    try { return db.prepare("SELECT model,count(*) AS n FROM vectors GROUP BY model ORDER BY model").all().map(row => [row.model, Number(row.n)]); }
    finally { db.close(); }
  };
  // a record not yet re-embedded keeps its old vector: nothing goes before its replacement is in
  expect(count(), "Q22DISK-VEC vectors per model mid-adoption").toEqual([["model-new", 7], ["model-old", 3]]);
  for (const record of records.slice(7)) await index.vector(record, "model-new", 0, [0, 1, 0]);
  expect(count(), "Q22DISK-VEC vectors per model after adoption").toEqual([["model-new", 10]]);
  const found = index.search("nothing", records.map(r => ({ id: r.id, version: 1 })), [0, 1, 0], "model-new", 20);
  expect(found.hits.length).toBe(10);
  await closeSealed(index);
});
