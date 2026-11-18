// SPDX-License-Identifier: AGPL-3.0-or-later
// K2 harness helper (nativecrash stage 2, M13). Owner: G0. Each group writes its own server/nativecrash-k2-<group>-1019.test.ts that
// imports this; there is no shared test file. Two seams:
//   k2Lease(): a REAL createLedgerLease over spy ports (interruptTurn spy, terminal recorder, settle/present counters).
//   k2Server(): launchVerificationServer plus the real HTTP Stop route.
// k2Check() is the K2 backstop every case ends with: no unresolved teardown at the terminal, no kind-unjoined turn, exactly one R,
// and K3 (interruptTurn is called 0 times when the DRIVER won the closer CAS, once when the lease did).
import { expect } from "vitest";
import { createLedgerLease } from "../server/ledger-refusal.ts";
import { fencedRefusals, kindUnjoined, unawaitedTeardowns, type FencedRefusal } from "../server/drivers/engine-input.ts";
import type { LineageVerdict } from "../server/memory/lineage-types.ts";

export const k2Verdict: LineageVerdict = { state: "checking", reason: "not-built" } as LineageVerdict;
let ordinal = 0;
export interface K2Lease {
  readonly identity: { botId: string; threadId: string; dispatchGeneration: string; lineageTurnIds: string[]; adapterLeaseId: string };
  readonly lease: ReturnType<typeof createLedgerLease>;
  /** interruptTurn spy: the lease port's adapter call (the fallback close). */
  readonly calls: { interrupt: number; confirmed: number; settle: number; present: number; seal: number };
  readonly refusals: () => FencedRefusal[];
}
export function k2Lease(options: { interrupt?: () => Promise<boolean> } = {}): K2Lease {
  const n = ++ordinal;
  const identity = { botId: "k2-bot", threadId: `k2-thread-${n}`, dispatchGeneration: `k2-gen-${n}-${Math.random().toString(36).slice(2)}`, lineageTurnIds: ["k2-turn"], adapterLeaseId: "k2-lease" };
  const calls = { interrupt: 0, confirmed: 0, settle: 0, present: 0, seal: 0 };
  const lease = createLedgerLease(identity, {
    seal() { calls.seal++; },
    interrupt: async () => { calls.interrupt++; return options.interrupt ? options.interrupt() : true; },
    settle() { calls.settle++; }, present() { calls.present++; }, quarantine() {}, confirmed() { calls.confirmed++; },
  });
  const refusals = () => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).dispatchGeneration === identity.dispatchGeneration);
  return { identity, lease, calls, refusals };
}

/** The K2 backstop. Await the lease's teardown first; this fails a case that leaves a teardown unresolved, unjoined or unawaited. */
export async function k2Check(rig: K2Lease, expected: { closer: "driver" | "lease"; refusals?: number }): Promise<void> {
  await rig.lease.teardownConfirmed;
  const mine = rig.refusals();
  expect(mine, "exactly one R per dispatch generation").toHaveLength(expected.refusals ?? 1);
  for (const R of mine) {
    expect(R.closer, "the R has one closer").toBe(expected.closer);
    expect(R.teardownSettled, "teardown unresolved at terminal").toBe(true);
  }
  expect(unawaitedTeardowns().filter(R => mine.includes(R)), "every teardown has an awaiter").toEqual([]);
  expect(kindUnjoined.count, "kind-unjoined turn refusal").toBe(0);
  expect(rig.calls.interrupt, expected.closer === "driver" ? "K3: the driver won, interruptTurn must not be called" : "the lease won: interruptTurn once").toBe(expected.closer === "driver" ? 0 : 1);
  expect(rig.calls.settle, "one settle").toBe(1);
}

/** Real HTTP Stop route against a launched verification server. `fixture` is launchVerificationServer's result. */
export interface K2ServerFixture { info: { url: string; dataDir: string; logPath: string }; close(): Promise<void> }
export function k2Stop(fixture: K2ServerFixture, headers: Record<string, string>, botId: string, threadId: string): Promise<Response> {
  return fetch(`${fixture.info.url}/api/bots/${botId}/interrupt`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ threadId }) });
}
export async function k2Server(instrumentationSource = "", turnLog: { replies: string[] } = { replies: ["k2 reply"] }): Promise<K2ServerFixture> {
  const { launchVerificationServer } = await import("../scripts/control-murage.ts");
  return launchVerificationServer(process.env, undefined, { separateHome: true, turnLog, instrumentationSource }) as Promise<K2ServerFixture>;
}
