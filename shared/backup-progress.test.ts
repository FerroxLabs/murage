// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createBackupProgressReporter, createBackupStepLog, normalizeBackupProgress, safeBackupProgress } from "./backup-progress.mjs";

it("a new step goes out at once, repeats of a step are held to the interval", () => {
  const sent: unknown[] = [];
  let time = 1000;
  const report = createBackupProgressReporter(note => { sent.push(note); }, { now: () => time, minIntervalMs: 500 });
  report("encrypt", 0, 100);
  time = 1100; report("encrypt", 10, 100);
  time = 1600; report("encrypt", 20, 100);
  time = 1650; report("readback");
  expect(sent).toEqual([
    { step: "encrypt", elapsedMs: 0, done: 0, total: 100 },
    { step: "encrypt", elapsedMs: 600, done: 20, total: 100 },
    { step: "readback", elapsedMs: 650 },
  ]);
});

it("a note that can't be sent never reaches the backup as an error", () => {
  const report = createBackupProgressReporter(() => { throw new Error("the desktop has gone"); });
  expect(() => report("encrypt", 1, 2)).not.toThrow();
  expect(() => safeBackupProgress(() => { throw new Error("no"); })("x")).not.toThrow();
  expect(() => safeBackupProgress(undefined)("x")).not.toThrow();
});

it("only the known shape is taken from a note", () => {
  expect(normalizeBackupProgress({ type: "x", step: "encrypt", elapsedMs: 5, done: 12, total: 10, extra: "/home/sam" })).toEqual({ step: "encrypt", elapsedMs: 5, done: 10, total: 10 });
  expect(normalizeBackupProgress({ step: "encrypt", elapsedMs: 5, done: 1 })).toEqual({ step: "encrypt", elapsedMs: 5 });
  for (const raw of [null, "encrypt", {}, { step: "nonsense", elapsedMs: 1 }, { step: "__proto__", elapsedMs: 1 }, { step: "encrypt", elapsedMs: -1 }, { step: "encrypt", elapsedMs: 1.5 }]) expect(normalizeBackupProgress(raw)).toBeNull();
});

it("one line as each step ends, timed by the worker's clock, with the bytes it reached", () => {
  const lines: string[] = [];
  const note = createBackupStepLog({ job: "abcd1234", log: line => lines.push(line) });
  note({ step: "database-copy", elapsedMs: 100 });
  note({ step: "database-copy", elapsedMs: 600, done: 40, total: 90 });
  note({ step: "database-copy", elapsedMs: 900, done: 90, total: 90 });
  note({ step: "database-clean", elapsedMs: 1000 });
  note({ step: "nonsense", elapsedMs: 5000 });
  note({ step: "done", elapsedMs: 4000 });
  expect(lines).toEqual([
    'backup step {"job":"abcd1234","step":"database-copy","ms":900,"bytes":90}',
    'backup step {"job":"abcd1234","step":"database-clean","ms":3000}',
  ]);
});
