// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// attachment-read.ts: the leaf checks (names, links, FIFOs, directories, hard
// links, size), the bounded pool (two slots, queue of 64, 10 s deadline from
// enqueue, stuck slots stay counted, late opens closed) and lossless identity.
import { execFileSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import * as realFsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import {
  ATTACHMENT_IO_DEADLINE_MS, ATTACHMENT_IO_QUEUE, ATTACHMENT_READ_CEILING, __resetAttachmentPoolForTests, __setAttachmentFsForTests, __setAttachmentReadHookForTests,
  attachmentNameOf, attachmentPoolState, attachmentsHomeOf, probeAttachment, readAttachmentFile, sameIdentity, storedPathOf,
  type AttachmentFs, type AttachmentHandle, type FileIdentity,
} from "./attachment-read.ts";

const posix = process.platform !== "win32";
let root: string, folder: string;
const home = () => attachmentsHomeOf(root);
const NAME = "11111111-1111-4111-8111-111111111111.png";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "murage-attachment-read-"));
  folder = join(root, "attachments");
  mkdirSync(folder, { mode: 0o700 });
});
afterEach(() => {
  __setAttachmentFsForTests(undefined);
  __setAttachmentReadHookForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeTempDirSync(root);
});

/** Counts the real fs calls the module makes. */
function countingFs(): { fs: AttachmentFs; lstat: number; open: number } {
  const counts = { lstat: 0, open: 0 } as { fs: AttachmentFs; lstat: number; open: number };
  const real = realFsp;
  counts.fs = {
    lstat: async path => { counts.lstat++; return real.lstat(path, { bigint: true }); },
    open: async (path, flags) => {
      counts.open++;
      const handle = await real.open(path, flags);
      return { stat: () => handle.stat({ bigint: true }), read: (b, o, l, p) => handle.read(b, o, l, p), close: () => handle.close() };
    },
  };
  return counts;
}

