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

/** A second copy of an existing recovery key, for a password manager, a USB
 * stick or another computer. The secret is read and written inside this
 * process; the caller is told only the new file's name.
 *
 * The copy is held to the same rule as the original: never inside the
 * installation it unlocks, and never inside the backup folder — a key filed
 * beside the archives is lost with them, which is a total loss dressed up as
 * a backup. */
export function copyRecoveryKeyFile({ from, to, installation, destination = null }) {
  // Parsing `from` first refuses to copy anything that is not a usable key.
  const source = readBackupIdentity(from, installation);
  if (!source.recipient) throw new Error("BACKUP_IDENTITY_HEADER_REQUIRED");
  if (typeof to !== "string" || !path.isAbsolute(to) || to.includes("\0")) throw locationInvalid();
  const name = path.basename(to);
  if (!name || name === "." || name === "..") throw locationInvalid();
  let parent;
  try { parent = realpathSync.native(path.dirname(to)); if (!lstatSync(parent).isDirectory()) throw locationInvalid(); }
  catch { throw locationInvalid(); }
  const target = path.join(parent, name);
  assertIndependent(target, installation, destination);
  const content = Buffer.from(readFileSync(realpathSync.native(from)));
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
    // The copy is only a copy once it reads back as the same key.
    try {
      const copied = readBackupIdentity(target, installation);
      if (copied.recipient !== source.recipient || copied.identity !== source.identity) throw Error();
    } catch { throw new Error("BACKUP_RECOVERY_KEY_UNVERIFIED"); }
    verified = true;
    return { file: target, label: name, publicKey: source.recipient };
  } finally {
    content.fill(0);
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

/** A folder that cannot hold the key is skipped; anything else is a real
 * failure and must not be hidden by trying somewhere else. */
const PLACEMENT_REFUSALS = new Set(["BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "BACKUP_RECOVERY_KEY_LOCATION_INVALID", "BACKUP_RECOVERY_KEY_EXISTS"]);
/** Creates the key for the person, with no file dialog, in the first of
 * `folders` that is allowed to hold it. Setting up backups should not start
 * with a file picker; the placement rules are unchanged, they are just
 * applied here instead of being explained to the person. */
export function createRecoveryKeyIn(folders, { installation, destination = null, now = Date.now() }) {
  let refused = null;
  for (const folder of folders) {
    const file = suggestRecoveryKeyPath(folder);
    if (!file) continue;
    try { return createRecoveryKeyFile({ file, installation, destination, now }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!PLACEMENT_REFUSALS.has(code)) throw error;
      refused = code;
    }
  }
  throw new Error(refused ?? "BACKUP_RECOVERY_KEY_LOCATION_INVALID");
}

const usablePath = value => typeof value === "string" && value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value);
const usableFolder = value => {
  if (!usablePath(value)) return null;
  try { return lstatSync(value).isDirectory() ? value : null; } catch { return null; }
};
/** A remembered key file counts only while a plain file is still there. The
 * person may have moved it, renamed it or thrown it away between launches,
 * and an offer to copy a file that is gone is a worse answer than no offer. */
const usableKeyFile = value => {
  if (!usablePath(value)) return null;
  try { const found = lstatSync(value); return found.isFile() && !found.isSymbolicLink() ? value : null; } catch { return null; }
};
/** Remembers WHERE the last recovery key was saved or picked, across
 * launches: the folder the pickers start in, and the file itself so a second
 * copy can still be offered in a later launch. A location only, written
 * owner-only. Never the key, and never anything read out of it.
 *
 * Unreadable, stale or disagreeing values read as unset. Records written
 * before the file was remembered still read back: they carry the folder, and
 * the copy is simply not offered from them. */
export function recoveryKeyFolderStore(file) {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (value?.version !== 1) return null;
        const folder = usableFolder(value.folder);
        if (!folder) return null;
        const keyFile = usableKeyFile(value.file);
        // The two are written together, so a file from some other folder is a
        // record that has been edited or half-written: keep only the folder.
        return { folder, file: keyFile && path.dirname(keyFile) === folder ? keyFile : null };
      } catch { return null; }
    },
    write(folder, keyFile = null) {
      if (!usableFolder(folder)) return;
      const remembered = usablePath(keyFile) && path.dirname(keyFile) === folder ? keyFile : null;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, JSON.stringify({ version: 1, folder, ...(remembered ? { file: remembered } : {}) }), { mode: 0o600 });
        renameSync(temporary, file);
      } catch { try { rmSync(temporary, { force: true }); } catch { /* Remembering is a convenience only. */ } }
    },
  };
}

