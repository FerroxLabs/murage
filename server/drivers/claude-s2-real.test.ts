import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { parseMcpStatus } from "./mcp-readiness.ts";
import { cliStdinEnd } from "./cli-stdin-eof.ts";
import { killCliTree, awaitCliTreeStopped } from "../procs.ts";
import type { SendTurnInput } from "../contracts.ts";
import { requireRealClaudeS2Runner } from "./claude-s2-real-runner.fixture.ts";

const enabled = process.env.MURAGE_REAL_CLAUDE_S2 === "1";
if (!enabled) console.info("SKIP real Claude S2: set MURAGE_REAL_CLAUDE_S2=1; requires isolated Claude 2.1.310 and explicit provider credentials.");
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "real S2 fixture cleanup failed");
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read(); if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("real S2 fixture deadline");
    await delay(20);
  }
}

// A real stdio MCP child, spawned anew for each generation. The release file
// lets the test hold tools/list independently of the CLI's reconnect outcome.
const mountSource = `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const log = value => appendFileSync(process.env.S2_LOG, JSON.stringify(value) + '\\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
log({ event: 'spawn', pid: process.pid });
createInterface({ input: process.stdin }).on('line', async line => {
  const req = JSON.parse(line); log({ event: 'request', req });
  if (req.method === 'initialize') send({ id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 's2-fixture', version: '1' } } });
  else if (req.method === 'tools/list') {
    log({ event: 'list-wait' });
    while (!existsSync(process.env.S2_RELEASE)) await new Promise(r => setTimeout(r, 10));
    log({ event: 'list-answer' });
    send({ id: req.id, result: { tools: [{ name: process.env.S2_TOOL, description: 'Return the isolated fixture marker. Call this tool when asked.', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (req.method === 'tools/call') {
    if (process.env.S2_ASK === '1') {
      log({ event: 'server-request', id: 'old-server-request' });
      send({ id: 'old-server-request', method: 'elicitation/create', params: { message: 'Choose the isolated fixture value', requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } });
    } else send({ id: req.id, result: { content: [{ type: 'text', text: process.env.S2_TOOL }] } });
  } else if (req.id !== undefined && req.method) send({ id: req.id, result: {} });
});
`;

