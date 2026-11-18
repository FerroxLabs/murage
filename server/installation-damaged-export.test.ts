import { fixtureLink } from "./testing/platform-fixtures.ts";
import { seedCopyIntents } from "./testing/fts-copy-fixture.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as yauzl from "yauzl";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { inspectInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { DAMAGED_EXPORT_DATABASE_WITHHELD, writeInstallationDamagedExport } from "./installation-damaged-export.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-damaged-export-test-")); roots.push(root);
  const data = join(root, "source"), target = join(root, "preservation.zip"); mkdirSync(data);
  const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(join(data, path)), { recursive: true }); writeFileSync(join(data, path), bytes); };
  put("config.json", '{"token":"fake-private-token",');
  put("messages.db", Buffer.from([0, 255, 1, 2, 3]));
  put("messages.db-wal", Buffer.from([8, 7, 6]));
  put("messages.db-shm", Buffer.from([5, 4, 3]));
  put("section-contexts.json", '{"version":999,"contexts":');
  put("workspaces/bot/notes.txt", "unfinished user work");
  put("artifact-files/report.html", "<h1>Saved report</h1>");
  return { root, data, target, put };
}
async function readZip(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value!)));
  const files = new Map<string, Buffer>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject); zip.on("end", resolve);
      zip.on("entry", entry => zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const chunks: Buffer[] = [];
        stream!.on("error", reject);
        stream!.on("data", chunk => chunks.push(Buffer.from(chunk)));
        stream!.on("end", () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      }));
      zip.readEntry();
    });
  } finally { zip.close(); }
  return files;
}

