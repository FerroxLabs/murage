// SPDX-License-Identifier: AGPL-3.0-or-later
// K2 file of the G2 claude group (nativecrash stage 2, M13). Owner: G2 claude (this file); helper testing/nativecrash-k2.ts: G0.
// The claude permission broker (CL1-4 seam, opts.refusalCtx) on a binding whose ledger refusal reaches a REAL ledger lease (k2Lease):
//  lease-won: the revoke lands outside any fence call (Tl revoke), so the lease closes through interruptTurn once; a fenced broker reply
//    afterwards only joins the lease's R and closes nothing of its own (M17).
import { mkdtempSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPermissionBroker } from "./drivers/claude.ts";
import { refusalFor } from "./drivers/engine-input.ts";
import { bindConsumingTurn } from "./consuming-turn-response.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { watchEscapes } from "./testing/nativecrash-harness.ts";
import { k2Check, k2Lease, k2Verdict } from "../testing/nativecrash-k2.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function rig(leasePort = true) {
  const k2 = k2Lease(); k2.lease.attach("k2-provider-turn");
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nc-k2cl-"))); cleanups.push(() => removeTempDir(dir));
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const f = consumingFixture(undefined, { threadId: k2.identity.threadId, botId: k2.identity.botId }); cleanups.push(() => f.close());
  let current = true;
  // production wiring: the binding's ledger refusal is the lease's (index.ts lease port)
  const binding = bindConsumingTurn({ identity: { ...k2.identity, lineageTurnIds: [f.turn.turnId] }, turn: f.turn, db: f.f.db, isCurrent: () => current,
    onLedgerRefused: verdict => { if (leasePort) k2.lease.onLedgerRefused(verdict); } });
  const order: string[] = []; let sockClosed = false;
  const owner = { settleFenced: async () => { order.push("settle"); } };
  const broker = await createPermissionBroker({ releaseBinding: binding, threadId: k2.identity.threadId, socketPaths: [join(dir, "b.sock")],
    onAsk: () => {}, onResolve: () => {}, isActive: () => true,
    refusalCtx: () => ({ owner, target: owner, close: () => async () => { order.push(`retire:conn-closed=${sockClosed}`); return { confirmed: true }; } }) });
  cleanups.push(() => broker.close());
  const sock: Socket = connect(broker.socketPath); sock.on("error", () => {}); cleanups.push(() => sock.destroy());
  sock.on("close", () => { sockClosed = true; });
  await new Promise<void>(resolve => sock.once("connect", () => resolve()));
  const askBad = () => sock.write(JSON.stringify({ t: "ask", id: "q-bad", kind: "question", tool: "AskUserQuestion", input: { questions: "not-an-array" } }) + "\n");
  const joined = async () => { for (let i = 0; i < 2000 && !(k2.refusals()[0]?.joins ?? []).some(s => s.startsWith("claude.broker")); i++) await new Promise(r => setTimeout(r, 5)); };
  return { k2, watch, order, owner, askBad, joined, binding, revoke: () => { current = false; }, isSockClosed: () => sockClosed };
}

it("K2 claude lease-won: a Tl revoke outside a fence call closes through the lease once; the later fenced broker reply only joins", async () => {
  const x = await rig();
  x.revoke();
  x.k2.lease.onLedgerRefused(k2Verdict);
  const [R] = x.k2.refusals();
  expect(R?.closer, "a revoke outside any fence call: the lease owns the close").toBe("lease");
  x.askBad();
  await x.joined();
  expect(x.k2.refusals(), "the broker reply joins the lease's R, no second record").toEqual([R]);
  for (let i = 0; i < 200 && !x.isSockClosed(); i++) await new Promise(r => setTimeout(r, 5));
  expect(x.isSockClosed(), "the refused connection still closes (fail-closed deny)").toBe(true);
  expect(x.order, "lease won first: the driver runs no settle and no retire of its own (join only, M17)").toEqual([]);
  expect(x.watch.escaped).toEqual([]);
  await k2Check(x.k2, { closer: "lease" });
}, 30_000);

// M17 at the broker site, independent of the lease's close timing: an R the lease has claimed but not yet closed (its close is pending)
// is never closed by the broker's fenced reply. R.close runs whatever composite reaches it first, so the site's closer check is what keeps
// the driver's settle and retire out of a lease-owned close.
it("K2 claude: a lease-claimed R whose close has not started is joined, never closed, by the fenced broker reply", async () => {
  const x = await rig(false);
  const own = refusalFor(Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }), "lease.ledger",
    { engine: "claude", threadId: x.k2.identity.threadId, binding: x.binding, kind: "turn", target: undefined })!;
  expect(own.noClaim(), "the lease owns the close").toBe(true);
  cleanups.push(() => own.close(async () => ({ confirmed: true })));
  x.revoke();
  x.askBad();
  for (let i = 0; i < 2000 && !own.joins.some(s => s.startsWith("claude.broker")); i++) await new Promise(r => setTimeout(r, 5));
  expect(own.joins.filter(s => s.startsWith("claude.broker")).length, "the fenced broker reply joined the lease's R").toBeGreaterThan(0);
  for (let i = 0; i < 200 && !x.isSockClosed(); i++) await new Promise(r => setTimeout(r, 5));
  expect(x.isSockClosed(), "the refused connection still closes (fail-closed deny)").toBe(true);
  await new Promise(r => setTimeout(r, 100));
  expect(x.order, "the driver runs no settle and no retire on a lease-claimed R").toEqual([]);
  expect(x.watch.escaped).toEqual([]);
}, 30_000);