async function fixture() {
  if (process.platform !== "linux") throw new Error("real S2 qualification requires the pinned Linux host");
  const root = mkdtempSync(join(tmpdir(), "murage-s2-real-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); mkdirSync(home);
  const configDir = join(root, "claude"); mkdirSync(configDir);
  // No inherited HOME/config dirs, hooks, settings or live application data.
  // 7C supplies credentials explicitly through the process environment.
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "0", ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  const executable = await requireRealClaudeS2Runner();
  expect(execFileSync(executable, ["--version"], { env, cwd: root, encoding: "utf8", timeout: 10_000 })).toMatch(/^2\.1\.310\b/);
  const script = join(root, "mount.mjs"); writeFileSync(script, mountSource);
  const cred = createTurnCredentialStore(); cleanup.push(() => cred.dispose());
  const botId = randomUUID(); const threadId = randomUUID();
  const bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  function generation(n: number, ask = false, holdList = false) {
    const f = consumingFixture(undefined, { botId, threadId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const turn: SendTurnInput = { threadId, text: "isolated", releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1") };
    const log = join(root, `generation-${n}.jsonl`); const release = join(root, `release-${n}`);
    const tool = `generation_${n}_${randomUUID().replaceAll("-", "")}`;
    if (!holdList) writeFileSync(release, "release");
    return { f, turn, log, release, tool, accepted: [] as any[], servers: { one: { command: process.execPath, args: [script],
      env: { S2_LOG: log, S2_RELEASE: release, S2_TOOL: tool, S2_ASK: ask ? "1" : "0" } } } };
  }
  const records = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  let relay: CliMountRelay;
  let cli: ChildProcessWithoutNullStreams;
  const frames: any[] = [];
  function observeAccepted(g: ReturnType<typeof generation>) {
    const mount = relay.mounts.get("one")!;
    let pending = "";
    // Registered AFTER RelayedMount's data listener. Its synchronous ingress
    // acceptance/forwarding has run before this observer sees each frame.
    mount.child.stdout!.on("data", data => {
      pending += data;
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) return;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!mount.mount.ingress.sealed && !mount.mount.ingress.retired) g.accepted.push(JSON.parse(line));
      }
    });
  }
  async function start(g: ReturnType<typeof generation>) {
    relay = await CliMountRelay.create(g.turn, g.servers, {}, cred);
    observeAccepted(g);
    // The closure cleans up the CURRENT generation, including after failures.
    cleanup.push(async () => {
      try { await relay.finish(); }
      finally { if (cli) { killCliTree(cli); await awaitCliTreeStopped(cli); } }
    });
    const config = join(root, "mcp.json"); writeFileSync(config, JSON.stringify({ mcpServers: relay.servers }));
    cli = spawn(executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--allowedTools", "mcp__one__*", "--settings", "{}"],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });

    let pending = "";
    cli.stdout.on("data", data => { pending += data; for (;;) {
      const end = pending.indexOf("\n"); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { frames.push(JSON.parse(line)); } catch { /* non-protocol diagnostics */ }
    } });
    cli.stderr.resume();
    relay.attach(cli, () => {}, () => cliStdinEnd({ child: cli }));
    expect((await request({ subtype: "initialize" })).subtype).toBe("success");
    await until(() => records(g.log).some(r => r.event === "list-answer") ? true : undefined);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const answer = await request({ subtype: "mcp_status" });
      if (answer.subtype === "success" && parseMcpStatus(answer.response)?.get("one") === "connected") break;
      if (Date.now() >= deadline) throw new Error("initial real MCP status never connected");
      await delay(50);
    }
  }
  function write(value: unknown) { cli.stdin.write(JSON.stringify(value) + "\n"); }
  async function request(body: object) {
    const id = randomUUID(); write({ type: "control_request", request_id: id, request: body });
    return until(() => frames.find(f => f.type === "control_response" && f.response?.request_id === id)?.response);
  }
  function prompt(text: string) { write({ type: "user", message: { role: "user", content: text } }); }
  async function next(g: ReturnType<typeof generation>) {
    const previous = relay;
    expect(await previous.retireGeneration()).toBe(true);
    relay = await previous.nextGeneration(g.turn, g.servers, {}, () => { frames.push({ staleTicket: true }); });
    observeAccepted(g);
    return previous;
  }
  // Linux /proc is read-only. Match only descendants of this exact CLI pid.
  function shimPids(pid = cli.pid!): number[] {
    let children: number[];
    try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); }
    catch { return []; }
    return children.flatMap(child => {
      let command = ""; try { command = readFileSync(`/proc/${child}/cmdline`, "utf8"); } catch {}
      return [...(command.includes("cli-mount-shim") ? [child] : []), ...shimPids(child)];
    });
  }
  return { generation, records, start, request, prompt, next, frames, write, shimPids, get relay() { return relay; }, get cli() { return cli; } };
}

