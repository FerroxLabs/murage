// Copyright 2026 Ferrox Labs
// Backup and persistence-failure rules follow OpenClaw extensions/whatsapp session.ts and auth-store.test.ts
// (MIT, OpenClaw Foundation); record naming follows Baileys use-multi-file-auth-state (MIT).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStoreError, bufferJSON, CREDENTIAL_RECORD_TYPES, isAuthFileName, wipeAuthDir, decodeRecord, encodeRecord, newAuthKey, parseAuthKey, readAuthKeyFile, recordName, useEncryptedAuthState, writeFileAtomic,
  type AuthCreds, type AuthStateOptions,
} from "./auth-store.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "murage-wa-auth-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const initCreds = (): AuthCreds => ({ noiseKey: Buffer.from([1, 2, 3]), registered: false, me: undefined });
const open = (dir: string, key: Buffer, extra: Partial<AuthStateOptions> = {}) => useEncryptedAuthState(dir, key, { initCreds, ...extra });

describe("records", () => {
  it("round-trips values, Buffers included, and binds the record name", () => {
    const key = newAuthKey();
    const value = { a: 1, buf: Buffer.from("secret"), nested: { raw: new Uint8Array([9, 8, 7]) } };
    const sealed = encodeRecord("session-x", value, key);
    const back = decodeRecord("session-x", sealed, key) as { a: number; buf: Buffer; nested: { raw: Buffer } };
    expect(back.a).toBe(1);
    expect(Buffer.isBuffer(back.buf) && back.buf.toString()).toBe("secret");
    expect([...back.nested.raw]).toEqual([9, 8, 7]);
    expect(() => decodeRecord("session-y", sealed, key)).toThrow(AuthStoreError);
  });
  it("is IV, ciphertext, 16 byte tag, with a fresh IV each time and no plaintext", () => {
    const key = newAuthKey();
    const one = encodeRecord("n", { word: "plaintext-marker" }, key);
    const two = encodeRecord("n", { word: "plaintext-marker" }, key);
    expect(one.equals(two)).toBe(false);
    expect(one.includes("plaintext-marker")).toBe(false);
    expect(one.length).toBe(12 + Buffer.byteLength(JSON.stringify({ word: "plaintext-marker" })) + 16);
  });
  it("fails on the wrong key, a flipped byte, or a short file", () => {
    const key = newAuthKey();
    const sealed = encodeRecord("n", { v: 1 }, key);
    expect(() => decodeRecord("n", sealed, newAuthKey())).toThrow(/decrypt/);
    const flipped = Buffer.from(sealed);
    flipped[14] ^= 0xff;
    expect(() => decodeRecord("n", flipped, key)).toThrow(AuthStoreError);
    expect(() => decodeRecord("n", Buffer.alloc(10), key)).toThrow(/short/);
  });
  it("rejects keys that are not 32 bytes", () => {
    expect(() => encodeRecord("n", {}, Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => parseAuthKey("abcd")).toThrow(/32 bytes/);
    const key = newAuthKey();
    expect(parseAuthKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseAuthKey(key.toString("base64")).equals(key)).toBe(true);
  });
  it("mangles names like useMultiFileAuthState and refuses path tricks", () => {
    expect(recordName("pre-key", "12")).toBe("pre-key-12");
    expect(recordName("sender-key", "a/b:c")).toBe("sender-key-a__b-c");
    expect(() => recordName("session", "../x")).toThrow(AuthStoreError);
    expect(() => recordName("../session", "x")).toThrow(AuthStoreError);
    expect(() => recordName("a", "b\u0000c")).toThrow(AuthStoreError);
  });
  it("matches Baileys BufferJSON for the {type:'Buffer'} shape", () => {
    const text = JSON.stringify({ b: Buffer.from("hi") }, bufferJSON.replacer);
    expect(JSON.parse(text).b).toEqual({ type: "Buffer", data: Buffer.from("hi").toString("base64") });
    expect(Buffer.isBuffer(JSON.parse(text, bufferJSON.reviver).b)).toBe(true);
  });
});

describe("useEncryptedAuthState", () => {
  it("starts from fresh creds, persists them encrypted, and reopens with the same key", async () => {
    const dir = path.join(root, "auth");
    const key = newAuthKey();
    const first = await open(dir, key);
    expect(first.hadCreds).toBe(false);
    first.state.creds.registered = true;
    first.state.creds.me = { id: "1@s.whatsapp.net" };
    await first.saveCreds();
    const raw = readFileSync(path.join(dir, "creds.bin"));
    expect(raw.includes("s.whatsapp.net")).toBe(false);
    const second = await open(dir, key);
    expect(second.hadCreds).toBe(true);
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.isBuffer(second.state.creds.noiseKey)).toBe(true);
  });
  it("writes 0700 directories and 0600 files with no temp files left behind", async () => {
    const dir = path.join(root, "auth");
    const store = await open(dir, newAuthKey());
    await store.saveCreds();
    await store.state.keys.set({ "pre-key": { "1": { k: 1 } } });
    if (process.platform !== "win32") {
      expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
      expect((statSync(path.join(dir, "creds.bin")).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(path.join(dir, "pre-key-1.bin")).mode & 0o777).toString(8)).toBe("600");
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("stores, reads, revives and deletes signal keys", async () => {
    const dir = path.join(root, "auth");
    const key = newAuthKey();
    const store = await open(dir, key, { reviveKey: (type: string, value: unknown) => (type === "app-state-sync-key" ? { revived: value } : value) });
    await store.state.keys.set({
      "pre-key": { "1": { priv: Buffer.from("p") }, "2": { priv: Buffer.from("q") } },
      "app-state-sync-key": { "AAA/bbb": { data: 1 } },
      "lid-mapping": { "15550001111": "99@lid" },
    });
    expect(existsSync(path.join(dir, "app-state-sync-key-AAA__bbb.bin"))).toBe(true);
    expect(existsSync(path.join(dir, "lid-mapping-15550001111.bin"))).toBe(true);
    const got = await store.state.keys.get("pre-key", ["1", "2", "3"]);
    expect(Object.keys(got).sort()).toEqual(["1", "2"]);
    expect((got["1"] as { priv: Buffer }).priv.toString()).toBe("p");
    expect(await store.state.keys.get("app-state-sync-key", ["AAA/bbb"])).toEqual({ "AAA/bbb": { revived: { data: 1 } } });
    expect(await store.state.keys.get("lid-mapping", ["15550001111"])).toEqual({ "15550001111": "99@lid" });
    await store.state.keys.set({ "pre-key": { "1": null as unknown as Record<string, unknown> } });
    expect(Object.keys(await store.state.keys.get("pre-key", ["1", "2"]))).toEqual(["2"]);
    for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f)).includes("priv")).toBe(false);
  });
  it("refuses a record moved under another name: a hard stop, not an empty record", async () => {
    const dir = path.join(root, "auth");
    const seen: AuthStoreError[] = [];
    const store = await open(dir, newAuthKey(), { onUnreadable: (error) => seen.push(error) });
    await store.state.keys.set({ session: { a: { v: 1 } } });
    writeFileSync(path.join(dir, "session-b.bin"), readFileSync(path.join(dir, "session-a.bin")));
    await expect(store.state.keys.get("session", ["b"])).rejects.toMatchObject({ code: "undecryptable" });
    expect(seen).toHaveLength(1);
    expect(Object.keys(await store.state.keys.get("session", ["a"]))).toEqual(["a"]);
  });
  it("refuses every record when the wrong key is supplied to an existing directory", async () => {
    const dir = path.join(root, "auth");
    const first = await open(dir, newAuthKey());
    await first.state.keys.set({ "pre-key": { "1": { priv: Buffer.from("p") } } });
    const wrong = await open(path.join(root, "other"), newAuthKey());
    writeFileSync(path.join(root, "other", "pre-key-1.bin"), readFileSync(path.join(dir, "pre-key-1.bin")));
    await expect(wrong.state.keys.get("pre-key", ["1"])).rejects.toBeInstanceOf(AuthStoreError);
  });
  it("writes the same record twice with different ciphertexts (fresh IV on every write)", async () => {
    const dir = path.join(root, "auth");
    const store = await open(dir, newAuthKey());
    await store.state.keys.set({ session: { a: { v: 1 } } });
    const one = readFileSync(path.join(dir, "session-a.bin"));
    await store.state.keys.set({ session: { a: { v: 1 } } });
    const two = readFileSync(path.join(dir, "session-a.bin"));
    expect(one.subarray(0, 12).equals(two.subarray(0, 12))).toBe(false);
    expect(one.equals(two)).toBe(false);
  });
  it("serializes writes: the last set for a record wins", async () => {
    const store = await open(path.join(root, "auth"), newAuthKey());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.state.keys.set({ session: { x: { n: i } } })));
    expect(await store.state.keys.get("session", ["x"])).toEqual({ x: { n: 19 } });
  });
  it("keeps the previous creds as .bak and restores them when creds.bin is corrupt", async () => {
    const dir = path.join(root, "auth");
    const key = newAuthKey();
    const store = await open(dir, key);
    store.state.creds.stage = 1;
    await store.saveCreds();
    store.state.creds.stage = 2;
    await store.saveCreds();
    expect(existsSync(path.join(dir, "creds.bin.bak"))).toBe(true);
    writeFileSync(path.join(dir, "creds.bin"), Buffer.from("garbage that is not a record at all"));
    const reopened = await open(dir, key);
    expect(reopened.restoredFromBackup).toBe(true);
    expect(reopened.hadCreds).toBe(true);
    expect(reopened.state.creds.stage).toBe(1);
    const again = await open(dir, key);
    expect(again.restoredFromBackup).toBe(false);
    expect(again.state.creds.stage).toBe(1);
  });
  it("does not overwrite a good backup with a corrupt creds file", async () => {
    const dir = path.join(root, "auth");
    const key = newAuthKey();
    const store = await open(dir, key);
    store.state.creds.stage = 1;
    await store.saveCreds();
    store.state.creds.stage = 2;
    await store.saveCreds();
    const goodBackup = readFileSync(path.join(dir, "creds.bin.bak"));
    writeFileSync(path.join(dir, "creds.bin"), Buffer.from("corrupted by a crash, longer than twenty-eight bytes"));
    store.state.creds.stage = 3;
    await store.saveCreds();
    expect(readFileSync(path.join(dir, "creds.bin.bak")).equals(goodBackup)).toBe(true);
    expect((await open(dir, key)).state.creds.stage).toBe(3);
  });
  it("refuses a wrong key instead of minting new creds over the old ones", async () => {
    const dir = path.join(root, "auth");
    const store = await open(dir, newAuthKey());
    await store.saveCreds();
    const before = readFileSync(path.join(dir, "creds.bin"));
    await expect(open(dir, newAuthKey())).rejects.toMatchObject({ code: "undecryptable" });
    expect(readFileSync(path.join(dir, "creds.bin")).equals(before)).toBe(true);
  });
  it("refuses a symlinked auth directory and a symlinked record", async () => {
    if (process.platform === "win32") return;
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    const key = newAuthKey();
    await open(real, key);
    symlinkSync(real, link);
    await expect(open(link, key)).rejects.toMatchObject({ code: "unsafe-path" });
    const dir = path.join(root, "auth");
    const store = await open(dir, key);
    writeFileSync(path.join(root, "elsewhere"), "x");
    symlinkSync(path.join(root, "elsewhere"), path.join(dir, "pre-key-9.bin"));
    await expect(store.state.keys.get("pre-key", ["9"])).rejects.toMatchObject({ code: "unsafe-path" });
  });
  it("reports a persistence failure through the hook and to the caller", async () => {
    const dir = path.join(root, "auth");
    const failures: unknown[] = [];
    const store = await open(dir, newAuthKey(), { onPersistenceFailure: (e: unknown) => failures.push(e) });
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "now a file, not a directory");
    await expect(store.saveCreds()).rejects.toMatchObject({ code: "persist-failed" });
    await expect(store.state.keys.set({ session: { a: { v: 1 } } })).rejects.toMatchObject({ code: "persist-failed" });
    expect(failures).toHaveLength(2);
    await expect(store.flush()).resolves.toBeUndefined();
  });
  it("writeFileAtomic replaces a file in one step", async () => {
    const file = path.join(root, "f.bin");
    await writeFileAtomic(file, Buffer.from("one"));
    await writeFileAtomic(file, Buffer.from("two"));
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readAuthKeyFile", () => {
  it("reads raw, hex and base64 keys with owner-only permissions", () => {
    if (process.platform === "win32") return;
    const key = newAuthKey();
    for (const [name, body] of [["raw", key], ["hex", Buffer.from(key.toString("hex"))], ["b64", Buffer.from(key.toString("base64"))]] as const) {
      const file = path.join(root, name);
      writeFileSync(file, body, { mode: 0o600 });
      expect(readAuthKeyFile(file).equals(key)).toBe(true);
    }
  });
  it("refuses a symlink, loose permissions, and a wrong-size key", () => {
    if (process.platform === "win32") return;
    const key = newAuthKey();
    const real = path.join(root, "key");
    writeFileSync(real, key, { mode: 0o600 });
    symlinkSync(real, path.join(root, "linked"));
    expect(() => readAuthKeyFile(path.join(root, "linked"))).toThrow();
    const loose = path.join(root, "loose");
    writeFileSync(loose, key, { mode: 0o600 });
    chmodSync(loose, 0o644);
    expect(() => readAuthKeyFile(loose)).toThrow(/owner only/);
    const short = path.join(root, "short");
    writeFileSync(short, Buffer.alloc(10, 1), { mode: 0o600 });
    expect(() => readAuthKeyFile(short)).toThrow(/32 bytes/);
  });
});

