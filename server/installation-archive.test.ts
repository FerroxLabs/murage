import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { inspectInstallationArchive, portableArchivePath, writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";

const roots: string[] = [];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "murage-archive-test-"));
  roots.push(parent);
  const data = join(parent, "installation");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), '{"profile":{"name":"Fixture owner"},"flux":{"apiKey":"archive-credential-canary"}}');
  writeFileSync(join(data, "bots.json"), '[{"id":"bot","threadId":"thread","name":"Fixture"}]');
  return { parent, data, archive: join(parent, "fixture.murage-backup.zip") };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function crafted(f: ReturnType<typeof fixture>, files: Array<{ path: string; text: string | Buffer; mode?: number }>, mutate?: (manifest: any) => void, zip64 = false, compress = false) {
  const manifest = {
    format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) })),
    omitted: [], missing: [], database: { status: "absent" },
  };
  mutate?.(manifest);
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, createWriteStream(f.archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  for (const file of files) zip.addBuffer(Buffer.from(file.text), `state/${file.path}`, { compress, mode: file.mode ?? 0o100600, forceZip64Format: zip64 });
  zip.end({ forceZip64Format: zip64, comment: "" });
  await output;
}

it.each(["trigger", "counts", "cycle"])("rejects a hash-valid external database archive with invalid %s before restore publication", async kind => {
  const f = fixture(), path = join(f.parent, "external.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("t", "m", 1, "user", "text", null, JSON.stringify({ id: "m", at: 1, role: "user", kind: "text", parentId: kind === "cycle" ? "m" : null }));
    db.exec("INSERT INTO thread_state VALUES('t','m')");
    if (kind === "trigger") db.exec("CREATE TRIGGER hostile AFTER UPDATE ON messages BEGIN UPDATE thread_state SET active_leaf_id=NULL WHERE thread_id='t'; END");
  } finally { db.close(); }
  const bytes = readFileSync(path);
  await crafted(f, [{ path: "messages.db", text: bytes }], manifest => {
    manifest.database = { status: "copied", messages: kind === "counts" ? 2 : 1, threads: 1, bytes: bytes.length, sha256: sha(bytes) };
  });
  const before = readFileSync(f.archive);
  await expect(prepareInstallationRestore(f.archive, f.parent)).rejects.toMatchObject({ code: kind === "trigger" ? "DATABASE_SCHEMA_UNSUPPORTED" : kind === "counts" ? "INVALID_DATABASE_MANIFEST" : "CYCLIC_MESSAGE_BRANCH" });
  expect(readFileSync(f.archive)).toEqual(before);
  expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-archive-inspection-"))).toEqual([]);
});

it.each(["missing-parent", "cycle", "missing-head", "duplicate"])("rejects an external legacy transcript with %s", async kind => {
  const f = fixture();
  const message = { id: "m", at: 1, role: "user", kind: "text", parentId: kind === "cycle" ? "m" : kind === "missing-parent" ? "missing" : null };
  await crafted(f, [{ path: "messages-thread.json", text: JSON.stringify({ messages: kind === "duplicate" ? [message, message] : [message], activeLeafId: kind === "missing-head" ? "missing" : "m" }) }]);
  await expect(prepareInstallationRestore(f.archive, f.parent)).rejects.toMatchObject({ code: kind === "cycle" ? "CYCLIC_MESSAGE_BRANCH" : kind === "missing-parent" ? "INVALID_MESSAGE_PARENT" : kind === "missing-head" ? "INVALID_ACTIVE_BRANCH" : "INVALID_RESTORE_MESSAGE" });
});

it.each(["routines.json", "webhooks.json", "delegation-receipts.json"])("rejects malformed external %s even when archive hashes are valid", async path => {
  const f = fixture();
  const value = path === "routines.json" ? { version: 1, routines: [], runs: [], routineRequestReceipts: [{ requestId: "r", fingerprint: "b".repeat(64) }] }
    : path === "webhooks.json" ? { version: 1, webhooks: [], deliveries: [{ deliveryId: "not-a-key", runId: "r" }] }
    : [{ id: "r", status: "done" }];
  await crafted(f, [{ path, text: JSON.stringify(value) }]);
  const original = readFileSync(f.archive);
  await expect(prepareInstallationRestore(f.archive, f.parent)).rejects.toMatchObject({ code: "INVALID_INSTALLATION_RECORDS" });
  expect(readFileSync(f.archive)).toEqual(original);
});

it.each(["companion/devices.json", "companion", "connection-profiles/old/credentials.bin", "restored-connections.json"])("an external archive cannot install connection authority at %s", async path => {
  const f = fixture();
  await crafted(f, [{ path, text: "injected-connection-authority" }]);
  await expect(prepareInstallationRestore(f.archive, f.parent)).rejects.toMatchObject({ code: "RESERVED_RESTORE_COMPONENT" });
});

