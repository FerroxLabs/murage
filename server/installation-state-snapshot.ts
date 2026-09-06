// Private directory-stage builder for the versioned archive/restore workflow.
// This is not a portable archive or an activated restored installation.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { dirname, join, sep } from "node:path";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError, withOfflineInstallation } from "./installation-database-snapshot.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";

const JSON_COMPONENTS = new Set(["config.json", "bots.json", "groups.json", "routines.json", "calendar-calls.json", "webhooks.json", "delegations.json", "delegation-receipts.json", "section-contexts.json", "browser-cleanups.json"]);
const DIRECTORY_COMPONENTS = new Set(["attachments", "workspaces", "skills", "skill-state", "checkpoints", "events"]);
const SAFE_CONFIG_FIELDS = ["profile", "language", "rooms", "localVm", "features", "browserProfiles"] as const;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(code: string): never { throw new InstallationSnapshotError(code); }

export interface StateSnapshotManifest {
  format: "murage.installation-stage";
  version: 1;
  snapshotId: string;
  createdAt: string;
  restorePolicy: "paused-review-required";
  files: Array<{ path: string; bytes: number; sha256: string }>;
  omitted: Array<{ path: string; reason: string }>;
  missing: string[];
  database: { status: "absent" } | { status: "copied"; messages: number; threads: number; bytes: number; sha256: string };
}

function safePart(name: string): boolean {
  return !!name && name !== "." && name !== ".." && name.length <= 255 &&
    !/[\\/:\x00-\x1f]/.test(name) && !/[ .]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function projectConfig(value: unknown, omit: (path: string, reason: string) => void): JsonObject {
  if (!object(value)) fail("INVALID_CONFIG_COMPONENT");
  const projected: JsonObject = {};
  const fields: Record<string, Record<string, string>> = {
    profile: { name: "string", email: "string" },
    rooms: { turnTimeoutMinutes: "number" },
    localVm: { mode: "string", maxInstances: "number" },
    features: { browser: "boolean", skillRecorder: "boolean", showToolCalls: "boolean" },
  };
  for (const [name, allowed] of Object.entries(fields)) {
    const raw = value[name];
    if (raw === undefined) continue;
    if (!object(raw)) fail("INVALID_CONFIG_COMPONENT");
    const copy: JsonObject = {};
    for (const [key, member] of Object.entries(raw)) {
      if (!Object.hasOwn(allowed, key)) { omit(`config.json/${name}/${key}`, "Unknown nested configuration excluded"); continue; }
      if (typeof member !== allowed[key]) fail("INVALID_CONFIG_COMPONENT");
      copy[key] = member;
    }
    projected[name] = copy;
  }
  if (value.language !== undefined) {
    if (typeof value.language !== "string") fail("INVALID_CONFIG_COMPONENT");
    projected.language = value.language;
  }
  if (value.browserProfiles !== undefined) {
    if (!Array.isArray(value.browserProfiles)) fail("INVALID_CONFIG_COMPONENT");
    projected.browserProfiles = value.browserProfiles.map((raw, index) => {
      if (!object(raw)) fail("INVALID_CONFIG_COMPONENT");
      const copy: JsonObject = {};
      for (const [key, member] of Object.entries(raw)) {
        if (!["id", "name", "partitionId"].includes(key)) { omit(`config.json/browserProfiles/${index}/${key}`, "Browser credential state excluded"); continue; }
        if (typeof member !== "string") fail("INVALID_CONFIG_COMPONENT");
        copy[key] = member;
      }
      return copy;
    });
  }
  if (value.instances !== undefined) {
    if (!object(value.instances)) fail("INVALID_CONFIG_COMPONENT");
    const instances: JsonObject = Object.create(null);
    for (const [id, raw] of Object.entries(value.instances)) {
      if (!object(raw) || typeof raw.driver !== "string") fail("INVALID_CONFIG_COMPONENT");
      instances[id] = { driver: raw.driver, ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}), enabled: false };
      for (const key of Object.keys(raw)) if (!["driver", "displayName", "enabled"].includes(key)) omit(`config.json/instances/${id}/${key}`, "Execution configuration requires review and credential re-entry");
    }
    projected.instances = instances;
  }
  for (const key of Object.keys(value)) if (![...SAFE_CONFIG_FIELDS, "instances"].includes(key)) omit(`config.json/${key}`, "Credential-bearing or unknown configuration excluded");
  return projected;
}

