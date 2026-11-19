import { fencedTurnInput } from "./engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { hasClaudeS2Pending, claudeS2HasLiveTurn } from "./claude-s2-pending.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { recordEvents } from "../testing/events.ts";
import type { SendTurnInput } from "../contracts.ts";
import { requireRealClaudeS2Runner } from "./claude-s2-real-runner.fixture.ts";
import * as qualification from "./claude-s2-qualification.ts";

const wire = vi.hoisted(() => ({ held: undefined as undefined | (() => void), cliPids: [] as number[] }));
// Delay delivery BELOW the production primitive: the driver has answered N
// and removed its card, but the real CLI callback resumes only after N+1.
import * as procs from "../procs.ts";
beforeEach(() => {
  const spawn = procs.spawnCli;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args);
    if (args[1]?.includes("--input-format") && child.stdin) {
      wire.cliPids.push(child.pid!);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((...values: Parameters<typeof write>) => {
        let frame: any; try { frame = JSON.parse(String(values[0])); } catch {}
        if (!wire.held && frame?.type === "control_response" && frame.response?.response?.action === "accept") {
          wire.held = () => { write(...values); };
          return true;
        }
        return write(...values);
      }) as typeof child.stdin.write;
    }
    return child;
  });
});
const enabled = process.env.MURAGE_REAL_CLAUDE_S2 === "1";
if (!enabled) console.info("SKIP T-S2-NO-CROSS-PRODUCTION: set MURAGE_REAL_CLAUDE_S2=1; pinned 2.1.310 and explicit provider credentials required.");
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  wire.held = undefined; wire.cliPids = []; vi.restoreAllMocks(); vi.unstubAllEnvs();
  resetClaudeVersionGate();
});
async function until(check: () => boolean, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("real production S2 deadline"); await new Promise(r => setTimeout(r, 20)); }
}
const source = `
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const [generationPath, logPath, releasePath] = process.argv.slice(2);
const generation = Number(readFileSync(generationPath, 'utf8'));
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
createInterface({input:process.stdin}).on('line', async line => {
  const req = JSON.parse(line); appendFileSync(logPath, JSON.stringify({generation,req})+'\\n');
  if (req.method === 'initialize') send({id:req.id,result:{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}}});
  else if (req.method === 'tools/list') {
    if (process.env.S2_HOLD_LIST === '1' && generation === 2) while (!existsSync(releasePath+'-list-2')) await new Promise(r=>setTimeout(r,10));
    send({id:req.id,result:{tools:[{name:'probe',description:'Call once when asked to probe.',inputSchema:{type:'object',properties:{}}}]}});
  }
  else if (req.method === 'tools/call') {
    if (generation === 1) {
      send({id:'old-server-request',method:'elicitation/create',params:{message:'Isolated test: choose yes',requestedSchema:{type:'object',properties:{value:{type:'string',enum:['yes']}},required:['value']}}});
      while (!existsSync(releasePath)) await new Promise(r=>setTimeout(r,10));
    }
    if (generation === 2) while (!existsSync(releasePath+'-2')) await new Promise(r=>setTimeout(r,10));
    send({id:req.id,result:{content:[{type:'text',text:'probe complete'}]}});
  } else if(req.id !== undefined && req.method) send({id:req.id,result:{}});
});
`;

