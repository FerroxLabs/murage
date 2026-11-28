// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (pip-reflect.ts startReflectFromNow). Consumer owner: the bot PATCH route (index.ts), witnessed booted in
// ../revokehealth-reflect-api-1022.test.ts W-REFLECT-FROM-NOW.
// 1.0.22 MUST-FIX item 6: the cursor the switch writes keeps the history from before it out of the reflection run's choice (no backfill),
// and a turn after the switch is chosen as before.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MIN_RUN_INTERVAL_MS, REFLECTABLE_AGE_MS, readReflectState, reflectableThreads, startReflectFromNow, type ReflectDeps } from "./pip-reflect.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const T0 = 1_760_000_000_000, SWITCH = T0 + 30 * 24 * 3600_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
const bot = { id: "moss", threadIds: ["private"], continuity: true, options: { reflect: true } as never };
const deps = { bootEpoch: "boot" as never, tmpBase: "/tmp", bots: () => [bot], resolveRoute: async () => { throw new Error("not used"); }, memoryMode: () => "active" } as unknown as ReflectDeps;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { setMemoryCaptureRoster(null); });
const exchange = (id: string, at: number) => {
  const db = database();
  captureMessage(db, "private", { id: `o-${id}`, at, role: "user", kind: "text", text: `Please be brief ${id}.`, origin: "desktop" } as never);
  captureMessage(db, "private", { id: `b-${id}`, at: at + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
};
const chosen = (now: number) => reflectableThreads(database(), deps, bot, readReflectState(database(), "moss"), now).map(c => c.threadId);

it("W-REFLECT-NO-BACKFILL the switch's cursor keeps the history before it out of the run's choice, and a turn after it is chosen", () => {
  for (let i = 1; i <= 20; i++) exchange(String(i), T0 + i * 1000);
  // without the cursor the month-old history is a candidate the first run would bill for
  expect(chosen(SWITCH)).toEqual(["private"]);
  startReflectFromNow("moss", ["private"], SWITCH);
  expect(chosen(SWITCH + REFLECTABLE_AGE_MS + MIN_RUN_INTERVAL_MS)).toEqual([]);
  exchange("after", SWITCH + 60_000);
  expect(chosen(SWITCH + 60_000 + REFLECTABLE_AGE_MS + MIN_RUN_INTERVAL_MS)).toEqual(["private"]);
});
