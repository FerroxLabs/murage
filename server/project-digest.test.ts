// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectCard } from "./project-cards.ts";
import { createDefaultPeriodBudget } from "./project-defaults.ts";
import { insertProjectActivity } from "./project-records.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { runProjectDigests } from "./project-digest.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
const now = Date.parse("2026-09-29T08:00:00Z");
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,json TEXT)");
  channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: null, now: now - 2 * 86400000 });
  const group = { id: "g", threadId: "room", memberIds: [] };
  let clock = now;
  const bus = { store: { group: (id: string) => id === "g" ? group : undefined,
    appendMessage: (thread: string, value: unknown) => db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(thread, `m-${clock}`, clock, JSON.stringify(value)),
    patchGroup: vi.fn(),
  }, broadcast: vi.fn() } as unknown as CommsBus;
  const deps = { db, bus, features: {} as { projectsDigest?: boolean }, timeZone: "UTC" };
  const run = (at = now) => { clock = at; return runProjectDigests(deps, at); };
  const enable = () => db.exec(`UPDATE project_settings SET parts='{"digest":true}'`);
  const card = () => createProjectCard(db, { groupId: "g", title: "MODEL_CANARY_NEVER_IN_DIGEST", actor: { kind: "owner" }, memberIds: [], now: now - 1000 });
  const lines = () => db.prepare("SELECT json FROM messages").all().map(row => JSON.parse(String(row.json)));
  return { db, deps, run, enable, card, lines };
}
it("is opt-in and honours the global flag, closed and ended projects", () => {
  const f = fixture(); f.card(); f.run(); expect(f.lines()).toHaveLength(0);
  f.enable(); f.deps.features.projectsDigest = false; f.run(); expect(f.lines()).toHaveLength(0);
  f.deps.features.projectsDigest = true;
  f.db.exec("UPDATE project_settings SET closed_at=1"); f.run(); expect(f.lines()).toHaveLength(0);
  f.db.exec("UPDATE project_settings SET closed_at=NULL,ended_at=1"); f.run(); expect(f.lines()).toHaveLength(0);
});
it("waits until 08:00 and dedupes from persisted messages across runs and restart", () => {
  const f = fixture(); f.enable(); f.card(); f.run(now - 1); expect(f.lines()).toHaveLength(0);
  f.run(); f.run(now + 60000); runProjectDigests({ ...f.deps, bus: { ...f.deps.bus } }, now + 120000);
  expect(f.lines()).toHaveLength(1);
  expect(f.lines()[0]).toMatchObject({ actorKind: "murage", kind: "activity", murage: { kind: "status", digestDay: "2026-09-29" } });
  expect(f.lines()[0].from).toBeUndefined();
  expect(JSON.stringify(f.lines())).not.toContain("MODEL_CANARY");
  f.run(now + 86400000); expect(f.lines()).toHaveLength(2);
});
it("uses the period budget zone ahead of the server zone", () => {
  const f = fixture(); f.enable(); f.card();
  createDefaultPeriodBudget(f.db, { groupId: "g", period: "week", tz: "Asia/Tokyo", now });
  f.run(); expect(f.lines()).toHaveLength(1);
  f.run(Date.parse("2026-09-29T22:59:59Z")); expect(f.lines()).toHaveLength(1);
  f.run(Date.parse("2026-09-29T23:00:00Z")); expect(f.lines()).toHaveLength(2);
  expect(f.lines()[1].murage.digestDay).toBe("2026-09-30");
});
it("uses the previous digest window and omits card titles and model detail", () => {
  const f = fixture(); f.enable(); const made = f.card(); if (!made.ok) throw Error("fixture");
  f.run();
  insertProjectActivity(f.db, { groupId: "g", kind: "card_moved", actor: "owner", workItemId: made.card.id, at: now + 1000, detail: { from: "todo", to: "done", text: "MODEL_DETAIL_CANARY" } });
  f.db.prepare("UPDATE project_work_items SET state='done',done_at=? WHERE id=?").run(now + 1000, made.card.id);
  f.run(now + 2 * 86400000);
  expect(f.lines()[1].tool.name).toContain("1 card done");
  expect(JSON.stringify(f.lines())).not.toContain("MODEL_");
  f.run(now + 3 * 86400000);
  expect(f.lines()[2].tool.name).toContain("nothing changed since the last digest");
});
it("posts nothing for an empty project, but an unchanged goal receives a quiet digest", () => {
  const f = fixture(); f.enable(); f.run(); expect(f.lines()).toHaveLength(0);
  f.db.prepare("INSERT INTO project_goals (id,group_id,title,state,created_at) VALUES ('goal','g','Owner goal','draft',?)").run(now - 2 * 86400000);
  f.run(); expect(f.lines()[0].tool.name).toContain("nothing changed since the last digest");
});
it("includes grouped decisions and today's work, not yesterday's usage", () => {
  const f = fixture(); f.enable(); f.card();
  f.db.exec(`UPDATE project_work_items SET state='waiting',waiting_on='{"kind":"restart"}'`);
  const insert = f.db.prepare(`INSERT INTO usage_ledger(settle_key,group_id,bot_id,thread_id,engine,tokens_reported,charge_kind,work_ms,ok,at) VALUES (?,'g','bot','room','fake',0,'none',3600000,1,?)`);
  insert.run("today", now - 1000); insert.run("yesterday", now - 86400000);
  f.run(); expect(f.lines()[0].tool.name).toContain("1 needs you"); expect(f.lines()[0].tool.name).toContain("1 h");
});

