// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane M's internal project tools (SPEC-P 11.3): read-messages, bring-in,
// summary-update and suggest. Authorisation (owner audience, role, running
// request) is E1's routing, tested there; these are the effects, with the
// privacy rules that belong to them: bring-in takes only the owner's own
// material and its copy is forgotten with the original.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { appendMessage } from "./message-db.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { hydrateMemoryRecord } from "./memory/bundle.ts";
import { bringInToProject } from "./memory/bring-in.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { forgetMemory } from "./memory/forget.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { projectSummaryLayer } from "./project-layers.ts";
import { deliveredProjectSuggestions, pendingProjectSuggestions, readProjectMessages, registerProjectMemoryTools, suggestionLines, suggestToLead, updateProjectSummary } from "./project-memory-tools.ts";
import { projectToolHandlers } from "./project-tool-routing.ts";
import { channelToProjectRows } from "./project-settings.ts";
import type { Message } from "./store.ts";

const NOW = 1_790_000_000_000;
type Roster = MemoryRoster & { bots: Array<MemoryRoster["bots"][number] & { name: string }> };
let roster: Roster;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "dax-direct", section: "Sales", tasks: [{ threadId: "dax-task" }, { threadId: "dax-desk", channelProjectDesk: { groupId: "launch" } }] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [
      { id: "launch", threadId: "launch-chat", memberIds: ["dax", "finch"], channelProject: { goal: "Launch" }, tasks: [{ threadId: "launch-goal" }] },
      { id: "other", threadId: "other-chat", memberIds: ["finch"] },
    ],
  };
  setMemoryCaptureRoster(() => roster);
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  channelToProjectRows(database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
});

