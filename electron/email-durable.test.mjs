// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r4 section 1 (test 1, 8): durable write order, and the ack built from a read-back of credentials.bin.
import { describe, expect, it } from "vitest";
import { writeFileDurable } from "./durable-write.mjs";
import { ackFromDisk, emailSecretsSavedMessage, sanitizeEmailSecretsDoc, EMAIL_SECRETS_KEY } from "./email-secrets.mjs";

function fakeFs({ failOn } = {}) {
  const log = [];
  let next = 10;
  const fds = new Map();
  const step = (name, detail) => { if (failOn === name) throw new Error(`injected ${name} failure`); log.push(detail ? `${name}:${detail}` : name); };
  return {
    log,
    openSync(path) { step("open", path); const fd = next++; fds.set(fd, path); return fd; },
    writeFileSync(fd) { step("write", fds.get(fd)); },
    fsyncSync(fd) { step("fsync", fds.get(fd)); },
    closeSync(fd) { step("close", fds.get(fd)); },
    renameSync(from, to) { step("rename", `${from}>${to}`); },
  };
}

describe("durable credentials write (r4 section 1)", () => {
  it("POSIX: write, fsync, close, rename, then fsync of the parent directory", () => {
    const fs = fakeFs();
    writeFileDurable(fs, "/data/credentials.bin", "x", { platform: "darwin", pid: 7 });
    expect(fs.log).toEqual([
      "open:/data/credentials.bin.7.tmp", "write:/data/credentials.bin.7.tmp", "fsync:/data/credentials.bin.7.tmp", "close:/data/credentials.bin.7.tmp",
      "rename:/data/credentials.bin.7.tmp>/data/credentials.bin",
      "open:/data", "fsync:/data", "close:/data",
    ]);
  });
  it("Windows: the renamed file is reopened and flushed", () => {
    const fs = fakeFs();
    writeFileDurable(fs, "C:\\u\\credentials.bin", "x", { platform: "win32", pid: 7 });
    expect(fs.log.slice(-3)).toEqual(["open:C:\\u\\credentials.bin", "fsync:C:\\u\\credentials.bin", "close:C:\\u\\credentials.bin"]);
    expect(fs.log.some((entry) => entry === "fsync:C:\\u\\credentials.bin.7.tmp")).toBe(true);
  });
  it("a failed file fsync rejects before the rename; a failed directory fsync rejects", () => {
    const first = fakeFs({ failOn: "fsync" });
    expect(() => writeFileDurable(first, "/data/credentials.bin", "x", { platform: "linux" })).toThrow(/injected fsync/);
    expect(first.log.some((entry) => entry.startsWith("rename"))).toBe(false);
  });
});

const DOC = { owner: { token: "o-tok", keyId: "key_o" }, bots: { b1: { token: "b1-tok", keyId: "key_b1" } }, prev: { b1: { token: "p-tok", keyId: "key_prev" } }, retired: { ibx_1: { token: "r-tok", keyId: "key_ret", botId: "b1" } } };
const SAVE = { type: "murage:email-secrets-save", rev: 4, epoch: "e1", doc: DOC };

describe("the ack names the key ids read back from disk (r4 section 1)", () => {
  it("lists the bot, prev, retired and owner key ids the decrypted file holds", async () => {
    const stored = { [EMAIL_SECRETS_KEY]: DOC };
    const ack = await ackFromDisk({ readFile: () => Buffer.from("enc"), decrypt: async () => JSON.stringify(stored) }, SAVE);
    expect(ack).toEqual({ type: "murage:email-secrets-saved", rev: 4, epoch: "e1", keyIds: expect.arrayContaining(["key_b1", "key_prev", "key_ret", "key_o"]) });
    expect(ack.keyIds).toHaveLength(4);
  });
  it("lists only what the file holds: a key the write lost is absent", async () => {
    const stored = { [EMAIL_SECRETS_KEY]: { bots: { b1: DOC.bots.b1 } } };
    const ack = await ackFromDisk({ readFile: () => Buffer.from("enc"), decrypt: async () => ({ result: JSON.stringify(stored) }) }, SAVE);
    expect(ack.keyIds).toEqual(["key_b1"]);
  });
  it("a read-back that fails to read, decrypt or parse sends no ack", async () => {
    await expect(ackFromDisk({ readFile: () => { throw new Error("EIO"); }, decrypt: async () => "{}" }, SAVE)).rejects.toThrow();
    await expect(ackFromDisk({ readFile: () => Buffer.from("x"), decrypt: async () => { throw new Error("keychain busy"); } }, SAVE)).rejects.toThrow();
    await expect(ackFromDisk({ readFile: () => Buffer.from("x"), decrypt: async () => "not json" }, SAVE)).rejects.toThrow();
  });
  it("no ack without a key id list; the prev slot survives the sanitizer", () => {
    expect(emailSecretsSavedMessage(SAVE)).toBeNull();
    expect(sanitizeEmailSecretsDoc(DOC).prev).toEqual({ b1: { token: "p-tok", keyId: "key_prev" } });
  });
});
