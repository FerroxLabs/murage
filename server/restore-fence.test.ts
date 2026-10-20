// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, restore fence, round 7 (Astra r6): after a restore NOTHING that was pending at backup time
// runs or creates new work until an explicit owner action taken after that restore.
//   1 a restore during close-summary processing: startup does not treat the expired request as completion
//   2 a restored ready direct continuation is held, never drained, and a dismissed card means never
//   3 one fixture with a pending item of every kind: zero work starts at boot
//   4 structural: every table with a state/status/stage column is fenced or declared not pending work
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeInbox } from "./inbox.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { createProjectGoal } from "./project-goals.ts";
import { channelToProjectRows, setProjectRunState } from "./project-settings.ts";
import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import { projectIsClosing, projectSettingsFor } from "./project-records.ts";
import { resumeGoalCloseSummaries, resumeProjectCloses, startGoalCloseSummary, startProjectClose } from "./project-close.ts";
import { insertRoomRequest, markRequestDispatched, pruneTerminalRoomRequests } from "./room-requests.ts";
import { PushStore } from "./mobile-push-store.ts";
import { sweepRelayRemovals } from "./mobile-push-relay.ts";
import { initializeOwnerSends, neutralizeRestoredSends, SendStore } from "./send-store.ts";
import {
  fenceRestoredContinuations, fenceRestoredSql, isRestoreHeld, releaseHeldContinuation, RESTORE_FENCED_STORES, RESTORE_NOT_PENDING_WORK,
  runnableContinuation, restoreHoldFor, sqlRowRestoreHeld, releaseHeldItem, releaseHeldSharedResults,
} from "./restore-fence.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dbs: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); for (const root of roots.splice(0)) removeTempDirSync(root); });

const lineage = { rootThreadId: "room", origin: "server" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
function projectFixture() {
  const db = new DatabaseSync(":memory:"); dbs.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
  const lines = new Map<string, string>();
  const deps = { groupId: "g", threadId: "room", memberIds: ["lead", "worker"], now: 10, lineage,
    deliverables: () => ["Report: output/report.md"], routineNames: () => ["Daily report"], pauseRoutines: vi.fn(() => {}),
    post: vi.fn((key: string, text: string) => { lines.set(key, text); }), summary: () => "Delivered the report.", sync: vi.fn() };
  return { db, deps, lines };
}
const restore = (db: DatabaseSync, generation = "gen-1") => {
  fenceRestoredSql(db, generation);
  prepareProjectTablesForRestore(db, { groups: [{ id: "g", channelProject: {} }, { id: "g2", channelProject: {} }], botIds: new Set(["lead", "worker"]), now: 50 } as never);
};
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

describe("1 a restore during close processing is not completion", () => {
  it("the close summary is running at backup time: startup creates no lessons, no post, no dispatcher work", () => {
    const { db, deps } = projectFixture();
    const started = startProjectClose(db, deps);
    markRequestDispatched(db, started.summaryRequestId!, { now: 11 });
    restore(db);
    expect(db.prepare("SELECT state FROM room_requests WHERE id=?").get(started.summaryRequestId!)).toMatchObject({ state: "expired" });
    const before = count(db, "SELECT COUNT(*) AS n FROM room_requests");
    resumeProjectCloses(db, { ...deps, now: 60 });
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests")).toBe(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE 'close-lesson:%'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE state='queued'")).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.pauseRoutines).not.toHaveBeenCalled();
    expect(projectSettingsFor(db, "g")).toMatchObject({ closedAt: null, runState: "paused" });
    expect(restoreHoldFor(db, "project_close", `g:${(db.prepare("SELECT json_extract(detail,'$.closeSeq') AS s FROM project_activity WHERE kind='close'").get() as { s: number }).s}`)).toBeTruthy();
  });
  it("the owner pressing Close again after the restore finishes the close", () => {
    const { db, deps, lines } = projectFixture();
    const started = startProjectClose(db, deps);
    markRequestDispatched(db, started.summaryRequestId!, { now: 11 });
    restore(db);
    resumeProjectCloses(db, { ...deps, now: 60 });
    expect(lines.size).toBe(0);
    startProjectClose(db, { ...deps, now: 70 });
    resumeProjectCloses(db, { ...deps, now: 70 });
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE 'close-lesson:%'")).toBe(2);
    expect(lines.size).toBe(1);
    expect(projectSettingsFor(db, "g")?.closedAt).not.toBeNull();
  });
  it("a Close pressed from a conversation that is not the owner's releases nothing", () => {
    const { db, deps } = projectFixture();
    startProjectClose(db, deps);
    restore(db);
    startProjectClose(db, { ...deps, now: 70, lineage: { ...lineage, notOwnerAudience: true } });
    resumeProjectCloses(db, { ...deps, now: 70 });
    expect(deps.post).not.toHaveBeenCalled();
  });
  it("the owner resuming the project abandons a held close and starts nothing", () => {
    const { db, deps } = projectFixture();
    startProjectClose(db, deps);
    restore(db);
    expect(projectIsClosing(db, "g")).toBe(true);
    expect(setProjectRunState(db, { groupId: "g", runState: "running", actor: "owner", now: 80 })).toMatchObject({ ok: true });
    expect(projectIsClosing(db, "g")).toBe(false);
    resumeProjectCloses(db, { ...deps, now: 90 });
    expect(deps.post).not.toHaveBeenCalled();
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE 'close-lesson:%'")).toBe(0);
  });
  it("a goal sign-off the restore held creates no lessons until the owner resumes the project", () => {
    const { db, deps } = projectFixture();
    const goal = createProjectGoal(db, { groupId: "g", title: "Goal", now: 2 });
    if (!goal.ok) throw new Error(goal.reason);
    db.prepare("UPDATE project_goals SET state='done' WHERE id=?").run(goal.goal.id);
    startGoalCloseSummary(db, deps, goal.goal.id);
    restore(db);
    resumeGoalCloseSummaries(db, { ...deps, now: 60 });
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE 'goal-close-lesson:%'")).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
    setProjectRunState(db, { groupId: "g", runState: "running", actor: "owner", now: 80 });
    resumeGoalCloseSummaries(db, { ...deps, now: 90 });
    expect(deps.post).toHaveBeenCalledTimes(1);
  });
});

