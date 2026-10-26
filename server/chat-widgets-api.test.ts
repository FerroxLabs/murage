// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q4 (207) route level, real isolated server and fake engine: show_widget and update_widget through the agents
// server's internal routes, refused like ask_user (not-owner audience) and in rooms; a press is ONE owner send per widget
// (double press, a second ref and a retry leave one owner_sends row), delivered by queue and running the bot's next turn;
// update_widget on a settled widget is 409 and an unknown id 404; Stop and a restart leave an open widget pressable.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer; let headers: Record<string, string> = {}; let model: string;
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
  if(url.endsWith('/internal-capabilities.ts')){
    const loaded=next(url,context);
    const patch='\\nconst __murageMint=InternalCapabilities.prototype.mint;InternalCapabilities.prototype.mint=function(input){let forced=[];try{forced=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(process.env.MURAGE_DATA_DIR+"/fixture-not-owner.json","utf8"));}catch{}return __murageMint.call(this,forced.includes(input.threadId)?{...input,notOwnerAudience:true}:input);};\\n';
    return {...loaded,source:String(loaded.source)+patch};
  }
  if(url.endsWith('/server/send-store.ts')){
    const loaded=next(url,context);
    const patch='\\nconst __murageQueue=SendStore.prototype.queue;SendStore.prototype.queue=function(...args){const fs=process.getBuiltinModule("node:fs");const armed=process.env.MURAGE_DATA_DIR+"/fixture-fail-queue";if(fs.existsSync(armed)){fs.rmSync(armed,{force:true});throw new Error("fixture: the press could not take its place in line");}return __murageQueue.apply(this,args);};\\n';
    return {...loaded,source:String(loaded.source)+patch};
  }
  return next(url,context);
}});
`;
async function login() { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; }
async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = headers) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...extra, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); } catch { return undefined; } };
/** A held turn of `bot` whose prompt carries `marker`: its agents token. */
async function heldTurn(bot: any, marker: string, notOwner = false): Promise<string> {
  writeFileSync(join(fixture.info.dataDir, "fixture-not-owner.json"), JSON.stringify(notOwner ? [bot.threadId] : []));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${marker}` })).status).toBe(202);
  let token: string | undefined;
  await expect.poll(() => { const d = dump(); return JSON.stringify(d?.prompt ?? "").includes(marker) ? (token = d.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN) : undefined; }, { timeout: 20000 }).toBeTruthy();
  return token!;
}
async function internal(token: string, path: string, body: unknown) {
  const res = await fetch(fixture.info.url + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
async function newBot(name: string) {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: "off", composio: false });
  return bot;
}
const ownerSends = (sendId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT COUNT(*) AS n FROM owner_sends WHERE send_id = ?").get(sendId) as { n: number }).n; } finally { db.close(); }
};
const widgetRow = async (threadId: string, widgetId: string) => {
  const page = (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body;
  return (page.messages as any[]).find((message) => message.widget?.id === widgetId);
};
const BOOKING = {
  type: "Card", title: "Book a call", confirm: { label: "Book it", action: { type: "book" } }, cancel: { label: "Not now", action: { type: "cancel" } },
  children: [
    { type: "DatePicker", name: "date", label: "Date" },
    { type: "TimePicker", name: "time", label: "Time" },
    { type: "Select", name: "length", label: "Length", options: [{ label: "30 minutes", value: "30" }, { label: "1 hour", value: "60" }] },
  ],
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  await login();
  model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); });

