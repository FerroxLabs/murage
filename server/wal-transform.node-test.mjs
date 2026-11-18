// SPDX-License-Identifier: AGPL-3.0-or-later
// node:test adapter witnesses. Run: node --import ./server/testing/wal-transform-preload.mjs --test server/wal-transform.node-test.mjs (Node 24).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { TRANSFORM_MARKER, transformWalSource } from "./testing/wal-transform.mjs";

const PROD = ["server/wal-maintenance.ts", "server/io-budget.ts", "server/admission-shared.ts"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const before = new Map(PROD.map((f) => [f, sha(readFileSync(f))]));

test("W-transform-applied (node:test adapter): the string passed to new Worker is the transformed worker source", async () => {
  const sources = [];
  const builtin = process.getBuiltinModule("node:worker_threads");
  const Real = builtin.Worker;
  builtin.Worker = class extends Real { constructor(source, options) { if (typeof source === "string") sources.push(source); super(source, options); } };
  syncBuiltinESMExports();
  try {
    const wal = await import("./wal-maintenance.ts");
    const dir = mkdtempSync(join(tmpdir(), "wal-transform-nt-"));
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
    wal.startWalMaintenance(file, { setAutocheckpoint() {}, nudge: async () => false });
    await new Promise((r) => setTimeout(r, 200));
    await wal.stopWalMaintenance();
    db.close();
  } finally { builtin.Worker = Real; syncBuiltinESMExports(); }
  assert.ok(sources.length > 0, "a worker was created");
  assert.ok(sources.some((s) => s.includes(`/*${TRANSFORM_MARKER}*/`)), "the marker is in the worker source");
});

test("W-prod-untouched (node:test adapter)", () => {
  const head = process.env.WAL_PROD_HEAD_DIR;
  assert.ok(head, "WAL_PROD_HEAD_DIR names a directory of git show HEAD copies");
  for (const f of PROD) {
    assert.equal(sha(readFileSync(f)), sha(readFileSync(join(head, f))), `${f} differs from HEAD`);
    assert.equal(sha(readFileSync(f)), before.get(f), `${f} changed during the run`);
  }
});

// A writable target proves accidental persistence is detected after the write, rather than stopped by filesystem permissions.
test("W-prod-untouched writable target (node:test adapter)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-transform-write-"));
  try {
    mkdirSync(join(dir, "server"));
    const file = join(dir, "server/wal-maintenance.ts");
    const source = readFileSync("server/wal-maintenance.ts", "utf8");
    writeFileSync(file, source);
    const transformed = transformWalSource(file, source);
    assert.ok(transformed.includes(`/*${TRANSFORM_MARKER}*/`), "the target was transformed");
    assert.equal(sha(readFileSync(file)), sha(source), "the writable input stayed byte-identical after transformation");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
