// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 real logs (N3): `[loop] stall blocked=415653ms holder=memory.pip.threads:8msx8`. The named step held the loop 8 ms of 415 s, yet
// the line called it the holder and the stall was chased into the pip pager. A block that named steps do not account for says so first,
// and every stall line says how much CPU the process spent in it: a block that burned none was a wait (a sleep, a prompt, a stuck volume).
import { afterEach, beforeAll, expect, it } from "vitest";

let observe: typeof import("./observe.ts");
const lines: string[] = [];
beforeAll(async () => {
  observe = await import("./observe.ts");
  observe.setObserveSink(line => lines.push(line));
});
afterEach(() => { observe.stopLoopLagMonitor(); lines.length = 0; });
// the production threshold (1 s unless MURAGE_STALL_MS says otherwise): each block below is half a second over it
const STALL = Number(process.env.MURAGE_STALL_MS) || 1000;
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* holds the loop */ } };
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stalls = () => lines.filter(line => line.startsWith("[loop] stall"));

it("a stall that named steps barely touched names the unnamed time as the holder, not the step", async () => {
  observe.startLoopLagMonitor();
  await tick(120);
  for (let i = 0; i < 8; i++) observe.heldStep("memory.pip.threads", () => busy(1));
  busy(STALL + 500); // outside any named step
  await tick(120);
  expect(stalls()).toHaveLength(1);
  expect(stalls()[0]).toMatch(/ holder=unnamed:\d+ms others=memory\.pip\.threads:\d+msx8(?: |$)/);
});

it("a stall a named step did hold still names that step", async () => {
  observe.startLoopLagMonitor();
  await tick(120);
  observe.heldStep("turn.folder-trust", () => busy(STALL + 500));
  await tick(120);
  expect(stalls()).toHaveLength(1);
  expect(stalls()[0]).toMatch(/ holder=turn\.folder-trust:\d+ms(?: |$)/);
});

it("a stall line says how much CPU the block burned: a wait burns none, a busy step burns about all of it", async () => {
  observe.startLoopLagMonitor();
  await tick(120);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STALL + 500); // the thread sleeps: a blocked call, no CPU
  await tick(120);
  busy(STALL + 500);
  await tick(120);
  expect(stalls()).toHaveLength(2);
  const cpu = stalls().map(line => Number(/ cpu=(\d+)ms(?: |$)/.exec(line)?.[1] ?? NaN));
  expect(cpu[0]).toBeLessThan(200);
  expect(cpu[1]).toBeGreaterThan(STALL / 2);
});
