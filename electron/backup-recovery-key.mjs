// Creates the age recovery identity scheduled backups encrypt to, in process,
// so nobody needs a terminal and no extra binary ships. The file is byte-for-
// byte the format age-keygen writes, and it is accepted only after the same
// reader scheduled backups use (readBackupIdentity) parses it back.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { readBackupIdentity } from "./backup-mode.mjs";
import { pathWithin } from "../shared/path-identity.mjs";

// ---- Bech32 (BIP-173). age uses the original checksum constant, not bech32m.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const invalid = () => new Error("BECH32_INVALID");
function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= GENERATOR[bit];
  }
  return checksum >>> 0;
}
const expandHrp = hrp => [...hrp].map(c => c.charCodeAt(0) >> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31));
function convertBits(data, from, to, pad) {
  let accumulator = 0, bits = 0;
  const out = [], max = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) throw invalid();
    accumulator = (accumulator << from) | value; bits += from;
    while (bits >= to) { bits -= to; out.push((accumulator >> bits) & max); }
    accumulator &= (1 << bits) - 1;
  }
  if (pad) { if (bits) out.push((accumulator << (to - bits)) & max); }
  else if (bits >= from || (accumulator << (to - bits)) & max) throw invalid();
  return out;
}
/** Lowercase BIP-173 string for `data` bytes (or 5-bit words with {words:true}). */
export function bech32Encode(hrp, data, { words = false } = {}) {
  if (typeof hrp !== "string" || hrp.length < 1 || hrp.length > 83 || [...hrp].some(c => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126) || hrp !== hrp.toLowerCase()) throw invalid();
  const values = words ? [...data] : convertBits(data, 8, 5, true);
  const checksum = polymod([...expandHrp(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const encoded = hrp + "1" + [...values, ...[0, 1, 2, 3, 4, 5].map(i => (checksum >>> (5 * (5 - i))) & 31)].map(value => CHARSET[value]).join("");
  if (encoded.length > 90) throw invalid();
  return encoded;
}
/** BIP-173 decode: returns the lowercase hrp and the 5-bit data words. */
export function bech32Decode(text) {
  if (typeof text !== "string" || text.length < 8 || text.length > 90) throw invalid();
  if ([...text].some(c => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)) throw invalid();
  const lower = text.toLowerCase();
  if (lower !== text && text.toUpperCase() !== text) throw invalid();
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length) throw invalid();
  const hrp = lower.slice(0, separator), values = Array.from(lower.slice(separator + 1), c => CHARSET.indexOf(c));
  if (values.some(value => value < 0) || polymod([...expandHrp(hrp), ...values]) !== 1) throw invalid();
  return { hrp, words: values.slice(0, -6) };
}
function bech32Bytes(text, hrp) {
  const decoded = bech32Decode(text);
  if (decoded.hrp !== hrp) throw new Error("AGE_IDENTITY_INVALID");
  return Buffer.from(convertBits(decoded.words, 5, 8, false));
}

// ---- age X25519 identities.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const SECRET_HRP = "age-secret-key-", RECIPIENT_HRP = "age";
function rawPublic(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_X25519)) throw new Error("AGE_IDENTITY_INVALID");
  return der.subarray(12);
}
function recipientForScalar(scalar) {
  const der = Buffer.concat([PKCS8_X25519, scalar]);
  try { return bech32Encode(RECIPIENT_HRP, rawPublic(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })))); }
  finally { der.fill(0); }
}
/** The age1 recipient for an AGE-SECRET-KEY-1 line. */
export function ageIdentityRecipient(secret) {
  if (typeof secret !== "string" || secret !== secret.toUpperCase()) throw new Error("AGE_IDENTITY_INVALID");
  const scalar = bech32Bytes(secret, SECRET_HRP);
  try { if (scalar.length !== 32) throw new Error("AGE_IDENTITY_INVALID"); return recipientForScalar(scalar); }
  finally { scalar.fill(0); }
}
/** A fresh X25519 identity encoded as age encodes it. Call dispose() when done. */
export function generateAgeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  try {
    if (der.length !== 48 || !der.subarray(0, 16).equals(PKCS8_X25519)) throw new Error("AGE_IDENTITY_INVALID");
    const scalar = der.subarray(16), recipient = bech32Encode(RECIPIENT_HRP, rawPublic(publicKey));
    // Self-check: the scalar written to disk must be the one behind this recipient.
    if (recipientForScalar(scalar) !== recipient) throw new Error("AGE_IDENTITY_INVALID");
    const secret = bech32Encode(SECRET_HRP, scalar).toUpperCase();
    return { secret, recipient, dispose() { der.fill(0); } };
  } catch (error) { der.fill(0); throw error; }
}

