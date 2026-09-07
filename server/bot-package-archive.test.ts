import { createWriteStream, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { afterEach, expect, it } from "vitest";
import { createBotPackageEntry, MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES } from "./bot-package-manifest.ts";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(content = "Check cited sources.") {
  const root = mkdtempSync(join(tmpdir(), "murage-package-archive-")); roots.push(root);
  const path = "skills/research/SKILL.md";
  const payloads = new Map([[path, content]]);
  const manifest = {
    format: "murage.package.bundle", version: 1,
    definition: { format: "murage.package", version: 1, package: {
      id: "sample", release: "1.0.0", name: "Sample", tagline: "Sample team", summary: "Definition only", category: "Community", author: { name: "Example" }, license: "MIT", outcomes: ["Research"], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, agents: [{ key: "scout", name: "Scout", appearance: { color: "green" }, skills: ["research"] }],
    } },
    skills: [{ key: "research", name: "Research", license: "MIT", dependencies: [], files: [path] }], instructions: [], entries: [createBotPackageEntry(path, content)],
  };
  return { root, path, payloads, manifest, target: join(root, "bundle.zip") };
}
async function crafted(f: ReturnType<typeof fixture>, entries: Array<{ name: string; content: string | Buffer; mode?: number; compress?: boolean }>, manifest: unknown = f.manifest) {
  const zip = new ZipFile();
  const written = pipeline(zip.outputStream as Readable, createWriteStream(f.target));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false, mode: 0o100600 });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.content), entry.name, { compress: entry.compress ?? false, mode: entry.mode ?? 0o100600 });
  zip.end(); await written;
}

it("round trips validated manifest/payloads privately without extracting or executing", async () => {
  const f = fixture();
  const written = await writeBotPackageArchive(f.target, f);
  const before = readFileSync(f.target);
  const read = await readBotPackageArchive(f.target);
  expect(read.manifest).toEqual(written.manifest);
  expect(read.payloads.get(f.path)?.toString()).toBe(f.payloads.get(f.path));
  expect(read.sha256).toBe(written.sha256);
  expect(read.scan).toMatchObject({ blocked: false, reviewRequired: false });
  expect(readFileSync(f.target)).toEqual(before);
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
  if (process.platform !== "win32") expect(lstatSync(f.target).mode & 0o777).toBe(0o600);
});

