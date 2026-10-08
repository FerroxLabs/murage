// Deliberately limited OpenPGP: one pinned v4 Ed25519 legacy primary key and
// v4 binary-document signatures with SHA256/SHA512. No key discovery or gpg.
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { updateVerificationError } from "./update-errors.mjs";

const MAX_BYTES = 64 * 1024;
const KEY_FILE = new URL("./release-key.asc", import.meta.url);
const RELEASES = "https://github.com/FerroxLabs/murage-releases/releases/download/";
const OID = Buffer.from("2b06010401da470f01", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const fail = (detail) => { throw new Error(detail); };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  get remaining() { return this.bytes.length - this.offset; }
  take(n) {
    if (!Number.isInteger(n) || n < 0 || n > this.remaining) fail("Truncated OpenPGP data");
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  byte() { return this.take(1)[0]; }
  short() { return this.take(2).readUInt16BE(); }
  end() { if (this.remaining !== 0) fail("Trailing OpenPGP data"); }
}

function crc24(bytes) {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return Buffer.from([(crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
}

function dearmor(value, kind) {
  const raw = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value) : fail("Missing armor");
  if (raw.length > MAX_BYTES || raw.some(byte => byte > 127)) fail("Invalid armor size or encoding");
  let text = raw.toString("ascii").replace(/\r\n/g, "\n");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  const lines = text.split("\n");
  if (lines.shift() !== `-----BEGIN PGP ${kind}-----` || lines.pop() !== `-----END PGP ${kind}-----`) fail("Invalid armor boundary");
  const comments = [];
  while (lines.length && lines[0] !== "") {
    const header = /^(Version|Comment): ([\x20-\x7e]*)$/.exec(lines.shift());
    if (!header) fail("Unsupported armor header");
    if (header[1] === "Comment") comments.push(header[2]);
  }
  if (lines.shift() !== "") fail("Missing armor separator");
  const checksum = lines.pop();
  if (!/^=[A-Za-z0-9+/]{4}$/.test(checksum ?? "")) fail("Missing armor CRC24");
  if (!lines.length || lines.some(line => !/^[A-Za-z0-9+/=]{1,76}$/.test(line))) fail("Invalid armor body");
  const encoded = lines.join("");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !crc24(bytes).equals(Buffer.from(checksum.slice(1), "base64"))) fail("Invalid armor encoding or CRC24");
  return { bytes, comments };
}

function length(reader) {
  const first = reader.byte();
  if (first < 192) return first;
  if (first < 224) return ((first - 192) << 8) + reader.byte() + 192;
  if (first === 255) return reader.take(4).readUInt32BE();
  fail("Partial OpenPGP lengths are unsupported");
}
function packets(bytes) {
  const reader = new Reader(bytes);
  const result = [];
  while (reader.remaining) {
    if (result.length >= 64) fail("Too many OpenPGP packets");
    const header = reader.byte();
    if (!(header & 0x80)) fail("Invalid packet header");
    let size;
    if (header & 0x40) size = length(reader);
    else {
      const type = header & 3;
      if (type === 3) fail("Indeterminate OpenPGP length");
      size = reader.take(1 << type).readUIntBE(0, 1 << type);
    }
    result.push({ tag: header & 0x40 ? header & 63 : (header >> 2) & 15, body: reader.take(size) });
  }
  return result;
}
function mpi(reader, maxBytes) {
  const bits = reader.short();
  if (bits < 1 || bits > maxBytes * 8) fail("Unsupported MPI size");
  const bytes = reader.take(Math.ceil(bits / 8));
  if (!bytes[0] || (bytes.length - 1) * 8 + 32 - Math.clz32(bytes[0]) !== bits) fail("Noncanonical MPI");
  return bytes;
}

export function parseReleaseKey(armored) {
  const { bytes, comments } = dearmor(armored, "PUBLIC KEY BLOCK");
  const all = packets(bytes);
  if (all[0]?.tag !== 6) fail("Expected one public key packet");
  const body = all[0].body;
  const reader = new Reader(body);
  if (reader.byte() !== 4) fail("Only v4 public keys are supported");
  reader.take(4); // creation time
  if (reader.byte() !== 22 || !reader.take(reader.byte()).equals(OID)) fail("Expected Ed25519 legacy algorithm 22");
  const point = mpi(reader, 33);
  if (point.length !== 33 || point[0] !== 0x40) fail("Invalid Ed25519 public point");
  reader.end();
  const fingerprint = createHash("sha1").update(Buffer.concat([Buffer.from([0x99]), u16(body.length), body])).digest("hex");
  const key = createPublicKey({ key: Buffer.concat([SPKI, point.subarray(1)]), format: "der", type: "spki" });
  const userIds = [];
  for (const item of all.slice(1)) {
    if (item.tag === 13) {
      const uid = new TextDecoder("utf-8", { fatal: true }).decode(item.body);
      if (!uid || /[\x00-\x1f\x7f]/.test(uid)) fail("Invalid public key user ID");
      userIds.push(uid);
    } else if (item.tag === 2 && userIds.length) {
      // Certifications do not introduce additional trust anchors. Parse their
      // complete structure; detached documents are verified with the primary.
      readSignature(item.body, [0x10, 0x11, 0x12, 0x13], true);
    } else fail("Unsupported packet in public key");
  }
  return { fingerprint, key, comments, userIds };
}

function subpackets(bytes, certification) {
  const reader = new Reader(bytes);
  const result = [];
  while (reader.remaining) {
    const part = new Reader(reader.take(length(reader)));
    const kind = part.byte();
    const type = kind & 127;
    const body = part.take(part.remaining);
    const known = [2, 16, 33].includes(type) || (certification && [9, 11, 21, 22, 23, 27, 30, 34].includes(type));
    // A certification never adds trust (the primary key verifies documents),
    // so a newer gpg's extra self-certification preference (AEAD ciphersuites,
    // 39, and the like) is skipped when it is not marked critical. Document
    // signatures and critical subpackets stay strict.
    if (!known && certification && !(kind & 128)) continue;
    // gpg 2.5 adds a non-critical notation (20) to every document signature.
    // A notation nobody asked us to honour carries no trust either way; a
    // critical one is refused, as is every other unknown subpacket.
    if (type === 20 && !(kind & 128)) continue;
    if (!known) fail("Unsupported signature subpacket");
    if ((type === 2 && body.length !== 4) || (type === 16 && body.length !== 8)
      || (type === 33 && (body.length !== 21 || body[0] !== 4))) fail("Invalid signature subpacket");
    result.push({ type, body });
  }
  return result;
}

function readSignature(body, allowedTypes = [0], certification = false) {
  const reader = new Reader(body);
  if (reader.byte() !== 4 || !allowedTypes.includes(reader.byte()) || reader.byte() !== 22) fail("Unsupported signature version, type or algorithm");
  const hashId = reader.byte();
  if (hashId !== 8 && hashId !== 10) fail("Unsupported signature hash");
  const hashed = subpackets(reader.take(reader.short()), certification);
  const prefix = body.subarray(0, reader.offset);
  const unhashed = subpackets(reader.take(reader.short()), certification);
  const hashPrefix = reader.take(2);
  const r = mpi(reader, 32);
  const s = mpi(reader, 32);
  reader.end();
  const padded = value => Buffer.concat([Buffer.alloc(32 - value.length), value]);
  return { hashed, unhashed, prefix, hashPrefix, hash: hashId === 8 ? "sha256" : "sha512", signature: Buffer.concat([padded(r), padded(s)]) };
}

export function verifyDetachedSignature(data, signatureArmor, publicKeyArmor) {
  const key = parseReleaseKey(publicKeyArmor);
  const all = packets(dearmor(signatureArmor, "SIGNATURE").bytes);
  if (all.length !== 1 || all[0].tag !== 2) fail("Expected one detached signature packet");
  const sig = readSignature(all[0].body);
  const issuers = sig.hashed.filter(part => part.type === 33);
  if (issuers.length !== 1 || issuers[0].body.subarray(1).toString("hex") !== key.fingerprint) fail("Signature issuer fingerprint differs from shipped key");
  if (sig.hashed.filter(part => part.type === 2).length !== 1) fail("Missing or duplicate signature creation time");
  for (const part of [...sig.hashed, ...sig.unhashed]) {
    if (part.type === 16 && part.body.toString("hex") !== key.fingerprint.slice(-16)) fail("Signature issuer ID differs from shipped key");
    if (part.type === 33 && part.body.subarray(1).toString("hex") !== key.fingerprint) fail("Conflicting issuer fingerprint");
  }
  const digest = createHash(sig.hash).update(data).update(sig.prefix)
    .update(Buffer.concat([Buffer.from([4, 255]), u32(sig.prefix.length)])).digest();
  if (!digest.subarray(0, 2).equals(sig.hashPrefix) || !verify(null, digest, key.key, sig.signature)) fail("Invalid publisher signature");
  return key.fingerprint;
}

function semver(value) {
  if (typeof value !== "string" || value.length > 256) fail("Invalid version");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) fail("Invalid semver");
  const pre = match[4]?.split(".") ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) fail("Invalid prerelease number");
  return { core: match.slice(1, 4).map(BigInt), pre };
}
function newer(version, currentVersion) {
  const a = semver(version), b = semver(currentVersion);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return a.pre.length === 0 && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return false;
    if (b.pre[i] === undefined) return true;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    return an && bn ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : an !== bn ? !an : a.pre[i] > b.pre[i];
  }
  return false;
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("Expected HTTPS URL");
  return url;
}
async function fetchBytes(value, fetcher, timeoutMs) {
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Release verification timed out")); }, timeoutMs);
  });
  const transfer = async () => {
    let url = httpsUrl(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      controller.signal.throwIfAborted();
      const response = await fetcher(url.href, { redirect: "manual", signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      if (response.redirected) fail("Automatic redirects are unsupported");
      if (response.url) httpsUrl(response.url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) fail("Missing redirect target");
        url = httpsUrl(new URL(location, url));
        continue;
      }
      if (response.status !== 200) fail("Release asset is unavailable");
      const size = response.headers.get("content-length");
      if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) {
        void response.body?.cancel().catch(() => {});
        fail("Release asset is too large");
      }
      reader = response.body?.getReader();
      if (!reader) fail("Missing release asset body");
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) return Buffer.concat(chunks);
        received += chunk.byteLength;
        if (received > MAX_BYTES) fail("Release asset is too large");
        chunks.push(Buffer.from(chunk));
      }
    }
    fail("Too many release redirects");
  };
  try { return await Promise.race([transfer(), deadline]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function checkFile(file, expected) {
  if (typeof file !== "string" || !isAbsolute(file)) fail("Invalid update path");
  const beforePath = await lstat(file);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail("Expected a regular update file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) fail("Update path changed");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const path = await lstat(file);
    if (!path.isFile() || path.isSymbolicLink() || before.dev !== path.dev || before.ino !== path.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.size !== path.size || after.mtimeMs !== path.mtimeMs || after.ctimeMs !== path.ctimeMs
      || hash.digest("hex") !== expected) fail("Downloaded bytes differ from signed digest");
  } finally { await handle.close(); }
}

export async function verifyLinuxUpdate({ files, version, currentVersion, publicKey, packageType, fetch: fetcher = globalThis.fetch,
  releaseBaseUrl = RELEASES, timeoutMs = 20_000 } = {}) {
  try {
    if (!newer(version, currentVersion)) fail("Rollback refused");
    if (!Array.isArray(files) || files.length < 1 || files.length > 2 || new Set(files).size !== files.length
      || files.some(file => typeof file !== "string" || !isAbsolute(file))) fail("Invalid downloaded files");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000) fail("Invalid verification timeout");
    const expectedNames = new Set([`Murage-${version}-x86_64.AppImage`, `Murage-${version}-amd64.deb`]);
    if (files.some(file => !expectedNames.has(basename(file)))) fail("Update filename does not match version/platform");
    if (packageType !== undefined) {
      const suffix = packageType === "AppImage" ? "x86_64.AppImage" : packageType === "deb" ? "amd64.deb" : fail("Unsupported Linux package type");
      if (files.length !== 1 || basename(files[0]) !== `Murage-${version}-${suffix}`) fail("Update filename does not match the install mode");
    }
    const base = httpsUrl(releaseBaseUrl);
    const sumsUrl = new URL(`v${version}/SHA256SUMS-ubuntu-x64.txt`, base).href;
    const sums = await fetchBytes(sumsUrl, fetcher, timeoutMs);
    const signature = await fetchBytes(sumsUrl + ".asc", fetcher, timeoutMs);
    const fingerprint = verifyDetachedSignature(sums, signature, publicKey ?? await readFile(KEY_FILE));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sums);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const digests = new Map();
    if (!lines.length) fail("Empty checksums");
    for (const line of lines) {
      const match = /^([a-fA-F0-9]{64}) [ *](Murage-[^\s/\\]+)$/.exec(line);
      if (!match || !expectedNames.has(match[2]) || digests.has(match[2])) fail("Invalid or duplicate checksum filename");
      digests.set(match[2], match[1].toLowerCase());
    }
    const verified = files.map(file => {
      const digest = digests.get(basename(file));
      if (!digest) fail("Signed digest is missing for downloaded file");
      return { file, digest };
    });
    const recheck = async () => {
      try { for (const { file, digest } of verified) await checkFile(file, digest); }
      catch (error) { throw updateVerificationError(error); }
    };
    await recheck();
    return Object.freeze({ fingerprint, recheck });
  } catch (error) { throw updateVerificationError(error); }
}

export function createLinuxUpdateVerifier(options) {
  return ({ files, version }) => verifyLinuxUpdate({ ...options, files, version });
}
