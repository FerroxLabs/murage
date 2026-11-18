import { expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fixtureContract } from "./memory/testing/writetime-fixture.ts";
const available = existsSync(new URL("./consuming-turn-ingress.ts", import.meta.url));
const ingress = available ? await import("./consuming-turn-ingress.ts") : undefined;
const fixtures = available ? await import("./testing/consuming-fixture.ts") : undefined;
const response = available ? await import("./consuming-turn-response.ts") : undefined;

// red-at-4df086541: the actual MCP client could return a delayed custom
// result after revocation/replacement, or recover from loss without sealing
// the consuming lease. The child records only a count, never request content.
it.each(["refusal", "replacement", "transport-loss"])("T-EXTERNAL-STOP actual custom MCP/%s", async failure => {
  expect(ingress?.createProxyReleaseAuthority, "custom children require final ingress").toBeTypeOf("function");
  const { createLedgerLease } = await import("./ledger-refusal.ts");
  const { InternalCapabilities } = await import("./internal-capabilities.ts");
  const { createMcpMountAdmission, buildMcpServers } = await import("./drivers/mcp-mounts.ts");
  const { openChatMcpServers } = await import("./drivers/chat-mcp-client.ts");
  const { releaseNativeAnswer } = await import("./drivers/engine-input.ts");
  const home = mkdtempSync(join(tmpdir(), "murage-custom-stop-")), script = join(home, "custom.mjs"), pending = join(home, "pending");
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line), send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.method==='initialize') send({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list') send({tools:[{name:'hold',inputSchema:{type:'object'}}]});
 if(m.method==='tools/call') writeFileSync(process.env.PENDING,'1');
});`);
  let lease: ReturnType<typeof createLedgerLease>;
  const f = fixtures!.consumingFixture(undefined, { onRefused: verdict => lease.onLedgerRefused(verdict) });
  const caps = new InternalCapabilities(); caps.begin("B", "T", f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, ingress!.createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  let sessions: import("./drivers/chat-mcp-client.ts").ChatMcpSession[] = [], child: ReturnType<typeof spawn> | undefined;
  const settle = vi.fn(), present = vi.fn(), stopped = vi.fn(async (_id: string) => { for (const session of sessions) session.close(); return false; });
  lease = createLedgerLease(f.binding.identity, { seal: vi.fn(), interrupt: stopped, settle, present, quarantine: vi.fn() });
  lease.attach("custom-provider");
  try {
    const servers = buildMcpServers({ threadId: "T", text: "fixture", releaseBinding: f.binding, mountAdmission: admission,
      integrations: { custom: { fixture: { command: process.execPath, args: [script], env: { PENDING: pending } } } } })!;
    const opened = await openChatMcpServers(servers, { cwd: home, spawn: (command, args, env) => {
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); return child;
    } });
    sessions = opened.sessions;
    expect(opened.failed).toEqual([]); expect(sessions).toHaveLength(1);
    const result = sessions[0]!.callTool("hold", {}, {}).then(() => "released", () => "refused");
    await expect.poll(() => existsSync(pending), { timeout: 1000 }).toBe(true);
    if (failure === "transport-loss") child!.kill();
    else {
      if (failure === "refusal") f.flip(); else f.replace();
      expect(() => releaseNativeAnswer(f.binding, "openai:decision", "allow", vi.fn())).toThrow("MEMORY_CONTEXT_REVOKED");
    }
    expect(await result).toBe("refused");
    if (failure === "transport-loss") {
      expect(sessions[0]!.closed).toBe(true);
      expect(stopped).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
      expect(present).not.toHaveBeenCalled(); expect(f.refusals).toBe(0);
      expect(lease.quarantined).toBe(false);
      await expect(sessions[0]!.callTool("hold", {}, {})).rejects.toThrow();
    } else {
      await expect.poll(() => settle.mock.calls.length, { timeout: 1000 }).toBe(1);
      expect(stopped).toHaveBeenCalledExactlyOnceWith("custom-provider"); expect(present).toHaveBeenCalledTimes(1);
      expect(f.refusals).toBe(1);
      await expect.poll(() => lease.quarantined, { timeout: 1000 }).toBe(true);
      const write = vi.fn();
      expect(() => releaseNativeAnswer(f.binding, "openai:tool-append", "late", write)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(write).not.toHaveBeenCalled();
    }
  } finally {
    for (const session of sessions) session.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(sessions.map(session => session.teardown.wait({ closeMs: 3000, maxMs: 8000 })));
    admission.dispose(); f.close(); removeTempDirSync(home);
  }
});

// red-at-4df086541: transport loss did not invalidate outstanding result
// authority together with the exact admitted consuming lifecycle.
it.each(["error", "exit", "close", "end", "disconnect", "ack-timeout"])("T-EXTERNAL-STOP %s seals an outstanding permit", async event => {
  expect(ingress?.createConsumingIngress, "transport terminal paths must seal pending authority").toBeTypeOf("function");
  vi.useFakeTimers();
  const f = fixtures!.consumingFixture(), source = new EventEmitter(), write = vi.fn();
  try {
    const channel = ingress!.createConsumingIngress(f.binding, "transport");
    channel.supervise(source);
    channel.request('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', () => {});
    const permit = channel.issue({ instanceId: "transport", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}',
      descriptor: response!.registerConsumingDescriptor("proxy:custom:frame", "body"), refs: [] });
    if (event === "ack-timeout") await vi.advanceTimersByTimeAsync(5000);
    else source.emit(event);
    expect(channel.sealed).toBe(true);
    expect(() => channel.deliver(permit, write)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(event === "ack-timeout" ? 1 : 0);
  } finally { f.close(); vi.useRealTimers(); }
});

// red-at-4df086541: a live third-party result and an outstanding permit were
// independent of the refused engine lease. Only this isolated child's pipes
// are used; a requested but unconfirmed stop must retain quarantine.
it("T-EXTERNAL-STOP quarantines a pending process and suppresses its delayed answer", async () => {
  expect(ingress?.createConsumingIngress, "external results require a bound final acceptance").toBeTypeOf("function");
  const { createLedgerRefusal } = await import("./ledger-refusal.ts");
  const native = await import("./drivers/engine-input.ts");
  const f = fixtures!.consumingFixture(), settle = vi.fn(), quarantine = vi.fn(), answer = vi.fn();
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n');process.stdin.once('data',()=>process.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n'));"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "close");
  try {
    await once(child.stdout!, "data");
    const lease = createLedgerRefusal(f.binding.identity, { seal: vi.fn(), interrupt: async () => false, settle, quarantine, present: vi.fn() });
    const binding = response!.bindConsumingTurn({ ...f.binding, onLedgerRefused(verdict) { f.binding.onLedgerRefused(verdict); lease.onLedgerRefused(verdict); } });
    const channel = ingress!.createConsumingIngress(binding, "pending-child");
    channel.request('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', () => {});
    const permit = channel.issue({ instanceId: "pending-child", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}',
      descriptor: response!.registerConsumingDescriptor("proxy:custom:frame", "body"), refs: [] });
    f.flip();
    expect(() => native.releaseNativeAnswer(binding, "openai:decision", "allow", answer)).toThrow("MEMORY_CONTEXT_REVOKED");
    const delayed = once(child.stdout!, "data"); child.stdin!.write("finish\n");
    expect(String((await delayed)[0])).toContain('"result"');
    expect(() => channel.deliver(permit, answer)).toThrow("MEMORY_CONTEXT_REVOKED");
    await Promise.resolve(); await Promise.resolve();
    expect(answer).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledTimes(1); expect(lease.quarantined).toBe(true);
  } finally { child.kill(); await exited; f.close(); }
});

// red-at-4df086541: an outstanding external permit could survive a later refusal.
it("T-EXTERNAL-STOP suppresses an already issued external result after refusal", () => {
  expect(ingress?.createConsumingIngress, "external answers require server-owned final ingress").toBeTypeOf("function");
  const f = fixtures!.consumingFixture();
  try {
    const channel = ingress!.createConsumingIngress(f.binding, "external");
    channel.request('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', () => {});
    const permit = channel.issue({ instanceId: "external", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}',
      descriptor: response!.registerConsumingDescriptor("proxy:custom:frame", "body"), refs: [] });
    f.flip();
    const write = vi.fn();
    expect(() => channel.deliver(permit, write)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(() => channel.deliver(permit, write)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
  } finally { f.close(); }
});

const held: Array<{ close(): void }> = [];
afterEach(() => held.splice(0).forEach(f => f.close()));

// red-at-4df086541: T-EXTERNAL-STOP. The external operation is deliberately
// unresolved: only the next Murage boundary and exact local lease are claimed.
it("T-EXTERNAL-STOP seals outstanding permits while unconfirmed work is quarantined", async () => {
  const api = await fixtureContract<typeof import("./consuming-turn-response.ts")>(new URL("./consuming-turn-response.ts", import.meta.url), "§12.5 external work still needs a bound Murage acceptance gate");
  const { consumingFixture } = await import("./testing/consuming-fixture.ts");
  const { createConsumingIngress } = await import("./consuming-turn-ingress.ts");
  const { createLedgerRefusal } = await import("./ledger-refusal.ts");
  const old = consumingFixture(), next = consumingFixture(); held.push(old, next);
  const stop = vi.fn(async () => false), settle = vi.fn(), quarantine = vi.fn();
  const handler = createLedgerRefusal(old.binding.identity, { seal: vi.fn(), interrupt: stop, settle, quarantine, present: vi.fn() });
  const bound = api.bindConsumingTurn({ ...old.binding, onLedgerRefused: verdict => { handler.onLedgerRefused(verdict); old.binding.onLedgerRefused(verdict); } });
  const ingress = createConsumingIngress(bound, "external"), write = vi.fn();
  ingress.request('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', () => {});
  const envelope = ingress.issue({ instanceId: "external", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}', refs: [], descriptor: api.registerConsumingDescriptor("proxy:custom:frame", "body") });
  old.flip();
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED");
  await Promise.resolve(); await Promise.resolve();
  expect(write).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
  expect(quarantine).toHaveBeenCalledOnce(); expect(handler.identity).toEqual(old.binding.identity); expect(next.refusals).toBe(0);
});