/** Refusals the person can fix by choosing again. Answered as a value so
 * Electron does not print them as a crash; anything else still throws. */
const EXPECTED_REFUSALS = new Set(["BACKUP_RECOVERY_KEY_EXISTS", "BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "BACKUP_RECOVERY_KEY_LOCATION_INVALID", "BACKUP_RECOVERY_KEY_UNKNOWN", "BACKUP_BUSY", "BACKUP_UNAVAILABLE", "BACKUP_BINDINGS_UNAVAILABLE"]);
export async function settleRecoveryKeyRequest(work, log = line => console.warn(line)) {
  try { return await work(); }
  catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (!EXPECTED_REFUSALS.has(code)) throw error;
    log(`backup: recovery key not saved (${code})`);
    return { refused: code };
  }
}

/** Refusals that are about the place the person just picked for the copy, so
 * they are reported as they are however the source was found. Everything else
 * a copy can fail on is about the source file. */
const COPY_TARGET_REFUSALS = new Set(["BACKUP_RECOVERY_KEY_EXISTS", "BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "BACKUP_RECOVERY_KEY_LOCATION_INVALID", "BACKUP_RECOVERY_KEY_WRITE_FAILED", "BACKUP_RECOVERY_KEY_UNVERIFIED"]);

/** Native-dialog orchestration. The secret never leaves this process: the
 * caller receives only the chosen file's name and the public recipient. */
export function createRecoveryKeyFlow({ chooseFile, installation, selectedDestination, isUsable = () => true, now = () => Date.now(), folderStore = null, defaultFolder = () => null, chooseCopyFile = null, defaultFolders = null, isUsableDuringSetup = null }) {
  let pending = false, folder = null, keyFile = null;
  const remember = file => { folder = path.dirname(file); keyFile = file; folderStore?.write(folder, file); };
  const remembered = () => folderStore?.read() ?? null;
  const lastFolder = () => folder ?? remembered()?.folder ?? null;
  /** The key file this process last created or was pointed at, and failing
   * that the one a previous launch wrote down, so a copy can be offered
   * without asking the person where their key is. Null when neither is
   * known, or when the remembered file is no longer there. */
  const lastKeyFile = () => keyFile ?? remembered()?.file ?? null;
  return {
    isPending: () => pending,
    lastKeyFile,
    /** Creates the key with no dialog, in the first allowed default folder.
     * `destination` is the chosen backup folder, which the key may not sit in. */
    createFor(destination) {
      if (pending) throw new Error("BACKUP_BUSY");
      // The schedule host calls this from inside its own setup, so the guard
      // used here must not count that setup as work in progress; everything
      // else it checks still applies.
      if (!(isUsableDuringSetup ?? isUsable)()) throw new Error("BACKUP_UNAVAILABLE");
      const folders = [lastFolder(), ...(defaultFolders?.() ?? [defaultFolder()])].filter(value => typeof value === "string" && value);
      const created = createRecoveryKeyIn(folders, { installation: installation(), destination, now: now() });
      remember(created.file);
      return created;
    },
    /** Saves a second copy of the key somewhere the person picks. The secret
     * never leaves this process: they get back only the new file's name. */
    async saveCopy(file = lastKeyFile()) {
      if (pending) throw new Error("BACKUP_BUSY");
      if (!isUsable()) throw new Error("BACKUP_UNAVAILABLE");
      if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("BACKUP_RECOVERY_KEY_UNKNOWN");
      // Whether this process watched that file being written, or only read
      // its location back from the last launch. A file from a previous launch
      // may since have been replaced by something that is not a key, and that
      // is "we no longer know where your key is", not a failure of the copy.
      const fromMemory = keyFile === file;
      pending = true;
      try {
        const to = await (chooseCopyFile ?? chooseFile)(suggestRecoveryKeyPath(lastFolder() ?? defaultFolder()));
        if (!to) return { cancelled: true };
        if (!isUsable()) throw new Error("BACKUP_UNAVAILABLE");
        let destination;
        try { destination = await selectedDestination(); } catch { throw new Error("BACKUP_BINDINGS_UNAVAILABLE"); }
        let copied;
        try { copied = copyRecoveryKeyFile({ from: file, to, installation: installation(), destination }); }
        catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (fromMemory || COPY_TARGET_REFUSALS.has(code)) throw error;
          throw new Error("BACKUP_RECOVERY_KEY_UNKNOWN");
        }
        return { saved: true, label: copied.label, publicKey: copied.publicKey };
      } finally { pending = false; }
    },
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
