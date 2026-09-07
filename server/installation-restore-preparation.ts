import { pauseRestoredMemory } from "./memory/restore.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectInstallationArchive, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError, inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";
import { DEFAULT_INSTANCES } from "./default-instances.ts";
import { RESTORED_CONNECTIONS_FILE } from "../electron/restored-connections.mjs";
import { RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { notificationPreferencesSchema } from "../shared/notification-preferences.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code: string): never { throw new InstallationSnapshotError(code); }
const id = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
const MAX_JSON_BYTES = 64 * 1024 ** 2;
const RESERVED_RESTORE_FILES = new Set<string>([RESTORE_REVIEW_FILE, RESTORED_CONNECTIONS_FILE, "recovery-quarantine", "connection-profiles", "companion"]);
const terminal = new Set(["completed", "failed", "cancelled", "missed", "blocked", "limit"]);

/** Prepare a private review-only candidate. It never replaces an installation
 * and does not clear the startup barrier. The original archive is unchanged;
 * pending queue/cleanup/skill writes are retained separately as evidence. */
export async function prepareInstallationRestore(archive: string, outputParent: string, options: ArchiveLimits = {}) {
  const inspected = await inspectInstallationArchive(archive, outputParent, options);
  const state = join(inspected.directory, "state");
  const files = new Set(inspected.manifest.files.map(file => file.path));
  const modifications: Array<{ component: string; action: string }> = [];
  const quarantined: string[] = [];
  let success = false;
  const read = (path: string): unknown => {
    if (!files.has(path)) return undefined;
    const absolute = join(state, ...path.split("/"));
    if (lstatSync(absolute).size > MAX_JSON_BYTES) fail("RESTORE_COMPONENT_TOO_LARGE");
    try { return JSON.parse(readFileSync(absolute, "utf8")); }
    catch { fail("INVALID_RESTORE_COMPONENT"); }
  };
  const write = (path: string, value: unknown) => {
    const absolute = join(state, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, JSON.stringify(value) + "\n", { mode: 0o600, flush: true });
  };
  const quarantine = (path: string) => {
    if (!files.has(path)) return;
    const destination = join(state, "recovery-quarantine", inspected.manifest.snapshotId, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(join(state, ...path.split("/")), destination);
    quarantined.push(path);
  };
  try {
    // No future archive may place its own marker/quarantine over ours.
    if ([...files].some(path => RESERVED_RESTORE_FILES.has(path.toLowerCase()) || ["recovery-quarantine/", "connection-profiles/", "companion/"].some(prefix => path.toLowerCase().startsWith(prefix)))) fail("RESERVED_RESTORE_COMPONENT");
    for (const path of ["routines.json", "calendar-calls.json", "webhooks.json", "delegation-receipts.json", "section-contexts.json"]) {
      if (files.has(path)) assertInstallationRecords(path, read(path));
    }
    const storedConfig = read("config.json");
    const config = storedConfig === undefined ? {} : storedConfig;
    if (config !== undefined) {
      if (!object(config)) fail("INVALID_RESTORE_CONFIG");
      if (config.notifications !== undefined && !notificationPreferencesSchema.safeParse(config.notifications).success) fail("INVALID_RESTORE_CONFIG");
      const safe: RecordValue = {};
      safe.engineDiscovery = "explicit";
      const instances: RecordValue = Object.fromEntries(Object.entries(DEFAULT_INSTANCES).map(([key, value]) => [key, { driver: value.driver, enabled: false }]));
      for (const key of ["profile", "language", "rooms", "localVm", "browserProfiles", "notifications"]) if (Object.hasOwn(config, key)) safe[key] = config[key];
      safe.features = { browser: false, skillRecorder: false, showToolCalls: object(config.features) && config.features.showToolCalls === true };
      if (config.instances !== undefined) {
        if (!object(config.instances)) fail("INVALID_RESTORE_CONFIG");
        Object.assign(instances, Object.fromEntries(Object.entries(config.instances).map(([key, value]) => {
          if (!id(key) || !object(value) || typeof value.driver !== "string") fail("INVALID_RESTORE_CONFIG");
          return [key, { driver: value.driver, ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}), enabled: false }];
        })));
      }
      safe.instances = instances;
      write("config.json", safe);
      modifications.push({ component: "config.json", action: "Provider/MCP credentials excluded; engine and experimental execution disabled" });
    }
    const ownership = new Map<string, string>();
    const botIds = new Set<string>();
    for (const path of ["bots.json", "groups.json"]) {
      const records = read(path);
      if (records === undefined) continue;
      if (!Array.isArray(records)) fail("INVALID_RESTORE_ROSTER");
      const ids = new Set<string>();
      const prepared = records.map(value => {
        if (!object(value) || !id(value.id) || !id(value.threadId) || ids.has(value.id)) fail("INVALID_RESTORE_ROSTER");
        ids.add(value.id);
        if (path === "bots.json") botIds.add(value.id);
        const owner = `${path}:${value.id}`;
        const claim = (thread: unknown) => {
          if (!id(thread) || (ownership.has(thread) && ownership.get(thread) !== owner)) fail("DUPLICATE_RESTORE_THREAD");
          ownership.set(thread, owner);
        };
        claim(value.threadId);
        const record = { ...value };
        if (value.tasks !== undefined) {
          if (!Array.isArray(value.tasks)) fail("INVALID_RESTORE_ROSTER");
          const seen = new Set<string>();
          record.tasks = value.tasks.map(task => {
            if (!object(task) || !id(task.threadId) || seen.has(task.threadId)) fail("INVALID_RESTORE_ROSTER");
            seen.add(task.threadId); claim(task.threadId);
            const copy = { ...task, resumeCursors: {} };
            delete (copy as RecordValue).lastInstanceId;
            return copy;
          });
        }
        delete record.lastInstanceId;
        if (path === "bots.json") Object.assign(record, { busy: false, activity: "idle", autoApprove: false, autoReview: "off", alwaysAllow: [], approvePeerComms: true, computer: "off", autoStartVps: false, browser: false, composio: false, speakReplies: false, resumeCursors: {}, rewound: true });
        else {
          if (!Array.isArray(value.memberIds) || value.memberIds.some(member => !id(member) || !botIds.has(member))) fail("INVALID_RESTORE_MEMBERSHIP");
          Object.assign(record, { working: false, busyBotId: null });
        }
        return record;
      });
      write(path, prepared);
      modifications.push({ component: path, action: "Preserved identities/tasks; cleared active sessions and automatic authority" });
    }
    const routines = read("routines.json");
    if (routines !== undefined) {
      if (!object(routines) || routines.version !== 1 || !Array.isArray(routines.routines) || !Array.isArray(routines.runs)) fail("INVALID_RESTORE_ROUTINES");
      routines.routines = routines.routines.map(value => { if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_ROUTINES"); return { ...value, enabled: false }; });
      routines.runs = routines.runs.map(value => {
        if (!object(value) || !id(value.id) || typeof value.status !== "string") fail("INVALID_RESTORE_ROUTINES");
        if (terminal.has(value.status)) return value;
        return { ...value, status: "cancelled", error: "Pending work suspended after restoration; review its outcome before starting new work", finishedAt: Date.now() };
      });
      write("routines.json", routines);
    }
    const calls = read("calendar-calls.json");
    if (calls !== undefined) {
      if (!object(calls) || calls.version !== 1 || !Array.isArray(calls.calls)) fail("INVALID_RESTORE_CALENDAR");
      calls.calls = calls.calls.map(value => { if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_CALENDAR"); return { ...value, nextRunAt: null }; });
      write("calendar-calls.json", calls);
    }
    const webhooks = read("webhooks.json");
    if (webhooks !== undefined) {
      if (!object(webhooks) || webhooks.version !== 1 || !Array.isArray(webhooks.webhooks) || !Array.isArray(webhooks.deliveries)) fail("INVALID_RESTORE_WEBHOOKS");
      webhooks.webhooks = webhooks.webhooks.map(value => {
        if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_WEBHOOKS");
        const copy = { ...value, enabled: false, verificationPending: true, secretHash: randomBytes(32).toString("hex") };
        delete (copy as RecordValue).secret;
        return copy;
      });
      write("webhooks.json", webhooks);
    }
    for (const path of ["delegations.json", "browser-cleanups.json"]) quarantine(path);
    for (const path of files) {
      if (/^skill-state\/[^/]+\/staged\.json$/.test(path)) quarantine(path);
      else if (/^skill-state\/[^/]+\/skills\.json$/.test(path)) {
        const manifest = read(path);
        if (!object(manifest)) fail("INVALID_RESTORE_SKILLS");
        for (const entry of Object.values(manifest)) { if (!object(entry)) fail("INVALID_RESTORE_SKILLS"); entry.enabled = false; }
        write(path, manifest);
      }
    }
    const expireMessage = (value: unknown): RecordValue => {
      if (!object(value) || !id(value.id) || !["bot", "user"].includes(String(value.role)) || typeof value.kind !== "string" || typeof value.at !== "number") fail("INVALID_RESTORE_MESSAGE");
      const message = { ...value };
      if (object(message.card) && !message.card.answered && (message.card.requestId || message.card.routineRequest || message.card.skillRequest)) {
        message.card = { ...message.card, answered: "Expired after restore", dismissed: true };
      }
      for (const key of ["connector", "secret"]) if (object(message[key])) message[key] = { ...message[key], dismissed: true, resumed: false };
      if (object(message.goalRun) && message.goalRun.status === "working") message.goalRun = { ...message.goalRun, status: "blocked", detail: "Restored work requires outcome review before a fresh run" };
      if (message.queued === true) message.queued = false;
      return message;
    };
    for (const path of files) if (/^messages-[\w-]+\.json$/.test(path)) {
      const value = read(path);
      const graph = new InstallationTranscriptGraph(fail);
      const messages = Array.isArray(value) ? value : object(value) && Array.isArray(value.messages) ? value.messages : null;
      if (!messages) fail("INVALID_RESTORE_MESSAGE");
      for (const message of messages) graph.add(message);
      graph.validate(object(value) ? value.activeLeafId ?? null : null);
      if (Array.isArray(value)) write(path, value.map(expireMessage));
      else if (object(value) && Array.isArray(value.messages)) write(path, { ...value, messages: value.messages.map(expireMessage) });
      else fail("INVALID_RESTORE_MESSAGE");
    }
    if (files.has("messages.db")) {
      const db = new DatabaseSync(join(state, "messages.db"));
      try {
        const counts = inspectInstallationDatabase(db);
        if (inspected.manifest.database.status !== "copied" || counts.messages !== inspected.manifest.database.messages || counts.threads !== inspected.manifest.database.threads) fail("INVALID_DATABASE_MANIFEST");
        db.exec("BEGIN IMMEDIATE");
        const update = db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?");
        for (const row of db.prepare("SELECT thread_id,id,json FROM messages").iterate()) {
          if (typeof row.json !== "string" || Buffer.byteLength(row.json) > MAX_JSON_BYTES) fail("INVALID_RESTORE_MESSAGE");
          const before = JSON.parse(row.json);
          const after = expireMessage(before);
          if (after.id !== row.id) fail("INVALID_RESTORE_MESSAGE");
          const encoded = JSON.stringify(after);
          if (encoded !== row.json) update.run(encoded, row.thread_id, row.id);
        }
        if (pauseRestoredMemory(db)) modifications.push({component:"messages.db",action:"Memory paused; worker leases and provider disclosures invalidated; indexes require rebuild"});
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
      finally { db.close(); }
    }
    write(RESTORED_CONNECTIONS_FILE, { version: 1, id: randomUUID() });
    modifications.push({ component: RESTORED_CONNECTIONS_FILE, action: "Fresh Murage credentials and companion/device state; native engine globals remain untouched" });
    write(RESTORE_REVIEW_FILE, { version: 1, status: "review-required", snapshotId: inspected.manifest.snapshotId, archiveSha256: inspected.sha256, quarantined, modifications });
    success = true;
    return { ...inspected, stateDirectory: state, modifications, quarantined, activationAvailable: false as const };
  } catch (error) { throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("RESTORE_PREPARATION_FAILED"); }
  finally { if (!success) rmSync(inspected.directory, { recursive: true, force: true }); }
}