describe("2 a restored continuation is held, whatever its card", () => {
  const ready = { id: "c1", botId: "bot", text: "carry on", at: 1, state: "ready" as const, dispatcher: "direct" as const, principal: "p", cardId: "card1" };
  it("fenceRestoredContinuations holds every item of a record, its tasks included, with the generation", () => {
    const record: Record<string, unknown> = { id: "bot", heldContinuations: [ready], tasks: [{ threadId: "t", heldContinuations: [{ ...ready, id: "c2" }, { ...ready, id: "c3", state: "retry" }] }] };
    expect(fenceRestoredContinuations(record, "gen-1")).toBe(3);
    const all = [...(record.heldContinuations as unknown[]), ...((record.tasks as Array<{ heldContinuations: unknown[] }>)[0].heldContinuations)] as Array<Record<string, unknown>>;
    for (const item of all) expect(item).toMatchObject({ restoreHeld: true, restoreGen: "gen-1", state: "recovery" });
    expect(all.every(isRestoreHeld)).toBe(true);
  });
  it("the drain never offers a held item, even when it was ready and a tool-capable engine appeared", () => {
    const held = { ...ready, restoreHeld: true, restoreGen: "gen-1" };
    expect(runnableContinuation([held], "bot", Date.now())).toBeUndefined();
    expect(runnableContinuation([{ ...held, state: "ready" as const }], "bot", Date.now())).toBeUndefined();
    expect(runnableContinuation([ready], "bot", Date.now())).toBe(ready);
  });
  it("only a retry for the current generation releases it, and a dismissed card means never", () => {
    const held = { ...ready, restoreHeld: true, restoreGen: "gen-1" };
    expect(releaseHeldContinuation(held, "gen-1", false, "gen-1")).toEqual({ ok: true, restoreHeld: true });
    expect(releaseHeldContinuation(held, "gen-1", false)).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldContinuation(held, "gen-1", false, "gen-0")).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldContinuation(held, "gen-1", true, "gen-1")).toEqual({ ok: false, reason: "card_dismissed" });
    expect(releaseHeldContinuation(held, "gen-2", false, "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldContinuation({ ...held, restoreGen: undefined }, "gen-1", false, "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldContinuation(ready, null, true)).toEqual({ ok: true, restoreHeld: false });
  });
  it("prepareInstallationRestore holds the continuations of a bot task and a group in the prepared bots.json and groups.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-restore-fence-")); roots.push(root);
    const data = join(root, "source"); mkdirSync(data);
    const put = (path: string, value: unknown) => { mkdirSync(dirname(join(data, path)), { recursive: true }); writeFileSync(join(data, path), JSON.stringify(value)); };
    const item = (id: string) => ({ id, botId: "bot", text: "carry on", at: 1, state: "ready", dispatcher: "direct", principal: "p", cardId: "card1", options: { cardContinuation: true } });
    put("bots.json", [{ id: "bot", threadId: "thread", name: "Bot", tasks: [{ threadId: "thread", title: "T", heldContinuations: [item("direct")] }] }]);
    put("groups.json", [{ id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], heldContinuations: [item("room")] }]);
    const db = new DatabaseSync(join(data, "messages.db"));
    try {
      initializeMessageTables(db); initializeImageOperations(db);
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("thread", "card1", 1, "bot", "options", null, JSON.stringify({ id: "card1", at: 1, role: "bot", kind: "options", card: { requestId: "r", title: "Approve", answered: "deny", dismissed: true, options: [] } }));
      db.exec("INSERT INTO thread_state VALUES('thread','card1')");
    } finally { db.close(); }
    const archive = join(root, "backup.zip");
    await writeInstallationArchive(data, archive);
    const result = await prepareInstallationRestore(archive, root);
    const read = (path: string) => JSON.parse(readFileSync(join(result.stateDirectory, path), "utf8"));
    const prepared = [read("bots.json")[0].tasks[0].heldContinuations[0], read("groups.json")[0].heldContinuations[0]];
    const generation = prepared[0].restoreGen;
    expect(generation).toBeTruthy();
    for (const held of prepared) {
      expect(held).toMatchObject({ restoreHeld: true, restoreGen: generation, state: "recovery" });
      expect(runnableContinuation([held], "bot", Date.now())).toBeUndefined();
    }
    const out = new DatabaseSync(join(result.stateDirectory, "messages.db"), { readOnly: true });
    try { expect((out.prepare("SELECT token FROM send_restore_generation").get() as { token: string }).token).toBe(generation); } finally { out.close(); }
    expect(result.modifications.some(entry => /continuation/.test(entry.action))).toBe(true);
  });
});

