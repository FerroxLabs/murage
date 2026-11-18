// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), row C1: a floor refusal published by the checkpointer worker keeps its type through both
// write wrappers (withBusyBudget and transaction), while a log that only lags stays a plain DatabaseBusyError.
// The floor leg needs a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA) and is skipped elsewhere; the negative control runs anywhere.
// HEADLESS ONLY: a child process on a throwaway data dir.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WAL_ADMISSION_BYTES } from "./wal-maintenance.ts";
import { STRICT, onStrictMount } from "./testing/strict-fs.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "testing", "low-disk-classify-child.ts");
function child(scenario: string, dataDir: string, ballast = ""): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD, scenario, ballast], {
    encoding: "utf8", timeout: 120_000,
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: dataDir, USERPROFILE: dataDir, MURAGE_DATA_DIR: join(dataDir, ".murage"), LOW_DISK_CLASSIFY_CHILD: "1" },
  });
  const line = result.stdout.split("\n").find(l => l.startsWith("C1RESULT "));
  expect(line, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`).toBeDefined();
  return JSON.parse(line!.slice("C1RESULT ".length)) as Record<string, unknown>;
}

describe("C1 a worker-published floor refusal keeps its type through both wrappers", () => {
  it.skipIf(!onStrictMount)("under the worker's floor, in a normal start, both wrappers throw DiskFloorRefusal", { timeout: 180_000 }, () => {
    const dir = join(STRICT, "c1"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    try {
      const result = child("floor", dir, join(dir, "ballast"));
      expect(result).toMatchObject({
        startMode: "normal", ready: true, verdict: "DiskFloorRefusal",
        viaBudget: "DiskFloorRefusal", viaTransaction: "DiskFloorRefusal", budgetLow: true, transactionLow: true, readOnly: false, bootRecoveryRefused: true,
      });
      expect(result.bootRecoveryRoom, "the disk floor, not an exhausted byte allowance, refused recovery").toBeGreaterThanOrEqual(64 * 1024);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("negative control: a lagging log with ample space is a DatabaseBusyError, not a DiskFloorRefusal", { timeout: 180_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-c1-"));
    try {
      const result=child("lag",dir);
      expect(result).toMatchObject({startMode:"normal",ready:true,lag:"DatabaseBusyError",lagLow:false,readOnly:false,pinned:true});
      expect(result.lagBytes).toBeGreaterThanOrEqual(WAL_ADMISSION_BYTES);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
