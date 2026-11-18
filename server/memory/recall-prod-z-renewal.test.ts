// SPDX-License-Identifier: AGPL-3.0-or-later
// Production renewal owner: recall-prod-z. Reset census owner: recall production lane.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { LineageAllowance } from "./lineage-allowance.ts";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
// Execute the production statements around each await, without starting the app.
const sites = [
  ["direct no-bundle", 'const resetRoute=threadSealed', '// The recall started at slot acquisition'],
  ["direct memory-off floor", 'reuseStats.reset("retained-invalid");', 'const floor = roomTranscriptWithoutMemory'],
  ["room reset helper", 'const resetRoomMemberSession = async () => {', '/** The final write boundary'],
] as const;

it.each(sites)("%s keeps the spent allowance across setup", async (name, start, end) => {
  const at = source.indexOf(start);
  const until = source.indexOf(end, at);
  expect(at).toBeGreaterThan(0);
  expect(until).toBeGreaterThan(at);
  const body = source.slice(at, until) + (name === "room reset helper" ? "await resetRoomMemberSession();" : "");
  for (const boundary of ["current", "stopped", "mode-changed"] as const) {
    const allowance = name === "room reset helper" ? LineageAllowance.room(10) : LineageAllowance.turn(10);
    allowance.spendNodes("", 7);
    allowance.spendRows("", 1);
    const renew = vi.spyOn(allowance, "renew");
    let current = true, mode = "active";
    const reset = vi.fn(async () => {
      current = boundary !== "stopped";
      if (boundary === "mode-changed") mode = "paused";
    });
    const deleted = vi.fn();
    const context = vm.createContext({
      allowance, threadId: "thread", bot: { id: "bot" }, dispatchClaimId: "generation", internalGeneration: "generation",
      instance: { instanceId: "engine", adapter: { resetSession: reset } },
      threadSealed: () => false, store: { taskByThread: () => ({}) }, afterRecallReset: false,
      reuseStats: { reset() {} }, pre: { async: (_name: string, work: () => Promise<void>) => work() },
      directTurnClaimIsCurrent: () => current, DirectTurnSetupCancelled: Error,
      memoryState: () => ({ mode }), directStoredMemoryMode: "active", roomStoredMemoryMode: "active",
      assertMemoryAccess() {}, access: {}, internalCapabilities: { activeGeneration: () => current ? "generation" : undefined },
      roomRetainedMemory: new Map(), roomRetainedKey: "thread:engine", roomRetainedSession: () => "session",
      database: () => ({}), sessionKeyOf: () => ({}), deleteSessionChecks: deleted,
    });
    const js = ts.transpileModule(`(async () => { ${body} })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    }).outputText;
    const turn = vm.runInContext(js, context) as Promise<void>;
    if (boundary === "current") await turn;
    else await expect(turn).rejects.toThrow(boundary === "stopped" && name !== "room reset helper" ? "turn stopped before dispatch" : "MEMORY_CONTEXT_REVOKED");
    expect(reset).toHaveBeenCalledOnce();
    expect(renew, `${name}: ${boundary}`).not.toHaveBeenCalled();
    expect(allowance.room()).toBe(3);
    expect(allowance.debt).toBe(1);
    if (name === "room reset helper") expect(deleted).toHaveBeenCalledTimes(boundary === "current" ? 1 : 0);
  }
});
