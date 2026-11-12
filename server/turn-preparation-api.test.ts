import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// Only this disposable child loads the replay barrier. Product replay and
// Stop, admission, capabilities and conversation writes remain the real ones.
describe("detached turn preparation", () => {
  let fixture: VerificationServer;
  let headers: Record<string, string>;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const file = (name: string) => join(fixture.info.dataDir, name);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
  const state = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId);
  const events = () => existsSync(file("preparation-events")) ? readFileSync(file("preparation-events"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const create = async () => {
    const engine = (await api("GET", "/api/instances")).body.instances.find((e: any) => e.instanceId === "verification");
    const result = await api("POST", "/api/bots", { name: "Preparation fixture", modelSelection: { instanceId: "verification", model: engine.models.options[0].id } });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const bot = result.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const send = async (bot: any, text: string) => {
    const result = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `
      import fs from 'node:fs';
      import path from 'node:path';
      import { registerHooks } from 'node:module';
      const root=process.env.MURAGE_DATA_DIR;
      const armed=path.join(root,'replay-armed'), released=path.join(root,'replay-released');
      const log=(event)=>fs.appendFileSync(path.join(root,'preparation-events'),JSON.stringify(event)+'\\n');
      globalThis.__preparationLog=log;
      globalThis.__preparationHoldRendering=async()=>{
        if(!fs.existsSync(armed))return;
        const plan=JSON.parse(fs.readFileSync(armed,'utf8'));
        if(plan.stage!=='render')return;
        fs.rmSync(armed,{force:true});
        fs.writeFileSync(armed+'.waiting',plan.threadId);
        await new Promise(resolve=>{const timer=setInterval(()=>{if(!fs.existsSync(released))return;clearInterval(timer);resolve();},10);});
        if(plan.fail)throw Error(plan.error || 'fixture replay failed');
      };
      registerHooks({load(url,context,next){
        if(url.endsWith('/memory/turn-replay-inputs.ts')) {
          let source=fs.readFileSync(new URL(url),'utf8');
          const anchor='export function turnReplayInputs(args: TurnReplayInputsArgs): TurnReplayInputs | Promise<TurnReplayInputs> {';
          if(!source.includes(anchor))throw Error('replay fixture anchor moved');
          source=source.replace(/^export function turnReplayInputs[^\\n]+;$/gm,'');
          source=source.replace(anchor,anchor.replace('export function turnReplayInputs','function realTurnReplayInputs'));
          source+=\`
export async function turnReplayInputs(args) {
  if (!fs.existsSync(\$\{JSON.stringify(armed)\})) return realTurnReplayInputs(args);
  const plan=JSON.parse(fs.readFileSync(\$\{JSON.stringify(armed)\},'utf8'));
  if(plan.threadId!==args.threadId||plan.stage==='render')return realTurnReplayInputs(args);
  fs.rmSync(\$\{JSON.stringify(armed)\},{force:true});
  fs.writeFileSync(\$\{JSON.stringify(armed+'.waiting')\},args.threadId);
  await new Promise(resolve=>{const timer=setInterval(()=>{if(!fs.existsSync(\$\{JSON.stringify(released)\}))return;clearInterval(timer);resolve();},10);});
  if(plan.fail)throw Error(plan.error || 'fixture replay failed');
  return realTurnReplayInputs(args);
}
\`;
          return {format:'module-typescript',shortCircuit:true,source:"import fs from 'node:fs';\\n"+source};
        }
        if(url.endsWith('/server/index.ts')) {
          let source=fs.readFileSync(new URL(url),'utf8');
          source=source.replace('  internalCapabilities.begin(botId, threadId, generation,humanPrincipal);','  globalThis.__preparationLog({kind:"begin",threadId,generation});\\n  internalCapabilities.begin(botId, threadId, generation,humanPrincipal);');
          source=source.replace('  directTurnDispatchClaims.set(threadId, { id: dispatchClaimId, botId:bot.id, threadId, phase: "setup" });','  globalThis.__preparationLog({kind:"claim",threadId,generation:dispatchClaimId});\\n  directTurnDispatchClaims.set(threadId, { id: dispatchClaimId, botId:bot.id, threadId, phase: "setup" });');
          source=source.replace('giveBackAdmittedTurn(run, bot.id, threadId, admitted, phase, error, opts?.onDispatchError); });', 'giveBackAdmittedTurn(run, bot.id, threadId, admitted, phase, error, opts?.onDispatchError); }).finally(() => globalThis.__preparationLog({kind:"done",threadId,generation:run.generation}));');
          const render='async function replayLinesInSlices(viewer: Viewer, shown: readonly Message[], replayed: readonly Message[], text: (m: Message) => string): Promise<TranscriptEntry[]> {';
          if(!source.includes(render))throw Error('render fixture anchor moved');
          source=source.replace(render,render+'\\n  await globalThis.__preparationHoldRendering();');
          source=source.replaceAll('endTurnTrace(threadId, "setup-failed");','(globalThis.__preparationLog({kind:"trace-ended",threadId}), endTurnTrace(threadId, "setup-failed"));');
          // Invoke the existing refusal branch; never change the guard itself.
          source=source.replace('if (!beginGuardedOutsideTurn(threadId, instanceId, undefined, resumedSession)) {','if ((fs.existsSync(path.join(process.env.MURAGE_DATA_DIR,"outside-refuse")) && fs.readFileSync(path.join(process.env.MURAGE_DATA_DIR,"outside-refuse"),"utf8") === threadId) || !beginGuardedOutsideTurn(threadId, instanceId, undefined, resumedSession)) {');
          return {format:'module-typescript',shortCircuit:true,source:"import fs from 'node:fs'; import path from 'node:path';\\n"+source};
        }
        return next(url,context);
      }});
    ` });
    const proof = await api("GET", "/api/desktop-secret");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 120_000);
  afterAll(async () => {
    try {
      if (fixture && process.env.TURN_PREPARATION_EVIDENCE) {
        const destination = process.env.TURN_PREPARATION_EVIDENCE;
        writeFileSync(join(destination, "fixture-info.json"), JSON.stringify(fixture.info, null, 2));
        writeFileSync(join(destination, "fixture-server.log"), readFileSync(fixture.info.logPath));
        writeFileSync(join(destination, "fixture-events.json"), JSON.stringify(events(), null, 2));
        const bots = await api("GET", "/api/bots");
        const snapshots = await Promise.all(bots.body.bots.map(async (bot: any) => ({ bot, messages: await messages(bot.threadId) })));
        writeFileSync(join(destination, "fixture-conversations.json"), JSON.stringify(snapshots, null, 2));
      }
    } finally { await fixture?.close(); }
  });

  it.each(["inputs", "render"])("Stop and restart while replay %s is held preserves the replacement's capabilities and dispatch claim", async stage => {
    const bot = await create();
    writeFileSync(file("replay-armed"), JSON.stringify({ threadId: bot.threadId, stage }));
    await send(bot, "old turn");
    await expect.poll(() => existsSync(file("replay-armed.waiting"))).toBe(true);
    expect((await state(bot.id)).busy).toBe(true);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await send(bot, "replacement __fixture_hold_authority__");
    await expect.poll(() => events().filter(e => e.kind === "claim" && e.threadId === bot.threadId).length, { timeout: 15000 }).toBe(1);
    const replacement = events().filter(e => e.threadId === bot.threadId);
    writeFileSync(file("replay-released"), "");
    await expect.poll(() => events().some(e => e.kind === "done" && e.threadId === bot.threadId), { timeout: 15000 }).toBe(true);
    expect(events().filter(e => ["begin", "claim"].includes(e.kind) && e.threadId === bot.threadId)).toEqual(replacement.filter(e => ["begin", "claim"].includes(e.kind)));
    expect(events().filter(e => e.kind === "trace-ended" && e.threadId === bot.threadId)).toEqual(replacement.filter(e => e.kind === "trace-ended"));
    expect((await state(bot.id)).busy).toBe(true);
    expect((await messages(bot.threadId)).filter(m => m.tool?.name?.startsWith("error:"))).toEqual([]);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    rmSync(file("replay-released"), { force: true });
    rmSync(file("replay-armed.waiting"), { force: true });
  }, 45_000);

  it.each(["inputs", "render"])("rejected old replay %s after Stop and restart leaves the replacement conversation unchanged", async stage => {
    const bot = await create();
    writeFileSync(file("replay-armed"), JSON.stringify({ threadId: bot.threadId, stage, fail: true }));
    await send(bot, "old rejected turn");
    await expect.poll(() => existsSync(file("replay-armed.waiting"))).toBe(true);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await send(bot, "replacement __fixture_hold_authority__");
    await expect.poll(() => events().filter(e => e.kind === "claim" && e.threadId === bot.threadId).length, { timeout: 15000 }).toBe(1);
    // The fake has received the replacement prompt and holds without output.
    await expect.poll(() => existsSync(fixture.fixtureDumpLogPath) && readFileSync(fixture.fixtureDumpLogPath, "utf8").includes("replacement __fixture_hold_authority__"), { timeout: 15000 }).toBe(true);
    const before = await messages(bot.threadId);
    const marks = events().filter(e => e.threadId === bot.threadId);
    try {
      writeFileSync(file("replay-released"), "");
      const replacementGeneration = marks.find(e => e.kind === "claim")!.generation;
      await expect.poll(() => events().some(e => e.kind === "done" && e.threadId === bot.threadId && e.generation !== replacementGeneration), { timeout: 15000 }).toBe(true);
      expect(await messages(bot.threadId)).toEqual(before);
      expect((await state(bot.id)).busy).toBe(true);
      expect(events().filter(e => ["begin", "claim", "trace-ended"].includes(e.kind) && e.threadId === bot.threadId)).toEqual(marks.filter(e => ["begin", "claim", "trace-ended"].includes(e.kind)));
      expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`ignored stale rejection on thread ${bot.threadId}`);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      for (const name of ["replay-released", "replay-armed.waiting"]) rmSync(file(name), { force: true });
    }
  }, 45_000);

  it("a preparation diagnostic beyond 160 characters keeps a visible more marker, full expanded details and full log", async () => {
    const bot = await create();
    const diagnostic = "Fixture preparation diagnostic: " + "context ".repeat(30) + "Action: restore the missing fixture folder and retry.";
    writeFileSync(file("replay-armed"), JSON.stringify({ threadId: bot.threadId, fail: true, error: diagnostic }));
    writeFileSync(file("replay-released"), "");
    try {
      await send(bot, "owner needs full failure reason");
      await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15000 }).toBe(false);
      const errors = (await messages(bot.threadId)).filter(m => m.kind === "activity" && m.tool?.ok === false);
      expect(errors).toHaveLength(1);
      expect(errors[0].tool.name).toMatch(/… \(more\)$/);
      expect(errors[0].tool.errorDetails).toBe(diagnostic);
      // Load the real renderer through Vitest so JSX stays outside the
      // server's Node-only typecheck graph; the live API payload is unchanged.
      const { RuntimeErrorCard } = await vi.importActual<{ RuntimeErrorCard: ComponentType<{ message: string; details?: string; onOpenProviderSettings: () => void }> }>("../src/components/RuntimeErrorCard.tsx");
      const markup = renderToStaticMarkup(createElement(RuntimeErrorCard, {
        message: errors[0].tool.name.slice(6).trim(), details: errors[0].tool.errorDetails, onOpenProviderSettings: () => {},
      }));
      expect(markup.split("<details")[1]).toContain(diagnostic);
      expect(readFileSync(fixture.info.logPath, "utf8")).toContain(diagnostic);
    } finally {
      for (const name of ["replay-released", "replay-armed.waiting"]) rmSync(file(name), { force: true });
    }
  }, 45_000);

  it.each(["replay", "outside"])("%s preparation failure is visible on an ordinary owner send and releases the thread", async kind => {
    const bot = await create();
    if (kind === "replay") {
      writeFileSync(file("replay-armed"), JSON.stringify({ threadId: bot.threadId, fail: true }));
      writeFileSync(file("replay-released"), "");
    } else writeFileSync(file("outside-refuse"), bot.threadId);
    await send(bot, "owner request");
    await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15000 }).toBe(false);
    const rows = await messages(bot.threadId);
    const errors = rows.filter(m => m.kind === "activity" && m.tool?.ok === false && m.tool.name.startsWith("error:"));
    expect(errors).toHaveLength(1);
    if (kind === "replay") expect(errors[0].tool.name).toContain("fixture replay failed");
    expect(rows.filter(m => m.role === "user" && m.text === "owner request")).toHaveLength(1);
    for (const name of ["replay-released", "replay-armed.waiting", "outside-refuse"]) rmSync(file(name), { force: true });
    await send(bot, "try again __fixture_finish_turn__");
    await expect.poll(async () => (await messages(bot.threadId)).some(m => m.role === "bot" && m.kind === "text"), { timeout: 15000 }).toBe(true);
  }, 45_000);
});
