// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R migration and reconciler tests (SPEC-P section 4 and section 2
// cross-store rules): upgrade of existing channel projects, idempotency,
// interruption, and the boot reconciler that repairs a crash between the
// messages.db rows and the groups.json write.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home = "";

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "murage-project-migration-"));
  vi.resetModules();
  vi.stubEnv("MURAGE_DATA_DIR", join(home, "data"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const migration = await import("./project-migration.ts");
  const { database, transaction, closeDatabase } = await import("./database.ts");
  const records = await import("./project-records.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  return { store, migration, database, transaction, closeDatabase, records };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  const { closeDatabase } = await import("./database.ts");
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("migrateChannelProjects", () => {
  it("migrates a channel with a project block: settings, brief v1, goal draft", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Closing", [bot!.id], false, undefined, { bulletin: "Be brief.", defaultResponder: { kind: "member", botId: bot!.id }, completed: true });
    store.patchGroup(group.id, { channelProject: { goal: "Close the books", status: "active", startedAt: NOW, updatedAt: NOW } });

    const migrated = migration.migrateChannelProjects(store);
    expect(migrated).toBe(1);

    const settings = records.projectSettingsFor(database(), group.id);
    expect(settings).toMatchObject({
      mode: "conversation", leadBotId: bot!.id, runState: "running",
      migratedFrom: "both", closedAt: null, endedAt: null, parallelCards: 3,
    });
    const brief = records.currentProjectBrief(database(), group.id);
    expect(brief).toMatchObject({ version: 1, rules: "Be brief.", summary: "Close the books", updatedBy: "migration", change: "migration" });
    const goal = records.activeProjectGoal(database(), group.id);
    expect(goal).toBeNull(); // draft does not count as active
    const goals = database().prepare("SELECT * FROM project_goals WHERE group_id=?").all(group.id) as Array<Record<string, unknown>>;
    expect(goals).toHaveLength(1);
    expect(records.projectGoalFromRow(goals[0]!)).toMatchObject({
      title: "Close the books", description: "Close the books", state: "draft",
      stateReason: "From before the update: Start it to run it as a goal",
    });
  });

  it("migrates a done project to a done goal and stamps closed_at from completedAt", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Done deal", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Finish it", status: "done", startedAt: NOW, updatedAt: NOW + 5, completedAt: NOW + 5 } });
    migration.migrateChannelProjects(store);
    const settings = records.projectSettingsFor(database(), group.id);
    expect(settings!.closedAt).toBe(NOW + 5);
    const goal = records.projectGoalFromRow((database().prepare("SELECT * FROM project_goals WHERE group_id=?").get(group.id)) as Record<string, unknown>);
    expect(goal).toMatchObject({ state: "done", finishedAt: NOW + 5 });
  });

  it("loses nothing from a 2,000-character goal and a 12,000-character bulletin", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const goal = "g".repeat(2000);
    const bulletin = "b".repeat(12000);
    const group = store.createGroup("Long", [bot!.id], false, undefined, { bulletin, defaultResponder: { kind: "everyone" }, completed: true });
    store.patchGroup(group.id, { channelProject: { goal, status: "paused", startedAt: NOW, updatedAt: NOW } });
    migration.migrateChannelProjects(store);
    const brief = records.currentProjectBrief(database(), group.id);
    expect(brief!.rules).toBe(bulletin);
    expect(brief!.summary.length).toBeLessThanOrEqual(200);
    const row = database().prepare("SELECT * FROM project_goals WHERE group_id=?").get(group.id) as Record<string, unknown>;
    const migrated = records.projectGoalFromRow(row);
    expect(migrated.description).toBe(goal);
    expect(migrated.title.length).toBeLessThanOrEqual(200);
    expect(migrated.state).toBe("draft"); // paused before the update becomes draft (SPEC-P 4, deviation)
  });

  it("is idempotent: the settings row is the marker", async () => {
    const { store, migration, database } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Again", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Once", status: "active", startedAt: NOW, updatedAt: NOW } });
    expect(migration.migrateChannelProjects(store)).toBe(1);
    expect(migration.migrateChannelProjects(store)).toBe(0);
    expect((database().prepare("SELECT COUNT(*) AS n FROM project_briefs WHERE group_id=?").get(group.id) as { n: number }).n).toBe(1);
  });

  it("leaves plain channels untouched", async () => {
    const { store, migration, database } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    store.createGroup("Plain", [bot!.id]);
    expect(migration.migrateChannelProjects(store)).toBe(0);
    expect((database().prepare("SELECT COUNT(*) AS n FROM project_settings").get() as { n: number }).n).toBe(0);
  });

  it("rolls back an interrupted migration and runs clean on the next boot", async () => {
    const { store, migration, database, transaction, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Crash", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Crash test", status: "active", startedAt: NOW, updatedAt: NOW } });
    expect(() => transaction((db) => {
      migration.migrateChannelProjectGroup(db, store.group(group.id)!, NOW);
      throw new Error("simulated crash inside the migration transaction");
    })).toThrow("simulated crash");
    expect(records.projectSettingsFor(database(), group.id)).toBeNull();
    expect(migration.migrateChannelProjects(store)).toBe(1);
    expect(records.projectSettingsFor(database(), group.id)).not.toBeNull();
  });
});

