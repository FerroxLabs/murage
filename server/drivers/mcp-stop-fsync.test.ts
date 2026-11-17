// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace V2: the SPAWNING record is written and fsynced (file AND directory) before exec. The durable write unit is server/atomic.ts writeFileAtomic with
// syncDir. This counts the real fsync calls of a real write: one for the file, one for its directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ fsync: 0 }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const fsyncSync = (fd: number) => { counts.fsync++; return real.fsyncSync(fd); };
  return { ...real, fsyncSync, default: { ...real, fsyncSync } };
});
// the shared test setup imported atomic.ts before this mock existed: load a fresh copy that sees the counting fs
vi.resetModules();
const { StopRecordStore } = await import("./mcp-stop-records.ts");

describe.skipIf(process.platform === "win32")("RF: durable record writes", () => {
  it("RF1 every durable write is a file fsync AND a directory fsync, for PLANNED and for SPAWNING", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-stop-fsync-"));
    try {
      const store = new StopRecordStore(join(dir, "records"));
      const planned = { version: 1 as const, owner: "bot-1", generation: 1, platform: "desktop" as const, state: "PLANNED" as const, desktop: { pairs: [], captureCompleted: false } };
      counts.fsync = 0;
      store.plan(planned);
      expect(counts.fsync).toBe(2);
      counts.fsync = 0;
      store.advance(planned, "SPAWNING");
      expect(counts.fsync).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
