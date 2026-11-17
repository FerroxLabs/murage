// M13, mid-turn C8 on a desktop relay: the owner's Stop is noted (S1), and while its release is still held a rejected frame
// arrives on the real relay socket. Ingress seals, the lease refuses, and Antigravity's shipped relay-failure end
// (endOnRelayFailure, the :1047 callback) retires the relay and puts no card and no reply on the stream.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import type { TurnEnd } from "../turn-end.ts";
import type { SendTurnInput } from "../contracts.ts";
import { wiring } from "../decision-wiring/fixture.ts";
import { createTurnCardGate } from "../turn-card-gate.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true, cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
const { CliMountRelay } = await import("./cli-mount-relay.ts");
const { endOnRelayFailure } = await import("./antigravity.ts");
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanups.splice(0).reverse()) await c(); });

async function rig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  const f = consumingFixture(undefined, { botId: randomUUID(), lease, onRefused: verdict => lease.onLedgerRefused(verdict) }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn as never);
  cleanups.push(() => relay.finish());
  const retire = vi.spyOn(relay, "retire");
  const stream: string[] = [];
  let refusedSettles = 0;
  // Antigravity's own stop() retires the relay first (:1034), then the :1047 end runs.
  relay.attach(Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess,
    () => endOnRelayFailure(turn, () => relay.retire(), message => { stream.push(message); }, () => { refusedSettles++; }));
  const admittedLedgerLeases = new Map([["G", lease]]);
  // The index Stop route itself: it notes the Stop, writes the Stop record, then awaits the shared interrupt, held here at its browser release.
  const stopRecords: string[] = [], order: string[] = [];
  let releaseInterrupt!: () => void;
  const interruptHeld = new Promise<void>(resolve => { releaseInterrupt = resolve; });
  const { noteOwnerStop, stopDirectThreadForOwner } = wiring(["noteOwnerStop", "stopDirectThreadForOwner"], {
    directRuns: new Map([[f.turn.threadId, { generation: "G" }]]), internalTurnOwners: new Map(), admittedLedgerLeases,
    turnCardGate: createTurnCardGate({ liveTurnElsewhere: () => false }),
    callSpeech: { invalidate() {} }, replyState: { invalidate() {} }, dropAskerWakes() {}, markSendsStopped() {},
    recordStopForThread: (_db: unknown, bot: { id: string }, threadId: string) => { order.push("record"); stopRecords.push(`${bot.id}:${threadId}`); return true; },
    database: () => ({}), botCalls: { cancel() {} }, stopHeldVenuePosts: () => [], settleVenuePostCard() {},
    routines: { activeBotRunForThread: () => undefined }, cancelDirectTurnDispatch() {},
    interruptDirectThread: async () => { order.push("interrupt"); await interruptHeld; relay.retire(); },
  });
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "one" }) + "\n");
  await new Promise(resolve => setTimeout(resolve, 50));
  return { f, lease, relay, retire, children, stream, settled, presented, noteOwnerStop: () => noteOwnerStop!(f.turn.threadId),
    stopRoute: () => stopDirectThreadForOwner!({ id: "BOT" }, f.turn.threadId) as Promise<void>, releaseInterrupt, stopRecords, order,
    get refusedSettles() { return refusedSettles; } };
}
const rejectedFrame = (r: Awaited<ReturnType<typeof rig>>) => r.children[0]!.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));

describe("M13: Antigravity mid-turn, owner Stop held at its release, then a rejected relay frame", () => {
  it("S1 held: the frame is rejected, the callback retires the relay, nothing reaches the owner, the turn settles silent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await rig();
    r.noteOwnerStop(); // S1: the Stop route notes the owner's Stop before it awaits the browser release
    // The release is held: the adapter interrupt has not run, so nothing has retired the relay yet.
    expect({ retired: r.retire.mock.calls.length, refusals: r.f.refusals }).toEqual({ retired: 0, refusals: 0 });
    rejectedFrame(r);
    expect({ refusals: r.f.refusals, retired: r.retire.mock.calls.length, stream: r.stream, refusedSettles: r.refusedSettles, settled: r.settled, presented: r.presented })
      .toEqual({ refusals: 1, retired: 1, stream: [], refusedSettles: 1, settled: [{ kind: "silent" }], presented: [{ kind: "silent" }] });
    // Release: the adapter interrupt retires again; a frame after that is discarded and changes nothing.
    r.relay.retire(); rejectedFrame(r);
    expect({ refusals: r.f.refusals, stream: r.stream, settled: r.settled.length }).toEqual({ refusals: 1, stream: [], settled: 1 });
  });
  it("through the index Stop route: the Stop record is written, the frame during the held interrupt ends silent, release finishes once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await rig();
    const stopped = r.stopRoute();
    await Promise.resolve();
    expect({ order: r.order, records: r.stopRecords, retired: r.retire.mock.calls.length, refusals: r.f.refusals })
      .toEqual({ order: ["record", "interrupt"], records: [`BOT:${r.f.turn.threadId}`], retired: 0, refusals: 0 });
    rejectedFrame(r);
    expect({ refusals: r.f.refusals, retired: r.retire.mock.calls.length, stream: r.stream, refusedSettles: r.refusedSettles, settled: r.settled, presented: r.presented })
      .toEqual({ refusals: 1, retired: 1, stream: [], refusedSettles: 1, settled: [{ kind: "silent" }], presented: [{ kind: "silent" }] });
    r.releaseInterrupt(); await stopped; rejectedFrame(r);
    expect({ refusals: r.f.refusals, stream: r.stream, settled: r.settled.length, records: r.stopRecords.length }).toEqual({ refusals: 1, stream: [], settled: 1, records: 1 });
  });
  it("no Stop: the same frame gives the one ledger sentence on the stream", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await rig();
    rejectedFrame(r);
    expect({ refusals: r.f.refusals, stream: r.stream, refusedSettles: r.refusedSettles }).toEqual({ refusals: 1, stream: ["I stopped this turn because some of its context is no longer available."], refusedSettles: 1 });
  });
});
