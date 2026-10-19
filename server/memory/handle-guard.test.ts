// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 lane 3 (stall r3): a connection closed while the reflection pass walked (it hands the loop back between pages) threw out of
// runPipReflect and was recorded as a continuity failure. The pass now ends quietly; an error on a live connection is still thrown.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { endsWithHandle } from "./handle-guard.ts";

it("a walk that meets its connection closed part-way ends quietly", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(x)");
  const result = await endsWithHandle(db, () => false, async () => {
    await new Promise(resolve => setImmediate(resolve));
    db.close(); // a restore or shutdown while the loop was handed back
    await new Promise(resolve => setImmediate(resolve));
    return db.prepare("SELECT x FROM t").all(); // throws: the database is not open
  });
  expect(result).toBeUndefined();
});

it("a connection replaced part-way ends the walk quietly too", async () => {
  const db = new DatabaseSync(":memory:");
  let current = db;
  const result = await endsWithHandle(db, () => current !== db, async () => { current = new DatabaseSync(":memory:"); throw new Error("stale handle"); });
  expect(result).toBeUndefined();
});

it("an error on the live connection is the walk's own and is thrown", async () => {
  const db = new DatabaseSync(":memory:");
  await expect(endsWithHandle(db, () => false, async () => db.prepare("SELECT * FROM missing").all())).rejects.toThrow(/no such table/);
  expect(await endsWithHandle(db, () => false, async () => 7)).toBe(7);
});

it("the server's reflection pass runs both of its walks through the guard", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  // 1.0.3 pip-epoch passes the pass's abort signal into the sliced pending check; the guard wraps it unchanged
  expect(source).toMatch(/endsWithHandle\(handle, replaced, \(\) => pipReflectPendingSliced\(pipReflectDeps, undefined, signal\)\)/);
  expect(source).toMatch(/endsWithHandle\(handle, replaced, \(\) => runPipReflect\(pipReflectDeps, botId, signal\)\)/);
});
