// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// macOS and Windows updates take their version from latest-mac.yml / latest.yml, and those feed files carry no signature of
// their own. The signed build does: a Mac app's Info.plist is sealed by its code signature (Squirrel.Mac refuses a bundle
// whose signature does not satisfy the running app's requirement), and a Windows installer's version resource is covered by
// its Authenticode signature (checked by windows-update-signature.mjs before the download resolves). So after the download,
// read the version the signed build itself carries and install it only when it is the version the feed offered AND newer
// than the version running now. A feed that names a higher version but points at an older signed build is refused.
//
// Linux does more (a signed SHA256SUMS, update-signature.mjs); this is the Mac and Windows counterpart. It reads bytes only:
// nothing in the download is run or unpacked to disk here.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { inflateRawSync } from "node:zlib";
import { updateVerificationError } from "./update-errors.mjs";
import { createLinuxUpdateVerifier, isNewerVersion } from "./update-signature.mjs";

const fail = (detail) => { throw new Error(detail); };
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const MAX_PLIST = 1024 * 1024;
const MAX_RESOURCES = 32 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function openRegular(file) {
  if (typeof file !== "string" || !isAbsolute(file)) fail("Invalid update path");
  const pathStat = await lstat(file);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail("Expected a regular update file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stat = await handle.stat();
  if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
    await handle.close();
    fail("Update path changed");
  }
  return { handle, size: stat.size };
}

async function readAt(handle, position, length, size) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > size) fail("Update file is truncated");
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) fail("Update file is truncated");
    done += bytesRead;
  }
  return buffer;
}

/** The CFBundleShortVersionString of the one app bundle in a Squirrel.Mac update ZIP. */
export async function readMacZipBundleVersion(file) {
  const { handle, size } = await openRegular(file);
  try {
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, size - tailLength, tailLength, size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) fail("Update archive has no end record");
    const disk = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8), entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || diskEntries !== entries) fail("Multi-part update archives are unsupported");
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("Zip64 update archives are unsupported");
    const eocdOffset = size - tailLength + eocd;
    if (cdSize > MAX_CENTRAL_DIRECTORY || cdOffset + cdSize > eocdOffset) fail("Update archive directory is invalid");
    const directory = await readAt(handle, cdOffset, cdSize, size);
    const bundles = new Set();
    const plists = [];
    let p = 0;
    for (let index = 0; index < entries; index++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) fail("Update archive directory is invalid");
      const flags = directory.readUInt16LE(p + 8), method = directory.readUInt16LE(p + 10);
      const crc = directory.readUInt32LE(p + 16), compressed = directory.readUInt32LE(p + 20), uncompressed = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
      const local = directory.readUInt32LE(p + 42);
      const end = p + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length) fail("Update archive directory is invalid");
      const nameBytes = directory.subarray(p + 46, p + 46 + nameLength);
      const name = nameBytes.toString("latin1");
      const top = name.split("/")[0];
      if (top !== "__MACOSX") {
        if (!/^[^/\\]+\.app$/i.test(top)) fail("Update archive holds something other than one app bundle");
        bundles.add(top.toLowerCase());
      }
      if (/^[^/\\]+\.app\/contents\/info\.plist$/i.test(name)) plists.push({ name, nameBytes, flags, method, crc, compressed, uncompressed, local });
      p = end;
    }
    if (p !== directory.length) fail("Update archive directory is invalid");
    if (bundles.size !== 1 || plists.length !== 1) fail("Update archive must hold exactly one app bundle with one Info.plist");
    const [entry] = plists;
    if (entry.flags & 1) fail("Encrypted update archives are unsupported");
    if (entry.uncompressed > MAX_PLIST || entry.compressed > MAX_PLIST || (entry.method !== 0 && entry.method !== 8)) fail("Update Info.plist is unsupported");
    const header = await readAt(handle, entry.local, 30, size);
    if (header.readUInt32LE(0) !== 0x04034b50) fail("Update archive entry is invalid");
    const localNameLength = header.readUInt16LE(26), localExtraLength = header.readUInt16LE(28);
    const localName = await readAt(handle, entry.local + 30, localNameLength, size);
    if (!localName.equals(entry.nameBytes) || header.readUInt16LE(8) !== entry.method) fail("Update archive entry does not match its directory");
    const data = await readAt(handle, entry.local + 30 + localNameLength + localExtraLength, entry.compressed, size);
    const plist = entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_PLIST });
    if (plist.length !== entry.uncompressed || crc32(plist) !== entry.crc) fail("Update Info.plist failed its checksum");
    return plistString(plist, "CFBundleShortVersionString");
  } finally { await handle.close(); }
}

