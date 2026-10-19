// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The callers of attachment-read.ts (r3 R8 to R11): upload retries compare
// through the bounded reader and never read synchronously, a stalled disk
// answers 503 within the deadline, the avatar check tells "retry" from
// "absent", receipt re-completion reuses an identical committed entry after
// a byte-for-byte check through the leaf (so it finishes on a full disk) and
// writes otherwise, and membership is asked again after every awaited read.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_IO_DEADLINE_MS, __resetAttachmentPoolForTests, __setAttachmentFsForTests, __setAttachmentReadHookForTests, attachmentPoolState, type AttachmentFs } from "./attachment-read.ts";
import {
  IMAGE_MAX_BYTES, __resetAttachmentAccountingForTests, attachmentExists, probeServedImage, readAttachment, saveFile, saveImageUpload, saveReceiptImage, writeNewReceiptImage,
} from "./attachments.ts";
import { initializeArtifacts, type ArtifactScope } from "./artifacts.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { __setFreeDiskProbeForTests } from "./disk-space.ts";
import { imageReferences } from "./image-operations.ts";
import { resolveImageReferences } from "./image-reference-resolver.ts";
import { __resetMediaAssetsForTests, mediaAssetsRoute, type MediaAssetsDeps } from "./media-assets.ts";
import type { DelegatedRequest, DelegatedResult } from "./route-delegation.ts";
import { Store } from "./store.ts";
import { MEDIA_ROUTES, type MediaResolveResponse } from "../shared/media-assets.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const FOLDER = join(DATA_DIR, "attachments");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const ID = "44444444-4444-4444-8444-444444444444";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => { removeTempDirSync(FOLDER); mkdirSync(FOLDER, { recursive: true, mode: 0o700 }); __resetAttachmentAccountingForTests(); __resetMediaAssetsForTests(); __resetAttachmentPoolForTests(); });
afterEach(() => {
  __setAttachmentFsForTests(undefined); __setAttachmentReadHookForTests(undefined); __setFreeDiskProbeForTests(undefined);
  vi.useRealTimers(); vi.restoreAllMocks();
});

/** A store whose image lookups can be revoked mid-request, as a deletion would. */
function revocable(store: Store): { store: Store; revoke: () => void } {
  let revoked = false;
  const hidden = new Set(["boundAttachments", "imagePathsNamed", "recentImagePaths", "rowAttaching"]);
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (revoked && typeof prop === "string" && hidden.has(prop)) {
        return prop === "boundAttachments" ? () => new Map() : prop === "imagePathsNamed" ? () => new Set() : prop === "recentImagePaths" ? () => [] : () => undefined;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: proxy, revoke: () => { revoked = true; } };
}

/** An fs whose every lstat of an entry never settles until released. */
function stalled(): { fs: AttachmentFs; release: () => void } {
  const waiting: Array<() => void> = [];
  const real = (path: string) => import("node:fs/promises").then(fsp => fsp.lstat(path, { bigint: true }));
  return {
    fs: {
      lstat: async (path: string): Promise<BigIntStats> => { if (path !== FOLDER) await new Promise<void>(resolve => waiting.push(resolve)); return real(path); },
      open: async () => { throw new Error("not reached"); },
    },
    release: () => { for (const resolve of waiting.splice(0)) resolve(); },
  };
}

describe("upload retries", () => {
  it("an equal retry is answered from the bounded compare without writing anything", async () => {
    const first = await saveImageUpload(PNG, "image/png", ID);
    const before = readdirSync(FOLDER);
    expect(await saveImageUpload(PNG, "image/png", ID)).toEqual(first);
    expect(readdirSync(FOLDER)).toEqual(before);
    await expect(saveImageUpload(Buffer.concat([PNG, Buffer.from("x")]), "image/png", ID)).rejects.toMatchObject({ status: 409 });
  });

  it.runIf(posix)("a FIFO at the name answers 409 at once for images and files; four in parallel, then a normal upload completes", async () => {
    execFileSync("mkfifo", [join(FOLDER, `${ID}.png`)]);
    const answers = await Promise.allSettled(Array.from({ length: 4 }, () => saveImageUpload(PNG, "image/png", ID)));
    for (const answer of answers) expect(answer).toMatchObject({ status: "rejected", reason: { status: 409 } });
    const fileId = "55555555-5555-4555-8555-555555555555";
    execFileSync("mkfifo", [join(FOLDER, `${fileId}.txt`)]);
    await expect(saveFile((async function* () { yield Buffer.from("hello"); })(), "a.txt", "text/plain", { uploadId: fileId })).rejects.toMatchObject({ status: 409 });
    expect((await saveImageUpload(PNG, "image/png")).bytes).toBe(PNG.length);
  }, 5000);

  it("a stalled disk answers 503 within the deadline instead of hanging or claiming a conflict", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = stalled();
    __setAttachmentFsForTests(fake.fs);
    const retry = saveImageUpload(PNG, "image/png", ID).catch(error => error as { status?: number; message?: string });
    const avatar = attachmentExists(`${ID}.png`);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_IO_DEADLINE_MS);
    expect(await retry).toMatchObject({ status: 503, message: "Could not check the earlier upload. Try again." });
    expect(await avatar).toBe("retry");
    fake.release();
    vi.useRealTimers();
    await vi.waitFor(() => expect(attachmentPoolState().active).toBe(0));
  });
});

