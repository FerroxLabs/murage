// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.23 oldwit: the witnesses the Astra reviews of fix/1022-closer2 asked for (board: ASTRA fix1022-row76-closer2 b5d5b01177 / 697a20b1cf).
// Owners: q1023-oldwit owns this test file only (no product code); the held-reply path is owned by RelayedMount (cli-mount-relay.ts) and the
// mount admission (mcp-mounts.ts). Real fence, real deny reader, real ledger, real ingress and relay; only the mount child and the CLI process are stand-ins.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { WINDOW_WAKE } from "../memory/revoke-marker.ts";
import { raise } from "../memory/revoke-wake.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { refsLookup } from "../memory/deny-read.ts";
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
async function routine(bundled = false) {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const admission = createMcpMountAdmission(f.binding, authority, "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "morning brief", warmIdentity: { botId: f.binding.identity.botId, audience: "non-owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [], envs: Record<string, string>[] = [];
  const spawn = vi.fn((_command: string, _args: string[], env: Record<string, string>) => {
    envs.push(env);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { muragebox: bundled ? { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } : { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
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
  return { f, relay, failed, socket, engine, forwarded, child: children[0]!, caps, authority, env: envs[0]!,
    ingress: () => relay.mounts.get("muragebox")!.mount.ingress,
    /** A revoke opens a pending window over the thread: the held line is checking:pending until its walk ends. */
    openPending: () => { f.f.job(1, 50).pending("T", 1); expect(refsLookup(f.f.db, [held], MEMBER)).toMatchObject({ state: "checking", reason: "pending" }); },
    // MEMORY V2 V14: a waiting call wakes on the `window` topic (no poll). The runner's commit on the main connection raises it in production;
    // this fixture deletes on its own connection, so it raises the same topic the production commit hook raises.
    clearPending: () => { f.f.db.exec("DELETE FROM memory_deny_pending"); f.f.db.prepare("UPDATE memory_revoke_jobs SET state='done'").run(); raise(WINDOW_WAKE); },
  };
}

const reply = (id: number, text = "fixture reply words") => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\n";
const ids = (lines: string[]) => lines.map(line => JSON.parse(line).id);

// O7 (Astra b5d5b01177 :247): the chunk-count fixture is asserted FIRST, with room to spare, so a base run reaches the behaviour below it.
// 327f17651d (revkill3's parent) refused the whole turn on the 257th held chunk; the tip keeps every chunk and checks all of it in order.
it("OLDWIT-O7 a waiting reply with 300+ chunks of later output behind it does not refuse the turn; all of it is checked, in order", async () => {
  const r = await routine();
  r.socket.write(request(2) + "\n");
  await vi.waitFor(() => expect(ids(r.forwarded)).toEqual([1, 2]));
  r.openPending();
  r.child.stdout!.emit("data", Buffer.from(reply(1)));
  const text = "later reply words ".repeat(120);
  const later = Buffer.from(reply(2, text));
  const size = Math.ceil(later.length / 330);
  const chunks: Buffer[] = [];
  for (let at = 0; at < later.length; at += size) chunks.push(later.subarray(at, at + size));
  expect(chunks.length, "fixture: more than the old 256-chunk bound, by a margin").toBeGreaterThan(300);
  for (const chunk of chunks) r.child.stdout!.emit("data", chunk);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(r.f.refusals, "held output is not a revoke: the turn is not refused").toBe(0);
  expect(r.failed, "the relay is not sealed by held output").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  expect(ids(r.engine), "nothing unchecked reaches the engine").toEqual([]);
  r.clearPending();
  await vi.waitFor(() => expect(ids(r.engine)).toEqual([1, 2]), { timeout: 5000 });
  expect(JSON.parse(r.engine[1]!).result.content[0].text).toBe(text);
  expect(r.f.refusals).toBe(0);
  await expect(r.relay.finish()).resolves.toBe(true);
});

// 697a20b1cf (mcp-mounts.ts:158): a RAW (third-party, not enveloped) reply deferred at issue never created a permit. At the bound the relay
// answers its call with the content-free error; the engine's call is then complete and its id is free again. Reusing a completed id is not
// a protocol fault.
it("OLDWIT-RAW a raw reply dropped at the bound answers its call, and the engine can reuse that completed call id without sealing the turn", async () => {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 200; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const r = await routine();
  r.openPending();
  r.child.stdout!.emit("data", Buffer.from(reply(1)));
  await vi.waitFor(() => expect(ids(r.engine)).toContain(1), { timeout: 5000 });
  expect(JSON.parse(r.engine.find(line => JSON.parse(line).id === 1)!).error).toMatchObject({ code: -32000 });
  expect(r.f.refusals).toBe(0);
  expect(r.ingress().sealed).toBe(false);
  r.clearPending();
  // the same id again, now a new call
  r.socket.write(request(1) + "\n");
  await vi.waitFor(() => expect(ids(r.forwarded)).toEqual([1, 1]), { timeout: 5000 });
  expect(r.f.refusals, "reusing a completed call id does not refuse the turn").toBe(0);
  expect(r.failed, "the relay is not sealed by the reused id").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  r.child.stdout!.emit("data", Buffer.from(reply(1, "second answer")));
  await vi.waitFor(() => expect(ids(r.engine)).toEqual([1, 1]), { timeout: 5000 });
  expect(JSON.parse(r.engine[1]!).result.content[0].text).toBe("second answer");
});
