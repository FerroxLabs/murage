// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 revkill (SEAN-REPORTED: the 06:00 morning brief routine ended "I stopped this turn because some of its context is no longer
// available."). Owners: revkill-1020 builder owns the pending deferral (send-fence.ts deferringPendingFence, the ingress request pass-through
// and RelayedMount's bounded wait); the retained ledger, the deny reader and the turn-wide refusal latch are unchanged.
// Live log: ledger refusal cause=checking:pending on ONE muragebox call -> "mount failure seals the relay mount=muragebox cause=refusal"
// -> claude close reason=mount-relay-sealed. A routine turn has no owner continuation hook, so the held context still checking:pending
// (a revoke walk not finished, not a proven revoke) refused the whole turn. A call that is still being checked now waits for that exact
// check (bounded) and is retried; the relay and turn stay open. A proven revoke still refuses the turn and nothing is forwarded.
// Real fence, real deny reader, real ledger, real ingress and relay; only the mount child and the CLI process are stand-ins.
import { afterEach, expect, it, vi } from "vitest";
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
import { refsLookup } from "../memory/deny-read.ts";
import { addTurnParents, currentLsn } from "../memory/lineage-write.ts";
import { MEMBER } from "../memory/testing/writetime-fixture.ts";
import type { SendTurnInput } from "../contracts.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
// The revoke runner is the producer that ends the walk; the test plays it (clearPending / denyLine) and checks the wait woke it.
const wake = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../memory/memory-revocation.ts", async original => ({
  ...await original<typeof import("../memory/memory-revocation.ts")>(),
  wakeMemoryRevocation: () => { wake.calls++; },
}));
const { CliMountRelay, RelayedMount } = await import("./cli-mount-relay.ts");

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (id: number, method = "tools/call") => JSON.stringify({ jsonrpc: "2.0", id, method, params: { name: "brief" } });
const held = { kind: "line", threadId: "T", messageId: "X" } as const;

/** A routine turn (no owner continuation hook) with a mounted muragebox, attached to its CLI. */
async function routine() {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "morning brief", warmIdentity: { botId: f.binding.identity.botId, audience: "non-owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { muragebox: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const failed = vi.fn();
  relay.attach(cli, failed);
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "muragebox" }) + "\n");
  const engine: string[] = []; socket.on("data", chunk => engine.push(...String(chunk).split("\n").filter(Boolean)));
  const forwarded: string[] = []; children[0]!.stdin!.on("data", chunk => forwarded.push(...String(chunk).split("\n").filter(Boolean)));
  // the first call is checked and answered before the revoke: the held line X is in the turn's context
  socket.write(request(1, "tools/list") + "\n");
  await vi.waitFor(() => expect(forwarded).toHaveLength(1));
  return { f, relay, failed, socket, engine, forwarded, child: children[0]!,
    ingress: () => relay.mounts.get("muragebox")!.mount.ingress,
    /** A revoke opens a pending window over the thread: the held line is checking:pending until its walk ends. */
    openPending: () => { f.f.job(1, 50).pending("T", 1); expect(refsLookup(f.f.db, [held], MEMBER)).toMatchObject({ state: "checking", reason: "pending" }); },
    clearPending: () => { f.f.db.exec("DELETE FROM memory_deny_pending"); f.f.db.prepare("UPDATE memory_revoke_jobs SET state='done'").run(); },
  };
}

it("REVKILL-1020 a routine's muragebox call that meets a checking:pending refusal waits, then runs; the relay and the turn stay open", async () => {
  const r = await routine();
  r.openPending();
  r.socket.write(request(2) + "\n");
  r.socket.write(request(3) + "\n");
  // still being checked: nothing new is forwarded, and nothing is refused or sealed
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(r.f.refusals, "a pending check is not a revoke: the turn is not refused").toBe(0);
  expect(r.failed, "the relay is not sealed by one pending call").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  expect(r.forwarded).toHaveLength(1);
  expect(wake.calls, "the wait wakes the revoke runner for its check").toBeGreaterThan(0);
  // the walk finishes and proves the context still shown: the waiting calls run, in order
  r.clearPending();
  await vi.waitFor(() => expect(r.forwarded).toHaveLength(3), { timeout: 5000 });
  expect(r.forwarded.map(line => JSON.parse(line).id)).toEqual([1, 2, 3]);
  r.child.stdout!.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }) + "\n"));
  await vi.waitFor(() => expect(r.engine.map(line => JSON.parse(line).id)).toContain(2));
  expect(r.f.refusals).toBe(0);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  // and the turn completes normally
  await expect(r.relay.finish()).resolves.toBe(true);
});

