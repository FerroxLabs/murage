// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP2: where the desktop keeps what it needs to talk to a Cloud home.
//
// One record per home: the pin (homeId, publicOrigin, environmentId, homeKey,
// generation), the device id, and TWO distinct ed25519 private keys (session
// signs challenge/refresh; assertion signs step-up). The whole record is
// encrypted with Electron's safeStorage; nothing about it is stored in the
// clear. There is no plaintext opt-out: MURAGE_ALLOW_PLAINTEXT_SECRETS is
// never passed to the policy here, so a Linux basic_text keyring is refused
// for reads as well as writes (nothing legitimate was ever written that way).
//
// The short-lived access token is NOT stored: the client keeps it in main's
// memory only.
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { secretWriteRefusal } from "./secret-storage-policy.mjs";

export const HOME_ID = /^[\w-]{1,128}$/;

export class CloudHomeStoreError extends Error {
  constructor(code, message) { super(message); this.name = "CloudHomeStoreError"; this.code = code; }
}

/** Two independent ed25519 key pairs. Public halves are SPKI PEM (what the home stores). */
export function generateDeviceKeys() {
  const make = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  };
  const session = make(), assertion = make();
  return { sessionPublicKey: session.publicKey, sessionPrivateKey: session.privateKey, assertionPublicKey: assertion.publicKey, assertionPrivateKey: assertion.privateKey };
}

const RECORD_FIELDS = ["homeId", "cpEnvironment", "publicOrigin", "environmentId", "homeKey", "generation", "deviceId", "account", "sessionPrivateKey", "assertionPrivateKey", "pinnedAt"];

function validRecord(record) {
  return record && typeof record === "object" && RECORD_FIELDS.every((field) => record[field] !== undefined && record[field] !== null)
    && HOME_ID.test(record.homeId) && Number.isSafeInteger(record.generation) && record.generation > 0
    && record.sessionPrivateKey !== record.assertionPrivateKey;
}

const PENDING_FILE = "cloud-connect-pending.bin";
const PENDING_FIELDS = ["sessionPublicKey", "sessionPrivateKey", "assertionPublicKey", "assertionPrivateKey", "cpEnvironment", "startedAt"];
/** Set once the home has enrolled the pending key (its answer to /api/cloud/enter): what the saved record needs besides the keys. */
const ENROLLED_FIELDS = ["homeId", "publicOrigin", "environmentId", "homeKey", "generation", "deviceId", "account"];
function validEnrolled(enrolled) {
  return enrolled && typeof enrolled === "object" && !Array.isArray(enrolled) && Object.keys(enrolled).every((key) => ENROLLED_FIELDS.includes(key))
    && ENROLLED_FIELDS.every((field) => enrolled[field] !== undefined && enrolled[field] !== null)
    && HOME_ID.test(String(enrolled.homeId)) && Number.isSafeInteger(enrolled.generation) && enrolled.generation > 0
    && ["publicOrigin", "environmentId", "homeKey", "deviceId", "account"].every((field) => typeof enrolled[field] === "string" && enrolled[field].length > 0 && enrolled[field].length <= 4096);
}
/** Sealed BEFORE the POST to /api/cloud/enter: the home may have enrolled the key even when its answer never arrives. */
const ATTEMPTED_FIELDS = ["at", "homeId", "origin"];
function validAttempted(attempted) {
  return attempted && typeof attempted === "object" && !Array.isArray(attempted) && Object.keys(attempted).every((key) => ATTEMPTED_FIELDS.includes(key))
    && Number.isSafeInteger(attempted.at) && HOME_ID.test(String(attempted.homeId)) && typeof attempted.origin === "string" && attempted.origin.length <= 256;
}
/** What the Connect panel last showed, kept with the key so a restart shows it too: { code, message, at, retryAfterMs? }. */
const RESULT_FIELDS = ["code", "message", "at", "retryAfterMs"];
function validResult(result) {
  return result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).every((key) => RESULT_FIELDS.includes(key))
    && typeof result.code === "string" && result.code.length <= 64 && typeof result.message === "string" && result.message.length <= 512
    && Number.isSafeInteger(result.at) && (result.retryAfterMs === undefined || Number.isSafeInteger(result.retryAfterMs));
}
function validPending(pending) {
  return pending && typeof pending === "object" && PENDING_FIELDS.every((field) => pending[field] !== undefined && pending[field] !== null)
    && Number.isSafeInteger(pending.startedAt) && pending.sessionPrivateKey !== pending.assertionPrivateKey
    && ["sessionPublicKey", "sessionPrivateKey", "assertionPublicKey", "assertionPrivateKey"].every((field) => typeof pending[field] === "string" && pending[field].length < 4096)
    && (pending.enrolled === undefined || validEnrolled(pending.enrolled))
    && (pending.attempted === undefined || validAttempted(pending.attempted))
    && (pending.lastResult === undefined || validResult(pending.lastResult));
}
/** The fields kept on disk: the keys; `attempted` from just before the POST; `enrolled` once the home answered; `lastResult`. */
const pendingProjection = (pending) => Object.fromEntries([...PENDING_FIELDS, ...["attempted", "enrolled", "lastResult"].filter((field) => pending[field] !== undefined)]
  .map((field) => [field, pending[field]]));

