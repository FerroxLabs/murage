// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// N5 owns the fake adapter close results and the HTTP Stop witness.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export const COMMAND_STOP_FIXTURE_SOURCE = String.raw`
  const raceFile = threadId => path.join(process.env.MURAGE_DATA_DIR, "race-" + threadId);
  globalThis.n5RaceStage = threadId => fs.existsSync(raceFile(threadId)) ? fs.readFileSync(raceFile(threadId), "utf8") : "";
  const n5WaitFor = async file => {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file)) {
      if (Date.now() >= deadline) throw new Error("command Stop fixture barrier timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  globalThis.n5WaitAtRefusal = async threadId => {
    fs.writeFileSync(raceFile(threadId) + ".held", "");
    await n5WaitFor(raceFile(threadId) + ".resume");
  };
  globalThis.n5InterruptReceipt = async (threadId, invoke) => {
    const stage = globalThis.n5RaceStage(threadId);
    if (!["before", "during", "rejected"].includes(stage)) return invoke();
    fs.writeFileSync(raceFile(threadId) + ".requested", "");
    if (stage !== "rejected") await n5WaitFor(raceFile(threadId) + ".close");
    return { closeConfirmed: false, reason: "stop-failed" };
  };
  globalThis.n5ReportRefusal = (threadId, reason) => fs.writeFileSync(raceFile(threadId) + ".end", reason ?? "");
  const n5ServerStop = source => {
    const interrupt = "const stopCall = Promise.resolve(registry.get(selected.modelSelection.instanceId)?.adapter.interruptTurn(threadId));";
    const fold = "const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {";
    if (!source.includes(interrupt) || !source.includes(fold)) throw new Error("command Stop fixture anchor missing");
    return source
      .replace(interrupt, "const stopCall = globalThis.n5InterruptReceipt(threadId, () => registry.get(selected.modelSelection.instanceId)?.adapter.interruptTurn(threadId));")
      .replace(fold, fold + ' if (executionEvent.type === "turn.completed" && globalThis.n5RaceStage(executionEvent.threadId)) { globalThis.n5ReportRefusal(executionEvent.threadId, executionEvent.stopReason); if (globalThis.n5RaceStage(executionEvent.threadId) === "confirmed") { const lease = terminalDispatchFor(executionEvent); if (lease) confirmedStopGenerations.add(lease.identity.dispatchGeneration); } }');
  };
`;

export async function finishCommandStopRace(
  dir: string, threadId: string, stage: string, interrupt: () => Promise<{ status: number }>, idle: () => Promise<unknown>,
): Promise<string> {
  const file = join(dir, "race-" + threadId);
  if (stage === "confirmed") {
    await idle();
  } else {
    await expect.poll(() => existsSync(file + ".held"), { timeout: 15_000 }).toBe(true);
    const stop = interrupt();
    try {
      await expect.poll(() => existsSync(file + ".requested"), { timeout: 15_000 }).toBe(true);
      if (stage === "rejected") expect((await stop).status).toBe(409);
      writeFileSync(file + ".resume", "", { mode: 0o600 });
      await idle();
    } finally {
      writeFileSync(file + ".close", "", { mode: 0o600 });
      writeFileSync(file + ".resume", "", { mode: 0o600 });
      await stop;
    }
  }
  return readFileSync(file + ".end", "utf8");
}
