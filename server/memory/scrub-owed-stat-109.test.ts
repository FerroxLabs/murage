// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// memdel r3 High: indexScrubOwed reads "no scrub owed" only when the index file is missing. Any other stat error (permission, I/O)
// is unknown, and unknown is owed, so the controller starts the helper and deletion debt is never stranded.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";

const fault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) => {
      if (fault.code && String(path).endsWith("memory-index.db")) throw Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
      return actual.statSync(path, options);
    }) as typeof actual.statSync,
  };
});

// The setup file loads the reader before this file's mock applies, so take a fresh copy that imports the mocked node:fs.
let reader: typeof import("./index-reader.ts");
beforeAll(async () => { vi.resetModules(); reader = await import("./index-reader.ts"); });
afterEach(() => { fault.code = null; reader.closeMemoryIndexReader(); });

it("a missing index file owes no scrub", () => {
  expect(existsSync(join(DATA_DIR, "memory-index.db"))).toBe(false);
  expect(reader.indexScrubOwed()).toBe(false);
  fault.code = "ENOENT"; expect(reader.indexScrubOwed()).toBe(false);
  fault.code = "ENOTDIR"; expect(reader.indexScrubOwed()).toBe(false);
});

it("any other stat error is unknown (null), so the controller starts the helper", () => {
  for (const code of ["EACCES", "EIO", "EPERM", "EMFILE"]) { fault.code = code; expect(reader.indexScrubOwed()).toBeNull(); }
});
