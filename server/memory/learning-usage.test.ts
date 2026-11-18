// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute, memoryOwnerStatus, type MemoryOwnerOptions } from "./settings.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
const path = "/api/memory/learning-usage";
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 10, 12).getTime());
  reconcileMemoryRoster(roster);
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

it.each([false, true])("returns only the desktop learning totals and public connection fields (connected: %s)", async (connected) => {
  const ticket = ownerMemoryTicket();
  const options: MemoryOwnerOptions = connected ? { learningConnection: () => ({
    extractor: null, instanceId: "private-engine-id", source: "chosen", label: "Fixture",
    reason: "/private/home/engine", suggestion: { instanceId: "private-suggestion", label: "Other" },
  }) } : {};
  const db = database();
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),'system','learning-spend',0,'granted',?)")
    .run(learningSpendLedgerId(learningSpendMonth()), JSON.stringify({ input: 100_000_000, output: 300_000 }));
  const desktop = memoryOwnerStatus(ticket, roster, options);
  const before = db.prepare("SELECT total_changes() AS n").get();
  const summary = await memoryOwnerRoute(path, undefined, ticket, roster, {
    ...options,
    runtimeStatus: () => { throw new Error("Usage must not read the full memory status"); },
  });
  expect(summary).toEqual({ learning: {
    ceiling: desktop.learning.ceiling,
    connection: { label: desktop.learning.connection.label, source: desktop.learning.connection.source },
  } });
  expect(summary).toMatchObject({ learning: { ceiling: { inputUsed: 100_000_000, outputUsed: 300_000, paused: true, pausedBy: "limit" } } });
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("refuses a non-owner before reading learning usage", async () => {
  const learningConnection = vi.fn();
  await expect(memoryOwnerRoute(path, undefined, {}, roster, { learningConnection })).rejects.toThrow("MEMORY_OWNER_REQUIRED");
  expect(learningConnection).not.toHaveBeenCalled();
});
