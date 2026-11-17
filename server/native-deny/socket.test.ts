import { removeTempDirSync } from "../testing/cleanup.ts";
import { afterEach, describe, expect, it } from "vitest";
import { compileDenySpec, testTools } from "./test-support.ts";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { sha256 } from "./compile.ts";
import { createNativeDenySession, makeNativeDenyRequest } from "./backstop.ts";
import { startNativeDenySocket, requestNativeDeny } from "./socket.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "native-deny-socket-"));
  cleanups.push(async () => { removeTempDirSync(dir); });
  const session = createNativeDenySession({ turnId: "t", engine: "codex", onTamper: () => {}, log: () => {}, tools: testTools, generation: 1, policyHash: sha256("p"), spec: compileDenySpec({ selfPaths: [dir] }), cwd: dir, home: dir, shell: { path: "/bin/bash", mode: "command" }, envSha256: sha256("env") });
  return { session, path: join(dir, "gate.sock"), envFile: join(dir, "gate.env") };
}

describe("native deny isolated transport fixture", () => {
  it("binds a full roundtrip, denies wipe and retires on close; socket down is deny (M3)", async () => {
    const f = fixture(); const server = await startNativeDenySocket(f.session, f); cleanups.push(server.close);
    expect(statSync(f.envFile).mode & 0o777).toBe(0o600);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const req = makeNativeDenyRequest(f.session, "exec_command", { cmd: "echo ok" });
    expect((await requestNativeDeny(f.path, req)).allow).toBe(true);
    expect((await requestNativeDeny(f.path, req)).allow).toBe(false);
    expect((await requestNativeDeny(f.path, makeNativeDenyRequest(f.session, "exec_command", { cmd: "sh -c 'rm -rf /'" }))).allow).toBe(false);
    await server.close();
    expect((await requestNativeDeny(f.path, makeNativeDenyRequest(f.session, "exec_command", { cmd: "echo ok" }))).allow).toBe(false);
    expect(f.session.retired).toBe(true);
  });
  it("fails closed on truncated or malformed JSON, multiple frames and disconnected clients", async () => {
    const f = fixture(); const server = await startNativeDenySocket(f.session, f); cleanups.push(server.close);
    for (const text of ['{"v":2', 'not-json\n', '{}\n{}\n']) {
      const reply = await new Promise<string>(resolve => {
        let data = ""; const socket = net.createConnection(f.path, () => socket.end(text));
        socket.on("data", chunk => { data += chunk; }); socket.on("close", () => resolve(data)); socket.on("error", () => resolve(data));
      });
      expect(reply.includes('"allow":true')).toBe(false);
    }
  });
  it.each(["wrong-id", "operation", "partial", "oversize", "malformed", "disconnect", "timeout"])("client denies %s response", async kind => {
    const f = fixture(); const server = net.createServer(socket => {
      socket.on("error", () => {});
      socket.on("data", chunk => {
        if (kind === "operation") socket.end(JSON.stringify({ allow: true, callId: JSON.parse(String(chunk)).callId, operationSha256: "wrong" }) + "\n");
        if (kind === "partial") socket.end('{"allow":true');
        if (kind === "oversize") socket.end("x".repeat(9000) + "\n");
        if (kind === "wrong-id") socket.end('{"allow":true,"callId":"other"}\n');
        if (kind === "malformed") socket.end("broken\n");
        if (kind === "disconnect") socket.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(f.path, resolve));
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    expect((await requestNativeDeny(f.path, makeNativeDenyRequest(f.session, "exec_command", { cmd: "echo ok" }), 40)).allow).toBe(false);
  });
});
