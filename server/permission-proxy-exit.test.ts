// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PXY / P7b: the permission proxy's main answer is refused by the verdict port (the lease is revoked exactly when
// the answer frame asks for its verdict). The release seals, sends one -32099 terminal, ends stdout and closes.
// The proxy must then end by itself: the broker socket it holds must not keep the sealed process alive.
// Harness = spawnBoundProxy inlined with a gated verdict server.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createPermissionBroker } from "./drivers/claude.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const proxy = fileURLToPath(new URL("./permission-proxy.ts", import.meta.url));
it("P7b permission-proxy answer refused by the verdict port -> one -32099 terminal, stdout ended, the proxy exits 1 by itself, no answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ncr4c6-p7b-"));
  const fixture = consumingFixture(), caps = new InternalCapabilities();
  caps.begin("B", "T", fixture.binding.identity.dispatchGeneration);
  const home = mkdtempSync(join(tmpdir(), "ncr4c6-p7b-home-"));
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:permission:frame", "body"), () => []);
  let armed = false, upstreamOk = 0, upstreamRefused = 0, verdictsIssued = 0, verdictsRefused = 0;
  const verdictIds: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    let body: any;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const claim = caps.resolve(req.headers.authorization);
      if (!claim) throw new Error("authority");
      body = JSON.parse(Buffer.concat(chunks).toString());
      if (body?.operation === "upstream") {
        try { authority.reserveUpstream(claim, body); } catch (e) { upstreamRefused++; throw e; }
        upstreamOk++; res.end(JSON.stringify({ reserved: true })); return;
      }
      verdictIds.push(body?.requestId);
      if (armed) fixture.replace(); // the lease is revoked exactly when the answer frame asks for its verdict
      const envelope = authority.verdict(claim, body);
      verdictsIssued++; res.end(JSON.stringify(envelope));
    } catch { if (body?.operation !== "upstream") verdictsRefused++; instance.ingress.seal(); res.writeHead(409).end(); }
  });
  server.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));

  let asks = 0;
  const broker = await createPermissionBroker({
    socketPaths: [join(dir, "p.sock")],
    onAsk: (ask) => { asks++; armed = true; broker.answer(ask.id, "allow", "Owner decision"); },
    onResolve: () => {},
  });
  const child = spawn(process.execPath, [proxy, broker.socketPath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true, env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, MURAGE_DATA_DIR: home,
      TMPDIR: home, TMP: home, TEMP: home, NODE_ENV: "test", ELECTRON_RUN_AS_NODE: "1",
      MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token,
      MURAGE_RELEASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } });
  const rawLines: string[] = [], delivered: string[] = [], terminals: any[] = [], ipcOther: unknown[] = [];
  let stdoutEnded = false, exit: { code: number | null; signal: string | null } | undefined, killedByHarness = false;
  let raw = "", terminalExit: ReturnType<typeof setTimeout> | undefined;
  child.stdout!.setEncoding("utf8").on("data", chunk => {
    raw += chunk; let nl: number;
    while ((nl = raw.indexOf("\n")) >= 0) {
      const line = raw.slice(0, nl); raw = raw.slice(nl + 1); rawLines.push(line);
      try {
        const envelope = decodeReleaseEnvelope(line);
        instance.ingress.deliver(envelope, frame => { delivered.push(frame); });
        child.send({ type: "turn-release-ack", instanceId: instance.instanceId, sequence: envelope.sequence });
      } catch { instance.ingress.seal(); }
    }
  });
  child.stdout!.once("end", () => { stdoutEnded = true; });
  child.stderr!.resume();
  child.on("message", (m: any) => {
    instance.ingress.seal();
    if (m?.type === "turn-release-terminal") {
      terminals.push(m.frame);
      // same bound as spawnBoundProxy: the supervisor lets the child flush, then bounds its lifetime
      terminalExit ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { killedByHarness = true; child.kill(); } }, 1000);
    } else ipcOther.push(m);
  });
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  try {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/fixture/a.txt", content: "x" } } } });
    instance.ingress.request(request, () => { child.stdin!.write(request + "\n"); });
    const t0 = Date.now();
    while (terminals.length === 0 && !exit && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 20));
    const graceStart = Date.now();
    while (!exit && Date.now() - graceStart < 800) await new Promise(r => setTimeout(r, 20)); // inside the supervisor's 1000ms kill bound
    const frames = [...rawLines, ...delivered];
    const answerFrames = delivered.filter(f => { try { const v = JSON.parse(f); return v.id === 1 && "result" in v; } catch { return false; } });
    const facts = {
      asks, verdictIds, verdictsIssued, verdictsRefused, upstreamOk, upstreamRefused, lineageRefusals: fixture.refusals,
      terminals: terminals.map(t => ({ id: t?.id, code: t?.error?.code, data: t?.error?.data })),
      terminal32099: terminals.filter(t => t?.error?.code === -32099).length + frames.filter(f => f.includes("-32099")).length,
      stdoutLines: rawLines.length, deliveredFrames: delivered.length, answerFrames: answerFrames.length,
      stdoutEnded, exit, killedByHarness, ipcOther: ipcOther.length, sealed: instance.ingress.sealed,
    };
        expect(facts.asks, "the ask reached the broker (path reached)").toBe(1);
    expect(facts.terminal32099, "exactly one -32099 terminal (terminalProxyRefusal)").toBe(1);
    expect(facts.terminals[0]?.data).toEqual({ code: "MEMORY_CONTEXT_REVOKED", terminal: true });
    expect(facts.answerFrames, "no answer frame").toBe(0);
    expect(facts.stdoutEnded, "stdout ended").toBe(true);
    expect(facts.killedByHarness, "the proxy ended by itself, not by the supervisor's kill").toBe(false);
    expect(facts.exit, "exit code 1, no signal").toEqual({ code: 1, signal: null });
  } finally {
    if (terminalExit) clearTimeout(terminalExit);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    instance.dispose(); broker.close();
    server.closeAllConnections(); for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
    fixture.close(); removeTempDirSync(dir); removeTempDirSync(home);
  }
});
