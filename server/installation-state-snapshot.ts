// Private directory-stage builder for the versioned archive/restore workflow.
// This is not a portable archive or an activated restored installation.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync, type ReadStream, type Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_BACKUP_BYTES, MAX_BACKUP_FILES, MAX_LISTED_SKIPS, MAX_RESTORABLE_PATH_BYTES, type BackupSkipReason } from "../shared/backup-limits.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError, withOfflineInstallation, type OfflineInstallation } from "./installation-database-snapshot.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";
import { notificationPreferencesSchema } from "../shared/notification-preferences.ts";
import { classifyDataDirEntry, DATA_DIR_RECORDS } from "./data-dir-inventory.ts";

// What is copied is decided by data-dir-inventory.ts, the one list of every
// top-level name Murage writes: required records are validated and
// projected, optional owner files and owner folders are copied as written,
// and everything else is left out here (the fidelity inventory refuses a
// name that list does not know).
const JSON_COMPONENTS = new Set(DATA_DIR_RECORDS);
const isProjectedRecord = (path: string) => JSON_COMPONENTS.has(path) || classifyDataDirEntry(path)?.backup === "record";
const SAFE_CONFIG_FIELDS = ["profile", "language", "rooms", "localVm", "features", "browserProfiles", "notifications"] as const;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(code: string, path?: string): never { throw new InstallationSnapshotError(code, path ? { path } : undefined); }
const portable = (path: string) => path.split(sep).join("/");

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
  links?: Array<{ path: string; target: string; type: "file" | "dir" }>;
  copies?: Array<{ path: string; from: string }>;
  names?: Array<{ path: string; name: string }>;
  skipped?: Array<{ path: string; reason: BackupSkipReason }>;
  skippedCount?: number;
}

// skills.ts and procedure-bundles.ts link every enabled skill into each bot
// workspace's .claude/skills, .agents/skills and .grok/skills so the bot's
// engine finds it. Those links point back at the skill inside the same
// workspaces tree, which is captured anyway, and Murage re-creates them from
// the skill manifest, so they are left out rather than stored.
export const NATIVE_SKILL_LINK_OMITTED = "Skill shortcut Murage re-creates for the bot's engine; not restored";
function nativeSkillLink(root: string, relative: string): boolean {
  const portable = relative.split(sep).join("/");
  if (!/^workspaces\/(?:[^/]+\/)+\.(?:claude|agents|grok)\/skills\/[^/]+$/.test(portable)) return false;
  try {
    // Compare real paths: the link text keeps whatever spelling DATA_DIR had
    // (on macOS /var and /private/var name the same folder).
    const link = join(root, relative), workspaces = realpathSync.native(join(root, "workspaces")) + sep;
    const target = realpathSync.native(resolve(dirname(link), readlinkSync(link)));
    return target.startsWith(workspaces) && target.split(sep).includes("skills");
  } catch { return false; }
}