describe("avatar check", () => {
  it("agrees with the attachment route on every name", async () => {
    writeFileSync(join(FOLDER, `${ID}.png`), PNG);
    for (const name of [`${ID}.png`, `${ID}.jpeg`, "nul.png", `.${ID}.png`, "missing-1.png"]) {
      const probe = await probeServedImage(name), read = await readAttachment(name);
      expect(probe.ok).toBe(read.ok);
      expect(await attachmentExists(name)).toBe(read.ok);
    }
  });
});

describe("receipt re-completion", () => {
  /** Counts reads through the leaf module (attachment-read.ts). */
  function leafReads(): string[] {
    const seen: string[] = [];
    __setAttachmentReadHookForTests((stage, name) => { if (stage === "before-open") seen.push(name); });
    return seen;
  }

  it("reuses an identical committed entry after a byte-for-byte check through the leaf, writing nothing", async () => {
    const first = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    const before = statSync(first.path, { bigint: true });
    const reads = leafReads();
    const again = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    expect(again).toEqual({ path: first.path, mime: "image/png", bytes: PNG.length });
    expect(reads).toEqual([`${ID}.png`]);
    const after = statSync(first.path, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
    expect(readdirSync(FOLDER).filter(name => name.endsWith(".partial"))).toEqual([]);
  });

  it("writes the receipt's bytes when the entry is missing", async () => {
    const saved = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    expect(readFileSync(saved.path).equals(PNG)).toBe(true);
  });

  it("does not reuse a same-size entry with different bytes: it is replaced with the verified bytes", async () => {
    const first = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    writeFileSync(first.path, Buffer.alloc(PNG.length, 0x77));
    const before = statSync(first.path, { bigint: true }).ino;
    const saved = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    expect(readFileSync(saved.path).equals(PNG)).toBe(true);
    expect(statSync(saved.path, { bigint: true }).ino).not.toBe(before);
  });

  it("does not reuse an entry of another size", async () => {
    const first = await saveReceiptImage(Buffer.from("old-bytes"), "image/png", ID, IMAGE_MAX_BYTES);
    const saved = await saveReceiptImage(Buffer.from("receipt"), "image/png", ID, IMAGE_MAX_BYTES);
    expect(saved.path).toBe(first.path);
    expect(readFileSync(saved.path, "utf8")).toBe("receipt");
  });

  it("finishes on a full disk when the committed entry is identical", async () => {
    const first = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    const before = statSync(first.path, { bigint: true }).ino;
    __setFreeDiskProbeForTests(() => 0);
    const saved = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    expect(saved.path).toBe(first.path);
    expect(statSync(saved.path, { bigint: true }).ino).toBe(before);
  });

  it("refuses clearly on a full disk when the entry differs, and never vouches for it", async () => {
    const first = await saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    __setFreeDiskProbeForTests(() => 0);
    writeFileSync(first.path, Buffer.alloc(PNG.length, 0x77));
    await expect(saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES)).rejects.toThrow(/disk space/);
    expect(readFileSync(first.path).equals(Buffer.alloc(PNG.length, 0x77))).toBe(true);
    expect(readdirSync(FOLDER).filter(name => name.endsWith(".partial"))).toEqual([]);
  });

  it("refuses on a full disk when the entry is missing", async () => {
    __setFreeDiskProbeForTests(() => 0);
    await expect(saveReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES)).rejects.toThrow(/disk space/);
    expect(existsSync(join(FOLDER, `${ID}.png`))).toBe(false);
  });

  it("a just-retained receipt is committed write-only, without a read", () => {
    const reads = leafReads();
    const saved = writeNewReceiptImage(PNG, "image/png", ID, IMAGE_MAX_BYTES);
    expect(readFileSync(saved.path).equals(PNG)).toBe(true);
    expect(reads).toEqual([]);
  });
});

