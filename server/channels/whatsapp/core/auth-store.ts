// Copyright 2026 Ferrox Labs
// Adapted from OpenClaw extensions/whatsapp/src/session.ts and auth-store.ts (MIT, OpenClaw Foundation)
// for the save queue, creds backup and persistence-failure rules, and from Baileys
// lib/Utils/use-multi-file-auth-state.js (MIT) for the AuthenticationState contract.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Encrypted-at-rest Baileys auth state (design 3). Same contract as
// useMultiFileAuthState, but every record is AES-256-GCM sealed with a key
// handed in by the caller. This module does not import Baileys: the creds
// initialiser and any record revival are injected.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants as fsConstants, closeSync, fstatSync, mkdirSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const AUTH_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const CREDS_RECORD = "creds";
export const RECORD_EXT = ".bin";

export type AuthStoreErrorCode = "bad-key" | "undecryptable" | "unsafe-path" | "bad-record-name" | "persist-failed";

/**
 * Every Baileys signal-key class (`SignalDataTypeMap`, rc14). Logout, relink and wipe cover all of
 * them plus `creds` and its backup; OpenClaw fe6fa891ea4 fixed a regex that missed device-list,
 * lid-mapping, tctoken, sender-key-memory, identity-key and app-state-sync-version.
 */
export const CREDENTIAL_RECORD_TYPES = [
  "app-state-sync-key", "app-state-sync-version", "device-list", "identity-key", "lid-mapping",
  "pre-key", "sender-key", "sender-key-memory", "session", "tctoken",
] as const;

/** True for a file name this store writes: creds, its backup, a `<class>-<id>` record, or a leftover temp file. */
export function isAuthFileName(name: string): boolean {
  const base = name.replace(/\.[0-9a-f]{12}\.tmp$/, "");
  if (base === `${CREDS_RECORD}${RECORD_EXT}` || base === `${CREDS_RECORD}${RECORD_EXT}.bak`) return true;
  return base.endsWith(RECORD_EXT) && CREDENTIAL_RECORD_TYPES.some((type) => base.startsWith(`${type}-`));
}

/**
 * Removes the whole credential set: every known class, creds, backup and temp leftovers, and also any
 * unrecognised file, because a wipe that leaves a key behind is not a wipe. Refuses a symlinked
 * directory; a symlink inside it is unlinked, never followed. Returns what it found that was not ours.
 */
