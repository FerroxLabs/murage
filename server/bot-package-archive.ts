import { createHash } from "node:crypto";
import { closeSync, constants, createWriteStream, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";
import { MAX_BOT_PACKAGE_COMPRESSION_RATIO, MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath, parseBotPackageManifest, type BotPackageManifest } from "./bot-package-manifest.ts";
import { scanBotPackageContents } from "./bot-package-scan.ts";

export class BotPackageArchiveError extends Error {
  constructor(readonly code: string) { super(`Package archive refused (${code}).`); }
}
function fail(code: string): never { throw new BotPackageArchiveError(code); }
const check = (signal?: AbortSignal) => { if (signal?.aborted) fail("PACKAGE_ARCHIVE_CANCELLED"); };
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_ARCHIVE_BYTES = MAX_BOT_PACKAGE_EXPANDED_BYTES + MAX_BOT_PACKAGE_ENTRIES * 2048;

/** Read-only, in-memory intake. This never extracts or executes payloads,
 * resolves dependencies, grants authority, or imports anything into a store. */
export async function readBotPackageArchive(path: string, options: { signal?: AbortSignal } = {}) {
  check(options.signal);
  let fd: number | undefined, zip: yauzl.ZipFile | undefined, inFlight: Promise<void> | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("UNSAFE_PACKAGE_ARCHIVE");
    if (before.size > MAX_ARCHIVE_BYTES) fail("PACKAGE_ARCHIVE_LIMIT");
    fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail("PACKAGE_ARCHIVE_CHANGED");
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromFd(fd!, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
    if (zip.entryCount < 1 || zip.entryCount > MAX_BOT_PACKAGE_ENTRIES) fail("PACKAGE_ARCHIVE_LIMIT");
    let manifest: BotPackageManifest | undefined;
    let manifestBytes: Buffer | undefined;
    const payloads = new Map<string, Buffer>(), seen = new Set<string>();
    let expanded = 0;
    await new Promise<void>((resolve, reject) => {
      const source = zip!;
      source.once("error", reject);
      source.once("end", resolve);
      source.on("entry", (entry: yauzl.Entry) => {
        inFlight = (async () => {
          check(options.signal);
          const name = normalizeBotPackagePath(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (seen.has(name.toLowerCase()) || (mode !== 0 && mode !== 0o100000) || (entry.externalFileAttributes & 0x10) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) fail("UNSAFE_PACKAGE_ENTRY");
          seen.add(name.toLowerCase());
          if (!manifest && name !== "manifest.json") fail("PACKAGE_MANIFEST_MUST_BE_FIRST");
          const expected = manifest?.entries.find(item => item.path === name);
          if (manifest && !expected) fail("UNDECLARED_PACKAGE_ENTRY");
          for (const size of [entry.compressedSize, entry.uncompressedSize]) if (!Number.isSafeInteger(size) || size < 0) fail("PACKAGE_ARCHIVE_LIMIT");
          if (entry.uncompressedSize > MAX_BOT_PACKAGE_EXPANDED_BYTES - expanded || entry.compressedSize > MAX_ARCHIVE_BYTES) fail("PACKAGE_ARCHIVE_LIMIT");
          if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_BOT_PACKAGE_COMPRESSION_RATIO) fail("PACKAGE_COMPRESSION_RATIO");
          if (expected && entry.uncompressedSize !== expected.bytes) fail("PACKAGE_SIZE_MISMATCH");
          // Count actual compressed and expanded stream bytes independently;
          // central-directory declarations cannot substitute for these checks.
          const raw = await new Promise<Readable>((resolve, reject) => source.openReadStream(entry, entry.compressionMethod === 8 ? { decompress: false } : {}, (error, stream) => error ? reject(error) : resolve(stream)));
          let compressed = 0, bytes = 0;
          const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            compressed += chunk.length;
            callback(compressed > entry.compressedSize ? new BotPackageArchiveError("PACKAGE_SIZE_MISMATCH") : null, chunk);
          } });
          const decoded = entry.compressionMethod === 8 ? createInflateRaw() : new PassThrough();
          const transferred = pipeline(raw, counter, decoded, { signal: options.signal });
          void transferred.catch(() => {});
          const chunks: Buffer[] = [];
          const hash = createHash("sha256");
          try {
            for await (const chunk of decoded) {
              check(options.signal);
              const buffer = chunk as Buffer;
              bytes += buffer.length;
              expanded += buffer.length;
              if (bytes > entry.uncompressedSize || (expected && bytes > expected.bytes)) fail("PACKAGE_SIZE_MISMATCH");
              if (expanded > MAX_BOT_PACKAGE_EXPANDED_BYTES) fail("PACKAGE_ARCHIVE_LIMIT");
              hash.update(buffer); chunks.push(buffer);
            }
            await transferred;
            if (bytes !== entry.uncompressedSize || compressed !== entry.compressedSize) fail("PACKAGE_SIZE_MISMATCH");
            if (bytes > Math.max(1, compressed) * MAX_BOT_PACKAGE_COMPRESSION_RATIO) fail("PACKAGE_COMPRESSION_RATIO");
            if (expected && hash.digest("hex") !== expected.sha256) fail("PACKAGE_HASH_MISMATCH");
            const content = Buffer.concat(chunks, bytes);
            if (expected) payloads.set(name, content);
            else {
              manifestBytes = content;
              manifest = parseBotPackageManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
              if (manifest.entries.length + 1 !== source.entryCount) fail("PACKAGE_ENTRY_COUNT_MISMATCH");
            }
          } finally { raw.destroy(); counter.destroy(); decoded.destroy(); await transferred.catch(() => {}); }
          source.readEntry();
        })().catch(error => { reject(error); });
      });
      source.readEntry();
    });
    if (!manifest || !manifestBytes || payloads.size !== manifest.entries.length) fail("MISSING_PACKAGE_ENTRY");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      check(options.signal);
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes)); offset += bytes;
      if (offset > MAX_ARCHIVE_BYTES) fail("PACKAGE_ARCHIVE_LIMIT");
    }
    const after = lstatSync(path);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("PACKAGE_ARCHIVE_CHANGED");
    const scan = scanBotPackageContents([{ path: "manifest.json", content: manifestBytes }, ...[...payloads].map(([path, content]) => ({ path, content }))]);
    return { manifest, payloads, scan, sha256: hash.digest("hex") };
  } catch (error) {
    if (options.signal?.aborted) fail("PACKAGE_ARCHIVE_CANCELLED");
    throw error instanceof BotPackageArchiveError ? error : new BotPackageArchiveError("INVALID_PACKAGE_ARCHIVE");
  } finally {
    await inFlight?.catch(() => {});
    if (zip) zip.close(); else if (fd !== undefined) closeSync(fd);
  }
}