describe("reconcileProjectRecords", () => {
  it("gives a group with channelProject and no settings row its default rows (crash between JSON and rows)", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Half done", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Half written", status: "active", startedAt: NOW, updatedAt: NOW } });
    // Simulate a crash before the row write: no settings row exists.
    expect(records.projectSettingsFor(database(), group.id)).toBeNull();
    migration.reconcileProjectRecords(store);
    expect(records.projectSettingsFor(database(), group.id)).not.toBeNull();
  });

  it("restores channelProject on a group whose settings row is open but whose JSON lost the block", async () => {
    const { store, migration } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Lost block", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Keep me", status: "active", startedAt: NOW, updatedAt: NOW } });
    migration.migrateChannelProjects(store);
    store.patchGroup(group.id, { channelProject: undefined }); // crash lost the JSON write's counterpart
    migration.reconcileProjectRecords(store);
    expect(store.group(group.id)!.channelProject).toBeDefined();
  });

  it("deletes rows whose group is gone", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Gone", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Delete me", status: "active", startedAt: NOW, updatedAt: NOW } });
    migration.migrateChannelProjects(store);
    store.deleteGroup(group.id);
    expect(records.projectSettingsFor(database(), group.id)).toBeNull();
    expect((database().prepare("SELECT COUNT(*) AS n FROM project_goals WHERE group_id=?").get(group.id) as { n: number }).n).toBe(0);
  });

  it("never deletes project data when groups.json is missing at boot (unknown, not empty)", async () => {
    const { store, migration, database, records, closeDatabase } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const group = store.createGroup("Keep", [bot!.id]);
    store.patchGroup(group.id, { channelProject: { goal: "Keep me", status: "active", startedAt: NOW, updatedAt: NOW } });
    migration.migrateChannelProjects(store);
    expect(database().prepare("SELECT COUNT(*) AS n FROM project_goals WHERE group_id=?").get(group.id)).toMatchObject({ n: 1 });
    const { rmSync: rm } = await import("node:fs");
    rm(join(home, "data", "groups.json"), { force: true });
    const { Store } = await import("./store.ts");
    const cold = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(cold.groups).toHaveLength(0);
    migration.reconcileProjectRecords(cold);
    expect(records.projectSettingsFor(database(), group.id)).not.toBeNull();
    expect(database().prepare("SELECT COUNT(*) AS n FROM project_goals WHERE group_id=?").get(group.id)).toMatchObject({ n: 1 });
    expect(database().prepare("SELECT COUNT(*) AS n FROM project_briefs WHERE group_id=?").get(group.id)).toMatchObject({ n: 1 });
    closeDatabase();
  });

  it("snapshots messages.db before a boot-time delete of rows whose group is gone", async () => {
    const { store, migration, database, records } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const keep = store.createGroup("Keep", [bot!.id]);
    const gone = store.createGroup("Gone", [bot!.id]);
    for (const g of [keep, gone]) store.patchGroup(g.id, { channelProject: { goal: g.name, status: "active", startedAt: NOW, updatedAt: NOW } });
    migration.migrateChannelProjects(store);
    // The roster loses one group but not all: a crash-repair delete, snapshotted first.
    const { readFileSync, writeFileSync, readdirSync } = await import("node:fs");
    const file = join(home, "data", "groups.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string }>;
    writeFileSync(file, JSON.stringify(raw.filter(g => g.id !== gone.id)));
    const { Store } = await import("./store.ts");
    const cold = new Store(() => ({ instanceId: "claude", model: "m" }));
    migration.reconcileProjectRecords(cold);
    expect(records.projectSettingsFor(database(), gone.id)).toBeNull();
    expect(records.projectSettingsFor(database(), keep.id)).not.toBeNull();
    const snaps = readdirSync(join(home, "data")).filter(name => name.startsWith("project-rows-before-prune-"));
    expect(snaps).toHaveLength(1);
  });

  it("archives a desk task whose project rows are gone", async () => {
    const { store, migration, database } = await freshStore();
    const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
    const task = store.createTask(bot!.id, "Desk", false)!;
    // Lane E2a writes this marker; simulate it directly on the record.
    task.channelProjectDesk = { groupId: "ghost-group" };
    migration.reconcileProjectRecords(store);
    const reloaded = store.taskByThread(bot!.id, task.threadId);
    expect(reloaded!.channelProjectDesk!.archivedAt).toBeGreaterThan(0);
    expect(database()).toBeDefined();
  });
});