// ---- Writing the key file.
const locationInvalid = () => new Error("BACKUP_RECOVERY_KEY_LOCATION_INVALID");
function assertIndependent(target, installation, destination) {
  if (pathWithin(realpathSync.native(installation), target)) throw new Error("BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT");
  if (!destination) return;
  let folder;
  try { folder = realpathSync.native(destination); } catch { folder = path.resolve(destination); }
  if (pathWithin(folder, target)) throw new Error("BACKUP_RECOVERY_KEY_INSIDE_DESTINATION");
}
const createdStamp = now => new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
/** Writes a new identity to `file` (never replacing anything) and returns its
 * public half. The file must sit outside the installation and outside the
 * selected backup destination, judged on natively resolved paths. */
export function createRecoveryKeyFile({ file, installation, destination = null, now = Date.now() }) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw locationInvalid();
  const name = path.basename(file);
  if (!name || name === "." || name === "..") throw locationInvalid();
  let parent;
  try { parent = realpathSync.native(path.dirname(file)); if (!lstatSync(parent).isDirectory()) throw locationInvalid(); }
  catch { throw locationInvalid(); }
  const target = path.join(parent, name);
  assertIndependent(target, installation, destination);
  const key = generateAgeIdentity();
  const content = Buffer.from(`# created: ${createdStamp(now)}\n# public key: ${key.recipient}\n${key.secret}\n`, "utf8");
  let fd, created, verified = false;
  try {
    try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600); }
    catch (error) { throw new Error(error?.code === "EEXIST" ? "BACKUP_RECOVERY_KEY_EXISTS" : "BACKUP_RECOVERY_KEY_WRITE_FAILED"); }
    try {
      created = fstatSync(fd);
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      for (let offset = 0; offset < content.length;) offset += writeSync(fd, content, offset, content.length - offset);
      fsyncSync(fd);
    } catch { throw new Error("BACKUP_RECOVERY_KEY_WRITE_FAILED"); }
    finally { closeSync(fd); }
    try {
      const resolved = realpathSync.native(target), stat = lstatSync(resolved);
      if (resolved !== target || stat.dev !== created.dev || stat.ino !== created.ino || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error();
      assertIndependent(resolved, installation, destination);
      const parsed = readBackupIdentity(resolved, installation);
      const line = parsed.identity.split(/\r?\n/).find(entry => entry.startsWith("AGE-SECRET-KEY-1"));
      if (parsed.recipient !== key.recipient || line !== key.secret || ageIdentityRecipient(line) !== key.recipient) throw Error();
    } catch { throw new Error("BACKUP_RECOVERY_KEY_UNVERIFIED"); }
    if (process.platform !== "win32") {
      try { const dir = openSync(parent, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Directory sync is best effort on some volumes. */ }
    }
    verified = true;
    return { file: target, label: name, publicKey: key.recipient };
  } finally {
    content.fill(0); key.dispose();
    // Remove only the file this call created; never anything it found there.
    if (!verified && created) try { const stat = lstatSync(target); if (stat.dev === created.dev && stat.ino === created.ino) unlinkSync(target); } catch { /* Nothing of ours remains. */ }
  }
}

