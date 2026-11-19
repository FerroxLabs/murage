// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD 13 r2, the commit gate (relay half): the relay's identity check is the last step before the launcher publishes.
// FD 4 is faked with a Duplex the test drives as the launcher: it pushes `ready\n`, and reads what the relay writes back.
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { createEngineLoginRelay, type EngineLoginWho } from "./engine-login.ts";

let server: Server, port: number;
afterEach(async () => { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); });

interface Fake { child: EventEmitter; ready: () => void; sent: string[]; ended: () => boolean }
function fakeLauncher(): Fake {
  const sent: string[] = []; let ended = false;
  const channel = new Duplex({ read() {}, write(chunk, _e, cb) { sent.push(String(chunk)); cb(); }, final(cb) { ended = true; cb(); } });
  const child = Object.assign(new EventEmitter(), {
    pid: 2147483000, exitCode: null as number | null, signalCode: null as string | null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0)); return true; },
  });
  (child as unknown as Record<string, unknown>).stdio = [child.stdin, child.stdout, child.stderr, null, channel];
  return { child, ready: () => { channel.push("ready\n"); }, sent, ended: () => ended };
}
async function start(revalidate: ((who: EngineLoginWho) => boolean) | undefined, fake: Fake, logs: string[]) {
  const relay = createEngineLoginRelay({ log: line => logs.push(line), killGraceMs: 100, ...(revalidate ? { revalidate } : {}), spawnLauncher: () => fake.child as never });
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    setCloudIdentity(req.headers, { id: "dev1", account: "a", scope: "owner-desktop", publicKey: "", assertionKey: "", revoked: 0, factor: false, accessHash: "a".repeat(64) });
    void relay(req, socket, head, new URL(req.url ?? "/", "http://localhost")).then(took => { if (!took) socket.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return relay;
}
const open = () => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/engine-login/antigravityAgent?action=login&bot=atlas`);
  ws.once("open", () => resolve(ws)); ws.once("error", reject); ws.once("unexpected-response", (_r, res) => reject(new Error(`refused ${res.statusCode}`)));
});
const closedWith = (ws: WebSocket) => new Promise<number>(resolve => ws.once("close", code => resolve(code)));
const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

describe("commit gate: the relay decides once, at the last step", () => {
  it("(h) a live identity writes commit once; a second ready gets nothing; the end line says committed", async () => {
    const fake = fakeLauncher(), logs: string[] = [], seen: EngineLoginWho[] = [];
    await start(who => { seen.push(who); return true; }, fake, logs);
    const ws = await open();
    fake.ready(); await tick(); fake.ready(); await tick();
    expect(fake.sent).toEqual(["commit\n"]);
    expect(seen).toEqual([{ deviceId: "dev1", accessHash: "a".repeat(64), desktop: true, engine: "antigravityAgent", action: "login", bot: "atlas" }]);
    ws.close(); await tick(250);
    expect(logs.find(line => line.startsWith("engine-login end"))).toContain("commit=committed");
  });
  it("(f) an invalidation after the code and before ready ends FD 4 with no byte and closes 1008; a late ready answers nothing", async () => {
    const fake = fakeLauncher(), logs: string[] = [];
    const revalidate = vi.fn(() => true);
    const relay = await start(revalidate, fake, logs);
    const ws = await open(); const code = closedWith(ws);
    relay.invalidate("dev1");
    expect(await code).toBe(1008);
    expect(fake.ended()).toBe(true);
    fake.ready(); await tick();
    expect(fake.sent).toEqual([]);
    expect(revalidate).not.toHaveBeenCalled();
    await tick(250);
    expect(logs.find(line => line.startsWith("engine-login end"))).toContain("commit=discarded");
  });
  it("an invalidation of another device leaves the relay alone; invalidating with no id closes every relay", async () => {
    const fake = fakeLauncher(), logs: string[] = [];
    const relay = await start(() => true, fake, logs);
    const ws = await open(); const code = closedWith(ws);
    relay.invalidate("someone-else"); await tick();
    expect(fake.ended()).toBe(false);
    relay.invalidate();
    expect(await code).toBe(1008);
  });
  it("(g) ready after the socket closed, or with the identity gone, answers nothing and ends FD 4", async () => {
    const closedFake = fakeLauncher(), logs: string[] = [];
    await start(() => true, closedFake, logs);
    const ws = await open(); ws.close(); await closedWith(ws); await tick();
    closedFake.ready(); await tick();
    expect(closedFake.sent).toEqual([]);
    expect(closedFake.ended()).toBe(true);
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    const goneFake = fakeLauncher();
    await start(() => false, goneFake, logs);
    const live = await open();
    goneFake.ready(); await tick();
    expect(goneFake.sent).toEqual([]);
    expect(goneFake.ended()).toBe(true);
    live.close();
  });
  it("an unwired relay (no revalidate) never commits", async () => {
    const fake = fakeLauncher(), logs: string[] = [];
    await start(undefined, fake, logs);
    const ws = await open(); fake.ready(); await tick();
    expect(fake.sent).toEqual([]); ws.close();
  });
});