function projectComponent(name: string, value: unknown, omit: (path: string, reason: string) => void): unknown {
  assertInstallationRecords(name, value);
  if (name === "config.json") return projectConfig(value, omit);
  if (name === "bots.json") {
    if (!Array.isArray(value)) fail("INVALID_ROSTER_COMPONENT");
    return value.map((entry, index) => {
      if (!object(entry) || typeof entry.id !== "string" || typeof entry.threadId !== "string") fail("INVALID_ROSTER_COMPONENT");
      const bot = { ...entry };
      if (Object.hasOwn(bot, "resumeCursors")) { delete bot.resumeCursors; omit(`${name}/${index}/resumeCursors`, "Native provider cursors require fresh sessions"); }
      if (Array.isArray(bot.tasks)) bot.tasks = bot.tasks.map((task, taskIndex) => {
        if (!object(task)) fail("INVALID_ROSTER_COMPONENT");
        const copy = { ...task };
        if (Object.hasOwn(copy, "resumeCursors")) { delete copy.resumeCursors; omit(`${name}/${index}/tasks/${taskIndex}/resumeCursors`, "Native provider cursors require fresh sessions"); }
        return copy;
      });
      return bot;
    });
  }
  if (name === "webhooks.json") {
    if (!object(value) || !Array.isArray(value.webhooks) || !Array.isArray(value.deliveries)) fail("INVALID_WEBHOOK_COMPONENT");
    return { ...value, webhooks: value.webhooks.map((entry, index) => {
      if (!object(entry)) fail("INVALID_WEBHOOK_COMPONENT");
      const copy = { ...entry, enabled: false };
      for (const key of ["secret", "secretHash"]) if (Object.hasOwn(copy, key)) {
        delete (copy as JsonObject)[key];
        omit(`${name}/webhooks/${index}/${key}`, "Webhook verification must be re-established");
      }
      return copy;
    }) };
  }
  if (value === null || typeof value !== "object") fail("INVALID_JSON_COMPONENT");
  return value;
}

/** Build a private snapshot directory at a NEW path. It intentionally has a
 * distinct format from the eventual archive: projected webhook credentials
 * and inactive engine config require explicit restore reconstruction. Plain
 * transcript/file content can itself contain secrets; this is private data,
 * never a shareable diagnostics bundle. External project paths are not read. */