describe("3 one pending item of every kind: zero work starts at boot", () => {
  it("restores a fixture with every kind of pending work and nothing runs", () => {
    const { db, deps, lines } = projectFixture();
    for (const initialize of [initializeMessageTables, initializeOwnerSends, initializeMobilePush, initializeProjectCardDelivery]) initialize(db);
    // project close in progress and a goal sign-off in progress
    const closing = startProjectClose(db, deps);
    markRequestDispatched(db, closing.summaryRequestId!, { now: 11 });
    channelToProjectRows(db, { groupId: "g2", bulletin: "", leadBotId: "lead", now: 1 });
    const goal = createProjectGoal(db, { groupId: "g2", title: "Goal", now: 2 });
    if (!goal.ok) throw new Error(goal.reason);
    db.prepare("UPDATE project_goals SET state='done' WHERE id=?").run(goal.goal.id);
    startGoalCloseSummary(db, { ...deps, groupId: "g2" }, goal.goal.id);
    // queued and running room requests
    insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", admissionKey: "queued", lineage, targetThreadId: "room", toBotId: "worker", priority: "work", now: 3 } as never);
    const running = insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", admissionKey: "running", lineage, targetThreadId: "room", toBotId: "worker", priority: "work", now: 3 } as never);
    markRequestDispatched(db, running.request.id, { now: 4 });
    // sending and queued owner sends
    const sends = new SendStore(() => db);
    for (const [i, status] of (["sending", "queued"] as const).entries()) sends.accept({ kind: "group", ownerId: "g", threadId: "room", text: `words ${i}`, fingerprint: `fp${i}`, status, sendId: `send-${i}-123456` });
    // an owed card result delivery and a pending phone notification
    db.exec("PRAGMA foreign_keys=OFF"); // the owed row's parent request is not part of this fixture (the table is a child of room_requests since evhand)
    db.prepare("INSERT INTO project_card_delivery_owed (request_id, payload, created_at) VALUES ('owed', '{}', 1)").run();
    db.prepare("INSERT INTO push_bindings (binding_id,device_id,publisher_token,created_at,key_secret) VALUES ('b','d','t',1,'k')").run();
    db.prepare(`INSERT INTO push_events (event_ref,binding_id,kind,category,bot_id,thread_id,request_id,message_id,collapse_key,thread_group,revision,time_sensitive,resolved_by,created_at,expires_at,hold_until,state,attempts,next_attempt_at)
      VALUES ('e','b','approval','a','bot','room','r',NULL,'c','g',1,0,NULL,1,99999999999999,1,'pending',0,1)`).run();
    // a held continuation in the JSON records
    const record: Record<string, unknown> = { id: "bot", heldContinuations: [{ id: "c", botId: "bot", text: "carry on", at: 1, state: "ready", dispatcher: "direct", principal: "p" }] };

    // the restore
    const generation = "restore-gen";
    restore(db, generation);
    neutralizeRestoredSends(db, generation);
    fenceRestoredContinuations(record, generation);

    // boot: every importable startup/resume consumer runs
    const roomBefore = count(db, "SELECT COUNT(*) AS n FROM room_requests");
    resumeProjectCloses(db, { ...deps, now: 60 });
    resumeGoalCloseSummaries(db, { ...deps, groupId: "g2", now: 60 });
    expect(runnableContinuation(record.heldContinuations as never, "bot", Date.now())).toBeUndefined();
    // zero work started and zero created
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests")).toBe(roomBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE state IN ('queued','running','waiting_owner','waiting_bot')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM owner_sends WHERE status IN ('sending','queued')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM owner_sends WHERE restore_held=1")).toBe(2);
    expect((db.prepare("SELECT * FROM owner_sends").all() as Array<Record<string, unknown>>).every(isRestoreHeld)).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM project_card_delivery_owed")).toBe(1); // kept, held: never dropped
    expect(sqlRowRestoreHeld(db, "card_delivery", "owed")).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM push_events WHERE state IN ('held','pending')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM project_goals WHERE state IN ('planning','working')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM project_settings WHERE run_state<>'paused'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM restore_holds WHERE generation<>'restore-gen'")).toBe(0);
    expect(lines.size).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.pauseRoutines).not.toHaveBeenCalled();
    expect(deps.sync).not.toHaveBeenCalled();
  });
});

