// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Linux CI only. Bot email through server/index.ts against a loopback fake of Flux (the server's fetch is replaced in the fixture):
//   1. 5.2 arrival: mail from two #28 batches is ONE owner-only notice row in the bot's main chat ("and 2 more"), and no turn starts.
//   2. 5.4 marks through startTurnAdmitting: a turn called email_read; the next turn resumes the same engine
//      session, whose transcript since it started holds the read, so the next reply is marked.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { turnSecret } from "../turn-credential.ts";

type Fixture = { fixture: VerificationServer; headers: Record<string, string>; model: string };

async function launch(instrumentationSource?: string): Promise<Fixture> {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';${instrumentationSource ?? ""}` });
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(new URL("/api/desktop-secret", fixture.info.url))).json() as { secret: string }).secret };
  const instances = await (await fetch(new URL("/api/instances", fixture.info.url), { headers })).json() as any;
  return { fixture, headers, model: instances.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id };
}
async function call(f: Fixture, method: string, path: string, body?: unknown, headers: Record<string, string> = f.headers) {
  const response = await fetch(new URL(path, f.fixture.info.url), { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
async function api(f: Fixture, method: string, path: string, body?: unknown) {
  const answer = await call(f, method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
}
const dump = (f: Fixture) => { try { return existsSync(f.fixture.fixtureDumpPath) ? JSON.parse(readFileSync(f.fixture.fixtureDumpPath, "utf8")) : null; } catch { return null; } };
function agentsEnv(value: any): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.env?.MURAGE_COMMS_TOKEN === "string" || typeof value.env?.MURAGE_CRED_FILE === "string") return value.env;
  for (const child of Object.values(value)) { const found = agentsEnv(child); if (found) return found; }
  return undefined;
}
const idle = async (f: Fixture) => {
  const state = await api(f, "GET", "/api/bots?messages=0");
  return !state.bots.some((bot: any) => bot.busy);
};
async function makeBot(f: Fixture, name: string) {
  const bot = (await api(f, "POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: f.model } })).bot;
  await api(f, "PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  return bot as { id: string; threadId: string };
}
/** Holds one owner turn open, hands its credential and dump to `during`, then lets it finish. */
async function holdTurn(f: Fixture, bot: { id: string; threadId: string }, marker: string, during: (env: Record<string, string>, held: any) => Promise<void>) {
  await api(f, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${marker}\n__fixture_hold_authority__` });
  await expect.poll(() => JSON.stringify(dump(f)?.prompt ?? "").includes(marker), { timeout: 20000 }).toBe(true);
  const held = dump(f);
  try { await during(agentsEnv(held.mcpConfig)!, held); }
  finally {
    writeFileSync(join(f.fixture.fixtureFinishGateDir, String(held.pid)), "");
    await expect.poll(() => idle(f), { timeout: 20000 }).toBe(true);
  }
}
const internal = async (f: Fixture, path: string, token: string, body: unknown) => {
  const response = await fetch(new URL(path, f.fixture.info.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};


const FAKE_FLUX = `
  const fs=await import('node:fs');const path=await import('node:path');
  const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  cfg.flux={...(cfg.flux||{}),apiKey:'sk-flux-verificationfixture'};fs.writeFileSync(file,JSON.stringify(cfg));
  process.env.MURAGE_EMAIL_SECRETS=JSON.stringify({owner:{token:'owner-fixture-token',keyId:'key_owner_fixture'}});
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const originalFetch=globalThis.fetch;
  const received=(n,from)=>({id:'eev_'+n,type:'email.message.received',created:'2026-11-10T10:00:0'+n+'Z',inbox_id:'ibx_fixture',data:{message_id:'msg_'+n,thread_id:'thr_1',from,subject:'Secret subject '+n,preview:'Secret preview',trust:'untrusted',sender_authenticated:true,spam:false,held_for_owner:false}});
  let polls=0;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.protocol!=='https:')return originalFetch(input,init);
    if(!/(^|\\.)fluxrouter\\.ai$/.test(url.hostname))throw new Error('External network is refused in this fixture');
    const method=String(init?.method??'GET').toUpperCase();const p=url.pathname;
    if(p==='/v1/email/capabilities')return json(200,{object:'email.capabilities',enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{max_inboxes:5}});
    if(method==='POST'&&p==='/api/desktop/bot-keys')return json(201,{key:'bot-email-fixture',key_id:'key_bot_fixture'});
    if(method==='POST'&&p==='/v1/email/inboxes'){const b=JSON.parse(String(init.body));return json(201,{id:'ibx_fixture',bot_id:b.bot_id,address:'fixture@murage.email',state:'active',send_policy:'auto'});}
    if(method==='GET'&&p==='/v1/email/inboxes/ibx_fixture')return json(200,{id:'ibx_fixture',address:'fixture@murage.email',state:'active',sends_today:0,daily_send_cap:50});
    if(method==='GET'&&p==='/v1/email/inboxes/ibx_fixture/messages/msg_1')return json(200,{id:'msg_1',thread_id:'thr_1',from:'alex@example.com',subject:'Invoice',text:'Please pay invoice 42.',trust:'untrusted',sender_authenticated:true,spam:false,held_for_owner:false});
    if(method==='GET'&&p==='/v1/email/events'){
      polls++;
      if(polls===1)return json(200,{object:'list',data:[received(1,'Alex <Alex@Example.com>'),received(2,'sam@example.org')],next_cursor:'c_2'});
      if(polls===2)return json(200,{object:'list',data:[received(3,'kim@example.net')],next_cursor:'c_3'});
      await new Promise(resolve=>setTimeout(resolve,400));
      return json(200,{object:'list',data:[],next_cursor:'c_3'});
    }
    return json(404,{error:'not_found',message:'Not in this fixture.'});
  };
`;

describe.skipIf(process.platform !== "linux")("bot email through server/index.ts: arrival notices and turn marks", () => {
  let f: Fixture;
  beforeAll(async () => { f = await launch(FAKE_FLUX); }, 60000);
  afterAll(async () => { await f?.fixture.close(); });
  const rows = async (bot: { threadId: string }) => (await api(f, "GET", `/api/threads/${bot.threadId}/messages`)).messages as any[];

  it("two batches of mail make one grouped owner notice, with no subject and no turn", async () => {
    await expect.poll(async () => (await call(f, "GET", "/api/email/status?refresh=1")).status, { timeout: 20000 }).toBe(200);
    const bot = await makeBot(f, "Arrival fixture");
    await api(f, "POST", `/api/email/bots/${bot.id}/setup`, { username: "fixture", displayName: "Fixture" });
    await expect.poll(async () => (await rows(bot)).filter(row => row.murage?.status?.key === "email_arrived").map(row => row.text).join("|"), { timeout: 30000 })
      .toBe("New email for Arrival fixture from alex@example.com and 2 more");
    const notices = (await rows(bot)).filter(row => row.murage?.status?.key === "email_arrived");
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain("Secret");
    expect(await idle(f)).toBe(true);
  }, 90000);

  it("a turn that read mail leaves its engine session holding it: the resumed session's next reply is marked", async () => {
    const bot = (await api(f, "GET", "/api/bots?messages=0")).bots.find((item: any) => item.name === "Arrival fixture") as { id: string; threadId: string };
    await holdTurn(f, bot, "EMAIL_READ_HOLD", async env => {
      expect(env.MURAGE_EMAIL).toBe("send");
      const read = await internal(f, "/api/internal/email/email_read", turnSecret("MURAGE_COMMS_TOKEN", env), { message_id: "msg_1" });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
    });
    const replies = async () => (await rows(bot)).filter(row => row.role === "bot" && row.kind === "text" && !row.murage && !row.murageLine);
    // the read turn wrote no reply; its result is in the engine session, which the next turn resumes
    const before = (await replies()).length;
    await api(f, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "EMAIL_SECOND_TURN" });
    await expect.poll(async () => (await replies()).length, { timeout: 20000 }).toBeGreaterThan(before);
    await expect.poll(() => idle(f), { timeout: 20000 }).toBe(true);
    expect((await replies()).at(-1)?.externalContent, JSON.stringify(await replies())).toBe("email");
  }, 120000);
});