function safePart(name: string): boolean {
  return !!name && name !== "." && name !== ".." && Buffer.byteLength(name) <= 255 && name === name.normalize("NFC") &&
    !/[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) && !/[ .]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
const percent = (text: string) => [...Buffer.from(text)].map(byte => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join("");
/** A spelling of `name` every supported system can hold, for the archive:
 * characters Windows refuses (and "%" itself) as %XX, trailing dots and
 * spaces too, a device name's first letter, canonical Unicode. The real name
 * is kept in the manifest and put back wherever the restoring system allows. */
export function portableSpelling(name: string): string {
  let out = "";
  for (const character of name.normalize("NFC")) out += /[\\/:<>"|?*%\x00-\x1f\x7f]/.test(character) ? percent(character) : character;
  out = out.replace(/[ .]+$/, tail => percent(tail));
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = percent(out[0]) + out.slice(1);
  if (!out) out = "%2E";
  if (Buffer.byteLength(out) > 255) out = "murage-long-name-" + createHash("sha256").update(name).digest("hex").slice(0, 32);
  return out;
}

/** Folders a bot's tools rebuild on demand: package installs, virtual
 * environments, compiler and framework caches. Left out of backups (and
 * listed), so a bot's ordinary `npm install` can neither fill the backup nor
 * push it past its file limit. Any folder holding the standard CACHEDIR.TAG
 * marker (Rust's target/, many tool caches) or a pyvenv.cfg (a Python
 * virtual environment under any name) is treated the same way. */
export const REBUILDABLE_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules", ".pnpm-store", ".yarn-cache", ".npm", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".tox", ".nox", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".angular", ".gradle", ".cache",
]);
function rebuildableFolder(absolute: string, name: string): boolean {
  if (REBUILDABLE_FOLDERS.has(name)) return true;
  for (const marker of ["CACHEDIR.TAG", "pyvenv.cfg"]) {
    try { if (lstatSync(join(absolute, marker)).isFile()) return true; } catch { /* absent */ }
  }
  return false;
}
const deniedRead = (error: unknown) => ["EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException)?.code));

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
  if (value.notifications !== undefined) {
    if (!notificationPreferencesSchema.safeParse(value.notifications).success) fail("INVALID_CONFIG_COMPONENT");
    projected.notifications = value.notifications;
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
/** The stage's contents list and its projected records, for inspection.
 * Owner files are read in place (see openFile), so they are not in
 * `directory`; anything that writes an archive stays inside the offline
 * epoch and uses stageInstallationStateWhileOwned. */
export async function stageInstallationState(dataDir: string, outputParent: string, options: { signal?: AbortSignal; maxBytes?: number; maxFiles?: number } = {}): Promise<{ directory: string; manifest: StateSnapshotManifest }> {
  return withOfflineInstallation(dataDir, async installation => {
    const { directory, manifest } = await stageInstallationStateWhileOwned(installation, outputParent, options);
    return { directory, manifest };
  });
}

/** Internal composition seam: a caller keeps fidelity and recovery in one epoch.
 *
 * Every top-level name is checked against data-dir-inventory.ts HERE, so every
 * consumer of the stage (the encrypted backup and the older-style .zip file
 * alike, audit K-02) refuses a name Murage does not know or a state it must
 * not capture, instead of quietly leaving it out.
 *
 * Inside folders of owner work (a bot's own folder above all), nothing a bot
 * ordinarily makes stops the backup (audit A-01):
 *  - a shortcut (symbolic link) is stored as a shortcut and never followed;
 *  - a file with several names (a hard link: pnpm, git) is stored once, and
 *    each further name is restored as its own copy;
 *  - a name another system can't hold (a colon, a trailing dot, CON.txt, two
 *    names differing only in case) is stored under a safe spelling and put
 *    back under its real name wherever the restoring system allows it;
 *  - rebuildable folders (node_modules, virtual environments, caches) are left
 *    out and listed;
 *  - past the file limit, or where a file can't be read, the item is left out
 *    and listed. The backup still completes.
 * Murage's own records at the top of the folder are still all-or-nothing. */
export interface InstallationStage { directory: string; manifest: StateSnapshotManifest; assertSourceUnchanged: () => void; openFile: (stored: string) => ReadStream }
export async function stageInstallationStateWhileOwned(installation: OfflineInstallation, outputParent: string, options: { signal?: AbortSignal; maxBytes?: number; maxFiles?: number } = {}): Promise<InstallationStage> {
  const root = installation.dataDir;
  const parent = dataDirLeasePaths(outputParent).canonicalDataDir;
  if (parent === root || parent.startsWith(root + sep)) fail("DESTINATION_INSIDE_INSTALLATION");
  const maxBytes = options.maxBytes ?? MAX_BACKUP_BYTES;
  const maxFiles = options.maxFiles ?? MAX_BACKUP_FILES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BACKUP_BYTES || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BACKUP_FILES) fail("INVALID_SNAPSHOT_LIMITS");
    if (!lstatSync(root).isDirectory()) fail("INSTALLATION_MISSING");
    const stage = mkdtempSync(join(parent, ".murage-state-snapshot-"));
    let published = false;
    let bytes = 0;
    /** Restorable items: files, stored shortcuts and extra names. One place
     * is kept for the conversation database, copied last. */
    let items = 1;
    const observed = new Map<string, Stats>();
    const directories = new Map<string, string[]>();
    /** Files read in place, by stored path: where they are and what they were. */
    const inPlace = new Map<string, { absolute: string; identity: Stats }>();
    const manifest: StateSnapshotManifest = {
      format: "murage.installation-stage", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
      files: [], omitted: [], missing: [], database: { status: "absent" },
    };
    const links: NonNullable<StateSnapshotManifest["links"]> = [], copies: NonNullable<StateSnapshotManifest["copies"]> = [], names: NonNullable<StateSnapshotManifest["names"]> = [];
    const skipped: NonNullable<StateSnapshotManifest["skipped"]> = [];
    let skippedCount = 0;
    // Shown to the person, so a name with a control character or of absurd
    // length is made printable here rather than refused later.
    const shown = (path: string) => { const text = portable(path).replace(/[\x00-\x1f\x7f]/g, "?"); return text.length > 1000 ? text.slice(0, 999) + "…" : text; };
    const skip = (path: string, reason: BackupSkipReason) => { skippedCount++; if (skipped.length < MAX_LISTED_SKIPS) skipped.push({ path: shown(path), reason }); };
    /** First stored name of each multiply-linked file, by device and inode. */
    const firstName = new Map<string, string>();
    const omission = (path: string, reason: string) => manifest.omitted.push({ path, reason });
    const check = () => { if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED"); };
    const add = (path: string, size: number, sha256: string, source: string) => {
      bytes += size;
      if (bytes > maxBytes) fail("SNAPSHOT_LIMIT_EXCEEDED", source);
      manifest.files.push({ path, bytes: size, sha256 });
    };
    /** Copy one regular file from `source` (real, relative) to `stored` (archive spelling). */
    const copy = (source: string, stored: string) => {
      check();
      const absolute = join(root, source);
      const before = lstatSync(absolute);
      observed.set(absolute, before);
      if (!before.isFile()) fail("UNSAFE_SNAPSHOT_ENTRY", source);
      if (before.size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED", source);
      // Only Murage's projected records are written into the stage; every
      // other file is read in place, hashed now and streamed into the archive
      // later from the same, unchanged file (openFile below). Copying them
      // made a backup folder on a USB stick need room for a plaintext copy of
      // the whole workspace beside the encrypted one, and wrote every small
      // file twice (audit W-A2).
      const projected = !stored.includes("/") && isProjectedRecord(stored);
      const to = join(stage, "state", ...stored.split("/"));
      if (projected) mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let size = 0;
      const input = openSync(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const opened = fstatSync(input);
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) { closeSync(input); fail("SOURCE_CHANGED", source); }
      let output: number | undefined;
      try {
        if (projected) {
          output = openSync(to, "wx", 0o600);
          if (before.size > 64 * 1024 ** 2) fail("JSON_COMPONENT_TOO_LARGE", source);
          let value: unknown;
          try { value = JSON.parse(readFileSync(input, "utf8")); } catch { fail("INVALID_JSON_COMPONENT", source); }
          const buffer = Buffer.from(JSON.stringify(projectComponent(stored, value, omission)) + "\n");
          hash.update(buffer); size = buffer.length;
          let offset = 0;
          while (offset < buffer.length) offset += writeSync(output, buffer, offset, buffer.length - offset);
        } else {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            check();
            const length = readSync(input, buffer, 0, buffer.length, null);
            if (!length) break;
            size += length;
            if (size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED", source);
            hash.update(buffer.subarray(0, length));
          }
          if (size !== before.size) fail("SOURCE_CHANGED", source);
          inPlace.set(stored, { absolute, identity: before });
        }
      } catch (error) {
        if (error instanceof InstallationSnapshotError && !error.path) throw new InstallationSnapshotError(error.code, { path: source });
        throw error;
      } finally { try { if (output !== undefined) closeSync(output); } finally { closeSync(input); } }
      const after = lstatSync(absolute);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("SOURCE_CHANGED", source);
      add(stored, size, hash.digest("hex"), source);
    };
    /** One item inside a folder of owner work. `source` is its real relative
     * path, `stored` its archive spelling. */
    const walk = (source: string, stored: string, depth: number) => {
      check();
      const absolute = join(root, source);
      const before = lstatSync(absolute);
      const bot = source.split(sep)[0] === "workspaces";
      // A path another computer can't hold is left out and listed, so a
      // restore never meets one (second audit #2; MAX_RESTORABLE_PATH_BYTES).
      if (Buffer.byteLength(stored) > MAX_RESTORABLE_PATH_BYTES) { skip(source, "path-too-long"); return; }
      if (before.isSymbolicLink()) {
        if (depth === 0) { skip(source, "linked-folder"); observed.set(absolute, before); return; }
        if (nativeSkillLink(root, source)) { omission(portable(source), NATIVE_SKILL_LINK_OMITTED); return; }
        if (items >= maxFiles) { skip(source, "file-limit"); return; }
        let target: string;
        try { target = readlinkSync(absolute); } catch (error) { if (deniedRead(error)) { skip(source, "unreadable"); return; } throw error; }
        let type: "file" | "dir" = "file";
        try { if (statSync(absolute).isDirectory()) type = "dir"; } catch { /* A dangling shortcut is kept as one. */ }
        observed.set(absolute, before);
        links.push({ path: stored, target, type }); items++;
        // A shortcut to a folder outside the data folder is kept, and listed:
        // what it points at is not in the backup.
        if (type === "dir") {
          let outside = true;
          try { const real = realpathSync.native(absolute), home = realpathSync.native(root); outside = real !== home && !real.startsWith(home + sep); } catch { /* treated as outside */ }
          if (outside) skip(source, "linked-folder");
        }
        return;
      }
      if (before.isDirectory()) {
        if (depth > 0 && bot && rebuildableFolder(absolute, basename(absolute))) { skip(source, "rebuildable"); return; }
        if (depth > 64) { skip(source, "too-deep"); return; }
        let entries: string[];
        try { entries = readdirSync(absolute).sort(); } catch (error) { if (deniedRead(error)) { skip(source, "unreadable"); return; } throw error; }
        directories.set(absolute, entries);
        // Names are stored under a spelling unique in this folder even where
        // case is ignored; the real name goes in `names`.
        const taken = new Set<string>();
        for (const name of entries) {
          let spelled = safePart(name) ? name : portableSpelling(name);
          for (let attempt = 2; taken.has(spelled.toLowerCase()); attempt++) spelled = portableSpelling(name) + "%23" + attempt;
          taken.add(spelled.toLowerCase());
          const childStored = stored + "/" + spelled;
          const before = manifest.files.length + links.length + copies.length;
          walk(join(source, name), childStored, depth + 1);
          // Only an entry the archive holds (or a folder above one) keeps its
          // real name here; an empty folder is not stored at all.
          if (spelled !== name && manifest.files.length + links.length + copies.length > before) names.push({ path: childStored, name });
        }
        return;
      }
      if (!before.isFile()) { skip(source, "special"); return; }
      if (items >= maxFiles) { skip(source, "file-limit"); return; }
      if (before.nlink > 1) {
        const key = `${before.dev}:${before.ino}`, first = firstName.get(key);
        if (first) { observed.set(absolute, before); copies.push({ path: stored, from: first }); items++; return; }
        firstName.set(key, stored);
      }
      try { copy(source, stored); }
      catch (error) {
        if (!(error instanceof InstallationSnapshotError) && deniedRead(error)) { firstName.forEach((value, key) => { if (value === stored) firstName.delete(key); }); skip(source, "unreadable"); return; }
        throw error;
      }
      items++;
    };
    try {
      check();
      const rootNames = readdirSync(root).sort();
      // SQLite may create/remove these exact auxiliary files while taking its
      // own consistent backup. All other membership and file checks remain.
      const rootMembership=(entries:string[])=>entries.filter(name=>name!=="messages.db-wal"&&name!=="messages.db-shm");
      if (rootNames.length > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      // One list decides every top-level name (data-dir-inventory.ts).
      const kinds = new Map<string, NonNullable<ReturnType<typeof classifyDataDirEntry>>>();
      for (const name of rootNames) {
        const entry = classifyDataDirEntry(name);
        if (!entry) fail("BACKUP_UNCLASSIFIED_COMPONENT", name);
        if (entry.backup === "refused") fail(entry.code ?? "BACKUP_UNCLASSIFIED_COMPONENT", name);
        kinds.set(name, entry);
      }
      // Records and single owner files first, so the owner's folders can
      // never crowd them out of the file limit.
      for (const name of rootNames) {
        const kind = kinds.get(name)!.backup;
        if (kind === "record" || kind === "owner-file") {
          if (!safePart(name)) fail("NONPORTABLE_SNAPSHOT_PATH", name);
          copy(name, name); items++;
        }
      }
      for (const name of rootNames) {
        const kind = kinds.get(name)!.backup;
        if (kind === "owner-folder") walk(name, name, 0);
        else if (kind !== "record" && kind !== "owner-file" && kind !== "database" && kind !== "sidecar") omission(name, kinds.get(name)!.why);
      }
      for (const name of JSON_COMPONENTS) if (!rootNames.includes(name)) manifest.missing.push(name);
      if (links.length) manifest.links = links;
      if (copies.length) manifest.copies = copies;
      if (names.length) manifest.names = names;
      if (skippedCount) { manifest.skipped = skipped; manifest.skippedCount = skippedCount; }
      mkdirSync(join(stage, "state"), { recursive: true, mode: 0o700 });
      manifest.database = await installation.snapshotDatabase(join(stage, "state", "messages.db"));
      if (manifest.database.status === "copied") add("messages.db", manifest.database.bytes, manifest.database.sha256, "messages.db");
      else manifest.missing.push("messages.db");
      check();
      const assertSourceUnchanged = () => {
        check();
        if (JSON.stringify(rootMembership(readdirSync(root).sort())) !== JSON.stringify(rootMembership(rootNames))) fail("SOURCE_CHANGED");
        for (const [path, before] of observed) {
          const after = lstatSync(path);
          if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("SOURCE_CHANGED", relative(root, path));
        }
        for (const [path, entries] of directories) {
          let now: string[];
          try { now = readdirSync(path).sort(); } catch { fail("SOURCE_CHANGED", relative(root, path)); }
          if (JSON.stringify(now) !== JSON.stringify(entries)) fail("SOURCE_CHANGED", relative(root, path));
        }
      };
      assertSourceUnchanged();
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
      // Return an owned private stage, not a published archive. This avoids
      // a directory rename-to-user-name race: portable file publication will
      // use no-replace linking when archive serialization is implemented.
      published = true;
      /** A stream of one stored file: the staged copy for a projected record
       * or the database, otherwise the original, refused unless it is still
       * the very file that was hashed. */
      const openFile = (stored: string) => {
        const held = inPlace.get(stored);
        if (!held) {
          const path = join(stage, "state", ...stored.split("/"));
          const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
          return createReadStream(path, { fd, autoClose: true });
        }
        const fd = openSync(held.absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        const now = fstatSync(fd), was = held.identity;
        if (now.dev !== was.dev || now.ino !== was.ino || now.size !== was.size || now.mtimeMs !== was.mtimeMs || !now.isFile()) { closeSync(fd); fail("SOURCE_CHANGED", relative(root, held.absolute)); }
        return createReadStream(held.absolute, { fd, autoClose: true });
      };
      return { directory: stage, manifest, assertSourceUnchanged, openFile };
    } catch (error) {
      if (error instanceof InstallationSnapshotError) throw error;
      // The drive holding the backup folder filled up while the stage was
      // written: say so, as the rest of the capture does.
      if (["ENOSPC", "EDQUOT"].includes(String((error as NodeJS.ErrnoException)?.code))) throw new InstallationSnapshotError("BACKUP_DISK_FULL", { cause: error });
      // A plain filesystem error still names the item it was about.
      const path = (error as NodeJS.ErrnoException)?.path;
      throw new InstallationSnapshotError("STATE_SNAPSHOT_FAILED", { cause: error, ...(typeof path === "string" && path.startsWith(root + sep) ? { path: relative(root, path) } : {}) });
    } finally { if (!published) rmSync(stage, { recursive: true, force: true }); }
}