describe("credential-class wipe (OpenClaw fe6fa891ea4)", () => {
  it("lists every Baileys signal class", () => {
    expect([...CREDENTIAL_RECORD_TYPES].sort()).toEqual([
      "app-state-sync-key", "app-state-sync-version", "device-list", "identity-key", "lid-mapping", "pre-key", "sender-key", "sender-key-memory", "session", "tctoken",
    ]);
  });
  it("recognises the files this store writes, and nothing else", () => {
    for (const type of CREDENTIAL_RECORD_TYPES) expect(isAuthFileName(`${type}-abc.bin`)).toBe(true);
    expect(isAuthFileName("creds.bin")).toBe(true);
    expect(isAuthFileName("creds.bin.bak")).toBe(true);
    expect(isAuthFileName("creds.bin.0123456789ab.tmp")).toBe(true);
    expect(isAuthFileName("notes.txt")).toBe(false);
    expect(isAuthFileName("session-abc.json")).toBe(false);
  });
  it("removes a record of every class, creds, the backup and temp leftovers, and reports strangers", async () => {
    const dir = path.join(root, "auth");
    const store = await open(dir, newAuthKey());
    await store.saveCreds();
    await store.saveCreds();
    const data: Record<string, Record<string, unknown>> = {};
    for (const type of CREDENTIAL_RECORD_TYPES) data[type] = { id1: { v: type } };
    await store.state.keys.set(data);
    writeFileSync(path.join(dir, "creds.bin.0123456789ab.tmp"), "x");
    writeFileSync(path.join(dir, "stray.txt"), "x");
    expect(readdirSync(dir).length).toBeGreaterThan(12);
    const result = await wipeAuthDir(dir);
    expect(result.unrecognised).toEqual(["stray.txt"]);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("is a no-op for a missing directory and refuses a symlinked one", async () => {
    expect(await wipeAuthDir(path.join(root, "missing"))).toEqual({ removed: 0, unrecognised: [] });
    const real = path.join(root, "real");
    await open(real, newAuthKey());
    symlinkSync(real, path.join(root, "link"));
    await expect(wipeAuthDir(path.join(root, "link"))).rejects.toMatchObject({ code: "unsafe-path" });
  });
});
