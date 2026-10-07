// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { maintainPip, mutateReflect, type ReflectBot, type ReflectDeps } from "./pip-reflect.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    typeof value === "function" && name.endsWith("Sync") ? vi.fn(value as (...args: unknown[]) => unknown) : value]));
});
const fsCount = () => Object.values(fs).reduce((n, value) => n + (vi.isMockFunction(value) ? value.mock.calls.length : 0), 0);
const bots: ReflectBot[] = [{ id: "moss", threadIds: [], continuity: false }, { id: "untouched", threadIds: [], continuity: false }];
let now: number;
let deps: ReflectDeps;
beforeEach(() => {
  closeDatabase(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: bots.map(bot => ({ id: bot.id, threadId: bot.id })), groups: [] });
  now = Date.now();
  deps = { now: () => now, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => bots.map(bot => ({ ...bot })), memoryMode: () => "off", resolveRoute: vi.fn(), reaper: { sweep: async () => [] } };
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

it.each([false, true])("complete maintenance tick does one query and zero filesystem calls with no Continuity (root=%s)", async root => {
  if (root) fs.mkdirSync(join(deps.tmpBase, "orphan"), { recursive: true });
  const onContinuity = vi.fn(async () => {});
  const worker = new MemoryWorkerController({ onMaintenance: () => maintainPip(deps), continuityEligible: () => deps.bots().some(bot => bot.continuity), onContinuity });
  const tick = worker as unknown as { independentWork(): void; maintenanceTask: Promise<void>; continuityTask: Promise<void> | null };
  const prepare = vi.spyOn(database(), "prepare");
  vi.clearAllMocks();
  tick.independentWork();
  await Promise.all([tick.maintenanceTask, tick.continuityTask]);
  expect(prepare.mock.calls.map(([sql]) => sql)).toHaveLength(1);
  expect(prepare.mock.calls[0][0]).toMatch(/^SELECT /);
  expect(fsCount()).toBe(0);
  expect(onContinuity).not.toHaveBeenCalled();
  expect(worker.error).toBeNull();
});

it.each([false, true])("skips untouched bots and reuses eligibility when another bot uses PIP (persisted=%s)", async persisted => {
  if (persisted) mutateReflect("moss", () => {});
  else deps.bots = () => bots.map(bot => ({ ...bot, continuity: bot.id === "moss" }));
  const original = database().prepare.bind(database());
  const prepare = vi.spyOn(database(), "prepare");
  const gets: unknown[][] = [];
  prepare.mockImplementation(function (sql) {
    const statement = original(sql);
    const get = statement.get.bind(statement);
    vi.spyOn(statement, "get").mockImplementation((...args) => { gets.push(args); return get(...args); });
    return statement;
  });
  vi.clearAllMocks();
  await maintainPip(deps);
  expect(gets.flat()).not.toContain("pip-reflect:untouched");
  expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT 1 FROM memory_scope_bindings WHERE id=?"))).toHaveLength(0);
  expect(fsCount()).toBe(0);
});

it("discovers orphan roots at startup and hourly, including an empty installation", async () => {
  const orphan = join(deps.tmpBase, "orphan");
  fs.mkdirSync(orphan, { recursive: true });
  await maintainPip(deps, { startup: true });
  expect(fs.existsSync(orphan)).toBe(false);
  fs.mkdirSync(orphan, { recursive: true });
  vi.clearAllMocks();
  now += 30_000;
  await maintainPip(deps);
  expect(fsCount()).toBe(0);
  now += 60 * 60_000;
  await maintainPip(deps);
  expect(fs.existsSync(orphan)).toBe(false);
});
