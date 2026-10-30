import { expect, it } from "vitest";
import { MAX_BACKUP_DURATION_MS, backupBudgetArgument, decideBackupBudget, readBackupBudgetArgument, withoutBackupBudgetArgument } from "./backup-budget.mjs";

const MIN = 60_000, GIB = 1024 ** 3, STORED = 30 * MIN, ID = "12345678-1234-4234-8234-123456789abc";

it("gives Sean's backup more than the 28:50 it took", () => {
  expect(decideBackupBudget({ storedMs: STORED, lastBytes: 9_282_964_648 })).toBe(Math.ceil(8 * MIN * (9_282_964_648 / GIB) + 10 * MIN));
  expect(decideBackupBudget({ storedMs: STORED, lastRunMs: 28 * MIN + 50_000 })).toBe(67 * MIN + 40_000);
  expect(decideBackupBudget({ storedMs: STORED, lastBytes: 9_282_964_648, lastRunMs: 28 * MIN + 50_000 })).toBeGreaterThan(79 * MIN);
});
it("takes the larger size and never goes under the stored limit or over 4 hours", () => {
  expect(decideBackupBudget({ storedMs: STORED, lastBytes: GIB, liveBytes: 10 * GIB })).toBe(90 * MIN);
  expect(decideBackupBudget({ storedMs: STORED, liveBytes: 1024 })).toBe(STORED);
  expect(decideBackupBudget({ storedMs: STORED })).toBe(STORED);
  expect(decideBackupBudget({ storedMs: MIN, liveBytes: 0 })).toBe(10 * MIN);
  expect(decideBackupBudget({ storedMs: STORED, liveBytes: 1024 ** 4 })).toBe(MAX_BACKUP_DURATION_MS);
});
it("is always a whole number of milliseconds", () => {
  const budget = decideBackupBudget({ storedMs: STORED, liveBytes: 3 * GIB + 4096 });
  expect(Number.isSafeInteger(budget)).toBe(true);
  expect(budget).toBeGreaterThan(34 * MIN);
});
it.each([
  ["lastBytes", Number.NaN], ["lastBytes", -1], ["lastBytes", 1.5], ["lastBytes", 1024 ** 4 + 1], ["lastBytes", "9"], ["lastBytes", null],
  ["liveBytes", Number.POSITIVE_INFINITY], ["liveBytes", -5], ["lastRunMs", -1], ["lastRunMs", 4 * 60 * MIN + 1], ["lastRunMs", Number.NaN],
])("wrong %s %s means today's limit, even with good terms beside it", (key, value) => {
  expect(decideBackupBudget({ storedMs: STORED, lastBytes: 10 * GIB, [key]: value } as never)).toBe(STORED);
});
it.each([[undefined], [Number.NaN], [0], [999], [30 * MIN + 1], [1.5], ["1800000"]])("refuses a stored limit of %s", storedMs => {
  expect(() => decideBackupBudget({ storedMs, lastBytes: GIB } as never)).toThrow("INVALID_BACKUP_BUDGET");
});
it("reads back only one value, for this handoff, in range", () => {
  const good = backupBudgetArgument(ID, 79 * MIN);
  expect(readBackupBudgetArgument(["--x", good], ID, STORED)).toBe(79 * MIN);
  expect(readBackupBudgetArgument([], ID, STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([good, good], ID, STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([good], "22345678-1234-4234-8234-123456789abc", STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([good], undefined, STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([backupBudgetArgument(ID, 10 * MIN)], ID, STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([backupBudgetArgument(ID, MAX_BACKUP_DURATION_MS + 1)], ID, STORED)).toBe(STORED);
  expect(readBackupBudgetArgument([backupBudgetArgument(ID, MAX_BACKUP_DURATION_MS)], ID, STORED)).toBe(MAX_BACKUP_DURATION_MS);
  for (const bad of ["--murage-backup-budget=", "--murage-backup-budget=" + ID, `--murage-backup-budget=${ID}:1e9`, `--murage-backup-budget=${ID}:-1`, `--murage-backup-budget=${ID}:60000000\n`, `--murage-backup-budget=${ID}:60000000\r`, `--murage-backup-budget=${ID}:90000000000000000000`]) expect(readBackupBudgetArgument([bad], ID, STORED)).toBe(STORED);
});
it("every relaunch drops the value", () => {
  expect(withoutBackupBudgetArgument(["a", backupBudgetArgument(ID, 1000), "--murage-backup-mode"])).toEqual(["a", "--murage-backup-mode"]);
});
