import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeSendAttempts, SendAttemptStore, recoverSendAttempts, importLegacySendAttempts } from "./send-attempt-state.ts";
import { clearRetainedContextForAmbiguousAttempts } from "./send-attempt-compat.ts";
import { SendStore, initializeOwnerSends } from "./send-store.ts";
const handles: DatabaseSync[] = [];
function fixture(path = ":memory:") { const db = new DatabaseSync(path); handles.push(db); initializeOwnerSends(db); initializeSendAttempts(db); return { db, store: new SendAttemptStore(db), sends: new SendStore(() => db) }; }
afterEach(() => handles.splice(0).forEach(db => { if (db.isOpen) db.close(); }));
const scope = { ownerId: "owner", botId: "bot", threadId: "thread" };
const holder = () => ({ resumeCursors: { engine: "session" }, resumePolicies: {}, resumeSeals: {}, resumeIncarnations: { engine: 2 }, replayPending: true });
it("F7-DOWN-RETAINED-SESSION: possible delivery before recovery clears every retained holder", () => {
  const { store, db } = fixture(); const root = mkdtempSync(join(tmpdir(), "l8-compat-"));
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ ...holder(), tasks: [holder()] }]));
  writeFileSync(join(root, "groups.json"), JSON.stringify([holder()]));
  const receipt = store.create({ ...scope, sendId: "send", fingerprint: "hash" });
  const key = store.bind([receipt.attemptId], { generation: "gen", providerInstanceId: "instance" })[0]!;
  store.recordInvocation(key, store.byId(receipt.attemptId)!.revision, false);
  try { clearRetainedContextForAmbiguousAttempts(root, db); } catch { /* assert retained files below */ }
  const bots = JSON.parse(readFileSync(join(root, "bots.json"), "utf8"));
  expect(bots[0].resumeCursors).toBeUndefined(); expect(bots[0].tasks[0].resumeIncarnations).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, "groups.json"), "utf8"))[0].resumeSeals).toBeUndefined();
  expect(clearRetainedContextForAmbiguousAttempts(root, db)).toEqual({ ambiguous: 1, cleared: 0 });
});
it("F7-DOWN-NO-AMBIGUOUS-KEEPS: ordinary retained sessions stay unchanged", () => {
  const { db } = fixture(); const root = mkdtempSync(join(tmpdir(), "l8-compat-"));
  const original = JSON.stringify([holder()]); writeFileSync(join(root, "bots.json"), original);
  expect(clearRetainedContextForAmbiguousAttempts(root, db)).toEqual({ ambiguous: 0, cleared: 0 });
  expect(readFileSync(join(root, "bots.json"), "utf8")).toBe(original);
});
it("F7-DOWN-UNPARSEABLE-FAILS: corrupt retained context fails closed", () => {
  const { db, store } = fixture(); const root = mkdtempSync(join(tmpdir(), "l8-compat-"));
  store.create({ ...scope, fingerprint: "hash" }); writeFileSync(join(root, "bots.json"), "corrupt");
  expect(() => clearRetainedContextForAmbiguousAttempts(root, db)).toThrow();
  writeFileSync(join(root, "bots.json"), "{}"); expect(() => clearRetainedContextForAmbiguousAttempts(root, db)).toThrow();
});
it.each(["linked", "gate", "terminal"])("F7-CRASH: reopen after %s never retries possible delivery", stage => {
  const root = mkdtempSync(join(tmpdir(), "l8-restart-")); const path = join(root, "messages.sqlite");
  const before = fixture(path); const receipt = before.store.create({ ...scope, sendId: "send", fingerprint: "hash" });
  before.store.link(receipt.attemptId, "line");
  const key = before.store.bind([receipt.attemptId], { generation: "gen", providerInstanceId: "provider" })[0]!;
  if (stage !== "linked") before.store.releaseWrite(key, before.store.byId(receipt.attemptId)!.revision, 1);
  if (stage === "terminal") before.store.settleAttempt(key, before.store.byId(receipt.attemptId)!.revision, "failed", { binding: key, delivery: "uncertain" });
  before.db.close();
  const after = fixture(path); recoverSendAttempts(after.store, () => true);
  expect(after.store.readAttempt(scope, "send")).toMatchObject({ phase: "terminal", delivery: stage === "linked" ? "not_submitted" : "uncertain" });
  expect(after.store.replayEligibility("thread", ["line"]).excludedIds.has("line")).toBe(true);
  expect(recoverSendAttempts(after.store, () => true)).toBe(0);
});
it("F7-PRUNE: queue retention never erases same-ID or replay protection", async () => {
  const { sends, store } = fixture();
  const input = { kind: "bot" as const, ownerId: "bot", threadId: "thread", sendId: "send", fingerprint: "words", text: "words" };
  const row = sends.accept(input).row; sends.settle(row.seq, "failed", "line");
  expect(await sends.pruneResolved(0, Date.now() + 1, 0)).toBe(1);
  expect(sends.accept(input).kind).toBe("existing");
  expect(store.replayEligibility("thread", ["line"]).excludedIds.has("line")).toBe(true);
});
it("F7-DELETE: retirement uses irreversible scoped IDs and a rollback keeps protection", () => {
  const { db, store } = fixture(); const receipt = store.create({ ...scope, sendId: "private-send-id", fingerprint: "hash", queueId: "queue" });
  store.link(receipt.attemptId, "line");
  expect(() => store.retireThread(scope, () => {}, () => { throw new Error("disk full"); })).toThrow();
  expect(store.readAttempt(scope, "private-send-id")).toMatchObject({ attemptId: receipt.attemptId });
  store.retireThread(scope, () => {}, () => {});
  expect(store.readAttempt(scope, "private-send-id")).toEqual({ kind: "retired" });
  expect(JSON.stringify(db.prepare("SELECT * FROM retired_send_ids").all())).not.toContain("private-send-id");
  expect(store.readAttempt({ ...scope, botId: "another" }, "private-send-id")).toEqual({ kind: "missing" });
});
it("F7-ML8-LEGACY-DISPATCHED-IMPORT: a started dispatch stamp is uncertainty", () => {
  const { db, sends, store } = fixture();
  // Simulate a legacy writer with no attempt rows, not an ordinary transcript.
  const row = sends.accept({ kind: "bot", ownerId: "bot", threadId: "thread", sendId: "old", fingerprint: "words", text: "words" }).row;
  db.exec("DELETE FROM send_attempts");
  db.prepare("UPDATE owner_sends SET status='started',message_id='line',turn_id='allocated' WHERE seq=?").run(row.seq);
  expect(importLegacySendAttempts(store)).toBe(1);
  expect(store.readAttempt({ ownerId: "bot", botId: "bot", threadId: "thread" }, "old")).toMatchObject({ delivery: "uncertain", replayPolicy: "exclude" });
  expect(importLegacySendAttempts(store)).toBe(0);
});

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
it.each(["accepted", "linked", "before-gate", "after-gate", "possible-write", "terminal", "publication", "release"])("F7-CRASH child: process dies at %s committed boundary", stage => {
  const root = mkdtempSync(join(tmpdir(), "l8-crash-")); const path = join(root, "messages.sqlite");
  const module = pathToFileURL(resolve("server/send-attempt-state.ts")).href;
  const marker = join(root, "crash-point");
  const code = `import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync } from 'node:fs';
    import { initializeSendAttempts, SendAttemptStore } from ${JSON.stringify(module)};
    const db = new DatabaseSync(${JSON.stringify(path)}); db.exec('PRAGMA journal_mode=WAL'); initializeSendAttempts(db); const store = new SendAttemptStore(db);
    const receipt = store.create({ownerId:'owner',botId:'bot',threadId:'thread',sendId:'send',fingerprint:'hash'});
    const stage=${JSON.stringify(stage)}; const die=()=>{writeFileSync(${JSON.stringify(marker)},stage);process.kill(process.pid,'SIGKILL');};
    if(stage==='accepted') die(); store.link(receipt.attemptId,'line'); if(stage==='linked') die();
    const key=store.bind([receipt.attemptId],{generation:'gen',providerInstanceId:'instance'})[0];
    if(stage==='before-gate') { db.exec("BEGIN IMMEDIATE; UPDATE send_attempts SET delivery='uncertain'"); die(); }
    store.releaseWrite(key,store.byId(receipt.attemptId).revision,1); if(stage==='after-gate'||stage==='possible-write') die();
    store.settleAttempt(key,store.byId(receipt.attemptId).revision,'failed',{binding:key,delivery:'uncertain'}); if(stage==='terminal') die();
    store.flushEffects('thread','gen',effect=>{if(effect.kind===stage)die();}); die();`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000, env: { ...process.env, VITEST: "" } });
  expect(child.error, child.stderr).toBeUndefined();
  expect(readFileSync(marker, "utf8")).toBe(stage);
  // Windows reports self-termination as an exit status, not a POSIX wait signal.
  if (process.platform === "win32") expect(child.status, child.stderr).not.toBe(0);
  else expect(child.signal, child.stderr).toBe("SIGKILL");
  const after = fixture(path); recoverSendAttempts(after.store, () => true);
  const receipt = after.store.readAttempt(scope, "send");
  expect(receipt).toMatchObject({ delivery: ["accepted", "linked", "before-gate"].includes(stage) ? "not_submitted" : "uncertain" });
  if (!["accepted", "linked"].includes(stage)) expect(receipt).toMatchObject({ phase: "terminal" });
  if (stage !== "accepted") expect(after.store.replayEligibility("thread", ["line"]).excludedIds.has("line")).toBe(true);
});

