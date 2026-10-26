// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { createEngineLoginRelay, launcherEngineName, type EngineLoginEngine, type EngineLoginExtra, type EngineLoginOptions } from "./engine-login.ts";

let server: Server, port: number, logs: string[], launches: Array<{ engine: string; action: string; extra: EngineLoginExtra; pid?: number }>, scope = "owner-desktop";
async function start(options: EngineLoginOptions = {}) {
  logs = []; launches = [];
  const relay = createEngineLoginRelay({ log: line => logs.push(line), killGraceMs: 200, ...options,
    spawnLauncher: options.spawnLauncher ?? ((engine: EngineLoginEngine, action, extra) => {
      const child = spawn("/bin/cat", [], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      launches.push({ engine, action, extra, pid: child.pid }); return child;
    }) });
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    setCloudIdentity(req.headers, { id: "dev1", account: "a", scope: scope as "owner-desktop", publicKey: "", assertionKey: "", revoked: 0, factor: false });
    void relay(req, socket, head, new URL(req.url ?? "/", "http://localhost")).then(took => { if (!took) socket.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}
beforeEach(() => { scope = "owner-desktop"; });
afterEach(async () => { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); });
// A per-bot sign-in must name its bot, so every engine but Claude defaults to one.
const open = (engine = "codex", query = engine === "claudeAgent" ? "" : "?bot=atlas") => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/engine-login/${engine}${query}`);
  ws.once("open", () => resolve(ws)); ws.once("unexpected-response", (_r, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
  ws.once("error", reject);
});
const closed = (ws: WebSocket) => new Promise<number>(resolve => ws.once("close", code => resolve(code)));
const message = (ws: WebSocket) => new Promise<string>(resolve => ws.once("message", data => resolve(String(data))));
/** Sessions the relay has finished for one engine: it frees that engine's slot, then logs the end line. Counted per engine,
 * so a session an earlier test left ending (another engine's slot) is never taken for this one's. */
const ended = (engine: string) => logs.filter(line => line.startsWith(`engine-login end engine=${engine} `)).length;
const settled = (engine: string, before: number) => vi.waitFor(() => expect(ended(engine)).toBe(before + 1), { timeout: 5_000 });
const gone = async (pid: number) => { for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise(r => setTimeout(r, 50)); } return false; };

describe("engine login relay", () => {
  it("relays bytes both ways, logs one start and one end line with no bytes, and kills the child on close", async () => {
    await start();
    const ws = await open("codex", "?action=login&bot=atlas");
    const echoed = message(ws); ws.send("device-code-SECRET123");
    expect(await echoed).toBe("device-code-SECRET123");
    ws.close();
    expect(await gone(launches[0]!.pid!)).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(logs.filter(line => line.startsWith("engine-login start"))).toHaveLength(1);
    expect(logs.filter(line => line.startsWith("engine-login end"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("SECRET123");
    expect(launches[0]).toMatchObject({ engine: "codex", action: "login", extra: { bot: "atlas" } });
  });
  it("refuses a browser session, an unknown action and extra parameters", async () => {
    await start();
    scope = "browser"; await expect(open()).rejects.toMatchObject({ status: 403 });
    scope = "owner-desktop";
    await expect(open("codex", "?action=status")).rejects.toMatchObject({ status: 400 });
    await expect(open("codex", "?action=login&x=1")).rejects.toMatchObject({ status: 400 });
    expect(launches).toEqual([]);
  });
  it("allows one login per engine at a time and frees it afterwards", async () => {
    await start();
    const first = await open("codex");
    await expect(open("codex")).rejects.toMatchObject({ status: 409 });
    const other = await open("claudeAgent"); other.close();
    const done = closed(first); first.close(); await done;
    await gone(launches[0]!.pid!); await new Promise(r => setTimeout(r, 100));
    const again = await open("codex"); again.close(); await closed(again);
  });
  it("closes with 1009 and kills the child past the output cap", async () => {
    await start({ limits: { maxOutBytes: 10 } });
    const ws = await open(); const code = closed(ws); ws.send("0123456789abcdef");
    expect(await code).toBe(1009);
    expect(await gone(launches[0]!.pid!)).toBe(true);
  });
  it("closes with 1009 past the input cap", async () => {
    await start({ limits: { maxInBytes: 8 } });
    const ws = await open(); const code = closed(ws); ws.send("0123456789");
    expect(await code).toBe(1009);
    expect(await gone(launches[0]!.pid!)).toBe(true);
  });
  it("closes on an idle timeout and on the total timeout", async () => {
    await start({ limits: { idleMs: 150 } });
    const idle = await open(); expect(await closed(idle)).toBe(1001); expect(await gone(launches[0]!.pid!)).toBe(true);
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    await start({ limits: { totalMs: 150, idleMs: 10_000 } });
    const long = await open(); const timer = setInterval(() => long.send("x"), 30);
    expect(await closed(long)).toBe(1001); clearInterval(timer);
    expect(logs.some(line => line.includes("reason=total-timeout"))).toBe(true);
  });
  it("ends the session when the launcher exits first", async () => {
    await start({ spawnLauncher: () => spawn("/bin/sh", ["-c", "exit 3"], { detached: true, stdio: ["pipe", "pipe", "pipe"] }) });
    const ws = await open(); expect(await closed(ws)).toBe(1000);
    await new Promise(r => setTimeout(r, 50));
    expect(logs.filter(line => line.startsWith("engine-login end"))[0]).toContain("exit=3");
  });
  it("a rejected handshake spawns nothing and frees the engine slot", async () => {
    await start();
    // Upgrade request without Sec-WebSocket-Key: ws answers 400 and never calls the upgrade callback.
    const raw = connect(port, "127.0.0.1");
    await new Promise<void>(resolve => raw.once("connect", resolve));
    raw.write("GET /api/engine-login/codex HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n");
    raw.resume();
    await new Promise(resolve => raw.once("close", resolve));
    expect(launches).toEqual([]);
    const ws = await open("codex"); ws.close(); await closed(ws);
    expect(launches).toHaveLength(1);
  });
  it("a socket that dies mid-handshake never leaks the slot or a child", async () => {
    await start();
    for (let i = 0; i < 3; i++) {
      const raw = connect(port, "127.0.0.1");
      await new Promise<void>(resolve => raw.once("connect", resolve));
      raw.write("GET /api/engine-login/codex HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      raw.destroy();
      await new Promise(r => setTimeout(r, 50));
    }
    for (const launch of launches) expect(await gone(launch.pid!)).toBe(true);
    const ws = await open("codex"); ws.close(); await closed(ws);
  });
  it("a failed spawn frees the slot and closes the socket", async () => {
    let fail = true;
    await start({ spawnLauncher: () => { if (fail) throw new Error("no sudo"); return spawn("/bin/cat", [], { detached: true, stdio: ["pipe", "pipe", "pipe"] }); } });
    const ws = await open("codex"); expect(await closed(ws)).toBe(1011);
    fail = false;
    const again = await open("codex"); again.close(); await closed(again);
  });
  it("does not take other paths", async () => {
    await start();
    await expect(new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/api/engine-login/pi`); ws.once("open", resolve); ws.once("error", reject); })).rejects.toBeTruthy();
  });
  it("takes the antigravityAgent sign-in per bot and hands the launcher its short engine name", async () => {
    await start();
    const before = ended("antigravityAgent"); const ws = await open("antigravityAgent", "?action=login&bot=atlas"); const done = closed(ws); ws.close(); await done;
    await settled("antigravityAgent", before);
    expect(launches.map(item => `${item.engine}:${item.action}`)).toContain("antigravityAgent:login");
    expect(launcherEngineName("antigravityAgent")).toBe("antigravity");
    expect(launcherEngineName("grokAgent")).toBe("grokAgent");
  });
  it("takes grokAgent and kimiAgent sign-ins and sign-outs (Kimi's sign-out is the launcher's own)", async () => {
    await start();
    for (const engine of ["grokAgent", "kimiAgent"]) {
      for (const action of ["login", "logout"]) {
        const before = ended(engine); const ws = await open(engine, `?action=${action}&bot=atlas`); const done = closed(ws); ws.close(); await done;
        await settled(engine, before); // the engine's one slot frees when its launcher has exited, not when the socket closes
      }
    }
    await expect(open("kimiAgent", "?action=status&bot=atlas")).rejects.toMatchObject({ status: 400 });
    expect(launches.map(item => `${item.engine}:${item.action}`)).toEqual(["grokAgent:login", "grokAgent:logout", "kimiAgent:login", "kimiAgent:logout"]);
    expect(logs.some(line => line.startsWith("engine-login start engine=kimiAgent action=logout device="))).toBe(true);
    expect(logs.some(line => line.startsWith("engine-login end engine=kimiAgent action=logout device="))).toBe(true);
  });
  it("requires a bot for a per-bot login, forwards it in the launcher request and refuses a bad one", async () => {
    await start();
    for (const engine of ["codex", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo"]) await expect(open(engine, "?action=login")).rejects.toMatchObject({ status: 400 });
    await expect(open("codex", "?action=login&bot=../x")).rejects.toMatchObject({ status: 400 });
    await expect(open("codex", `?action=login&bot=${"a".repeat(65)}`)).rejects.toMatchObject({ status: 400 });
    expect(launches).toEqual([]);
    const ws = await open("codex", "?action=login&bot=atlas-1"); const done = closed(ws); ws.close(); await done;
    expect(launches[0]).toMatchObject({ engine: "codex", action: "login", extra: { bot: "atlas-1" } });
    expect(launches[0]!.extra).not.toHaveProperty("secret");
  });
  it("takes Claude's home-wide login without a bot, and with a bot as that bot's own sign-in (the override), and its sign-out either way", async () => {
    await start();
    let before = ended("claudeAgent");
    const home = await open("claudeAgent", "?action=login"); const homeDone = closed(home); home.close(); await homeDone; await settled("claudeAgent", before); before++;
    expect(launches[0]).toMatchObject({ engine: "claudeAgent", action: "login", extra: {} });
    const own = await open("claudeAgent", "?action=login&bot=atlas"); const ownDone = closed(own); own.close(); await ownDone; await settled("claudeAgent", before); before++;
    expect(launches[1]).toMatchObject({ engine: "claudeAgent", action: "login", extra: { bot: "atlas" } });
    const back = await open("claudeAgent", "?action=logout&bot=atlas"); const backDone = closed(back); back.close(); await backDone;
    expect(launches[2]).toMatchObject({ engine: "claudeAgent", action: "logout", extra: { bot: "atlas" } });
    await expect(open("claudeAgent", "?action=login&bot=../x")).rejects.toMatchObject({ status: 400 });
  });
  it("takes opencodeGo sign-in with a bot and logout with or without one", async () => {
    await start();
    for (const query of ["?action=login&bot=atlas", "?action=logout&bot=atlas", "?action=logout"]) {
      const before = ended("opencodeGo"); const ws = await open("opencodeGo", query); const done = closed(ws); ws.close(); await done;
      await settled("opencodeGo", before); // the slot frees when the launcher has exited
    }
    expect(launches.map(item => `${item.engine}:${item.action}:${item.extra.bot ?? ""}`)).toEqual(["opencodeGo:login:atlas", "opencodeGo:logout:atlas", "opencodeGo:logout:"]);
  });
  describe("enroll-key", () => {
    const secret = "sk-test_0123456789abcdefghij";
    it("waits for the first message, then launches with it and never logs it", async () => {
      await start();
      const ws = await open("codex", "?action=enroll-key");
      await new Promise(r => setTimeout(r, 50));
      expect(launches).toEqual([]);
      ws.send(secret);
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      expect(launches[0]).toMatchObject({ engine: "codex", action: "enroll-key", extra: { secret } });
      expect(launches[0]!.extra).not.toHaveProperty("bot");
      const done = closed(ws); ws.close(); await done;
      expect(await gone(launches[0]!.pid!)).toBe(true);
      await new Promise(r => setTimeout(r, 100));
      expect(logs.join("\n")).not.toContain(secret);
      expect(logs.filter(line => line.startsWith("engine-login start"))).toHaveLength(1);
    });
    it("closes 1008 without spawning when the first message is not a key, and frees the slot", async () => {
      await start();
      for (const bad of ["too short", `${secret} with spaces`, "a".repeat(513), "key/with/slash/0123456789"]) {
        const ws = await open("codex", "?action=enroll-key"); const code = closed(ws); ws.send(bad);
        expect(await code).toBe(1008);
      }
      expect(launches).toEqual([]);
      expect(logs.join("\n")).not.toContain("too short");
      const again = await open("codex", "?action=enroll-key"); again.close(); await closed(again);
    });
    it("closes without spawning when the owner never sends a key", async () => {
      await start({ limits: { idleMs: 100 } });
      const ws = await open("codex", "?action=enroll-key");
      expect(await closed(ws)).toBe(1001);
      expect(launches).toEqual([]);
    });
    it("needs a valid provider for opencodeGo and takes none elsewhere, and takes no bot", async () => {
      await start();
      await expect(open("opencodeGo", "?action=enroll-key")).rejects.toMatchObject({ status: 400 });
      await expect(open("opencodeGo", "?action=enroll-key&provider=Bad Name")).rejects.toMatchObject({ status: 400 });
      await expect(open("codex", "?action=enroll-key&provider=openai")).rejects.toMatchObject({ status: 400 });
      await expect(open("codex", "?action=enroll-key&bot=atlas")).rejects.toMatchObject({ status: 400 });
      await expect(open("claudeAgent", "?action=enroll-key")).rejects.toMatchObject({ status: 400 });
      await expect(open("kimiAgent", "?action=enroll-key")).rejects.toMatchObject({ status: 400 });
      const ws = await open("opencodeGo", "?action=enroll-key&provider=opencode-go"); ws.send(secret);
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      expect(launches[0]).toMatchObject({ engine: "opencodeGo", action: "enroll-key", extra: { provider: "opencode-go", secret } });
      const done = closed(ws); ws.close(); await done;
    });
  });
});
