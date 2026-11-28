// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 T1/T2 on the real proxy process: the list hides what the server named at launch (MURAGE_TOOLS_HIDDEN, never a server call:
// that call is made before the turn is bound and seals it), and every governed call re-reads the switches from the harness.
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const open: Array<{ child: ChildProcess; stub: Server }> = [];
afterEach(async () => {
  for (const { child, stub } of open.splice(0)) { child.kill(); await new Promise<void>(r => stub.close(() => r())); }
});
type Switches = { webRead?: { enabled: boolean }; webSearch?: { provider: string }; toolsOff?: string[] } | "missing" | "broken" | "forbidden";

async function start(initial: Switches, launchHidden?: string) {
  const state = { switches: initial, seen: [] as string[] };
  const stub = createServer((req, res) => {
    state.seen.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      if ((req.url ?? "").startsWith("/api/internal/tool-switches")) {
        if (state.switches === "broken") { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"boom"}'); return; }
        if (state.switches === "forbidden") { res.writeHead(403, { "content-type": "application/json" }); res.end('{"error":"unknown sender"}'); return; }
        if (state.switches === "missing") { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"nope"}'); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(state.switches)); return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"text":"ran"}');
    });
  });
  await new Promise<void>(r => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  const child = await spawnBoundProxy("agents", process.execPath, [PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_BOT_ID: "scout", MURAGE_THREAD_ID: "t1",
    MURAGE_COMMS_TOKEN: "tok-sv10", MURAGE_TURN_DEPTH: "0", ...(launchHidden !== undefined ? { MURAGE_TOOLS_HIDDEN: launchHidden } : {}) }, stdio: ["pipe", "pipe", "inherit"] });
  open.push({ child, stub });
  const pending = new Map<number, (m: any) => void>();
  let buf = ""; let n = 0;
  child.stdout!.on("data", c => {
    buf += c; let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); }
  });
  const rpc = (method: string, params?: unknown) => new Promise<any>(resolve => {
    const id = ++n; pending.set(id, resolve); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
  const names = async () => ((await rpc("tools/list")).result.tools as Array<{ name: string }>).map(t => t.name);
  return { rpc, names, state };
}

describe("agents proxy honours the Settings v10 tool switches", () => {
  it("lists what the launch hid, never asks the server to list, and refuses a switched-off tool at the call", async () => {
    const p = await start({ toolsOff: ["images"] }, JSON.stringify(["generate_image", "list_image_models"]));
    const hidden = await p.names();
    for (const name of ["generate_image", "list_image_models"]) expect(hidden).not.toContain(name);
    expect(hidden).toContain("list_bots");
    expect(p.state.seen.some(u => u.startsWith("/api/internal/tool-switches"))).toBe(false);
    const refused = await p.rpc("tools/call", { name: "generate_image", arguments: { prompt: "a cat" } });
    expect(refused.result.isError).toBe(true);
    expect(JSON.parse(refused.result.content[0].text)).toMatchObject({ code: "tool-off-for-bot", settingRef: { bot: "scout" } });
    expect(p.state.seen.some(u => u.startsWith("/api/internal/image"))).toBe(false);
  }, 30_000);
  it("a switch flipped after launch is refused at the next call even though the list still shows the tool", async () => {
    const p = await start({ toolsOff: [] }, "[]");
    expect(await p.names()).toContain("list_image_models");
    p.state.switches = { toolsOff: ["images"] };
    expect((await p.rpc("tools/call", { name: "list_image_models", arguments: {} })).result.isError).toBe(true);
    expect(p.state.seen.some(u => u.startsWith("/api/internal/image-models"))).toBe(false);
    p.state.switches = { toolsOff: [] };
    await p.rpc("tools/call", { name: "list_image_models", arguments: {} });
    expect(p.state.seen.some(u => u.startsWith("/api/internal/image-models"))).toBe(true);
  }, 30_000);
  it("garbage in the launch list hides every governed tool", async () => {
    const p = await start({ toolsOff: [] }, "not json");
    const names = await p.names();
    for (const name of ["web_search", "web_read", "generate_image", "send_voice_note"]) expect(names).not.toContain(name);
    expect(names).toContain("list_bots");
  }, 30_000);
  it("app-wide reader off refuses a new web_read for this bot", async () => {
    const p = await start({ webRead: { enabled: false } }, JSON.stringify(["web_read"]));
    expect(await p.names()).not.toContain("web_read");
    const fresh = await p.rpc("tools/call", { name: "web_read", arguments: { url: "https://example.com/a" } });
    expect(fresh.result.isError).toBe(true);
    expect(JSON.parse(fresh.result.content[0].text)).toMatchObject({ settingRef: { id: "tools.web-read" } });
  }, 30_000);
  it("an older server without the route refuses nothing at the call", async () => {
    const p = await start("missing");
    const names = await p.names();
    expect(names).toContain("web_search"); expect(names).toContain("generate_image");
    await p.rpc("tools/call", { name: "list_image_models", arguments: {} });
    expect(p.state.seen.some(u => u.startsWith("/api/internal/image-models"))).toBe(true);
  }, 30_000);
  it("a refusal other than 404 from the switches route refuses a governed call and runs nothing", async () => {
    const p = await start("forbidden");
    const refused = await p.rpc("tools/call", { name: "list_image_models", arguments: {} });
    expect(refused.result.isError).toBe(true);
    expect(JSON.parse(refused.result.content[0].text)).toMatchObject({ code: "tool-switches-unavailable" });
    expect(p.state.seen.some(u => u.startsWith("/api/internal/image-models"))).toBe(false);
  }, 30_000);
  it("an ungoverned tool call does not ask the harness for the switches", async () => {
    const p = await start({ toolsOff: ["images"] });
    p.state.seen.length = 0;
    await p.rpc("tools/call", { name: "list_bots", arguments: {} });
    expect(p.state.seen.some(u => u.startsWith("/api/internal/tool-switches"))).toBe(false);
  }, 30_000);
});