export async function wipeAuthDir(dir: string): Promise<{ removed: number; unrecognised: string[] }> {
  let stat;
  try { stat = await lstat(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { removed: 0, unrecognised: [] };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AuthStoreError("unsafe-path", "WhatsApp auth directory must be a real directory");
  let removed = 0;
  const unrecognised: string[] = [];
  for (const name of await readdir(dir)) {
    if (!isAuthFileName(name)) unrecognised.push(name);
    await rm(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return { removed, unrecognised };
}

export class AuthStoreError extends Error {
  readonly code: AuthStoreErrorCode;
  constructor(code: AuthStoreErrorCode, message: string) {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

/** Baileys BufferJSON, reimplemented: Buffers travel as {type:"Buffer", data:<base64>}. */
export const bufferJSON = {
  replacer(_key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return { type: "Buffer", data: Buffer.from(value).toString("base64") };
    const v = value as { type?: unknown; data?: unknown } | null;
    if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) return { type: "Buffer", data: Buffer.from(v.data as number[]).toString("base64") };
    return value;
  },
  reviver(_key: string, value: unknown): unknown {
    const v = value as { type?: unknown; data?: unknown } | null;
    if (v && typeof v === "object" && (v.type === "Buffer" || v.type === "Uint8Array")) {
      if (typeof v.data === "string") return Buffer.from(v.data, "base64");
      if (Array.isArray(v.data)) return Buffer.from(v.data as number[]);
    }
    return value;
  },
};

/** Accepts 64 hex characters or base64 of 32 bytes (the env var form). */
export function parseAuthKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== AUTH_KEY_BYTES) throw new AuthStoreError("bad-key", "WhatsApp auth key must be 32 bytes");
  return key;
}

export function newAuthKey(): Buffer {
  return randomBytes(AUTH_KEY_BYTES);
}

/**
 * Reads an on-disk key file: no symlinks, regular file, owner only, exactly
 * 32 bytes (hex or base64 text, or raw bytes). Creating the key is the
 * caller's job (design 3.3).
 */
export function readAuthKeyFile(file: string): Buffer {
  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new AuthStoreError("unsafe-path", "WhatsApp auth key is not a regular file");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new AuthStoreError("unsafe-path", "WhatsApp auth key must be readable by its owner only");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new AuthStoreError("unsafe-path", "WhatsApp auth key belongs to another user");
    if (stat.size > 256) throw new AuthStoreError("bad-key", "WhatsApp auth key file is too large");
    const raw = Buffer.alloc(stat.size);
    readSync(fd, raw, 0, stat.size, 0);
    return raw.length === AUTH_KEY_BYTES ? raw : parseAuthKey(raw.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function assertKey(key: Uint8Array): Buffer {
  if (key.length !== AUTH_KEY_BYTES) throw new AuthStoreError("bad-key", "WhatsApp auth key must be 32 bytes");
  return Buffer.from(key);
}

const RECORD_NAME = /^[A-Za-z0-9_+=@-][A-Za-z0-9._+=@-]*$/;

/** `${type}-${id}` with `/` as `__` and `:` as `-`, as useMultiFileAuthState names its files. */
export function recordName(type: string, id: string): string {
  const name = `${type}-${id}`.replace(/\//g, "__").replace(/:/g, "-");
  if (!RECORD_NAME.test(name) || name.includes("..")) throw new AuthStoreError("bad-record-name", "WhatsApp auth record name is not allowed");
  return name;
}

/** IV (12) | ciphertext | tag (16). The record name is the GCM additional data. */
export function encodeRecord(name: string, value: unknown, key: Uint8Array, iv: Buffer = randomBytes(IV_BYTES)): Buffer {
  const cipher = createCipheriv("aes-256-gcm", assertKey(key), iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value, bufferJSON.replacer), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function decodeRecord(name: string, data: Uint8Array, key: Uint8Array): unknown {
  const buffer = Buffer.from(data);
  if (buffer.length < IV_BYTES + TAG_BYTES) throw new AuthStoreError("undecryptable", "WhatsApp auth record is too short");
  try {
    const decipher = createDecipheriv("aes-256-gcm", assertKey(key), buffer.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(buffer.subarray(IV_BYTES, buffer.length - TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString("utf8"), bufferJSON.reviver);
  } catch (error) {
    if (error instanceof AuthStoreError) throw error;
    throw new AuthStoreError("undecryptable", "WhatsApp auth record could not be decrypted");
  }
}

export type AuthCreds = Record<string, unknown>;
export type AuthKeyData = Record<string, Record<string, unknown>>;

export interface EncryptedAuthState {
  state: {
    creds: AuthCreds;
    keys: {
      get(type: string, ids: readonly string[]): Promise<Record<string, unknown>>;
      set(data: AuthKeyData): Promise<void>;
    };
  };
  saveCreds(): Promise<void>;
  /** Resolves when every queued write has landed on disk. */
  flush(): Promise<void>;
  /** True when a creds record was found (or restored) at open, i.e. no new link is needed. */
  hadCreds: boolean;
  /** True when creds were restored from `creds.bin.bak` at open. */
  restoredFromBackup: boolean;
}

export interface AuthStateOptions {
  /** Baileys `initAuthCreds`. */
  initCreds: () => AuthCreds;
  /** Revive a stored key record into the shape Baileys expects (for app-state-sync-key). */
  reviveKey?: (type: string, value: unknown) => unknown;
  /** Called when a stored record does not decrypt with the expected key. The caller must stop the socket (hard refusal). */
  onUnreadable?: (error: AuthStoreError) => void;
  /** Called when a write fails. The caller must abort the socket so signal keys never run ahead of disk. */
  onPersistenceFailure?: (error: unknown) => void;
}

async function assertSafeDir(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AuthStoreError("unsafe-path", "WhatsApp auth directory must be a real directory");
}

async function readRecordFile(file: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AuthStoreError("unsafe-path", "WhatsApp auth record must be a regular file");
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Temp file, fsync, rename, mode 0600 (design 3.2). */
export async function writeFileAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Opens (creating if needed) the encrypted auth directory. A creds file that
 * does not decrypt is replaced from `creds.bin.bak` when the backup is good;
 * when neither decrypts the call throws rather than minting new creds over a
 * wrong key.
 */
export async function useEncryptedAuthState(dir: string, keyBytes: Uint8Array, options: AuthStateOptions): Promise<EncryptedAuthState> {
  const key = assertKey(keyBytes);
  await assertSafeDir(dir);
  const fileOf = (name: string): string => path.join(dir, `${name}${RECORD_EXT}`);
  const credsFile = fileOf(CREDS_RECORD);
  const backupFile = `${credsFile}.bak`;

  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
  const fail = (error: unknown): never => {
    try { options.onPersistenceFailure?.(error); } catch { /* the hook must not mask the original failure */ }
    throw error instanceof AuthStoreError ? error : new AuthStoreError("persist-failed", `WhatsApp auth state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  };

  const tryDecodeCreds = async (file: string): Promise<AuthCreds | null | "bad"> => {
    const raw = await readRecordFile(file);
    if (!raw) return null;
    try {
      const value = decodeRecord(CREDS_RECORD, raw, key);
      return value && typeof value === "object" ? (value as AuthCreds) : "bad";
    } catch {
      return "bad";
    }
  };

  let creds: AuthCreds;
  let hadCreds = false;
  let restoredFromBackup = false;
  const primary = await tryDecodeCreds(credsFile);
  if (primary && primary !== "bad") {
    creds = primary;
    hadCreds = true;
  } else {
    const backup = await tryDecodeCreds(backupFile);
    if (backup && backup !== "bad") {
      creds = backup;
      hadCreds = true;
      restoredFromBackup = true;
      await writeFileAtomic(credsFile, encodeRecord(CREDS_RECORD, creds, key));
    } else if (primary === "bad" || backup === "bad") {
      throw new AuthStoreError("undecryptable", "WhatsApp credentials exist but cannot be decrypted with this key");
    } else {
      creds = options.initCreds();
    }
  }

  const saveCreds = (): Promise<void> => enqueue(async () => {
    try {
      // Keep the previous creds as the backup only if they still decrypt (never overwrite a good backup with a bad file).
      const previous = await readRecordFile(credsFile);
      if (previous) {
        try {
          decodeRecord(CREDS_RECORD, previous, key);
          await writeFileAtomic(backupFile, previous).catch(() => undefined);
        } catch { /* keep the existing backup */ }
      }
      await writeFileAtomic(credsFile, encodeRecord(CREDS_RECORD, creds, key));
    } catch (error) {
      fail(error);
    }
  });

  const keys = {
    async get(type: string, ids: readonly string[]): Promise<Record<string, unknown>> {
      await tail;
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const name = recordName(type, id);
        const raw = await readRecordFile(fileOf(name));
        if (!raw) continue;
        let value: unknown;
        try {
          value = decodeRecord(name, raw, key);
        } catch {
          // A record that will not decrypt with the expected key is a hard refusal, never a silent
          // empty record: Baileys would otherwise mint a replacement and fork the signal state.
          const refusal = new AuthStoreError("undecryptable", `WhatsApp auth record ${type} could not be decrypted`);
          try { options.onUnreadable?.(refusal); } catch { /* the hook must not mask the refusal */ }
          throw refusal;
        }
        out[id] = options.reviveKey ? options.reviveKey(type, value) : value;
      }
      return out;
    },
    set(data: AuthKeyData): Promise<void> {
      return enqueue(async () => {
        try {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const name = recordName(type, id);
              if (value === null || value === undefined) await rm(fileOf(name), { force: true });
              else await writeFileAtomic(fileOf(name), encodeRecord(name, value, key));
            }
          }
        } catch (error) {
          fail(error);
        }
      });
    },
  };

  return { state: { creds, keys }, saveCreds, flush: () => tail.then(() => undefined), hadCreds, restoredFromBackup };
}