it("repairs End project after a crash before the JSON write", async () => {
  const { store, migration, database, transaction, records } = await freshStore();
  const bot = store.createBot({ name: "Lead" }, { seedMessages: false })!;
  const group = store.createGroup("Work", [bot.id]);
  store.patchGroup(group.id, { channelProject: { goal: "Work", status: "active", startedAt: NOW, updatedAt: NOW } });
  migration.migrateChannelProjects(store);
  const { endProjectRows } = await import("./project-settings.ts");
  database().prepare("UPDATE project_briefs SET rules='Keep these rules' WHERE group_id=?").run(group.id);
  transaction(db => endProjectRows(db, { groupId: group.id, now: NOW + 1 }));
  migration.reconcileProjectRecords(store);
  expect(store.group(group.id)!.channelProject).toBeUndefined();
  expect(store.group(group.id)!.bulletin).toBe("Keep these rules");
  expect(records.projectSettingsFor(database(), group.id)!.endedAt).toBe(NOW + 1);
  migration.reconcileProjectRecords(store);
  expect(store.group(group.id)!.channelProject).toBeUndefined();
});

it("validates descriptive shapes at boot without pausing running projects", async () => {
  const { store, migration, database, records } = await freshStore();
  const bot = store.createBot({ name: "Lead" }, { seedMessages: false })!;
  const group = store.createGroup("Work", [bot.id]);
  store.patchGroup(group.id, { channelProject: { goal: "Work", status: "active", startedAt: NOW, updatedAt: NOW } });
  migration.migrateChannelProjects(store);
  database().prepare("UPDATE project_goals SET criteria='[42]' WHERE group_id=?").run(group.id);
  migration.reconcileProjectRecords(store);
  expect(database().prepare("SELECT criteria FROM project_goals WHERE group_id=?").get(group.id)!.criteria).toBe("[]");
  expect(records.projectSettingsFor(database(), group.id)!.runState).toBe("running");
});

