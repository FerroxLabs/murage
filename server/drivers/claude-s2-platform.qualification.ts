// Runner side owner: MAIN (T2/T3). Receipt review side owner: MAIN.
// Collected only by qualify-claude-s2.mjs; every case uses an isolated home,
// real CLI, real admission and real mounted child. No production unlock exists.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import * as qualification from "./claude-s2-qualification.ts";
import * as procs from "../procs.ts";
import { ensureDirs } from "../config.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const cli = process.env.MURAGE_QUAL_S2_CLI!;
const reviewed = JSON.parse(process.env.MURAGE_QUAL_S2_RECEIPT!) as qualification.ClaudeS2Qualification;
const output = process.env.MURAGE_QUAL_S2_OUTPUT!;
const realQualifiedCli = qualification.claudeS2QualifiedCli;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 90_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("platform qualification handshake deadline");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const mountSource = `
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const [generationPath, logPath, releasePath, ask] = process.argv.slice(2);
const generation = Number(readFileSync(generationPath, 'utf8'));
const tool = 'probe_' + generation;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
appendFileSync(logPath, JSON.stringify({generation,event:'spawn',pid:process.pid})+'\\n');
createInterface({input:process.stdin}).on('line', async line => {
  const req = JSON.parse(line); appendFileSync(logPath, JSON.stringify({generation,req})+'\\n');
  if (req.method === 'initialize') send({id:req.id,result:{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}}});
  else if (req.method === 'tools/list') send({id:req.id,result:{tools:[{name:tool,description:'Call exactly once when asked to probe.',inputSchema:{type:'object',properties:{}}}]}});
  else if (req.method === 'tools/call') {
    if (generation === 1 && ask === 'yes') send({id:'old-server-request',method:'elicitation/create',params:{message:'Isolated fixture: choose yes',requestedSchema:{type:'object',properties:{value:{type:'string',enum:['yes']}},required:['value']}}});
    while (!existsSync(releasePath+'-'+generation)) await new Promise(r=>setTimeout(r,10));
    send({id:req.id,result:{content:[{type:'text',text:tool+' complete'}]}});
  } else if(req.id !== undefined && req.method) send({id:req.id,result:{}});
});
`;
type MountRow = { generation: number; event?: string; pid?: number; req?: { id?: unknown; method?: string; params?: { name?: string } } };
async function fixture(retain = true, ask = false) {
  expect(await qualification.prepareClaudeS2NativeBuild(cli)).toBe(reviewed.build);
  expect(reviewed.platform).toBe(process.platform); expect(reviewed.arch).toBe(process.arch);
  vi.spyOn(qualification, "claudeS2QualifiedCli").mockImplementation((file, version, env, platform, arch) =>
    realQualifiedCli(file, version, env, platform, arch, retain ? [reviewed] : []));
  ensureDirs();
  const root = mkdtempSync(join(tmpdir(), "s2-platform-")); cleanup.push(() => removeTempDir(root));
  const home = join(root, "home"), config = join(root, "config"); mkdirSync(home); mkdirSync(config);
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const script = join(root, "mount.mjs"), generation = join(root, "generation"), log = join(root, "requests.jsonl"), release = join(root, "release");
  writeFileSync(script, mountSource); writeFileSync(generation, "1");
  const relays: CliMountRelay[] = [], cliPids: number[] = [];
  const create = CliMountRelay.create, next = CliMountRelay.prototype.nextGeneration, spawn = procs.spawnCli;
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => { const r = await create(...args); relays.push(r); return r; });
  vi.spyOn(CliMountRelay.prototype, "nextGeneration").mockImplementation(async function (this: CliMountRelay, ...args) {
    const r = await next.apply(this, args); relays.push(r); return r;
  });
  let held: (() => void) | undefined;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args);
    if (args[1]?.includes("--input-format")) {
      cliPids.push(child.pid!);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((...values: Parameters<typeof write>) => {
        let frame: { type?: string; response?: { response?: { action?: string } } } | undefined;
        try { frame = JSON.parse(String(values[0])); } catch {}
        if (ask && !held && frame?.type === "control_response" && frame.response?.response?.action === "accept") {
          held = () => { write(...values); }; return true;
        }
        return write(...values);
      }) as typeof child.stdin.write;
    }
    return child;
  });
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "Isolated native qualification",
    enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter);
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  const turn = (n: number) => fixtureMountTurn({ threadId, cwd: root, draftOnly: true,
    text: `Call the connected probe_${n} tool exactly once, then say done. Do not call another tool.`,
    warmIdentity: { botId, audience: "owner" },
    integrations: { composio: { command: process.execPath, args: [script, generation, log, release, ask ? "yes" : "no"], env: {} } } });
  const rows = (): MountRow[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const setGeneration = (n: number) => writeFileSync(generation, String(n));
  const releaseGeneration = (n: number) => writeFileSync(`${release}-${n}`, "release");
  return { instance, events, threadId, turn, rows, setGeneration, releaseGeneration, relays, cliPids, held: () => held };
}

