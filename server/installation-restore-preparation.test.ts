import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { assertRestoreReviewed, RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-preparation-"));
  roots.push(root);
  const data = join(root, "source");
  mkdirSync(data);
  const put = (path: string, value: unknown) => { mkdirSync(dirname(join(data, path)), { recursive: true }); writeFileSync(join(data, path), JSON.stringify(value)); };
  put("config.json", { instances: { fake: { driver: "claudeAgent", enabled: true, config: { cli: "must-not-run" } } }, features: { browser: true, skillRecorder: true } });
  put("bots.json", [{ id: "bot", threadId: "thread", name: "Preserved bot", autoApprove: true, autoReview: "enforce", alwaysAllow: ["Bash:sh"], computer: "cloud", autoStartVps: true, browser: true, composio: true, busy: true, tasks: [{ threadId: "thread", title: "Keep me", resumeCursors: { old: "cursor" } }] }]);
  put("groups.json", [{ id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], working: true, busyBotId: "bot" }]);
  const run = { routineId: "routine", routineName: "Routine", botId: "bot", target: "bot", runOn: "ember", scheduledFor: 1, manual: true, createdAt: 1 };
  put("routines.json", { version: 1, routines: [{ id: "routine", name: "Routine", prompt: "Task", botId: "bot", target: "bot", runOn: "ember", enabled: true, schedule: { type: "once", at: 1 }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1 }], runs: [{ ...run, id: "done", status: "completed", result: "immutable receipt" }, { ...run, id: "queued", status: "queued" }], routineRequestReceipts: [{ requestId: "terminal-id", messageId: "terminal", botId: "bot", threadId: "thread", action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: "routine", appliedAt: 1 }] });
  put("calendar-calls.json", { version: 1, calls: [{ id: "call", name: "Call", description: "Fixture", botIds: ["bot"], schedule: { type: "once", at: 1 }, durationMinutes: 30, attachments: [], createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 10 }] });
  put("webhooks.json", { version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", name: "Hook", prompt: "Task", botId: "bot", runOn: "ember", createdAt: 1, updatedAt: 1, deliveryCount: 1, enabled: true, secretHash: "b".repeat(64) }], deliveries: [{ key: "endpoint:already-run", runId: "done", at: 1 }] });
  put("delegations.json", { thread: [{ id: "queued", message: "Never replay automatically" }] });
  put("browser-cleanups.json", { entries: ["Do not replay cleanup"] });
  put("skill-state/bot/skills.json", { skill: { enabled: true, revision: "preserve" } });
  put("skill-state/bot/staged.json", { writes: { pending: { text: "Do not apply automatically" } } });
  const db = new DatabaseSync(join(data, "messages.db"));
  const messages = [
    { id: "terminal", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Already done" } },
    { id: "pending", at: 2, role: "bot", kind: "options", parentId: "terminal", card: { requestId: "old-request", title: "Old approval", options: ["Allow"] } },
  ];
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
    for (const message of messages) db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, null, JSON.stringify(message));
    db.exec("INSERT INTO thread_state VALUES('thread','pending')");
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
  expect(read("bots.json")[0]).toMatchObject({ id: "bot", threadId: "thread", busy: false, autoApprove: false, autoReview: "off", alwaysAllow: [], computer: "off", autoStartVps: false, browser: false, composio: false, resumeCursors: {} });
  expect(read("groups.json")[0]).toMatchObject({ working: false, busyBotId: null });
  expect(read("routines.json").runs[0]).toMatchObject({ id: "done", status: "completed", result: "immutable receipt" });
  expect(read("routines.json").runs[1].status).toBe("cancelled");
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