it("REVKILL-1020 guard: when the pending check ends in a proven revoke the turn is still refused and the call never reaches the tool", async () => {
  const r = await routine();
  r.openPending();
  r.socket.write(request(2) + "\n");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(r.f.refusals).toBe(0);
  r.clearPending();
  r.f.f.denyLine("T", 1);
  await vi.waitFor(() => expect(r.f.refusals).toBe(1), { timeout: 5000 });
  expect(r.failed).toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(true);
  expect(r.forwarded, "revoked context is never released to the tool").toHaveLength(1);
});

it("REVKILL-1020 bound: a check still pending at its bound fails only that call; the relay and turn stay open", async () => {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 200; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const r = await routine();
  r.openPending();
  r.socket.write(request(2) + "\n");
  await vi.waitFor(() => expect(r.engine.map(line => JSON.parse(line).id)).toContain(2), { timeout: 5000 });
  const answer = JSON.parse(r.engine.find(line => JSON.parse(line).id === 2)!);
  expect(answer.error).toMatchObject({ code: -32000 });
  expect(JSON.stringify(answer)).not.toMatch(/fixture|brief/);
  expect(r.forwarded).toHaveLength(1);
  expect(r.f.refusals).toBe(0);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  // the next call, after the check clears, runs
  r.clearPending();
  r.socket.write(request(4) + "\n");
  await vi.waitFor(() => expect(r.forwarded.map(line => JSON.parse(line).id)).toEqual([1, 4]), { timeout: 5000 });
  expect(r.f.refusals).toBe(0);
});

// 1.0.20 revkill2 (Fable #25 residual): the TOOL REPLY path. Owners: revkill2-1020 builder owns the held reply (RelayedMount reply hold,
// ingress deliver keeping its permit, the mount accept retry); the fence, ledger and refusal latch are unchanged. A reply arriving while the
// turn's held context is checking:pending used to refuse the whole turn (issue/deliver -> retainedRefusal -> relay sealed).
const reply = (id: number, text = "fixture reply words") => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\n";
const ids = (lines: string[]) => lines.map(line => JSON.parse(line).id);

it("REVKILL2-1020 a tool reply that arrives during a pending check is held, then delivered after it clears; the turn is not refused", async () => {
  const r = await routine();
  r.openPending();
  r.child.stdout!.emit("data", Buffer.from(reply(1)));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(r.f.refusals, "a pending check is not a revoke: the reply does not refuse the turn").toBe(0);
  expect(r.failed, "the relay is not sealed by one held reply").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  expect(ids(r.engine), "nothing unchecked reaches the engine").not.toContain(1);
  expect(wake.calls).toBeGreaterThan(0);
  r.clearPending();
  await vi.waitFor(() => expect(ids(r.engine)).toContain(1), { timeout: 5000 });
  expect(JSON.parse(r.engine.find(line => JSON.parse(line).id === 1)!).result.content[0].text).toBe("fixture reply words");
  // the turn goes on: another call and its reply flow normally
  r.socket.write(request(2) + "\n");
  await vi.waitFor(() => expect(ids(r.forwarded)).toEqual([1, 2]));
  r.child.stdout!.emit("data", Buffer.from(reply(2)));
  await vi.waitFor(() => expect(ids(r.engine)).toContain(2));
  expect(r.f.refusals).toBe(0);
  expect(r.failed).not.toHaveBeenCalled();
  await expect(r.relay.finish()).resolves.toBe(true);
});