describe("2 a saved relay removal is held, not run, until the owner removes the device again", () => {
  const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", PT = "murage_pt_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
  it("the sweep invokes nothing for a restored removal; the owner's own removal releases it", async () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db); initializeMobilePush(db);
    const store = new PushStore(db);
    store.enqueueRelayRemoval({ bindingId: B, publisherToken: PT }, 100);
    fenceRestoredSql(db, "gen-1");
    expect(count(db, "SELECT COUNT(*) AS n FROM push_relay_removals")).toBe(1); // kept, not dropped
    const relay = { remove: vi.fn(async () => true) };
    expect(store.dueRelayRemovals(500, 10)).toEqual([]);
    expect(await sweepRelayRemovals(store, relay, 500)).toEqual({ removed: 0, retrying: 0, abandoned: 0 });
    expect(relay.remove).not.toHaveBeenCalled();
    expect(count(db, "SELECT COUNT(*) AS n FROM push_relay_removals")).toBe(1);
    store.enqueueRelayRemoval({ bindingId: B, publisherToken: PT }, 600);   // the owner removed the device after the restore
    expect(await sweepRelayRemovals(store, relay, 700)).toMatchObject({ removed: 1 });
    expect(relay.remove).toHaveBeenCalledTimes(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM push_relay_removals")).toBe(0);
  });
});

