// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW r3.2.8d D4 (binding builder note) and its Lows: at an R start MemoryIndex.create resumes a pending open (a refused or unanswered
// open charge) up to OPEN_RESUME_ATTEMPTS more times before the helper reports `initialised`.
// - (i) the open charge is refused once, then granted: create returns an OPEN index in the same call (0 failed starts).
// - (ii) refused on all 1 + 3 attempts: create returns still pending, after exactly 4 charges (the first try plus 3 resumes); the failed
//   start with backoff then applies unchanged. Without reset (not an R start) it stays 1 charge.
// - (iii) unanswered charges: each attempt waits for its own CHARGE_ACK_MS timeout (no new timer), and 4 x CHARGE_ACK_MS fits inside
//   MEMORY_WORKER_INIT_MS (120 s) by a wide margin.
// - (iv) the loop lives inside create: worker.ts passes `reset` and never reads the private openState.
// mK: no resume attempts: RED on (i) and (ii).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, OPEN_RESUME_ATTEMPTS } from "./index.ts";
import { OVERRUN_K_UNKNOWN } from "./memw-steps.ts";
import { CHARGE_ACK_MS, walTestHooks, type WalCharge } from "./index-wal.ts";
import { MEMORY_WORKER_INIT_MS } from "./worker-controller.ts";

const R_START = { resetId: 1, resets: OVERRUN_K_UNKNOWN, kind: "open" as const };
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-d4-")); dirs.push(d); return d; };
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; walTestHooks.chargeAckMs = 200; });
afterEach(() => { for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function controller(grant: (n: number) => boolean | "hang") {
  const seen: WalCharge[] = [];
  return { seen, charge: (c: WalCharge) => { seen.push(c); const g = grant(seen.length); return g === "hang" ? new Promise<boolean>(() => {}) : Promise.resolve(g); } };
}

describe("D4: the bounded open resume at an R start, inside MemoryIndex.create", () => {
  it("(i) the first open charge is refused, the second granted: the R start gets an open index from one create call", async () => {
    const ctl = controller(n => n >= 2);
    const index = await MemoryIndex.create(join(dir(), "i.db"), { charge: ctl.charge, reset: R_START });
    expect(index.opened()).toBe(true);
    expect(ctl.seen.length).toBeGreaterThanOrEqual(2);
    index.close();
  });

  it("(ii) refused on every attempt: pending after exactly 1 + 3 charges; a start that is not an R start makes 1", async () => {
    const ctl = controller(() => false);
    const index = await MemoryIndex.create(join(dir(), "i.db"), { charge: ctl.charge, reset: R_START });
    expect(index.opened()).toBe(false);
    expect(ctl.seen.length).toBe(1 + OPEN_RESUME_ATTEMPTS);
    const plain = controller(() => false);
    const other = await MemoryIndex.create(join(dir(), "j.db"), { charge: plain.charge });
    expect(other.opened()).toBe(false);
    expect(plain.seen.length).toBe(1);
  });

  it("(iii) unanswered charges: each attempt waits its own ack timeout, and 4 of the real ones fit MEMORY_WORKER_INIT_MS many times over", async () => {
    const ctl = controller(() => "hang");
    const started = performance.now();
    const index = await MemoryIndex.create(join(dir(), "i.db"), { charge: ctl.charge, reset: R_START });
    const took = performance.now() - started;
    expect(index.opened()).toBe(false);
    expect(ctl.seen.length).toBe(1 + OPEN_RESUME_ATTEMPTS);
    expect(took).toBeGreaterThanOrEqual((1 + OPEN_RESUME_ATTEMPTS) * 200 * 0.9); // one timeout per attempt (chargeAckMs 200 in this file)
    expect((1 + OPEN_RESUME_ATTEMPTS) * CHARGE_ACK_MS).toBeLessThanOrEqual(MEMORY_WORKER_INIT_MS / 10); // 8 s of 120 s
  });

  it("(iv) worker.ts only calls create (reset) and never reads the private openState", () => {
    const source = readFileSync(join(import.meta.dirname, "worker.ts"), "utf8");
    expect(source).toMatch(/MemoryIndex\.create\(message\.indexPath,\{charge:sendCharge,\.\.\.reset\?\{reset\}:\{\}\}\)/);
    expect(source).not.toMatch(/openState/);
  });
});
