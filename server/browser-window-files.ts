import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { inside, treeManifest } from './browser-window-identity.ts';
import { isChromeVersion, type WindowChromePlatform } from './browser-window-validated.ts';
import type { PackageFile } from './browser-window-linux.ts';
export type ChromeCandidate = { root: string; executable: string; versionFile?: string; signatureRoot?: string };
function fail(): never { throw new Error('Chrome file format could not be verified'); }
/** Reads only the version resource. No candidate executable is ever run. */
export function readChromeVersion(platform: WindowChromePlatform, candidate: ChromeCandidate): string {
  if (platform === 'darwin') {
    const data = readFileSync(candidate.versionFile ?? join(candidate.root, 'Contents', 'Info.plist'));
    const version = data.subarray(0, 8).toString() === 'bplist00' ? plistVersion(data) : data.toString('utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!isChromeVersion(version)) fail(); return version;
  }
  if (platform === 'win32') return peVersion(readFileSync(candidate.executable));
  const text = readFileSync(candidate.versionFile ?? '/var/lib/dpkg/status', 'utf8');
  const blocks = text.split(/\n\n/).filter(p => /^Package: google-chrome-stable$/m.test(p) && /^Status: install ok installed$/m.test(p));
  const version = blocks.length === 1 ? blocks[0].match(/^Version: (\d+\.\d+\.\d+\.\d+)-\d+$/m)?.[1] : undefined;
  if (!isChromeVersion(version)) fail(); return version;
}
/** Minimal bounded binary-plist reader: root dict and scalar string values. */
function plistVersion(data: Buffer): string {
  if (data.length < 40) fail();
  const trailer = data.length - 32, width = data[trailer + 6], refWidth = data[trailer + 7];
  const number = (offset: number, bytes: number) => { if (![1, 2, 4, 8].includes(bytes) || offset < 0 || offset + bytes > data.length) fail(); const n = bytes === 8 ? Number(data.readBigUInt64BE(offset)) : data.readUIntBE(offset, bytes); if (!Number.isSafeInteger(n)) fail(); return n; };
  const count = number(trailer + 8, 8), top = number(trailer + 16, 8), table = number(trailer + 24, 8);
  if (count > 100_000 || top >= count || table + count * width > trailer) fail();
  const object = (ref: number) => {
    if (ref >= count) fail(); const start = number(table + ref * width, width); if (start >= table) fail();
    const type = data[start] >> 4; let length = data[start] & 15, offset = start + 1;
    if (length === 15) { if (data[offset] >> 4 !== 1) fail(); const bytes = 2 ** (data[offset] & 15); length = number(offset + 1, bytes); offset += 1 + bytes; }
    return { type, length, offset };
  };
  const string = (ref: number) => {
    const { type, length, offset } = object(ref); const bytes = type === 6 ? length * 2 : length;
    if (![5, 6].includes(type) || offset + bytes > table) fail();
    if (type === 5) return data.toString('ascii', offset, offset + bytes);
    const copy = Buffer.from(data.subarray(offset, offset + bytes)); copy.swap16(); return copy.toString('utf16le');
  };
  const dict = object(top);
  if (dict.type !== 13 || dict.length > count || dict.offset + 2 * dict.length * refWidth > table) fail();
  for (let i = 0; i < dict.length; i++) if (string(number(dict.offset + i * refWidth, refWidth)) === 'CFBundleShortVersionString') return string(number(dict.offset + (dict.length + i) * refWidth, refWidth));
  return fail();
}
/** Follow the PE resource tree to RT_VERSION, then VS_FIXEDFILEINFO. An
 * incidental byte sequence elsewhere in the image is not a version resource. */
function peVersion(data: Buffer): string {
  if (data.length < 256 || data.toString('ascii', 0, 2) !== 'MZ') fail();
  const pe = data.readUInt32LE(0x3c); if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) fail();
  const sections = data.readUInt16LE(pe + 6), optional = pe + 24, optionalSize = data.readUInt16LE(pe + 20);
  if (optional + optionalSize > data.length) fail();
  const magic = data.readUInt16LE(optional), dd = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : fail());
  if (dd + 24 > optional + optionalSize) fail();
  const rva = (address: number, bytes: number) => {
    for (let i = 0; i < sections; i++) {
      const s = optional + optionalSize + i * 40; if (s + 40 > data.length) fail();
      const start = data.readUInt32LE(s + 12), size = data.readUInt32LE(s + 16), raw = data.readUInt32LE(s + 20);
      if (address >= start && address + bytes <= start + size && raw + address - start + bytes <= data.length) return raw + address - start;
    }
    return fail();
  };
  const resourceSize = data.readUInt32LE(dd + 20), base = rva(data.readUInt32LE(dd + 16), resourceSize);
  const versions: string[] = [];
  const walk = (offset: number, depth: number) => {
    if (depth > 2 || offset + 16 > resourceSize) fail();
    const p = base + offset, count = data.readUInt16LE(p + 12) + data.readUInt16LE(p + 14);
    if (count > 1000 || offset + 16 + count * 8 > resourceSize) fail();
    for (let i = 0; i < count; i++) {
      const e = p + 16 + i * 8, id = data.readUInt32LE(e), child = data.readUInt32LE(e + 4);
      if (depth === 0 && id !== 16) continue;
      if (child & 0x80000000) { walk(child & 0x7fffffff, depth + 1); continue; }
      if (depth !== 2 || child + 16 > resourceSize) fail();
      const value = rva(data.readUInt32LE(base + child), data.readUInt32LE(base + child + 4));
      if (value + 6 > data.length) fail(); const length = data.readUInt16LE(value), valueBytes = data.readUInt16LE(value + 2);
      const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
      if (!data.subarray(value + 6, value + 6 + key.length).equals(key) || valueBytes !== 52) fail();
      const fixed = (value + 6 + key.length + 3) & ~3;
      if (fixed + 52 > value + length || value + length > data.length || data.readUInt32LE(fixed) !== 0xfeef04bd) fail();
      const hi = data.readUInt32LE(fixed + 8), lo = data.readUInt32LE(fixed + 12);
      versions.push(`${hi >>> 16}.${hi & 65535}.${lo >>> 16}.${lo & 65535}`);
    }
  };
  walk(0, 0); if (!versions.length || new Set(versions).size !== 1 || !isChromeVersion(versions[0])) fail(); return versions[0];
}
/** dpkg-deb emits a tar stream; compute digests without extracting or running
 * anything from the package. Reject unsupported records under the Chrome root. */