describe.skipIf(!enabled)("pinned real CLI S2 protocol qualification (isolated relay; not dispatcher coverage)", () => {
  it("T-S2-REAL-RELIST: next model turn calls the newly listed tool on the retained CLI", async () => {
    const x = await fixture(); const a = x.generation(1); await x.start(a);
    x.prompt(`Call mcp__one__${a.tool} exactly once, then say done.`);
    const firstResult = await until(() => x.frames.find(f => f.type === "result"), 90_000);
    expect(firstResult.is_error).not.toBe(true);
    expect(x.records(a.log).some(r => r.req?.method === "tools/call")).toBe(true);
    const pid = x.cli.pid; const b = x.generation(2); await x.next(b);
    expect((await x.request({ subtype: "mcp_reconnect", serverName: "one" })).subtype).toBe("success");
    expect(parseMcpStatus((await x.request({ subtype: "mcp_status" })).response)?.get("one")).toBe("connected");
    x.prompt(`Call mcp__one__${b.tool} exactly once, then say done.`);
    await until(() => x.records(b.log).find(r => r.req?.method === "tools/call"), 90_000);
    expect(x.records(b.log).filter(r => r.req?.method === "tools/call").map(r => r.req.params.name)).toEqual([b.tool]);
    expect(x.cli.pid).toBe(pid);
  }, 240_000);
  it("T-S2-REAL-IDENTITY: new shim and initialize; status cannot connect ahead of list acceptance", async () => {
    const x = await fixture(); const a = x.generation(1); await x.start(a);
    const oldPids = x.shimPids(); expect(oldPids.length).toBeGreaterThan(0);
    const ticket = x.relay.ticket; const b = x.generation(2, false, true); const old = await x.next(b);
    const reconnect = x.request({ subtype: "mcp_reconnect", serverName: "one" });
    await until(() => x.records(b.log).find(r => r.event === "list-wait"));
    const status = x.request({ subtype: "mcp_status" }).then(answer => {
      if (parseMcpStatus(answer.response)?.get("one") === "connected") {
        expect(b.accepted.some(frame => Array.isArray(frame.result?.tools))).toBe(true);
      }
      return answer;
    });
    // A CLI may serialize status behind reconnect; that is safe too.
    await delay(100);
    expect(x.records(b.log).some(r => r.req?.method === "initialize")).toBe(true);
    expect(x.relay.ticket).not.toBe(ticket); expect(old.ticket).toBe("");
    await until(() => oldPids.every(pid => !existsSync(`/proc/${pid}`)) ? true : undefined);
    const fresh = x.shimPids(); expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.some(pid => oldPids.includes(pid))).toBe(false);
    writeFileSync(b.release, "release"); expect((await reconnect).subtype).toBe("success"); await status;
    expect(parseMcpStatus((await x.request({ subtype: "mcp_status" })).response)?.get("one")).toBe("connected");
  }, 120_000);
  it("T-S2-NO-CROSS: a real CLI's held elicitation callback cannot reach the next generation", async () => {
    const x = await fixture(); const a = x.generation(1, true); await x.start(a);
    x.prompt(`Call mcp__one__${a.tool} exactly once.`);
    const ask = await until(() => x.frames.find(f => f.type === "control_request" && f.request?.subtype === "elicitation"), 90_000);
    expect(x.records(a.log).some(r => r.event === "server-request")).toBe(true);
    const ticket = x.relay.ticket; const b = x.generation(2); await x.next(b);
    expect((await x.request({ subtype: "mcp_reconnect", serverName: "one" })).subtype).toBe("success");
    x.write({ type: "control_response", response: { subtype: "success", request_id: ask.request_id,
      response: { action: "accept", content: { value: "delayed-N-answer" } } } });
    const stale = connect(x.relay.socketPath); stale.on("error", () => {});
    await once(stale, "connect"); const closed = once(stale, "close");
    stale.write(JSON.stringify({ server: "one", ticket }) + "\n"); await closed;
    expect(x.frames.some(f => f.staleTicket)).toBe(true);
    await x.request({ subtype: "mcp_status" }); await delay(1_000);
    expect(x.records(b.log).some(r => r.req?.id === "old-server-request" || JSON.stringify(r).includes("delayed-N-answer"))).toBe(false);
    expect(b.f.refusals).toBe(0);
  }, 180_000);
  it("T-S2-REAL-SHIM-EOF: real CLI shim exits on socket EOF and does not reconnect itself", async () => {
    const x = await fixture(); const a = x.generation(1); await x.start(a);
    const oldPids = x.shimPids(); expect(oldPids.length).toBeGreaterThan(0);
    expect(await x.relay.retireGeneration()).toBe(true);
    await until(() => oldPids.every(pid => !existsSync(`/proc/${pid}`)) ? true : undefined);
    await delay(1_000);
    expect(x.shimPids()).toEqual([]); expect(x.cli.exitCode).toBeNull(); expect(a.f.refusals).toBe(0);
  }, 120_000);
});