describe("names", () => {
  it("refuses reserved device names, dotfiles, separators and long bases without any filesystem call", async () => {
    const seen = countingFs();
    __setAttachmentFsForTests(seen.fs);
    for (const name of ["nul.png", "CON.png", "com1.webp", "Lpt9.gif", ".hidden.png", "a/b.png", "..png", `${"a".repeat(161)}.png`, "a\\b.png"]) {
      expect(await readAttachmentFile(home(), name, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular" });
      expect(await probeAttachment(home(), name, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular" });
    }
    expect(seen.lstat + seen.open).toBe(0);
    writeFileSync(join(folder, NAME), "ok");
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toMatchObject({ ok: true });
  });

  it("maps stored paths to names only directly inside the folder", () => {
    expect(attachmentNameOf(home(), join(folder, NAME))).toBe(NAME);
    expect(attachmentNameOf(home(), join(root, NAME))).toBeNull();
    expect(attachmentNameOf(home(), join(folder, "sub", NAME))).toBeNull();
    expect(storedPathOf(home(), NAME)).toBe(join(folder, NAME));
  });
});

describe("leaf checks", () => {
  it("reads an ordinary file with its exact bytes", async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 3);
    writeFileSync(join(folder, NAME), bytes);
    const read = await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
    expect(read.ok && read.bytes.equals(bytes)).toBe(true);
  });

  it.runIf(posix)("refuses a link to a file outside, without opening it", async () => {
    const outside = join(root, "secret.png");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(folder, NAME));
    const seen = countingFs();
    __setAttachmentFsForTests(seen.fs);
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular", code: "link" });
    expect(seen.open).toBe(0);
  });

  it.runIf(posix)("refuses a FIFO without opening it, and the event loop keeps running", async () => {
    execFileSync("mkfifo", [join(folder, NAME)]);
    const seen = countingFs();
    __setAttachmentFsForTests(seen.fs);
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular" });
    expect(seen.open).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
  });

  it("refuses a directory, a hard-linked file and a folder that is a link", async () => {
    mkdirSync(join(folder, NAME));
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular" });
    rmdirSync(join(folder, NAME));
    writeFileSync(join(folder, NAME), "x");
    linkSync(join(folder, NAME), join(root, "other.png"));
    const seen = countingFs();
    __setAttachmentFsForTests(seen.fs);
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular" });
    expect(seen.open).toBe(0);
    if (posix) {
      unlinkSync(join(root, "other.png"));
      const real = join(root, "real-attachments");
      renameSync(folder, real);
      symlinkSync(real, folder);
      expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "not-regular", code: "link" });
    }
  });

  it("reads exactly 25 MiB; 25 MiB + 1 and a 2 GiB sparse file are too large and never opened", async () => {
    const path = join(folder, NAME);
    writeFileSync(path, "");
    truncateSync(path, ATTACHMENT_READ_CEILING);
    const exact = await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
    expect(exact.ok && exact.bytes.length).toBe(ATTACHMENT_READ_CEILING);
    truncateSync(path, ATTACHMENT_READ_CEILING + 1);
    const seen = countingFs();
    __setAttachmentFsForTests(seen.fs);
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "too-large" });
    // a caller asking for more than the ceiling still gets the ceiling
    expect(await readAttachmentFile(home(), NAME, 100 * 1024 * 1024)).toEqual({ ok: false, reason: "too-large" });
    truncateSync(path, 2 * 1024 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "too-large" });
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
    expect(seen.open).toBe(0);
  });

  it.runIf(posix)("a FIFO swapped in after the check does not hang: refused after the open, no byte read", async () => {
    const path = join(folder, NAME);
    writeFileSync(path, "plain");
    __setAttachmentReadHookForTests(stage => { if (stage === "before-open") { unlinkSync(path); execFileSync("mkfifo", [path]); } });
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const read = await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
    expect(read.ok).toBe(false);
    expect(["not-regular", "changed"]).toContain(!read.ok && read.reason);
    expect(ticked).toBe(true);
  }, 5000);

  it.runIf(posix)("a link swapped in after the check is refused by the no-follow open", async () => {
    const path = join(folder, NAME), outside = join(root, "secret.png");
    writeFileSync(path, "plain"); writeFileSync(outside, "plain");
    __setAttachmentReadHookForTests(stage => { if (stage === "before-open") { unlinkSync(path); symlinkSync(outside, path); } });
    const read = await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
    expect(read.ok).toBe(false);
    expect(["not-regular", "changed"]).toContain(!read.ok && read.reason);
  });

  it("another file of equal size swapped in, or bytes appended during the read, answer changed", async () => {
    const path = join(folder, NAME);
    writeFileSync(path, "aaaa");
    __setAttachmentReadHookForTests(stage => { if (stage === "before-open") { const other = join(folder, "swap.tmp"); writeFileSync(other, "bbbb"); renameSync(other, path); } });
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "changed" });
    writeFileSync(join(folder, "22222222-2222-4222-8222-222222222222.png"), "cccc");
    __setAttachmentReadHookForTests((stage, name) => { if (stage === "after-read") appendFileSync(join(folder, name), "more"); });
    expect(await readAttachmentFile(home(), "22222222-2222-4222-8222-222222222222.png", ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "changed" });
  });

  it("an I/O error answers io and the handle is still closed", async () => {
    writeFileSync(join(folder, NAME), "data");
    const seen = countingFs();
    let closed = 0;
    __setAttachmentFsForTests({ lstat: seen.fs.lstat, open: async (path, flags) => {
      const handle = await seen.fs.open(path, flags);
      return { ...handle, read: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }, close: async () => { closed++; await handle.close(); } };
    } });
    expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "io", code: "EIO" });
    expect(closed).toBe(1);
  });
});

describe("identity", () => {
  it("compares losslessly above 2^53", () => {
    const a: FileIdentity = { dev: 1n, ino: 2n ** 60n, nlink: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n };
    expect(sameIdentity(a, { ...a, ino: 2n ** 60n + 1n })).toBe(false);
    expect(Number(a.ino) === Number(a.ino + 1n)).toBe(true); // what number-valued stats lost
  });

  it("a size of 2^53 + 1 is too large before any conversion", async () => {
    __setAttachmentFsForTests({
      lstat: async path => fakeStat(path === folder ? "dir" : "file", 2n ** 53n + 1n),
      open: async () => { throw new Error("must not open"); },
    });
    expect(await probeAttachment(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "too-large" });
  });
});

