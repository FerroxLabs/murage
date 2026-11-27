// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 redfix-e2 (Astra on 8d2c14df6c): the engine's own `notifications/cancelled` withdraws a call. The host-computer proxy then
// keeps its mount (req.cancel(), no answer), but the trusted ingress still listed the withdrawn request id as outstanding, so a late
// reply for that id would still be authorized and released to the engine. The withdrawn id is now retired at ingress when the
// cancellation is forwarded: a late reply for it is consumed and never released, the mount stays open, and the next call is answered.
// Real CliMountRelay, real mount admission, real ingress and fence; only the mount child and the CLI process are stand-ins.
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
import type { SendTurnInput } from "../contracts.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
const { CliMountRelay } = await import("./cli-mount-relay.ts");

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const call = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fixture_action" } }) + "\n";
const cancelled = (id: number) => JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }) + "\n";
const reply = (id: number, text: string) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\n";
const ids = (lines: string[]) => lines.map(line => JSON.parse(line).id);
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

async function mounted() {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "computer action", warmIdentity: { botId: f.binding.identity.botId, audience: "non-owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { computer: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const failed = vi.fn();
  relay.attach(cli, failed);
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "computer" }) + "\n");
  const engine: string[] = []; socket.on("data", chunk => engine.push(...String(chunk).split("\n").filter(Boolean)));
  const forwarded: string[] = []; children[0]!.stdin!.on("data", chunk => forwarded.push(...String(chunk).split("\n").filter(Boolean)));
  return { f, failed, socket, engine, forwarded, child: children[0]!, ingress: () => relay.mounts.get("computer")!.mount.ingress };
}

it("E2-1022 a late reply for a call the engine withdrew is not released; the mount stays open and the next call is answered", async () => {
  const r = await mounted();
  r.socket.write(call(1));
  await vi.waitFor(() => expect(ids(r.forwarded)).toEqual([1]));
  // the engine withdraws call 1; the cancellation itself reaches the tool through the ingress
  r.socket.write(cancelled(1));
  await vi.waitFor(() => expect(r.forwarded.map(line => JSON.parse(line).method)).toEqual(["tools/call", "notifications/cancelled"]));
  // the tool answers call 1 anyway, after the withdrawal
  r.child.stdout!.emit("data", Buffer.from(reply(1, "late action words")));
  await settle();
  expect(r.engine.join("\n"), "the withdrawn call's late reply never reaches the engine").not.toContain("late action words");
  expect(ids(r.engine)).not.toContain(1);
  expect(r.ingress().sealed, "a late reply for a withdrawn call does not seal the mount").toBe(false);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.f.refusals).toBe(0);
  // the next call on the same mount runs and is answered
  r.socket.write(call(2));
  await vi.waitFor(() => expect(ids(r.forwarded.filter(line => JSON.parse(line).method === "tools/call"))).toEqual([1, 2]));
  r.child.stdout!.emit("data", Buffer.from(reply(2, "next action words")));
  await vi.waitFor(() => expect(ids(r.engine)).toEqual([2]));
  expect(r.engine[0]).toContain("next action words");
  expect(r.ingress().sealed).toBe(false);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.f.refusals).toBe(0);
});

it("E2-1022 guard: a withdrawn call is answered at most once; a second reply for it, or a reuse of its id, seals the mount", async () => {
  const r = await mounted();
  r.socket.write(call(1));
  r.socket.write(cancelled(1));
  await vi.waitFor(() => expect(r.forwarded).toHaveLength(2));
  r.child.stdout!.emit("data", Buffer.from(reply(1, "late action words")));
  await settle();
  expect(r.ingress().sealed).toBe(false);
  r.child.stdout!.emit("data", Buffer.from(reply(1, "second late words")));
  await vi.waitFor(() => expect(r.ingress().sealed).toBe(true));
  expect(r.engine.join("\n")).not.toMatch(/late action words|second late words/);

  const s = await mounted();
  s.socket.write(call(7));
  s.socket.write(cancelled(7));
  await vi.waitFor(() => expect(s.forwarded).toHaveLength(2));
  // the engine may not reuse an id whose late reply could still arrive: it would be taken for the new call's answer
  s.socket.write(call(7));
  await vi.waitFor(() => expect(s.ingress().sealed).toBe(true));
  expect(s.forwarded).toHaveLength(2);
});

it("E2-1022 guard: a cancellation for a call the mount does not own retires nothing; the owned call is still answered", async () => {
  const r = await mounted();
  r.socket.write(call(3));
  r.socket.write(cancelled(99));
  await vi.waitFor(() => expect(r.forwarded).toHaveLength(2));
  r.child.stdout!.emit("data", Buffer.from(reply(3, "owned action words")));
  await vi.waitFor(() => expect(ids(r.engine)).toEqual([3]));
  expect(r.ingress().sealed).toBe(false);
  expect(r.failed).not.toHaveBeenCalled();
});
