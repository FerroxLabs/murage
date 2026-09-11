// F5-T1 (media design M1): scoped MediaAsset resolver and the authorized byte
// route. Every type below comes from validated bytes, never from a suffix.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { initializeArtifacts, registerArtifact, type ArtifactScope } from "./artifacts.ts";
import {
  MEDIA_ASSET_ID_PATTERN, MEDIA_IMAGE_MAX_PIXELS, MEDIA_MAX_ACTIVE_STREAMS, MEDIA_SERVER_ID, MEDIA_SNIFF_BYTES, MEDIA_STREAM_CHUNK_BYTES,
  __resetMediaAssetsForTests, issueMediaCapability, mediaActiveStreamCount, mediaAssetsRoute, mediaWorkspaceRevision, parseByteRange,
  resolveImageReferenceRoute, sniffMedia, verifyMediaCapability, type MediaAssetsDeps,
} from "./media-assets.ts";
import { sendDelegated, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
import { Store } from "./store.ts";
import { COMPANION_HEADER } from "./sse-visibility.ts";
import {
  MEDIA_BYTES_RESPONSE_HEADERS, MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_CAPABILITY_TTL_MS, MEDIA_ROUTES, isMediaCapabilityToken, redactMediaCapability,
  type MediaAsset, type MediaResolveResponse,
} from "../shared/media-assets.ts";

// ── byte fixtures ──────────────────────────────────────────────────────────
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const le16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const le32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const png = (width = 3, height = 2, tail = 64) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0]), u32(0),
  Buffer.alloc(tail, 0x11), Buffer.from("IEND"),
]);
const jpeg = (width = 5, height = 4) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1]), u16(2 + 6), Buffer.from("Exif\0\0"),
  Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(height), u16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  Buffer.from([0xff, 0xda]), u16(8), Buffer.from([1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(40, 0x5a), Buffer.from([0xff, 0xd9]),
]);
const gif = (width = 7, height = 9) => Buffer.concat([Buffer.from("GIF89a"), le16(width), le16(height), Buffer.from([0, 0, 0]), Buffer.alloc(32, 0x21), Buffer.from([0x3b])]);
const webp = (width = 11, height = 13) => {
  const bits = (width - 1) | ((height - 1) << 14);
  const payload = Buffer.concat([Buffer.from([0x2f]), le32(bits), Buffer.alloc(40, 0x7f)]);
  const body = Buffer.concat([Buffer.from("WEBP"), Buffer.from("VP8L"), le32(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), le32(body.length), body]);
};
const wav = (seconds = 1) => {
  const data = Buffer.alloc(seconds * 8000, 0x40);
  const body = Buffer.concat([Buffer.from("WAVE"), Buffer.from("fmt "), le32(16), le16(1), le16(1), le32(8000), le32(8000), le16(1), le16(8), Buffer.from("data"), le32(data.length), data]);
  return Buffer.concat([Buffer.from("RIFF"), le32(body.length), body]);
};
const mp3 = () => Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10), Buffer.alloc(2000, 0x33)]);
const mp3Frames = () => {
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, no padding: 417-byte frames.
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat([header, Buffer.alloc(413, 0x22), header, Buffer.alloc(413, 0x22), header, Buffer.alloc(413, 0x22)]);
};
const ftyp = (major: string, ...compatible: string[]) => {
  const brands = Buffer.concat(compatible.map(brand => Buffer.from(brand.padEnd(4), "latin1")));
  const box = Buffer.concat([u32(16 + brands.length), Buffer.from("ftyp"), Buffer.from(major.padEnd(4), "latin1"), u32(0x200), brands]);
  return Buffer.concat([box, u32(8 + 64), Buffer.from("mdat"), Buffer.alloc(64, 0x44)]);
};
const mp4 = () => ftyp("isom", "isom", "mp41");
const m4a = () => ftyp("M4A ", "M4A ", "mp42", "isom");
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(200, 0x99)]);
const mkv = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88]), Buffer.from("matroska"), Buffer.alloc(200, 0x99)]);
const svg = () => Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
const exe = () => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ── unit: sniffing ─────────────────────────────────────────────────────────
describe("sniffMedia", () => {
  it("identifies previewable images from their bytes with dimensions", () => {
    expect(sniffMedia(png(640, 480), png(640, 480).length)).toEqual({ kind: "image", mime: "image/png", supported: true, width: 640, height: 480 });
    expect(sniffMedia(jpeg(1920, 1080), 5000)).toEqual({ kind: "image", mime: "image/jpeg", supported: true, width: 1920, height: 1080 });
    expect(sniffMedia(gif(7, 9), 100)).toEqual({ kind: "image", mime: "image/gif", supported: true, width: 7, height: 9 });
    expect(sniffMedia(webp(11, 13), 100)).toEqual({ kind: "image", mime: "image/webp", supported: true, width: 11, height: 13 });
  });
  it("identifies the U-28 playback set and reports other containers truthfully", () => {
    expect(sniffMedia(wav(), wav().length)).toMatchObject({ kind: "audio", mime: "audio/wav", supported: true });
    expect(sniffMedia(mp3(), mp3().length)).toMatchObject({ kind: "audio", mime: "audio/mpeg", supported: true });
    expect(sniffMedia(mp3Frames(), mp3Frames().length)).toMatchObject({ kind: "audio", mime: "audio/mpeg", supported: true });
    expect(sniffMedia(mp4(), mp4().length)).toMatchObject({ kind: "video", mime: "video/mp4", supported: true });
    expect(sniffMedia(m4a(), m4a().length)).toMatchObject({ kind: "audio", mime: "audio/mp4", supported: true });
    expect(sniffMedia(webm(), webm().length)).toMatchObject({ kind: "video", mime: "video/webm", supported: true });
    expect(sniffMedia(mkv(), mkv().length)).toMatchObject({ kind: "video", mime: "video/x-matroska", supported: false });
    expect(sniffMedia(ftyp("qt  ", "qt  "), 200)).toMatchObject({ kind: "video", mime: "video/quicktime", supported: false });
    expect(sniffMedia(Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(64)]), 68)).toMatchObject({ kind: "audio", mime: "audio/flac", supported: false });
  });
  it("never trusts a suffix: active, executable, damaged and oversized content is unsupported", () => {
    expect(sniffMedia(svg(), svg().length)).toMatchObject({ kind: "file", mime: "image/svg+xml", supported: false });
    expect(sniffMedia(exe(), exe().length)).toMatchObject({ kind: "file", mime: "application/octet-stream", supported: false });
    expect(sniffMedia(png().subarray(0, 12), 12)).toMatchObject({ kind: "file", supported: false });
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 4)).toMatchObject({ kind: "file", supported: false });
    expect(sniffMedia(png(20_000, 20_000), 100)).toMatchObject({ kind: "image", mime: "image/png", supported: false, width: 20_000, height: 20_000 });
    expect(20_000 * 20_000).toBeGreaterThan(MEDIA_IMAGE_MAX_PIXELS);
    expect(sniffMedia(png(), 30 * 1024 * 1024)).toMatchObject({ kind: "image", supported: false });
    expect(sniffMedia(Buffer.alloc(0), 0)).toMatchObject({ kind: "file", supported: false });
    expect(sniffMedia(Buffer.from("plain text"), 10)).toMatchObject({ kind: "file", mime: "application/octet-stream", supported: false });
    expect(sniffMedia(Buffer.concat([Buffer.from("RIFF"), le32(999_999), Buffer.from("WAVEfmt ")]), 100)).toMatchObject({ supported: false });
  });
});