function fakeStat(kind: "dir" | "file", size = 4n): BigIntStats {
  return {
    isDirectory: () => kind === "dir", isFile: () => kind === "file", isSymbolicLink: () => false,
    dev: 1n, ino: kind === "dir" ? 1n : 2n, nlink: 1n, size, mtimeNs: 5n, ctimeNs: 6n,
  } as unknown as BigIntStats;
}

describe("the pool", () => {
  /** A fake fs whose open never settles until released. */
  function stallingFs(stage: "open" | "lstat") {
    const pending: Array<(handle: AttachmentHandle) => void> = [];
    const stalledLstats: Array<() => void> = [];
    let lstats = 0, closes = 0, stallLstat = stage === "lstat", released = false;
    const handle = (): AttachmentHandle => ({
      stat: async () => fakeStat("file"),
      read: async (buffer, offset, length) => { buffer.fill(7, offset, offset + length); return { bytesRead: length }; },
      close: async () => { closes++; },
    });
    const fs: AttachmentFs = {
      lstat: async path => {
        lstats++;
        if (stallLstat && path !== folder) await new Promise<void>(resolve => stalledLstats.push(resolve));
        return fakeStat(path === folder ? "dir" : "file");
      },
      open: () => stage === "open" && !released ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(handle()),
    };
    return {
      fs, get lstats() { return lstats; }, get closes() { return closes; },
      release: () => { stallLstat = false; released = true; for (const resolve of pending.splice(0)) resolve(handle()); for (const resolve of stalledLstats.splice(0)) resolve(); },
    };
  }

  for (const stage of ["open", "lstat"] as const) {
    it(`a stalled ${stage}: both slots answer io/timeout at 10 s, a queued read answers busy, the 65th waiter busy at once`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      __resetAttachmentPoolForTests();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fake = stallingFs(stage);
      __setAttachmentFsForTests(fake.fs);
      const first = readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
      const second = readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
      await vi.advanceTimersByTimeAsync(0);
      const lstatsWhileHeld = fake.lstats;
      const queued = Array.from({ length: ATTACHMENT_IO_QUEUE }, () => readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING));
      expect(attachmentPoolState()).toMatchObject({ active: 2, queued: ATTACHMENT_IO_QUEUE });
      // the 65th waiter: busy at once
      expect(await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)).toEqual({ ok: false, reason: "busy" });
      await vi.advanceTimersByTimeAsync(0);
      // a queued read does not even run its pre-open lstat while both slots are held
      expect(fake.lstats).toBe(lstatsWhileHeld);
      await vi.advanceTimersByTimeAsync(ATTACHMENT_IO_DEADLINE_MS);
      expect(await first).toEqual({ ok: false, reason: "io", code: "timeout" });
      expect(await second).toEqual({ ok: false, reason: "io", code: "timeout" });
      for (const read of await Promise.all(queued)) expect(read).toEqual({ ok: false, reason: "busy" });
      // the stuck slots stay counted until their fs call settles
      expect(attachmentPoolState()).toMatchObject({ active: 2, stuck: 2 });
      expect(warn).toHaveBeenCalledTimes(1);
      fake.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(attachmentPoolState()).toMatchObject({ active: 0, stuck: 0, queued: 0 });
      // a late open is closed, never leaked
      if (stage === "open") expect(fake.closes).toBe(2);
      vi.useRealTimers();
      const next = await readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING);
      expect(next).toMatchObject({ ok: true });
      warn.mockRestore();
    });
  }

  it("never holds more than two operations at once", async () => {
    let inFlight = 0, most = 0;
    __setAttachmentFsForTests({
      lstat: async path => { inFlight++; most = Math.max(most, inFlight); await new Promise(resolve => setTimeout(resolve, 1)); inFlight--; return fakeStat(path === folder ? "dir" : "file"); },
      open: async () => ({ stat: async () => fakeStat("file"), read: async (_buffer, _offset, length) => ({ bytesRead: length }), close: async () => undefined }),
    });
    await Promise.all(Array.from({ length: 20 }, () => readAttachmentFile(home(), NAME, ATTACHMENT_READ_CEILING)));
    expect(most).toBeLessThanOrEqual(2);
  });
});
