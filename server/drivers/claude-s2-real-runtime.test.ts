// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Supplemental real-engine observations owned by the s2-real qualification job.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fencedTurnInput } from "./engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { recordEvents } from "../testing/events.ts";
import { claudeS2HasLiveTurn, claudeS2SteerAdapter, hasClaudeS2Pending } from "./claude-s2-pending.ts";
import { requireRealClaudeS2Runner } from "./claude-s2-real-runner.fixture.ts";
import type { SendTurnInput } from "../contracts.ts";

const observed = vi.hoisted(() => ({ pids: [] as number[], users: [] as Array<{ pid: number; text: string; at: number }> }));
vi.mock("../procs.ts", async original => {
  const actual = await original<typeof import("../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    const child = actual.spawnCli(...args);
    if (args[1]?.includes("--input-format") && child.stdin) {
      observed.pids.push(child.pid!);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((...values: Parameters<typeof write>) => {
        let frame: any; try { frame = JSON.parse(String(values[0])); } catch { /* diagnostics */ }
        if (frame?.type === "user") observed.users.push({ pid: child.pid!, text: frame.message.content, at: performance.now() });
        return write(...values);
      }) as typeof child.stdin.write;
    }
    return child;
  } };
});

const enabled = process.env.MURAGE_REAL_CLAUDE_S2 === "1";
const realIt = it.skipIf(!enabled);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  observed.pids = []; observed.users = [];
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate();
  if (errors.length) throw new AggregateError(errors, "real runtime cleanup failed");
});
async function until(check: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("real runtime observation deadline");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function descendants(pid: number): number[] {
  let children: number[];
  try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
  return children.flatMap(child => [child, ...descendants(child)]);
}
const mountSource = `
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
const [generationPath, logPath, releasePath, failPath] = process.argv.slice(2);
const generation = Number(readFileSync(generationPath, 'utf8'));
const log = value => appendFileSync(logPath, JSON.stringify({generation,pid:process.pid,...value})+'\\n');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
log({event:'spawn'});
createInterface({input:process.stdin}).on('line', async line => {
  const req=JSON.parse(line); log({event:'request',method:req.method});
  if(req.method==='initialize') send({id:req.id,result:{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'runtime-qualification',version:'1'}}});
  else if(req.method==='tools/list') {
    if(generation===2) {
      log({event:'list-held'});
      while(!existsSync(releasePath)) await new Promise(r=>setTimeout(r,10));
      if(existsSync(failPath)) { unlinkSync(failPath); log({event:'injected-transport-exit'}); process.exit(1); }
    }
    log({event:'list-answer'});
    send({id:req.id,result:{tools:[{name:'probe',description:'Return a qualification marker.',inputSchema:{type:'object',properties:{}}}]}});
  } else if(req.method==='tools/call') send({id:req.id,result:{content:[{type:'text',text:'isolated qualification marker'}]}});
  else if(req.id!==undefined && req.method) send({id:req.id,result:{}});
});
`;

async function fixture() {
  if (process.platform !== "linux") throw new Error("real runtime PID witness requires Linux");
  ensureDirs();
  const root = mkdtempSync(join(tmpdir(), "s2-real-runtime-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), config = join(root, "claude"); mkdirSync(home); mkdirSync(config);
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const cli = await requireRealClaudeS2Runner();
  const script = join(root, "mount.mjs"), gen = join(root, "generation"), log = join(root, "mount.jsonl");
  const release = join(root, "release-list"), fail = join(root, "fail-once");
  writeFileSync(script, mountSource); writeFileSync(gen, "1");
  const relays: CliMountRelay[] = [];
  const create = CliMountRelay.create.bind(CliMountRelay);
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => { const relay = await create(...args); relays.push(relay); return relay; });
  const next = CliMountRelay.prototype.nextGeneration;
  vi.spyOn(CliMountRelay.prototype, "nextGeneration").mockImplementation(async function (this: CliMountRelay, ...args: Parameters<typeof next>) {
    const relay = await next.apply(this, args); relays.push(relay); return relay;
  });
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated real runtime qualification", enabled: true,
    environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter), bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(text: string): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const input: SendTurnInput = { threadId, text, cwd: root, draftOnly: true, releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: [script, gen, log, release, fail], env: {} } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const records = (): any[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const first = await instance.adapter.sendTurn(turn("Say OK."));
  expect(await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId, 90_000)).toMatchObject({ ok: true });
  expect(observed.pids).toHaveLength(1);
  expect([...relays[0]!.mounts.values()].every(m => m.mount.ingress.retired)).toBe(true);
  async function disposeAndWitness() {
    const pids = [...new Set([...observed.pids.flatMap(pid => [pid, ...descendants(pid)]),
      ...relays.flatMap(relay => [...relay.mounts.values()].map(mount => mount.child.pid!))])];
    const paths = relays.flatMap(relay => [relay.socketPath, ...(relay.cred ? [relay.cred.path] : [])]);
    await instance.dispose();
    await until(() => pids.every(pid => !alive(pid)) && paths.every(path => !existsSync(path)));
    expect(pids.every(pid => !alive(pid))).toBe(true);
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(bindings.every(f => f.refusals === 0)).toBe(true);
  }
  return { instance, events, threadId, turn, records, gen, release, fail, relays, bindings, disposeAndWitness };
}

realIt.each([false, true])("T-S2-REAL-RUNTIME-ORDER-LATENCY: real relist, prompt before steer, teardown; cold=%s", async cold => {
  const x = await fixture(), originalPid = observed.pids[0]!;
  writeFileSync(x.gen, "2"); if (cold) writeFileSync(x.fail, "fail next list once");
  const dispatchAt = performance.now();
  const sending = x.instance.adapter.sendTurn(x.turn("Say SECOND."));
  await until(() => x.records().some(r => r.generation === 2 && r.event === "list-held"));
  expect(hasClaudeS2Pending(x.threadId)).toBe(true); expect(claudeS2HasLiveTurn(x.threadId)).toBe(false);
  expect(x.events.events.filter(e => e.type === "turn.started")).toHaveLength(1);
  expect(observed.users.map(row => row.text)).toEqual(["Say OK."]);
  const fence = vi.fn();
  const held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "Say STEER.", fence);
  expect(fence).toHaveBeenCalledOnce();
  const releaseAt = performance.now(); writeFileSync(x.release, "release list");
  const second = await sending; expect(await held).toBe(true);
  expect(observed.users.map(row => row.text)).toEqual([
    "Say OK.", "Say SECOND.", "Say STEER.",
  ]);
  expect(observed.users[1]!.pid === originalPid).toBe(!cold);
  expect(observed.users[2]!.pid).toBe(observed.users[1]!.pid);
  expect(observed.pids).toHaveLength(cold ? 2 : 1);
  expect(fence).toHaveBeenCalledTimes(2); // admission and the one held steer's release
  expect(x.records().some(r => r.event === "injected-transport-exit")).toBe(cold);
  expect(x.records().some(r => r.generation === 2 && r.event === "list-answer")).toBe(true);
  expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === second.turnId, 90_000)).toMatchObject({ ok: true });
  const sample = { kind: "real-stdin-enqueue", platform: process.platform, arch: process.arch, cold,
    dispatchMs: observed.users[1]!.at - dispatchAt, releaseToPromptMs: observed.users[1]!.at - releaseAt };
  expect(sample.releaseToPromptMs).toBeGreaterThanOrEqual(0);
  console.info(`S2_REAL_LATENCY ${JSON.stringify(sample)}`);
  if (process.env.MURAGE_QUAL_S2_LATENCY) appendFileSync(process.env.MURAGE_QUAL_S2_LATENCY, JSON.stringify(sample) + "\n");
  await x.disposeAndWitness();
}, 180_000);

realIt("T-S2-REAL-RUNTIME-STOP: Stop during real held relist writes no successor prompt and tears down exact resources", async () => {
  const x = await fixture(); writeFileSync(x.gen, "2");
  const sending = x.instance.adapter.sendTurn(x.turn("This stopped prompt must never be written."));
  await until(() => x.records().some(r => r.generation === 2 && r.event === "list-held"));
  expect(hasClaudeS2Pending(x.threadId)).toBe(true);
  const held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "This stopped steer must never be written.");
  const outcomes = await Promise.allSettled([sending, x.instance.adapter.interruptTurn(x.threadId)]);
  expect(outcomes[0]!.status).toBe("fulfilled"); expect(outcomes[1]!.status).toBe("fulfilled");
  const sent = (outcomes[0] as PromiseFulfilledResult<{ turnId: string }>).value;
  expect(await held).toBe(false);
  expect(await x.events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId, 30_000)).toMatchObject({ stopReason: "cancelled" });
  expect(observed.users.map(row => row.text)).toEqual(["Say OK."]);
  expect(observed.pids).toHaveLength(1); expect(hasClaudeS2Pending(x.threadId)).toBe(false);
  await x.disposeAndWitness();
}, 180_000);