/** Publish one new private archive only after manifest, hashes and content
 * scan pass. Review findings are returned for the caller's confirmation flow.
 * POSIX permissions are 0700 scratch/0600 output; Windows requires owner ACLs. */
export async function writeBotPackageArchive(destination: string, input: {
  manifest: unknown; payloads: ReadonlyMap<string, string | Uint8Array>;
}, options: { signal?: AbortSignal } = {}) {
  check(options.signal);
  const name = normalizeBotPackagePath(basename(destination));
  const target = join(realpathSync(dirname(destination)), name);
  try { lstatSync(target); fail("PACKAGE_DESTINATION_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const manifest = parseBotPackageManifest(input.manifest);
  if (input.payloads.size !== manifest.entries.length) fail("UNDECLARED_PACKAGE_ENTRY");
  const payloads = new Map<string, Buffer>();
  const metadata = Buffer.from(JSON.stringify(manifest) + "\n");
  let expanded = metadata.length;
  for (const entry of manifest.entries) {
    const payload = input.payloads.get(entry.path);
    if (payload === undefined) fail("MISSING_PACKAGE_ENTRY");
    const size = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
    expanded += size;
    if (expanded > MAX_BOT_PACKAGE_EXPANDED_BYTES) fail("PACKAGE_ARCHIVE_LIMIT");
    if (size !== entry.bytes) fail("PACKAGE_SIZE_MISMATCH");
    const bytes = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
    if (digest(bytes) !== entry.sha256) fail("PACKAGE_HASH_MISMATCH");
    payloads.set(entry.path, bytes);
  }
  const scan = scanBotPackageContents([{ path: "manifest.json", content: metadata }, ...[...payloads].map(([path, content]) => ({ path, content }))]);
  if (scan.blocked) fail("PACKAGE_CONTENT_SCAN_BLOCKED");
  const scratch = mkdtempSync(join(dirname(target), ".murage-package-write-"));
  const writer = new ZipFile();
  const file = join(scratch, "bundle.zip");
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  writer.once("error", error => output.destroy(error));
  const completed = pipeline(writer.outputStream as Readable, output, { signal: options.signal });
  void completed.catch(() => {});
  try {
    writer.addBuffer(metadata, "manifest.json", { compress: false, mode: 0o100600 });
    for (const [path, content] of payloads) writer.addBuffer(content, path, { compress: false, mode: 0o100600 });
    writer.end(); await completed;
    const result = await readBotPackageArchive(file, options);
    if (result.scan.blocked) fail("PACKAGE_CONTENT_SCAN_BLOCKED");
    const fd = openSync(file, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    check(options.signal); linkSync(file, target);
    return { ...result, path: target };
  } catch (error) {
    throw error instanceof BotPackageArchiveError ? error : new BotPackageArchiveError((error as NodeJS.ErrnoException).code === "EEXIST" ? "PACKAGE_DESTINATION_EXISTS" : "PACKAGE_ARCHIVE_WRITE_FAILED");
  } finally {
    (writer.outputStream as Readable).destroy(); output.destroy();
    await completed.catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}
