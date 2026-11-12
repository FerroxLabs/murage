import { DATA_DIR } from "./config.ts";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { newId } from "./contracts.ts";
import { isReservedBotId, CANARY_BROWSER_ID } from "../shared/bot-identity.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore as prepareOfflineRestore } from "./installation-restore-preparation.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { stopSearchIndex, trigramQuery } from "./message-search-index.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { migrateMemorySchema } from "./memory/schema.ts";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeDelegationPacks } from "./delegation-pack/schema.ts";
import { completeRequest, insertRoomRequest, markRequestDispatched } from "./room-requests.ts";
import { assertRestoreReviewed, RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => servingDatabase.closeDatabase());
async function prepareInstallationRestore(...args: Parameters<typeof prepareOfflineRestore>) {
  const closed = servingDatabase.databaseSharedRowsStamp() === undefined;
  const acquire = vi.spyOn(servingDatabase, "database");
  const transaction = vi.spyOn(servingDatabase, "transaction");
  try { return await prepareOfflineRestore(...args); }
  finally {
    expect(acquire).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    if (closed) expect(servingDatabase.databaseSharedRowsStamp()).toBeUndefined();
    acquire.mockRestore(); transaction.mockRestore();
  }
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture(customize?: { bot?: Record<string, unknown>; group?: Record<string, unknown>; db?: (db: DatabaseSync) => void; withoutLegacyQueueFile?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-preparation-"));
  roots.push(root);
  const data = join(root, "source");
  mkdirSync(data);
  const put = (path: string, value: unknown) => { mkdirSync(dirname(join(data, path)), { recursive: true }); writeFileSync(join(data, path), JSON.stringify(value)); };
  put("config.json", { instances: { fake: { driver: "claudeAgent", enabled: true, config: { cli: "must-not-run" } } }, features: { browser: true, skillRecorder: true } });
  put("bots.json", [{ id: "bot", threadId: "thread", name: "Preserved bot", autoApprove: true, autoReview: "enforce", alwaysAllow: ["Bash:sh"], computer: "cloud", autoStartVps: true, browser: true, useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "profile_1", composio: true, busy: true, resumePolicies: { engine: { root: "/old", sha256: "hash" } }, replayPending: { engine: { cursor: "kept" } }, tasks: [{ threadId: "thread", title: "Keep me", autoApprove: true, alwaysAllow: ["Bash:sh"], resumePolicies: { engine: { root: "/old", sha256: "hash" } }, replayPending: { engine: { cursor: "kept" } }, resumeSeals: { engine: { cursor: "kept", generation: 1 } }, resumeCursors: { old: "cursor" } }], ...customize?.bot }]);
  put("groups.json", [{ id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], working: true, busyBotId: "bot", ...customize?.group }]);
  const run = { routineId: "routine", routineName: "Routine", botId: "bot", target: "bot", runOn: "ember", scheduledFor: 1, manual: true, createdAt: 1 };
  put("routines.json", { version: 1, routines: [{ id: "routine", name: "Routine", prompt: "Task", botId: "bot", target: "bot", runOn: "ember", enabled: true, schedule: { type: "once", at: 1 }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1 }], runs: [{ ...run, id: "done", status: "completed", result: "immutable receipt" }, { ...run, id: "queued", status: "queued" }], routineRequestReceipts: [{ requestId: "terminal-id", messageId: "terminal", botId: "bot", threadId: "thread", action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: "routine", appliedAt: 1 }] });
  mkdirSync(join(data, "events", "routine-runs"), { recursive: true });
  writeFileSync(join(data, "events", "routine-runs", "routine.jsonl"), [{ ...run, id: "journal-done", status: "completed" }, { ...run, id: "journal-queued", status: "queued" }].map(line => JSON.stringify(line)).join("\n") + "\n");
  put("calendar-calls.json", { version: 1, calls: [{ id: "call", name: "Call", description: "Fixture", botIds: ["bot"], schedule: { type: "once", at: 1 }, durationMinutes: 30, attachments: [], createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 10 }] });
  put("webhooks.json", { version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", name: "Hook", prompt: "Task", botId: "bot", runOn: "ember", createdAt: 1, updatedAt: 1, deliveryCount: 1, enabled: true, secretHash: "b".repeat(64) }], deliveries: [{ key: "endpoint:already-run", runId: "done", at: 1 }] });
  if (!customize?.withoutLegacyQueueFile) put("delegations.json", { thread: [{ id: "queued", message: "Never replay automatically" }] });
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
    for (const message of messages) db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, null, JSON.stringify(message));
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
  // A restore pauses execution for review: the default-on browser and Teach a skill come back off
  // as explicit choices here, while an ordinary upgrade (no stored flag) keeps both on.
  expect(read("config.json").features).toEqual({ browser: false, skillRecorder: false, showToolCalls: false });
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
  expect(read("bots.json")[0].resumePolicies).toBeUndefined();
  expect(read("bots.json")[0].replayPending).toBeUndefined();
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
    await promisify(execFile)(process.execPath, [entry], { windowsHide: true, timeout: 20_000, env: { PATH: dirname(process.execPath), HOME: f.root, USERPROFILE: f.root, MURAGE_DATA_DIR: prepared.stateDirectory, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
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

it.each(["mcp-grants.json", "MCP-grants.json", "Mcp-Grants.JSON"])("never installs a script-access grants file spelled %s, as a case-insensitive volume would open it, and still completes", async name => {
  const root = mkdtempSync(join(tmpdir(), "murage-case-fold-")); roots.push(root);
  const archive = join(root, "external.zip");
  const bytes = Buffer.from("{}");
  const manifest = {
    format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: [{ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
    omitted: [], missing: [], database: { status: "absent" },
  };
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, createWriteStream(archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  zip.addBuffer(bytes, `state/${name}`, { compress: false, mode: 0o100600 });
  zip.end();
  await output;
  const result = await prepareInstallationRestore(archive, root);
  expect(readdirSync(result.stateDirectory).map(entry => entry.toLowerCase())).not.toContain("mcp-grants.json");
  expect(result.modifications).toContainEqual({ component: name, action: "Not something Murage restores, so the restore leaves it out" });
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

it("carries search through restore and discards saved summaries for the resumable fill", async () => {
  // The preparation pass rewrites message JSON (expiring open cards) and runs the
  // archive inspector over the database: neither may orphan or refuse the search index.
  const f = await fixture({
    db: (db) => {
      // Explicit legacy archive: 1.0.19 serving opens no longer create this table.
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)");
      const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
      const index = db.prepare("INSERT INTO messages_fts(rowid, t) VALUES(?, ?)");
      for (const [id, at, text] of [["s1", 10, "searchable Railway deploy note"], ["s2", 11, "日本語の検索"]] as const) {
        const row = add.run("thread", id, at, "user", "text", text, JSON.stringify({ id, at, role: "user", kind: "text", text, parentId: "browser-setup" }));
        index.run(row.lastInsertRowid, text);
      }
      db.prepare("INSERT INTO thread_summary(thread_id,last_at,last_role,last_from,snippet) VALUES('thread',11,'user',NULL,'stale restored preview')").run();
    },
  });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    const hits = (query: string) =>
      db.prepare("SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id").all(trigramQuery(query)).map((row) => row.id);
    expect(hits("railway")).toEqual(["s1"]);
    expect(hits("日本語")).toEqual(["s2"]);
    expect(db.prepare("SELECT * FROM thread_summary").all()).toEqual([]);
    expect(db.prepare("SELECT done,cursor FROM transcript_index_state WHERE name='thread_summary'").get()).toEqual({ done: 0, cursor: 0 });
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

// Astra r20 (e): handoffs queued in the backup's messages.db never run after a restore.
const queueRows = (db: DatabaseSync, count: number) => {
  initializePendingDelegations(db);
  const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,?,?,?)");
  for (let i = 0; i < count; i++) insert.run(`q-${i}`, `src-${i % 7}`, "peer", "bot", i % 3 === 0 ? "busy" : "fresh", i % 3 === 0 ? 5 : null, JSON.stringify({ message: `queued ${i}`, depth: 0, attempts: 0 }));
};
it.each([0, 1])("T-GONE: restore removes packs with %i pending handoffs; kills missing restore deletion", async pending => {
  const f = await fixture({ withoutLegacyQueueFile: true, db: db => {
    queueRows(db, pending);
    initializeDelegationPacks(db);
    db.prepare("INSERT INTO delegation_packs VALUES('pack','q-0','thread','bot','peer','target','[\"terminal\"]','[]',1,1)").run();
  } });
  const source = new DatabaseSync(join(f.data, "messages.db"), { readOnly: true });
  try { expect(source.prepare("SELECT count(*) AS n FROM delegation_packs").get()?.n).toBe(1); } finally { source.close(); }
  const prepared = await prepareInstallationRestore(f.archive, f.root);
  const restored = new DatabaseSync(join(prepared.stateDirectory, "messages.db"), { readOnly: true });
  try { expect(restored.prepare("SELECT count(*) AS n FROM delegation_packs").get()?.n).toBe(0); } finally { restored.close(); }
});
it("a restore with 50 queued handoffs leaves the table empty, keeps the rows as evidence, and activation passes; a row put back is refused", async () => {
  const f = await fixture({ withoutLegacyQueueFile: true, db: (db) => queueRows(db, 50) });
  const prepared = await prepareInstallationRestore(f.archive, f.root);
  expect(prepared.modifications).toContainEqual({ component: "messages.db", action: "50 queued handoffs moved to recovery-quarantine; none runs after the restore" });
  const evidence = JSON.parse(readFileSync(join(prepared.stateDirectory, "recovery-quarantine", prepared.manifest.snapshotId, "delegations.json"), "utf8")) as Record<string, Array<{ id: string; message: string }>>;
  expect(Object.values(evidence).flat()).toHaveLength(50);
  expect(evidence["src-0"]![0]).toMatchObject({ id: "q-0", message: "queued 0" });
  const restored = new DatabaseSync(join(prepared.stateDirectory, "messages.db"), { readOnly: true });
  try { expect(restored.prepare("SELECT COUNT(*) AS n FROM pending_delegations").get()).toEqual({ n: 0 }); } finally { restored.close(); }
  // the full restore path: archive, restore, review
  const { restoreInstallation } = await import("./installation-restore.ts");
  const { reviewInstallation } = await import("./installation-activation.ts");
  const target = join(f.root, "queue-restored");
  const saved = await writeInstallationArchive(f.data, join(f.root, "queue.zip"));
  await restoreInstallation(target, join(f.root, "queue.zip"), saved.sha256, { requireNew: true });
  expect(() => reviewInstallation(target)).not.toThrow();
  const put = new DatabaseSync(join(target, "messages.db"));
  try { queueRows(put, 1); } finally { put.close(); }
  expect(() => reviewInstallation(target)).toThrowError(expect.objectContaining({ code: "RESTORE_WORK_NOT_PAUSED" }));
});
it("when the backup also carries a delegations.json, both are kept as evidence under their own names", async () => {
  const f = await fixture({ db: (db) => queueRows(db, 3) });
  const prepared = await prepareInstallationRestore(f.archive, f.root);
  const dir = join(prepared.stateDirectory, "recovery-quarantine", prepared.manifest.snapshotId);
  expect(JSON.parse(readFileSync(join(dir, "delegations.json"), "utf8")).thread[0].id).toBe("queued");
  expect(Object.values(JSON.parse(readFileSync(join(dir, "delegations-table.json"), "utf8"))).flat()).toHaveLength(3);
});
it("T17 a reserved id in bots.json or groups.json is refused; ui-canary stays a valid id", async () => {
  for (const reserved of [CANARY_BROWSER_ID, "__murage-x"]) {
    const asBot = await fixture({ bot: { id: reserved } });
    await expect(prepareInstallationRestore(asBot.archive, asBot.root)).rejects.toMatchObject({ code: "RESERVED_RESTORE_ID" });
    const asGroup = await fixture({ group: { id: reserved } });
    await expect(prepareInstallationRestore(asGroup.archive, asGroup.root)).rejects.toMatchObject({ code: "RESERVED_RESTORE_ID" });
  }
  const plain = await fixture({ group: { id: "ui-canary" } });
  await expect(prepareInstallationRestore(plain.archive, plain.root)).resolves.toBeTruthy();
});
it("T18 createBot's ids and package import's ids can never be reserved", () => {
  for (let i = 0; i < 50; i++) expect(isReservedBotId(newId())).toBe(false);   // createBot: id: newId()
  const uuid = z.string().uuid();                                              // package-import-transaction.ts
  expect(uuid.safeParse(CANARY_BROWSER_ID).success).toBe(false);
  expect(uuid.safeParse("__murage-00000000-0000-4000-8000-000000000000").success).toBe(false);
});

it("a restored conversation drops the old installation's app-made working folder and keeps a folder the owner chose (A1)", async () => {
  const f = await fixture({ bot: { tasks: [
    { threadId: "thread", title: "Local", cwd: "/old/Murage/workspaces/bot/threads/thread", resumeCursors: {} },
    { threadId: "thread-two", title: "Windows", cwd: "C:\\Users\\old\\AppData\\Murage\\workspaces\\bot\\threads\\thread-two\\", resumeCursors: {} },
    { threadId: "thread-three", title: "Chosen", cwd: "/home/owner/project", resumeCursors: {} },
    { threadId: "thread-four", title: "Other bot", cwd: "/old/Murage/workspaces/other/threads/thread-four", resumeCursors: {} },
  ] } });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const tasks = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"))[0].tasks;
  expect(tasks.map((task: any) => task.cwd)).toEqual([undefined, undefined, "/home/owner/project", "/old/Murage/workspaces/other/threads/thread-four"]);
});

import { vi } from "vitest";
import { initializeChatsPreviewStorage, readChatsGen, remintChatsGen, prepareThreadSummaryBackfill } from "./thread-summary.ts";
import { RetainedRestorePreparationError } from "./installation-restore-preparation.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";

it.each(["absent tables", "absent singleton", "existing singleton"])("T-RESTORE-PREP prepares %s and preserves its epoch on open", async shape => {
  const f = await fixture({ db: db => {
    if (shape === "absent tables") db.exec("DROP TABLE IF EXISTS thread_summary");
    else if (shape === "absent singleton") initializeChatsPreviewStorage(db);
    else remintChatsGen(db);
  } });
  const archive = readFileSync(f.archive);
  const result = await prepareInstallationRestore(f.archive, f.root);
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"));
  try {
    const gen = readChatsGen(db);
    expect(gen).toEqual({ epoch: expect.stringMatching(/^[a-f0-9]{32}$/), rev: 0 });
    prepareThreadSummaryBackfill(db);
    expect(readChatsGen(db)).toEqual(gen);
    inspectInstallationDatabase(db);
  } finally { db.close(); }
  expect(readFileSync(f.archive)).toEqual(archive);
});

it.each(["create", "insert", "update", "commit"])("T-RESTORE-RETAIN keeps a blocked candidate after remint %s failure", async fault => {
  const f = await fixture();
  const archive = readFileSync(f.archive);
  const rawExec = DatabaseSync.prototype.exec, rawPrepare = DatabaseSync.prototype.prepare;
  let remintHandle: DatabaseSync | undefined;
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS chats_gen")) {
      remintHandle = this;
      if (fault === "create") throw new Error("remint injected failure");
    }
    if (this === remintHandle && sql === "COMMIT" && fault === "commit") throw new Error("remint injected failure");
    return rawExec.call(this, sql);
  });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this === remintHandle && (fault === "insert" && sql.startsWith("INSERT OR IGNORE INTO chats_gen") || fault === "update" && sql.startsWith("UPDATE chats_gen"))) throw new Error("remint injected failure");
    return rawPrepare.call(this, sql);
  });
  let error: unknown;
  try { await prepareInstallationRestore(f.archive, f.root); } catch (caught) { error = caught; }
  finally { exec.mockRestore(); prepare.mockRestore(); }
  expect(error).toBeInstanceOf(RetainedRestorePreparationError);
  const retained = error as RetainedRestorePreparationError;
  expect(retained.activationAvailable).toBe(false);
  expect(existsSync(retained.stateDirectory)).toBe(true);
  expect(JSON.parse(readFileSync(join(retained.stateDirectory, RESTORE_REVIEW_FILE), "utf8")).status).toBe("preparing");
  expect(() => assertRestoreReviewed(retained.stateDirectory)).toThrow();
  const db = new DatabaseSync(join(retained.stateDirectory, "messages.db"), { readOnly: true });
  try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='chats_gen'").get()).toBeUndefined(); }
  finally { db.close(); }
  expect(readFileSync(f.archive)).toEqual(archive);
  const retry = await prepareInstallationRestore(f.archive, f.root);
  expect(retry.stateDirectory).not.toBe(retained.stateDirectory);
});

import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import * as servingDatabase from "./database.ts";
import { registerChatsGenPublisher } from "./thread-summary.ts";

it.each(["absent tables", "absent singleton", "existing singleton"].flatMap(shape => ["create", "insert", "update", "rng", "commit", "close"].map(fault => ({ shape, fault }))))("BF-1 supplied-handle isolation: $shape / $fault", async ({shape, fault}) => {
  const f = await fixture({ db: db => {
    if (shape === "absent tables") db.exec("DROP TABLE IF EXISTS thread_summary");
    else if (shape === "absent singleton") initializeChatsPreviewStorage(db);
    else remintChatsGen(db);
  }});
  const archive = readFileSync(f.archive);
  mkdirSync(DATA_DIR, { recursive: true });
  const serving = servingDatabase.database(), servingGen = readChatsGen(serving), send = vi.fn();
  // 5d5a791f19 starts an independent search reset transaction on this handle. Join it before spying on restore.
  expect(await stopSearchIndex()).toBe(true);
  const dispose = registerChatsGenPublisher(serving, send);
  const servingExec = vi.spyOn(serving, "exec");
  const accessor = vi.spyOn(servingDatabase, "database");
  const rawExec = DatabaseSync.prototype.exec, rawPrepare = DatabaseSync.prototype.prepare, rawClose = DatabaseSync.prototype.close;
  const snapshot = (db: DatabaseSync) => ({
    schema: rawPrepare.call(db, "SELECT name,sql FROM sqlite_schema WHERE name IN ('thread_summary','chats_gen') ORDER BY name").all(),
    gen: rawPrepare.call(db,"SELECT 1 FROM sqlite_schema WHERE name='chats_gen'").get() ? rawPrepare.call(db,"SELECT * FROM chats_gen").all() : null,
    previews: rawPrepare.call(db,"SELECT 1 FROM sqlite_schema WHERE name='thread_summary'").get() ? rawPrepare.call(db,"SELECT * FROM thread_summary").all() : null,
  });
  let candidate: DatabaseSync | undefined, before: ReturnType<typeof snapshot> | undefined, committed = false;
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS chats_gen") && this !== serving) {
      candidate = this; before = snapshot(this);
      if (fault === "create") throw Error("C2 injected create");
    }
    if (this === candidate && sql === "COMMIT") {
      if (fault === "commit") throw Error("C2 injected commit");
      committed = true;
    }
    return rawExec.call(this, sql);
  });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this === candidate && (fault === "insert" && sql.startsWith("INSERT OR IGNORE INTO chats_gen") || fault === "update" && sql.startsWith("UPDATE chats_gen"))) throw Error("C2 injected mutation");
    return rawPrepare.call(this,sql);
  });
  const close = vi.spyOn(DatabaseSync.prototype,"close").mockImplementation(function(this: DatabaseSync) { rawClose.call(this); if (this === candidate && fault === "close") throw Error("C2 injected close"); });
  const random = crypto.randomBytes;
  const rng = vi.spyOn(crypto,"randomBytes").mockImplementation(((...args: Parameters<typeof random>) => { if (candidate && !committed && fault === "rng") throw Error("C2 injected rng"); return (random as Function)(...args); }) as typeof random);
  syncBuiltinESMExports();
  let failure: unknown;
  try { await prepareInstallationRestore(f.archive,f.root); } catch(error) { failure=error; }
  finally { exec.mockRestore(); prepare.mockRestore(); close.mockRestore(); rng.mockRestore(); syncBuiltinESMExports(); }
  try {
    expect(failure).toBeInstanceOf(RetainedRestorePreparationError);
    const retained = failure as RetainedRestorePreparationError;
    expect(retained.activationAvailable).toBe(false); expect(existsSync(retained.stateDirectory)).toBe(true);
    expect(JSON.parse(readFileSync(join(retained.stateDirectory, RESTORE_REVIEW_FILE),"utf8")).status).toBe("preparing");
    expect(() => assertRestoreReviewed(retained.stateDirectory)).toThrow();
    const reopened = new DatabaseSync(join(retained.stateDirectory,"messages.db"), { readOnly:true });
    try { if (fault === "close") { expect(readChatsGen(reopened).rev).toBe(0); expect(snapshot(reopened)).not.toEqual(before); } else expect(snapshot(reopened)).toEqual(before); } finally { reopened.close(); }
    expect(readFileSync(f.archive)).toEqual(archive);
    expect(servingExec.mock.calls.filter(([sql]) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(sql))).toEqual([]); expect(accessor).not.toHaveBeenCalled();
    expect(readChatsGen(serving)).toEqual(servingGen);
    await new Promise(resolve => setTimeout(resolve, 300)); expect(send).not.toHaveBeenCalled();
  } finally { dispose(); servingExec.mockRestore(); accessor.mockRestore(); servingDatabase.closeDatabase(); }
});