// ── unit: ranges ───────────────────────────────────────────────────────────
describe("parseByteRange", () => {
  it("accepts exactly one bytes range and refuses everything else", () => {
    expect(parseByteRange(undefined, 100)).toBe("full");
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    // RFC 9110: the unit is case-insensitive and whitespace may surround "=".
    expect(parseByteRange("Bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("BYTES = -10", 100)).toEqual({ start: 90, end: 99 });
    for (const bad of ["bytes=100-", "bytes=5-4", "bytes=-0", "bytes=0-1,5-6", "bytes=-", "items=0-1", "bytes=a-b", "bytes=0-1;x", "0-1", "bytes=0 - 1", "bits=0-1"]) expect(parseByteRange(bad, 100), bad).toBe("unsatisfiable");
    expect(parseByteRange(["bytes=0-1", "bytes=2-3"], 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

// ── unit: capability ───────────────────────────────────────────────────────
describe("media capability", () => {
  it("issues a 10 minute token bound to asset, revision and the desktop surface", () => {
    const now = 1_700_000_000_000, { token, expiresAt } = issueMediaCapability("ma1_" + "a".repeat(32), "r1.rev", now);
    expect(isMediaCapabilityToken(token)).toBe(true);
    expect(expiresAt).toBe(now + MEDIA_CAPABILITY_TTL_MS);
    expect(verifyMediaCapability(token, "ma1_" + "a".repeat(32), now + 1)).toEqual({ ok: true, claims: { v: 1, assetId: "ma1_" + "a".repeat(32), revision: "r1.rev", surface: "desktop", exp: expiresAt } });
    expect(verifyMediaCapability(token, "ma1_" + "a".repeat(32), expiresAt)).toEqual({ ok: false, reason: "expired" });
    expect(verifyMediaCapability(token, "ma1_" + "b".repeat(32), now)).toEqual({ ok: false, reason: "invalid" });
    const [head, body, signature] = token.split(".");
    const flipped = signature![0] === "A" ? "B" : "A";
    expect(verifyMediaCapability(`${head}.${body}.${flipped}${signature!.slice(1)}`, "ma1_" + "a".repeat(32), now)).toEqual({ ok: false, reason: "invalid" });
    const forgedClaims = Buffer.from(JSON.stringify({ v: 1, assetId: "ma1_" + "a".repeat(32), revision: "r1.rev", surface: "remote", exp: expiresAt })).toString("base64url");
    expect(verifyMediaCapability(`${head}.${forgedClaims}.${signature}`, "ma1_" + "a".repeat(32), now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyMediaCapability(undefined, "x", now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyMediaCapability("mc1.x.y", "x", now)).toEqual({ ok: false, reason: "invalid" });
    expect(redactMediaCapability(`${MEDIA_ROUTES.bytes}/ma1_x?cap=${token}&surface=desktop`)).toBe(`${MEDIA_ROUTES.bytes}/ma1_x?cap=[redacted]&surface=desktop`);
  });
});

// ── route fixture ──────────────────────────────────────────────────────────
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
interface Fixture {
  deps: MediaAssetsDeps; store: Store; db: DatabaseSync; attachments: string; workspaces: string; storage: string;
  botId: string; threadId: string; otherBotId: string; otherThreadId: string;
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch {} } __resetMediaAssetsForTests(); });
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); __resetMediaAssetsForTests(); });

function fixture(): Fixture {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Media bot" }), other = store.createBot({ name: "Other bot" });
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "murage-media-db-")), "messages.db")); cleanups.push(() => db.close()); initializeArtifacts(db);
  const attachments = join(DATA_DIR, "attachments"), workspaces = join(DATA_DIR, "workspaces"), storage = join(DATA_DIR, "artifact-files");
  mkdirSync(attachments, { recursive: true }); mkdirSync(join(workspaces, bot.id), { recursive: true }); mkdirSync(join(workspaces, other.id), { recursive: true });
  const artifactScopes = (): ArtifactScope[] => store.bots.map(item => ({ botId: item.id, botName: item.name, threadId: item.threadId, workspaceRoot: join(workspaces, item.id) }));
  return { deps: { dataDir: DATA_DIR, database: () => db, store, artifactScopes }, store, db, attachments, workspaces, storage, botId: bot.id, threadId: bot.threadId, otherBotId: other.id, otherThreadId: other.threadId };
}
function attach(f: Fixture, threadId: string, name: string, bytes: Buffer): string {
  const path = join(f.attachments, name); writeFileSync(path, bytes);
  f.store.appendMessage(threadId, { role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path, mime: "image/png" }] });
  return path;
}
function request(method: string, path: string, options: { desktop?: boolean; body?: unknown; headers?: Record<string, string>; query?: string } = {}): DelegatedRequest {
  const url = new URL(`http://127.0.0.1:1${path}${options.query ?? ""}`);
  return { method, path, url, headers: options.headers ?? {}, desktop: options.desktop ?? true, readBody: async () => options.body };
}
const resolve = (f: Fixture, ref: unknown, desktop = true) => mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { desktop, body: { ref } }), f.deps);
const bytesPath = (url: string) => new URL(`http://127.0.0.1:1${url}`);
async function fetchBytes(f: Fixture, url: string, options: { method?: string; headers?: Record<string, string>; desktop?: boolean } = {}): Promise<DelegatedResult> {
  const parsed = bytesPath(url);
  return mediaAssetsRoute({ method: options.method ?? "GET", path: parsed.pathname, url: parsed, headers: options.headers ?? {}, desktop: options.desktop ?? false, readBody: async () => undefined }, f.deps);
}
async function drain(result: DelegatedResult): Promise<Buffer> {
  if (result.stream) return Buffer.concat(await result.stream.toArray() as Buffer[]);
  return Buffer.from(result.bytes ?? new Uint8Array(0));
}
/** Status of a response whose body is not read; the stream is released the way sendDelegated would on client close. */
const status = (result: DelegatedResult) => { result.stream?.destroy(); return result.status; };
const ready = (result: DelegatedResult) => { expect(result.status).toBe(200); const body = result.body as MediaResolveResponse; expect(body.asset.availability).toBe("ready"); expect(body.url).toBeDefined(); return body as MediaResolveResponse & { url: string }; };

