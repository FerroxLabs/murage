// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW (spec 1.7, 1.9, 1.14): a backup of the memory index taken while the helper owns it reads the live set through held descriptors and
// rebuilds it in private staging. It runs no checkpoint on the live index: the main file and the -wal keep their bytes, no charge is asked
// for, and the sidecars (-walstop, -walok, -walattempt) are left as they are. The copy it leaves opens STOPPED (no_walok), and the helper-start reset completes it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { openIndexWal, walTestHooks, type WalCharge } from "./memory/index-wal.ts";
import { MemoryIndex, type IndexedMemory } from "./memory/index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rec = (i: number): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 5}`, text: `words of record ${i} alpha ${"pad ".repeat(i % 9)}`, deleted: false });
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "memw-backup-owned-")); walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; });
afterEach(() => { delete walTestHooks.exit; removeTempDirSync(dir); });

it("MEMW backup while owned: no checkpoint outside the charge, sidecars present", { timeout: 120_000 }, async () => {
  const source = join(dir, "offline"); mkdirSync(source);
  const path = join(source, "memory-index.db"), target = join(dir, "memory-index.snapshot.db");
  const charges: WalCharge[] = [];
  const index = await MemoryIndex.create(path, { charge: async c => { charges.push(c); return true; } });
  try {
    expect(await index.applyBatch(Array.from({ length: 60 }, (_, i) => rec(i)))).toEqual({ status: "done" });
    // committed frames stay in the -wal (the checks are PASSIVE; nothing truncates here)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
    // every sidecar of the set is present while the helper owns it
    for (const suffix of ["-walstop", "-walok", "-walattempt"]) if (!existsSync(path + suffix)) writeFileSync(path + suffix, `sidecar ${suffix}\n`);
    const before = { main: sha(path), wal: sha(`${path}-wal`), walSize: statSync(`${path}-wal`).size, charges: charges.length,
      sidecars: ["-walstop", "-walok", "-walattempt"].map(suffix => sha(path + suffix)) };

    const result = await withOfflineInstallation(source, installation => installation.snapshotMemoryIndex(target));
    expect(result.status).toBe("copied");

    // no checkpoint on the live index: main file and -wal byte for byte, no charge asked for, sidecars untouched
    expect(sha(path)).toBe(before.main);
    expect(statSync(`${path}-wal`).size).toBe(before.walSize);
    expect(sha(`${path}-wal`)).toBe(before.wal);
    expect(charges.length).toBe(before.charges);
    expect(["-walstop", "-walok", "-walattempt"].map(suffix => sha(path + suffix))).toEqual(before.sidecars);
    // the owner still writes and checks as before
    expect(await index.applyBatch([rec(1000)])).toEqual({ status: "done" });
  } finally { await index.prepareExit().catch(() => {}); try { index.close(); } catch { /* the test's own handle */ } }
  // Owner ruling (fail closed): the copy carries the seal's index_meta but not -walok, so a restored copy opens STOPPED with reason
  // no_walok (r3.2.8a: -walstop is presence-only and never repaired; the copy gets no new sidecar identity).
  const opened = openIndexWal(target, { charge: async () => true });
  try {
    expect(opened.verdict).toEqual({ state: "unresolved", reason: "open_check_owed" });
    expect(await opened.wal.openCheck()).toMatchObject({ state: "stopped", reason: "no_walok" });
  } finally { (opened.wal as unknown as { closeForQuarantine(): void }).closeForQuarantine(); }
});

// The other half of the ruling: the helper-start reset completes the stopped copy. The reset path is WP1/WP2a's (handleReset on a
// stopped file); until it is merged into this branch the half stays a named pending test.
it.todo("MEMW backup copy: the helper-start reset completes the copy that opened stopped with no_walok (pending WP1/WP2a reset path)");
