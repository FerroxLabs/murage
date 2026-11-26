import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyHandler } from "../companion/src/proxy.ts";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../companion/src/browser.ts";
import { skillSwitchIngressFixtureSource,skillSwitchCountFixtureSource } from './testing/skill-switch-ingress-fixture.ts';
// Both bot and owner workflow sides are owned by the skill-switch build lane.
// Queue/fence owner: decision lane. All writes target this isolated fake-engine fixture.
import { existsSync, readFileSync, writeFileSync, realpathSync,cpSync,unlinkSync,mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../scripts/control-murage.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { raiseLevel } from "./testing/raise-level.ts";
import {removeTempDir} from './testing/cleanup.ts';
import {DatabaseSync} from 'node:sqlite';
let fixture: VerificationServer;
let desktop: Record<string, string>;
const companionToken = "a".repeat(64);
const guestDoor = { "x-murage-door-token": companionToken };
const bots: any[] = [];
const evidence: unknown[] = [];
const api = fixtureDisplayApi(() => join(fixture.info.dataDir, "messages.db"), async (method: string, path: string, body?: any, headers = desktop) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const responseText = await response.text();
  let result: any;
  try { result = JSON.parse(responseText); } catch { result = { error: responseText }; }
  // No transport credentials or request headers enter evidence.
  evidence.push({ method, path, status: response.status, result });
  return { status: response.status, body: result };
});
const md = (name: string, body = "Read supplied notes.") => `---\nname: ${name}\ndescription: Sample instructions\n---\n${body}\n`;
const manifestPath = (bot: any) => join(fixture.info.dataDir, "skill-state", bot.id, "skills.json");
const manifest = (bot: any) => readFileSync(manifestPath(bot), "utf8");
const skills = async (bot: any) => (await api("GET", `/api/bots/${bot.id}/skills`)).body.skills;
const messages = async (bot: any) => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
const switchCards = async (bot: any) => (await messages(bot)).filter(message => message.card?.skillRequest?.action === "turn_off" || message.card?.skillRequest?.action === "turn_on" || message.card?.skillRequest?.action === "delete");
async function startSkillFixture(){
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: companionToken }, instrumentationSource: `
    process.env.FAKE_CLAUDE_MODE='hang';
    process.env.MURAGE_SWITCH_COUNTS_FIXTURE='1';
    const fs=await import('node:fs'); const {registerHooks}=await import('node:module');
    const fixtureSource=${skillSwitchIngressFixtureSource.toString()};
    const fixtureCountSource=${skillSwitchCountFixtureSource.toString()};
    registerHooks({load(url,context,next) {
      if(url.endsWith('/server/decision/implementation.ts'))return {format:'module-typescript',shortCircuit:true,source:fixtureCountSource(url,fs.readFileSync(new URL(url),'utf8'))};
      if(url.endsWith('/server/atomic.ts'))return {format:'module-typescript',shortCircuit:true,source:fixtureSource(url,fs.readFileSync(new URL(url),'utf8'))};
      if(url.endsWith('/server/skill-switch-executor.ts')||url.endsWith('/server/narrow-denials.ts'))return {format:'module-typescript',shortCircuit:true,source:fixtureCountSource(url,fs.readFileSync(new URL(url),'utf8'))};
      if(url.endsWith('/server/skill-guard/scan.ts'))return {format:'module-typescript',shortCircuit:true,source:fixtureCountSource(url,fs.readFileSync(new URL(url),'utf8'))};
      if(url.endsWith('/server/skill-switch-settlement.ts'))return {format:'module-typescript',shortCircuit:true,source:fixtureSource(url,fs.readFileSync(new URL(url),'utf8'))};
      if(url.endsWith('/server/skills.ts')) {
        const anchor='  // currentSkillScan may have written the manifest: read it again.';
        let source=fs.readFileSync(new URL(url),'utf8');
        if(!source.includes(anchor))throw Error('skill effect fixture anchor missing');
        source="import {appendFileSync as recordSwitchEffect} from 'node:fs';\\n"+source.replace(anchor, "  recordSwitchEffect(join(DATA_DIR,'fixture-switch-effects.jsonl'),JSON.stringify({botId,name,enabled,acknowledged:options.acknowledged})+String.fromCharCode(10));\\n"+anchor);
        const boundedAnchor='  const {botId,name,entry}=state;';
        if(source.includes(boundedAnchor))source=source.replace(boundedAnchor,boundedAnchor+"\\n  recordSwitchEffect(join(DATA_DIR,'fixture-switch-effects.jsonl'),JSON.stringify({botId,name,enabled:action==='turn_on',acknowledged:options.acknowledged})+String.fromCharCode(10));");
        return {format:'module-typescript',shortCircuit:true,source:fixtureCountSource(url,source)};
      }
      if(!url.endsWith('/server/index.ts'))return next(url,context);
      let source="import {appendLegacyFixtureMessage} from './testing/approval-card.ts';\\n"+fixtureSource(url,fs.readFileSync(new URL(url),'utf8'));
      const anchor='const bot = store.createBot({ ...profile.patch, section: proven ? section : undefined, ...(selection ? { modelSelection: selection } : {}) }, { noAccess: !proven, ...(proven && startComputer.computer ? { computer: startComputer.computer } : {}) });';
      if(!source.includes(anchor))throw Error('legacy fixture seed anchor missing');
      source=source.replace(anchor,anchor+\`
        if(bot.name==='Legacy fixture') {
          const requestId=randomUUID(); const preview='Sample instructions';
          appendLegacyFixtureMessage(store,bot.threadId,{role:'bot',kind:'options',card:{title:'Turn off skill "sample-skill"?',subtitle:'Review the skill.',tool:'switch_skill',requestId,options:['Turn off','Deny'],skillRequest:{version:1,requestId,botId:bot.id,threadId:bot.threadId,stagedId:'',action:'turn_off',name:'sample-skill',gist:'Sample',source:'learn:conversation',preview,sha256:createHash('sha256').update(preview).digest('hex'),warnings:[],createdAt:Date.now()}}});
        }
      \`);
      return {format:'module-typescript',shortCircuit:true,source};
    }});
  ` }).catch(error=>{const path=/see (.+\.log)/.exec(String(error))?.[1];if(path&&existsSync(path))console.error(readFileSync(path,'utf8'));throw error;});
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  // Recall workers are outside this fixture's skill-approval workflow.
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
  const doctor = await runControlMurage(["doctor", "--url", fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  evidence.push({ command: ["doctor", "--url", fixture.info.url], result: doctor });
  expect(doctor).toMatchObject({ ok: true });
  for (const name of ["sample-skill", "shared-skill"]) {
    expect((await api("POST", "/api/skills/import", { files: [{ path: "SKILL.md", content: md(name) }], kind: "file" })).status).toBe(201);
  }
}
beforeAll(startSkillFixture,120_000);
afterEach(async () => {
  for (const bot of bots.splice(0)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
});
afterAll(async () => {
  if (fixture && process.env.SKILL_SWITCH_EVIDENCE === "stdout") console.log("SKILL_SWITCH_WORKFLOW " + JSON.stringify({ fixture: fixture.info, calls: evidence, serverLog: readFileSync(fixture.info.logPath, "utf8") }));
  else if (fixture && process.env.SKILL_SWITCH_EVIDENCE) writeFileSync(process.env.SKILL_SWITCH_EVIDENCE, JSON.stringify({ fixture: fixture.info, calls: evidence }, null, 2));
  await fixture?.close();
});
async function makeBot(shared = false, nameOverride = "Fixture bot") {
  const made = await api("POST", "/api/bots", { name: nameOverride, modelSelection: { instanceId: "verification", model: "fake" } });
  expect(made.status).toBe(201);
  const bot = made.body.bot; bots.push(bot);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  const name = shared ? "shared-skill" : "sample-skill";
  expect((await api("PUT", `/api/skills/collection:${name}/bots/${bot.id}`, { on: true })).status).toBe(200);
  if (!shared) {
    // Fixture preparation: the same installed bytes, with learned provenance, to exercise only-copy wording.
    const state = JSON.parse(manifest(bot)); state[name].source = "learn:conversation";
    writeFileSync(manifestPath(bot), JSON.stringify(state));
  }
  return bot;
}
async function turnEnvironment(bot: any): Promise<Record<string, string>> {
  let env: Record<string, string> | undefined;
  await expect.poll(() => {
    try {
      const data = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
      const candidate = data.mcpConfig?.mcpServers?.agents?.env;
      if (candidate?.MURAGE_BOT_ID !== bot.id || candidate?.MURAGE_THREAD_ID !== bot.threadId) return false;
      env = candidate; return true;
    } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  return env!;
}
async function heldTurn(bot: any) {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Turn off your sample skill." })).status).toBe(202);
  const env = await turnEnvironment(bot);
  return { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` };
}
const requestSwitch = (bot: any, auth: Record<string, string>, action = "turn_off", name = "sample-skill") => api("POST", "/api/internal/skills/switch", { fromBotId: bot.id, fromThreadId: bot.threadId, action, skill_name: name }, auth);
const answer = async (bot: any, card: any, behavior: string, hash = card.skillRequest.sha256) => {
  const result=await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior, reviewedSha256: hash, reviewedVerdictHash:card.skillRequest.verdictHash });
  if(behavior==='allow'&&hash===card.skillRequest.sha256&&result.status!==200)console.error('fixture answer',JSON.stringify({result,hasVerdict:!!card.skillRequest.verdictHash}));
  return result;
};
async function proposed(bot: any, auth: Record<string, string>, action = "turn_off", name = "sample-skill") {
  const result = await requestSwitch(bot, auth, action, name);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const cards = await switchCards(bot);
  return cards.at(-1)!.card;
}
it("nothing changes without an approved card; deny preserves the manifest bytes and logs user-denied", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot), before = manifest(bot), listed = await skills(bot);
  const card = await proposed(bot, auth);
  expect(card.options).toEqual(["Turn off", "Deny"]);
  expect(card.answered).toBeUndefined();
  expect(manifest(bot)).toBe(before); expect(await skills(bot)).toEqual(listed);
  expect((await answer(bot, card, "deny")).status).toBe(200);
  expect(manifest(bot)).toBe(before); expect(await skills(bot)).toEqual(listed);
  expect((await switchCards(bot)).at(-1)!.card.answered).toBe("deny");
  const decisions = readFileSync(join(fixture.info.dataDir, "decisions.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(decisions).toContainEqual(expect.objectContaining({ requestId: card.requestId, decision: "user-denied", tool: "skill_switch" }));
});
it("wrong reviewed hash refuses; approval turns it off and a repeat has no card", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot), before = manifest(bot), card = await proposed(bot, auth);
  expect((await answer(bot, card, "allow", "0".repeat(64))).status).toBe(409);
  expect(manifest(bot)).toBe(before);
  expect((await answer(bot, card, "allow")).status).toBe(200);
  expect((await skills(bot))[0].enabled).toBe(false);
  expect(await requestSwitch(bot, auth)).toMatchObject({ status: 409, body: { error: expect.stringContaining("Already off") } });
  expect(await switchCards(bot)).toHaveLength(1);
});
it("refuses approval when SKILL.md changed after the card", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot), card = await proposed(bot, auth);
  const file = realpathSync(join(fixture.info.dataDir, "workspaces", bot.id, "skills", "sample-skill", "SKILL.md"));
  writeFileSync(file, md("sample-skill", "Changed after review."));
  const before = manifest(bot);
  expect((await answer(bot, card, "allow")).status).toBe(409);
  expect(manifest(bot)).toBe(before);
  const stale = (await switchCards(bot)).at(-1)!.card;
  expect(JSON.stringify(stale)).toContain("nothing was changed");
});
it("refuses approval when the owner flipped the enabled state", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot), card = await proposed(bot, auth);
  expect((await api("PATCH", `/api/bots/${bot.id}/skills/sample-skill`, { enabled: false })).status).toBe(200);
  const before = manifest(bot);
  expect((await answer(bot, card, "allow")).status).toBe(409);
  expect(manifest(bot)).toBe(before);
});
it("approved shared take-off leaves the other bot and collection copy alone", async () => {
  const a = await makeBot(true), b = await makeBot(true), auth = await heldTurn(a), beforeB = manifest(b);
  const card = await proposed(a, auth, "delete", "shared-skill");
  expect(card.subtitle).toContain("Your other bots and the shared copy keep it");
  expect((await answer(a, card, "allow")).status).toBe(200);
  expect(await skills(a)).toEqual([]); expect(manifest(b)).toBe(beforeB);
  expect((await skills(b))[0].enabled).toBe(true);
  const shared = await api("GET", "/api/skills/collection:shared-skill");
  expect(shared.status).toBe(200);
  expect(shared.body.usedBy.map((entry: any) => entry.botId)).toEqual([b.id]);
});
it("No limits runs without a card, but a blocked turn-on still refuses before the queue", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const auth = await heldTurn(bot);
  expect(await requestSwitch(bot, auth)).toMatchObject({ status: 201, body: { autoApproved: true, summary: expect.stringContaining("Done under No limits") } });
  expect((await skills(bot))[0].enabled).toBe(false); expect(await switchCards(bot)).toHaveLength(0);
  const state = JSON.parse(manifest(bot)); state["sample-skill"].scan = { ...state["sample-skill"].scan, verdict: "blocked", findings: [] };
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  expect((await requestSwitch(bot, auth, "turn_on")).status).toBe(409);
  expect((await skills(bot))[0].enabled).toBe(false); expect(await switchCards(bot)).toHaveLength(0);
});
it("rejects missing and built-in names, invalid actions, and wrong source threads", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot);
  expect((await requestSwitch(bot, auth, "delete", "not-installed")).status).toBe(404);
  expect((await requestSwitch(bot, auth, "delete", "chief-of-staff")).status).toBe(404);
  expect((await requestSwitch(bot, auth, "enable")).status).toBe(400);
  expect((await api("POST", "/api/internal/skills/switch", { fromBotId: bot.id, fromThreadId: "other-thread", action: "delete", skill_name: "sample-skill" }, auth)).status).toBe(403);
  expect(await switchCards(bot)).toHaveLength(0);
});
it("caps create and switch cards together at eight", async () => {
  expect((await api("PATCH", "/api/config", { features: { skillRecorder: true } })).status).toBe(200);
  const bot = await makeBot(), auth = await heldTurn(bot);
  const stage = await api("POST", "/api/internal/skills/stage", { fromBotId: bot.id, fromThreadId: bot.threadId, action: "create", source: "conversation", skill_md: md("pending-skill") }, auth);
  expect(stage.status).toBe(201);
  for (let i = 0; i < 7; i++) expect((await requestSwitch(bot, auth)).status).toBe(201);
  expect((await requestSwitch(bot, auth)).status).toBe(429);
  expect((await skills(bot))[0].enabled).toBe(true);
});
it("MAIN b: owner skills_list has only names, actions, scope and hashes including staged writes", async () => {
  const bot = await makeBot(), auth = await heldTurn(bot);
  expect((await api("PATCH", "/api/config", { features: { skillRecorder: true } })).status).toBe(200);
  const staged = await api("POST", "/api/internal/skills/stage", { fromBotId: bot.id, fromThreadId: bot.threadId,
    action: "create", source: "conversation", skill_md: md("pending-list-skill"), gist: "Private staged gist" }, auth);
  expect(staged.status).toBe(201);
  const before = manifest(bot);
  expect((await api("PATCH", "/api/config", { features: { skillRecorder: false } })).status).toBe(200);
  const listed = await api("GET", `/api/internal/skills?fromBotId=${bot.id}&fromThreadId=${bot.threadId}`, undefined, auth);
  expect(listed.status).toBe(200);
  expect(Object.keys(listed.body).sort()).toEqual(["skills", "staged"]);
  expect(listed.body.skills).toHaveLength(1); expect(listed.body.staged).toHaveLength(1);
  for (const row of [...listed.body.skills, ...listed.body.staged]) {
    expect(Object.keys(row).sort()).toEqual(["action", "name", "scope", "sha256"]);
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/); expect(row.scope).toEqual(expect.any(String));
  }
  expect(listed.body.skills[0]).toMatchObject({ name: "sample-skill", action: "turn_off", sha256: JSON.parse(before)["sample-skill"].sha256 });
  expect(listed.body.staged[0]).toMatchObject({ name: "pending-list-skill", action: "create" });
  for (const secret of ["Read supplied notes.", "Sample instructions", "Private staged gist", "conversation"])
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  expect(manifest(bot)).toBe(before);
});
it("skills_list and switching work with authoring disabled", async () => {
  expect((await api("PATCH", "/api/config", { features: { skillRecorder: false } })).status).toBe(200);
  const bot = await makeBot(), auth = await heldTurn(bot);
  expect((await api("GET", `/api/internal/skills?fromBotId=${bot.id}&fromThreadId=${bot.threadId}`, undefined, auth)).status).toBe(200);
  expect((await requestSwitch(bot, auth)).status).toBe(201);
  expect((await api("POST", "/api/internal/skills/stage", { fromBotId: bot.id, fromThreadId: bot.threadId, action: "create", source: "conversation", skill_md: md("unavailable-skill") }, auth)).status).toBe(403);
});

it("Full access setup approval waits until the reply ends", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true })).status).toBe(200);
  const auth = await heldTurn(bot), before = manifest(bot);
  expect(await requestSwitch(bot, auth)).toMatchObject({ status: 201, body: { startsWhen: "reply-ends" } });
  expect(manifest(bot)).toBe(before);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "1");
  await expect.poll(async () => (await skills(bot))[0].enabled, { timeout: 30_000 }).toBe(false);
  for (const command of [["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url], ["messages", "--bot", bot.id, "--limit", "10", "--url", fixture.info.url]]) {
    evidence.push({ command, result: await runControlMurage(command, { env: { MURAGE_DATA_DIR: fixture.info.dataDir } }) });
  }
});
it("routine origin keeps a card under Full access setup approvals", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true })).status).toBe(200);
  const made = await api("POST", "/api/routines", { name: "Fixture routine", prompt: "Turn off the sample skill.", botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86400000 } });
  expect(made.status).toBe(201);
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  const started = await api("POST", `/api/routines/${made.body.routine.id}/run`);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))), env = dump.mcpConfig.mcpServers.agents.env;
  const origin = { ...bot, threadId: env.MURAGE_THREAD_ID };
  bots.push(origin);
  const result = await requestSwitch(origin, { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` });
  expect(result.status).toBe(201); expect(result.body.startsWhen).toBeUndefined();
  const card = (await switchCards(origin)).at(-1)!.card;
  expect(card.answered).toBeUndefined(); expect((await skills(bot))[0].enabled).toBe(true);
  const dumpAtFinish = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  writeFileSync(join(fixture.fixtureFinishGateDir, String(dumpAtFinish.pid)), "1");
  await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  expect((await switchCards(origin)).at(-1)!.card.answered).toBeUndefined();
  expect((await skills(bot))[0].enabled).toBe(true);
  expect((await answer(origin, card, "deny")).status).toBe(200);
  // MAIN RULING 1115-SKILLS-GROK d: routine runs return 201; webhooks remain 202.
  expect(started.status).toBe(201);
});

it("legacy switch cards are deny-only without a live queue registration", async () => {
  const bot = await makeBot(false, "Legacy fixture"), before = manifest(bot);
  const card = (await switchCards(bot)).at(-1)!.card;
  expect(await answer(bot, card, "allow")).toMatchObject({ status: 409, body: { error: "This card is from before a restart: ask the bot again." } });
  expect(manifest(bot)).toBe(before);
  expect((await answer(bot, card, "deny")).status).toBe(200);
  expect((await switchCards(bot)).at(-1)!.card.answered).toBe("deny");
  expect(manifest(bot)).toBe(before);
});
it("a guest turn on a No limits bot still gets an owner card", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const room = (await api("POST", "/api/groups", { name: "Guest fixture", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Turn off the sample skill." }, guestDoor)).status).toBe(202);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const origin = { ...bot, threadId: room.threadId }; bots.push(origin);
  const env = await turnEnvironment(origin);
  const before = manifest(bot);
  expect((await requestSwitch(origin, { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` })).status).toBe(201);
  expect((await switchCards(origin)).at(-1)!.card.answered).toBeUndefined();
  expect(manifest(bot)).toBe(before);
  expect((await answer(origin, (await switchCards(origin)).at(-1)!.card, "deny")).status).toBe(200);
});
it("turn-on approval acknowledges exactly the review findings shown on its card", async () => {
  const bot = await makeBot();
  const state = JSON.parse(manifest(bot)), entry = state["sample-skill"];
  entry.enabled = false;
  entry.scan = { ...entry.scan, verdict: "review", findings: [{ rule: "fixture-review", category: "instruction", severity: "medium", confidence: 1, message: "Review this instruction", evidence: "Sample", file: "SKILL.md", source: "murage" }] };
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  const auth = await heldTurn(bot), card = await proposed(bot, auth, "turn_on");
  expect(card.options).toEqual(["Turn on", "Deny"]);
  expect(card.subtitle).toContain("Review this instruction");
  expect((await skills(bot))[0].enabled).toBe(false);
  expect((await answer(bot, card, "allow")).status).toBe(200);
  expect((await skills(bot))[0].enabled).toBe(true);
});
it("blocked turn-on in Ask refuses before a card", async () => {
  const bot = await makeBot(), state = JSON.parse(manifest(bot));
  state["sample-skill"].enabled = false;
  state["sample-skill"].scan = { ...state["sample-skill"].scan, verdict: "blocked", findings: [] };
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  const auth = await heldTurn(bot), before = manifest(bot);
  const refused = await requestSwitch(bot, auth, "turn_on");
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("This skill was blocked by the skill check and can't be switched on.");
  expect(await switchCards(bot)).toHaveLength(0); expect(manifest(bot)).toBe(before);
});

it("Grok H2: a guest transcript has no skill body or metadata, and only the owner can review and allow", async () => {
  const bot = await makeBot();
  const room = (await api("POST", "/api/groups", { name: "Private review fixture", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Delete the sample skill." }, guestDoor)).status).toBe(202);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const origin = { ...bot, threadId: room.threadId }; bots.push(origin);
  const env = await turnEnvironment(origin);
  const guestAuth = { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` };
  // MAIN RULING 1115-SKILLS-GROK b: a non-owner model cannot read the list.
  const guestList = await api("GET", `/api/internal/skills?fromBotId=${bot.id}&fromThreadId=${origin.threadId}`, undefined, guestAuth);
  expect(guestList).toEqual({ status: 403, body: { error: "Only the owner can list skills." } });
  const card = await proposed(origin, guestAuth, "delete");
  expect(card.skillRequest.preview).toBeUndefined();
  expect(card.skillRequest.gist).toBeUndefined(); expect(card.skillRequest.warnings).toBeUndefined(); expect(card.skillRequest.source).toBeUndefined();
  expect(JSON.stringify(card)).not.toContain("Read supplied notes.");
  expect(card.subtitle).toBe("This is the only copy. It can't be undone.");
  const path = `/api/threads/${origin.threadId}/skill-switch-review/${(await switchCards(origin)).at(-1)!.id}`;
  const anonymousReview = await api("GET", path, undefined, {});
  const spoofedReview = await api("GET", path, undefined, { "x-murage-surface": "desktop" });
  expect(JSON.stringify([anonymousReview.body, spoofedReview.body])).not.toContain("Read supplied notes.");
  const review = await api("GET", path);
  expect(review.status).toBe(200); expect(review.body.request.preview).toContain("Read supplied notes.");
  expect(review.body.request.sha256).toBe(card.skillRequest.sha256);
  const before = manifest(bot);
  const guestAnswer = await api("POST", `/api/threads/${origin.threadId}/respond`, { requestId: card.requestId, behavior: "allow", reviewedSha256: review.body.request.sha256 }, guestDoor);
  expect(manifest(bot)).toBe(before);
  expect((await answer(origin, card, "allow", "")).status).toBe(409); expect(manifest(bot)).toBe(before);
  expect((await answer(origin, card, "allow", review.body.request.sha256)).status).toBe(200);
  expect(await skills(bot)).toEqual([]);
  expect((await api("GET", path)).status).toBe(409);
  expect(JSON.stringify(await messages(origin))).not.toContain("Read supplied notes.");
  // MAIN RULING 1115-SKILLS-GROK a: routeRefusal seals this companion route.
  expect(anonymousReview.status).toBe(404);
  expect(spoofedReview.status).toBe(404);
  expect(anonymousReview.body).toEqual({ error: "no such route" });
  expect(spoofedReview.body).toEqual({ error: "no such route" });
  expect(guestAnswer.status).toBe(403);
});
it("RED_no_limits_review_is_status_not_card turn_on (Grok H1)", async () => {
  const bot = await makeBot();
  const state = JSON.parse(manifest(bot)), entry = state["sample-skill"];
  entry.enabled = false;
  entry.scan = { ...entry.scan, verdict: "review", findings: [{ rule: "fixture-review", category: "instruction", severity: "medium", confidence: 1, message: "Review this instruction", evidence: "Sample", file: "SKILL.md", source: "murage" }] };
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const auth = await heldTurn(bot), before = manifest(bot);
  const result = await requestSwitch(bot, auth, "turn_on");
  // MAIN RULING design F Decision/§3: review refuses without an attended No limits card; OPEN for GrokBuild approval.
  expect(result.status, JSON.stringify(result.body)).toBe(409); expect(result.body.code).toBe('needs-review');
  expect(result.body.autoApproved).toBeUndefined(); expect(result.body.startsWhen).toBeUndefined();
  expect(manifest(bot)).toBe(before); expect(await switchCards(bot)).toHaveLength(0);
  expect((await skills(bot))[0].enabled).toBe(false);
});
it("Grok H1: an owner-routine at No limits files a card and changes nothing until owner allow", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const made = await api("POST", "/api/routines", { name: "Approval fixture", prompt: "Turn off the sample skill.", botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86400000 } });
  expect(made.status).toBe(201);
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  expect((await api("POST", `/api/routines/${made.body.routine.id}/run`)).status).toBe(201);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const env = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))).mcpConfig.mcpServers.agents.env;
  const origin = { ...bot, threadId: env.MURAGE_THREAD_ID }; bots.push(origin);
  const before = manifest(bot), result = await requestSwitch(origin, { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` });
  expect(result.status, JSON.stringify(result.body)).toBe(201); expect(result.body.autoApproved).toBeUndefined(); expect(result.body.startsWhen).toBeUndefined();
  expect(manifest(bot)).toBe(before);
  const card = (await switchCards(origin)).at(-1)!.card; expect(card.answered).toBeUndefined();
  expect((await answer(origin, card, "allow")).status).toBe(200); expect((await skills(bot))[0].enabled).toBe(false);
});

it("Grok H1: a real webhook on a No limits bot files a card instead of executing", async () => {
  const bot = await makeBot();
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const hook = await api("POST", "/api/webhooks", { name: "Skill approval fixture", prompt: "Turn off the sample skill.", botId: bot.id, runOn: "ember" });
  expect(hook.status).toBe(201);
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  const response = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "fixture" }) });
  expect(response.status).toBe(202);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const env = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))).mcpConfig.mcpServers.agents.env;
  const origin = { ...bot, threadId: env.MURAGE_THREAD_ID }; bots.push(origin);
  const before = manifest(bot), result = await requestSwitch(origin, { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` });
  expect(result.status, JSON.stringify(result.body)).toBe(201); expect(result.body.autoApproved).toBeUndefined(); expect(result.body.startsWhen).toBeUndefined();
  expect(manifest(bot)).toBe(before);
  const card = (await switchCards(origin)).at(-1)!.card;
  expect(card.answered).toBeUndefined(); expect((await answer(origin, card, "deny")).status).toBe(200); expect(manifest(bot)).toBe(before);
});

it.each(["turn_off", "delete"])("RED_no_limits_review_is_status_not_card %s (Grok H1)", async action => {
  const bot = await makeBot();
  const state = JSON.parse(manifest(bot)); state["sample-skill"].scan.verdict = "review";
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const auth = await heldTurn(bot), before = manifest(bot), result = await requestSwitch(bot, auth, action);
  // MAIN RULING design F Decision/§3: off/delete review also returns a noninteractive status; OPEN for GrokBuild approval.
  expect(result.status,JSON.stringify(result.body)).toBe(409);expect(result.body.code).toBe('needs-review');
  expect(result.body.autoApproved).toBeUndefined();expect(result.body.startsWhen).toBeUndefined();
  expect(manifest(bot)).toBe(before);expect(await switchCards(bot)).toHaveLength(0);
});

it("Grok H2: a private turn-on review shows findings only on the owner review surface", async () => {
  const bot = await makeBot();
  const state = JSON.parse(manifest(bot)), entry = state["sample-skill"];
  entry.enabled = false; entry.scan = { ...entry.scan, verdict: "review", findings: [{ rule: "fixture-review", category: "instruction", severity: "medium", confidence: 1, message: "Private review finding", evidence: "Sample", file: "SKILL.md", source: "murage" }] };
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  const room = (await api("POST", "/api/groups", { name: "Private findings fixture", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  const previous = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Turn on the sample skill." }, guestDoor)).status).toBe(202);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8") !== previous, { timeout: 30_000 }).toBe(true);
  const origin = { ...bot, threadId: room.threadId }; bots.push(origin);
  const env = await turnEnvironment(origin), card = await proposed(origin, { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` }, "turn_on");
  expect(JSON.stringify(await messages(origin))).not.toContain("Private review finding");
  expect(JSON.stringify(card)).not.toContain("Read supplied notes."); expect(card.skillRequest.gist).toBeUndefined();
  const review = await api("GET", `/api/threads/${room.threadId}/skill-switch-review/${(await switchCards(origin)).at(-1)!.id}`);
  expect(review.status).toBe(200); expect(review.body.request.gist).toContain("Private review finding");
  expect(review.body.request.preview).toContain("Read supplied notes.");
  expect((await answer(origin, card, "allow", review.body.request.sha256)).status).toBe(200);
  expect((await skills(bot))[0].enabled).toBe(true);
  expect(JSON.stringify(await messages(origin))).not.toContain("Private review finding");
});

// Review H1: a scan may change without changing the file hash or enabled state.
it.each(["turn_on", "turn_off", "delete"])("H1 settlement: Full access rechecks a new review verdict before automatic %s", async action => {
  const bot = await makeBot();
  if (action === "turn_on") {
    expect((await api("PATCH", `/api/bots/${bot.id}/skills/sample-skill`, { enabled: false })).status).toBe(200);
  }
  expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true })).status).toBe(200);
  const auth = await heldTurn(bot);
  expect(await requestSwitch(bot, auth, action)).toMatchObject({ status: 201, body: { startsWhen: "reply-ends" } });
  const card = (await switchCards(bot)).at(-1)!.card;
  const state = JSON.parse(manifest(bot));
  state["sample-skill"].scan.verdict = "review";
  state["sample-skill"].scan.findings = [{ rule: "fixture-review", category: "instruction", severity: "medium", confidence: 1, message: "New review finding", evidence: "Sample", file: "SKILL.md", source: "murage" }];
  writeFileSync(manifestPath(bot), JSON.stringify(state));
  const before = manifest(bot);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "1");
  const command = ["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url];
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: any) => entry.id === bot.id)?.busy, { timeout: 30_000 }).toBe(false);
  const beforeOwner = await runControlMurage(command, { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  evidence.push({ command, result: beforeOwner });
  // Reply completion and an open owner decision are separate fixture states.
  // Doctor independently proves the fixture remains healthy.
  const settled = await runControlMurage(["doctor", "--url", fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  expect(settled).toMatchObject({ ok: true });
  expect(manifest(bot)).toBe(before);
  expect((await switchCards(bot)).at(-1)!.card.answered).toBeUndefined();
  const decisions = readFileSync(join(fixture.info.dataDir, "decisions.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(decisions.filter(row => row.requestId === card.requestId).map(row => row.decision)).not.toContain("auto-approved");
  expect(beforeOwner).toMatchObject({ status: "needs-user", target: { busy: false } });
  expect((await answer(bot, card, "deny")).status).toBe(200);
  expect(manifest(bot)).toBe(before);
  const waited = await runControlMurage(command, { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  evidence.push({ command, result: waited });
  expect(waited).toMatchObject({ status: "settled" });
});

it.each(["automatic", "owner"])("RED_acknowledgement_only_from_valid_owner_token %s", async mode => {
  const bot = await makeBot();
  expect((await api("PATCH", `/api/bots/${bot.id}/skills/sample-skill`, { enabled: false })).status).toBe(200);
  if (mode === "automatic") expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true })).status).toBe(200);
  const auth = await heldTurn(bot);
  expect((await requestSwitch(bot, auth, "turn_on")).status).toBe(201);
  if (mode === "automatic") {
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "1");
    await expect.poll(async () => (await skills(bot))[0].enabled, { timeout: 30_000 }).toBe(true);
  } else expect((await answer(bot, (await switchCards(bot)).at(-1)!.card, "allow")).status).toBe(200);
  const effects = readFileSync(join(fixture.info.dataDir, "fixture-switch-effects.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const effect = effects.filter(row => row.botId === bot.id && row.enabled).at(-1)!;
  expect(effect).toBeDefined();
  const contentHash = JSON.parse(manifest(bot))["sample-skill"].scan.contentHash;
  expect(effect.acknowledged).toBe(mode === "owner" ? contentHash : undefined);
});

const issuerEvents=()=>{const path=join(fixture.info.dataDir,'fixture-owner-issuer.jsonl');return existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
const countEvents=()=>{const path=join(fixture.info.dataDir,'fixture-switch-counts.jsonl');return existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
function seedQueueHistory(){
  const path=join(fixture.info.dataDir,'decision-queues','skill.json'),saved=JSON.parse(readFileSync(path,'utf8'));
  saved.entries=saved.entries.filter((row:any)=>!row.item.ref.startsWith('fixture-history-'));
  for(let i=0;i<1024;i++){const id=`fixture-history-${i}`;saved.entries.push({state:'accepted',base:{approve:null,source:'no-grant'},item:{kind:'skill',ref:id,epoch:id,approvalId:id,proof:'history',view:{title:'History',subtitle:''},call:{tool:'stage_skill',input:{},approval:{queueRef:id,epoch:id,action:{requestId:id}}}}});}
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(1024*1024);writeFileSync(path,JSON.stringify(saved));
}
it.each([1,1024].flatMap(entries=>['turn_on','turn_off','delete'].map(action=>({entries,action}))))('B01 real HTTP phase budgets: $entries entries $action',async({entries,action})=>{
  const bot=await makeBot(),saved=JSON.parse(manifest(bot));saved['sample-skill'].enabled=action!=='turn_on';
  for(let i=1;i<entries;i++)saved[`sibling-${i}`]={...structuredClone(saved['sample-skill']),storageRevision:String(i).padStart(64,'0')};
  writeFileSync(manifestPath(bot),JSON.stringify(saved));
  const auth=await heldTurn(bot),rawHash=saved['sample-skill'].sha256;
  const check=(events:any[],validationCount:number,delivery=false)=>{
    const starts=events.filter(row=>row.kind==='phase');
    expect(starts.filter(row=>row.label==='validation')).toHaveLength(validationCount);
    expect(events.filter(row=>row.kind==='list'||row.kind==='scan')).toHaveLength(0);
    for(const start of starts){
      const rows=events.filter(row=>row.phase===start.phase),reads=rows.filter(row=>row.kind==='read'&&row.bytes>0);
      const target=reads.filter(row=>row.path.endsWith('/SKILL.md')),metadata=reads.filter(row=>!row.path.endsWith('/SKILL.md'));
      expect(new Set(target.map(row=>row.open)).size).toBeLessThanOrEqual(1);
      expect(target.reduce((n,row)=>n+row.bytes,0)).toBeLessThanOrEqual(256*1024+1);
      expect(new Set(metadata.filter(row=>row.path.endsWith('/skills.json')).map(row=>row.open)).size).toBeLessThanOrEqual(2);
      expect(metadata.every(row=>row.bytes<=1024*1024+1)).toBe(true);
      if(['validation','final'].includes(start.label))expect(rows.filter(row=>row.kind==='hash'&&row.digest===rawHash)).toHaveLength(2);
      if(start.label==='primitive')expect(rows.filter(row=>row.kind==='hash'&&row.digest===rawHash)).toHaveLength(1);
    }
    if(delivery){
      console.log('HTTP_DELIVERY_OBSERVER '+JSON.stringify({phases:starts.map(row=>row.label),writes:events.filter(row=>row.kind==='write').map(row=>({label:row.label,bytes:row.bytes}))}));
      const reads=events.filter(row=>row.kind==='read'&&row.bytes>0);
      expect(new Set(reads.filter(row=>row.path.endsWith('/SKILL.md')).map(row=>row.open)).size).toBeLessThanOrEqual(4);
      expect(new Set(reads.filter(row=>!row.path.endsWith('/SKILL.md')).map(row=>row.open)).size).toBeLessThanOrEqual(8);
      // MAIN RULING F §2.6: the cap is twelve; task discovery changes descendant writes. OPEN for GrokBuild.
      expect(events.filter(row=>row.kind==='write').length).toBeGreaterThanOrEqual(4);
      expect(events.filter(row=>row.kind==='write').length).toBeLessThanOrEqual(12);
      expect(events.filter(row=>row.kind==='write').every(row=>row.bytes<=1024*1024)).toBe(true);
    }
    console.log('HTTP_BUDGET '+JSON.stringify({entries,action,delivery,phases:starts.map(row=>row.label),targetReads:new Set(events.filter(row=>row.kind==='read'&&row.bytes>0&&row.path.endsWith('/SKILL.md')).map(row=>row.open)).size,writes:events.filter(row=>row.kind==='write').length}));
  };
  let offset=countEvents().length;
  const card=await proposed(bot,auth,action);check(countEvents().slice(offset),1);
  const message=(await switchCards(bot)).at(-1)!;
  for(let warm=0;warm<2;warm++){
    offset=countEvents().length;expect((await api('GET',`/api/threads/${bot.threadId}/skill-switch-review/${message.id}`)).status).toBe(200);
    check(countEvents().slice(offset),1);
  }
  offset=countEvents().length;expect((await answer(bot,card,'allow')).status).toBe(200);check(countEvents().slice(offset),1,true);
  const after=JSON.parse(manifest(bot));expect(action==='delete'?after['sample-skill']===undefined:after['sample-skill'].enabled=== (action==='turn_on')).toBe(true);
  for(let i=1;i<entries;i++)expect(after[`sibling-${i}`]).toEqual(saved[`sibling-${i}`]);
});
it.each(['content','metadata'])('B02 real HTTP caps bytes before reading oversized %s',async resource=>{
  const bot=await makeBot(),auth=await heldTurn(bot),path=resource==='content'?realpathSync(join(fixture.info.dataDir,'workspaces',bot.id,'skills','sample-skill','SKILL.md')):manifestPath(bot);
  const before=readFileSync(path),cap=resource==='content'?256*1024:1024*1024,offset=countEvents().length;
  try{
    writeFileSync(path,resource==='content'?md('sample-skill')+'x'.repeat(cap+4096):' '.repeat(cap+4096));
    const response=await requestSwitch(bot,auth,'turn_off'),reads=countEvents().slice(offset).filter(row=>row.kind==='read'&&row.path===path);
    const bytes=reads.reduce((n,row)=>n+row.bytes,0);console.log('HTTP_BYTE_CAP '+JSON.stringify({resource,bytes,cap,status:response.status}));
    expect(bytes).toBeLessThanOrEqual(cap+1);expect(response.status).toBe(409);expect(await switchCards(bot)).toHaveLength(0);
  }finally{writeFileSync(path,before);}
});
it('B03 real HTTP stale scans refuse instead of entering the unbudgeted scanner',async()=>{
  const bot=await makeBot();expect((await api('PATCH',`/api/bots/${bot.id}/skills/sample-skill`,{enabled:false})).status).toBe(200);
  const auth=await heldTurn(bot),saved=JSON.parse(manifest(bot));saved['sample-skill'].scan.scannerVersion=0;writeFileSync(manifestPath(bot),JSON.stringify(saved));
  const before=manifest(bot),offset=countEvents().length,response=await requestSwitch(bot,auth,'turn_on');
  if(response.status===201){const card=(await switchCards(bot)).at(-1)!.card;await answer(bot,card,'allow');}
  const scans=countEvents().slice(offset).filter(row=>row.kind==='scan').length;console.log('HTTP_SCANNER_CAP '+JSON.stringify({scans,limit:0,status:response.status}));
  expect(scans).toBe(0);expect(manifest(bot)).toBe(before);expect(response.status).toBe(409);expect(await switchCards(bot)).toHaveLength(0);
});
it('B04 real HTTP upgrade selects indexed candidates and releases proofs without population scans',async()=>{
  const pending:any[]=[];
  for(let i=0;i<40;i++){
    const bot=await makeBot(),auth=await heldTurn(bot);await proposed(bot,auth,'turn_off');pending.push(bot);
    const dump=JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'));if(i===39)break;
    writeFileSync(join(fixture.fixtureFinishGateDir,String(dump.pid)),'1');
    await expect.poll(()=>{try{process.kill(dump.pid,0);return false;}catch{return true;}},{timeout:20_000}).toBe(true);
    await expect.poll(()=>countEvents().some(row=>row.kind==='retirement'&&row.botId===bot.id),{timeout:20_000}).toBe(true);
  }
  const bot=pending[0],offset=countEvents().length;
  const last=JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'));writeFileSync(join(fixture.fixtureFinishGateDir,String(last.pid)),'1');
  await expect.poll(()=>countEvents().slice(offset).some(row=>row.kind==='retirement'&&row.botId===pending[39].id),{timeout:20_000}).toBe(true);
  expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  await expect.poll(()=>countEvents().slice(offset).filter(row=>row.kind==='selection').length,{timeout:20_000}).toBeGreaterThan(0);
  const selected=countEvents().slice(offset).filter(row=>row.kind==='selection').map(row=>row.count);console.log('HTTP_INDEX_SELECTION '+JSON.stringify({candidates:selected}));expect(selected.every(count=>count<=17)).toBe(true);
  await expect.poll(()=>JSON.parse(readFileSync(join(fixture.info.dataDir,'decision-queues','skill.json'),'utf8')).entries.some((row:any)=>row.item.call.approval.action.skillRequest?.botId===bot.id&&row.state==='accepted'),{timeout:20_000}).toBe(true);
  await expect.poll(async()=>(await switchCards(bot)).filter(row=>!row.card.answered&&!row.card.dismissed).length,{timeout:20_000}).toBe(0);
  const events=countEvents().slice(offset),candidates=events.filter(row=>row.kind==='selection').map(row=>row.count),populations=events.filter(row=>row.kind==='population');
  console.log('HTTP_BATCH_CAP '+JSON.stringify({candidates,populations:populations.map(row=>row.count)}));
  expect(candidates.length).toBeGreaterThan(0);expect(candidates.every(count=>count<=17)).toBe(true);expect(populations).toHaveLength(0);
  expect(JSON.parse(manifest(bot))['sample-skill'].enabled).toBe(false);
},120_000);
it('B05 real HTTP accepted receipt survives near-capacity compaction and restored skill state',async()=>{
  const bot=await makeBot(),auth=await heldTurn(bot),before=manifest(bot),card=await proposed(bot,auth,'turn_off'),message=(await switchCards(bot)).at(-1)!;
  effectBaselines.set(bot.id,switchEffects(bot).length);expect((await answer(bot,card,'allow')).status).toBe(200);
  expect(switchEffects(bot)).toHaveLength(1);await fixture.stop();writeFileSync(manifestPath(bot),before);seedQueueHistory();await fixture.restart();
  const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};desktop={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
  const offset=countEvents().length,response=await api('GET',`/api/threads/${bot.threadId}/skill-switch-review/${message.id}?fixtureReplay=1&fixtureCompact=1`);
  console.log('HTTP_RECEIPT_CAP '+JSON.stringify({state:response.body.state,effects:switchEffects(bot).length,enabled:JSON.parse(manifest(bot))['sample-skill'].enabled}));
  expect(response).toMatchObject({status:200,body:{state:'already'}});expect(manifest(bot)).toBe(before);expect(switchEffects(bot)).toHaveLength(1);expect(countEvents().slice(offset).filter(row=>row.kind==='phase')).toHaveLength(0);
},90_000);
it.each(['C01','C02','C03','C04','C05'])('%s real server restart retains the original attempt fence',async point=>{
  const bot=await makeBot();expect((await api('PATCH',`/api/bots/${bot.id}/skills/sample-skill`,{enabled:false})).status).toBe(200);
  const auth=await heldTurn(bot);await proposed(bot,auth,'turn_on');
  const enginePid=Number(JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8')).pid);
  const stopEngine=()=>{if(Number.isInteger(enginePid)&&enginePid>1&&enginePid!==process.pid&&enginePid!==fixture.info.pid)try{process.kill(enginePid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const message=(await switchCards(bot)).at(-1)!,reviewPath=`/api/threads/${bot.threadId}/skill-switch-review/${message.id}`;
  const backup=join(fixture.info.dataDir,`fixture-crash-backup-${bot.id}`),workspace=join(fixture.info.dataDir,'workspaces',bot.id),state=join(fixture.info.dataDir,'skill-state',bot.id);
  mkdirSync(backup);cpSync(workspace,join(backup,'workspace'),{recursive:true});cpSync(state,join(backup,'state'),{recursive:true});
  effectBaselines.set(bot.id,switchEffects(bot).length);
  const marker=join(fixture.info.dataDir,'fixture-crash-point.json');writeFileSync(marker,JSON.stringify({point,botId:bot.id}));
  try{
    if(point==='C03'){
      expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
      await expect.poll(async()=>switchEffects(bot).filter(row=>row.enabled).length,{timeout:20_000}).toBe(1);
      expect((await api('PATCH',`/api/bots/${bot.id}/skills/sample-skill`,{enabled:false})).status).toBe(200);
      const live=await api('GET',reviewPath+'?fixtureReplay=1');
      console.log('SERVER_LIVE_RETRY '+JSON.stringify({point,state:live.body.state,effects:switchEffects(bot).filter(row=>row.enabled).length}));
      expect(switchEffects(bot).filter(row=>row.enabled)).toHaveLength(1);
      expect(live).toMatchObject({status:200,body:{state:'unconfirmed'}});
    }else{
      await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true}).catch(()=>undefined);
      await expect.poll(()=>fixture.child.exitCode,{timeout:20_000}).toBe(point==='C01'?71:point==='C04'?74:72);
    }
    evidence.push({point,logPath:fixture.info.logPath,serverLog:readFileSync(fixture.info.logPath,'utf8')});
    if(existsSync(marker))unlinkSync(marker);stopEngine();await fixture.stop();
    if(point==='C05')seedQueueHistory();
    await removeTempDir(workspace);await removeTempDir(state);cpSync(join(backup,'workspace'),workspace,{recursive:true});cpSync(join(backup,'state'),state,{recursive:true});
    const before=countEvents().length;await fixture.restart();
    const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};desktop={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
    const replay=await api('GET',reviewPath+'?fixtureReplay=1'),enabled=JSON.parse(manifest(bot))['sample-skill'].enabled;
    console.log('SERVER_CRASH_WITNESS '+JSON.stringify({point,state:replay.body.state,enabled,effects:switchEffects(bot).filter(row=>row.enabled).length,acknowledgements:switchEffects(bot).filter(row=>row.enabled&&row.acknowledged).length}));
    expect(enabled).toBe(false);
    expect(switchEffects(bot).filter(row=>row.enabled)).toHaveLength(point==='C01'?0:1);
    expect(switchEffects(bot).filter(row=>row.enabled).every(row=>row.acknowledged===undefined)).toBe(true);
    expect(replay).toMatchObject({status:200,body:{state:point==='C04'?'already':'unconfirmed'}});
    expect(countEvents().slice(before).filter(row=>row.kind==='phase')).toHaveLength(0);
    expect((await switchCards(bot)).filter(row=>!row.card.answered&&!row.card.dismissed)).toHaveLength(0);
  }finally{
    if(existsSync(marker))unlinkSync(marker);stopEngine();
    evidence.push({point,finalLogPath:fixture.info.logPath,serverLog:readFileSync(fixture.info.logPath,'utf8')});
    await fixture.close();bots.length=0;await startSkillFixture();
  }
},90_000);
const insertionCount=()=>issuerEvents().filter(row=>row.stage==='insert').length;
const effectBaselines=new Map<string,number>();
const switchEffects=(bot:any)=>{const path=join(fixture.info.dataDir,'fixture-switch-effects.jsonl');return existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.botId===bot.id).slice(effectBaselines.get(bot.id)??0):[];};
async function reviewProposal(action='turn_on'){
  const bot=await makeBot();const saved=JSON.parse(manifest(bot));
  saved['sample-skill'].enabled=action!=='turn_on';saved['sample-skill'].scan.verdict='review';
  writeFileSync(manifestPath(bot),JSON.stringify(saved));
  const auth=await heldTurn(bot),card=await proposed(bot,auth,action),message=(await switchCards(bot)).at(-1)!;
  effectBaselines.set(bot.id,switchEffects(bot).length);
  return {bot,auth,card,path:`/api/threads/${bot.threadId}/skill-switch-review/${message.id}`};
}
function assertNoOwnerExecution(bot:any,card:any,count:number){
  console.log('ISSUER_BOUNDARY '+JSON.stringify({insertions:insertionCount()-count,primitiveCalls:switchEffects(bot).length}));
  expect(insertionCount()).toBe(count);expect(switchEffects(bot)).toHaveLength(0);
  const path=join(fixture.info.dataDir,'decisions.ndjson');
  const audit=existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  expect(audit.filter(row=>row.requestId===card.requestId&&row.decision==='user-approved')).toHaveLength(0);
}
it('RED_owner_racing_no_limits_cannot_use_missing_origin',async()=>{
  const f=await reviewProposal(),count=insertionCount(),before=manifest(f.bot);
  expect((await api('GET',f.path+'?fixturePosture=no-limits')).status).toBe(200);
  expect((await switchCards(f.bot)).filter(row=>!row.card.answered&&!row.card.dismissed)).toHaveLength(1);
  const queued=JSON.parse(readFileSync(join(fixture.info.dataDir,'decision-queues','skill.json'),'utf8')).entries.find((row:any)=>row.item.call.approval.action.skillRequest?.botId===f.bot.id);
  const proof=queued.item.proof,db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'));db.exec('PRAGMA busy_timeout=1000');let removed=0;
  try{for(const row of db.prepare('SELECT key FROM decision_continuations').all()){try{const key=JSON.parse(String(row.key));if(key.kind==='background-job'&&key.id===proof.id&&key.botId===proof.botId&&key.threadId===proof.threadId)removed+=Number(db.prepare('DELETE FROM decision_continuations WHERE key=?').run(String(row.key)).changes);}catch{}}}finally{db.close();}
  expect(removed).toBe(1);
  const result=await answer(f.bot,f.card,'allow');assertNoOwnerExecution(f.bot,f.card,count);expect(result.status).toBe(409);expect(manifest(f.bot)).toBe(before);
});
it.each(['deny','wipe'])('RED_automatic_cannot_bypass_protected_skill_card %s',async why=>{
  const bot=await makeBot(),auth=await heldTurn(bot),card=await proposed(bot,auth,'turn_off'),message=(await switchCards(bot)).at(-1)!,path=`/api/threads/${bot.threadId}/skill-switch-review/${message.id}`;
  expect((await api('GET',path+'?fixturePosture=no-limits')).status).toBe(200);
  const queued=JSON.parse(readFileSync(join(fixture.info.dataDir,'decision-queues','skill.json'),'utf8')).entries.find((row:any)=>row.item.call.approval.action.skillRequest?.botId===bot.id);
  const db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'));db.exec('PRAGMA busy_timeout=1000');try{expect(Number(db.prepare('UPDATE approval_records SET why=? WHERE id=?').run(why,queued.item.approvalId).changes)).toBe(1);}finally{db.close();}
  const before=manifest(bot),count=insertionCount();effectBaselines.set(bot.id,switchEffects(bot).length);
  const result=await api('GET',path+'?fixtureReplay=1');assertNoOwnerExecution(bot,card,count);expect(manifest(bot)).toBe(before);expect(result).toMatchObject({status:200,body:{state:'not-run'}});
});
it('I01 RED_preview_get_cannot_issue_owner_token',async()=>{
  const f=await reviewProposal(),before=manifest(f.bot),count=insertionCount();
  const review=await api('GET',f.path);
  expect((await api('GET',f.path+'?fixtureIssuer=preview')).status).toBe(200);
  expect(review.status).toBe(200);expect(review.body.request.verdictHash).toBe(f.card.skillRequest.verdictHash);
  expect(review.body.request.findings).toEqual(expect.any(Array));
  assertNoOwnerExecution(f.bot,f.card,count);
  expect(await api('GET',f.path+'?fixtureBoundary=1')).toMatchObject({status:200,body:{state:'not-run'}});
  expect(manifest(f.bot)).toBe(before);assertNoOwnerExecution(f.bot,f.card,count);
});
it('I02 RED_bulk_and_fallback_cannot_issue_owner_token',async()=>{
  const f=await reviewProposal(),count=insertionCount(),before=manifest(f.bot);
  const preview=await api('POST','/api/inbox/approve-all/preview',{thread:{threadId:f.bot.threadId,requestIds:[f.card.requestId]}});
  expect(preview.status).toBe(200);expect(preview.body.eligible).toHaveLength(0);
  // Seed only the normally excluded selection; the real apply loop and per-card responder keep bulk identity.
  const seeded=await api('GET',f.path+'?fixtureBulkSeed=1');expect(seeded.status).toBe(200);
  const applied=await api('POST','/api/inbox/approve-all/apply',{batchId:seeded.body.batchId,requestIds:[f.card.requestId]});
  // MAIN RULING F I02: real bulk recheck reports needs-look before its special-card fence; OPEN for GrokBuild.
  expect(applied).toMatchObject({status:200,body:{approved:0,results:[{requestId:f.card.requestId,result:'skipped',reason:'not-eligible:needs-look'}]}});
  assertNoOwnerExecution(f.bot,f.card,count);
  for(const kind of ['bulk','bulk-fallback']){
    expect((await api('GET',f.path+'?fixtureIssuer='+kind)).status).toBe(200);
    expect(issuerEvents()).toContainEqual(expect.objectContaining({kind,stage:'guard'}));
    assertNoOwnerExecution(f.bot,f.card,count);
  }
  expect(manifest(f.bot)).toBe(before);
});
it('I03 RED_permission_upgrade_cannot_issue_owner_token',async()=>{
  const f=await reviewProposal(),count=insertionCount(),before=manifest(f.bot);
  expect((await api('GET',f.path+'?fixtureIssuer=level-upgrade')).status).toBe(200);
  expect((await raiseLevel(api,f.bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  await expect.poll(async()=> (await switchCards(f.bot)).filter(row=>!row.card.answered&&!row.card.dismissed).length).toBe(0);
  expect(manifest(f.bot)).toBe(before);assertNoOwnerExecution(f.bot,f.card,count);
});
it.each(['missing-session','revoked-session'])('I04 RED_authorized_surface_without_session_binding_cannot_issue %s',async mode=>{
  const f=await reviewProposal(),count=insertionCount(),before=manifest(f.bot),guards=issuerEvents().length;
  const result=await api('POST',`/api/threads/${f.bot.threadId}/respond`,{requestId:f.card.requestId,behavior:'allow',reviewedSha256:f.card.skillRequest.sha256,
    reviewedVerdictHash:f.card.skillRequest.verdictHash},{...desktop,'x-fixture-issuer-mode':mode});
  assertNoOwnerExecution(f.bot,f.card,count);expect(result.status).toBe(409);expect(issuerEvents().length).toBeGreaterThan(guards);
  expect(manifest(f.bot)).toBe(before);
});
it.each(['fresh-failed','fresh-missing','endpoint-fresh-failed'])('I05 RED_failed_required_fresh_auth_cannot_issue %s',async mode=>{
  const f=await reviewProposal(),count=insertionCount(),before=manifest(f.bot),guards=issuerEvents().length;
  const result=await api('POST',`/api/threads/${f.bot.threadId}/respond`,{requestId:f.card.requestId,behavior:'allow',reviewedSha256:f.card.skillRequest.sha256,
    reviewedVerdictHash:f.card.skillRequest.verdictHash,freshAuth:{digest:'wrong-digest'}},{...desktop,'x-fixture-issuer-mode':mode});
  assertNoOwnerExecution(f.bot,f.card,count);
  expect(result.status).toBe(mode==='endpoint-fresh-failed'?403:409);
  if(mode!=='endpoint-fresh-failed')expect(issuerEvents().length).toBeGreaterThan(guards);
  expect(manifest(f.bot)).toBe(before);assertNoOwnerExecution(f.bot,f.card,count);
});
it('RED_upgrade_matching_review_snapshot_never_runs endpoint',async()=>{
  const f=await reviewProposal(),before=manifest(f.bot),count=insertionCount();
  expect((await raiseLevel(api,f.bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  await expect.poll(async()=> (await switchCards(f.bot)).filter(row=>!row.card.answered&&!row.card.dismissed).length).toBe(0);
  expect(manifest(f.bot)).toBe(before);assertNoOwnerExecution(f.bot,f.card,count);
});
it('RED_upgrade_matching_review_snapshot_never_runs registered acceptor boundary',async()=>{
  const f=await reviewProposal(),before=manifest(f.bot);
  const result=await api('GET',f.path+'?fixtureBoundary=1');
  console.log('M01_BOUNDARY '+JSON.stringify({state:result.body.state,enabled:JSON.parse(manifest(f.bot))['sample-skill'].enabled,primitiveCalls:switchEffects(f.bot).length,acknowledged:switchEffects(f.bot).at(-1)?.acknowledged,scanHash:JSON.parse(manifest(f.bot))['sample-skill'].scan.contentHash}));
  expect(result).toMatchObject({status:200,body:{state:'not-run'}});
  expect(manifest(f.bot)).toBe(before);expect(switchEffects(f.bot)).toHaveLength(0);
});
it.each(['turn_on','turn_off','delete'])('RED_upgrade_clean_to_review_same_hashes_never_runs %s',async action=>{
  const bot=await makeBot();if(action==='turn_on')expect((await api('PATCH',`/api/bots/${bot.id}/skills/sample-skill`,{enabled:false})).status).toBe(200);
  const auth=await heldTurn(bot),card=await proposed(bot,auth,action);effectBaselines.set(bot.id,switchEffects(bot).length);const saved=JSON.parse(manifest(bot)),count=insertionCount();
  saved['sample-skill'].scan.verdict='review';writeFileSync(manifestPath(bot),JSON.stringify(saved));const before=manifest(bot);
  expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  await expect.poll(async()=> (await switchCards(bot)).filter(row=>!row.card.answered&&!row.card.dismissed).length).toBe(0);
  expect(manifest(bot)).toBe(before);assertNoOwnerExecution(bot,card,count);
});
it('RED_setup_waits_no_limits_runs_now',async()=>{
  const now=await makeBot();expect((await raiseLevel(api,now.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  const nowAuth=await heldTurn(now);expect((await requestSwitch(now,nowAuth)).body.autoApproved).toBe(true);
  expect((await skills(now))[0].enabled).toBe(false);expect(await switchCards(now)).toHaveLength(0);
  const later=await makeBot();expect((await raiseLevel(api,later.id,{fullAccess:true,acknowledgeFullAccess:true,fullAccessSetupRequests:true})).status).toBe(200);
  const laterAuth=await heldTurn(later);expect((await requestSwitch(later,laterAuth)).body.startsWhen).toBe('reply-ends');
  expect((await skills(later))[0].enabled).toBe(true);
  const dump=JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'));writeFileSync(join(fixture.fixtureFinishGateDir,String(dump.pid)),'1');
  await expect.poll(async()=>(await skills(later))[0].enabled,{timeout:30_000}).toBe(false);
});

it.each(["MCP summary", "skill review"])("paired device proxy admits the private %s while the browser refuses", async kind => {
  const bot = await makeBot();
  const auth = kind === "skill review" ? await heldTurn(bot) : undefined;
  if (auth) await proposed(bot, auth);
  const path = auth
    ? `/api/threads/${bot.threadId}/skill-switch-review/${(await switchCards(bot)).at(-1)!.id}`
    : `/api/bots/${bot.id}/mcp-servers`;
  const options = { harnessPort: Number(new URL(fixture.info.url).port), companionToken };
  const devices: BrowserDeviceStore = {
    redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null,
    signOutDevice: () => null, issuePushTokens: () => null, pushBinding: () => null, approvalIdentity: () => null,
    authenticatePush: () => null, resolveSession: value => value === "paired-session" ? {
      device: { id: "paired", name: "Fixture", cloudDesktopAccess: false },
      session: { expiresAt: Date.now() + 60_000 }, sessionId: "paired-session-record",
    } : null,
    sessionDeadline: () => Date.now() + 60_000,
  };
  const device = createServer(createProxyHandler({
    ...options, authenticate: value => value === "paired-bearer" ? { id: "paired", cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "unused" }), serverName: () => "Fixture",
  }));
  const browser = createServer(createBrowserHandler({
    ...options, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
  }));
  async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  try {
    const [deviceUrl, browserUrl] = await Promise.all([listen(device), listen(browser)]);
    const read = await fetch(deviceUrl + path, { headers: { authorization: "Bearer paired-bearer" } });
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.json()).toMatchObject(auth
      ? { request: { preview: expect.stringContaining("Read supplied notes.") } }
      : { servers: expect.any(Array) });
    const refused = await fetch(browserUrl + path, { headers: {
      origin: browserUrl, cookie: `${cookieName("http")}=paired-session`, "x-murage-companion-token": companionToken,
    } });
    expect([403, 404]).toContain(refused.status);
    expect(await refused.text()).not.toContain("Read supplied notes.");
  } finally {
    await Promise.all([device, browser].map(server => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  }
}, 90_000);