// ── route: authority ───────────────────────────────────────────────────────
describe("mediaAssetsRoute authority", () => {
  it("hides resolve from non-desktop and companion callers and answers nothing else under the prefix", async () => {
    const f = fixture();
    expect((await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "x.png" }, false)).status).toBe(404);
    expect((await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { headers: { [COMPANION_HEADER]: "1" }, body: {} }), f.deps)).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", MEDIA_ROUTES.resolve), f.deps)).status).toBe(405);
    expect((await mediaAssetsRoute(request("GET", "/api/media"), f.deps)).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", "/api/media/other"), f.deps)).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", "/api/mediax"), f.deps)).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", `${MEDIA_ROUTES.bytes}/../x`), f.deps)).status).toBe(404);
    expect((await mediaAssetsRoute(request("GET", `${MEDIA_ROUTES.bytes}/not-an-id`), f.deps)).status).toBe(404);
  });
  it("refuses every reference that carries a path, root or URL authority", async () => {
    const f = fixture();
    for (const ref of [
      undefined, null, "x", { source: "workspace", scope: { botId: f.botId, threadId: f.threadId }, relativePath: "/etc/passwd", revision: "r1.aaaaaaaa" },
      { source: "workspace", scope: { botId: f.botId, threadId: f.threadId }, relativePath: "../secret.png", revision: "r1.aaaaaaaa" },
      { source: "workspace", scope: { botId: f.botId, threadId: f.threadId }, relativePath: "a.png", revision: "r1.aaaaaaaa", root: "/tmp" },
      { source: "workspace", scope: { botId: f.botId, threadId: f.threadId }, relativePath: "a.png" },
      { source: "attachment", threadId: f.threadId, attachmentId: "../config.json" },
      { source: "attachment", threadId: f.threadId, attachmentId: "a.svg" },
      { source: "attachment", threadId: f.threadId, attachmentId: "a.png", path: "/x" },
      { source: "artifact", artifactId: "not-a-uuid" },
      { source: "external-link", url: "https://example.com/a.png" },
      { source: "screen-frame", messageId: "m" },
    ]) {
      const result = await resolve(f, ref);
      expect(result.status, JSON.stringify(ref)).toBe(400);
      expect(result.body).toMatchObject({ code: "invalid-request" });
    }
    expect((await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { body: { ref: { source: "artifact", artifactId: "0f2a1c3e-1111-4222-8333-944455566677" }, extra: 1 } }), f.deps)).status).toBe(400);
    expect((await mediaAssetsRoute({ ...request("POST", MEDIA_ROUTES.resolve), readBody: async () => { throw new Error("invalid JSON body"); } }, f.deps)).status).toBe(400);
    // The bounded body reader's 413 keeps its meaning instead of becoming a generic 400.
    const oversized = await mediaAssetsRoute({ ...request("POST", MEDIA_ROUTES.resolve), readBody: async () => { throw Object.assign(new Error("body too large"), { status: 413 }); } }, f.deps);
    expect(oversized.status).toBe(413); expect(oversized.body).toMatchObject({ code: "too-large" });
  });
  it("keeps resolve-image-reference as the K0 skeleton until F5-T4", async () => {
    const f = fixture();
    expect((await resolveImageReferenceRoute(request("GET", "/api/internal/resolve-image-reference"), { botId: "b", threadId: "t", generation: "g" }, f.deps)).status).toBe(405);
    expect((await resolveImageReferenceRoute(request("POST", "/api/internal/resolve-image-reference", { body: {} }), { botId: "b", threadId: "t", generation: "g" }, f.deps)).status).toBe(501);
  });
});