import { exportSendAttemptCompat, importSendAttemptCompat, mergeSendRetirementFences, SEND_ATTEMPT_COMPAT_MEMBER } from "./send-attempt-compat.ts";
it("F7-RESTORE: destination retirement fences defeat an older backup", () => {
  const source = fixture(); const destination = fixture();
  source.store.create({ ...scope, sendId: "deleted", fingerprint: "hash" });
  destination.store.create({ ...scope, sendId: "deleted", fingerprint: "hash" });
  destination.store.retireThread(scope, () => {}, () => {});
  mergeSendRetirementFences(source.db, destination.db);
  expect(source.store.readAttempt(scope, "deleted")).toEqual({ kind: "retired" });
  expect(() => source.store.create({ ...scope, sendId: "deleted", fingerprint: "hash" })).toThrow("retired_send_id");
});
it("F7-EXPORT-RETAINED-SESSION: staged context clears and checksum protects recovery", () => {
  const { store, db } = fixture(); const root = mkdtempSync(join(tmpdir(), "l8-export-"));
  writeFileSync(join(root, "bots.json"), JSON.stringify([holder()]));
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
  const receipt = store.create({ ...scope, sendId: "send", fingerprint: "hash" });
  store.link(receipt.attemptId, "line", () => { db.prepare("INSERT INTO messages VALUES ('thread','line',?)").run(JSON.stringify({ role: "user", kind: "text", text: "only one copy" })); });
  const key = store.bind([receipt.attemptId], { generation: "gen", providerInstanceId: "provider" })[0]!;
  store.releaseWrite(key, store.byId(receipt.attemptId)!.revision, 1);
  recoverSendAttempts(store, () => true);
  exportSendAttemptCompat(root, db);
  expect(JSON.parse(readFileSync(join(root, "bots.json"), "utf8"))[0].resumeCursors).toBeUndefined();
  expect(String(db.prepare("SELECT json FROM messages").get()!.json)).toContain('"kind":"activity"');
  const archive = readFileSync(join(root, SEND_ATTEMPT_COMPAT_MEMBER), "utf8"); expect(archive).not.toContain("only one copy");
  expect(importSendAttemptCompat(root, db)).toBe(true);
  expect(String(db.prepare("SELECT json FROM messages").get()!.json)).toContain('"kind":"text"');
  const changed = JSON.parse(archive); changed.body += " "; writeFileSync(join(root, SEND_ATTEMPT_COMPAT_MEMBER), JSON.stringify(changed));
  expect(() => importSendAttemptCompat(root, db)).toThrow("checksum");
});