export async function stageInstallationState(dataDir: string, outputParent: string, options: { signal?: AbortSignal; maxBytes?: number; maxFiles?: number } = {}): Promise<{ directory: string; manifest: StateSnapshotManifest }> {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const parent = dataDirLeasePaths(outputParent).canonicalDataDir;
  if (parent === root || parent.startsWith(root + sep)) fail("DESTINATION_INSIDE_INSTALLATION");
  const maxBytes = options.maxBytes ?? 20 * 1024 ** 3;
  const maxFiles = options.maxFiles ?? 100_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) fail("INVALID_SNAPSHOT_LIMITS");
  return withOfflineInstallation(root, async installation => {
    if (!lstatSync(root).isDirectory()) fail("INSTALLATION_MISSING");
    const stage = mkdtempSync(join(parent, ".murage-state-snapshot-"));
    let published = false;
    let bytes = 0;
    let entries = 0;
    const observed = new Map<string, Stats>();
    const manifest: StateSnapshotManifest = {
      format: "murage.installation-stage", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
      files: [], omitted: [], missing: [], database: { status: "absent" },
    };
    const omission = (path: string, reason: string) => manifest.omitted.push({ path, reason });
    const check = () => { if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED"); };
    const add = (path: string, size: number, sha256: string) => {
      bytes += size;
      if (bytes > maxBytes || manifest.files.length >= maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      manifest.files.push({ path, bytes: size, sha256 });
    };
    const copy = (path: string) => {
      check();
      const source = join(root, path);
      const before = lstatSync(source);
      observed.set(source, before);
      if (before.isSymbolicLink()) { omission(path, "Symlink not followed; review external or managed link after restore"); return; }
      if (!before.isFile() || before.nlink !== 1) fail("UNSAFE_SNAPSHOT_ENTRY");
      if (before.size > maxBytes - bytes || manifest.files.length >= maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const to = join(stage, "state", path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let size = 0;
      const input = openSync(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const opened = fstatSync(input);
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) { closeSync(input); fail("SOURCE_CHANGED"); }
      let output: number | undefined;
      try {
        output = openSync(to, "wx", 0o600);
        if (JSON_COMPONENTS.has(path) || /^messages-[\w-]+\.json$/.test(path)) {
          if (before.size > 64 * 1024 ** 2) fail("JSON_COMPONENT_TOO_LARGE");
          let value: unknown;
          try { value = JSON.parse(readFileSync(input, "utf8")); } catch { fail("INVALID_JSON_COMPONENT"); }
          const buffer = Buffer.from(JSON.stringify(projectComponent(path, value, omission)) + "\n");
          hash.update(buffer); size = buffer.length;
          let offset = 0;
          while (offset < buffer.length) offset += writeSync(output, buffer, offset, buffer.length - offset);
        } else {
          {
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              check();
              const length = readSync(input, buffer, 0, buffer.length, null);
              if (!length) break;
              size += length;
              if (size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED");
              hash.update(buffer.subarray(0, length));
              let offset = 0;
              while (offset < length) offset += writeSync(output, buffer, offset, length - offset);
            }
          }
        }
        fsyncSync(output);
      } finally { try { if (output !== undefined) closeSync(output); } finally { closeSync(input); } }
      const after = lstatSync(source);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("SOURCE_CHANGED");
      add(path, size, hash.digest("hex"));
    };
    const walk = (path: string, depth = 0) => {
      check();
      if (++entries > maxFiles || depth > 64) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const before = lstatSync(join(root, path));
      if (before.isSymbolicLink()) { omission(path, "Directory symlink not followed"); return; }
      if (!before.isDirectory()) { copy(path); return; }
      const names = readdirSync(join(root, path)).sort();
      const folded = new Set<string>();
      for (const name of names) {
        const normalized = name.normalize("NFC").toLowerCase();
        if (!safePart(name) || folded.has(normalized)) fail("NONPORTABLE_SNAPSHOT_PATH");
        folded.add(normalized);
        walk(join(path, name), depth + 1);
      }
      if (JSON.stringify(readdirSync(join(root, path)).sort()) !== JSON.stringify(names)) fail("SOURCE_CHANGED");
    };
    try {
      check();
      const names = readdirSync(root).sort();
      if (names.length > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      for (const name of names) {
        if (name === "messages.db" || name === "messages.db-wal" || name === "messages.db-shm") continue;
        if (!safePart(name)) fail("NONPORTABLE_SNAPSHOT_PATH");
        if (JSON_COMPONENTS.has(name) || /^messages-[\w-]+\.json$/.test(name) || /^decisions\.ndjson(?:\.1)?$/.test(name)) copy(name);
        else if (DIRECTORY_COMPONENTS.has(name)) walk(name);
        else omission(name, "Cache, native diagnostics, runtime state or unrecognized component excluded");
      }
      for (const name of JSON_COMPONENTS) if (!names.includes(name)) manifest.missing.push(name);
      mkdirSync(join(stage, "state"), { recursive: true, mode: 0o700 });
      manifest.database = await installation.snapshotDatabase(join(stage, "state", "messages.db"));
      if (manifest.database.status === "copied") add("messages.db", manifest.database.bytes, manifest.database.sha256);
      else manifest.missing.push("messages.db");
      check();
      if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(names)) fail("SOURCE_CHANGED");
      for (const [path, before] of observed) {
        const after = lstatSync(path);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("SOURCE_CHANGED");
      }
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
      // Return an owned private stage, not a published archive. This avoids
      // a directory rename-to-user-name race: portable file publication will
      // use no-replace linking when archive serialization is implemented.
      published = true;
      return { directory: stage, manifest };
    } catch (error) {
      throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("STATE_SNAPSHOT_FAILED");
    } finally { if (!published) rmSync(stage, { recursive: true, force: true }); }
  });
}
