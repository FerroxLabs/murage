// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F2 (1.0.4, fix/104-routines-gate) through the real server (designs/F2-ROUTINES-104.md r3.1, tests 4, 13 and 14):
// Run now on a closed project is refused with the project copy, and a routine run whose bot is switched to the
// Cloud VM engine while its turn is being set up is refused at the engine the turn resolves, never sent to the VM.
// The hold is a load hook on server/store.ts: Store.prepareThread waits while a file exists (the one await in
// startTurn before the bot is reread and its engine resolved).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const PROJECT_CLOSED = "This project is closed. Reopen it to run its routines.";
const CLOUD = "Cloud runs begin when Cloud approvals arrive. Run this routine on this computer for now.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const makeBot = async (name: string) => {
  const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect((await api("PATCH", `/api/bots/${made.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return made.body.bot as { id: string; threadId: string };
};
const runOf = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);

posixOnly("F2 routine gates through the real server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const tmp=path.join(process.env.MURAGE_DATA_DIR,'tmp');fs.mkdirSync(tmp,{recursive:true});
      globalThis.__f2Hold=async(threadId)=>{
        const hold=path.join(tmp,'f2-hold');if(!fs.existsSync(hold))return;
        fs.appendFileSync(path.join(tmp,'f2-entered'),threadId+'\\n');
        while(fs.existsSync(hold))await new Promise(resolve=>setTimeout(resolve,25));
      };
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, nextLoad) {
        if(!url.endsWith('/server/store.ts'))return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const anchor='prepareThread(threadId: string): Promise<void> {\\n    return prepareThreadRows(threadId);';
        if(!source.includes(anchor))throw new Error('prepareThread fixture anchor changed');
        return { format:'module-typescript', shortCircuit:true, source: source.replace(anchor,'prepareThread(threadId: string): Promise<void> {\\n    return (globalThis as any).__f2Hold(threadId).then(() => prepareThreadRows(threadId));') };
      } });
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // The Computer engine: the whole agent runs on the owner's cloud box (no Box key here, so it is never reached).
      cfg.instances.box={driver:'boxAgent',displayName:'Computer fixture',config:{}};
      cfg.features={...(cfg.features??{}),projectsAutonomy:false};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("4: Run now on a closed project answers 409 with the project copy and creates no run", async () => {
    const member = await makeBot("Project member");
    const made = await api("POST", "/api/projects", { clientId: "f2-closed", purpose: "Closed routines", mode: "bots", members: [member.id], leadBotId: null });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const routine = await api("POST", "/api/routines", { botId: member.id, target: "room-goal", groupId: made.body.group.id, name: "Room check", prompt: "Check the project",
      enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 } });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    expect((await api("POST", `/api/groups/${made.body.group.id}/project/close`, {})).status).toBe(200);
    expect(await api("GET", `/api/groups/${made.body.group.id}/project`)).toMatchObject({ status: 200, body: { lifecycle: "closed" } });
    const before = (await api("GET", "/api/routines")).body.runs.length;
    expect(await api("POST", `/api/routines/${routine.body.routine.id}/run`, {})).toEqual({ status: 409, body: { error: PROJECT_CLOSED } });
    expect((await api("GET", "/api/routines")).body.runs.length).toBe(before);
  }, 60_000);

  it("13: a bot switched to the Cloud VM engine while its routine turn is set up is refused there, never sent to the VM", async () => {
    const bot = await makeBot("Switched lead");
    const routine = await api("POST", "/api/routines", { botId: bot.id, name: "Race check", prompt: "race check on this computer", enabled: false,
      schedule: { type: "once", at: Date.now() + 86_400_000 } });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    const tmp = join(fixture.info.dataDir, "tmp");
    mkdirSync(tmp, { recursive: true });
    const hold = join(tmp, "f2-hold"), entered = join(tmp, "f2-entered");
    rmSync(entered, { force: true });
    writeFileSync(hold, "");
    try {
      const started = await api("POST", `/api/routines/${routine.body.routine.id}/run`, {});
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      await expect.poll(() => existsSync(entered) && readFileSync(entered, "utf8").trim().length > 0, { timeout: 30_000 }).toBe(true);
      const switched = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", modelSelection: { instanceId: "box", model: "claude-fable-5" } });
      expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    } finally { rmSync(hold, { force: true }); }
    const runId = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.routineId === routine.body.routine.id).id;
    await expect.poll(async () => (await runOf(runId))?.status, { timeout: 30_000 }).toBe("failed");
    expect((await runOf(runId)).error).toBe(CLOUD);
    // 14 (guard): the owner's own chat on a Cloud VM bot is not an automation and still starts
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner asks the box", threadId: bot.threadId })).status).toBe(202);
  }, 90_000);
});
