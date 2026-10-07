import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { trigramQuery } from "./message-search-index.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { migrateMemorySchema } from "./memory/schema.ts";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { completeRequest, insertRoomRequest, markRequestDispatched } from "./room-requests.ts";
import { assertRestoreReviewed, RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(customize?: { bot?: Record<string, unknown>; db?: (db: DatabaseSync) => void }) {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-preparation-"));
  roots.push(root);
  const data = join(root, "source");
  mkdirSync(data);
  const put = (path: string, value: unknown) => { mkdirSync(dirname(join(data, path)), { recursive: true }); writeFileSync(join(data, path), JSON.stringify(value)); };
  put("config.json", { instances: { fake: { driver: "claudeAgent", enabled: true, config: { cli: "must-not-run" } } }, features: { browser: true, skillRecorder: true } });
  put("bots.json", [{ id: "bot", threadId: "thread", name: "Preserved bot", autoApprove: true, autoReview: "enforce", alwaysAllow: ["Bash:sh"], computer: "cloud", autoStartVps: true, browser: true, useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "profile_1", composio: true, busy: true, tasks: [{ threadId: "thread", title: "Keep me", autoApprove: true, alwaysAllow: ["Bash:sh"], resumeCursors: { old: "cursor" } }], ...customize?.bot }]);
  put("groups.json", [{ id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], working: true, busyBotId: "bot" }]);
  const run = { routineId: "routine", routineName: "Routine", botId: "bot", target: "bot", runOn: "ember", scheduledFor: 1, manual: true, createdAt: 1 };
  put("routines.json", { version: 1, routines: [{ id: "routine", name: "Routine", prompt: "Task", botId: "bot", target: "bot", runOn: "ember", enabled: true, schedule: { type: "once", at: 1 }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1 }], runs: [{ ...run, id: "done", status: "completed", result: "immutable receipt" }, { ...run, id: "queued", status: "queued" }], routineRequestReceipts: [{ requestId: "terminal-id", messageId: "terminal", botId: "bot", threadId: "thread", action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: "routine", appliedAt: 1 }] });
  mkdirSync(join(data, "events", "routine-runs"), { recursive: true });
  writeFileSync(join(data, "events", "routine-runs", "routine.jsonl"), [{ ...run, id: "journal-done", status: "completed" }, { ...run, id: "journal-queued", status: "queued" }].map(line => JSON.stringify(line)).join("\n") + "\n");
  put("calendar-calls.json", { version: 1, calls: [{ id: "call", name: "Call", description: "Fixture", botIds: ["bot"], schedule: { type: "once", at: 1 }, durationMinutes: 30, attachments: [], createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 10 }] });
  put("webhooks.json", { version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", name: "Hook", prompt: "Task", botId: "bot", runOn: "ember", createdAt: 1, updatedAt: 1, deliveryCount: 1, enabled: true, secretHash: "b".repeat(64) }], deliveries: [{ key: "endpoint:already-run", runId: "done", at: 1 }] });
  put("delegations.json", { thread: [{ id: "queued", message: "Never replay automatically" }] });
  put("browser-cleanups.json", { entries: ["Do not replay cleanup"] });
  // Murage for Chrome: the paired external client registry, its generated
  // pairing files and the extension service state are credentials of this
  // computer's browser, never carried by a backup (plan 4.3).
  put("browser-extension/clients.json", { version: 1, workspaceId: "workspace", enabled: true, clients: [{ clientId: "client", tokenHash: "c".repeat(64) }] });
  put("browser-extension/client-configs/client.json", { clientId: "client", token: "not-a-real-token" });
  put("browser-extension/state.json", { version: 1, bindings: [] });
  put("skill-state/bot/skills.json", { skill: { enabled: true, revision: "preserve" } });
  put("skill-state/bot/staged.json", { writes: { pending: { text: "Do not apply automatically" } } });
  const db = new DatabaseSync(join(data, "messages.db"));
  const messages = [
    { id: "terminal", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Already done" } },
    { id: "pending", at: 2, role: "bot", kind: "options", parentId: "terminal", card: { requestId: "old-request", title: "Old approval", options: ["Allow"] } },
    // Murage for Chrome setup card waiting to continue the owner's request.
    { id: "browser-setup", at: 3, role: "bot", kind: "options", parentId: "pending", card: { title: "Use your browser for this task?", options: [], browserSetup: { requestKey: "setup-key", botId: "bot", threadId: "thread", ownerMessageId: "terminal", decision: "declined", continueRequested: true } } },
  ];
  try {
    initializeMessageTables(db);
    initializeImageOperations(db);
    for (const message of messages) db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, null, JSON.stringify(message));
    db.exec("INSERT INTO thread_state VALUES('thread','pending')");
    customize?.db?.(db);
  } finally { db.close(); }
  const archive = join(root, "backup.zip");
  await writeInstallationArchive(data, archive);
  return { root, data, archive, messages };
}

it("prepares a blocked candidate preserving terminal identities and suspending consequential work", async () => {
  const f = await fixture();
  const original = readFileSync(join(f.data, "bots.json"));
  const result = await prepareInstallationRestore(f.archive, f.root);
  const read = (path: string) => JSON.parse(readFileSync(join(result.stateDirectory, path), "utf8"));
  expect(read("config.json").engineDiscovery).toBe("explicit");
  expect(read("config.json").instances.fuigo).toMatchObject({ driver: "fuigoAgent", enabled: false });
  expect(Object.values(read("config.json").instances).every((entry: any) => entry.enabled === false)).toBe(true);
  const profile = restoredConnectionProfile(result.stateDirectory);
  expect(profile?.credentialsFile).toContain("connection-profiles");
  expect(existsSync(profile!.directory)).toBe(false);
  expect(read("bots.json")[0]).toMatchObject({ id: "bot", threadId: "thread", busy: false, autoApprove: false, autoReview: "off", alwaysAllow: [], computer: "off", autoStartVps: false, browser: false, useMyChrome: false, composio: false, resumeCursors: {} });
  expect(read("bots.json")[0]).not.toHaveProperty("browserTransport");
  expect(read("bots.json")[0]).not.toHaveProperty("browserExtensionProfileId");
  expect(existsSync(join(result.stateDirectory, "browser-extension"))).toBe(false);
  expect(read("groups.json")[0]).toMatchObject({ working: false, busyBotId: null });
  expect(read("bots.json")[0].tasks).toEqual([{ threadId: "thread", title: "Keep me", autoApprove: false, alwaysAllow: [], resumeCursors: {} }]);
  expect(read("routines.json").runs[0]).toMatchObject({ id: "done", status: "completed", result: "immutable receipt" });
  expect(read("routines.json").runs[1].status).toBe("cancelled");
  const journal = readFileSync(join(result.stateDirectory, "events", "routine-runs", "routine.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(journal.map(line => [line.id, line.status])).toEqual([["journal-done", "completed"], ["journal-queued", "cancelled"]]);
  expect(read("routines.json").routineRequestReceipts[0].requestId).toBe("terminal-id");
  expect(read("calendar-calls.json").calls[0].nextRunAt).toBeNull();
  expect(read("webhooks.json").deliveries[0].key).toBe("endpoint:already-run");
  expect(read("webhooks.json").webhooks[0]).toMatchObject({ enabled: false, verificationPending: true });
  expect(read("skill-state/bot/skills.json").skill.enabled).toBe(false);
  expect(existsSync(join(result.stateDirectory, "delegations.json"))).toBe(false);
  expect(read(`recovery-quarantine/${result.manifest.snapshotId}/delegations.json`).thread[0].id).toBe("queued");
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    const terminal = JSON.parse(String(db.prepare("SELECT json FROM messages WHERE id='terminal'").get()?.json));
    const pending = JSON.parse(String(db.prepare("SELECT json FROM messages WHERE id='pending'").get()?.json));
    expect(terminal).toEqual(f.messages[0]);
    expect(pending.card).toMatchObject({ answered: "Expired after restore", dismissed: true });
    // A setup card never continues a task on the restored installation.
    const setup = JSON.parse(String(db.prepare("SELECT json FROM messages WHERE id='browser-setup'").get()?.json));
    expect(setup.card).toMatchObject({ answered: "Expired after restore", dismissed: true });
    expect(setup.card.browserSetup).toMatchObject({ continueRequested: false, error: "This was waiting when the backup was made. Ask again." });
  } finally { db.close(); }
  expect(() => assertRestoreReviewed(result.stateDirectory)).toThrowError(expect.objectContaining({ code: "RESTORE_REVIEW_REQUIRED" }));
  expect(readFileSync(join(f.data, "bots.json"))).toEqual(original);
});

it("the real harness refuses prepared state before starting any provider or scheduler", async () => {
  const f = await fixture();
  const prepared = await prepareInstallationRestore(f.archive, f.root);
  const before = readFileSync(join(prepared.stateDirectory, "bots.json"));
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  let failure: any;
  try {
    await promisify(execFile)(process.execPath, [entry], { timeout: 20_000, env: { PATH: dirname(process.execPath), HOME: f.root, USERPROFILE: f.root, MURAGE_DATA_DIR: prepared.stateDirectory, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  } catch (error) { failure = error; }
  expect(failure?.code).toBe(1);
  expect(failure.stderr).toContain("RESTORE_REVIEW_REQUIRED");
  expect(readFileSync(join(prepared.stateDirectory, "bots.json"))).toEqual(before);
});

it("a malformed review marker still blocks startup instead of opting into execution", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-marker-")); roots.push(root);
  writeFileSync(join(root, RESTORE_REVIEW_FILE), "not-json");
  expect(() => assertRestoreReviewed(root)).toThrowError(expect.objectContaining({ code: "RESTORE_REVIEW_REQUIRED" }));
});

it("refuses hash-valid external section records before preparing a restore and preserves the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-section-external-")); roots.push(root);
  const archive = join(root, "external.zip");
  const bytes = Buffer.from('{"version":2,"contexts":{}}');
  const manifest = {
    format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: [{ path: "section-contexts.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
    omitted: [], missing: [], database: { status: "absent" },
  };
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, createWriteStream(archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  zip.addBuffer(bytes, "state/section-contexts.json", { compress: false, mode: 0o100600 });
  zip.end();
  await output;
  const before = readFileSync(archive);
  await expect(prepareInstallationRestore(archive, root)).rejects.toMatchObject({ code: "INVALID_INSTALLATION_RECORDS", component: "section-contexts.json" });
  expect(readFileSync(archive)).toEqual(before);
  expect(readdirSync(root)).toEqual(["external.zip"]);
});

it("refuses invalid notification quiet hours in a hash-valid external archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-notification-external-")); roots.push(root);
  const archive = join(root, "external.zip");
  const bytes = Buffer.from(JSON.stringify({ notifications: { previewContent: false, quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "Invalid/Zone" } } }));
  const manifest = {
    format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: [{ path: "config.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
    omitted: [], missing: [], database: { status: "absent" },
  };
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, createWriteStream(archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  zip.addBuffer(bytes, "state/config.json", { compress: false, mode: 0o100600 });
  zip.end(); await output;
  const before = readFileSync(archive);
  await expect(prepareInstallationRestore(archive, root)).rejects.toMatchObject({ code: "INVALID_RESTORE_CONFIG" });
  expect(readFileSync(archive)).toEqual(before);
  expect(readdirSync(root)).toEqual(["external.zip"]);
});

// SPEC-P 15.1 (lane E1): nothing waiting or running when the backup was made
// runs again by itself, and "who this bot can message" is not carried.
it("expires every open room request with no wake, keeps the owner's words, and resets who a bot can message", async () => {
  let sendId = "", runningId = "", doneId = "";
  const f = await fixture({
    bot: { messageAllow: { mode: "list", botIds: ["someone"] } },
    db: (db) => {
      initializeProjectTables(db);
      const lineage = { rootThreadId: "room-thread", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
      sendId = insertRoomRequest(db, { groupId: "room", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:room:s1", lineage, payloadText: "my unsent words", targetThreadId: "room-thread", now: 1 }).request.id;
      const done = insertRoomRequest(db, { groupId: "room", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:room:s0", lineage, now: 1 }).request;
      completeRequest(db, done.id, { state: "done", now: 2 });
      doneId = done.id;
      const running = insertRoomRequest(db, { groupId: "room", verb: "assign", fromKind: "bot", toBotId: "bot", parentId: done.id, admissionKey: "assign:x", returnBotId: "bot", returnThreadId: "room-thread", now: 3 }).request;
      markRequestDispatched(db, running.id, { now: 4 });
      runningId = running.id;
    },
  });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const bots = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"));
  expect(bots[0]).not.toHaveProperty("messageAllow");
  expect(result.modifications).toContainEqual({ component: "bots.json", action: "Who each bot can message was reset to its team." });
  expect(result.modifications).toContainEqual({ component: "messages.db", action: "2 waiting room request(s) expired: this was waiting when the backup was made; ask again" });
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, verb, state, outcome_note, payload_text FROM room_requests ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(sendId)).toMatchObject({ state: "expired", outcome_note: "restored", payload_text: "my unsent words" });
    expect(byId.get(runningId)).toMatchObject({ state: "expired", outcome_note: "restored" });
    expect(byId.get(doneId)).toMatchObject({ state: "done" });
    expect(rows.some((row) => row.verb === "wake")).toBe(false);
  } finally { db.close(); }
});

it("prepares project rows inside the archive transaction and review rejects reopened authority", async () => {
  const f = await fixture();
  const { initializeProjectTables } = await import("./project-tables.ts");
  const { channelToProjectRows } = await import("./project-settings.ts");
  const { reviewInstallation } = await import("./installation-activation.ts");
  const groups = JSON.parse(readFileSync(join(f.data, "groups.json"), "utf8"));
  groups[0].channelProject = { goal: "Keep it", status: "active", startedAt: 1, updatedAt: 1 };
  writeFileSync(join(f.data, "groups.json"), JSON.stringify(groups));
  const source = new DatabaseSync(join(f.data, "messages.db"));
  initializeProjectTables(source);
  channelToProjectRows(source, { groupId: "room", leadBotId: "bot", bulletin: "Rules", now: 1 });
  source.close();
  const archive = join(f.root, "projects.zip");
  const saved = await writeInstallationArchive(f.data, archive);
  const { restoreInstallation } = await import("./installation-restore.ts");
  const target = join(f.root, "project-restored");
  await restoreInstallation(target, archive, saved.sha256, { requireNew: true });
  const db = new DatabaseSync(join(target, "messages.db"));
  expect(db.prepare("SELECT run_state, work_roots, work_profile FROM project_settings").get()).toMatchObject({ run_state: "paused", work_roots: "[]", work_profile: "ask" });
  db.close();
  expect(() => reviewInstallation(target)).not.toThrow();
  const changed = new DatabaseSync(join(target, "messages.db"));
  changed.prepare("UPDATE project_settings SET run_state='running'").run();
  changed.close();
  expect(() => reviewInstallation(target)).toThrowError(expect.objectContaining({ code: "RESTORE_WORK_NOT_PAUSED" }));
});

it("restores X work markers as closed partitions and quarantines invalid work before activation",async()=>{
  const team=randomUUID();
  const f=await fixture({bot:{sharedWith:{mode:"all",teams:[]},tasks:[{threadId:"thread",title:"Work",sharedWork:{teamId:team,createdAt:1,finishing:{generation:"old"}}},{threadId:"duplicate",title:"Duplicate",sharedWork:{teamId:team,createdAt:1}},{threadId:"invalid",title:"Invalid",sharedWork:{teamId:"../invalid",createdAt:1},channelProjectDesk:{groupId:"room"}}]}});
  const prepared=await prepareInstallationRestore(f.archive,f.root),bot=JSON.parse(readFileSync(join(prepared.stateDirectory,"bots.json"),"utf8"))[0];
  expect(bot.sharedWith).toBeUndefined();expect(bot.partitionedAt).toBeTypeOf("number");
  expect(bot.tasks[0].sharedWork).toMatchObject({teamId:team,closedReason:"restored"});expect(bot.tasks[0].sharedWork.finishing).toBeUndefined();
  expect(bot.tasks[1].sharedWork).toMatchObject({quarantined:true,closedReason:"restored"});expect(bot.tasks[2].sharedWork).toMatchObject({quarantined:true,closedReason:"restored"});
  expect(prepared.modifications.some(note=>note.action.includes("Quarantined"))).toBe(true);
});


it("R3c C7: repair malformed sharing before replaying a restored rename journal",async()=>{
 const id="a1111111-1111-4111-8111-111111111111";
 const f=await fixture({bot:{section:"Sales",sharedWith:{mode:"list"}},db:db=>{
  migrateMemorySchema(db);
  initializeTeamIdentityTables(db);
  db.prepare("INSERT INTO team_identities(team_id,label,created_at,updated_at,op,op_phase,op_label,op_records,op_since) VALUES(?,'Sales',1,1,'rename',1,'Revenue',?,1)").run(id,JSON.stringify({bots:["bot"],groups:[]}));
 }});
 const result=await prepareInstallationRestore(f.archive,f.root);
 const bots=JSON.parse(readFileSync(join(result.stateDirectory,"bots.json"),"utf8"));
 expect(bots[0]).toMatchObject({section:"Revenue"});expect(bots[0].sharedWith).toBeUndefined();
});
it("R4d C-r3 4: a restored stalled rename with both memory scopes rolls back to the earlier name and adds a note",async()=>{
 const id="b2222222-2222-4222-8222-222222222222";
 const f=await fixture({bot:{section:"Revenue"},db:db=>{
  migrateMemorySchema(db);
  initializeTeamIdentityTables(db);
  db.prepare("INSERT INTO memory_scopes VALUES(?,'team','Sales','[]',0)").run(randomUUID());
  db.prepare("INSERT INTO memory_scopes VALUES(?,'team','Revenue','[]',0)").run(randomUUID());
  db.prepare("INSERT INTO team_identities(team_id,label,created_at,updated_at,op,op_phase,op_label,op_records,op_since) VALUES(?,'Sales',1,1,'rename',3,'Revenue',?,1)").run(id,JSON.stringify({bots:["bot"],groups:["room"]}));
 }});
 const groups=JSON.parse(readFileSync(join(f.data,"groups.json"),"utf8"));groups[0]={...groups[0],name:"Revenue",section:"Revenue"};writeFileSync(join(f.data,"groups.json"),JSON.stringify(groups));
 const archive=join(f.root,"stalled-rename.zip");await writeInstallationArchive(f.data,archive);
 const result=await prepareInstallationRestore(archive,f.root);
 const read=(path:string)=>JSON.parse(readFileSync(join(result.stateDirectory,path),"utf8"));
 expect(read("bots.json")[0]).toMatchObject({section:"Sales"});expect(read("groups.json")[0]).toMatchObject({section:"Sales",name:"Sales"});
 expect(result.modifications.map(note=>note.action)).toContain("A team rename could not finish; the team keeps its earlier name.");
 const db=new DatabaseSync(join(result.stateDirectory,"messages.db"));
 try{expect(db.prepare("SELECT label,op,op_label FROM team_identities WHERE team_id=?").get(id)).toMatchObject({label:"Sales",op:null,op_label:null});
  expect(db.prepare("SELECT count(*) AS n FROM memory_scopes WHERE kind='team'").get()).toMatchObject({n:2});}finally{db.close();}
});
it("R3c C7: restored quarantined work produces one repair note",async()=>{
 const f=await fixture({bot:{tasks:[{threadId:"thread",title:"Invalid work",resumeCursors:{},sharedWork:{teamId:"invalid",createdAt:1}}]}});
 const result=await prepareInstallationRestore(f.archive,f.root);
 expect(result.modifications.filter(note=>note.action==="Quarantined work conversation thread.")).toHaveLength(1);
});

it("does not add memory to a legacy archive or report memory paused",async()=>{
 const f=await fixture(),result=await prepareInstallationRestore(f.archive,f.root);
 const db=new DatabaseSync(join(result.stateDirectory,"messages.db"),{readOnly:true});
 try{expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_%'").all()).toEqual([]);}finally{db.close();}
 expect(result.modifications.some(item=>item.action.startsWith("Memory paused"))).toBe(false);
});

// "Make images without asking" is spend authority the old computer granted: a
// restored bot follows its permission level (which a restore resets to Ask)
// until the owner chooses it again. "Ask before each image" and the guard only
// ask more, so they come back as they were.
it("resets Make images without asking on a restore and keeps the settings that only ask more", async () => {
  const f = await fixture({ bot: { imageApproval: "allow", imageAskAfter: 4 } });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const [bot] = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"));
  expect(bot).not.toHaveProperty("imageApproval");
  expect(bot.imageAskAfter).toBe(4);
  expect(result.modifications).toContainEqual({ component: "bots.json", action: "Bots set to make images without asking now follow their permission level." });
  const asks = await fixture({ bot: { imageApproval: "ask" } });
  const kept = JSON.parse(readFileSync(join((await prepareInstallationRestore(asks.archive, asks.root)).stateDirectory, "bots.json"), "utf8"));
  expect(kept[0].imageApproval).toBe("ask");
});

// Bot learning (T1-17): the customer-message opt-in is a grant; a backup never brings it back.
it("a restore does not switch customer-message learning back on, and keeps the other learning choices", async () => {
  const f = await fixture({ bot: { learning: { enabled: true, askFirst: true, prospectLearning: true, prospectThreadIds: ["t1"], revision: 3 } } });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const bots = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"));
  expect(bots[0].learning).toMatchObject({ enabled: true, askFirst: true, prospectLearning: false, prospectThreadIds: [] });
  expect(result.modifications).toContainEqual({ component: "bots.json", action: "Learning from customer and audience messages was turned off; choose it again if you want it." });
});

it("carries the message search index through a prepared restore and keeps it matching its rows", async () => {
  // The preparation pass rewrites message JSON (expiring open cards) and runs the
  // archive inspector over the database: neither may orphan or refuse the search index.
  const f = await fixture({
    db: (db) => {
      const add = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
      const index = db.prepare("INSERT INTO messages_fts(rowid, t) VALUES(?, ?)");
      for (const [id, at, text] of [["s1", 10, "searchable Railway deploy note"], ["s2", 11, "日本語の検索"]] as const) {
        const row = add.run("thread", id, at, "user", "text", text, JSON.stringify({ id, at, role: "user", kind: "text", text, parentId: "browser-setup" }));
        index.run(row.lastInsertRowid, text);
      }
    },
  });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    const hits = (query: string) =>
      db.prepare("SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id").all(trigramQuery(query)).map((row) => row.id);
    expect(hits("railway")).toEqual(["s1"]);
        expect(hits("日本語")).toEqual(["s2"]);
  } finally { db.close(); }
});

it("PIP: a restore with memory comes back paused, with the continuity rows kept and the bot's continuity switch still true", async () => {
  const f = await fixture({
    bot: { continuity: true },
    db: db => {
      migrateMemorySchema(db);
      db.prepare("UPDATE memory_meta SET mode='active' WHERE id=1").run();
      db.exec("INSERT INTO memory_scopes VALUES('pip-scope','bot','bot','[\"bot\"]',1)");
      db.exec("INSERT INTO memory_records VALUES('identity:pip-fixture',1,'pip-scope','commitment','Kept across a restore.','owner-statement','active',0,1,NULL,NULL,1)");
      db.exec("UPDATE memory_record_details SET partition='identity' WHERE record_id='identity:pip-fixture'");
    },
  });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const bots = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"));
  expect(bots[0].continuity).toBe(true);
  expect(result.modifications.some(item => item.action.startsWith("Memory paused"))).toBe(true);
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    expect(db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode).toBe("paused");
    expect(db.prepare("SELECT state FROM memory_records WHERE id='identity:pip-fixture'").get()?.state).toBe("active");
    expect(db.prepare("SELECT partition FROM memory_record_details WHERE record_id='identity:pip-fixture'").get()?.partition).toBe("identity");
    // continuity rows are not part of the rebuilt recall index: no receipt was ever queued for them
    expect(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id='identity:pip-fixture'").get()?.n).toBe(0);
  } finally { db.close(); }
});
