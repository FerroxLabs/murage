// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P9 (1.0.24): the owner's model connection (its key) changes between a turn's preparation and its send. Murage's own race, never the
// owner's to resend: a turn proven unwritten is prepared once more with the new route and answered; if the route moves again, ONE plain
// Murage line names it, the code kept under technical details. Real server, real POST /api/bots/:id/messages, a real provider connection
// (created, refreshed and rotated through /api/provider-connections), a fenced fixture engine whose sendTurn parks until the test has
// rotated the key, then runs the real submission check (server/index.ts validateDirectSubmission -> ProviderRouteChanged, caught at the
// handler's murageSetupRetryable). Owner of the retry: server/index.ts (catch of the direct dispatch); owner of the line: shared/murage-start-failure.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { murageStartFailureLine } from "../shared/murage-start-failure.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const at = (name: string) => join(fixture.info.dataDir, name);
const href = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as any;
  if (response.status < 200 || response.status > 299) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const lines = (name: string) => existsSync(at(name)) ? readFileSync(at(name), "utf8").split("\n").filter(Boolean) : [];
const submissions = (threadId: string) => lines("dump").map(line => JSON.parse(line)).filter(row => row.threadId === threadId && !row.prompt).length;
const botMessages = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[]).filter(message => message.role === "bot");
let connection: { id: string; revision: string };
let keyNumber = 0;
const rotateKey = async () => {
  keyNumber += 1;
  const current = (await api("GET", "/api/provider-connections")).connections.find((row: any) => row.id === connection.id);
  const changed = await api("POST", "/api/provider-connections/mutate", { action: "update", id: connection.id, revision: current.revision, key: `sk-proj-FAKE_ROUTE_KEY_${keyNumber}` });
  expect(changed.connections.find((row: any) => row.id === connection.id).revision).not.toBe(current.revision);
  // a changed key drops the saved model list; the next bot needs it listed again
  await api("POST", `/api/provider-connections/${connection.id}/refresh`, {});
};