function plistString(bytes, key) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<plist[\s>]/.test(text)) fail("Update Info.plist is not an XML property list");
  const matches = [...text.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"))];
  if (matches.length !== 1 || text.split(`<key>${key}</key>`).length !== 2) fail(`Update Info.plist must name ${key} once`);
  return matches[0][1];
}

/** The ProductVersion string and the fixed product version of a Windows PE file's single version resource. */
export async function readWindowsPeVersion(file) {
  const { handle, size } = await openRegular(file);
  try {
    const dos = await readAt(handle, 0, 64, size);
    if (dos.readUInt16LE(0) !== 0x5a4d) fail("Update installer is not a Windows program");
    const pe = dos.readUInt32LE(60);
    if (pe > 4096) fail("Update installer header is invalid");
    const head = await readAt(handle, pe, 24, size);
    if (head.readUInt32LE(0) !== 0x00004550) fail("Update installer header is invalid");
    const sectionCount = head.readUInt16LE(6), optionalSize = head.readUInt16LE(20);
    if (sectionCount < 1 || sectionCount > 96) fail("Update installer header is invalid");
    const optional = await readAt(handle, pe + 24, optionalSize, size);
    const magic = optional.readUInt16LE(0);
    const dirs = magic === 0x10b ? 96 : magic === 0x20b ? 112 : fail("Update installer header is invalid");
    if (optional.length < dirs + 24 || optional.readUInt32LE(dirs - 4) < 3) fail("Update installer has no resources");
    const resourceRva = optional.readUInt32LE(dirs + 16), resourceSize = optional.readUInt32LE(dirs + 20);
    if (!resourceRva || !resourceSize || resourceSize > MAX_RESOURCES) fail("Update installer has no usable resources");
    const table = await readAt(handle, pe + 24 + optionalSize, sectionCount * 40, size);
    const sections = Array.from({ length: sectionCount }, (_, i) => ({
      va: table.readUInt32LE(i * 40 + 12),
      raw: table.readUInt32LE(i * 40 + 20), rawSize: table.readUInt32LE(i * 40 + 16),
    }));
    const toFile = (rva, length) => {
      const hits = sections.filter((s) => rva >= s.va && rva - s.va + length <= s.rawSize);
      if (hits.length !== 1) fail("Update installer resource is outside its sections");
      return hits[0].raw + (rva - hits[0].va);
    };
    const resources = await readAt(handle, toFile(resourceRva, resourceSize), resourceSize, size);
    const dir = (offset) => {
      if (offset + 16 > resources.length) fail("Update installer resources are invalid");
      const count = resources.readUInt16LE(offset + 12) + resources.readUInt16LE(offset + 14);
      if (offset + 16 + count * 8 > resources.length) fail("Update installer resources are invalid");
      return Array.from({ length: count }, (_, i) => {
        const id = resources.readUInt32LE(offset + 16 + i * 8), target = resources.readUInt32LE(offset + 20 + i * 8);
        return { id: id & 0x80000000 ? null : id, subdir: Boolean(target & 0x80000000), offset: target & 0x7fffffff };
      });
    };
    const versions = dir(0).filter((entry) => entry.id === 16);
    if (versions.length !== 1 || !versions[0].subdir) fail("Update installer must carry one version resource");
    const names = dir(versions[0].offset);
    if (names.length !== 1 || !names[0].subdir) fail("Update installer must carry one version resource");
    const languages = dir(names[0].offset);
    if (languages.length < 1 || languages.some((entry) => entry.subdir)) fail("Update installer version resource is invalid");
    const answers = [];
    for (const language of languages) {
      if (language.offset + 16 > resources.length) fail("Update installer resources are invalid");
      const rva = resources.readUInt32LE(language.offset), length = resources.readUInt32LE(language.offset + 4);
      if (length > MAX_RESOURCES) fail("Update installer version resource is invalid");
      answers.push(parseVersionInfo(await readAt(handle, toFile(rva, length), length, size)));
    }
    const first = JSON.stringify(answers[0]);
    if (answers.some((answer) => JSON.stringify(answer) !== first)) fail("Update installer names more than one version");
    return answers[0];
  } finally { await handle.close(); }
}