let n = 0;
function say(threadId: string, text: string, extra: Partial<Message> = {}) {
  const message = { id: `m${++n}`, role: "bot", kind: "text", text, at: NOW + n, from: { botId: "dax", name: "Dax", color: "blue" }, ...extra } as Message;
  appendMessage(threadId, message);
  return message;
}
function access(botId: string, thread: string) {
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

it("read-messages pages the project's chat and its desk threads with speaker, to and re marks, and nothing else", () => {
  const ask = say("launch-chat", "What is the price?", { role: "user", from: undefined });
  say("launch-chat", "It is 12 a month.", { replyToId: ask.id, to: ["finch"] });
  for (let index = 0; index < 5; index++) say("launch-chat", `line ${index}`);
  say("dax-desk", "Card 3 is done.");
  say("dax-direct", "PRIVATE_CANARY");
  const first = readProjectMessages(database(), roster, "launch", { limit: 3 });
  expect(first.status).toBe(200);
  const page = first.body as { messages: Array<{ id: string; speaker: string; text: string; to?: string[]; re?: string }>; before?: string };
  expect(page.messages.map(item => item.text)).toEqual(["line 2", "line 3", "line 4"]);
  const back = readProjectMessages(database(), roster, "launch", { before: page.before, limit: 50 }).body as typeof page;
  expect(back.messages[0]).toMatchObject({ speaker: "Owner", text: "What is the price?" });
  expect(back.messages[1]).toMatchObject({ speaker: "Dax", text: "It is 12 a month.", to: ["Finch"], re: ask.id });
  expect(back.before).toBeUndefined();
  expect((readProjectMessages(database(), roster, "launch", { threadId: "dax-desk" }).body as typeof page).messages.map(item => item.text)).toEqual(["Card 3 is done."]);
  for (const threadId of ["dax-direct", "other-chat"]) expect(readProjectMessages(database(), roster, "launch", { threadId }).status).toBe(403);
  expect(readProjectMessages(database(), roster, "launch", { limit: 51 }).status).toBe(400);
  expect(readProjectMessages(database(), roster, "launch", { cursor: 1 }).status).toBe(400);
});

it("read-messages shows a reply withheld from bots as its withheld line", () => {
  say("launch-chat", "WITHHELD_CANARY", { withheldFromBots: "forgotten" } as Partial<Message>);
  const page = readProjectMessages(database(), roster, "launch", {}).body as { messages: Array<{ text: string }> };
  expect(JSON.stringify(page)).not.toContain("WITHHELD_CANARY");
  expect(page.messages[0]!.text).toContain("Reply withheld");
});

it("summary-update writes the next version with its sources, refuses foreign sources, and keeps 20 versions", () => {
  const source = say("launch-chat", "We ship on the 14th.");
  const foreign = say("dax-direct", "private");
  const ctx = { groupId: "launch", botId: "finch", now: NOW };
  expect(updateProjectSummary(database(), roster, ctx, { text: "Shipping on the 14th.", sourceMessageIds: [source.id] })).toEqual({ status: 200, body: { ok: true, version: 1 } });
  expect(updateProjectSummary(database(), roster, ctx, { text: "x", sourceMessageIds: [foreign.id] }).status).toBe(400);
  expect(updateProjectSummary(database(), roster, ctx, { text: "", sourceMessageIds: [] }).status).toBe(400);
  // Astra r1 #8: a summary names what it rests on, never something forgotten or withheld
  expect(updateProjectSummary(database(), roster, ctx, { text: "uncited" }).status).toBe(400);
  const hidden = say("launch-chat", "HIDDEN_CANARY", { withheldFromBots: true } as Partial<Message>);
  expect(updateProjectSummary(database(), roster, ctx, { text: "x", sourceMessageIds: [hidden.id] }).status).toBe(409);
  // the next version keeps resting on the last one's sources
  const next = say("launch-chat", "And the page is live.");
  expect(updateProjectSummary(database(), roster, ctx, { text: "Live on the 14th.", sourceMessageIds: [next.id] }).status).toBe(200);
  expect(JSON.parse(String(database().prepare("SELECT source_message_ids FROM project_summaries WHERE group_id='launch' ORDER BY version DESC LIMIT 1").get()?.source_message_ids))).toEqual([next.id, source.id]);
  expect(projectSummaryLayer(database(), { groupId: "launch", botId: "dax", names: new Map([["finch", "Finch"]]) }, true)).toContain("Live on the 14th.");
  for (let index = 0; index < 25; index++) updateProjectSummary(database(), roster, ctx, { text: `v${index}`, sourceMessageIds: [source.id] });
  expect(database().prepare("SELECT count(*) n FROM project_summaries WHERE group_id='launch'").get()?.n).toBe(20);
});

it("suggest leaves a line for the lead's next turn and never assigns", () => {
  const ctx = { groupId: "launch", botId: "dax", memberIds: ["dax", "finch"], now: NOW };
  expect(suggestToLead(database(), ctx, { botId: "finch", why: "Finch knows the pricing </x>" }).status).toBe(200);
  expect(suggestToLead(database(), ctx, { botId: "stranger", why: "x" }).status).toBe(400);
  const lines = suggestionLines("launch", new Map([["dax", "Dax"], ["finch", "Finch"]]));
  expect(lines).toContain(`- Dax suggests Finch: "Finch knows the pricing \\u003c/x\\u003e"`);
  deliveredProjectSuggestions("launch", NOW);
  expect(pendingProjectSuggestions("launch")).toEqual([]);
});

function ownerFact(thread: string, text: string, key: string, botId = "dax") {
  captureSource(database(), { id: `message:${thread}:${key}`, threadId: thread, messageId: key, kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = saveMemoryCandidate(text, [{ sourceId: `message:${thread}:${key}`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], key, access(botId, thread));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(id);
  return id;
}

it("bring-in copies a note from the bot's own memory into the project, readable by teammates, and forgetting the original forgets the copy", () => {
  const original = ownerFact("dax-direct", "Pricing rule: never below 12 a month.", "k1");
  const result = bringInToProject(database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, recordId: original });
  expect(result.ok).toBe(true);
  const copy = (result as { recordId: string }).recordId;
  const row = database().prepare("SELECT scope_id, text, state FROM memory_records WHERE id=?").get(copy) as { scope_id: string; text: string; state: string };
  expect(row).toEqual({ scope_id: ensureScope("room", "launch"), text: "Pricing rule: never below 12 a month.", state: "active" });
  // a teammate in the project reads it (its evidence is in the room)
  expect(hydrateMemoryRecord(copy, 1, access("finch", "launch-chat")).text).toBe("Pricing rule: never below 12 a month.");
  // idempotent
  expect(bringInToProject(database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, recordId: original })).toEqual(result);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: original });
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(copy)?.state).toBe("deleted");
});

