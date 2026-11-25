// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22, binding): NO transport size or count caps at all, matching upstream. This
// file is the group A witness: one row per hop class pushes a real 20 MiB item through the real entry point and the turn goes on.
// Owners: lane cause22-main-fable owns these rows and the hops they drive (mcp-bridge.ts, the tool proxies, proxy-turn-release.ts,
// turn-release-door.ts); group C (lane cause22-cli) owns the ingress behind the door; the mount relay rows are in
// drivers/cause22-owner-caps-relay-1021.test.ts.
//   B1/B2  the spawned MCP bridge (mcp-bridge.ts runMcpBridge): engine stdin, child stdout.
//   Q1-Q5  each spawned tool proxy's request line, behind the real release door (testing/bound-proxy-fixture.ts runBoundBridge).
//   R1-R3  a 20 MiB upstream answer through a spawned proxy and the real door back to the engine.
// The proxy rows run on the owner's turn: the ingress keeps its own bounds on other turns until group C's deletion is merged.
// RED on c187b11166: the 8 MiB bridge frame cap, the 64 KiB request caps and the 8/16 MiB answer caps throw; the bridge kills its
// child or the proxy seals, and the calls are never answered.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";

const MiB = 1024 * 1024;
type Reply = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The real bridge entry, a real child MCP server, real pipes. Returns what reached the engine and whether the bridge is still up. */
async function bridgeRun(childScript: string, input: string, want: number): Promise<{ replies: Reply[]; alive: boolean }> {
  const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
    runMcpBridge({command:process.execPath,args:['-e',${JSON.stringify(childScript)}],label:'fixture'});`;
  const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  bridge.stderr.resume();
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 60_000);
      let lines = 0;
      bridge.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; for (let at = chunk.indexOf("\n"); at !== -1; at = chunk.indexOf("\n", at + 1)) lines++; if (lines >= want) { clearTimeout(timer); resolve(); } });
      bridge.once("close", () => { clearTimeout(timer); resolve(); });
      bridge.stdin.on("error", () => {});
      bridge.stdin.write(input);
    });
    const alive = bridge.exitCode === null && bridge.signalCode === null;
    return { replies: output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Reply), alive };
  } finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
  }
}


// The child answers each request with the size of the text it was given; with BIG set it answers request 1 with a 20 MiB result.
const sizeChild = (big: boolean) => `const rl=require('node:readline').createInterface({input:process.stdin});const seen=[];
  rl.on('line',l=>{const m=JSON.parse(l);seen.push(m.params&&m.params.name);if(m.id===undefined)return;
    const text=${big ? "seen.length===1?'x'.repeat(20*1024*1024):'small'" : "'small'"};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text}],got:String(m.params&&m.params.arguments&&m.params.arguments.text||'').length,seen:seen.slice()}})+'\\n');});`;
const call = (id: number, name: string, text = "") => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text } } }) + "\n";
const init = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} });
const parse = (frames: string[]) => frames.map((frame) => { try { return JSON.parse(frame) as Reply; } catch { return { id: frame } as Reply; } });
const ITEM = 20 * MiB;

const env = { MURAGE_CONTROL_URL: "http://127.0.0.1:9", MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "B", MURAGE_THREAD_ID: "T" };
const PROXIES: Array<{ row: string; entry: string; role: string; script: string }> = [
  { row: "O1a headless browser proxy request line", entry: "server/drivers/headless-browser-proxy.ts runHeadlessBrowserProxy", role: "headlessBrowser",
    script: "const m=await import('./server/drivers/headless-browser-proxy.ts');void m.runHeadlessBrowserProxy();" },
  { row: "O1b unified browser proxy request line", entry: "server/drivers/unified-browser-proxy.ts runUnifiedBrowserProxy", role: "unifiedBrowser",
    script: "const m=await import('./server/drivers/unified-browser-proxy.ts');void m.runUnifiedBrowserProxy();" },
  { row: "O1c browser extension MCP request line", entry: "server/drivers/browser-extension-mcp.ts runBrowserExtensionMcp", role: "browser-extension",
    script: "const m=await import('./server/drivers/browser-extension-mcp.ts');void m.runBrowserExtensionMcp({config:{endpoint:'http://127.0.0.1:9/api/browser-extension/mcp',clientId:'paired_client',token:'a'.repeat(43)}});" },
  { row: "O1d host computer proxy request line", entry: "server/drivers/host-computer-proxy.ts runHostComputerProxy", role: "hostComputer",
    script: "const m=await import('./server/drivers/host-computer-proxy.ts');void m.runHostComputerProxy();" },
  { row: "O1e phone jobs proxy request line", entry: "server/drivers/phone-jobs-proxy.ts runPhoneJobsProxy", role: "phoneJobs",
    script: "const m=await import('./server/drivers/phone-jobs-proxy.ts');void m.runPhoneJobsProxy();" },
];

/** A loopback control route that answers every POST with a JSON body of about `bytes` bytes ({"ok":true,"text":"xxx..."}). */
async function bigControl(bytes: number): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":true,"text":"');
      const piece = Buffer.alloc(64 * 1024, 0x78); let sent = 0;
      const pump = () => { while (sent < bytes) { sent += piece.length; if (!res.write(piece)) { res.once("drain", pump); return; } } res.end('"}'); };
      res.on("error", () => {}); pump();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}
const RESPONSE_SITES: Array<{ row: string; role: string; script: string; extra: Record<string, string>; tool?: string; method?: string; args?: unknown; harness?: boolean }> = [
  { row: "R1 host computer proxy answer (host-computer-proxy.ts post)", role: "hostComputer", tool: "computer", extra: {},
    script: "const m=await import('./server/drivers/host-computer-proxy.ts');void m.runHostComputerProxy();" },
  { row: "R2 unified browser proxy answer (unified-browser-proxy.ts forward)", role: "unifiedBrowser", method: "tools/list", extra: {},
    script: "const m=await import('./server/drivers/unified-browser-proxy.ts');void m.runUnifiedBrowserProxy();" },
  { row: "R3 agents proxy answer (proxy-turn-release.ts proxyFetch / proxyUpstreamResponse body)", role: "agents", tool: "ask_user", args: { questions: [{ question: "q?" }] },
    extra: { MURAGE_COMMS_TOKEN: "fixture-token" }, harness: true, script: "await import('./server/drivers/agents-proxy.ts');" },
];


describe("cause22-no-transport-caps: a 20 MiB item passes every group A hop and the turn goes on", () => {
  it("B1 bridge engine stdin: a 20 MiB tool call reaches the tool server whole and the next call is served", async () => {
    const { replies, alive } = await bridgeRun(sizeChild(false), call(1, "big", "z".repeat(ITEM)) + call(2, "after"), 2);
    expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
    expect((replies[0]?.result as { got?: number })?.got, "every byte of the call reached the child").toBe(ITEM);
    expect((replies[1]?.result as { seen?: unknown })?.seen).toEqual(["big", "after"]);
    expect(alive).toBe(true);
  }, 120_000);

  it("B2 bridge child stdout: a 20 MiB tool result reaches the engine whole and the same child serves the next call", async () => {
    const { replies, alive } = await bridgeRun(sizeChild(true), call(1, "first") + call(2, "second"), 2);
    expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
    expect((replies[0]?.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text?.length, "every byte of the result reached the engine").toBe(ITEM);
    expect((replies[1]?.result as { seen?: unknown })?.seen).toEqual(["first", "second"]);
    expect(alive).toBe(true);
  }, 120_000);

  for (const { row, role, script } of PROXIES) it(`Q ${row}: a 20 MiB request is read whole, answered by the proxy itself, and the next call is answered`, async () => {
    // `initialize` is answered by each proxy itself, so the row needs no far end: the 20 MiB line is the item under test.
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "y".repeat(ITEM) } } });
    const replies = parse(await runBoundBridge(script, [init(0), big, init(2)], 3, false, { role, env, owner: true, delays: [0, 2_000, 2_000], raw: [1], timeoutMs: 60_000 })
      .catch((error: unknown) => [`fixture: ${String(error)}`]));
    // proxies that read lines concurrently may answer the next call first: every call is answered once, in any order
    expect(replies.map((reply) => reply.id).sort(), row).toEqual([0, 1, 2]);
    expect(replies.find((reply) => reply.id === 1)?.result, `${row}: the 20 MiB request got the proxy's own answer`).toBeDefined();
  }, 120_000);

  for (const { row, role, tool, method, args, extra, harness, script } of RESPONSE_SITES) it(`${row}: a 20 MiB upstream answer is passed on, never a size error, and the proxy answers the next call`, async () => {
    const control = await bigControl(ITEM);
    try {
      const call1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: method ?? "tools/call", params: method ? {} : { name: tool, arguments: args ?? {} } });
      const frames = await runBoundBridge(script, [init(0), call1, init(2)], 3, false,
        { role, env: { ...env, ...extra, MURAGE_CONTROL_URL: control.url, ...(harness ? { MURAGE_HARNESS_URL: control.url } : {}) }, owner: true, delays: [0, 2_000, 2_000], timeoutMs: 90_000 })
        .catch((error: unknown) => [`fixture: ${String(error)}`]);
      const replies = parse(frames);
      expect(replies.map((reply) => reply.id).sort(), row).toEqual([0, 1, 2]);
      const at = replies.findIndex((reply) => reply.id === 1);
      expect(replies[at]?.error, row).toBeUndefined();
      // the harness answer of the agents tool is read whole and turned into the tool's own text; the two others pass the body on
      if (!harness) expect(Buffer.byteLength(frames[at]!), `${row}: every byte of the answer reached the engine`).toBeGreaterThanOrEqual(ITEM);
    } finally { control.close(); }
  }, 180_000);
});