it("REVKILL2-1020 guard: a held reply whose check ends in a proven revoke refuses the turn and is never forwarded", async () => {
  const r = await routine();
  r.openPending();
  r.child.stdout!.emit("data", Buffer.from(reply(1)));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(r.f.refusals).toBe(0);
  r.clearPending();
  r.f.f.denyLine("T", 1);
  await vi.waitFor(() => expect(r.f.refusals).toBe(1), { timeout: 5000 });
  expect(r.failed).toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(true);
  expect(ids(r.engine), "a revoked turn's reply never reaches the engine").not.toContain(1);
});

it("REVKILL2-1020 bound: a reply whose check is still pending at the bound is dropped; its call gets a content-free error and the turn continues", async () => {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 200; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const r = await routine();
  r.openPending();
  r.child.stdout!.emit("data", Buffer.from(reply(1)));
  await vi.waitFor(() => expect(ids(r.engine)).toContain(1), { timeout: 5000 });
  const answer = JSON.parse(r.engine.find(line => JSON.parse(line).id === 1)!);
  expect(answer.error).toMatchObject({ code: -32000 });
  expect(JSON.stringify(answer)).not.toMatch(/fixture|words/);
  expect(r.f.refusals).toBe(0);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  r.clearPending();
  r.socket.write(request(2) + "\n");
  await vi.waitFor(() => expect(ids(r.forwarded)).toEqual([1, 2]));
  r.child.stdout!.emit("data", Buffer.from(reply(2)));
  await vi.waitFor(() => expect(ids(r.engine)).toContain(2));
  expect(r.engine.filter(line => JSON.parse(line).id === 1), "the dropped reply is never delivered late").toHaveLength(1);
  expect(r.f.refusals).toBe(0);
});

// 1.0.21 cause1 defer (ASTRA BLOCK dc8bbebef2, MAIN ruling (a)): a malformed held receipt fails closed on the deferred path too. The turn holds
// the line X, its thread's prefix and a receipt whose row is corrupted; a revoke opens a pending window over the thread, so the prefix reads
// pending ahead of the receipt and the combined verdict keeps that first checking reason (pending). Before, send-fence.ts deferred it like any pending check: the call (or reply) waited, then got the content-free error at
// the bound and the turn kept running with no refusal or stopped row. Now the turn is refused at once and nothing is forwarded. RED on
// dc8bbebef2 and with send-fence.ts checkRetainedFence's malformedHeldReceipt refusal off.
it.each(["call", "reply"])("CAUSE1-DEFER-1021 a %s meeting a pending check with a malformed held receipt refuses the turn instead of waiting", async path => {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 200; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const r = await routine();
  const db = r.f.f.db;
  r.f.f.receipt("bundle-defer", "T", "fixture", "fixture-session");
  const prefix = { kind: "prefix", threadId: "T", held: currentLsn(db), shown: ["X"], content: true } as const;
  const receipt = { kind: "receipt", bundleId: "bundle-defer", lsn: currentLsn(db), scopeIds: [] } as const;
  addTurnParents(r.f.turn, [prefix, receipt]);
  db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE bundle_id='bundle-defer'").run();
  expect(refsLookup(db, [receipt], MEMBER)).toEqual({ state: "checking", reason: "lookup-error" });
  r.openPending();
  // the deferred case: the held prefix reads pending first, so what the turn holds reads pending as a whole with the malformed receipt behind it
  expect(refsLookup(db, [held, prefix, receipt], MEMBER)).toEqual({ state: "checking", reason: "pending" });
  if (path === "call") r.socket.write(request(2) + "\n");
  else r.child.stdout!.emit("data", Buffer.from(reply(1)));
  await vi.waitFor(() => expect(r.f.refusals, "the refusal row").toBe(1), { timeout: 3000 });
  expect(r.failed, "the relay is sealed and the turn stopped").toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(true);
  if (path === "call") expect(r.forwarded, "the call never reaches the tool").toHaveLength(1);
  expect(r.engine.some(line => JSON.parse(line).error?.code === -32000), "no wait-and-retry answer: the turn does not continue").toBe(false);
  expect(ids(r.engine), "the held reply never reaches the engine").not.toContain(path === "reply" ? 1 : 2);
});
