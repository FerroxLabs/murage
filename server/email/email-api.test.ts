// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Linux CI only. Bot email (BOT-EMAIL-MURAGE-109) through isolated servers, each with its own temporary HOME/data and fake engine.
//   1. Dark launch: no Flux key, no email. Every /api/email route is the one not-available refusal, a bot's turn credential is refused
//      before any route, the turn lists no email tools, and nothing about email is written to the conversation.
//   2. Email on against a loopback fake of Flux (the server's fetch is replaced in the fixture; no request leaves the machine): the owner
//      gives the bot an address, the bot's email_send is held for a new contact as an email card, the card is answered through the thread's
//      HTTP respond route (refused to a caller that is not the owner), and the email_outcome row reaches the bot's next turn.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { turnSecret } from "../turn-credential.ts";
import { EMAIL_OWNER_COPY } from "../../shared/email-copy.ts";

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

describe.skipIf(process.platform !== "linux")("bot email dark launch through an isolated server", () => {
  let f: Fixture;
  beforeAll(async () => { f = await launch(); }, 60000);
  afterAll(async () => { await f?.fixture.close(); });

  it("probe off: no route answers beyond a not-available refusal, a bot credential never reaches one, no tool, card or notice", async () => {
    const bot = await makeBot(f, "Dark mail");
    for (const [method, path, body] of [["GET", "/api/email/status"], ["GET", `/api/email/bots/${bot.id}`], ["POST", "/api/email/account", { on: true }], ["POST", `/api/email/bots/${bot.id}/setup`, { username: "dark", displayName: "Dark" }], ["POST", `/api/email/bots/${bot.id}/trusted-add`, { entry: "a@b.test" }]] as const) {
      expect(await call(f, method, path, body), path).toEqual({ status: 404, body: { error: EMAIL_OWNER_COPY.notAvailable } });
    }
    // a caller that is not the owner's surface is refused before the launch switch is even read
    // (the server's own door refuses it first: no route at all for a caller without the owner's proof)
    expect([403, 404]).toContain((await call(f, "GET", "/api/email/status", undefined, {})).status);
    await holdTurn(f, bot, "EMAIL_DARK_HOLD", async env => {
      expect(env.MURAGE_EMAIL).toBeUndefined();
      const token = turnSecret("MURAGE_COMMS_TOKEN", env);
      // F18: the bot's own turn credential never reaches an owner route, with or without the desktop marker
      expect([403, 404]).toContain((await call(f, "GET", "/api/email/status", undefined, { authorization: `Bearer ${token}` })).status);
      expect(await call(f, "GET", "/api/email/status", undefined, { ...f.headers, authorization: `Bearer ${token}` })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.ownerOnly } });
      // the tool route itself refuses while off
      expect((await internal(f, "/api/internal/email/email_send", token, { to: ["a@b.test"], subject: "x", text: "y" })).status).toBe(403);
    });
    const rows = (await api(f, "GET", `/api/threads/${bot.threadId}/messages`)).messages as any[];
    expect(rows.some(row => row.card?.emailSend || row.card?.emailTrustOffer || row.murage?.status?.key === "email_outcome")).toBe(false);
    expect(JSON.stringify(dump(f)?.prompt ?? "")).not.toMatch(/email_send|email_list/);
  }, 90000);
});

/** A loopback fake of Flux inside the server process: capabilities on, key mint, inbox create and read, send. Every https request is
 * answered here or refused; each is logged (path and the credential's first characters only) for the assertions. */
const FAKE_FLUX = `
  const fs=await import('node:fs');const path=await import('node:path');
  const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  cfg.flux={...(cfg.flux||{}),apiKey:'sk-flux-verificationfixture'};fs.writeFileSync(file,JSON.stringify(cfg));
  process.env.MURAGE_EMAIL_SECRETS=JSON.stringify({owner:{token:'owner-fixture-token',keyId:'key_owner_fixture'}});
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.protocol!=='https:')return originalFetch(input,init);
    const method=String(init?.method??'GET').toUpperCase();const auth=new Headers(init?.headers).get('authorization')??'';
    fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'flux.log'),JSON.stringify({method,host:url.hostname,path:url.pathname,auth:auth.slice(7,19)})+'\\n');
    if(!/(^|\\.)fluxrouter\\.ai$/.test(url.hostname))throw new Error('External network is refused in this fixture');
    const p=url.pathname;
    if(p==='/v1/email/capabilities')return json(200,{object:'email.capabilities',enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{max_inboxes:5}});
    if(method==='POST'&&p==='/api/desktop/bot-keys')return json(201,{key:'bot-email-fixture',key_id:'key_bot_fixture'});
    if(method==='POST'&&p==='/v1/email/inboxes'){const b=JSON.parse(String(init.body));return json(201,{id:'ibx_fixture',bot_id:b.bot_id,address:'fixture@murage.email',state:'active',send_policy:'auto'});}
    if(method==='GET'&&p==='/v1/email/inboxes/ibx_fixture')return json(200,{id:'ibx_fixture',address:'fixture@murage.email',state:'active',sends_today:0,daily_send_cap:50});
    if(method==='POST'&&p==='/v1/email/inboxes/ibx_fixture/messages')return json(200,{status:'sent',message_id:'msg_fixture'});
    return json(404,{error:'not_found',message:'Not in this fixture.'});
  };
`;

