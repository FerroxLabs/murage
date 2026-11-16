// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";

// Execute the production initializer without opening SQLite or starting its scheduler.
const source = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
const initializer = source.slice(source.indexOf("const admission = workerData.admission"), source.indexOf("const osPageSize ="));
const admission = (workerData: object) => runInNewContext(initializer + "\nadmission;", {
  workerData, gen: 1, performance, require: () => ({ threadId: 1 }),
}) as ReturnType<typeof checkpointLedger>;

it.each([
  ["both missing", {}],
  ["buffer missing", { admissionSource: checkpointLedger.toString() }],
  ["producer missing", { admission: new SharedArrayBuffer(256) }],
  ["producer empty", { admission: new SharedArrayBuffer(256), admissionSource: "" }],
] as const)("F5-no-ledger: missing admission data refuses both acquisition and settlement (%s)", (_label, data) => {
  const ledger = admission(data);
  for (const act of [() => ledger.beginCopy(4096, Date.now()), () => ledger.endCopy({ minute: 0, ceiling: 0 } as never, 0, 0, undefined, Date.now())]) {
    let failure: unknown;
    try { act(); } catch (error) { failure = error; }
    expect(failure, "no successful ticket or no-op settlement without a ledger").toMatchObject({ name: "AdmissionLockTimeout" });
  }
});

it("F5-no-ledger: a complete ledger still uses the audited producer", () => {
  const buffer = new SharedArrayBuffer(256), slots = new BigInt64Array(buffer);
  slots[1] = BigInt(Math.floor(Date.now() / 60_000));
  const ledger = admission({ admission: buffer, admissionSource: checkpointLedger.toString() });
  expect(typeof ledger.lock).toBe("function");
  expect(ledger.slots.buffer).toBe(buffer);
});