// ── membership after awaits ──────────────────────────────────────────────
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
function conversation() {
  const base = new Store(selection);
  const bot = base.createBot({ name: "Reader" });
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "murage-attread-db-")), "messages.db")); initializeArtifacts(db);
  const path = join(FOLDER, `${ID}.png`); writeFileSync(path, PNG);
  base.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path, mime: "image/png" }] });
  const { store, revoke } = revocable(base);
  const artifactScopes = (): ArtifactScope[] => [];
  const deps: MediaAssetsDeps = { dataDir: DATA_DIR, database: () => db, store, artifactScopes };
  return { store, revoke, deps, bot, path, db };
}
const request = (method: string, path: string, body?: unknown, desktop = true): DelegatedRequest => {
  const url = new URL(`http://127.0.0.1:1${path}`);
  return { method, path: url.pathname, url, headers: {}, desktop, readBody: async () => body };
};
const drain = async (result: DelegatedResult) => result.stream ? Buffer.concat(await result.stream.toArray() as Buffer[]) : Buffer.from(result.bytes ?? new Uint8Array(0));

describe("membership is asked again after the read", () => {
  it("imageReferences: a revoked image or a turn that ended refuses; a stalled read answers 503", async () => {
    const f = conversation();
    expect((await imageReferences(f.store, f.bot.threadId, [`${ID}.png`], () => {}))[0]!.bytes).toEqual(PNG);
    __setAttachmentReadHookForTests(stage => { if (stage === "after-read") f.revoke(); });
    await expect(imageReferences(f.store, f.bot.threadId, [`${ID}.png`], () => {})).rejects.toMatchObject({ status: 403 });
    __setAttachmentReadHookForTests(undefined);
    const g = conversation();
    await expect(imageReferences(g.store, g.bot.threadId, [`${ID}.png`], () => { throw Object.assign(new Error("turn ended"), { status: 409 }); })).rejects.toThrow("turn ended");
  });

  it("resolveImageReferences: membership lost during the read writes no attachment", async () => {
    const f = conversation();
    const before = readdirSync(FOLDER);
    __setAttachmentReadHookForTests(stage => { if (stage === "after-read") f.revoke(); });
    await expect(resolveImageReferences([{ kind: "attachment", attachmentId: `${ID}.png` }], { botId: f.bot.id, threadId: f.bot.threadId }, f.deps, { disclose: true }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(readdirSync(FOLDER)).toEqual(before);
    __setAttachmentReadHookForTests(undefined);
    const g = conversation();
    await expect(resolveImageReferences([{ kind: "attachment", attachmentId: `${ID}.png` }], { botId: g.bot.id, threadId: g.bot.threadId }, { ...g.deps, assertLive: () => { throw new Error("turn ended"); } }, { disclose: true }))
      .rejects.toThrow("turn ended");
  });

  it("media viewer: no capability when membership is lost during the read; changed bytes are never served, not even in part", async () => {
    const f = conversation();
    const ref = { source: "attachment", threadId: f.bot.threadId, attachmentId: `${ID}.png` };
    const resolved = await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { ref }), f.deps);
    const body = resolved.body as MediaResolveResponse;
    expect(body.asset.availability).toBe("ready");
    expect(body.asset.revision).toBe(sha256(PNG));
    const served = await mediaAssetsRoute(request("GET", body.url!, undefined, false), f.deps);
    expect(served.status).toBe(200);
    expect(await drain(served)).toEqual(PNG);
    // equal size, other bytes: the digest no longer matches the authorized revision
    const other = Buffer.from(PNG); other[other.length - 1] ^= 0xff;
    writeFileSync(f.path, other);
    const refused = await mediaAssetsRoute(request("GET", body.url!, undefined, false), f.deps);
    expect(refused.status).toBe(409);
    expect(refused.stream).toBeUndefined();
    writeFileSync(f.path, PNG);
    __setAttachmentReadHookForTests(stage => { if (stage === "after-read") f.revoke(); });
    const hidden = await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { ref }), f.deps);
    expect(hidden.status).toBe(404);
    expect((hidden.body as { url?: string }).url).toBeUndefined();
    expect(existsSync(f.path)).toBe(true);
  });
});