it("round trips a private installation archive without changing source or exporting configured credentials", async () => {
  const f = fixture();
  const original = readFileSync(join(f.data, "config.json"));
  const result = await writeInstallationArchive(f.data, f.archive);
  const inspected = await inspectInstallationArchive(f.archive, f.parent);
  expect(inspected.sha256).toBe(result.sha256);
  expect(inspected.manifest.format).toBe("murage.installation");
  expect(readFileSync(join(inspected.directory, "state", "config.json"), "utf8")).not.toContain("archive-credential-canary");
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
  expect(result.manifest.omitted).toContainEqual({ path: "config.json/flux", reason: "Credential-bearing or unknown configuration excluded" });
});

it("supports ZIP64 metadata without requiring a giant in-memory fixture", async () => {
  const f = fixture();
  await crafted(f, [{ path: "attachments/file.txt", text: "ZIP64 receipt" }], undefined, true);
  const result = await inspectInstallationArchive(f.archive, f.parent);
  expect(readFileSync(join(result.directory, "state", "attachments/file.txt"), "utf8")).toBe("ZIP64 receipt");
});

it("refuses to replace a backup file that already exists", async () => {
  const f = fixture();
  writeFileSync(f.archive, "existing-backup-sentinel");
  await expect(writeInstallationArchive(f.data, f.archive)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(f.archive, "utf8")).toBe("existing-backup-sentinel");
});

it.each(["duplicate", "case-collision", "file-parent"])("rejects %s paths before exposing a extracted stage", async kind => {
  const f = fixture();
  const second = kind === "duplicate" ? "a" : kind === "case-collision" ? "A" : "a/b";
  await crafted(f, [{ path: "a", text: "first" }, { path: second, text: "second" }]);
  await expect(inspectInstallationArchive(f.archive, f.parent)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE_PATH" });
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-archive-inspection-"))).toEqual([]);
});

it("rejects raw ZIP traversal names even when local and central headers agree", async () => {
  const f = fixture();
  await crafted(f, [{ path: "evil/file", text: "do not escape" }]);
  const bytes = readFileSync(f.archive).toString("latin1").replaceAll("state/evil/file", "state/../x/file");
  writeFileSync(f.archive, Buffer.from(bytes, "latin1"));
  await expect(inspectInstallationArchive(f.archive, f.parent)).rejects.toThrow();
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-archive-inspection-"))).toEqual([]);
});

it("rejects a symlink entry rather than writing or following it", async () => {
  const f = fixture();
  await crafted(f, [{ path: "link", text: "../../outside", mode: 0o120777 }]);
  await expect(inspectInstallationArchive(f.archive, f.parent)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE_ENTRY" });
});

it("checks file content against manifest hashes", async () => {
  const f = fixture();
  await crafted(f, [{ path: "item", text: "correct" }], manifest => { manifest.files[0].sha256 = "0".repeat(64); });
  await expect(inspectInstallationArchive(f.archive, f.parent)).rejects.toMatchObject({ code: "ARCHIVE_HASH_MISMATCH" });
});

it("refuses byte and entry budgets before unbounded extraction", async () => {
  const f = fixture();
  await crafted(f, [{ path: "a", text: "123456789" }, { path: "b", text: "abc" }]);
  await expect(inspectInstallationArchive(f.archive, f.parent, { maxBytes: 5 })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
  await expect(inspectInstallationArchive(f.archive, f.parent, { maxFiles: 1 })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
});

it("rejects excessive expansion ratio even inside the total-byte budget", async () => {
  const f = fixture();
  await crafted(f, [{ path: "repetitive", text: "a".repeat(1024 * 1024) }], undefined, false, true);
  await expect(inspectInstallationArchive(f.archive, f.parent, { maxBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ code: "ARCHIVE_COMPRESSION_RATIO_EXCEEDED" });
});

it("rejects undeclared entries and missing declared files", async () => {
  const f = fixture();
  await crafted(f, [{ path: "a", text: "content" }], manifest => { manifest.files[0].path = "b"; });
  await expect(inspectInstallationArchive(f.archive, f.parent)).rejects.toMatchObject({ code: "UNDECLARED_ARCHIVE_ENTRY" });
});

it("refuses cancellation without leaving partial extraction directories", async () => {
  const f = fixture();
  await crafted(f, [{ path: "a", text: "content" }]);
  const controller = new AbortController();
  controller.abort();
  await expect(inspectInstallationArchive(f.archive, f.parent, { signal: controller.signal })).rejects.toMatchObject({ code: "SNAPSHOT_CANCELLED" });
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-archive-inspection-"))).toEqual([]);
});

it.each(["../outside", "/root", "C:/data", "a\\b", "a//b", "a/./b", "a/../b", "NUL.txt", "a:stream", "a. "])("refuses unsafe portable path %s", path => {
  expect(portableArchivePath(path)).toBe(false);
});
