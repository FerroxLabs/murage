import { evidencePath } from '../scripts/evidence-path.mjs';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string,string> = {};
let bot: {id:string; threadId:string};
const observations: unknown[] = [];
async function api(method:string,path:string,body?:unknown) {
  const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const result = {status:response.status,body:await response.json() as any};
  if (path !== "/api/desktop-secret") {
    const observation = {method,path,body,result};
    if (JSON.stringify(observations.at(-1)) !== JSON.stringify(observation)) observations.push(observation);
  }
  return result;
}
beforeAll(async()=>{
  fixture=await launchVerificationServer({});
  const proof=await api("GET","/api/desktop-secret");
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
  const engines=(await api("GET","/api/instances")).body.instances;
  const model=engines.find((engine:any)=>engine.instanceId==="verification").models.options[0].id;
  const created=await api("POST","/api/bots",{name:"L8 scoped stop fixture",modelSelection:{instanceId:"verification",model}});
  expect(created.status).toBe(201); bot=created.body.bot;
  expect((await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false})).status).toBe(200);
},60_000);
afterAll(async()=>{
  const evidence = evidencePath("evidence/r20-l8main-runtime"); mkdirSync(evidence, {recursive:true});
  writeFileSync(join(evidence, "http-observations.json"), JSON.stringify(observations, null, 2));
  if (fixture && existsSync(fixture.info.logPath)) copyFileSync(fixture.info.logPath, join(evidence, "server.log"));
  await fixture?.close();
});

const scoped={contract:1,actionId:"action",threadId:"thread",sendId:"send",attemptId:"attempt",receiptRevision:1,bindingEpoch:1,turnId:"turn"};
it.each([
  {turnId:"foreign"}, {attemptId:"attempt"}, {sendId:"send"}, {actionId:"action"},
  {receiptRevision:1}, {bindingEpoch:1}, {contract:1},
  {...scoped,all:true}, {...scoped,turnId:[]}, {...scoped,attemptId:""},
  {...scoped,receiptRevision:-1}, {...scoped,bindingEpoch:1.2},
  {...scoped,turnId:"x".repeat(513)}, {...scoped,contract:2},
])("STOP-MALFORMED: rejects scoped input before any broad Stop: %j",async body=>{
  const result=await api("POST",`/api/bots/${bot.id}/interrupt`,body);
  expect(result).toMatchObject({status:400,body:{code:"bad_scope"}});
});

it("STOP-MALFORMED/SIBLINGS: a partial scoped request leaves a real provider turn running",async()=>{
  const text="__fixture_hold_authority__ L8 scope must not stop this turn";
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text})).status).toBe(202);
  await expect.poll(()=>existsSync(fixture.fixtureDumpPath)&&readFileSync(fixture.fixtureDumpPath,"utf8").includes(text),{timeout:20_000}).toBe(true);
  try {
    const result=await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId,turnId:"foreign"});
    expect(result).toMatchObject({status:400,body:{code:"bad_scope"}});
    const bots=(await api("GET","/api/bots?messages=0")).body.bots;
    expect(bots.find((row:any)=>row.id===bot.id).busy).toBe(true);
  } finally {
    // Existing broad Stop remains the explicit cleanup action.
    expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId})).status).toBe(200);
  }
},45_000);

it("ISO-11 / STATE-1: Help is a durable isolated queued receipt behind a held turn", async () => {
  const held = "__fixture_hold_authority__ L8 existing work";
  const sendId = "l8-help-queued-send";
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: held, sendId: "l8-held-before-help" })).status).toBe(202);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(held), { timeout: 20_000 }).toBe(true);
  let queueId: string | undefined;
  try {
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "L8 Help question", sendId, noSteer: true });
    expect(sent).toMatchObject({ status: 202, body: { queued: true } });
    queueId = sent.body.queueId;
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), {readOnly:true});
    try { expect(db.prepare("SELECT isolated,queue_only FROM send_attempts WHERE send_id=?").get(sendId)).toEqual({isolated:1,queue_only:1}); } finally { db.close(); }
    const state = await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`);
    expect(state).toMatchObject({ status: 200, body: { contract: 1, sendId, state: "queued", delivery: "not_submitted", actions: { remove: true, stop: false } } });
    expect(state.body.attemptId).toBeTypeOf("string");
    expect(state.body.queueId).toBe(sent.body.queueId);
  } finally {
    if (queueId) await api("DELETE", `/api/bots/${bot.id}/queue/${queueId}`);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}, 45_000);

it("STATE-1: foreign thread and stale turn hint cannot change the send being followed", async () => {
  const result = await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=l8-not-present-send&turnId=foreign`);
  expect(result).toMatchObject({ status: 200, body: { sendId: "l8-not-present-send", attemptId: null, state: "unknown", turnId: null } });
  expect((await api("GET", `/api/bots/${bot.id}/turn-state?threadId=foreign-thread&sendId=l8-not-present-send`)).status).toBe(404);
});