it("materializes committed desktop creation once after a crash before JSON", async () => {
  const {store,migration,database,records} = await freshStore();
  const bot=store.createBot({name:"Lead"},{seedMessages:false})!;
  const {createProjectRows}=await import("./project-new.ts");
  createProjectRows(database(),{clientId:"new-project",purpose:"A report",members:[bot.id],leadBotId:bot.id,mode:"goal",goal:{title:"Report"}},[{id:bot.id,name:bot.name}],NOW);
  expect(store.group("new-project")).toBeUndefined();
  migration.reconcileProjectRecords(store); migration.reconcileProjectRecords(store);
  expect(store.groups.filter(g=>g.id==="new-project")).toHaveLength(1);
  expect(records.currentProjectBrief(database(),"new-project")?.rules).toBe("A report");
  expect(store.group("new-project")?.defaultResponder).toEqual({kind:"member",botId:bot.id});
});
it("repairs Close and Reopen JSON and desk archive flags after row commits", async () => {
  const {store,migration,database,records}=await freshStore();
  const bot=store.createBot({name:"Lead"},{seedMessages:false})!;
  const group=store.createGroup("Work",[bot.id]);
  store.patchGroup(group.id,{channelProject:{goal:"Work",status:"active",startedAt:NOW,updatedAt:NOW}});
  migration.migrateChannelProjects(store);
  const desk=store.createTask(bot.id,"Desk",false)!; desk.channelProjectDesk={groupId:group.id};
  const {setProjectClosed,setProjectReopened}=await import("./project-settings.ts");
  setProjectClosed(database(),{groupId:group.id,at:NOW+1}); migration.reconcileProjectRecords(store);
  expect(store.group(group.id)?.channelProject).toMatchObject({status:"done",completedAt:NOW+1});
  expect(desk.channelProjectDesk.archivedAt).toBe(NOW+1);
  setProjectReopened(database(),{groupId:group.id,at:NOW+2}); migration.reconcileProjectRecords(store);
  expect(store.group(group.id)?.channelProject).toMatchObject({status:"active"});
  expect(store.group(group.id)?.channelProject?.completedAt).toBeUndefined();
  expect(desk.channelProjectDesk.archivedAt).toBeUndefined();
  expect(records.projectSettingsFor(database(),group.id)?.runState).toBe("paused");
});

it("a Chief proposal writes no bots, groups, tasks or requests",async()=>{
  const {store,database}=await freshStore();const chief=store.createBot({name:"Chief"},{seedMessages:false})!;
  const {proposeProject}=await import("./project-new.ts");
  const before={bots:JSON.stringify(store.bots),groups:JSON.stringify(store.groups),requests:database().prepare("SELECT * FROM room_requests").all()};
  const result=await proposeProject({purpose:"Synthetic report"},{members:[{id:chief.id,name:chief.name}],chiefId:chief.id,ownerAudience:true,roster:"Chief",run:async(prompt:string)=>`${/<murage-project-proposal nonce="[a-f0-9]{32}">/.exec(prompt)![0]}\n${JSON.stringify({members:[chief.id],leadBotId:chief.id,mode:"bots",brief:{summary:"Report",doneMeans:"Written",rules:"Brief"},budget:{minutes:120,tokens:3000000},planOutline:["Write"]})}\n</murage-project-proposal>`});
  expect(result).toHaveProperty("proposal");
  expect(JSON.stringify(store.bots)).toBe(before.bots);expect(JSON.stringify(store.groups)).toBe(before.groups);
  expect(database().prepare("SELECT * FROM room_requests").all()).toEqual(before.requests);
});

