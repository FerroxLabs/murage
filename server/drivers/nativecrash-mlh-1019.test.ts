// SPDX-License-Identifier: AGPL-3.0-or-later
// MLH (nativecrash stage 2): a learning one-shot whose fenced submission was refused joins the refusal's ONE close (awaits R.teardown, then
// resets the session); it never issues its own lookup interruptTurn while a closer owns that refusal (K3).
import { expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { hiddenTurnRunner } from "./cli-memory-learning.ts";
import { refusalFor, type FencedRefusal } from "./engine-input.ts";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function rig(classify: boolean) {
  const order: string[] = []; let R: FencedRefusal | undefined;
  const revoked = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  const adapter = {
    provider: "codex", capabilities: {},
    onEvent: (_listener: (event: RuntimeEvent) => void) => () => {},
    sendTurn: async (input: SendTurnInput) => {
      try { (input as unknown as { fencedWrite: (write: () => void) => void }).fencedWrite(() => { order.push("written"); }); }
      catch (error) {
        // the driver's fenced submit classifies the refusal and claims its close (a real driver then closes its process)
        if (classify) R = refusalFor(error, "fixture.submit", { engine: "fixture", threadId: input.threadId, kind: "turn", lease: { late: undefined }, target: { id: "proc" } });
        throw error;
      }
      return { turnId: "turn" };
    },
    respondToRequest: async () => "rejected",
    interruptTurn: async () => { order.push("interruptTurn"); return undefined; },
    resetSession: async () => { order.push("resetSession"); },
  };
  const live = { instanceId: "fixture", driverKind: "codex", displayName: "Fixture", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance;
  const gate = { released: 0, check() {}, send() { throw revoked; } };
  const run = hiddenTurnRunner(live)("prompt", new AbortController().signal, { maxBytes: 1000, gate, cwd: fixtureBotFolder() } as never);
  let settled: unknown = "pending";
  void run.then(() => { settled = "resolved"; }, error => { settled = error; });
  return { order, revoked, refusal: () => R, settled: () => settled };
}

it("MLH: a refused fenced submission with a claimed R is joined: no interruptTurn, the run settles after the one close, then the session resets", async () => {
  const t = rig(true);
  await tick();
  const R = t.refusal()!;
  expect(R.closer).toBe("driver");
  expect([t.settled(), t.order]).toEqual(["pending", []]); // AWAITED: the one-shot is not over while the refused turn's close is running
  await R.close(async () => { t.order.push("close"); return { confirmed: true }; });
  await tick();
  expect(t.settled()).toBe(t.revoked);
  expect(t.order).toEqual(["close", "resetSession"]);
});

it("MLH control: a refusal no driver classified keeps the lookup interrupt and reset", async () => {
  const t = rig(false);
  await tick();
  expect(t.settled()).toBe(t.revoked);
  expect(t.order).toEqual(["interruptTurn", "resetSession"]);
});
