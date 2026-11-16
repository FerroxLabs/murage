import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { connect, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { SendTurnInput } from "../contracts.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";

const death = vi.hoisted(() => ({ confirmed: true, killed: [] as unknown[], onKill: undefined as undefined | (() => void) }));
vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: (child: unknown) => { death.killed.push(child); death.onKill?.(); },
  awaitCliTreeStopped: async () => death.confirmed,
  cliTreeStoppedSignal: () => new Promise(() => {}),
}));
vi.mock("./chat-mcp-client.ts", async original => ({
  ...await original<typeof import("./chat-mcp-client.ts")>(),
  ChatMcpDescendants: class {
    track() {} async ready() {} async stop() { return death.confirmed; }
    goneSignal() { return new Promise(() => {}); }
  },
  chatMcpTeardown: () => ({ markStopRequested() {}, wait: async () => ({ closeConfirmed: death.confirmed }), onClosed() {} }),
}));
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  death.confirmed = true; death.onKill = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  death.killed = [];
});
function child(): ChildProcess {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, pid: undefined }) as unknown as ChildProcess;
}
function admission(threadId: string = randomUUID(), botId: string = randomUUID()) {
  const f = consumingFixture(undefined, { botId, threadId });
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities();
  caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const mountAdmission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "fixture", releaseBinding: f.binding, mountAdmission };
  return { f, turn };
}
const servers = { one: { command: "isolated-mount", args: [], env: {} } };
async function fixture() {
  const first = admission();
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const children: ChildProcess[] = [];
  const spawn = () => { const c = child(); children.push(c); return c; };
  const relay = await CliMountRelay.create(first.turn, servers, {}, cred, spawn);
  const cli = child(); const eof = vi.fn(); relay.attach(cli, vi.fn(), eof);
  cleanups.push(() => relay.finish());
  return { ...first, relay, cli, eof, children, spawn, cred };
}
async function auth(relay: CliMountRelay, ticket = relay.ticket): Promise<Socket> {
  const socket = connect(relay.socketPath); socket.on("error", () => {});
  cleanups.push(() => socket.destroy()); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket, server: "one" }) + "\n");
  return socket;
}
it("T-S2-GENERATION-CUT: sockets and ingresses retire before child stop; CLI and pathname survive", async () => {
  const x = await fixture(); const ticket = x.relay.ticket;
  const socket = await auth(x.relay);
  const forwarded = once(x.children[0]!.stdin!, "data");
  socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'); await forwarded;
  const closed = once(socket, "close");
  death.onKill = () => expect(x.relay.mounts.get("one")!.mount.ingress.retired).toBe(true);
  expect(await x.relay.retireGeneration()).toBe(true); await closed;
  expect(death.killed).toEqual(x.children); expect(x.eof).not.toHaveBeenCalled();
  expect(x.relay.ticket).not.toBe(ticket); expect(x.relay.ticket).toBe("");
  expect(existsSync(x.cred.path)).toBe(true); expect(JSON.parse(readFileSync(x.cred.path, "utf8"))).toEqual({});
  expect(existsSync(x.relay.socketPath)).toBe(true);
});
it("T-S2-CRED-FIRST: fresh ticket/admission/mount precede spawn on the same process listener", async () => {
  const x = await fixture(); const ticket = x.relay.ticket; const mount = x.relay.mounts.get("one");
  expect(await x.relay.retireGeneration()).toBe(true);
  const next = admission(x.turn.threadId, x.f.binding.identity.botId);
  const relay = await x.relay.nextGeneration(next.turn, servers, { one: { MURAGE_COMMS_TOKEN: "new" } }, vi.fn(), () => {
    const file = JSON.parse(readFileSync(x.cred.path, "utf8"));
    expect(file.one.MURAGE_COMMS_TOKEN).toBe("new"); expect(file.one.MURAGE_RELAY_TICKET).not.toBe(ticket);
    return x.spawn();
  });
  cleanups.push(() => relay.finish());
  expect(relay.socketPath).toBe(x.relay.socketPath); expect(relay.mounts.get("one")).not.toBe(mount);
  expect(relay.turn.mountAdmission).not.toBe(x.turn.mountAdmission);
  await x.relay.finish(); // obsolete generation cannot close its successor
  expect(existsSync(relay.socketPath)).toBe(true); expect(x.eof).not.toHaveBeenCalled();
});
it("T-S2-BETWEEN: between-turn and stale-ticket sockets cannot seal either admission", async () => {
  const x = await fixture(); const oldTicket = x.relay.ticket;
  await x.relay.retireGeneration();
  const between = await auth(x.relay, oldTicket); await once(between, "close");
  const next = admission(x.turn.threadId, x.f.binding.identity.botId); const fail = vi.fn();
  const relay = await x.relay.nextGeneration(next.turn, servers, {}, fail, x.spawn); cleanups.push(() => relay.finish());
  for (const ticket of [oldTicket, "unknown"]) {
    const stale = await auth(relay, ticket); await once(stale, "close");
  }
  expect(fail).toHaveBeenCalledTimes(2); expect(x.f.refusals).toBe(0); expect(next.f.refusals).toBe(0);
  expect(relay.mounts.get("one")!.mount.ingress.sealed).toBe(false);
});
it("T-S2-DEFAULT-COLD: finish still ends CLI, disposes credentials and closes listener", async () => {
  const x = await fixture(); expect(await x.relay.finish()).toBe(true);
  expect(x.eof).toHaveBeenCalledWith(x.cli); expect(death.killed).toContain(x.cli);
  expect(existsSync(x.cred.path)).toBe(false); expect(existsSync(x.relay.socketPath)).toBe(false);
});
it("T-S2-UNCONFIRMED: failed generation death recycles CLI and cannot create a successor", async () => {
  const x = await fixture(); death.confirmed = false;
  expect(await x.relay.retireGeneration()).toBe(false);
  expect(await x.relay.finish()).toBe(false);
  expect(death.killed).toContain(x.cli);
  await expect(x.relay.nextGeneration(admission().turn, servers, {}, vi.fn(), x.spawn)).rejects.toThrow("S2_GENERATION_NOT_AVAILABLE");
});