/**
 * Door v2: devices the home enrolled for a Connect the person then cancelled, whose removal the home has not confirmed yet.
 * Each entry is a full record (the session key signs the retry's sign-in) plus when it was cancelled. Never a paired home.
 */
const REVOKE_FILE = "cloud-revoke-pending.bin";
/**
 * Far above anything a person reaches (each entry is one cancelled Connect the home has not confirmed yet). Nothing is ever
 * dropped to stay under it: a save past it is refused with queue-full, and every entry already queued is kept.
 */
export const MAX_QUEUED_REVOCATIONS = 1000;
export const QUEUE_FULL_MESSAGE = "Too many cancelled connections are waiting for your Cloud home to confirm them.";
const validRevocation = (entry) => validRecord(entry) && Number.isSafeInteger(entry.cancelledAt);
const revocationProjection = (entry) => Object.fromEntries([...RECORD_FIELDS, "cancelledAt"].map((field) => [field, entry[field]]));

export function createCloudHomeStore({ safeStorage, directory, platform = process.platform, fs = { chmod, mkdir, readdir, readFile, rename, rm, writeFile }, maxQueuedRevocations = MAX_QUEUED_REVOCATIONS }) {
  if (!safeStorage || !directory) throw new TypeError("safeStorage and directory are required");
  const pendingFile = path.join(directory, PENDING_FILE), revokeFile = path.join(directory, REVOKE_FILE);
  const writeSealed = async (target, value) => {
    const temporary = `${target}.${process.pid}.tmp`;
    const sealed = safeStorage.encryptString(JSON.stringify(value));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, sealed, { mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
  };
  const file = (homeId) => {
    if (!HOME_ID.test(String(homeId))) throw new CloudHomeStoreError("invalid-home", "That Cloud home id is not valid");
    return path.join(directory, `cloud-home-${homeId}.bin`);
  };
  // env: {} on purpose. No plaintext opt-out for Cloud keys.
  const refusal = async () => {
    const reason = await secretWriteRefusal({ safeStorage, platform, env: {} });
    if (reason) throw new CloudHomeStoreError("store-refused", reason);
  };
  return {
    /** Throws store-refused when keys could not be kept safely. Pairing calls this BEFORE it touches the home. */
    assertWritable: refusal,
    async save(record) {
      if (!validRecord(record)) throw new CloudHomeStoreError("invalid-record", "The Cloud home record is incomplete");
      await refusal();
      const target = file(record.homeId), temporary = `${target}.${process.pid}.tmp`;
      const sealed = safeStorage.encryptString(JSON.stringify(Object.fromEntries(RECORD_FIELDS.map((field) => [field, record[field]]))));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, sealed, { mode: 0o600 });
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => {});
    },
    /** The record for a home, or null when none is saved. Throws store-refused on an unsafe backend. */
    async load(homeId) {
      const target = file(homeId);
      let sealed;
      try { sealed = await fs.readFile(target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
      await refusal();
      let record;
      try { record = JSON.parse(safeStorage.decryptString(sealed)); } catch { throw new CloudHomeStoreError("unreadable", "The saved Cloud home could not be opened. Pair it again."); }
      if (!validRecord(record) || record.homeId !== homeId) throw new CloudHomeStoreError("unreadable", "The saved Cloud home could not be opened. Pair it again.");
      return record;
    },
    async list() {
      let names;
      try { names = await fs.readdir(directory); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
      return names.map((name) => /^cloud-home-([\w-]{1,128})\.bin$/.exec(name)?.[1]).filter(Boolean);
    },
    async remove(homeId) { await fs.rm(file(homeId), { force: true }); },
    /**
     * Door v2: the ONE pending Connect (its two private keys and when it started), sealed with the same safeStorage as a
     * record. It is saved before the browser opens, so a restart can still enroll with the same key. The file name cannot
     * match list()'s cloud-home-<id>.bin pattern.
     */
    async savePending(pending) {
      if (!validPending(pending)) throw new CloudHomeStoreError("invalid-record", "The pending connection is incomplete");
      await refusal();
      const temporary = `${pendingFile}.${process.pid}.tmp`;
      const sealed = safeStorage.encryptString(JSON.stringify(pendingProjection(pending)));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, sealed, { mode: 0o600 });
      await fs.rename(temporary, pendingFile);
      await fs.chmod(pendingFile, 0o600).catch(() => {});
    },
    /** The pending Connect, or null when none (or it cannot be read: a pending key is only ever re-made, never repaired). */
    async loadPending() {
      let sealed;
      try { sealed = await fs.readFile(pendingFile); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
      await refusal();
      try { const pending = JSON.parse(safeStorage.decryptString(sealed)); return validPending(pending) ? pendingProjection(pending) : null; } catch { return null; }
    },
    async clearPending() { await fs.rm(pendingFile, { force: true }); },
    /**
     * The devices still to be removed at their home (most recent last). An empty list removes the file. Every entry given is
     * written: a list longer than the bound is refused with queue-full and the file keeps what it had, never trimmed.
     * Callers read, change and write this list inside the client's one store lock, so no write is ever based on an old read.
     */
    async saveRevocations(entries) {
      if (!Array.isArray(entries) || !entries.every(validRevocation)) throw new CloudHomeStoreError("invalid-record", "The devices to remove are incomplete");
      if (entries.length > maxQueuedRevocations) throw new CloudHomeStoreError("queue-full", QUEUE_FULL_MESSAGE);
      if (entries.length === 0) { await fs.rm(revokeFile, { force: true }); return; }
      await refusal();
      await writeSealed(revokeFile, entries.map(revocationProjection));
    },
    /**
     * The queued devices, or [] when none (or the file cannot be opened at all). An entry that does not validate is skipped
     * on its own, so one damaged entry never hides the others' credentials. Read errors other than a missing file throw.
     * strict: a file that cannot be opened throws unreadable instead, so a change to the list never writes over it.
     */
    async loadRevocations({ strict = false } = {}) {
      let sealed;
      try { sealed = await fs.readFile(revokeFile); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
      await refusal();
      let entries;
      try { entries = JSON.parse(safeStorage.decryptString(sealed)); } catch {
        if (strict) throw new CloudHomeStoreError("unreadable", "The devices waiting to be removed could not be opened");
        return [];
      }
      return Array.isArray(entries) ? entries.filter(validRevocation).map(revocationProjection) : [];
    },
  };
}
