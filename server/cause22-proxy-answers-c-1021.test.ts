// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22, binding): NO transport size or count caps at all. Group A witness rows for
// the answer sites that had no 20 MiB row of their own. Owner of these rows and of the sites they drive: lane cause22-main-fable.
// Each row spawns the real proxy entry behind the real release door (testing/bound-proxy-fixture.ts runBoundBridge, owner turn),
// gives it a real far end (a loopback HTTP server or a real child process) that answers 20 MiB, and asserts the answer reaches the
// engine and the proxy serves the next call.
//   C1  drivers/phone-proxy.ts runAdb: 20 MiB of adb child output (SITES #17; also the phone caller of collectProxyUpstream, #10).
//   C2  drivers/phone-jobs-proxy.ts post: 20 MiB harness answer (the phone-jobs caller of collectProxyUpstream, #10).
//   C3  drivers/agents-proxy.ts apiLong: 20 MiB harness answer (the agents caller of collectProxyUpstream, #10). The engine gets
//       the agents proxy's kept model-facing trim of that answer (agents-result.ts), which is the one size rule the ruling keeps.
//   C4  connector-proxy.ts relay / readBounded: 20 MiB connected-apps answer (SITES #18).
// RED on c187b11166: collectProxyUpstream cut at 8 MiB (4 MiB for phone jobs) and readBounded at 8 MiB, each sealing the proxy, so
// the call is never answered.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";

const MiB = 1024 * 1024;
const ITEM = 20 * MiB;
type Reply = { id?: unknown; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string; data?: string }> }; error?: { message?: string } };
const init = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} });
const call = (id: number, name: string, args: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const parse = (frames: string[]) => frames.map((frame) => { try { return JSON.parse(frame) as Reply; } catch { return { id: frame } as Reply; } });
const env = { MURAGE_CONTROL_URL: "http://127.0.0.1:9", MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "B", MURAGE_THREAD_ID: "T" };

/** Writes `head`, then `bytes` bytes of "x", then `tail`, honouring backpressure. */
function writeBig(res: ServerResponse, head: string, bytes: number, tail: string): void {
  res.write(head);
  const piece = Buffer.alloc(64 * 1024, 0x78); let sent = 0;
  const pump = () => { while (sent < bytes) { const part = sent + piece.length > bytes ? piece.subarray(0, bytes - sent) : piece; sent += part.length; if (!res.write(part)) { res.once("drain", pump); return; } } res.end(tail); };
  res.on("error", () => {}); pump();
}

/** A loopback far end. `answer` decides per request; it gets the parsed JSON body. */
async function farEnd(answer: (path: string, body: any, res: ServerResponse) => void): Promise<{ url: string; paths: string[]; close(): void }> {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* not JSON */ }
      paths.push(req.url ?? "");
      answer(req.url ?? "", body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths, close: () => { server.closeAllConnections(); server.close(); } };
}

/** Runs one proxy entry: initialize, the big call, initialize again. Returns the parsed replies and the raw frames. */
async function drive(role: string, script: string, big: string, extra: Record<string, string>): Promise<{ replies: Reply[]; frames: string[] }> {
  const frames = await runBoundBridge(script, [init(0), big, init(2)], 3, false,
    { role, env: { ...env, ...extra }, owner: true, delays: [0, 2_000, 2_000], timeoutMs: 90_000 })
    .catch((error: unknown) => [`fixture: ${String(error)}`]);
  return { replies: parse(frames), frames };
}

