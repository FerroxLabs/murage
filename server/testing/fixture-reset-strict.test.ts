// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestHandle } from "../test-handle-registry.ts";
import { cleanupInternals, removeTempDir } from "./cleanup.ts";

const suites = [
  "scripts/smoothness/record-keys-io.test.mjs",
  "server/memory/revoke-bounded.test.ts",
  "server/memory/schema-shape-marker.test.ts",
];

// Execute the actual reset callback without registering the suite's database
// tests. Only the other fixture dependencies are stubbed; removal and handle
// settlement use the real helper, including its default strictness and retries.
function resetHook(file: string, dir: string, mkdir: typeof mkdirSync): () => Promise<void> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const hooks = source.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression, callback = call.arguments[0];
    return call.expression.getText(source) === "beforeEach" && callback && ts.isArrowFunction(callback)
      && callback.body.getText(source).includes("removeTempDir(DATA_DIR") ? [callback.getText(source)] : [];
  });
  expect(hooks).toHaveLength(1);
  return runInNewContext(`(${hooks[0]})`, {
    DATA_DIR: dir, removeTempDir, mkdirSync: mkdir,
    closeMemoryIndexReader: vi.fn(), resetRecordKeysWriteBudget: vi.fn(),
    searchIndexTestHooks: {}, reconcileMemoryRoster: vi.fn(), process: { env: {} },
  });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-strict-reset-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(dir, { strict: true });
});

describe.each(suites)("fixture reset in %s", file => {
  it("rejects exhausted removal and never continues setup against stale data", async () => {
    const stale = join(dir, "stale-row");
    writeFileSync(stale, "previous fixture");
    const failure = Object.assign(new Error("injected fixture removal failure"), { code: "EBUSY" });
    const remove = vi.spyOn(cleanupInternals, "remove").mockImplementation(() => { throw failure; });
    vi.spyOn(cleanupInternals, "sleep").mockResolvedValue();
    const warn = vi.spyOn(cleanupInternals, "warn").mockImplementation(() => {});
    const mkdir = vi.fn(mkdirSync);

    await expect(resetHook(file, dir, mkdir)()).rejects.toBe(failure);
    expect(remove.mock.calls.length).toBeGreaterThan(1);
    expect(warn).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(existsSync(stale)).toBe(true);
  });

  it("awaits handle shutdown and successful removal before recreating the fixture", async () => {
    const stale = join(dir, "stale-row");
    writeFileSync(stale, "previous fixture");
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.fn(() => stopped);
    const unregister = registerTestHandle("stop", stop);
    const remove = vi.spyOn(cleanupInternals, "remove");
    const mkdir = vi.fn(mkdirSync);
    const pending = resetHook(file, dir, mkdir)();
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
      expect(remove).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(existsSync(stale)).toBe(true);
    } finally {
      release();
      try { await pending; } finally { unregister(); }
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith(dir, { recursive: true });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});