// ── route: attachments ─────────────────────────────────────────────────────
describe("attachment assets", () => {
  it("resolves a conversation's image to a pinned descriptor and a capability URL", async () => {
    const f = fixture(), image = png(640, 480);
    attach(f, f.threadId, "11111111-1111-4111-8111-111111111111.png", image);
    const first = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "11111111-1111-4111-8111-111111111111.png" }));
    const message = f.store.messagesFor(f.threadId).at(-1)!;
    const asset: MediaAsset = first.asset;
    expect(asset).toEqual({
      id: expect.stringMatching(MEDIA_ASSET_ID_PATTERN), scope: { serverId: MEDIA_SERVER_ID, botId: f.botId, threadId: f.threadId, messageId: message.id },
      source: "attachment", kind: "image", name: "11111111-1111-4111-8111-111111111111.png", mime: "image/png", bytes: image.length, revision: sha256(image),
      width: 640, height: 480, availability: "ready", capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: true },
    });
    expect(first.url.startsWith(`${MEDIA_ROUTES.bytes}/${asset.id}?${MEDIA_CAPABILITY_QUERY_PARAM}=mc1.`)).toBe(true);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(first.expiresAt! - Date.now()).toBeLessThanOrEqual(MEDIA_CAPABILITY_TTL_MS);
    expect(redactMediaCapability(first.url)).toBe(`${MEDIA_ROUTES.bytes}/${asset.id}?${MEDIA_CAPABILITY_QUERY_PARAM}=[redacted]`);
    expect(JSON.stringify(asset)).not.toContain(DATA_DIR);
    // Resolving again keeps the identity and issues a fresh capability.
    const again = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "11111111-1111-4111-8111-111111111111.png" }));
    expect(again.asset.id).toBe(asset.id); expect(again.asset.revision).toBe(asset.revision); expect(again.url).not.toBe(first.url);
  });
  it("serves the exact bytes with GET, HEAD and one satisfiable range", async () => {
    const f = fixture(), image = png(8, 8, MEDIA_STREAM_CHUNK_BYTES * 2 + 1234);
    attach(f, f.threadId, "22222222-2222-4222-8222-222222222222.png", image);
    const { url, asset } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "22222222-2222-4222-8222-222222222222.png" }));
    const full = await fetchBytes(f, url);
    expect(full.status).toBe(200);
    expect(full.headers).toMatchObject({ ...MEDIA_BYTES_RESPONSE_HEADERS, "content-type": "image/png", "accept-ranges": "bytes", "content-length": String(image.length), etag: `"${asset.revision}"` });
    expect(full.headers!["content-disposition"]).toMatch(/^inline; filename\*=UTF-8''/);
    expect(full.headers!["content-range"]).toBeUndefined();
    expect(full.stream).toBeDefined();
    expect((await drain(full)).equals(image)).toBe(true);
    expect(mediaActiveStreamCount()).toBe(0);
    const head = await fetchBytes(f, url, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.stream).toBeUndefined(); expect(head.bytes?.length).toBe(0);
    expect(head.headers).toMatchObject({ "content-length": String(image.length), "accept-ranges": "bytes" });
    const middle = await fetchBytes(f, url, { headers: { range: `bytes=${MEDIA_STREAM_CHUNK_BYTES - 5}-${MEDIA_STREAM_CHUNK_BYTES + 10}` } });
    expect(middle.status).toBe(206);
    expect(middle.headers).toMatchObject({ "content-range": `bytes ${MEDIA_STREAM_CHUNK_BYTES - 5}-${MEDIA_STREAM_CHUNK_BYTES + 10}/${image.length}`, "content-length": "16" });
    expect((await drain(middle)).equals(image.subarray(MEDIA_STREAM_CHUNK_BYTES - 5, MEDIA_STREAM_CHUNK_BYTES + 11))).toBe(true);
    const tail = await fetchBytes(f, url, { headers: { range: "bytes=-100" } });
    expect(tail.status).toBe(206); expect((await drain(tail)).equals(image.subarray(image.length - 100))).toBe(true);
    const open = await fetchBytes(f, url, { headers: { range: `bytes=${image.length - 3}-` } });
    expect(open.status).toBe(206); expect(open.headers!["content-range"]).toBe(`bytes ${image.length - 3}-${image.length - 1}/${image.length}`);
    expect((await drain(open)).equals(image.subarray(image.length - 3))).toBe(true);
    const headRange = await fetchBytes(f, url, { method: "HEAD", headers: { range: "bytes=0-9" } });
    expect(headRange.status).toBe(206); expect(headRange.headers).toMatchObject({ "content-length": "10", "content-range": `bytes 0-9/${image.length}` });
    // A stale validator falls back to the full representation instead of mixing revisions.
    const stale = await fetchBytes(f, url, { headers: { range: "bytes=0-9", "if-range": '"other"' } });
    expect(stale.status).toBe(200); expect((await drain(stale)).length).toBe(image.length);
    const matching = await fetchBytes(f, url, { headers: { range: "bytes=0-9", "if-range": `"${asset.revision}"` } });
    expect(matching.status).toBe(206); expect((await drain(matching)).equals(image.subarray(0, 10))).toBe(true);
  });
  it("answers 416 for multipart, malformed and unsatisfiable ranges", async () => {
    const f = fixture(), image = png();
    attach(f, f.threadId, "33333333-3333-4333-8333-333333333333.png", image);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "33333333-3333-4333-8333-333333333333.png" }));
    for (const range of ["bytes=0-1,4-5", `bytes=${image.length}-`, "bytes=5-2", "bytes=-0", "items=0-1", "bytes=x"]) {
      const result = await fetchBytes(f, url, { headers: { range } });
      expect(result.status, range).toBe(416);
      expect(result.headers).toMatchObject({ "content-range": `bytes */${image.length}`, "accept-ranges": "bytes" });
      expect(result.stream).toBeUndefined();
    }
    // Only a capability holder learns the method rule; without one the route stays hidden.
    const post = await fetchBytes(f, url, { method: "POST" });
    expect(post.status).toBe(405); expect(post.headers).toMatchObject({ allow: "GET, HEAD" });
    expect((await fetchBytes(f, bytesPath(url).pathname, { method: "POST" })).status).toBe(404);
    expect((await fetchBytes(f, `${bytesPath(url).pathname}?cap=mc1.${"A".repeat(20)}.${"B".repeat(43)}`, { method: "POST" })).status).toBe(404);
  });
  it("requires a valid, unexpired capability for exactly this asset and never serves the companion", async () => {
    const f = fixture();
    attach(f, f.threadId, "44444444-4444-4444-8444-444444444444.png", png());
    attach(f, f.threadId, "55555555-5555-4555-8555-555555555555.png", gif());
    const a = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "44444444-4444-4444-8444-444444444444.png" }));
    const b = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "55555555-5555-4555-8555-555555555555.png" }));
    expect(b.asset.mime).toBe("image/gif");
    const capOf = (url: string) => bytesPath(url).searchParams.get(MEDIA_CAPABILITY_QUERY_PARAM)!;
    expect((await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}`)).status).toBe(404);
    expect((await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}?cap=${capOf(b.url)}`)).status).toBe(404);
    expect((await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}?cap=${capOf(a.url)}&cap=${capOf(a.url)}`)).status).toBe(404);
    expect((await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}?cap=${capOf(a.url).slice(0, -2)}AA`)).status).toBe(404);
    expect((await fetchBytes(f, a.url, { headers: { [COMPANION_HEADER]: "1" } })).status).toBe(404);
    expect((await fetchBytes(f, a.url, { headers: { [COMPANION_HEADER]: "1, 1" } })).status).toBe(404);
    // Desktop proof is neither needed nor sufficient: only the capability authorizes bytes.
    expect((await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}`, { desktop: true })).status).toBe(404);
    expect(status(await fetchBytes(f, a.url, { desktop: true }))).toBe(200);
    const expired = issueMediaCapability(a.asset.id, a.asset.revision!, Date.now() - MEDIA_CAPABILITY_TTL_MS - 1);
    const late = await fetchBytes(f, `${MEDIA_ROUTES.bytes}/${a.asset.id}?cap=${expired.token}`);
    expect(late.status).toBe(403); expect(late.body).toMatchObject({ code: "capability-expired" });
    // A restart forgets every asset: a syntactically valid token alone is not authority.
    __resetMediaAssetsForTests();
    expect((await fetchBytes(f, a.url)).status).toBe(404);
  });
  it("denies cross-conversation access, unreferenced files, and pretend images", async () => {
    const f = fixture();
    attach(f, f.threadId, "66666666-6666-4666-8666-666666666666.png", png());
    writeFileSync(join(f.attachments, "77777777-7777-4777-8777-777777777777.png"), png());
    writeFileSync(join(f.attachments, "88888888-8888-4888-8888-888888888888.png"), exe());
    f.store.appendMessage(f.threadId, { role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path: join(f.attachments, "88888888-8888-4888-8888-888888888888.png"), mime: "image/png" }] });
    const other = await resolve(f, { source: "attachment", threadId: f.otherThreadId, attachmentId: "66666666-6666-4666-8666-666666666666.png" });
    expect(other.status).toBe(404); expect(other.body).toMatchObject({ code: "unavailable" });
    expect((await resolve(f, { source: "attachment", threadId: "no-such-thread", attachmentId: "66666666-6666-4666-8666-666666666666.png" })).status).toBe(404);
    expect((await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "77777777-7777-4777-8777-777777777777.png" })).status).toBe(404);
    expect(existsSync(join(DATA_DIR, "messages-no-such-thread.json"))).toBe(false);
    const fake = await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "88888888-8888-4888-8888-888888888888.png" });
    expect(fake.status).toBe(200);
    const body = fake.body as MediaResolveResponse;
    expect(body.asset).toMatchObject({ availability: "unsupported", kind: "file", mime: "application/octet-stream", capabilities: { preview: false, download: false, imageReference: false } });
    expect(body.url).toBeUndefined();
    // An SVG named .png is active content, not an image asset.
    attach(f, f.threadId, "99999999-9999-4999-8999-999999999999.png", svg());
    const active = (await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "99999999-9999-4999-8999-999999999999.png" })).body as MediaResolveResponse;
    expect(active.asset).toMatchObject({ availability: "unsupported", mime: "image/svg+xml" }); expect(active.url).toBeUndefined();
  });
  it("answers changed or missing instead of splicing revisions when the file moves under a capability", async () => {
    const f = fixture(), image = png(4, 4, 4096);
    const path = attach(f, f.threadId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png", image);
    const first = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" }));
    const replacement = png(4, 4, 8192);
    writeFileSync(path, replacement); utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const changed = await fetchBytes(f, first.url);
    expect(changed.status).toBe(409); expect(changed.body).toMatchObject({ code: "changed" }); expect(changed.stream).toBeUndefined();
    const second = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" }));
    expect(second.asset.id).toBe(first.asset.id); expect(second.asset.revision).toBe(sha256(replacement)); expect(second.asset.revision).not.toBe(first.asset.revision);
    expect((await fetchBytes(f, first.url)).status).toBe(409);
    expect((await drain(await fetchBytes(f, second.url))).equals(replacement)).toBe(true);
    unlinkSync(path);
    const missing = await fetchBytes(f, second.url);
    expect(missing.status).toBe(410); expect(missing.body).toMatchObject({ code: "missing" });
    expect((await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" })).body).toMatchObject({ asset: { availability: "missing" } });
    // A symlink placed at the attachment path is never followed.
    symlinkSync(join(f.attachments, "..", "bots.json"), path);
    expect((await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" })).body).toMatchObject({ asset: { availability: "denied" } });
  });
  it("caps simultaneous streams and releases the count when a client goes away", async () => {
    const f = fixture(), image = png(2, 2, MEDIA_STREAM_CHUNK_BYTES * 3);
    attach(f, f.threadId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png", image);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png" }));
    const open: DelegatedResult[] = [];
    for (let index = 0; index < MEDIA_MAX_ACTIVE_STREAMS; index++) { const result = await fetchBytes(f, url); expect(result.status).toBe(200); open.push(result); }
    expect(mediaActiveStreamCount()).toBe(MEDIA_MAX_ACTIVE_STREAMS);
    const busy = await fetchBytes(f, url);
    expect(busy.status).toBe(503); expect(busy.body).toMatchObject({ code: "busy" }); expect(busy.headers).toMatchObject({ "retry-after": "1" });
    expect((await fetchBytes(f, url, { method: "HEAD" })).status).toBe(200);
    open[0]!.stream!.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mediaActiveStreamCount()).toBe(MEDIA_MAX_ACTIVE_STREAMS - 1);
    expect((await drain(await fetchBytes(f, url, { headers: { range: "bytes=0-3" } }))).length).toBe(4);
    for (const result of open.slice(1)) result.stream!.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mediaActiveStreamCount()).toBe(0);
  });
  it("destroys a stream whose file changes mid-flight instead of completing with mixed bytes", async () => {
    const f = fixture(), image = png(2, 2, MEDIA_STREAM_CHUNK_BYTES * 4);
    const path = attach(f, f.threadId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png", image);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png" }));
    const result = await fetchBytes(f, url);
    expect(result.status).toBe(200);
    const stream = result.stream!, chunks: Buffer[] = [];
    const first = await new Promise<Buffer>(resolve => stream.once("data", chunk => resolve(chunk as Buffer)));
    chunks.push(first);
    stream.pause();
    writeFileSync(path, png(2, 2, MEDIA_STREAM_CHUNK_BYTES * 4).fill(0x77, 100)); utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const outcome = await new Promise<"error" | "end">(resolve => { stream.on("error", () => resolve("error")); stream.on("end", () => resolve("end")); stream.on("data", chunk => chunks.push(chunk as Buffer)); stream.resume(); });
    expect(outcome).toBe("error");
    expect(mediaActiveStreamCount()).toBe(0);
  });
});

// ── route: saved Files versions ────────────────────────────────────────────
describe("artifact assets", () => {
  it("resolves a saved version by its authorized scope and pins it to the stored digest", async () => {
    const f = fixture(), image = jpeg(300, 200), root = join(f.workspaces, f.botId);
    writeFileSync(join(root, "photo.jpg"), image);
    const artifact = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "photo.jpg", name: "Photo" }, { owner: true, scopes: f.deps.artifactScopes() });
    const resolved = ready(await resolve(f, { source: "artifact", artifactId: artifact.id }));
    expect(resolved.asset).toMatchObject({ source: "artifact", kind: "image", mime: "image/jpeg", name: "Photo.jpg", bytes: image.length, revision: artifact.sha256, width: 300, height: 200,
      scope: { serverId: MEDIA_SERVER_ID, botId: f.botId, threadId: f.threadId }, capabilities: { preview: true, download: true, imageReference: true } });
    expect((await drain(await fetchBytes(f, resolved.url))).equals(image)).toBe(true);
    expect(status(await fetchBytes(f, resolved.url, { headers: { range: "bytes=2-3" } }))).toBe(206);
    // The workspace original changing does not change the saved version.
    writeFileSync(join(root, "photo.jpg"), gif());
    expect((await drain(await fetchBytes(f, resolved.url))).equals(image)).toBe(true);
    // A tampered stored copy is reported as changed, never served.
    const blob = join(f.storage, `${artifact.sha256}.jpg`);
    writeFileSync(blob, jpeg(300, 200).fill(0x01, 40)); utimesSync(blob, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await fetchBytes(f, resolved.url)).status).toBe(409);
    expect((await resolve(f, { source: "artifact", artifactId: artifact.id })).body).toMatchObject({ asset: { availability: "changed", revision: artifact.sha256 } });
    unlinkSync(blob);
    expect((await resolve(f, { source: "artifact", artifactId: artifact.id })).body).toMatchObject({ asset: { availability: "missing" } });
  });
  it("hides saved versions outside the authorized scopes and marks non-media as unsupported", async () => {
    const f = fixture(), root = join(f.workspaces, f.botId);
    writeFileSync(join(root, "report.html"), "<!doctype html><h1>Report</h1>");
    const report = registerArtifact(f.db, f.storage, { botId: f.botId, threadId: f.threadId, relativePath: "report.html" }, { owner: true, scopes: f.deps.artifactScopes() });
    const html = (await resolve(f, { source: "artifact", artifactId: report.id })).body as MediaResolveResponse;
    expect(html.asset).toMatchObject({ availability: "unsupported", kind: "file", capabilities: { preview: false, download: false } }); expect(html.url).toBeUndefined();
    expect((await resolve(f, { source: "artifact", artifactId: "0f2a1c3e-1111-4222-8333-944455566677" })).status).toBe(404);
    const narrowed = { ...f.deps, artifactScopes: () => f.deps.artifactScopes().filter(scope => scope.botId !== f.botId) };
    const denied = await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { body: { ref: { source: "artifact", artifactId: report.id } } }), narrowed);
    expect(denied.status).toBe(404);
  });
});

// ── route: workspace files ─────────────────────────────────────────────────
describe("workspace assets", () => {
  it("serves a workspace file only through its authorized scope and the revision discovery issued", async () => {
    const f = fixture(), root = join(f.workspaces, f.botId), audio = wav(2);
    mkdirSync(join(root, "outputs")); writeFileSync(join(root, "outputs", "take one.wav"), audio);
    const stat = (await import("node:fs")).lstatSync(join(root, "outputs", "take one.wav"));
    const canonicalRoot = (await import("node:fs")).realpathSync.native(root);
    const revision = mediaWorkspaceRevision(canonicalRoot, "outputs/take one.wav", stat);
    expect(revision).toMatch(/^r1\.[A-Za-z0-9_-]{43}$/);
    const scope = { botId: f.botId, threadId: f.threadId };
    const resolved = ready(await resolve(f, { source: "workspace", scope, relativePath: "outputs/take one.wav", revision }));
    expect(resolved.asset).toMatchObject({ source: "workspace", kind: "audio", mime: "audio/wav", name: "take one.wav", bytes: audio.length, revision, scope: { serverId: MEDIA_SERVER_ID, ...scope },
      capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: false } });
    expect(JSON.stringify(resolved)).not.toContain(root);
    const range = await fetchBytes(f, resolved.url, { headers: { range: "bytes=44-1043" } });
    expect(range.status).toBe(206); expect(range.headers!["content-type"]).toBe("audio/wav"); expect((await drain(range)).equals(audio.subarray(44, 1044))).toBe(true);
    // A stale or foreign revision never opens the file.
    expect((await resolve(f, { source: "workspace", scope, relativePath: "outputs/take one.wav", revision: "r1.stalestalestale" })).body).toMatchObject({ asset: { availability: "changed" } });
    const otherRevision = mediaWorkspaceRevision(join(f.workspaces, f.otherBotId), "outputs/take one.wav", stat);
    expect((await resolve(f, { source: "workspace", scope, relativePath: "outputs/take one.wav", revision: otherRevision })).body).toMatchObject({ asset: { availability: "changed" } });
    // Another conversation cannot reach this workspace; an unknown scope is hidden.
    expect((await resolve(f, { source: "workspace", scope: { botId: f.otherBotId, threadId: f.otherThreadId }, relativePath: "outputs/take one.wav", revision })).body).toMatchObject({ asset: { availability: "missing" } });
    expect((await resolve(f, { source: "workspace", scope: { botId: f.otherBotId, threadId: f.threadId }, relativePath: "outputs/take one.wav", revision })).status).toBe(404);
    expect((await resolve(f, { source: "workspace", scope: { botId: f.botId, threadId: "unknown" }, relativePath: "outputs/take one.wav", revision })).status).toBe(404);
    // Editing the file after resolve: bytes answer changed, and a new revision is needed.
    writeFileSync(join(root, "outputs", "take one.wav"), wav(3)); utimesSync(join(root, "outputs", "take one.wav"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await fetchBytes(f, resolved.url)).status).toBe(409);
    expect((await resolve(f, { source: "workspace", scope, relativePath: "outputs/take one.wav", revision })).body).toMatchObject({ asset: { availability: "changed" } });
  });
  it("never follows links, never opens private files and refuses roots that are not dedicated workspaces", async () => {
    const f = fixture(), root = join(f.workspaces, f.botId), fs = await import("node:fs");
    const secret = join(f.workspaces, "secret.png"); writeFileSync(secret, png());
    symlinkSync(secret, join(root, "linked.png"));
    mkdirSync(join(root, "memory")); writeFileSync(join(root, "memory", "note.png"), png());
    writeFileSync(join(root, "CLAUDE.md"), "instructions");
    fs.mkdirSync(join(root, "real")); fs.symlinkSync(join(root, "real"), join(root, "via-link"));
    writeFileSync(join(root, "real", "clip.png"), png());
    const canonicalRoot = fs.realpathSync.native(root), scope = { botId: f.botId, threadId: f.threadId };
    const rev = (relative: string, path: string) => mediaWorkspaceRevision(canonicalRoot, relative, fs.lstatSync(path));
    expect((await resolve(f, { source: "workspace", scope, relativePath: "linked.png", revision: rev("linked.png", secret) })).body).toMatchObject({ asset: { availability: "denied" } });
    expect((await resolve(f, { source: "workspace", scope, relativePath: "memory/note.png", revision: rev("memory/note.png", join(root, "memory", "note.png")) })).body).toMatchObject({ asset: { availability: "denied" } });
    expect((await resolve(f, { source: "workspace", scope, relativePath: "CLAUDE.md", revision: rev("CLAUDE.md", join(root, "CLAUDE.md")) })).body).toMatchObject({ asset: { availability: "denied" } });
    expect((await resolve(f, { source: "workspace", scope, relativePath: "via-link/clip.png", revision: rev("via-link/clip.png", join(root, "real", "clip.png")) })).body).toMatchObject({ asset: { availability: "denied" } });
    expect((await resolve(f, { source: "workspace", scope, relativePath: "real/clip.png", revision: rev("real/clip.png", join(root, "real", "clip.png")) })).body).toMatchObject({ asset: { availability: "ready" } });
    // Hard links carry a second name; they are unsupported rather than pinned.
    fs.linkSync(join(root, "real", "clip.png"), join(root, "real", "clip-2.png"));
    expect((await resolve(f, { source: "workspace", scope, relativePath: "real/clip.png", revision: rev("real/clip.png", join(root, "real", "clip.png")) })).body).toMatchObject({ asset: { availability: "unsupported" } });
    // HOME or an ancestor of HOME is never a workspace, even when a scope names it.
    const homeDir = (await import("node:os")).homedir();
    writeFileSync(join(homeDir, "home.png"), png());
    for (const workspaceRoot of [homeDir, join(homeDir, "..")]) {
      const homeScoped = { ...f.deps, artifactScopes: (): ArtifactScope[] => [{ botId: f.botId, botName: "b", threadId: f.threadId, workspaceRoot }] };
      const relativePath = workspaceRoot === homeDir ? "home.png" : `${fs.realpathSync.native(homeDir).split("/").at(-1)}/home.png`;
      const revision = mediaWorkspaceRevision(fs.realpathSync.native(workspaceRoot), relativePath, fs.lstatSync(join(homeDir, "home.png")));
      const home = await mediaAssetsRoute(request("POST", MEDIA_ROUTES.resolve, { body: { ref: { source: "workspace", scope, relativePath, revision } } }), homeScoped);
      expect(home.status, workspaceRoot).toBe(200); expect((home.body as MediaResolveResponse).asset.availability, workspaceRoot).toBe("denied");
    }
  });
  it("reads only a bounded head for type detection and streams large media without buffering it", async () => {
    const f = fixture(), root = join(f.workspaces, f.botId), fs = await import("node:fs");
    const video = Buffer.concat([mp4(), Buffer.alloc(MEDIA_SNIFF_BYTES * 2, 0xab)]);
    writeFileSync(join(root, "clip.mp4"), video);
    const revision = mediaWorkspaceRevision(fs.realpathSync.native(root), "clip.mp4", fs.lstatSync(join(root, "clip.mp4")));
    const resolved = ready(await resolve(f, { source: "workspace", scope: { botId: f.botId, threadId: f.threadId }, relativePath: "clip.mp4", revision }));
    expect(resolved.asset).toMatchObject({ kind: "video", mime: "video/mp4", bytes: video.length });
    const result = await fetchBytes(f, resolved.url, { headers: { range: `bytes=${MEDIA_SNIFF_BYTES}-` } });
    expect(result.status).toBe(206);
    expect((await drain(result)).equals(video.subarray(MEDIA_SNIFF_BYTES))).toBe(true);
  });
});

// ── route: through the delegation seam over real sockets ───────────────────
// server/index.ts awaits the module and then hands the result to
// sendDelegated. A media element aborts range requests on every seek, so the
// client is often gone by the time the file is open: every such request must
// give its stream slot back, or the byte route ends up 503 for the life of
// the process.
describe("byte route through sendDelegated", () => {
  const servers: Server[] = [];
  // A server-side stream outlives the client's last byte by a tick; wait for
  // it before the module-level reset zeroes the counter under it.
  afterEach(async () => {
    await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  interface Seam { base: string; received: () => number; handled: () => number; settled: () => Promise<void> }
  /** Same shape as the server/index.ts delegation; `before` runs first so a
   * test can hold the request until the client has gone or a gate opens. */
  async function seam(f: Fixture, before: (res: ServerResponse) => Promise<void> = async () => {}): Promise<Seam> {
    let received = 0, handled = 0;
    const server = createServer(async (req, res) => {
      received++;
      await before(res);
      const url = new URL(req.url!, "http://127.0.0.1");
      const result = await mediaAssetsRoute({ method: req.method!, path: url.pathname, url, headers: req.headers, desktop: false, readBody: async () => undefined }, f.deps);
      sendDelegated(res, req.method!, result);
      handled++;
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received: () => received, handled: () => handled,
      settled: () => expect.poll(() => handled === received, { timeout: 5000 }).toBe(true),
    };
  }
  /** Aborts `count` requests that the server actually received; an abort that
   * lands before the request is even sent does not count. */
  async function abortReceived(seam: Seam, target: string, count: number): Promise<void> {
    const start = seam.received();
    for (let index = 0; seam.received() < start + count; index++) {
      if (index >= count * 20) throw new Error("the server never received enough aborted requests");
      const controller = new AbortController();
      const attempt = fetch(target, { signal: controller.signal, headers: { range: `bytes=${index * 100}-` } }).then(response => response.arrayBuffer()).catch(() => undefined);
      setImmediate(() => controller.abort());
      await attempt;
    }
  }
  const fullBytes = async (target: string) => { const response = await fetch(target); expect(response.status).toBe(200); return Buffer.from(await response.arrayBuffer()); };
  const attachLarge = (f: Fixture, name: string, chunks: number) => { const image = png(2, 2, MEDIA_STREAM_CHUNK_BYTES * chunks); attach(f, f.threadId, name, image); return image; };

  it("releases the slot when the client is gone before the file is open", async () => {
    const f = fixture(), image = attachLarge(f, "dddddddd-dddd-4ddd-8ddd-dddddddddddd.png", 2);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd.png" }));
    // Hold every request until its client has gone, then open the file for it: the worst case of the async window.
    const held = await seam(f, res => new Promise(resolve => res.once("close", () => resolve())));
    await abortReceived(held, held.base + url, MEDIA_MAX_ACTIVE_STREAMS + 4);
    await held.settled();
    expect(held.handled()).toBeGreaterThanOrEqual(MEDIA_MAX_ACTIVE_STREAMS + 4);
    expect(mediaActiveStreamCount()).toBe(0);
    // The next player request is served in full, not answered 503.
    const server = await seam(f);
    expect((await fullBytes(server.base + url)).equals(image)).toBe(true);
    await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
  });

  it("releases the slot whichever way an abort races the open, and mid-stream", async () => {
    const f = fixture(), image = attachLarge(f, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png", 6);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png" }));
    const racing = await seam(f), base = racing.base;
    await abortReceived(racing, base + url, MEDIA_MAX_ACTIVE_STREAMS * 4);
    // A seek after the first chunk: the response is piped, then the client leaves.
    for (let index = 0; index < MEDIA_MAX_ACTIVE_STREAMS + 2; index++) {
      const response = await fetch(base + url);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
    }
    await racing.settled();
    await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
    expect((await fullBytes(base + url)).equals(image)).toBe(true);
    await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
  });

  it("holds the cap while several requests are still opening their files", async () => {
    const f = fixture(); attachLarge(f, "ffffffff-ffff-4fff-8fff-ffffffffffff.png", 8);
    const { url } = ready(await resolve(f, { source: "attachment", threadId: f.threadId, attachmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff.png" }));
    let waiting = 0, open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const { base } = await seam(f, async () => { waiting++; await gate; });
    const total = MEDIA_MAX_ACTIVE_STREAMS * 2;
    const responses = Array.from({ length: total }, () => fetch(base + url));
    await expect.poll(() => waiting, { timeout: 5000 }).toBe(total);
    open();
    const settled = await Promise.all(responses);
    const statuses = settled.map(response => response.status).sort();
    expect(statuses).toEqual([...Array(MEDIA_MAX_ACTIVE_STREAMS).fill(200), ...Array(MEDIA_MAX_ACTIVE_STREAMS).fill(503)]);
    expect(mediaActiveStreamCount()).toBeLessThanOrEqual(MEDIA_MAX_ACTIVE_STREAMS);
    for (const response of settled) await (response.status === 200 ? response.body!.cancel() : response.text());
    await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
  });
});