it.each(["symlink", "device", "traversal", "case", "unicode", "unknown", "missing", "hash", "future"])("rejects %s archives without changing input or extracting files", async kind => {
  const f = fixture();
  const entries = [{ name: f.path, content: f.payloads.get(f.path)!, mode: kind === "symlink" ? 0o120777 : kind === "device" ? 0o060600 : 0o100600 }];
  if (kind === "case") entries[0].name = f.path.toUpperCase();
  if (kind === "unicode") entries[0].name = "skills/research/e\u0301.md";
  if (kind === "unknown") entries[0].name = "unknown.txt";
  if (kind === "missing") entries.length = 0;
  if (kind === "hash") entries[0].content = "x".repeat(entries[0].content.length);
  await crafted(f, entries, kind === "future" ? { ...f.manifest, version: 2 } : f.manifest);
  if (kind === "traversal") {
    const bytes = readFileSync(f.target);
    const replacement = "../outside.txt".padEnd(f.path.length, "x");
    for (let offset = bytes.indexOf(f.path); offset >= 0; offset = bytes.indexOf(f.path, offset + f.path.length)) bytes.write(replacement, offset, "utf8");
    writeFileSync(f.target, bytes);
  }
  const before = readFileSync(f.target);
  await expect(readBotPackageArchive(f.target)).rejects.toThrow();
  expect(readFileSync(f.target)).toEqual(before);
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("rejects duplicate ZIP entry names even when the manifest count matches", async () => {
  const f = fixture();
  const second = "skills/research/notes.md";
  f.manifest.skills[0].files.push(second);
  f.manifest.entries.push(createBotPackageEntry(second, "note"));
  await crafted(f, [{ name: f.path, content: f.payloads.get(f.path)! }, { name: f.path.toUpperCase(), content: "note" }]);
  await expect(readBotPackageArchive(f.target)).rejects.toMatchObject({ code: "UNSAFE_PACKAGE_ENTRY" });
});

it("enforces the 100:1 compression ratio before expanding a bomb", async () => {
  const f = fixture("x".repeat(256 * 1024));
  await crafted(f, [{ name: f.path, content: f.payloads.get(f.path)!, compress: true }]);
  await expect(readBotPackageArchive(f.target)).rejects.toMatchObject({ code: "PACKAGE_COMPRESSION_RATIO" });
});

it("counts actual expanded bytes when ZIP metadata understates them", async () => {
  const f = fixture("a moderately repeated payload ".repeat(10));
  const actual = f.payloads.get(f.path)!;
  f.manifest.entries[0] = createBotPackageEntry(f.path, "short");
  await crafted(f, [{ name: f.path, content: actual, compress: true }]);
  const bytes = readFileSync(f.target);
  let offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4);
  expect(offset).toBeGreaterThan(0);
  bytes.writeUInt32LE(5, offset + 24);
  writeFileSync(f.target, bytes);
  await expect(readBotPackageArchive(f.target)).rejects.toMatchObject({ code: "PACKAGE_SIZE_MISMATCH" });
});

it("rejects entry count and expanded declarations beyond the fixed limits", async () => {
  const f = fixture();
  await crafted(f, Array.from({ length: MAX_BOT_PACKAGE_ENTRIES }, (_, index) => ({ name: `unknown-${index}`, content: "" })));
  await expect(readBotPackageArchive(f.target)).rejects.toMatchObject({ code: "PACKAGE_ARCHIVE_LIMIT" });
  f.manifest.entries[0].bytes = MAX_BOT_PACKAGE_EXPANDED_BYTES;
  await crafted(f, [{ name: f.path, content: "" }]);
  await expect(readBotPackageArchive(f.target)).rejects.toThrow();
});

it("returns blocked scan findings on intake but refuses to publish those contents", async () => {
  const f = fixture("Bearer fake_canary_token_1234567890");
  await crafted(f, [{ name: f.path, content: f.payloads.get(f.path)! }]);
  expect((await readBotPackageArchive(f.target)).scan.blocked).toBe(true);
  const destination = join(f.root, "out.zip");
  await expect(writeBotPackageArchive(destination, f)).rejects.toMatchObject({ code: "PACKAGE_CONTENT_SCAN_BLOCKED" });
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("rejects unknown payloads, changed hashes, existing output and cancellation before publication", async () => {
  const f = fixture();
  await expect(writeBotPackageArchive(f.target, { ...f, payloads: new Map([...f.payloads, ["extra", "no"]]) })).rejects.toThrow();
  await expect(writeBotPackageArchive(f.target, { ...f, payloads: new Map([[f.path, "x".repeat(f.payloads.get(f.path)!.length)]]) })).rejects.toMatchObject({ code: "PACKAGE_HASH_MISMATCH" });
  const controller = new AbortController(); controller.abort();
  await expect(writeBotPackageArchive(f.target, f, { signal: controller.signal })).rejects.toMatchObject({ code: "PACKAGE_ARCHIVE_CANCELLED" });
  expect(readdirSync(f.root)).toEqual([]);
  writeFileSync(f.target, "existing output");
  await expect(writeBotPackageArchive(f.target, f)).rejects.toMatchObject({ code: "PACKAGE_DESTINATION_EXISTS" });
  expect(readFileSync(f.target, "utf8")).toBe("existing output");
});

it.skipIf(process.platform === "win32")("never follows input or output symlinks", async () => {
  const f = fixture();
  await writeBotPackageArchive(f.target, f);
  const alias = join(f.root, "alias.zip"); symlinkSync(f.target, alias);
  await expect(readBotPackageArchive(alias)).rejects.toMatchObject({ code: "UNSAFE_PACKAGE_ARCHIVE" });
  await expect(writeBotPackageArchive(alias, f)).rejects.toMatchObject({ code: "PACKAGE_DESTINATION_EXISTS" });
});