describe("cause22-no-transport-caps: a 20 MiB answer passes the phone, phone-jobs, agents and connector proxies and the turn goes on", () => {
  // Each row runs twice: the 20 MiB item, and a 64 KiB control that takes the same path and passes on c187b11166 too, so a red
  // 20 MiB row is the size and nothing else.
  for (const [tag, BYTES] of [["", ITEM], ["control 64 KiB: ", 64 * 1024]] as const) {
  it(tag + "C1 phone proxy adb output (phone-proxy.ts runAdb): a 20 MiB screenshot from the adb child reaches the engine whole and the next call is answered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cause22-c-adb-"));
    try {
      // A real child process in adb's place (the proxy's own MURAGE_ADB_PATH seam): a device list, and a 20 MiB PNG-headed screenshot.
      const adb = join(dir, "adb");
      writeFileSync(adb, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("devices")) process.stdout.write("List of devices attached\\nFIXTUREDEVICE01 device usb:1-1 product:fixture model:Fixture device:fixture\\n");
else if (args.includes("screencap")) {
  const out = Buffer.alloc(${BYTES}, 0x61); Buffer.from("89504e470d0a1a0a", "hex").copy(out);
  process.stdout.write(out);
} else process.stdout.write("\\n");
`);
      chmodSync(adb, 0o755);
      // phone-proxy.ts starts its stdin loop only as the launched file: the entry block reads process.argv[1].
      const script = "process.argv[1]=process.cwd()+'/server/drivers/phone-proxy.ts';await import('./server/drivers/phone-proxy.ts');";
      const { replies } = await drive("phone", script, call(1, "screenshot", { serial: "FIXTUREDEVICE01" }), { MURAGE_ADB_PATH: adb });
      expect(replies.map((reply) => reply.id).sort(), "C1: every call is answered").toEqual([0, 1, 2]);
      const answer = replies.find((reply) => reply.id === 1);
      expect(answer?.error, "C1").toBeUndefined();
      const image = answer?.result?.content?.find((part) => part.type === "image");
      expect(Buffer.from(image?.data ?? "", "base64").length, "C1: every byte of the adb output reached the engine").toBe(BYTES);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  it(tag + "C2 phone jobs proxy answer (phone-jobs-proxy.ts post): a 20 MiB harness answer reaches the engine whole and the next call is answered", async () => {
    const far = await farEnd((_path, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); writeBig(res, '{"ok":true,"text":"', BYTES, '"}'); });
    try {
      const script = "const m=await import('./server/drivers/phone-jobs-proxy.ts');void m.runPhoneJobsProxy();";
      const { replies } = await drive("phoneJobs", script, call(1, "phone_location_get"),
        { MURAGE_CONTROL_URL: far.url, MURAGE_PHONE_TOOLS: "phone_location_get" });
      expect(replies.map((reply) => reply.id).sort(), "C2: every call is answered").toEqual([0, 1, 2]);
      const answer = replies.find((reply) => reply.id === 1);
      expect(far.paths, "C2: the call went to the harness route").toContain("/api/internal/device/call");
      expect(answer?.result?.isError, "C2").toBeUndefined();
      expect(answer?.result?.content?.[0]?.text?.length, "C2: every byte of the harness answer reached the engine").toBe(BYTES);
    } finally { far.close(); }
  }, 180_000);

  it(tag + "C3 agents proxy long call (agents-proxy.ts apiLong): a 20 MiB harness answer is read whole; the engine gets the kept model-facing trim, never a transport error, and the next call is answered", async () => {
    const far = await farEnd((path, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (path === "/api/internal/publish-site") writeBig(res, '{"ok":true,"text":"', BYTES, '"}');
      else if (path === "/api/internal/tool-result") res.end(JSON.stringify({ id: "r-00000000-0000-4000-8000-000000000000", truncated: true }));
      else res.end("{}");
    });
    try {
      const { replies } = await drive("agents", "await import('./server/drivers/agents-proxy.ts');", call(1, "publish_site", { folder: "site" }),
        { MURAGE_CONTROL_URL: far.url, MURAGE_HARNESS_URL: far.url, MURAGE_COMMS_TOKEN: "fixture-token" });
      expect(replies.map((reply) => reply.id).sort(), "C3: every call is answered").toEqual([0, 1, 2]);
      const answer = replies.find((reply) => reply.id === 1);
      expect(far.paths, "C3: the call went to the harness route").toContain("/api/internal/publish-site");
      expect(answer?.result?.isError, "C3: not an error result").toBe(false);
      const text = answer?.result?.content?.[0]?.text ?? "";
      // The body parses only when all of it was collected (its closing quote and brace are its last two bytes); a cut body is
      // answered as "{}" with no note. The overflow note of the agents tools (agents-result.ts, over 24,000 characters) is the one
      // size rule the ruling keeps. The preview in front of it is whatever redact.ts leaves (group B owns that file).
      expect(text, "C3: the answer was collected whole and parsed; the engine holds the kept model-facing trim, not a transport error").toContain("[Large tool result:");
    } finally { far.close(); }
  }, 180_000);

  it(tag + "C4 connector proxy answer (connector-proxy.ts relay readBounded): a 20 MiB connected-apps answer reaches the engine whole and the next call is answered", async () => {
    const far = await farEnd((_path, body, res) => {
      if (body?.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
      if (body.method === "tools/call") writeBig(res, `{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"content":[{"type":"text","text":"`, BYTES, '"}]}}');
      else res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
    });
    try {
      const { replies } = await drive("connectors", "await import('./server/connector-proxy.ts');", call(1, "FIXTURE_RUN_ACTION", { input: "a" }),
        { MURAGE_CONNECTOR_UPSTREAM_URL: `${far.url}/mcp`, MURAGE_HARNESS_URL: far.url, MURAGE_CONNECTORS_TOKEN: "fixture-token",
          MURAGE_CONNECTOR_LOOKUP_TIMEOUT_MS: "120000", MURAGE_CONNECTOR_ACTION_TIMEOUT_MS: "120000" });
      expect(replies.map((reply) => reply.id).sort(), "C4: every call is answered").toEqual([0, 1, 2]);
      const answer = replies.find((reply) => reply.id === 1);
      expect(answer?.error, "C4").toBeUndefined();
      expect(answer?.result?.isError, "C4").toBeUndefined();
      expect(answer?.result?.content?.[0]?.text?.length, "C4: every byte of the connected-apps answer reached the engine").toBe(BYTES);
    } finally { far.close(); }
  }, 180_000);
  }
});