// SMOOTH-FTS-MERGE R6 section 3: the database bytes are never exported raw. This fixture's messages.db does not open, so its
// three names are withheld with the approved sentence (a settled export is covered by settle-copy-damaged-export.test.ts).
it("exports damaged JSON bytes unchanged as private non-restorable evidence and withholds a database that will not open", async () => {
  const f = fixture();
  for (const home of ["vm-home", "vm-homes", "connection-profiles", "companion", "native", "flux-hermes-home"]) f.put(`${home}/private`, "fake-excluded-home-secret");
  const database = new Map(["messages.db", "messages.db-wal", "messages.db-shm"].map(path => [path, readFileSync(join(f.data, path))]));
  const originals = new Map(["config.json", "section-contexts.json", "workspaces/bot/notes.txt", "artifact-files/report.html"].map(path => [path, readFileSync(join(f.data, path))]));
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expect(result.manifest).toMatchObject({ format: "murage.installation-damaged", version: 1, complete: false, restorePolicy: "preservation-only-no-restore" });
  expect(result.manifest.warning).toContain("credentials");
  expect(JSON.stringify(result.manifest)).not.toContain(f.data);
  expect(JSON.stringify(result.manifest)).not.toContain("fake-private-token");
  expect(result.manifest.omitted.map(entry => entry.path)).toEqual(expect.arrayContaining(["vm-home", "vm-homes", "connection-profiles", "companion", "native", "flux-hermes-home"]));
  const entries = await readZip(f.target);
  expect(JSON.parse(entries.get("manifest.json")!.toString())).toEqual(result.manifest);
  for (const [path, bytes] of originals) {
    expect(entries.get(`preservation/${path}`)).toEqual(bytes);
    expect(readFileSync(join(f.data, path))).toEqual(bytes);
    expect(result.manifest.files.find(entry => entry.path === path)).toEqual({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  for (const [path, bytes] of database) {
    expect(entries.has(`preservation/${path}`)).toBe(false);
    expect(readFileSync(join(f.data, path))).toEqual(bytes);
    expect(result.manifest.omitted.filter(entry => entry.path === path)).toEqual([{ path, reason: DAMAGED_EXPORT_DATABASE_WITHHELD }]);
    expect(result.manifest.files.some(entry => entry.path === path)).toBe(false);
  }
  expect([...entries.values()].some(bytes => bytes.includes("fake-excluded-home-secret"))).toBe(false);
  expect(createHash("sha256").update(readFileSync(f.target)).digest("hex")).toBe(result.sha256);
  if (process.platform !== "win32") expect(lstatSync(f.target).mode & 0o777).toBe(0o600);
  await expect(inspectInstallationArchive(f.target, f.root)).rejects.toMatchObject({ code: "INVALID_ARCHIVE_MANIFEST" });
  await expect(prepareInstallationRestore(f.target, f.root)).rejects.toMatchObject({ code: "INVALID_ARCHIVE_MANIFEST" });
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

// A name a zip can't hold is left in place and listed (below), not refused.
it.each(["bytes", "files", "cancel"])("refuses %s limits without publishing or modifying damaged data", async kind => {
  const f = fixture();
  if (kind === "path") f.put("workspaces/CON", "unsafe portable name");
  const original = readFileSync(join(f.data, "config.json"));
  const controller = new AbortController(); if (kind === "cancel") controller.abort();
  await expect(writeInstallationDamagedExport(f.data, f.target, { maxBytes: kind === "bytes" ? 1 : undefined, maxFiles: kind === "files" ? 1 : undefined, signal: controller.signal })).rejects.toMatchObject({ code: kind === "cancel" ? "SNAPSHOT_CANCELLED" : kind === "path" ? "NONPORTABLE_SNAPSHOT_PATH" : "SNAPSHOT_LIMIT_EXCEEDED" });
  expect(existsSync(f.target)).toBe(false);
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-"))).toEqual([]);
  const lease = acquireDataDirLease(f.data); lease.release();
});

it("refuses existing destinations, output inside source and active ownership", async () => {
  const f = fixture();
  writeFileSync(f.target, "existing archive");
  await expect(writeInstallationDamagedExport(f.data, f.target)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(f.target, "utf8")).toBe("existing archive");
  await expect(writeInstallationDamagedExport(f.data, join(f.data, "output.zip"))).rejects.toMatchObject({ code: "DESTINATION_INSIDE_INSTALLATION" });
  const lease = acquireDataDirLease(f.data);
  try { await expect(writeInstallationDamagedExport(f.data, join(f.root, "other.zip"))).rejects.toThrow(); }
  finally { lease.release(); }
  expect(existsSync(join(f.root, "other.zip"))).toBe(false);
});

it("omits source symlinks and rejects destination aliases into the source", async () => {
  const f = fixture();
  const outside = join(f.root, "external-private"); writeFileSync(outside, "external credential canary");
  fixtureLink(outside, join(f.data, "workspaces", "outside"), "file");
  fixtureLink(f.data, join(f.data, "workspaces", "cycle"), "dir");
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expect(result.manifest.omitted).toEqual(expect.arrayContaining([{ path: "workspaces/outside", reason: "Symlink not followed" }, { path: "workspaces/cycle", reason: "Symlink not followed" }]));
  const entries = await readZip(f.target);
  expect([...entries.values()].some(bytes => bytes.includes("external credential canary"))).toBe(false);
  expect(readFileSync(outside, "utf8")).toBe("external credential canary");
  const alias = join(f.root, "alias"); fixtureLink(f.data, alias, "dir");
  await expect(writeInstallationDamagedExport(f.data, join(alias, "output.zip"))).rejects.toMatchObject({ code: "DESTINATION_INSIDE_INSTALLATION" });
});

// 0.1.60 audit A-01: what a bot ordinarily makes in its folder never stops
// the private preservation export either.
it("preserves a used bot folder: hard links, colon names and node_modules do not stop it", async () => {
  const f = fixture();
  const desk = join(f.data, "workspaces", "bot");
  mkdirSync(join(desk, "site", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(desk, "site", "node_modules", "dep", "index.js"), "x");
  writeFileSync(join(desk, "a.js"), "shared\n");
  const { linkSync } = await import("node:fs");
  linkSync(join(desk, "a.js"), join(desk, "b.js"));
  // A colon or a device name cannot be a Windows file name (a write there
  // makes an alternate data stream, or reaches the device).
  const colon = process.platform !== "win32";
  if (colon) writeFileSync(join(desk, "log 10:30.txt"), "timestamped\n");
  if (colon) f.put("workspaces/CON", "device name");
  const result = await writeInstallationDamagedExport(f.data, f.target);
  const paths = result.manifest.files.map(file => file.path);
  expect(paths).toEqual(expect.arrayContaining(["workspaces/bot/a.js", "workspaces/bot/b.js"]));
  expect(result.manifest.omitted).toEqual(expect.arrayContaining([
    { path: "workspaces/bot/site/node_modules", reason: "Rebuildable dependency or cache folder left in place" },
    ...(colon ? [{ path: "workspaces/bot/log 10:30.txt", reason: "Name another system can't hold; left in place" }] : []),
    ...(colon ? [{ path: "workspaces/CON", reason: "Name another system can't hold; left in place" }] : []),
  ]));
});

it("preserves the phone rollback journal byte for byte beside its database", async () => {
  const f = fixture();
  f.put("phone-calls.db", "damaged phone database");
  f.put("phone-calls.db-journal", Buffer.from([1, 0, 255, 42]));
  await writeInstallationDamagedExport(f.data, f.target);
  const files = await readZip(f.target);
  expect(files.get("preservation/phone-calls.db-journal")).toEqual(Buffer.from([1, 0, 255, 42]));
  expect(files.get("preservation/phone-calls.db")?.toString()).toBe("damaged phone database");
});

it("T-COPY-DAMAGED: damaged export sanitizes retired postings in its private database", async () => {
  const f = fixture();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(f.data, "messages.db" + suffix), { force: true });
  const source = new DatabaseSync(join(f.data,"messages.db"));
  try { initializeMessageTables(source); seedCopyIntents(source); source.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); ALTER TABLE messages_fts RENAME TO messages_fts_retired; CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzxretiredcanary')"); } finally { source.close(); }
  expect(readFileSync(join(f.data,"messages.db")).includes(Buffer.from("qzx"))).toBe(true);
  await writeInstallationDamagedExport(f.data,f.target);
  const files = await readZip(f.target);
  const entry = [...files].find(([name]) => name.endsWith("/messages.db"));
  expect(entry).toBeDefined();
  const file = join(f.root,"sanitized.db"); writeFileSync(file,entry![1]);
  const copy = new DatabaseSync(file,{readOnly:true});
  try { expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]); expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]); } finally { copy.close(); }
  expect(readFileSync(file).includes(Buffer.from("qzx"))).toBe(false);
});
