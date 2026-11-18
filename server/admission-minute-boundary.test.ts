// SPDX-License-Identifier: AGPL-3.0-or-later
// WAL-ADMISSION-FLAKE: the ledger is kept per wall-clock minute. A minute that rolls over inside the checkpointer thread must
// not turn a process whose owner last said "active" into an idle one (1 MiB a minute, nothing in the last 5 s) until the owner
// next reads the clock; and a process that really is idle keeps its documented rule at every second of the minute.
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";

const MINUTE = 60_000, MiB = 1024 * 1024;
/** A ledger in minute 5 whose owner has published `idle`, then asked for a copy at second `second` of minute `minute`. */
function ask(idle: boolean, minute: number, second: number, ceiling: number) {
  const ledger = checkpointLedger(new SharedArrayBuffer(32 * BigInt64Array.BYTES_PER_ELEMENT));
  ledger.lock(); try { ledger.rotate(5 * MINUTE); Atomics.store(ledger.slots, 7, idle ? 1n : 0n); } finally { ledger.unlock(); }
  return ledger.beginCopy(ceiling, minute * MINUTE + second * 1000);
}

it("T-MIN-ACTIVE an active process is admitted at every second, also in the minute after a rollover seen only by the worker", () => {
  const refused: string[] = [];
  for (let s = 0; s < 60; s++) {
    if (!ask(false, 5, s, 2 * MiB)) refused.push(`same minute :${s}`);
    if (!ask(false, 6, s, 2 * MiB)) refused.push(`after rollover :${s}`);
    if (!ask(false, 6, s, 4096)) refused.push(`small copy after rollover :${s}`);
  }
  expect(refused, "refused although the owner published active").toEqual([]);
});

it("T-MIN-IDLE a process that is really idle keeps the rule: 1 MiB a minute, nothing in the last 5 s, at every second", () => {
  const wrong: string[] = [];
  for (let s = 0; s < 60; s++) {
    for (const minute of [5, 6]) {
      const small = ask(true, minute, s, 4096), big = ask(true, minute, s, 2 * MiB);
      if ((small !== null) !== (s <= 55)) wrong.push(`small, minute ${minute}, :${s}`);
      if (big !== null) wrong.push(`big, minute ${minute}, :${s}`);
    }
  }
  expect(wrong).toEqual([]);
});
