import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZipFile } from 'yazl';
import { extractChromeZip, readChromeVersion, readDebTar } from './browser-window-files.ts';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chrome-files-')); });
afterEach(() => removeTempDirSync(root));
it('reads a four-part macOS version from the bundle without executing Chrome', () => {
  const file = join(root, 'Info.plist'); writeFileSync(file, '<plist><dict><key>CFBundleShortVersionString</key><string>157.0.8103.38</string></dict></plist>');
  expect(readChromeVersion('darwin', { root, executable: join(root, 'chrome'), versionFile: file })).toBe('157.0.8103.38');
  writeFileSync(file, '<plist><dict><key>CFBundleShortVersionString</key><string>157.*</string></dict></plist>'); expect(() => readChromeVersion('darwin', { root, executable: '', versionFile: file })).toThrow();
});
it('extends the packaged signer evidence with organization and thumbprint', () => {
  const source = readFileSync(new URL('../native/engine-exclusion/exclusion.c', import.meta.url), 'utf8');
  expect(source).toContain('CERT_SHA256_HASH_PROP_ID');
  expect(source).toContain('szOID_ORGANIZATION_NAME');
  expect(source).toMatch(/napi_set_named_property\(env, result, "thumbprint", value\)/);
});
it('extracts private files and contained framework symlinks', async () => {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from('chrome'), 'app/chrome', { mode: 0o100755 }); zip.addBuffer(Buffer.from('chrome'), 'app/link', { mode: 0o120777 });
  const chunks: Buffer[] = []; zip.outputStream.on('data', b => chunks.push(b)); const done = new Promise<void>(r => zip.outputStream.on('end', r)); zip.end(); await done;
  const file = join(root, 'chrome.zip'); writeFileSync(file, Buffer.concat(chunks)); await extractChromeZip(file, join(root, 'out'));
  expect(readFileSync(join(root, 'out/app/link'), 'utf8')).toBe('chrome');
});
it('rejects an archive symlink leaving the private tree', async () => {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from('../../outside'), 'app/link', { mode: 0o120777 });
  const chunks: Buffer[] = []; zip.outputStream.on('data', b => chunks.push(b)); const done = new Promise<void>(r => zip.outputStream.on('end', r)); zip.end(); await done;
  const file = join(root, 'chrome.zip'); writeFileSync(file, Buffer.concat(chunks)); await expect(extractChromeZip(file, join(root, 'out'))).rejects.toThrow();
});
it('refuses a malformed tar instead of inventing a package table', () => { expect(() => readDebTar(Buffer.from('not tar'))).toThrow(); });

// Minimal PE resource tree: RT_VERSION -> name -> language -> fixed info.
function peFixture() {
  const b = Buffer.alloc(1024); b.write('MZ'); b.writeUInt32LE(128, 0x3c); b.writeUInt32LE(0x4550, 128);
  b.writeUInt16LE(0x14c, 132); b.writeUInt16LE(1, 134); b.writeUInt16LE(224, 148); const opt = 152;
  b.writeUInt16LE(0x10b, opt); b.writeUInt32LE(16, opt + 92); b.write('.rsrc', 376); b.writeUInt32LE(512, 384); b.writeUInt32LE(0x1000, opt + 112); b.writeUInt32LE(512, opt + 116);
  b.writeUInt32LE(0x1000, 388); b.writeUInt32LE(512, 392); b.writeUInt32LE(512, 396);
  for (const [offset, id, child] of [[0, 16, 0x80000020], [32, 1, 0x80000040], [64, 1033, 96]]) {
    b.writeUInt16LE(1, 512 + offset + 14); b.writeUInt32LE(id, 512 + offset + 16); b.writeUInt32LE(child, 512 + offset + 20);
  }
  b.writeUInt32LE(0x1080, 608); b.writeUInt32LE(92, 612); b.writeUInt16LE(92, 640); b.writeUInt16LE(52, 642);
  b.write('VS_VERSION_INFO\0', 646, 'utf16le'); b.writeUInt32LE(0xfeef04bd, 680);
  b.writeUInt32LE(157 * 65536, 688); b.writeUInt32LE(8103 * 65536 + 38, 692); return b;
}
it('reads a PE version resource and refuses malformed resource paths and fixed info', () => {
  const executable = join(root, 'chrome.exe'), good = peFixture(); writeFileSync(executable, good);
  expect(readChromeVersion('win32', { root, executable })).toBe('157.0.8103.38');
  for (const corrupt of [(b: Buffer) => b.writeUInt32LE(0xffff, 264), (b: Buffer) => b.writeUInt32LE(0x80000fff, 532), (b: Buffer) => b.writeUInt32LE(0, 680), (b: Buffer) => b.writeUInt16LE(4, 640)]) {
    const bad = Buffer.from(good); corrupt(bad); writeFileSync(executable, bad); expect(() => readChromeVersion('win32', { root, executable })).toThrow();
  }
});
function binaryPlist() {
  const key = Buffer.from('CFBundleShortVersionString'), value = Buffer.from('157.0.8103.38');
  const objects = [Buffer.from([0xd1, 1, 2]), Buffer.concat([Buffer.from([0x5f, 0x10, key.length]), key]), Buffer.concat([Buffer.from([0x50 + value.length]), value])];
  const offsets = [8, 11, 11 + objects[1].length], table = 8 + objects.reduce((n, b) => n + b.length, 0);
  const trailer = Buffer.alloc(32); trailer[6] = trailer[7] = 1; trailer.writeBigUInt64BE(3n, 8); trailer.writeBigUInt64BE(BigInt(table), 24);
  return Buffer.concat([Buffer.from('bplist00'), ...objects, Buffer.from(offsets), trailer]);
}
it('reads binary plist version and rejects malformed trailers, refs and strings', () => {
  const file = join(root, 'Info.plist'), good = binaryPlist(), candidate = { root, executable: '', versionFile: file };
  writeFileSync(file, good); expect(readChromeVersion('darwin', candidate)).toBe('157.0.8103.38');
  for (const corrupt of [(b: Buffer) => { b[b.length - 26] = 3; }, (b: Buffer) => { b[10] = 99; }, (b: Buffer) => { b[39] = 0x4f; }]) {
    const bad = Buffer.from(good); corrupt(bad); writeFileSync(file, bad); expect(() => readChromeVersion('darwin', candidate)).toThrow();
  }
});
it('reads a valid root-owned deb tar payload and rejects a bad checksum', async () => {
  const { createHash } = await import('node:crypto');
  const content = Buffer.from('chrome payload'), h = Buffer.alloc(512);
  h.write('./opt/google/chrome/chrome');
  for (const [offset, width, value] of [[100, 8, 0o755], [108, 8, 0], [116, 8, 0], [124, 12, content.length]]) h.write(value.toString(8).padStart(width - 1, '0') + '\0', offset);
  h[156] = 48; h.fill(32, 148, 156); h.write(h.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const tar = Buffer.concat([h, content, Buffer.alloc(512 - content.length), Buffer.alloc(1024)]);
  expect(readDebTar(tar)).toEqual([{ path: 'opt/google/chrome/chrome', mode: 0o755, sha256: createHash('sha256').update(content).digest('hex') }]);
  const corrupt = Buffer.from(tar); corrupt[0] ^= 1; expect(() => readDebTar(corrupt)).toThrow();
});
