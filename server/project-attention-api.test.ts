// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
let ids: { owner: string; pair: string; task: string };
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {observeVerifiedHuman,linkHumanBinding,resolveHumanBinding,humanTask}=await import(${JSON.stringify(new URL("./human-principals.ts", import.meta.url).href)});
    const {ownerMemoryTicket}=await import(${JSON.stringify(new URL("./memory/authority.ts", import.meta.url).href)});
    const {getOrCreateChannel}=await import(${JSON.stringify(new URL("./comms-visibility.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Attention fixture'},{seedMessages:false}), peer=store.createBot({name:'Peer fixture'},{seedMessages:false});
    const owner=store.createGroup('Owner room',[bot.id,peer.id],false,undefined,{completed:true});
    const task=store.createGroupTask(owner.id,'Background',false);
    store.appendMessage(task.threadId,{role:'bot',kind:'text',text:'One result'});
    store.appendMessage(task.threadId,{role:'bot',kind:'activity',text:'Tool noise'});
    const bindingId=observeVerifiedHuman({platform:'slack',authorityId:'fixture',connectionId:'fixture',userId:'contact'});
    linkHumanBinding(ownerMemoryTicket(),{bindingId,expectedRevision:1,as:'person'});
    const personTask=humanTask(store,bot.id,resolveHumanBinding(bindingId));
    const pair=getOrCreateChannel(store,bot,peer,personTask.threadId);
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'attention-fixture.json'),JSON.stringify({owner:owner.id,pair:pair.id,task:task.threadId}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "attention-fixture.json"), "utf8"));
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("hydrates the read-only reason only for a contact-bound room", async () => {
  const response = await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers });
  expect(response.status).toBe(200);
  const { groups } = await response.json() as { groups: Array<{ id: string; readOnlyReason?: string }> };
  expect(groups.find(group => group.id === ids.owner)).not.toHaveProperty("readOnlyReason");
  expect(groups.find(group => group.id === ids.pair)?.readOnlyReason).toBe("This is a channel person’s delegated conversation. Start an owner room to send a message.");
});
it("projects durable unread counts and resets through the existing switch route", async () => {
  const { groups } = await (await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers })).json() as { groups: Array<{ id: string; tasks: Array<{ threadId: string; unreadCount?: number }> }> };
  expect(groups.find(group => group.id === ids.owner)?.tasks.find(task => task.threadId === ids.task)?.unreadCount).toBe(1);
  const response = await fetch(`${fixture.info.url}/api/groups/${ids.owner}/tasks/${ids.task}?messages=0`, { method: "POST", headers });
  expect(response.status).toBe(200);
  const { group } = await response.json() as { group: { tasks: Array<{ threadId: string; unreadCount?: number }> } };
  expect(group.tasks.find(task => task.threadId === ids.task)?.unreadCount).toBe(0);
});