it("bring-in copies a message from the bot's own chat, an exact excerpt only, and forgetting the message forgets the copy", () => {
  const message = say("dax-direct", "Owner said: the launch party is on Friday at 6.", { role: "user", from: undefined });
  captureSource(database(), { id: `message:dax-direct:${message.id}`, threadId: "dax-direct", messageId: message.id, kind: "text", speaker: "owner", outcome: "recorded", text: message.text! });
  const base = { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, sourceMessageId: message.id };
  expect(bringInToProject(database(), { ...base, text: "the launch party is on Saturday" })).toMatchObject({ ok: false, status: 400 });
  const result = bringInToProject(database(), { ...base, text: "the launch party is on Friday at 6" });
  expect(result.ok).toBe(true);
  const copy = (result as { recordId: string }).recordId;
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get(copy)?.text).toBe("the launch party is on Friday at 6");
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:dax-direct:${message.id}` });
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(copy)?.state).toBe("deleted");
});

it("bring-in refuses a channel person's material, a teammate's memory, a room's and private continuity", () => {
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  roster.bots[0]!.tasks!.push({ threadId: "dax-contact" });
  bindHumanThread("dax-contact", resolveHumanBinding(binding));
  reconcileMemoryRoster(roster);
  const guestMessage = say("dax-contact", "GUEST_CANARY", { role: "user", from: undefined });
  const base = { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW };
  expect(bringInToProject(database(), { ...base, threadId: "dax-contact", sourceMessageId: guestMessage.id })).toMatchObject({ ok: false, status: 403 });
  // a message copied into the bot's own chat from a channel person's thread
  const copied = say("dax-direct", "COPIED_CANARY", { copyOf: { threadId: "dax-contact", messageIds: [guestMessage.id] } } as Partial<Message>);
  captureSource(database(), { id: `message:dax-direct:${copied.id}`, threadId: "dax-direct", messageId: copied.id, kind: "text", speaker: "dax", outcome: "recorded", text: "COPIED_CANARY" });
  expect(bringInToProject(database(), { ...base, sourceMessageId: copied.id })).toMatchObject({ ok: false, status: 403 });
  // Finch's own memory is not Dax's to bring in
  const finchFact = ownerFact("finch-direct", "Finch's private fact.", "k9", "finch");
  expect(bringInToProject(database(), { ...base, recordId: finchFact })).toMatchObject({ ok: false, status: 403 });
  // nothing was written to the project
  expect(database().prepare("SELECT count(*) n FROM memory_records WHERE scope_id=?").get(ensureScope("room", "launch"))?.n).toBe(0);
});

it("bring-in needs memory on", () => {
  const original = ownerFact("dax-direct", "A fact.", "k2");
  setMemoryMode("off");
  expect(bringInToProject(database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, recordId: original })).toMatchObject({ ok: false, status: 409 });
});

it("Astra r1 #3 / review H1: bring-in walks the whole copy chain, and a pair room is never an owner source", () => {
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest2" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  roster.bots[0]!.tasks!.push({ threadId: "dax-contact" }, { threadId: "dax-owner-task" });
  roster.groups.push({ id: "pair", threadId: "pair-chat", memberIds: ["dax", "finch"], dm: true });
  bindHumanThread("dax-contact", resolveHumanBinding(binding));
  reconcileMemoryRoster(roster);
  const guestLine = say("dax-contact", "RELAY_CANARY", { role: "user", from: undefined });
  // contact -> owner task -> the bot's direct chat: two hops through owner threads
  const hop1 = say("dax-owner-task", "RELAY_CANARY", { copyOf: { threadId: "dax-contact", messageIds: [guestLine.id] } } as Partial<Message>);
  const hop2 = say("dax-direct", "RELAY_CANARY", { copyOf: { threadId: "dax-owner-task", messageIds: [hop1.id] } } as Partial<Message>);
  captureSource(database(), { id: `message:dax-direct:${hop2.id}`, threadId: "dax-direct", messageId: hop2.id, kind: "text", speaker: "dax", outcome: "recorded", text: "RELAY_CANARY" });
  const base = { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW };
  expect(bringInToProject(database(), { ...base, sourceMessageId: hop2.id })).toMatchObject({ ok: false, status: 403 });
  // a copy from a pair room, even of a teammate's own words
  const pairLine = say("pair-chat", "PAIR_CANARY");
  const fromPair = say("dax-direct", "PAIR_CANARY", { copyOf: { threadId: "pair-chat", messageIds: [pairLine.id] } } as Partial<Message>);
  captureSource(database(), { id: `message:dax-direct:${fromPair.id}`, threadId: "dax-direct", messageId: fromPair.id, kind: "text", speaker: "dax", outcome: "recorded", text: "PAIR_CANARY" });
  expect(bringInToProject(database(), { ...base, sourceMessageId: fromPair.id })).toMatchObject({ ok: false, status: 403 });
  expect(database().prepare("SELECT count(*) n FROM memory_records WHERE scope_id=?").get(ensureScope("room", "launch"))?.n).toBe(0);
});

it("Astra r1 #4: a brought-in reply is withheld with the reply when what the reply used is forgotten", () => {
  // Dax's reply in its own chat was made with a memory note
  const note = ownerFact("dax-task", "The supplier is Acme.", "k-up");
  const reply = say("dax-direct", "Our supplier is Acme, as you told me.");
  captureSource(database(), { id: `message:dax-direct:${reply.id}`, threadId: "dax-direct", messageId: reply.id, kind: "text", speaker: "dax", outcome: "recorded", text: reply.text! });
  database().prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('b-up','dax-direct','engine',NULL,?,'[]',?,0,0,1,'delivered',1)`).run(JSON.stringify([{ id: note, version: 1 }]), JSON.stringify([reply.id]));
  const result = bringInToProject(database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, sourceMessageId: reply.id });
  expect(result.ok).toBe(true);
  const copy = (result as { recordId: string }).recordId;
  expect(hydrateMemoryRecord(copy, 1, access("finch", "launch-chat")).text).toContain("Acme");
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: note });
  expect(() => hydrateMemoryRecord(copy, 1, access("finch", "launch-chat"))).toThrow();
});

