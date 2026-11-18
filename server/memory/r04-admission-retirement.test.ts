// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: mem-r04-1019 witness producer (scripts/verification/mem-r04-mutants.mjs R04-retire-too-late);
// index.ts startTurnAdmitting admission retirement is the production side under test; MAIN mutation contract.
//
// R04 admission retirement through the actual server: a direct turn's lineage stays open after the turn completes
// (its late lines still find it), so the member's next admission must retire it before any setup step runs. The
// observation point is forced, not timed: the server-process instrumentation reads the member's open turns at the
// recall readiness call each memory-active turn makes after admission and before its reader is finalized. A
// retirement deferred to reader finalization or later (the R04-retire-too-late mutant) leaves the completed
// predecessor open there, and a receipt joining at that moment would address a merge of both generations.
// Synthetic fixture text only; fake engine, loopback server, no network or credentials.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

const LINEAGE = new URL("./lineage-write.ts", import.meta.url).href;
const READINESS = new URL("./recall-readiness.ts", import.meta.url).href;
const WORK = "R04_RETIRE_WORK_CANARY we plan on Mondays.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, models: string[];
let sequence = 0;

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const observations = () => existsSync(join(fixture.info.dataDir, "r04-observations.jsonl"))
  ? readFileSync(join(fixture.info.dataDir, "r04-observations.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

/** Post a direct message and wait until the engine had its prompt and the bot is idle again. */
async function turn(botId: string, threadId: string) {
  const tag = `R04_RETIRE_TURN_${++sequence}`;
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: `Please answer briefly. ${tag}` });
  await expect.poll(() => JSON.stringify(readJson(fixture.fixtureDumpPath)?.prompt ?? null).includes(tag), { timeout: 30000 }).toBe(true);
  await expect.poll(idle, { timeout: 30000 }).toBe(true);
}

/** Ask the server process whether the turns it observed are still open (answered on an unref-ed 25 ms tick). */
async function probe(seq: number) {
  writeFileSync(join(fixture.info.dataDir, "r04-probe.json"), JSON.stringify({ seq }));
  let answer: any;
  await expect.poll(() => { answer = readJson(join(fixture.info.dataDir, "r04-probe-result.json")); return answer?.seq; }, { timeout: 10000 }).toBe(seq);
  return answer;
}

posixOnly("R04 admission retires the member's completed predecessor before setup", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
      const lineage=await import(${JSON.stringify(LINEAGE)});
      const {RecallReadiness}=await import(${JSON.stringify(READINESS)});
      const dir=process.env.MURAGE_DATA_DIR;
      const target=()=>{try{return JSON.parse(fs.readFileSync(path.join(dir,'r04-target.json'),'utf8'));}catch{return null;}};
      const seen=[];
      const access=RecallReadiness.prototype.access;
      RecallReadiness.prototype.access=function(...args){
        const t=target();
        const current=t?lineage.currentTurnLineage(t.threadId):undefined;
        if(t&&current){
          if(!seen.includes(current))seen.push(current);
          const row={turn:seen.indexOf(current),
            earlierOpen:seen.filter(open=>open!==current&&lineage.isTurnOpen(open)).length,
            receiptTarget:lineage.runningTurnFor(t.threadId,t.botId)===current,
            writerTarget:lineage.writerTurnFor(t.threadId,t.botId)===current,
            memberBegan:lineage.openTurnsBegan(t.threadId,t.botId)===current.turnLsn};
          fs.appendFileSync(path.join(dir,'r04-observations.jsonl'),JSON.stringify(row)+'\\n');
        }
        return access.apply(this,args);
      };
      let answered;
      setInterval(()=>{try{
        const asked=JSON.parse(fs.readFileSync(path.join(dir,'r04-probe.json'),'utf8'));
        if(asked.seq===answered)return;answered=asked.seq;const t=target();
        fs.writeFileSync(path.join(dir,'r04-probe-result.json'),JSON.stringify({seq:asked.seq,open:seen.map(open=>lineage.isTurnOpen(open)),
          receiptTarget:seen.findIndex(open=>lineage.runningTurnFor(t.threadId,t.botId)===open)}));
      }catch{}},25).unref();
    ` });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    models = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options.map((option: any) => option.id);
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("R04 retire at admission: the completed predecessor is closed before the next turn's first setup step", async () => {
    const created = (await api("POST", "/api/bots", { name: "Retire fixture", modelSelection: { instanceId: "verification", model: models[0] } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${created.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", "/api/memory/action", { action: "identity-write", botId: created.id, kind: "relation", key: "owner", expectedVersion: 0, text: WORK, basis: "owner-fact", audience: "owner-private" });
    writeFileSync(join(fixture.info.dataDir, "r04-target.json"), JSON.stringify({ botId: created.id, threadId: created.threadId }));

    await turn(created.id, created.threadId);
    // Precondition: the completed first turn is still the member's open turn, so the next admission has one to retire.
    expect(await probe(1)).toEqual({ seq: 1, open: [true], receiptTarget: 0 });

    await turn(created.id, created.threadId);
    // At the second turn's first setup step after admission, its own generation is the member's only open turn:
    // the predecessor is closed, a receipt joining now targets exactly this turn, and so does an engine line.
    expect(observations()).toEqual([
      { turn: 0, earlierOpen: 0, receiptTarget: true, writerTarget: true, memberBegan: true },
      { turn: 1, earlierOpen: 0, receiptTarget: true, writerTarget: true, memberBegan: true },
    ]);
    expect(await probe(2)).toEqual({ seq: 2, open: [false, true], receiptTarget: 1 });
  }, 150000);
});