it("show_widget is refused for a turn that is not the owner's; update_widget: unknown id 404", async () => {
  const bot = await newBot("Widget chain fixture");
  const chain = await heldTurn(bot, "widget chain", true);
  try {
    const refused = await internal(chain, "/api/internal/show-widget", { widget: BOOKING });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Show a widget from an owner conversation.");
  } finally { await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
  const owner = await heldTurn(bot, "widget owner");
  try {
    expect((await internal(owner, "/api/internal/update-widget", { widgetId: "no-such-widget", widget: BOOKING })).status).toBe(404);
    const invalid = await internal(owner, "/api/internal/show-widget", { widget: { type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("request_credential");
  } finally { await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 60000);

it("rooms refuse show_widget with one line", async () => {
  const bot = await newBot("Widget room fixture");
  const group = (await api("POST", "/api/groups", { name: "Widget room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  expect(group.threadId).toBeTruthy();
  writeFileSync(join(fixture.info.dataDir, "fixture-not-owner.json"), "[]");
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "__fixture_hold_authority__ widget room" })).status).toBe(202);
  let token: string | undefined;
  await expect.poll(() => { const d = dump(); return JSON.stringify(d?.prompt ?? "").includes("widget room") ? (token = d.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN) : undefined; }, { timeout: 20000 }).toBeTruthy();
  try {
    const refused = await internal(token!, "/api/internal/show-widget", { widget: BOOKING });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Widgets are not available in rooms. Answer in text.");
    expect((await api("GET", `/api/threads/${group.threadId}/messages?limit=200`)).body.messages.some((message: any) => message.widget !== undefined)).toBe(false);
  } finally { await api("POST", `/api/groups/${group.id}/interrupt`, {}); }
}, 60000);

it("one owner send per widget: Stop and a restart leave it open; the first press settles; a double press, another ref and a retry meet already_settled", async () => {
  const bot = await newBot("Widget press fixture");
  const token = await heldTurn(bot, "widget press");
  const shown = await internal(token, "/api/internal/show-widget", { widget: BOOKING });
  expect(shown.status).toBe(201);
  const widgetId = shown.body.widgetId as string;
  expect(shown.body.text).toContain("End this turn");
  const updated = await internal(token, "/api/internal/update-widget", { widgetId, widget: { ...BOOKING, caption: "This is how it is set now" } });
  expect(updated.status).toBe(200);
  // Stop: the widget is not a question, nothing expires it
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.some((one: any) => one.id === bot.id && one.busy), { timeout: 15000 }).toBe(false);
  expect((await widgetRow(bot.threadId, widgetId))?.widget.settled).toBeUndefined();
  // a restart: still open and pressable
  await fixture.restart();
  await login();
  const row = await widgetRow(bot.threadId, widgetId);
  expect(row?.widget.settled).toBeUndefined();
  expect(row?.widget.rev).toBe(1);

  const press = { ref: "confirm", rev: 1, values: { date: "2026-10-21", time: "09:30", length: "60" } };
  // a press is the owner's: a request that cannot prove it is refused and nothing is sent or settled
  expect((await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, press, {})).status).toBe(403);
  expect(ownerSends(`widget-${widgetId}`)).toBe(0);
  expect((await widgetRow(bot.threadId, widgetId))?.widget.settled).toBeUndefined();
  // a press on the tree before the update names the wrong revision
  expect((await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, { ...press, rev: 0 })).body.code).toBe("widget_changed");
  const first = await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, press);
  expect(first.status).toBe(200);
  expect(first.body.text).toBe("Book it:\nDate: 2026-10-21\nTime: 09:30\nLength: 1 hour");
  const again = await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, press);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("already_settled");
  const otherRef = await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, { ref: "cancel", rev: 1 });
  expect(otherRef.status).toBe(409);
  expect(otherRef.body.code).toBe("already_settled");
  expect(ownerSends(`widget-${widgetId}`)).toBe(1);
  const settled = (await widgetRow(bot.threadId, widgetId))?.widget.settled;
  expect(settled).toMatchObject({ ref: "confirm", label: "Book it", sendId: `widget-${widgetId}`, values: { date: "2026-10-21", time: "09:30", length: "60" } });
  // the bot continues with those answers: the queued send runs its next turn
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes("Length: 1 hour"), { timeout: 20000 }).toBe(true);
  // update_widget on a settled widget: 409
  const later = dump()?.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN as string;
  const stale = await internal(later, "/api/internal/update-widget", { widgetId, widget: BOOKING });
  expect(stale.status).toBe(409);
  // 208: reopen puts the answers in a NEW widget, prefilled, with its own send
  const reopened = await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/reopen`, {});
  expect(reopened.status).toBe(201);
  const fresh = reopened.body.message.widget;
  expect(fresh.id).not.toBe(widgetId);
  expect(fresh.settled).toBeUndefined();
  const defaults = Object.fromEntries((fresh.root.children as any[]).map((node) => [node.name, node.defaultValue]));
  expect(defaults).toEqual({ date: "2026-10-21", time: "09:30", length: "60" });
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
}, 120000);

it("a press whose send cannot start after the claim is told as held (409 answer_held), not as sent: its words wait as a chip", async () => {
  const bot = await newBot("Widget held fixture");
  const token = await heldTurn(bot, "widget held");
  const shown = await internal(token, "/api/internal/show-widget", { widget: BOOKING });
  expect(shown.status).toBe(201);
  const widgetId = shown.body.widgetId as string;
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.some((one: any) => one.id === bot.id && one.busy), { timeout: 15000 }).toBe(false);
  // the widget row is an ordinary text row carrying the widget: 1.0.3 backs it up, restores it and reads it as its words
  expect(await widgetRow(bot.threadId, widgetId)).toMatchObject({ id: widgetId, kind: "text", text: expect.stringContaining("Book a call") });
  writeFileSync(join(fixture.info.dataDir, "fixture-fail-queue"), "");
  const held = await api("POST", `/api/threads/${bot.threadId}/widgets/${widgetId}/respond`, { ref: "confirm", rev: 0, values: { date: "2026-10-21", time: "09:30", length: "30" } });
  expect(held.status).toBe(409);
  expect(held.body).toMatchObject({ ok: false, code: "answer_held", outcome: "held", noticeCode: "refused" });
  expect((await widgetRow(bot.threadId, widgetId))?.widget.settled).toMatchObject({ ref: "confirm", sendId: `widget-${widgetId}` });
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { expect(db.prepare("SELECT status, notice FROM owner_sends WHERE send_id = ?").all(`widget-${widgetId}`)).toEqual([{ status: "refused", notice: "refused" }]); } finally { db.close(); }
}, 60000);