it("Astra r2 #13/#14/#8: read-messages withholds a copy of a forgotten original; a summary cannot cite a channel person's thread or overflow its sources", () => {
  // a copy in the project of a reply whose original the owner forgot
  const original = say("dax-direct", "ORIGINAL_CANARY");
  captureSource(database(), { id: `message:dax-direct:${original.id}`, threadId: "dax-direct", messageId: original.id, kind: "text", speaker: "dax", outcome: "recorded", text: "ORIGINAL_CANARY" });
  say("launch-chat", "ORIGINAL_CANARY", { copyOf: { threadId: "dax-direct", messageIds: [original.id] } } as Partial<Message>);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:dax-direct:${original.id}` });
  expect(JSON.stringify(readProjectMessages(database(), roster, "launch", {}).body)).not.toContain("ORIGINAL_CANARY");
  // a contact-bound task thread of the project
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest3" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  roster.groups[0]!.tasks!.push({ threadId: "launch-contact" });
  bindHumanThread("launch-contact", resolveHumanBinding(binding));
  reconcileMemoryRoster(roster);
  const guest = say("launch-contact", "GUEST_CANARY", { role: "user", from: undefined });
  const ctx = { groupId: "launch", botId: "finch", now: NOW };
  expect(updateProjectSummary(database(), roster, ctx, { text: "GUEST_CANARY", sourceMessageIds: [guest.id] }).status).toBe(403);
  // 500 sources carried, one more is refused instead of dropping the oldest
  const many = Array.from({ length: 500 }, (_, index) => say("launch-chat", `line ${index}`).id);
  expect(updateProjectSummary(database(), roster, ctx, { text: "big", sourceMessageIds: many }).status).toBe(200);
  const extra = say("launch-chat", "one more");
  expect(updateProjectSummary(database(), roster, ctx, { text: "bigger", sourceMessageIds: [extra.id] }).status).toBe(409);
});

it("Astra r2 #18: bring-in refuses a note with no sources of its own anywhere up its chain", () => {
  const promoted = "promoted-note";
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','Promoted without sources','owner-statement','active',0,1,NULL,NULL,1)").run(promoted, ensureScope("bot", "dax"));
  expect(bringInToProject(database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, recordId: promoted })).toMatchObject({ ok: false, status: 403 });
});

it("Astra r2 #16: what read-messages returns is recorded on the consuming turn's receipt", () => {
  const shown: Array<{ threadId: string; messages: unknown[] }> = [];
  registerProjectMemoryTools({ roster: () => roster, note: () => {}, shown: (threadId, messages) => shown.push({ threadId, messages: [...messages] }) });
  say("launch-chat", "hello");
  const result = projectToolHandlers.get("read-messages")!({ db: database(), groupId: "launch", botId: "dax", role: "member", request: { targetThreadId: "launch-chat", rootThreadId: "launch-chat" } as never, memberIds: ["dax", "finch"], ownerAudience: true, now: NOW }, {});
  expect(result.status).toBe(200);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.threadId).toBe("launch-chat");
  expect(shown[0]!.messages).toEqual([{ threadId: "launch-chat", messageId: (result.body as { messages: Array<{ id: string }> }).messages[0]!.id }]);
});

it.each(["schedule","assistant","source","checkpoint"])("bot bring-in refuses %s as an active project fact",kind=>{
 const message=say("dax-direct","Captured content",{role:kind==="assistant"?"bot":"user",origin:"desktop",...(kind==="schedule"?{automation:{kind:"schedule" as const}}:{})});
 const db=database();db.prepare("UPDATE memory_jobs SET status='complete' WHERE source_id=?").run(`message:dax-direct:${message.id}`);
 const base={groupId:"launch",roomThreadId:"launch-chat",botId:"dax",roster,now:NOW,botInitiated:true};
 let result;
 if(kind==="source"||kind==="checkpoint"){
 const id=saveMemoryCandidate("Captured content",[{sourceId:`message:dax-direct:${message.id}`,revision:1,startByte:0,endByte:16}],`r6-${kind}`,access("dax","dax-direct"));
 db.prepare("UPDATE memory_records SET state='active',kind=? WHERE id=?").run(kind,id);
 result=bringInToProject(db,{...base,recordId:id});
 }else result=bringInToProject(db,{...base,sourceMessageId:message.id});
 expect(result).toMatchObject({ok:false,status:403,error:expect.any(String)});
 expect(db.prepare("SELECT count(*) n FROM memory_sources WHERE kind='bring-in'").get()?.n).toBe(0);
});

it("bot bring-in accepts completed attended evidence across scopes",()=>{
 const message=say("dax-direct","An attended owner fact",{role:"user",origin:"desktop",from:undefined});
 const db=database();db.prepare("UPDATE memory_jobs SET status='complete' WHERE source_id=?").run(`message:dax-direct:${message.id}`);
 expect(bringInToProject(db,{groupId:"launch",roomThreadId:"launch-chat",botId:"dax",roster,now:NOW,sourceMessageId:message.id,botInitiated:true})).toMatchObject({ok:true});
});
it("registered bot bring-in refuses a schedule-backed fact's original evidence",()=>{
 const original=ownerFact("dax-direct","Automated claim","r6-original");
 const db=database();db.prepare("UPDATE memory_jobs SET status='complete' WHERE source_id='message:dax-direct:r6-original'").run();
 db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','schedule') WHERE source_id='message:dax-direct:r6-original'").run();
 registerProjectMemoryTools({roster:()=>roster,note:()=>{throw new Error("Refusal must not announce a copy");}});
 const result=projectToolHandlers.get("bring-in")!({db,groupId:"launch",botId:"dax",role:"member",request:{targetThreadId:"launch-chat",rootThreadId:"launch-chat"} as never,memberIds:["dax","finch"],ownerAudience:true,now:NOW},{recordId:original});
 expect(result).toMatchObject({status:403});
 expect(db.prepare("SELECT count(*) n FROM memory_sources WHERE kind='bring-in'").get()?.n).toBe(0);
});