describe.skipIf(process.platform === "win32")("P9: a turn whose provider route changed while it was prepared", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${href("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${href("server/testing/fake-late-terminal-driver.ts")});
      const dir=process.env.MURAGE_DATA_DIR; const at=name=>path.join(dir,name);
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      // the fixture engine takes an OpenAI-compatible connection, so the turn carries a provider route
      driver.create=async input=>{ const instance=await create(input); instance.driverKind='openai-compat'; instance.adapter.provider='openai-compat';
        const on=instance.adapter.onEvent.bind(instance.adapter); instance.adapter.onEvent=listener=>on((event,source)=>listener({...event,provider:'openai-compat'},source));
        return instance; };
      // route-arm "<n>": the next n turns park (route-ready-<k> written) between choosing their provider route and the check that the route is
      // still current, until the test has rotated the key and written route-go-<k>. The park is one awaited call inserted into the turn's
      // preparation (server/index.ts, right after "assert.dispatch"); the check it waits in front of is the real, unchanged production one.
      globalThis.routePark=async()=>{
        if(!fs.existsSync(at('route-arm')))return;
        const left=Number(fs.readFileSync(at('route-arm'),'utf8'));
        if(left>1)fs.writeFileSync(at('route-arm'),String(left-1)); else fs.rmSync(at('route-arm'),{force:true});
        const k=fs.readdirSync(dir).filter(name=>name.startsWith('route-ready-')).length+1;
        fs.writeFileSync(at('route-ready-'+k),'1');
        const end=Date.now()+30000;
        while(!fs.existsSync(at('route-go-'+k))&&Date.now()<end) await new Promise(resolve=>setTimeout(resolve,20));
      };
      const {registerHooks}=await import('node:module');
      registerHooks({load(url,context,next){
        const loaded=next(url,context);
        if(!url.endsWith('/server/index.ts'))return loaded;
        const source=String(loaded.source);
        const anchor=/endAssertDispatch[(][)];([^i]*)if [(]!providerRouteIsCurrent[(]providerRoute[)][)]/;
        if(!anchor.test(source))throw new Error('route park anchor missing');
        return {...loaded,source:source.replace(anchor,(m,gap)=>'endAssertDispatch(); await globalThis.routePark?.();'+gap+'if (!providerRouteIsCurrent(providerRoute))')};
      }});
      BUILT_IN_DRIVERS.push(driver);
      const file=at('config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.fenced={driver:'fakeLateTerminal',environment:{FAKE_LATE_DUMP:at('dump'),FAKE_LATE_FENCED_WRITES:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
      const originalFetch=globalThis.fetch;
      globalThis.fetch=(input,init)=>{
        const url=String(input);
        if(url==='https://api.openai.com/v1/models')return Promise.resolve(new Response(JSON.stringify({data:[{id:'gpt-5-fixture'}]})));
        if(url.startsWith('https://'))throw new Error('External network disabled in route fixture');
        return originalFetch(input,init);
      };
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const created = await api("POST", "/api/provider-connections/mutate", { action: "create", preset: "openai", label: "Route fixture", key: "sk-proj-FAKE_ROUTE_KEY_0" });
    connection = created.connections.find((row: any) => row.label === "Route fixture");
    await api("POST", `/api/provider-connections/${connection.id}/refresh`, {});
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  // [route changes while it is prepared, answered?]; 0 is the control: the same bot and route, nothing moves
  it.each([[0, true], [1, true], [2, false]] as const)("the route changes %i time(s) before the send", async (changes, answered) => {
    const bot = (await api("POST", "/api/bots", { name: `Route ${changes}`, modelSelection: { instanceId: "fenced", model: "gpt-5-fixture", connectionId: connection.id } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const before = submissions(bot.threadId), rowsBefore = (await botMessages(bot.threadId)).length;
    if (changes > 0) writeFileSync(at("route-arm"), String(changes));
    const readyBase = readdirSync(fixture.info.dataDir).filter(name => name.startsWith("route-ready-")).length;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "please look at this" });
    const idle = async () => (await api("GET", "/api/bots?messages=0")).bots.find((row: any) => row.id === bot.id)?.busy !== true;
    for (let k = 1; k <= changes; k++) {
      // the first park must happen (else the fixture is broken); a later one only follows when the turn was prepared again, so a turn that
      // simply ended (no retry) leaves the loop and is judged by the assertions below
      await expect.poll(async () => existsSync(at(`route-ready-${readyBase + k}`)) || (k > 1 && await idle()), { timeout: 30000 }).toBe(true);
      if (!existsSync(at(`route-ready-${readyBase + k}`))) break;
      await rotateKey();
      writeFileSync(at(`route-go-${readyBase + k}`), "go");
    }
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const rows = (await botMessages(bot.threadId)).slice(rowsBefore).filter(row => !String(row.tool?.name ?? "").startsWith("engine limit:"));
    const log = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(bot.threadId));
    expect(submissions(bot.threadId) - before).toBe(answered ? 1 : 0);
    expect(rows.map(row => String(row.text ?? "") + String(row.tool?.name ?? "")).join("\n")).not.toMatch(/Send it again|changed just before sending|provider_route_changed/);
    if (answered) {
      expect(rows.filter(row => row.kind === "text" && row.text === "Hello from late")).toHaveLength(1);
      expect(rows.filter(row => row.kind === "activity" && row.tool?.ok === false)).toHaveLength(0);
      // the control (nothing moved) is answered with no second preparation; the changed route is prepared once more, silently
      expect(log.some(line => line.includes(`[turn] setup failed in Murage on thread ${bot.threadId} (${murageStartFailureLine("provider_route_changed")}); preparing it once more`))).toBe(changes > 0);
    } else {
      expect(rows.filter(row => row.kind === "text")).toHaveLength(0);
      const cards = rows.filter(row => row.kind === "activity" && row.tool?.ok === false);
      expect(cards.map(row => row.tool.name)).toEqual(["Murage couldn't start this reply because the AI service picked for this bot changed while your message was being prepared."]); // literal: the table is not its own oracle
      expect(String(cards[0].tool.errorDetails)).toContain("provider_route_changed");
    }
  }, 120000);
});