export function readDebTar(tar: Buffer): PackageFile[] {
  const files: PackageFile[] = []; let end = false;
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  const octal = (b: Buffer) => { const s = text(b).trim(); if (!/^[0-7]+$/.test(s)) fail(); return Number.parseInt(s, 8); };
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512); if (h.every(b => b === 0)) { end = true; break; }
    const expected = octal(h.subarray(148, 156)); let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i]; if (checksum !== expected) fail();
    const size = octal(h.subarray(124, 136)); if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) fail();
    const prefix = text(h.subarray(345, 500)), name = `${prefix ? `${prefix}/` : ''}${text(h.subarray(0, 100))}`.replace(/^\.\//, '');
    if (name.startsWith('/') || name.split('/').includes('..')) fail();
    if (name.startsWith('opt/google/chrome/')) {
      const kind = String.fromCharCode(h[156]);
      if (kind === '0' || kind === '\0') {
        if (octal(h.subarray(108, 116)) !== 0 || octal(h.subarray(116, 124)) !== 0) fail();
        files.push({ path: name, mode: octal(h.subarray(100, 108)) & 0o7777, sha256: createHash('sha256').update(tar.subarray(offset + 512, offset + 512 + size)).digest('hex') });
      } else if (kind !== '5') fail();
    } else if (!['0', '\0', '5', '2'].includes(String.fromCharCode(h[156]))) fail();
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!end || !files.length) fail(); return files;
}
/** Staging directory is private and newly allocated by the caller. Symlinks
 * are created last, so no archive entry can write through one. */
export async function extractChromeZip(file: string, target: string): Promise<void> {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip!)));
  const seen = new Set<string>(), links: { path: string; target: string }[] = []; let total = 0;
  try {
    if (zip.entryCount < 1 || zip.entryCount > 50_000) fail();
    await new Promise<void>((done, reject) => {
      zip.once('error', reject); zip.once('end', done);
      zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
        const name = entry.fileName.replace(/\/$/, ''), parts = name.split('/');
        if (!name || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) || seen.has(name.toLowerCase()) || entry.isEncrypted()) fail();
        seen.add(name.toLowerCase()); const out = resolve(target, name); if (!inside(target, out)) fail();
        const mode = entry.externalFileAttributes >>> 16, kind = mode & 0o170000;
        if (entry.fileName.endsWith('/')) { if (kind && kind !== 0o040000) fail(); mkdirSync(out, { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
        if (kind && ![0o100000, 0o120000].includes(kind)) fail();
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > 1024 * 1024 * 1024 - total || (kind === 0o120000 && entry.uncompressedSize > 4096)) fail();
        const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)));
        let count = 0; const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { count += chunk.length; total += chunk.length; callback(count > entry.uncompressedSize || total > 1024 * 1024 * 1024 ? new Error('Chrome archive size limit') : null, chunk); } });
        mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
        if (kind === 0o120000) {
          const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const link = Buffer.concat(chunks).toString('utf8'); if (!link || link.includes('\0') || link.includes('\\') || !inside(target, resolve(dirname(out), link))) fail();
          links.push({ path: out, target: link });
        } else { await pipeline(stream, counter, createWriteStream(out, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o600 })); if (count !== entry.uncompressedSize) fail(); }
        zip.readEntry();
      })().catch(reject); });
      zip.readEntry();
    });
    for (const link of links) symlinkSync(link.target, link.path);
    treeManifest(target);
  } finally { zip.close(); }
}
