// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { emitConsumingTurnResponse, registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { DEFAULT_BUSY_MS, isDatabaseBusy } from "./db-busy.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";

// The outer HTTP test permits four seconds for an entire fixture request.
// Exercise the release itself so widening its 50 ms writer wait to the
// foreground one-second budget cannot hide inside that workflow allowance.
it.each(["live", "revoked"] as const)("consuming release bounds real SQLite contention: %s", state => {
  const f = consumingFixture();
  const path = String(f.f.db.prepare("PRAGMA database_list").get()!.file);
  const other = new DatabaseSync(path);
  const write = vi.fn();
  const descriptor = registerConsumingDescriptor("gateway:json-error-limit-done", "body");
  const release = () => emitConsumingTurnResponse(f.binding, descriptor, { bytes: 1, refs: [], write });
  let locked = false;
  try {
    if (state === "revoked") f.flip();
    other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    locked = true;
    const started = performance.now();
    let error: unknown;
    try { release(); } catch (caught) { error = caught; }
    expect(performance.now() - started).toBeLessThan(750);
    expect(error).toBeDefined();
    expect(write).not.toHaveBeenCalled();
    expect(f.budget.counts.attempts).toBe(0);
    expect(f.f.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(DEFAULT_BUSY_MS);
    other.exec("ROLLBACK");
    locked = false;
    if (state === "live") {
      expect(isDatabaseBusy(error)).toBe(true);
      expect(f.refusals).toBe(0);
      release();
      expect(write).toHaveBeenCalledOnce();
      expect(f.budget.counts.attempts).toBe(1);
    } else {
      expect(error).toMatchObject({ message: "MEMORY_CONTEXT_REVOKED" });
      expect(f.refusals).toBe(1);
      expect(release).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(write).not.toHaveBeenCalled();
    }
  } finally {
    if (locked) other.exec("ROLLBACK");
    other.close();
    f.close();
  }
});

it("the actual destination runs with the serving-thread SQLite wait budget", () => {
  const f = consumingFixture();
  try {
    let observed: unknown;
    emitConsumingTurnResponse(f.binding, registerConsumingDescriptor("gateway:json-error-limit-done", "body"), {
      bytes: 1, refs: [], write: () => { observed = f.f.db.prepare("PRAGMA busy_timeout").get()!.timeout; },
    });
    expect(observed).toBe(50);
    expect(f.f.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(DEFAULT_BUSY_MS);
    expect(f.budget.counts.attempts).toBe(1);
    expect(f.refusals).toBe(0);
  } finally { f.close(); }
});