it("T-S2-PLATFORM-RELIST-LATENCY real native relist and S1 control", async () => {
  const timing: Record<string, number> = {};
  for (const retain of [true, false]) {
    const x = await fixture(retain);
    x.releaseGeneration(1);
    const first = await x.instance.adapter.sendTurn(x.turn(1));
    expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === first.turnId, 90_000)).toMatchObject({ ok: true });
    expect(x.rows().some(r => r.generation === 1 && r.req?.method === "tools/call" && r.req.params?.name === "probe_1")).toBe(true);
    x.setGeneration(2);
    const started = performance.now();
    const second = await x.instance.adapter.sendTurn(x.turn(2));
    timing[retain ? "s2AdmissionMs" : "s1AdmissionMs"] = performance.now() - started;
    await until(() => x.rows().some(r => r.generation === 2 && r.req?.method === "tools/call"));
    expect(x.rows().filter(r => r.generation === 2 && r.req?.method === "tools/call").map(r => r.req?.params?.name)).toEqual(["probe_2"]);
    expect(x.cliPids.length).toBe(retain ? 1 : 2);
    x.releaseGeneration(2);
    expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === second.turnId, 90_000)).toMatchObject({ ok: true });
    await x.instance.dispose();
    vi.restoreAllMocks();
  }
  expect(Number.isFinite(timing.s2AdmissionMs)).toBe(true);
  expect(Number.isFinite(timing.s1AdmissionMs)).toBe(true);
  // Keep measured values for the platform reviewer; a cache hit may not
  // introduce binary hashing into the turn admission path.
  writeFileSync(join(output, "latency.json"), JSON.stringify(timing, null, 2) + "\n");
}, 240_000);

it("T-S2-PLATFORM-NO-CROSS real delayed generation callback", async () => {
  const x = await fixture(true, true);
  const first = await x.instance.adapter.sendTurn(x.turn(1));
  const oldTicket = x.relays[0]!.ticket;
  const ask = await x.events.until(e => e.type === "request.opened" && e.turnId === first.turnId, 90_000);
  expect(ask.type).toBe("request.opened");
  if (ask.type !== "request.opened") return;
  expect(await x.instance.adapter.respondToRequest(x.threadId, ask.requestId!, { behavior: "answer", answers: [{ id: "value", selected: ["yes"] }] })).toBe("answered");
  await until(() => !!x.held()); x.releaseGeneration(1);
  expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === first.turnId, 90_000)).toMatchObject({ ok: true });
  x.setGeneration(2); await x.instance.adapter.sendTurn(x.turn(2));
  expect(x.relays).toHaveLength(2); expect(x.cliPids).toHaveLength(1);
  expect(x.relays[1]!.ticket).not.toBe(oldTicket);
  x.held()!();
  const stale = connect(x.relays[1]!.socketPath); stale.on("error", () => {});
  await once(stale, "connect"); const closed = once(stale, "close");
  stale.write(JSON.stringify({ server: Object.keys(x.relays[1]!.servers)[0], ticket: oldTicket }) + "\n"); await closed;
  await until(() => x.rows().some(r => r.generation === 2 && r.req?.method === "tools/call"));
  expect(x.rows().filter(r => r.generation === 2).some(r => r.req?.id === "old-server-request")).toBe(false);
}, 240_000);

it("T-S2-PLATFORM-STOP-ALONE real retained native process and credentials", async () => {
  const x = await fixture(); x.releaseGeneration(1);
  const first = await x.instance.adapter.sendTurn(x.turn(1));
  expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === first.turnId, 90_000)).toMatchObject({ ok: true });
  expect(x.relays).toHaveLength(1); expect(x.cliPids).toHaveLength(1);
  const relay = x.relays[0]!, credentialPath = relay.cred!.path;
  expect(existsSync(credentialPath)).toBe(true);
  const started = performance.now();
  await x.instance.adapter.interruptTurn(x.threadId);
  await expect.poll(() => existsSync(credentialPath), { timeout: 10_000 }).toBe(false);
  expect(existsSync(dirname(credentialPath))).toBe(false);
  await expect.poll(() => x.cliPids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), { timeout: 10_000 }).toBe(true);
  expect([...relay.mounts.values()].every(mount => mount.child.exitCode !== null || mount.child.signalCode !== null)).toBe(true);
  expect(performance.now() - started).toBeLessThan(10_000);
}, 180_000);