it("P4 rolls back a failed groups write, then retries and survives cold reload", async () => {
  const {store,migration,database,records}=await freshStore();
  const bot=store.createBot({name:"Member"},{seedMessages:false})!;
  const {createProjectRows}=await import('./project-new.ts');
  createProjectRows(database(),{clientId:'retry-create',purpose:'Report',mode:'bots',members:[bot.id]},[{id:bot.id,name:bot.name}],NOW);
  const save=vi.spyOn(store as unknown as {saveGroups():void},'saveGroups').mockImplementationOnce(()=>{throw new Error('disk write failed');});
  expect(()=>migration.reconcileProjectRecords(store)).toThrow('disk write failed');
  expect(store.group('retry-create')).toBeUndefined();
  expect(database().prepare("SELECT 1 FROM project_activity WHERE json_extract(detail,'$.creation')='materialized'").get()).toBeUndefined();
  save.mockRestore(); migration.reconcileProjectRecords(store);
  (await import('./message-db.ts')).closeMessageDb(); (await import('./database.ts')).closeDatabase();
  const {Store}=await import('./store.ts');
  const cold=new Store(()=>({instanceId:'claude',model:'m'})); migration.reconcileProjectRecords(cold);
  expect(cold.group('retry-create')?.channelProject?.status).toBe('active');
  expect(records.projectSettingsFor(database(),'retry-create')).not.toBeNull();
});
it("P5 materializes only the requested creation", async () => {
  const {store,migration,database}=await freshStore();
  const bot=store.createBot({name:"Member"},{seedMessages:false})!;
  const {createProjectRows}=await import('./project-new.ts');
  for(const clientId of ['first','second'])createProjectRows(database(),{clientId,purpose:'Report',mode:'bots',members:[bot.id]},[{id:bot.id,name:bot.name}],NOW);
  const narrow=(migration as unknown as {materializeProjectCreation(target:typeof store,id:string):void}).materializeProjectCreation;
  expect(typeof narrow).toBe('function'); narrow(store,'first');
  expect(store.group('first')?.channelProject?.status).toBe('active'); expect(store.group('second')).toBeUndefined();
  migration.reconcileProjectRecords(store); expect(store.group('second')?.channelProject?.status).toBe('active');
});

it("C8 retry after posting then failure and cold reload persists exactly one summary", async () => {
  const {store,database}=await freshStore();const bot=store.createBot({name:'Member'},{seedMessages:false})!;
  const group=store.createGroup('Close',[bot.id]);const {channelToProjectRows}=await import('./project-settings.ts');
  channelToProjectRows(database(),{groupId:group.id,bulletin:'',leadBotId:null,now:1});
  const {startProjectClose,resumeProjectCloses}=await import('./project-close.ts');
  const post=(key:string,text:string)=>store.appendProjectCloseMessage(group.threadId,key,text);
  const deps={groupId:group.id,threadId:group.threadId,memberIds:[],now:2,lineage:{rootThreadId:group.threadId,origin:'desktop' as const,audienceFingerprint:'owner',notOwnerAudience:false,unattended:false},deliverables:()=>[],routineNames:()=>[],pauseRoutines:vi.fn().mockImplementationOnce(()=>{throw new Error('after posting');}),post,summary:()=>null,sync:()=>{}};
  startProjectClose(database(),deps);expect(()=>resumeProjectCloses(database(),deps)).toThrow('after posting');
  resumeProjectCloses(database(),deps);
  (await import('./message-db.ts')).closeMessageDb(); (await import('./database.ts')).closeDatabase();
  const {Store}=await import('./store.ts');const cold=new Store(()=>({instanceId:'claude',model:'m'}));
  expect(cold.messagesFor(group.threadId).filter(m=>m.text?.startsWith('Project closed.'))).toHaveLength(1);
  expect(database().prepare("SELECT id FROM messages WHERE thread_id=? AND text LIKE 'Project closed.%'").all(group.threadId)).toHaveLength(1);
});

it("repairs a malformed project row at boot instead of stopping the app (C-2)", async () => {
  const { store, migration, database, records } = await freshStore();
  const bot = store.createBot({ name: "Lead" }, { seedMessages: false })!;
  const group = store.createGroup("Work", [bot.id]);
  store.patchGroup(group.id, { channelProject: { goal: "Work", status: "active", startedAt: NOW, updatedAt: NOW } });
  migration.migrateChannelProjects(store);
  database().prepare(`UPDATE project_settings SET parts='{"bogus":3}', work_roots='{}' WHERE group_id=?`).run(group.id);
  expect(() => migration.reconcileProjectRecords(store)).not.toThrow();
  const settings = records.projectSettingsFor(database(), group.id)!;
  expect(Array.isArray(settings.workRoots)).toBe(true);
  expect(typeof settings.parts).toBe("object");
});