// ---- Where the save dialog starts.
const KEY_NAME = "murage-recovery-key", KEY_EXTENSION = ".txt";
/** `murage-recovery-key.txt` in `folder`, or the first `-2`, `-3`, … name not
 * taken there, so the dialog never proposes a file the save would refuse.
 * The existence check is only a suggestion: creation still refuses to replace. */
export function suggestRecoveryKeyPath(folder, exists = existsSync) {
  if (typeof folder !== "string" || !folder) return null;
  for (let n = 1; n <= 999; n++) {
    const candidate = path.join(folder, `${KEY_NAME}${n === 1 ? "" : `-${n}`}${KEY_EXTENSION}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(folder, KEY_NAME + KEY_EXTENSION);
}

const usableFolder = value => {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) return null;
  try { return lstatSync(value).isDirectory() ? value : null; } catch { return null; }
};
/** Remembers the FOLDER the last recovery key was saved in or picked from,
 * across launches. Only the folder path is written, owner-only; never the
 * key, its name or its content. Unreadable or stale values read as unset. */
export function recoveryKeyFolderStore(file) {
  return {
    read() {
      try { const value = JSON.parse(readFileSync(file, "utf8")); return value?.version === 1 ? usableFolder(value.folder) : null; }
      catch { return null; }
    },
    write(folder) {
      if (!usableFolder(folder)) return;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, JSON.stringify({ version: 1, folder }), { mode: 0o600 });
        renameSync(temporary, file);
      } catch { try { rmSync(temporary, { force: true }); } catch { /* Remembering is a convenience only. */ } }
    },
  };
}

/** Refusals the person can fix by choosing again. Answered as a value so
 * Electron does not print them as a crash; anything else still throws. */
const EXPECTED_REFUSALS = new Set(["BACKUP_RECOVERY_KEY_EXISTS", "BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "BACKUP_RECOVERY_KEY_LOCATION_INVALID", "BACKUP_BUSY", "BACKUP_UNAVAILABLE", "BACKUP_BINDINGS_UNAVAILABLE"]);
export async function settleRecoveryKeyRequest(work, log = line => console.warn(line)) {
  try { return await work(); }
  catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (!EXPECTED_REFUSALS.has(code)) throw error;
    log(`backup: recovery key not saved (${code})`);
    return { refused: code };
  }
}

/** Native-dialog orchestration. The secret never leaves this process: the
 * caller receives only the chosen file's name and the public recipient. */
export function createRecoveryKeyFlow({ chooseFile, installation, selectedDestination, isUsable = () => true, now = () => Date.now(), folderStore = null, defaultFolder = () => null }) {
  let pending = false, folder = null;
  const remember = file => { folder = path.dirname(file); folderStore?.write(folder); };
  const lastFolder = () => folder ?? folderStore?.read() ?? null;
  return {
    isPending: () => pending,
    /** Folder of the last key created or picked, to start the pickers in. */
    lastFolder,
    /** A key file picked elsewhere (the schedule's key picker): start there next time. */
    rememberKeyFile(file) { if (typeof file === "string" && path.isAbsolute(file)) remember(file); },
    async create() {
      if (pending) throw new Error("BACKUP_BUSY");
      if (!isUsable()) throw new Error("BACKUP_UNAVAILABLE");
      pending = true;
      try {
        const file = await chooseFile(suggestRecoveryKeyPath(lastFolder() ?? defaultFolder()));
        if (!file) return { cancelled: true };
        if (!isUsable()) throw new Error("BACKUP_UNAVAILABLE");
        let destination;
        try { destination = await selectedDestination(); } catch { throw new Error("BACKUP_BINDINGS_UNAVAILABLE"); }
        const created = createRecoveryKeyFile({ file, installation: installation(), destination, now: now() });
        remember(created.file);
        return { saved: true, label: created.label, publicKey: created.publicKey };
      } finally { pending = false; }
    },
  };
}
