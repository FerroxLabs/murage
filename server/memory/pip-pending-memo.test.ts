// SPDX-License-Identifier: AGPL-3.0-or-later
// T10 (STALLS-FINAL-DESIGN section 4, the 34.6 s stall): the maintenance pass's "is there anything to reflect" check scans each continuity
// bot's threads once while nothing it reads moved (memory data revision, the bot's reflect state and settings, the minute), so a pass
// costs one map read per bot instead of a scan of every thread.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { pipPendingScanStats, pipReflectPending, pipReflectPendingSliced, resetPipPendingScans, type ReflectDeps } from "./pip-reflect.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const T0 = 1_760_000_000_000;
let clock = T0;
const deps = {
  now: () => clock, bootEpoch: "boot" as never, tmpBase: "/tmp",
  bots: () => [{ id: "moss", threadIds: ["private"], continuity: true, options: { reflect: true } as never }],
  resolveRoute: async () => { throw new Error("not used"); }, memoryMode: () => "active",
} as unknown as ReflectDeps;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
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

// rc13 real-data boot (a 581 ms stall, `memory.pip.pending:261ms others=memory.pip.threads:261msx2`): the idle lane's check runs in slices,
// handing the event loop back between threads (and between pages of one thread's walk), with the same answer and the same memo.
it("the sliced check hands the loop back between threads and agrees with the one-hold check", async () => {
  const many = { ...deps, bots: () => [{ id: "moss", threadIds: Array.from({ length: 300 }, (_, i) => `t${i}`).concat("private"), continuity: true, options: { reflect: true } as never }] } as ReflectDeps;
  let turns = 0, ticking = true;
  const tick = () => { if (!ticking) return; turns++; setImmediate(tick); };
  setImmediate(tick);
  const sliced = await pipReflectPendingSliced(many, 0);
  ticking = false;
  expect(turns).toBeGreaterThan(100);
  resetPipPendingScans();
  expect(sliced).toBe(pipReflectPending(many));
  // the memo is shared: a sliced check right after a full one reads the map
  await pipReflectPendingSliced(many, 0);
  expect(pipPendingScanStats.memoHits).toBe(1);
});