describe.skipIf(process.platform !== "linux")("bot email on, against a loopback fake of Flux", () => {
  let f: Fixture;
  beforeAll(async () => { f = await launch(FAKE_FLUX); }, 60000);
  afterAll(async () => { await f?.fixture.close(); });
  const fluxLog = () => { const file = join(f.fixture.info.dataDir, "flux.log"); return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; };

  it("the owner gives an address; the held send is an email card answered over HTTP by the owner only; the outcome reaches the next turn", async () => {
    await expect.poll(async () => (await call(f, "GET", "/api/email/status?refresh=1")).status, { timeout: 20000 }).toBe(200);
    const bot = await makeBot(f, "Mail fixture");
    const view = await api(f, "POST", `/api/email/bots/${bot.id}/setup`, { username: "fixture", displayName: "Fixture" });
    expect(view).toMatchObject({ state: "active", address: "fixture@murage.email" });
    await holdTurn(f, bot, "EMAIL_ON_HOLD", async env => {
      expect(env.MURAGE_EMAIL).toBe("send");
      const token = turnSecret("MURAGE_COMMS_TOKEN", env);
      // F18 with email on: still refused, and the inbox was never created with a bot credential
      expect(await call(f, "GET", "/api/email/status", undefined, { ...f.headers, authorization: `Bearer ${token}` })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.ownerOnly } });
      const held = await internal(f, "/api/internal/email/email_send", token, { to: ["new.person@example.test"], subject: "Hello", text: "Hi there" });
      expect(held.status, JSON.stringify(held.body)).toBe(200);
    });
    const rows = async () => (await api(f, "GET", `/api/threads/${bot.threadId}/messages`)).messages as any[];
    const card = (await rows()).find(row => row.card?.emailSend)?.card;
    expect(card, JSON.stringify(await rows())).toBeTruthy();
    expect(card).toMatchObject({ kind: "email-send", emailSend: { phase: "open", state: "awaiting_owner" } });
    expect(fluxLog().some(entry => entry.path.endsWith("/messages"))).toBe(false);
    // not the owner's surface: may never say Send
    expect((await call(f, "POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow", emailAction: "send", emailRevision: card.emailSend.revision }, {})).status).toBe(403);
    const answered = await call(f, "POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow", emailAction: "send", emailRevision: card.emailSend.revision });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => (await rows()).find(row => row.card?.requestId === card.requestId)?.card.emailSend.state, { timeout: 10000 }).toBe("sent");
    const sends = fluxLog().filter(entry => entry.method === "POST" && entry.path === "/v1/email/inboxes/ibx_fixture/messages");
    expect(sends).toHaveLength(1);
    expect(sends[0].auth).toBe("bot-email-fi");
    expect(fluxLog().find(entry => entry.path === "/v1/email/inboxes" && entry.method === "POST")?.auth).toBe("owner-fixtur");
    const outcome = (await rows()).find(row => row.murage?.status?.key === "email_outcome");
    expect(outcome?.text).toContain(card.emailSend.ref);
    // 4.6: the bot hears it on its next turn, as an external update of the conversation
    await api(f, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "EMAIL_NEXT_TURN" });
    await expect.poll(() => JSON.stringify(dump(f)?.prompt ?? "").includes("EMAIL_NEXT_TURN"), { timeout: 20000 }).toBe(true);
    expect(JSON.stringify(dump(f).prompt)).toContain(card.emailSend.ref);
    await expect.poll(() => idle(f), { timeout: 20000 }).toBe(true);
  }, 120000);
});