import { reviewInstallation, activateInstallation } from "./installation-activation.ts";
it.each(["before", "inside", "after"])("T-RESTORE-RETAIN: a process crash %s remint retains a blocked candidate and a fresh retry", async point => {
  const f = await fixture(); const archive = readFileSync(f.archive);
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { prepareInstallationRestore } from ${JSON.stringify(new URL("./installation-restore-preparation.ts", import.meta.url).href)};
    const raw=DatabaseSync.prototype.exec; let preview=false;
    DatabaseSync.prototype.exec=function(sql) {
      const candidate = String(this.prepare("PRAGMA database_list").get().file).endsWith("/state/messages.db");
      if (candidate && ${JSON.stringify(point)}==='before' && sql==='BEGIN IMMEDIATE') process.exit(71);
      if(candidate && sql.includes('CREATE TABLE IF NOT EXISTS chats_gen')) preview=true;
      const value=raw.call(this,sql);
      if(preview && (${JSON.stringify(point)}==='inside' && sql.includes('CREATE TABLE IF NOT EXISTS chats_gen') || ${JSON.stringify(point)}==='after' && sql==='COMMIT')) process.exit(71);
      return value;
    };
    await prepareInstallationRestore(${JSON.stringify(f.archive)},${JSON.stringify(f.root)});
    process.exit(72);
  `;
  await expect(promisify(execFile)(process.execPath,["--input-type=module","-e",source],{ windowsHide: true,timeout:30_000,env:{...process.env,MURAGE_DATA_DIR:join(f.root,"child-private")}}).catch(error => { if(error.code!==71) console.error(error.stderr); throw error; })).rejects.toMatchObject({code:71});
  const retained = readdirSync(f.root).map(name=>join(f.root,name,"state")).filter(path=>existsSync(join(path,RESTORE_REVIEW_FILE)));
  expect(retained).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(retained[0],RESTORE_REVIEW_FILE),"utf8")).status).toBe("preparing");
  expect(()=>assertRestoreReviewed(retained[0])).toThrow(); expect(()=>reviewInstallation(retained[0])).toThrow();
  const db=new DatabaseSync(join(retained[0],"messages.db"),{readOnly:true});
  try { if(point==='after') expect(readChatsGen(db).rev).toBe(0); else expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='chats_gen'").get()).toBeUndefined(); } finally {db.close();}
  expect(readFileSync(f.archive)).toEqual(archive);
  const retry=await prepareInstallationRestore(f.archive,f.root);
  expect(retry.stateDirectory).not.toBe(retained[0]); expect(existsSync(retained[0])).toBe(true);
  const { restoreInstallation } = await import("./installation-restore.ts");
  const installed = join(f.root, "retry-installed");
  await restoreInstallation(installed, f.archive, createHash("sha256").update(archive).digest("hex"), { requireNew: true });
  const review=reviewInstallation(installed);
  expect(review.activationAvailable).toBe(true);
  expect(activateInstallation(installed,review.reviewHash).status).toBe("reviewed-engines-disabled");
});

it.each(["absent tables", "absent singleton", "existing singleton"])("T-RESTORE-PREP cold process prepares %s without a serving construction and real reopen preserves its epoch",async shape=>{
  const f=await fixture({db:db=>{
    if(shape==="absent tables")db.exec("DROP TABLE IF EXISTS thread_summary");
    else if(shape==="absent singleton")initializeChatsPreviewStorage(db);
    else remintChatsGen(db);
  }});
  const forbidden=join(f.root,"must-not-open-serving");
  const source=`
    import sqlite from 'node:sqlite';
    const Original=sqlite.DatabaseSync, opens=[], seen=new Set();
    const rawExec=Original.prototype.exec, rawPrepare=Original.prototype.prepare;
    const observe=db=>{if(seen.has(db))return;seen.add(db);const file=String(rawPrepare.call(db,'PRAGMA database_list').get().file)||':memory:';
      opens.push(file);if(file===${JSON.stringify(join(forbidden,"messages.db"))})throw Error('serving connection during offline preparation');};
    Original.prototype.exec=function(sql){observe(this);return rawExec.call(this,sql);};
    Original.prototype.prepare=function(sql){observe(this);return rawPrepare.call(this,sql);};
    const {prepareInstallationRestore}=await import(${JSON.stringify(new URL("./installation-restore-preparation.ts",import.meta.url).href)});
    const result=await prepareInstallationRestore(${JSON.stringify(f.archive)},${JSON.stringify(f.root)});
    const db=new sqlite.DatabaseSync(result.stateDirectory+'/messages.db',{readOnly:true});
    const gen=db.prepare('SELECT epoch,rev FROM chats_gen WHERE id=1').get();db.close();
    await new Promise(done=>setTimeout(done,300));
    console.log('COLD_RESULT '+JSON.stringify({stateDirectory:result.stateDirectory,gen,opens}));
  `;
  const child=await promisify(execFile)(process.execPath,["--input-type=module","-e",source],{ windowsHide: true,env:{...process.env,MURAGE_DATA_DIR:forbidden},timeout:30_000});
  const result=JSON.parse(child.stdout.split("COLD_RESULT ")[1]);
  expect(result.opens).not.toContain(join(forbidden,"messages.db"));expect(result.opens).toContain(":memory:");
  expect(result.gen).toEqual({epoch:expect.stringMatching(/^[a-f0-9]{32}$/),rev:0});expect(existsSync(forbidden)).toBe(false);
  const reopen=`const {database,closeDatabase}=await import(${JSON.stringify(new URL("./database.ts",import.meta.url).href)});const db=database();console.log('OPEN_RESULT '+JSON.stringify(db.prepare('SELECT epoch,rev FROM chats_gen WHERE id=1').get()));closeDatabase();`;
  const opened=await promisify(execFile)(process.execPath,["--input-type=module","-e",reopen],{ windowsHide: true,env:{...process.env,MURAGE_DATA_DIR:result.stateDirectory},timeout:30_000});
  expect(JSON.parse(opened.stdout.split("OPEN_RESULT ")[1].split("\n")[0])).toEqual(result.gen);
},60_000);

it("T-RESTORE-ROTATE: restoring an owner's own backup changes search identity inside the candidate transaction", async () => {
  const f = await fixture({ db: db => {
    db.exec("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',1,0,0)");
  } });
  const result = await prepareInstallationRestore(f.archive, f.root);
  const db = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
  try {
    const owner = db.prepare("SELECT * FROM transcript_index_state WHERE name='search_owner'").get();
    expect(owner).toMatchObject({ name: "search_owner", done: expect.any(String), cursor: 0, skipped: 0 });
    expect(owner).not.toEqual({ name: "search_owner", done: 1, cursor: 0, skipped: 0 });
  } finally { db.close(); }
});