function parseVersionInfo(bytes) {
  const align = (n) => (n + 3) & ~3;
  const block = (offset, limit) => {
    if (offset + 6 > limit) fail("Update installer version resource is invalid");
    const length = bytes.readUInt16LE(offset), valueLength = bytes.readUInt16LE(offset + 2), type = bytes.readUInt16LE(offset + 4);
    const end = offset + length;
    if (length < 6 || end > limit) fail("Update installer version resource is invalid");
    let cursor = offset + 6, key = "";
    for (;; cursor += 2) {
      if (cursor + 2 > end) fail("Update installer version resource is invalid");
      const unit = bytes.readUInt16LE(cursor);
      if (unit === 0) { cursor += 2; break; }
      key += String.fromCharCode(unit);
    }
    cursor = align(cursor);
    const valueBytes = type === 1 ? valueLength * 2 : valueLength;
    if (cursor + valueBytes > end) fail("Update installer version resource is invalid");
    const value = bytes.subarray(cursor, cursor + valueBytes);
    const children = [];
    for (let child = align(cursor + valueBytes); child < end; ) {
      const parsed = block(child, end);
      children.push(parsed);
      child = align(child + parsed.length);
    }
    return { key, type, value, children, length };
  };
  const root = block(0, bytes.length);
  if (root.key !== "VS_VERSION_INFO" || root.value.length < 52 || root.value.readUInt32LE(0) !== 0xfeef04bd) fail("Update installer version resource is invalid");
  const ms = root.value.readUInt32LE(16), ls = root.value.readUInt32LE(20);
  const fixedProductVersion = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  const productVersions = new Set();
  for (const info of root.children.filter((child) => child.key === "StringFileInfo")) {
    for (const strings of info.children) {
      for (const entry of strings.children) {
        if (entry.key !== "ProductVersion") continue;
        let text = "";
        for (let i = 0; i + 1 < entry.value.length; i += 2) text += String.fromCharCode(entry.value.readUInt16LE(i));
        productVersions.add(text.replace(/\0+$/, ""));
      }
    }
  }
  if (productVersions.size !== 1) fail("Update installer must name its product version once");
  return { productVersion: [...productVersions][0], fixedProductVersion };
}

function selectArtifact(platform, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2 || new Set(files).size !== files.length
    || files.some((file) => typeof file !== "string" || !isAbsolute(file))) fail("Invalid downloaded files");
  if (platform === "darwin") {
    if (files.length !== 1 || !/\.zip$/i.test(basename(files[0]))) fail("Expected one macOS update archive");
    return files[0];
  }
  if (platform === "win32") {
    const installers = files.filter((file) => /\.exe$/i.test(basename(file)));
    if (installers.length !== 1) fail("Expected one Windows update installer");
    return installers[0];
  }
  fail("Unsupported update platform");
}

/** The version the signed build carries, compared with what the feed offered. Throws when they differ. */
export async function assertSignedBuildVersion({ platform, file, version, readers = {} }) {
  if (platform === "darwin") {
    const built = await (readers.mac ?? readMacZipBundleVersion)(file);
    if (built !== version) fail(`The signed build is version ${built}, not the offered ${version}`);
    return;
  }
  const { productVersion, fixedProductVersion } = await (readers.windows ?? readWindowsPeVersion)(file);
  const core = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1, 4).map(Number) ?? fail("Invalid version");
  if (productVersion !== version || core.some((part, i) => fixedProductVersion[i] !== part)) {
    fail(`The signed installer is version ${productVersion} (${fixedProductVersion.join(".")}), not the offered ${version}`);
  }
}

/** coordinator verifyDownload for macOS and Windows: refuse a rollback, then refuse a build whose own version is not the
 * offered one. The receipt's recheck reads the build again right before the install starts. */
export function createSignedBuildVerifier({ platform = process.platform, currentVersion, readers } = {}) {
  return async ({ files, version }) => {
    try {
      if (!isNewerVersion(version, currentVersion)) fail("Rollback refused");
      const file = selectArtifact(platform, files);
      const check = () => assertSignedBuildVersion({ platform, file, version, readers });
      await check();
      return Object.freeze({
        recheck: async () => {
          try { await check(); } catch (error) { throw updateVerificationError(error); }
        },
      });
    } catch (error) { throw updateVerificationError(error); }
  };
}

/** The coordinator's download check for this platform, used for every feed (the normal one and the latest-release
 * fallback): Linux checks a signed SHA256SUMS, macOS and Windows the version the signed build carries. */
export function createUpdateDownloadVerifier({ platform = process.platform, currentVersion, packageType = null, readers } = {}) {
  if (platform === "linux") return createLinuxUpdateVerifier({ currentVersion, packageType: packageType ?? "AppImage" });
  return createSignedBuildVerifier({ platform, currentVersion, readers });
}