type Located = { file: string; name: string; body: string };
const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** Bodies of every function or method whose name starts like a startup or sweep consumer and whose signature ends the line with `{`. */
function bootConsumers(): Located[] {
  const found: Located[] = [];
  const declaration = /^[ \t]*(?:export )?(?:async )?(?:function )?((?:resume|recover|sweep|drain|reconcile|replay|due)[A-Za-z0-9]*)\s*(?:<[^>\n]*>)?\([^\n]*\)[^\n{=;]*\{\s*$/gm;
  for (const file of readdirSync(SERVER_DIR).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = readFileSync(join(SERVER_DIR, file), "utf8");
    for (const match of source.matchAll(declaration)) {
      let depth = 0, end = match.index! + match[0].length - 1;
      for (; end < source.length; end++) { const c = source[end]; if (c === "{") depth++; else if (c === "}" && --depth === 0) break; }
      found.push({ file, name: match[1]!, body: source.slice(match.index!, end) });
    }
  }
  return found;
}
function everyTableDb() {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeInbox(db); initializeArtifacts(db); initializeImageOperations(db); initializeImageLibrary(db); initializeThreadSnooze(db);
  initializeProjectTables(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); initializeProjectCardDelivery(db); initializeOwnerSends(db);
  return db;
}
const tablesOf = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name);

describe("4 every store that can hold pending work is fenced or declared not pending", () => {
  it("each table with a state, status or stage column is listed in RESTORE_FENCED_STORES or RESTORE_NOT_PENDING_WORK", () => {
    const db = everyTableDb();
    fenceRestoredSql(db, "g");
    const covered = new Set(RESTORE_FENCED_STORES.flatMap(entry => entry.tables ?? []));
    const missing: string[] = [];
    for (const table of tablesOf(db)) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
      if (!columns.some(name => /^(state|status|stage)$/.test(name))) continue;
      if (!covered.has(table) && !(table in RESTORE_NOT_PENDING_WORK)) missing.push(table);
    }
    expect(missing).toEqual([]);
    for (const entry of RESTORE_FENCED_STORES) { expect(entry.consumers.length).toBeGreaterThan(0); expect(entry.note.length).toBeGreaterThan(10); }
  });
  it("every table or JSON store a startup, resume, recover, sweep, drain or due consumer reads is inventoried, whatever its columns", () => {
    const db = everyTableDb(), known = new Set(tablesOf(db));
    const covered = new Set(RESTORE_FENCED_STORES.flatMap(entry => entry.tables ?? []));
    const files = new Set(RESTORE_FENCED_STORES.flatMap(entry => entry.files ?? []));
    const consumers = bootConsumers();
    expect(consumers.length).toBeGreaterThan(20);                      // the scan finds the consumers, it is not vacuous
    expect(consumers.map(item => item.name)).toEqual(expect.arrayContaining(["resumePendingPublications", "sweepOwedDeliveries", "dueRelayRemovals", "resumePendingAssistantImages"]));
    const unlisted: string[] = [];
    for (const { file, name, body } of consumers) {
      for (const match of body.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/gi)) {
        const table = match[1]!.toLowerCase();
        if (known.has(table) && !covered.has(table) && !(table in RESTORE_NOT_PENDING_WORK)) unlisted.push(`${file}:${name} reads table ${table}`);
      }
      for (const match of body.matchAll(/["'`]([\w-]+\.json)["'`]/g)) if (!files.has(match[1]!) && !(match[1]! in RESTORE_NOT_PENDING_WORK)) unlisted.push(`${file}:${name} reads ${match[1]}`);
    }
    expect([...new Set(unlisted)]).toEqual([]);
  });
  it("an entry marked dropped is really never consumed: no runnable row is left for any consumer after a restore", () => {
    const db = everyTableDb();
    db.prepare("INSERT INTO push_bindings (binding_id,device_id,publisher_token,created_at,key_secret) VALUES ('b','d','t',1,'k')").run();
    for (const [i, state] of (["held", "pending", "sent"] as const).entries()) {
      db.prepare(`INSERT INTO push_events (event_ref,binding_id,kind,category,bot_id,thread_id,request_id,message_id,collapse_key,thread_group,revision,time_sensitive,resolved_by,created_at,expires_at,hold_until,state,attempts,next_attempt_at)
        VALUES (?,'b','approval','a','bot','room','r',NULL,'c','g',1,0,NULL,1,99999999999999,1,?,0,1)`).run(`e${i}`, state);
    }
    fenceRestoredSql(db, "gen-1");
    const dropped = RESTORE_FENCED_STORES.filter(entry => entry.mode === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
    for (const entry of dropped) {
      // a consumer may read the table (the push sender reads push_events) but the proof says no runnable row is left for it
      expect(entry.proof?.length ?? 0).toBeGreaterThan(0);
      for (const sql of entry.proof!) expect(count(db, sql)).toBe(0);
    }
    // the sent notification is history, not pending work
    expect(count(db, "SELECT COUNT(*) AS n FROM push_events WHERE state='sent'")).toBe(1);
  });
  it("nothing marked held is dropped: a card result, a relay removal, an image operation and an output receipt all survive the fence", () => {
    const db = everyTableDb();
    db.exec("PRAGMA foreign_keys=OFF"); // the owed row's parent request is not part of this fixture (the table is a child of room_requests since evhand)
    db.prepare("INSERT INTO project_card_delivery_owed (request_id, payload, created_at) VALUES ('owed','{}',1)").run();
    db.prepare("INSERT INTO push_relay_removals (binding_id,publisher_token,attempts,next_attempt_at,created_at) VALUES ('b','t',0,1,1)").run();
    db.prepare("INSERT INTO image_operations VALUES('op','gen','h','publish-pending','{}',1)").run();
    db.prepare("INSERT INTO output_publications (id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,created_at,updated_at) VALUES ('rc','assistant-image','b','t','r','p','s','image/png',1,'failed',1,1)").run();
    fenceRestoredSql(db, "gen-1");
    for (const table of ["project_card_delivery_owed", "push_relay_removals", "image_operations", "output_publications"]) expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(1);
    for (const [kind, id] of [["card_delivery", "owed"], ["push_relay_removal", "b"], ["image_operation", "op"], ["output_receipt", "rc"]] as const) expect(sqlRowRestoreHeld(db, kind, id)).toBe(true);
  });
});

describe("5 a finished shared request's undelivered result is held, not published at boot", () => {
  it("a done request not yet delivered is held; a delivered one is not; only a current-generation release (or Resume of its project) frees it", () => {
    const db = everyTableDb();
    channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
    const make = (key: string) => { const id = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", admissionKey: key, lineage, targetThreadId: "t", toBotId: "worker", priority: "work", now: 3 } as never).request.id; db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')").run(id); return id; };   // shared work is recorded as such when it is created
    const owed = make("owed"), delivered = make("delivered"), resume = make("resume");
    db.prepare("UPDATE room_requests SET state='done'").run();
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=?").run(delivered);
    const notes = fenceRestoredSql(db, "gen-1");
    expect(notes.some(note => note.action.includes("finished shared result"))).toBe(true);
    expect(sqlRowRestoreHeld(db, "shared_result", owed)).toBe(true);
    expect(sqlRowRestoreHeld(db, "shared_result", resume)).toBe(true);
    expect(sqlRowRestoreHeld(db, "shared_result", delivered)).toBe(false);
    expect(releaseHeldItem(db, "shared_result", owed, undefined, "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
    expect(releaseHeldItem(db, "shared_result", owed, "gen-0", "gen-1")).toEqual({ ok: false, reason: "stale_generation" });
    expect(sqlRowRestoreHeld(db, "shared_result", owed)).toBe(true);
    expect(releaseHeldItem(db, "shared_result", owed, "gen-1", "gen-1")).toEqual({ ok: true });
    expect(sqlRowRestoreHeld(db, "shared_result", owed)).toBe(false);
    expect(releaseHeldSharedResults(db, "g", () => true)).toBe(1);
    expect(sqlRowRestoreHeld(db, "shared_result", resume)).toBe(false);
  });
  it("no prune deletes a held shared result, however old: it waits for the owner's release, then ages out like any other", () => {
    const db = everyTableDb();
    channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
    const make = (key: string) => { const id = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", admissionKey: key, lineage, targetThreadId: "t", toBotId: "worker", priority: "work", now: 3 } as never).request.id; db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')").run(id); return id; };   // shared work is recorded as such when it is created
    const held = make("held"), plain = make("plain"), card = make("card");
    db.prepare("UPDATE room_requests SET state='done', finished_at=1").run();
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=?").run(plain);
    db.prepare("INSERT INTO project_card_delivery_owed (request_id, payload, created_at) VALUES (?,'{}',1)").run(card);
    fenceRestoredSql(db, "gen-1");
    const later = 100 * 24 * 60 * 60 * 1000;
    pruneTerminalRoomRequests(db, later);
    const ids = () => (db.prepare("SELECT id FROM room_requests").all() as Array<{ id: string }>).map(row => row.id).sort();
    expect(ids()).toEqual([card, held].sort());
    expect(releaseHeldItem(db, "shared_result", held, "gen-1", "gen-1")).toEqual({ ok: true });
    pruneTerminalRoomRequests(db, later);
    expect(ids()).toEqual([card, held].sort());                                  // released but not yet delivered: still delivery debt
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=?").run(held);
    pruneTerminalRoomRequests(db, later);
    expect(ids()).toEqual([card]);
  });
  it("the boot delivery skips held results and the inventory lists the store and its consumers", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("function deliverOwedSharedResults"), source.indexOf("configureSharedDrain({"));
    expect(fn).toContain('sqlRowRestoreHeld(db, "shared_result"');
    expect(source).not.toMatch(/for \(const row of db\.prepare\("SELECT id FROM room_requests WHERE state IN \('done','failed'\)[^\n]*\n\s+const request = roomRequest/);
    expect(RESTORE_FENCED_STORES.find(entry => entry.store === "finished shared request results")?.mode).toBe("held");
  });
});