it("F7-CRASH / F7-ML3: a failed receipt survives restart and retry without another provider input", async () => {
  const sendId = "l8-failed-restart", text = "__fixture_fail_turn__ L8 immutable receipt";
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId, noSteer: true })).status).toBe(202);
  await expect.poll(async () => (await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`)).body.terminalOutcome, { timeout: 30_000 }).toBe("failed");
  const before = (await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`)).body;
  await fixture.restart();
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const retry = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId });
  expect(retry.body).toMatchObject({ ok: false, existing: true, receipt: { attemptId: before.attemptId } });
  const after = (await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`)).body;
  expect(after).toMatchObject({ attemptId: before.attemptId, terminalOutcome: "failed", state: "submitted_but_failed" });
}, 65_000);

it("STOP-RESULT: a scoped Stop returns its durable result and a retry cannot stop a sibling", async () => {
  const engine = (await api("GET", "/api/instances")).body.instances.find((row:any)=>row.instanceId==="verification");
  const created = await api("POST", "/api/bots", {name:"L8 Stop identity fixture", modelSelection:{instanceId:"verification",model:engine.models.options[0].id}});
  expect(created.status).toBe(201); bot=created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, {computer:"off",browser:false,composio:false})).status).toBe(200);
  const sendId = "l8-scoped-running";
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ L8 exact scoped target", sendId, noSteer: true });
  expect(sent.status).toBe(202);
  let target: any;
  await expect.poll(async () => { target = (await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`)).body; return target.state; }, { timeout: 20_000 }).toBe("running");
  const body = { contract: 1, actionId: "l8-stop-press", threadId: bot.threadId, sendId, attemptId: target.attemptId, receiptRevision: target.receiptRevision, bindingEpoch: target.bindingEpoch, turnId: target.turnId };
  const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, body);
  expect(stopped).toMatchObject({ status: 200, body: { ok: true, matched: true, stopped: true, unconfirmed: false, actionId: body.actionId, receipt: { attemptId: target.attemptId, state: "stopped" } } });
  const siblingId = "l8-scoped-sibling-new";
  expect((await api("POST", `/api/bots/${bot.id}/messages`, {threadId:bot.threadId, text:"__fixture_hold_authority__ L8 replacement must survive", sendId:siblingId, noSteer:true})).status).toBe(202);
  try {
    await expect.poll(async()=> (await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${siblingId}`)).body.state, {timeout:20_000}).toBe("running");
    expect(await api("POST", `/api/bots/${bot.id}/interrupt`, body)).toEqual(stopped);
    expect((await api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${siblingId}`)).body.state).toBe("running");
  } finally { await api("POST", `/api/bots/${bot.id}/interrupt`, {threadId:bot.threadId}); }
}, 60_000);

async function failedRoom(suffix: string) {
  const { SendStore } = await import("./send-store.ts");
  const { sendFingerprint } = await import("./send-idempotency.ts");
  const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
  const result = await api("POST", "/api/groups", { name: `L8 receipts ${suffix}`, memberIds: bots.map((row:any)=>row.id), setup: {bulletin:"",defaultResponder:{kind:"member",botId:bot.id}} });
  expect(result.status).toBe(201);
  const group = result.body.group, text = `L8 room failed words ${suffix}`, sendId = `l8-room-failed-${suffix}`;
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), {timeout:5000});
  try {
    const sends = new SendStore(()=>db);
    const row = sends.accept({kind:"group",ownerId:group.id,threadId:group.threadId,sendId,text,fingerprint:sendFingerprint(text,undefined,"chat"),mode:"chat",status:"refused",notice:"refused",origin:"desktop"}).row;
    const receipt = sends.attemptFor(row)!;
    // No provider exists for a refusal at acceptance; it owns no cleanup.
    const binding = sends.bindingFor(row)!;
    sends.attempts()!.flushEffects(group.threadId,binding.generation,()=>{});
    return {group,text,sendId,receipt};
  } finally {db.close();}
}

it("F7-ML1-GROUP-SAMEID: a room route returns its immutable failed receipt", async()=>{
  const f=await failedRoom("sameid");
  const retry=await api("POST",`/api/groups/${f.group.id}/messages`,{threadId:f.group.threadId,text:f.text,sendId:f.sendId});
  expect(retry).toMatchObject({status:202,body:{ok:false,existing:true,receipt:{attemptId:f.receipt.attemptId,state:"refused"}}});
});

it("F7-GROUP-RESEND: a recorded room action creates exactly one replacement",async()=>{
  const f=await failedRoom("action");
  const action={contract:1,kind:"resend",actionId:"l8-room-action-press",replacementSendId:"l8-room-replacement-send",threadId:f.group.threadId,sendId:f.sendId,attemptId:f.receipt.attemptId,receiptRevision:f.receipt.revision,bindingEpoch:f.receipt.bindingEpoch,confirmDuplicate:false};
  const first=await api("POST",`/api/groups/${f.group.id}/send-actions`,action);
  expect(first).toMatchObject({status:202,body:{actionId:action.actionId,replacementSendId:action.replacementSendId,receipt:{contract:1,sendId:action.replacementSendId}}});
  const retry=await api("POST",`/api/groups/${f.group.id}/send-actions`,action);
  expect(retry.body.replacementAttemptId).toBe(first.body.replacementAttemptId);
});
