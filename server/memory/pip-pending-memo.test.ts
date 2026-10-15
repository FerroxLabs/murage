// SPDX-License-Identifier: AGPL-3.0-or-later
// T10 (STALLS-FINAL-DESIGN section 4, the 34.6 s stall): the maintenance pass's "is there anything to reflect" check scans each continuity
// bot's threads once while nothing it reads moved (memory data revision, the bot's reflect state and settings, the minute), so a pass
// costs one map read per bot instead of a scan of every thread.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { pipPendingScanStats, pipReflectPending, resetPipPendingScans, type ReflectDeps } from "./pip-reflect.ts";

const T0 = 1_760_000_000_000;
let clock = T0;
const deps = {
  now: () => clock, bootEpoch: "boot" as never, tmpBase: "/tmp",
  bots: () => [{ id: "moss", threadIds: ["private"], continuity: true, options: { reflect: true } as never }],
  resolveRoute: async () => { throw new Error("not used"); }, memoryMode: () => "active",
} as unknown as ReflectDeps;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "moss", threadId: "private", tasks: [] }], groups: [] } as never); setMemoryMode("active");
  resetPipPendingScans(); clock = T0;
});

it("two checks within a minute with no data movement scan the bot's threads once", () => {
  expect(pipReflectPending(deps)).toBeUndefined();
  expect(pipReflectPending(deps)).toBeUndefined();
  expect(pipPendingScanStats.scans).toBe(1);
  expect(pipPendingScanStats.memoHits).toBe(1);
});

it("a data revision, a new minute, or a changed setting scans again", () => {
  pipReflectPending(deps);
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  pipReflectPending(deps);
  expect(pipPendingScanStats.scans).toBe(2);
  clock += 61_000;
  pipReflectPending(deps);
  expect(pipPendingScanStats.scans).toBe(3);
  const changed = { ...deps, bots: () => [{ id: "moss", threadIds: ["private", "task"], continuity: true, options: { reflect: true } as never }] } as ReflectDeps;
  pipReflectPending(changed);
  expect(pipPendingScanStats.scans).toBe(4);
  pipReflectPending(changed);
  expect(pipPendingScanStats.scans).toBe(4);
  appendMessage("private", { id: "reply", at: clock, role: "bot", kind: "text", text: "Done.", turnTerminal: true });
  pipReflectPending(changed);
  expect(pipPendingScanStats.scans).toBe(5);
});
