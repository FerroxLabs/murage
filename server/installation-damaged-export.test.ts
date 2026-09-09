import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as yauzl from "yauzl";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { inspectInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { writeInstallationDamagedExport } from "./installation-damaged-export.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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

it("exports damaged JSON and database bytes unchanged as private non-restorable evidence", async () => {
  const f = fixture();
  for (const home of ["vm-home", "vm-homes", "connection-profiles", "companion", "native", "flux-hermes-home"]) f.put(`${home}/private`, "fake-excluded-home-secret");
  const originals = new Map(["config.json", "messages.db", "messages.db-wal", "messages.db-shm", "section-contexts.json", "workspaces/bot/notes.txt", "artifact-files/report.html"].map(path => [path, readFileSync(join(f.data, path))]));
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
  expect([...entries.values()].some(bytes => bytes.includes("fake-excluded-home-secret"))).toBe(false);
  expect(createHash("sha256").update(readFileSync(f.target)).digest("hex")).toBe(result.sha256);
  if (process.platform !== "win32") expect(lstatSync(f.target).mode & 0o777).toBe(0o600);
  await expect(inspectInstallationArchive(f.target, f.root)).rejects.toMatchObject({ code: "INVALID_ARCHIVE_MANIFEST" });
  await expect(prepareInstallationRestore(f.target, f.root)).rejects.toMatchObject({ code: "INVALID_ARCHIVE_MANIFEST" });
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

it.each(["bytes", "files", "cancel", "path"])("refuses %s limits without publishing or modifying damaged data", async kind => {
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

it.skipIf(process.platform === "win32")("omits source symlinks and rejects destination aliases into the source", async () => {
  const f = fixture();
  const outside = join(f.root, "external-private"); writeFileSync(outside, "external credential canary");
  symlinkSync(outside, join(f.data, "workspaces", "outside"));
  symlinkSync(f.data, join(f.data, "workspaces", "cycle"));
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expect(result.manifest.omitted).toEqual(expect.arrayContaining([{ path: "workspaces/outside", reason: "Symlink not followed" }, { path: "workspaces/cycle", reason: "Symlink not followed" }]));
  const entries = await readZip(f.target);
  expect([...entries.values()].some(bytes => bytes.includes("external credential canary"))).toBe(false);
  expect(readFileSync(outside, "utf8")).toBe("external credential canary");
  const alias = join(f.root, "alias"); symlinkSync(f.data, alias);
  await expect(writeInstallationDamagedExport(f.data, join(alias, "output.zip"))).rejects.toMatchObject({ code: "DESTINATION_INSIDE_INSTALLATION" });
});
