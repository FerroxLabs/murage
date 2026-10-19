// Memory settings "rebuild-index": the Advanced "Rebuild search index" action. It rewinds the adoption marker and starts the
// same batched re-embedding in the background; progress is the existing status.semantic.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { ADOPTION_MARKER } from "./model-adoption.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const state = vi.hoisted(() => ({ value: "verified" as "verified" | "checking" | "absent" }));
vi.mock("./model-location.ts", async (original) => ({ ...(await original<typeof import("./model-location.ts")>()), bundledModelState: () => state.value }));
const { memoryOwnerRoute, memoryOwnerStatus } = await import("./settings.ts");

const roster = { bots: [{ id: "rebuild-owner", threadId: "rebuild-thread" }], groups: [] };
const owner = () => ownerMemoryTicket();
const rebuild = () => memoryOwnerRoute("/api/memory/action", { action: "rebuild-index" }, owner(), roster) as Promise<any>;
const mode = (value: string) => database().prepare("UPDATE memory_meta SET mode=? WHERE id=1").run(value);
function seed(count: number) {
  const db = database(); db.exec("PRAGMA foreign_keys=OFF");
  const insert = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'indexed','indexed',NULL)");
  for (let i = 0; i < count; i++) insert.run(`rebuild-${i}`);
}
const pending = () => Number((database().prepare("SELECT COUNT(*) AS n FROM memory_projection_receipts WHERE lexical_status='pending' AND embedding_status='pending'").get() as { n: number }).n);
const semantic = () => memoryOwnerStatus(owner(), roster).semantic!;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); state.value = "verified"; mode("active"); });
afterEach(() => closeDatabase());

it("starts the batched run, re-queues every indexed record and reports progress to M of M", async () => {
  seed(1200);
  const answer = await rebuild();
  expect(answer).toMatchObject({ running: true, started: true });
  await vi.waitFor(() => expect(semantic().total).toBe(1200));
  expect(pending()).toBe(1200);
  expect(existsSync(join(DATA_DIR, ADOPTION_MARKER))).toBe(true);
  expect(semantic()).toEqual({ state: "indexing", done: 0, total: 1200 });
  database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE rowid IN (SELECT rowid FROM memory_projection_receipts WHERE embedding_status='pending' LIMIT 700)").run();
  expect(semantic()).toEqual({ state: "indexing", done: 700, total: 1200 });
  database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE embedding_status='pending'").run();
  expect(semantic()).toEqual({ state: "ready", done: 1200, total: 1200 });
});

it("treats a second request while one is running as a no-op", async () => {
  seed(1200);
  const first = await rebuild();
  const second = await rebuild();
  expect(first.started).toBe(true);
  expect(second).toEqual({ running: true, started: false });
  await vi.waitFor(() => expect(semantic().total).toBe(1200));
  expect(pending()).toBe(1200);
});

it("refuses with a plain reason when the model is not ready", async () => {
  state.value = "absent";
  seed(5);
  await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not ready") });
  expect(pending()).toBe(0);
  state.value = "checking";
  await expect(rebuild()).rejects.toMatchObject({ status: 409 });
});

it("refuses when memory is off", async () => {
  mode("off");
  seed(5);
  await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Memory is off") });
  expect(pending()).toBe(0);
});