it("counts automatic completion results as done, but not results awaiting review", () => {
  const f = fixture(); f.enable(); const made = f.card(); if (!made.ok) throw Error("fixture");
  insertProjectActivity(f.db, { groupId: "g", kind: "card_result", actor: "server", workItemId: made.card.id, at: now - 500, detail: { from: "doing", to: "done" } });
  insertProjectActivity(f.db, { groupId: "g", kind: "card_result", actor: "server", workItemId: "review-card", at: now - 500, detail: { from: "doing", to: "review" } });
  f.run(); expect(f.lines()[0].tool.name).toContain("1 card done");
});

it("logs a bad project timezone and continues with the next project", () => {
 const f=fixture(); f.enable(); f.card();
 channelToProjectRows(f.db,{groupId:"bad",bulletin:"",leadBotId:null,now:now-1000});
 f.db.exec("UPDATE project_settings SET parts='{\"digest\":true}'");
 createDefaultPeriodBudget(f.db,{groupId:"g",period:"week",tz:"UTC",now});
 f.db.exec("UPDATE project_budgets SET tz='Not/AZone' WHERE group_id='g'");
 const group=f.deps.bus.store.group;
 vi.spyOn(f.deps.bus.store,"group").mockImplementation(id=>id==="bad"?{id:"bad",threadId:"second",memberIds:[]} as unknown as ReturnType<typeof group>:group(id));
 createProjectCard(f.db,{groupId:"bad",title:"Other",actor:{kind:"owner"},memberIds:[],now:now-1000});
 const log=vi.spyOn(console,"error").mockImplementation(()=>{});
 try {expect(f.run()).toBe(1);expect(f.lines()).toHaveLength(1);expect(log).toHaveBeenCalled();}finally{log.mockRestore();}
});
it("uses plural need and the UI failed-goal wording", () => {
 const f=fixture();f.enable();f.card();f.card();
 f.db.exec("UPDATE project_work_items SET state='waiting',waiting_on='{\"kind\":\"restart\"}'");
 f.db.prepare("INSERT INTO project_goals (id,group_id,title,state,created_at) VALUES ('goal','g','Owner goal','failed',?)").run(now-1000);
 f.run();expect(f.lines()[0].tool.name).toContain("2 need you");expect(f.lines()[0].tool.name).toContain("Goal 'Owner goal': Could not continue.");
});

it("the boot/interval tick contains unexpected failures and skips restore admission", () => {
 const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
 const body=source.match(/const digestTick = \(\) => \{([\s\S]*?)\n\};/)![1];
 const run=vi.fn(()=>{throw Error("fixture failure");}),log={error:vi.fn()};
 const invoke=new Function("backupRestartAdmission","runProjectDigests","database","commsBus","cfg","store","readProjectDecisions","console",body);
 expect(()=>invoke({held:()=>false},run,()=>({}),{},{features:{}},{},()=>({}),log)).not.toThrow();expect(log.error).toHaveBeenCalled();
 run.mockClear();invoke({held:()=>true},run,()=>({}),{},{features:{}},{},()=>({}),log);expect(run).not.toHaveBeenCalled();
});