it("T-S2-NO-CROSS-PRODUCTION-OFFLINE: relist holds the prompt; delayed old transport cannot deliver or close generation N+1", async () => {
  ensureDirs();
  // The protocol executable is an isolated wire fixture. Its test supplies
  // an explicit receipt at this I/O edge rather than an environment unlock.
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-protocol-fixture" };
  vi.spyOn(qualification, "claudeS2QualifiedCli").mockImplementation(async () => qualification.claudeS2Qualified({},
    receipt.platform, receipt.version, receipt.build, receipt.arch, [receipt]));
  // This offline protocol child has an injected fixture receipt at both
  // qualification edges, including the final synchronous freshness check.
  vi.spyOn(qualification, "claudeS2QualifiedCliNow").mockImplementation(() => qualification.claudeS2Qualified({},
    receipt.platform, receipt.version, receipt.build, receipt.arch, [receipt]));
  const root = mkdtempSync(join(tmpdir(), "s2-offline-no-cross-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), config = join(root, "config"); mkdirSync(home); mkdirSync(config);
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  const protocolLog = join(root, "cli.jsonl"); vi.stubEnv("FAKE_CLAUDE_S2_PROTOCOL_LOG", protocolLog);
  const cli = join(root, "offline-cli.mjs");
  // The offline peer has no model round trip. The real process reader uses
  // whole-second ps ages and conservatively excludes children born in init's
  // second. Give its genuinely initialized MCP children two clock boundaries
  // before init; retain real probes and the existing test deadline.
  // The executable is copied into its disposable home; preserve the shared
  // Windows child-process wrapper when resolving imports from that new path.
  const peer = readFileSync(new URL("claude-s2-protocol-cli.fixture.mjs", import.meta.url), "utf8")
    .replaceAll('"../../shared/win-hide-child-process.mjs"', JSON.stringify(new URL("../../shared/win-hide-child-process.mjs", import.meta.url).href));
  const init = '  out({ type: "system", subtype: "init",';
  expect(peer).toContain(init);
  writeFileSync(cli, peer.replace(init, `  const baselineReadyAt = (Math.floor(Date.now() / 1000) + 2) * 1000;
  while (Date.now() < baselineReadyAt) await new Promise(resolve => setTimeout(resolve, Math.min(100, baselineReadyAt - Date.now())));
${init}`));
  chmodSync(cli, 0o755);
  const script = join(root, "mount.mjs"), gen = join(root, "generation"), log = join(root, "requests.jsonl"), release = join(root, "tool-result");
  writeFileSync(script, source); writeFileSync(gen, "1");
  const relays: CliMountRelay[] = [];
  const create = CliMountRelay.create.bind(CliMountRelay);
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => { const r = await create(...args); relays.push(r); return r; });
  const next = CliMountRelay.prototype.nextGeneration;
  vi.spyOn(CliMountRelay.prototype, "nextGeneration").mockImplementation(async function (this: CliMountRelay, ...args: Parameters<typeof next>) {
    const r = await next.apply(this, args); relays.push(r); return r;
  });
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "offline S2 protocol", enabled: true,
    environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter), bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(text: string): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const input: SendTurnInput = { text, threadId, cwd: root, draftOnly: true, releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: [script, gen, log, release], env: { S2_HOLD_LIST: "1" } } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const records = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  const first = await instance.adapter.sendTurn(turn("first"));
  const old = relays[0]!, oldTicket = old.ticket, oldMount = [...old.mounts.values()][0]!;
  const ask = await events.until(e => e.type === "request.opened" && e.turnId === first.turnId);
  if (ask.type !== "request.opened") throw new Error("offline elicitation missing");
  expect(await instance.adapter.respondToRequest(threadId, ask.requestId!, { behavior: "answer", answers: [{ id: "value", selected: ["yes"] }] })).toBe("answered");
  await until(() => !!wire.held, 20_000);
  writeFileSync(release, "release");
  await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
  expect(oldMount.mount.ingress.retired).toBe(true);
  writeFileSync(gen, "2");
  const sending = instance.adapter.sendTurn(turn("second"));
  await until(() => records(log).some(r => r.generation === 2 && r.req.method === "tools/list"), 20_000);
  expect(hasClaudeS2Pending(threadId)).toBe(true); expect(claudeS2HasLiveTurn(threadId)).toBe(false);
  expect(events.events.filter(e => e.type === "turn.started")).toHaveLength(1);
  expect(records(protocolLog).filter(r => r.event === "prompt").map(r => r.text)).toEqual(["first"]);
  writeFileSync(release + "-list-2", "release list");
  const second = await sending;
  expect(relays).toHaveLength(2); expect(wire.cliPids).toHaveLength(1);
  expect(relays[1]!.ticket).not.toBe(oldTicket);
  await until(() => records(log).some(r => r.generation === 2 && r.req.method === "tools/call"), 20_000);
  wire.held!();
  await until(() => records(protocolLog).some(r => r.event === "delayed-answer"), 20_000);
  // Deliver already-buffered events below the retired transport listeners.
  // They must neither write old content nor seal/finish the successor.
  oldMount.child.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":999,"result":{"content":[{"type":"text","text":"old-generation-marker"}]}}\n'));
  oldMount.child.stdout!.emit("end"); oldMount.child.emit("error", new Error("delayed old transport"));
  await old.finish();
  const fresh = relays[1]!, stale = connect(fresh.socketPath); stale.on("error", () => {});
  await once(stale, "connect"); const closed = once(stale, "close");
  stale.write(JSON.stringify({ server: Object.keys(fresh.servers)[0], ticket: oldTicket }) + "\n"); await closed;
  expect(existsSync(fresh.socketPath)).toBe(true);
  expect([...fresh.mounts.values()].every(m => !m.mount.ingress.retired && !m.mount.ingress.sealed)).toBe(true);
  expect(records(log).filter(r => r.generation === 2).some(r => r.req.id === "old-server-request" || JSON.stringify(r).includes("old-generation-marker"))).toBe(false);
  expect(bindings[1]!.refusals).toBe(0);
  writeFileSync(release + "-2", "release second tool");
  expect(await events.until(e => e.type === "turn.completed" && e.turnId === second.turnId)).toMatchObject({ ok: true });
  expect(records(protocolLog).filter(r => r.event === "prompt").map(r => r.text)).toEqual(["first", "second"]);
  const socket = fresh.socketPath, credential = fresh.cred!.path;
  await instance.dispose();
  expect(existsSync(socket)).toBe(false); expect(existsSync(credential)).toBe(false);
  for (const pid of wire.cliPids) expect(() => process.kill(pid, 0)).toThrow();
}, 60_000);
it.skipIf(!enabled)("T-S2-NO-CROSS-PRODUCTION: real delayed callback after production result settlement and reconnect", async () => {
  ensureDirs(); // suite-owned isolated data directory, never the live app
  const root = mkdtempSync(join(tmpdir(), "s2-no-cross-production-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), config = join(root, "config"); mkdirSync(home); mkdirSync(config);
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const cli = await requireRealClaudeS2Runner();
  expect(execFileSync(cli, ["--version"], { cwd: root, encoding: "utf8", timeout: 10_000 })).toMatch(/^2\.1\.310\b/);
  const script = join(root, "mount.mjs"), gen = join(root, "generation"), log = join(root, "requests.jsonl"), release = join(root, "tool-result");
  writeFileSync(script, source); writeFileSync(gen, "1");
  const relays: CliMountRelay[] = [];
  const create = CliMountRelay.create.bind(CliMountRelay);
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => { const r = await create(...args); relays.push(r); return r; });
  const next = CliMountRelay.prototype.nextGeneration;
  vi.spyOn(CliMountRelay.prototype, "nextGeneration").mockImplementation(async function (this: CliMountRelay, ...args: Parameters<typeof next>) {
    const r = await next.apply(this, args); relays.push(r); return r;
  });
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated S2 real", enabled: true,
    environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter);
  const bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const input: SendTurnInput = { threadId, cwd: root, draftOnly: true, text: "Call the connected probe tool exactly once, then say done. Do not call it twice.",
      releaseBinding: f.binding, mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: [script, gen, log, release], env: {} } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(input.text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const first = await instance.adapter.sendTurn(turn());
  const oldTicket = relays[0]!.ticket;
  const ask = await events.until(e => e.type === "request.opened" && e.turnId === first.turnId, 90_000);
  if (ask.type !== "request.opened") throw new Error("elicitation missing");
  expect(await instance.adapter.respondToRequest(threadId, ask.requestId!, { behavior: "answer", answers: [{ id: "value", selected: ["yes"] }] })).toBe("answered");
  await until(() => !!wire.held);
  writeFileSync(release, "release");
  // ONLY the real CLI's result reaches production settle(); the test never
  // calls retire/finish/retireGeneration to manufacture the boundary.
  await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId, 90_000);
  expect([...relays[0]!.mounts.values()].every(m => m.mount.ingress.retired)).toBe(true);
  writeFileSync(gen, "2");
  await instance.adapter.sendTurn(turn()); // returns after the actual barrier
  expect(relays).toHaveLength(2); expect(wire.cliPids).toHaveLength(1);
  expect(relays[1]!.ticket).not.toBe(oldTicket);
  wire.held!();
  const stale = connect(relays[1]!.socketPath); stale.on("error", () => {});
  await once(stale, "connect"); const closed = once(stale, "close");
  stale.write(JSON.stringify({ server: Object.keys(relays[1]!.servers)[0], ticket: oldTicket }) + "\n"); await closed;
  const records = (): Array<{ generation: number; req: any }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  await until(() => records().some(r => r.generation === 2 && r.req.method === "tools/call"));
  await new Promise(r => setTimeout(r, 1_000));
  expect(records().filter(r => r.generation === 2).some(r => r.req.id === "old-server-request")).toBe(false);
  expect(bindings[1]!.refusals).toBe(0);
}, 240_000);
