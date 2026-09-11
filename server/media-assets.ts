// Scoped media assets and authorized byte serving (F5-T1, media design M1).
// Image references (IMG-SEED, F5-T4) live in image-reference-resolver.ts and
// reuse the pinned workspace lookup exported below.
// Contract: shared/media-assets.ts and docs/plans/0152-CONTRACTS.md.
//
// Authority, in order:
// 1. POST /api/media/resolve needs desktop proof (server/index.ts gates it
//    through DESKTOP_AUTHORITY_ROUTES and this module checks again). The body
//    names one structured source: an image attachment of one conversation, a
//    saved Files version, or a workspace-relative file pinned to the revision
//    discovery issued. No absolute path, root or URL is ever accepted.
// 2. The server derives the owning scope, opens the file without following
//    links, takes the type from validated bytes (never the extension), pins a
//    revision and remembers an opaque asset id in memory. It answers a
//    same-origin byte URL carrying a short-lived HMAC capability (U-03) bound
//    to asset + revision + the desktop surface.
// 3. GET/HEAD /api/media/bytes/<assetId>?cap= needs no desktop header, because
//    <img>/<audio>/<video> cannot send one. The capability is verified, then
//    the source is re-authorized and re-pinned on every request. A changed
//    file answers 409 instead of splicing two revisions across ranges.
// 4. U-04: a companion-forwarded request is never served, capability or not.
// The capability key is random per process and never persisted, so a restart
// revokes every outstanding URL. This module never logs a URL; any other log
// sink that could see one uses redactMediaCapability.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, parse, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactError, describeArtifact, readArtifact, type ArtifactAccess, type ArtifactScope } from "./artifacts.ts";
import type { Store } from "./store.ts";
import { companionMarked } from "./sse-visibility.ts";
import {
  IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_MIMES, MEDIA_BYTES_RESPONSE_HEADERS, MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_CAPABILITY_TTL_MS,
  MEDIA_CAPABILITY_VERSION, MEDIA_PLAYABLE_MIMES, MEDIA_ROUTE_PREFIX, MEDIA_ROUTES, isMediaCapabilityToken,
  type MediaAsset, type MediaAssetAvailability, type MediaAssetKind, type MediaCapabilityClaims, type MediaResolveResponse,
} from "../shared/media-assets.ts";
import { isFileRevision, isWorkspaceRelativePath, isWorkspaceScopeRef, type WorkspaceScopeRef } from "../shared/workspace-files.ts";
import { hiddenRoute, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
import { workspaceRevisionOf } from "./workspace-revision.ts";

export interface MediaAssetsDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  artifactScopes: () => ArtifactScope[];
}

/** 0.1.52 media is desktop-only (U-04): every asset lives on this harness. */
export const MEDIA_SERVER_ID = "local";
export const MEDIA_ASSET_ID_PATTERN = /^ma1_[A-Za-z0-9_-]{32}$/;
/** Bounded read used for type detection (JPEG frame headers can follow EXIF). */
export const MEDIA_SNIFF_BYTES = 256 * 1024;
/** Bytes are streamed in bounded chunks; nothing is buffered whole. */
export const MEDIA_STREAM_CHUNK_BYTES = 256 * 1024;
/** Open byte streams across the desktop surface. More answers 503. */
export const MEDIA_MAX_ACTIVE_STREAMS = 8;
export const MEDIA_REGISTRY_MAX_ENTRIES = 2_048;
export const MEDIA_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** Decoded pixel ceiling: 100 megapixels. */
export const MEDIA_IMAGE_MAX_PIXELS = 100_000_000;
/** Audio/video ceiling for workspace files (streamed, never buffered). */
export const MEDIA_PLAYER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Attachments and saved Files versions are capped at 25 MiB when written. */
export const MEDIA_STORED_MAX_BYTES = 25 * 1024 * 1024;
const CLOCK_SKEW_MS = 5_000;
const PREVIEW_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PLAYABLE: readonly string[] = [...MEDIA_PLAYABLE_MIMES.audio, ...MEDIA_PLAYABLE_MIMES.video];
const RESOLVE_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
const BYTES_HEADERS = { ...MEDIA_BYTES_RESPONSE_HEADERS, "content-security-policy": "default-src 'none'; sandbox" } as const;
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9-]{1,160}\.(png|jpg|gif|webp)$/;
const ARTIFACT_ID = /^[a-f0-9-]{36}$/;
const UNAVAILABLE = "This media is unavailable.";

// ---------------------------------------------------------------------------
// Content sniffing: MIME comes from validated bytes, extension is never trusted.

export interface SniffedMedia {
  kind: MediaAssetKind;
  mime: string;
  /** True only when the bytes are a supported, bounded, well-formed type. */
  supported: boolean;
  width?: number;
  height?: number;
  reason?: string;
}

const ascii = (bytes: Buffer, start: number, end: number) => bytes.length >= end ? bytes.toString("latin1", start, end) : "";
const other = (mime: string, reason: string): SniffedMedia => ({ kind: "file", mime, supported: false, reason });
const damaged = () => other("application/octet-stream", "The file claims a media type but its bytes are damaged or incomplete.");

function image(mime: string, width: number, height: number, total: number): SniffedMedia {
  if (!(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0)) return damaged();
  if (width * height > MEDIA_IMAGE_MAX_PIXELS) return { kind: "image", mime, supported: false, width, height, reason: "The image has too many pixels to preview." };
  if (total > MEDIA_IMAGE_MAX_BYTES) return { kind: "image", mime, supported: false, width, height, reason: "The image is too large to preview." };
  if (!PREVIEW_IMAGE_MIMES.includes(mime)) return { kind: "image", mime, supported: false, width, height, reason: "This image format has no preview." };
  return { kind: "image", mime, supported: true, width, height };
}

function player(kind: "audio" | "video", mime: string, total: number): SniffedMedia {
  if (!PLAYABLE.includes(mime)) return { kind, mime, supported: false, reason: "This media format is not playable here." };
  if (total > MEDIA_PLAYER_MAX_BYTES) return { kind, mime, supported: false, reason: "The media file is too large to play here." };
  return { kind, mime, supported: true };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let index = 2;
  while (index + 4 <= bytes.length) {
    if (bytes[index] !== 0xff) return undefined;
    const marker = bytes[index + 1]!;
    if (marker === 0xff) { index++; continue; }
    index += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (index + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(index);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7 || index + 7 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(index + 3), width: bytes.readUInt16BE(index + 5) };
    }
    index += length;
  }
  return undefined;
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** Length of an MPEG audio Layer III frame starting at `offset`, if valid. */
function mp3FrameLength(bytes: Buffer, offset: number): number | undefined {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (bytes[offset + 1]! >> 3) & 3, layer = (bytes[offset + 1]! >> 1) & 3;
  const bitrateIndex = bytes[offset + 2]! >> 4, rateIndex = (bytes[offset + 2]! >> 2) & 3, padding = (bytes[offset + 2]! >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]! * 1000, rate = MP3_RATES[version]![rateIndex]!;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + padding;
}

const MP4_VIDEO_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso8", "iso9", "mp41", "mp42", "avc1", "dash", "mmp4", "M4V ", "MSNV"]);
const MP4_AUDIO_BRANDS = new Set(["M4A ", "M4B "]);

/** Identify a file from its leading bytes. `total` is the full file size. */
export function sniffMedia(head: Uint8Array, total: number): SniffedMedia {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (total === 0 || bytes.length === 0) return other("application/octet-stream", "The file is empty.");
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (bytes.length < 24 || bytes.readUInt32BE(8) !== 13 || ascii(bytes, 12, 16) !== "IHDR") return damaged();
    return image("image/png", bytes.readUInt32BE(16), bytes.readUInt32BE(20), total);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return size ? image("image/jpeg", size.width, size.height, total) : damaged();
  }
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return bytes.length >= 10 ? image("image/gif", bytes.readUInt16LE(6), bytes.readUInt16LE(8), total) : damaged();
  }
  if (ascii(bytes, 0, 4) === "RIFF" && bytes.length >= 12) {
    const riffSize = bytes.readUInt32LE(4), form = ascii(bytes, 8, 12);
    if (riffSize < 4 || riffSize + 8 > total) return damaged();
    if (form === "WEBP") {
      const chunk = ascii(bytes, 12, 16);
      if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return image("image/webp", bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff, total);
      }
      if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = bytes.readUInt32LE(21);
        return image("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, total);
      }
      if (chunk === "VP8X" && bytes.length >= 30) return image("image/webp", bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1, total);
      return damaged();
    }
    if (form === "WAVE") return /^[\x20-\x7e]{4}$/.test(ascii(bytes, 12, 16)) ? player("audio", "audio/wav", total) : damaged();
    if (form === "AVI ") return { kind: "video", mime: "video/x-msvideo", supported: false, reason: "This media format is not playable here." };
    return other("application/octet-stream", "This file type has no preview.");
  }
  if (ascii(bytes, 0, 4) === "OggS" && bytes.length >= 5 && bytes[4] === 0) {
    return bytes.subarray(0, Math.min(bytes.length, 128)).includes("theora", 0, "latin1")
      ? { kind: "video", mime: "video/ogg", supported: false, reason: "This media format is not playable here." }
      : player("audio", "audio/ogg", total);
  }
  if (ascii(bytes, 0, 4) === "fLaC") return player("audio", "audio/flac", total);
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10 && bytes[3]! >= 2 && bytes[3]! <= 4 && bytes[4] !== 0xff && [6, 7, 8, 9].every(index => bytes[index]! < 0x80)) {
    return player("audio", "audio/mpeg", total);
  }
  const frame = mp3FrameLength(bytes, 0);
  if (frame !== undefined && frame >= 4 && mp3FrameLength(bytes, frame) !== undefined) return player("audio", "audio/mpeg", total);
  if (ascii(bytes, 4, 8) === "ftyp" && bytes.length >= 16) {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) return damaged();
    const major = ascii(bytes, 8, 12), brands = [major];
    for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
    if (major === "qt  ") return { kind: "video", mime: "video/quicktime", supported: false, reason: "This media format is not playable here." };
    if (MP4_AUDIO_BRANDS.has(major)) return player("audio", "audio/mp4", total);
    if (MP4_VIDEO_BRANDS.has(major)) return player("video", "video/mp4", total);
    if (["heic", "heix", "mif1", "msf1"].includes(major)) return { kind: "image", mime: "image/heic", supported: false, reason: "This image format has no preview." };
    if (major === "avif") return { kind: "image", mime: "image/avif", supported: false, reason: "This image format has no preview." };
    if (major.startsWith("3g")) return { kind: "video", mime: "video/3gpp", supported: false, reason: "This media format is not playable here." };
    if (brands.some(brand => MP4_AUDIO_BRANDS.has(brand))) return player("audio", "audio/mp4", total);
    if (brands.some(brand => MP4_VIDEO_BRANDS.has(brand))) return player("video", "video/mp4", total);
    return other("application/octet-stream", "This media container is not supported.");
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const window = bytes.subarray(0, Math.min(bytes.length, 64)), at = window.indexOf(Buffer.from([0x42, 0x82]));
    const sizeByte = at >= 0 ? window[at + 2] : undefined;
    if (sizeByte === undefined || (sizeByte & 0x80) === 0) return damaged();
    const docType = ascii(window, at + 3, at + 3 + (sizeByte & 0x7f));
    if (docType === "webm") return player("video", "video/webm", total);
    if (docType === "matroska") return { kind: "video", mime: "video/x-matroska", supported: false, reason: "This media format is not playable here." };
    return damaged();
  }
  const text = bytes.subarray(0, Math.min(bytes.length, 1024)).toString("latin1").replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return other("image/svg+xml", "SVG images are active content and are not previewed.");
  if (ascii(bytes, 0, 5) === "%PDF-") return other("application/pdf", "This file type has no preview.");
  const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
  if (ascii(bytes, 0, 2) === "MZ" || ascii(bytes, 0, 4) === "\x7fELF" || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
    return other("application/octet-stream", "Executable files are never previewed.");
  }
  return other("application/octet-stream", "This file type has no preview.");
}

// ---------------------------------------------------------------------------
// Capability (U-03): mc1.<base64url claims>.<base64url HMAC-SHA256>

const capabilityKey = randomBytes(32);
const mac = (label: string, value: string) => createHmac("sha256", capabilityKey).update(label).update("\0").update(value).digest();

export function issueMediaCapability(assetId: string, revision: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + MEDIA_CAPABILITY_TTL_MS;
  const claims: MediaCapabilityClaims = { v: 1, assetId, revision, surface: "desktop", exp: expiresAt };
  const signed = `${MEDIA_CAPABILITY_VERSION}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return { token: `${signed}.${mac("media-capability", signed).toString("base64url")}`, expiresAt };
}

export type MediaCapabilityCheck = { ok: true; claims: MediaCapabilityClaims } | { ok: false; reason: "invalid" | "expired" };

export function verifyMediaCapability(token: unknown, assetId: string, now = Date.now()): MediaCapabilityCheck {
  const invalid: MediaCapabilityCheck = { ok: false, reason: "invalid" };
  if (!isMediaCapabilityToken(token)) return invalid;
  const [version, body, signature] = token.split(".") as [string, string, string];
  const expected = mac("media-capability", `${version}.${body}`), given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return invalid; }
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || Object.keys(claims).sort().join(",") !== "assetId,exp,revision,surface,v") return invalid;
  if (claims.v !== 1 || claims.surface !== "desktop" || claims.assetId !== assetId || typeof claims.revision !== "string" || !Number.isSafeInteger(claims.exp)) return invalid;
  const exp = claims.exp as number;
  if (exp > now + MEDIA_CAPABILITY_TTL_MS + CLOCK_SKEW_MS) return invalid;
  if (exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as unknown as MediaCapabilityClaims };
}

// ---------------------------------------------------------------------------
// References, scope and pinned files

type NormalizedRef =
  | { source: "attachment"; threadId: string; attachmentId: string }
  | { source: "artifact"; artifactId: string }
  /** `revision` absent pins whatever is there now (image references only;
   * the media routes always carry the revision discovery issued). */
  | { source: "workspace"; scope: WorkspaceScopeRef; relativePath: string; revision?: string };

class MediaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function fail(status: number, code: string, message: string): never { throw new MediaError(status, code, message); }

const fingerprint = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const cleanName = (value: string) => value.replace(/\p{Cc}/gu, " ").trim().slice(0, 200) || "media";

/** Same opaque identity as R3-T1 `workspaceFileRevision(root, relativePath,
 * stat)` (server/workspace-revision.ts): sha256 over the canonical root, the
 * relative path, the artifact source fingerprint and, within the text limit,
 * the file's own bytes at that path. A revision issued for another root or
 * another content never matches. Throws when the file at that path is not
 * the observed state or cannot be read: no revision exists for it. */
export function mediaWorkspaceRevision(root: string, relativePath: string, stat: Stats): string {
  const result = workspaceRevisionOf(root, relativePath, stat);
  if (!result.ok) fail(409, "changed", "This media changed. Open it again.");
  return result.revision;
}

export function mediaAssetIdFor(ref: NormalizedRef): string {
  const parts = ref.source === "attachment" ? [ref.source, ref.threadId, ref.attachmentId]
    : ref.source === "artifact" ? [ref.source, ref.artifactId]
      : [ref.source, ref.scope.botId, ref.scope.threadId, ref.relativePath];
  return `ma1_${mac("media-asset", JSON.stringify(parts)).subarray(0, 24).toString("base64url")}`;
}

function parseRef(body: unknown): NormalizedRef {
  const invalid = () => fail(400, "invalid-request", "Choose media from this conversation, Files or its workspace.");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "ref") invalid();
  const ref = (body as { ref: unknown }).ref;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) invalid();
  const value = ref as Record<string, unknown>, keys = Object.keys(value).sort().join(",");
  if (value.source === "attachment" && keys === "attachmentId,source,threadId" && typeof value.threadId === "string" && THREAD_ID.test(value.threadId)
    && typeof value.attachmentId === "string" && ATTACHMENT_ID.test(value.attachmentId)) {
    return { source: "attachment", threadId: value.threadId, attachmentId: value.attachmentId };
  }
  if (value.source === "artifact" && keys === "artifactId,source" && typeof value.artifactId === "string" && ARTIFACT_ID.test(value.artifactId)) {
    return { source: "artifact", artifactId: value.artifactId };
  }
  if (value.source === "workspace" && keys === "relativePath,revision,scope,source" && isWorkspaceScopeRef(value.scope)
    && isWorkspaceRelativePath(value.relativePath) && isFileRevision(value.revision)) {
    return { source: "workspace", scope: { botId: value.scope.botId, threadId: value.scope.threadId }, relativePath: value.relativePath, revision: value.revision };
  }
  return invalid();
}

type Unready = Exclude<MediaAssetAvailability, "ready" | "loading">;
export type MediaFileOutcome =
  | { state: "ready"; path: string; stat: Stats; revision?: string; observed: Array<[string, Stats]> }
  | { state: Unready; revision?: string };
type Outcome = MediaFileOutcome;
interface Located { name: string; scope: MediaAsset["scope"]; outcome: Outcome }

/** One ordinary, unlinked file directly inside `directory`. */
function directFile(directory: string, path: string): Outcome {
  let parent: Stats;
  try { parent = lstatSync(directory); } catch (error) { return { state: errno(error) === "ENOENT" ? "missing" : "denied" }; }
  if (!parent.isDirectory() || parent.isSymbolicLink()) return { state: "denied" };
  let stat: Stats;
  try { stat = lstatSync(path); } catch (error) { return { state: errno(error) === "ENOENT" ? "missing" : "unsupported" }; }
  if (stat.isSymbolicLink()) return { state: "denied" };
  if (!stat.isFile() || stat.nlink !== 1) return { state: "unsupported" };
  return { state: "ready", path, stat, observed: [[directory, parent]] };
}

function threadOwner(store: Store, threadId: string): { id: string; room: boolean } | undefined {
  for (const bot of store.bots) if (bot.threadId === threadId || (bot.tasks ?? []).some(task => task.threadId === threadId)) return { id: bot.id, room: false };
  for (const group of store.groups) if (group.threadId === threadId || (group.tasks ?? []).some(task => task.threadId === threadId)) return { id: group.id, room: true };
  return undefined;
}

/** An image attachment is reachable only through a message of the exact
 * conversation that holds it. The thread must already exist in the store, so
 * a guessed id never creates or loads an unrelated transcript. */
function locateAttachment(ref: Extract<NormalizedRef, { source: "attachment" }>, deps: MediaAssetsDeps): Located {
  const owner = threadOwner(deps.store, ref.threadId);
  if (!owner) fail(404, "unavailable", UNAVAILABLE);
  const directory = join(deps.dataDir, "attachments"), path = join(directory, ref.attachmentId);
  const message = deps.store.messagesFor(ref.threadId)
    .find(item => (item.attachments ?? []).some(attachment => attachment.kind === "image" && resolve(attachment.path) === path));
  if (!message) fail(404, "unavailable", UNAVAILABLE);
  // A room message names its speaking member; a person's upload to a room is
  // owned by the room itself.
  const botId = owner.room ? message.from?.botId ?? owner.id : owner.id;
  return { name: ref.attachmentId, scope: { serverId: MEDIA_SERVER_ID, botId, threadId: ref.threadId, messageId: message.id }, outcome: directFile(directory, path) };
}

const artifactAccess = (deps: MediaAssetsDeps): ArtifactAccess => ({ owner: true, scopes: deps.artifactScopes() });
const artifactStorage = (deps: MediaAssetsDeps) => join(deps.dataDir, "artifact-files");

/** A saved Files version: authorized by the same scopes Files uses and pinned
 * by its content digest. The stored copy is re-verified byte for byte here. */
function locateArtifact(ref: Extract<NormalizedRef, { source: "artifact" }>, deps: MediaAssetsDeps, verify: boolean): Located {
  const db = deps.database(), storage = artifactStorage(deps), access = artifactAccess(deps);
  let artifact;
  try { artifact = describeArtifact(db, storage, ref.artifactId, access); }
  catch (error) { if (error instanceof ArtifactError) fail(404, "unavailable", UNAVAILABLE); throw error; }
  const located = { name: cleanName(artifact.filename), scope: { serverId: MEDIA_SERVER_ID, botId: artifact.botId, threadId: artifact.threadId } };
  if (artifact.savedState === "missing") return { ...located, outcome: { state: "missing", revision: artifact.sha256 } };
  if (artifact.savedState !== "available") return { ...located, outcome: { state: "changed", revision: artifact.sha256 } };
  // Same blob name artifacts.ts uses: <sha256><extension>. Resolve re-reads
  // and re-hashes the stored copy through readArtifact (bounded at 25 MiB);
  // bytes requests only re-pin the same inode against the remembered state.
  const extension = extname(artifact.filename).toLowerCase() || artifact.filename.toLowerCase();
  let path = join(storage, artifact.sha256 + extension);
  if (verify) {
    try { path = readArtifact(db, storage, ref.artifactId, access).verifiedNativePath; }
    catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      if (error.status === 404) fail(404, "unavailable", UNAVAILABLE);
      return { ...located, outcome: { state: error.status === 410 ? "missing" : "changed", revision: artifact.sha256 } };
    }
  }
  const outcome = directFile(storage, path);
  if (outcome.state !== "ready") return { ...located, outcome: { state: outcome.state === "missing" ? "missing" : "changed", revision: artifact.sha256 } };
  return { ...located, outcome: { ...outcome, revision: artifact.sha256 } };
}

const privateName = (name: string, last: boolean) => /^(memory|skills|credentials)$/i.test(name) || (last && /^(MEMORY|SOUL|AGENTS|CLAUDE)\.md$/i.test(name));

/** A workspace file: the root is re-derived from the scopes Files and
 * register_artifact already authorize for this bot conversation; the path is
 * walked with lstat and never follows a link. */
function locateWorkspace(ref: Extract<NormalizedRef, { source: "workspace" }>, deps: MediaAssetsDeps): Located {
  const located = { name: cleanName(basename(ref.relativePath)), scope: { serverId: MEDIA_SERVER_ID, botId: ref.scope.botId, threadId: ref.scope.threadId } };
  const roots = new Set<string>();
  for (const scope of deps.artifactScopes()) {
    if (scope.botId !== ref.scope.botId || scope.threadId !== ref.scope.threadId || scope.threadAvailable === false) continue;
    // R3-T4 adds each conversation's managed generated-images root as a
    // scope that authorizes saved image rows only. It is never a browsing
    // root (register-artifact skips it too); counting it made every thread
    // look ambiguous, so workspace media never resolved.
    if (scope.managedOutput === true) continue;
    roots.add(resolve(scope.workspaceRoot));
  }
  if (roots.size !== 1) fail(404, "unavailable", UNAVAILABLE);
  const candidate = [...roots][0]!;
  let rootStat: Stats;
  try { rootStat = lstatSync(candidate); } catch (error) { return { ...located, outcome: { state: errno(error) === "ENOENT" ? "missing" : "denied" } }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...located, outcome: { state: "denied" } };
  let root: string;
  try { root = realpathSync.native(candidate); } catch (error) { return { ...located, outcome: { state: errno(error) === "ENOENT" ? "missing" : "denied" } }; }
  let home: string | undefined;
  try { home = realpathSync.native(homedir()); } catch { home = undefined; }
  // The filesystem root, HOME and any ancestor of HOME are never a dedicated workspace.
  if (root === parse(root).root || (home !== undefined && (home === root || home.startsWith(root.endsWith(sep) ? root : root + sep)))) {
    return { ...located, outcome: { state: "denied" } };
  }
  const parts = ref.relativePath.split("/");
  if (parts.some((part, index) => privateName(part, index === parts.length - 1))) return { ...located, outcome: { state: "denied" } };
  let canonicalStat: Stats;
  try { canonicalStat = lstatSync(root); } catch (error) { return { ...located, outcome: { state: errno(error) === "ENOENT" ? "missing" : "denied" } }; }
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) return { ...located, outcome: { state: "denied" } };
  const observed: Array<[string, Stats]> = [[root, canonicalStat]];
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let stat: Stats;
    try { stat = lstatSync(path); } catch (error) { return { ...located, outcome: { state: errno(error) === "ENOENT" ? "missing" : "unsupported" } }; }
    if (stat.isSymbolicLink()) return { ...located, outcome: { state: "denied" } };
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) return { ...located, outcome: { state: "missing" } };
      observed.push([path, stat]);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) return { ...located, outcome: { state: "unsupported" } };
    const current = workspaceRevisionOf(root, ref.relativePath, stat);
    if (!current.ok) return { ...located, outcome: { state: current.reason === "changed" ? "changed" : "unsupported" } };
    const revision = current.revision;
    if (ref.revision !== undefined && revision !== ref.revision) return { ...located, outcome: { state: "changed" } };
    return { ...located, outcome: { state: "ready", path, stat, revision, observed } };
  }
  return { ...located, outcome: { state: "missing" } };
}

/** The same scoped, link-refusing workspace lookup the media routes use, for
 * image references (F5-T4). The root comes from the conversation's own
 * authorized scopes; a throw means the conversation has no single workspace. */
export function locateWorkspaceMedia(scope: WorkspaceScopeRef, relativePath: string, revision: string | undefined, deps: MediaAssetsDeps): { name: string; outcome: MediaFileOutcome } {
  try {
    const located = locateWorkspace({ source: "workspace", scope, relativePath, ...(revision === undefined ? {} : { revision }) }, deps);
    return { name: located.name, outcome: located.outcome };
  } catch (error) {
    if (error instanceof MediaError) return { name: cleanName(basename(relativePath)), outcome: { state: "denied" } };
    throw error;
  }
}

function locate(ref: NormalizedRef, deps: MediaAssetsDeps, verify: boolean): Located {
  if (ref.source === "attachment") return locateAttachment(ref, deps);
  if (ref.source === "artifact") return locateArtifact(ref, deps, verify);
  return locateWorkspace(ref, deps);
}

const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/** Open exactly the file that was observed; undefined if it changed. */
async function openPinned(path: string, expected: string, observed: Array<[string, Stats]>): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try { handle = await open(path, FLAGS); } catch { return undefined; }
  try {
    const stat = await handle.stat();
    const ancestors = observed.every(([ancestor, before]) => { const now = lstatSync(ancestor); return now.dev === before.dev && now.ino === before.ino && now.isDirectory() && !now.isSymbolicLink(); });
    if (stat.isFile() && fingerprint(stat) === expected && ancestors) return handle;
  } catch { /* closed below */ }
  await handle.close().catch(() => undefined);
  return undefined;
}

/** Read a whole located file through a pinned handle: undefined if it is not
 * exactly the observed file, is larger than `maxBytes`, or changed while it
 * was read. Never follows a link. */
export async function readPinnedMediaFile(outcome: Extract<MediaFileOutcome, { state: "ready" }>, maxBytes: number): Promise<Buffer | undefined> {
  if (outcome.stat.size > maxBytes) return undefined;
  const expected = fingerprint(outcome.stat), handle = await openPinned(outcome.path, expected, outcome.observed);
  if (!handle) return undefined;
  try {
    const bytes = await readAt(handle, outcome.stat.size, 0);
    const after = await handle.stat();
    if (bytes.length !== outcome.stat.size || fingerprint(after) !== expected || fingerprint(lstatSync(outcome.path)) !== expected) return undefined;
    return bytes;
  } finally { await handle.close().catch(() => undefined); }
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function sha256Of(handle: FileHandle, size: number): Promise<string | undefined> {
  const hash = createHash("sha256");
  for (let position = 0; position < size;) {
    const chunk = await readAt(handle, Math.min(1024 * 1024, size - position), position);
    if (!chunk.length) return undefined;
    hash.update(chunk); position += chunk.length;
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory asset registry and stream accounting

interface RegistryEntry { ref: NormalizedRef; asset: MediaAsset; revision: string; path: string; fingerprint: string; expiresAt: number }
const registry = new Map<string, RegistryEntry>();
let activeStreams = 0;

function remember(assetId: string, entry: RegistryEntry, now: number): void {
  registry.delete(assetId);
  for (const [id, item] of registry) if (item.expiresAt + CLOCK_SKEW_MS <= now) registry.delete(id);
  registry.set(assetId, entry);
  while (registry.size > MEDIA_REGISTRY_MAX_ENTRIES) registry.delete(registry.keys().next().value!);
}

/** Test seam: forget every asset and stream count (the key stays). */
export function __resetMediaAssetsForTests(): void { registry.clear(); activeStreams = 0; }
export function mediaActiveStreamCount(): number { return activeStreams; }

function descriptor(assetId: string, ref: NormalizedRef, located: Located, availability: Unready | "ready", sniffed?: SniffedMedia, bytes?: number, revision?: string): MediaAsset {
  const ready = availability === "ready", kind = sniffed?.kind ?? "file", mime = sniffed?.mime ?? "application/octet-stream";
  return {
    id: assetId, scope: located.scope, source: ref.source, kind, name: located.name, mime,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(revision ? { revision } : {}),
    ...(sniffed?.width !== undefined && sniffed.height !== undefined ? { width: sniffed.width, height: sniffed.height } : {}),
    availability,
    capabilities: {
      preview: ready, download: ready,
      // Native open/reveal is F4-T5; this route grants no filesystem action.
      open: false, reveal: false,
      imageReference: ready && (IMAGE_REFERENCE_MIMES as readonly string[]).includes(mime) && (bytes ?? Infinity) <= IMAGE_REFERENCE_LIMITS.maxBytesEach,
    },
  };
}

async function resolveMedia(ref: NormalizedRef, deps: MediaAssetsDeps, now: number): Promise<MediaResolveResponse> {
  const assetId = mediaAssetIdFor(ref), located = locate(ref, deps, true), outcome = located.outcome;
  // A non-ready answer never touches the registry: a stale revision from one
  // surface must not revoke a URL another surface holds, and the byte route
  // re-pins the file on every request anyway.
  if (outcome.state !== "ready") return { asset: descriptor(assetId, ref, located, outcome.state, undefined, undefined, outcome.revision) };
  const limit = ref.source === "workspace" ? MEDIA_PLAYER_MAX_BYTES : MEDIA_STORED_MAX_BYTES;
  if (outcome.stat.size > limit) return { asset: descriptor(assetId, ref, located, "unsupported", undefined, outcome.stat.size) };
  const expected = fingerprint(outcome.stat), handle = await openPinned(outcome.path, expected, outcome.observed);
  if (!handle) return { asset: descriptor(assetId, ref, located, "changed", undefined, outcome.stat.size) };
  let sniffed: SniffedMedia, revision = outcome.revision;
  try {
    sniffed = sniffMedia(await readAt(handle, Math.min(outcome.stat.size, MEDIA_SNIFF_BYTES), 0), outcome.stat.size);
    // Attachments have no stored digest: pin them by content now.
    if (ref.source === "attachment" && sniffed.supported) revision = await sha256Of(handle, outcome.stat.size);
    const after = await handle.stat();
    if (fingerprint(after) !== expected || fingerprint(lstatSync(outcome.path)) !== expected || (sniffed.supported && !revision)) {
      return { asset: descriptor(assetId, ref, located, "changed", undefined, outcome.stat.size) };
    }
  } finally { await handle.close().catch(() => undefined); }
  if (!sniffed.supported) return { asset: descriptor(assetId, ref, located, "unsupported", sniffed, outcome.stat.size, revision) };
  const asset = descriptor(assetId, ref, located, "ready", sniffed, outcome.stat.size, revision);
  const { token, expiresAt } = issueMediaCapability(assetId, revision!, now);
  remember(assetId, { ref, asset, revision: revision!, path: outcome.path, fingerprint: expected, expiresAt }, now);
  return { asset, url: `${MEDIA_ROUTES.bytes}/${assetId}?${MEDIA_CAPABILITY_QUERY_PARAM}=${token}`, expiresAt };
}

// ---------------------------------------------------------------------------
// Byte serving: single range, 206/416, bounded chunks, re-pinned per request

export type ByteRange = { start: number; end: number } | "full" | "unsatisfiable";

/** One `bytes=` range only (the unit is case-insensitive and optional
 * whitespace may surround `=`, per RFC 9110). Multiple ranges, other units
 * and malformed or unsatisfiable specs are refused (416) rather than
 * approximated. */
export function parseByteRange(header: string | string[] | undefined, size: number): ByteRange {
  if (header === undefined) return "full";
  if (typeof header !== "string") return "unsatisfiable";
  const match = /^bytes[ \t]*=[ \t]*(\d{0,15})-(\d{0,15})$/i.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "") || size === 0) return "unsatisfiable";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  if (match[2] === "") return { start, end: size - 1 };
  const last = Number(match[2]);
  return last < start ? "unsatisfiable" : { start, end: Math.min(last, size - 1) };
}

/** Pull-based reader: each chunk is read only when the response asks for
 * more, so a slow or paused client applies backpressure. The file must still
 * match its pinned state when the range ends; otherwise the response is
 * destroyed instead of completing with mixed bytes. The stream takes over a
 * slot the caller reserved in `activeStreams` and gives it back exactly once
 * when it is destroyed, whether it ended, failed, or lost its client (the
 * delegation seam destroys it when the response goes away, including a
 * response that was already gone by the time the file was open). */
class PinnedRangeStream extends Readable {
  private position: number;
  private released = false;
  private readonly handle: FileHandle;
  private readonly end: number;
  private readonly expected: string;
  constructor(handle: FileHandle, start: number, end: number, expected: string) {
    super({ highWaterMark: MEDIA_STREAM_CHUNK_BYTES });
    this.handle = handle; this.position = start; this.end = end; this.expected = expected;
  }
  override _read(): void {
    if (this.position > this.end) {
      this.handle.stat().then(stat => { if (fingerprint(stat) === this.expected) this.push(null); else this.destroy(new Error("The media file changed while it was being read.")); },
        error => this.destroy(error as Error));
      return;
    }
    const length = Math.min(MEDIA_STREAM_CHUNK_BYTES, this.end - this.position + 1);
    readAt(this.handle, length, this.position).then(chunk => {
      if (chunk.length === 0) { this.destroy(new Error("The media file changed while it was being read.")); return; }
      this.position += chunk.length;
      this.push(chunk);
    }, error => this.destroy(error as Error));
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.released) { this.released = true; activeStreams--; }
    this.handle.close().then(() => callback(error), () => callback(error));
  }
}

const bytesError = (status: number, code: string, error: string, headers: Record<string, string> = {}): DelegatedResult =>
  ({ status, headers: { ...BYTES_HEADERS, ...headers }, body: { error, code } });
const hiddenBytes = (): DelegatedResult => ({ ...hiddenRoute(), headers: { ...BYTES_HEADERS } });
const contentDisposition = (name: string) => `inline; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;

async function serveBytes(request: DelegatedRequest, deps: MediaAssetsDeps, assetId: string, now: number): Promise<DelegatedResult> {
  const tokens = request.url.searchParams.getAll(MEDIA_CAPABILITY_QUERY_PARAM);
  if (tokens.length !== 1) return hiddenBytes();
  const check = verifyMediaCapability(tokens[0], assetId, now);
  if (!check.ok) return check.reason === "expired" ? bytesError(403, "capability-expired", "This media link expired. Open the media again.") : hiddenBytes();
  const entry = registry.get(assetId);
  if (!entry) return hiddenBytes();
  // Only a holder of the capability learns that the route exists at all.
  if (request.method !== "GET" && request.method !== "HEAD") return bytesError(405, "method-not-allowed", "Media bytes are read with GET or HEAD.", { allow: "GET, HEAD" });
  if (entry.revision !== check.claims.revision) return bytesError(409, "changed", "This media changed. Open it again.");
  let located: Located;
  try {
    const ref = entry.ref.source === "workspace" ? { ...entry.ref, revision: entry.revision } : entry.ref;
    located = locate(ref, deps, false);
  } catch (error) {
    if (error instanceof MediaError) return hiddenBytes();
    return bytesError(409, "changed", "This media changed. Open it again.");
  }
  const outcome = located.outcome;
  if (outcome.state === "missing") return bytesError(410, "missing", "This media is no longer available.");
  if (outcome.state !== "ready" || outcome.path !== entry.path || fingerprint(outcome.stat) !== entry.fingerprint
    || (outcome.revision !== undefined && outcome.revision !== entry.revision)) return bytesError(409, "changed", "This media changed. Open it again.");
  const size = outcome.stat.size, etag = `"${entry.revision}"`;
  let range = parseByteRange(request.headers.range, size);
  const ifRange = request.headers["if-range"];
  if (request.headers.range !== undefined && ifRange !== undefined && ifRange !== etag) range = "full";
  const base = { ...BYTES_HEADERS, "content-type": entry.asset.mime, "accept-ranges": "bytes", etag, "content-disposition": contentDisposition(entry.asset.name) };
  if (range === "unsatisfiable") return bytesError(416, "range-not-satisfiable", "Request one byte range inside the file.", { "accept-ranges": "bytes", "content-range": `bytes */${size}` });
  const { start, end } = range === "full" ? { start: 0, end: size - 1 } : range;
  const partial = range !== "full", length = size === 0 ? 0 : end - start + 1;
  const headers: Record<string, string> = { ...base, "content-length": String(length), ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) };
  const status = partial ? 206 : 200;
  if (request.method === "HEAD") return { status, headers, bytes: new Uint8Array(0) };
  if (activeStreams >= MEDIA_MAX_ACTIVE_STREAMS) return bytesError(503, "busy", "Too many media streams are open. Try again.", { "retry-after": "1" });
  // Reserve the slot before the open: requests that arrive while this one is
  // still opening must see it, or the cap is only advisory.
  activeStreams++;
  let handle: FileHandle | undefined;
  try { handle = await openPinned(outcome.path, entry.fingerprint, outcome.observed); } catch { handle = undefined; }
  if (!handle) { activeStreams--; return bytesError(409, "changed", "This media changed. Open it again."); }
  if (length === 0) { activeStreams--; await handle.close().catch(() => undefined); return { status, headers, bytes: new Uint8Array(0) }; }
  return { status, headers, stream: new PinnedRangeStream(handle, start, end, entry.fingerprint) };
}

// ---------------------------------------------------------------------------
// Routes

/** /api/media/*. `resolve` needs desktop proof; `bytes/<assetId>` needs the
 * capability it issued instead, because media elements cannot send the
 * desktop header. The companion is refused either way (U-04). */
export async function mediaAssetsRoute(request: DelegatedRequest, deps: MediaAssetsDeps): Promise<DelegatedResult> {
  const path = request.path;
  if (path !== MEDIA_ROUTE_PREFIX && !path.startsWith(`${MEDIA_ROUTE_PREFIX}/`)) return hiddenRoute();
  if (companionMarked(request.headers)) return hiddenRoute();
  const now = Date.now();
  if (path === MEDIA_ROUTES.bytes || path.startsWith(`${MEDIA_ROUTES.bytes}/`)) {
    const assetId = path.slice(MEDIA_ROUTES.bytes.length + 1);
    if (!MEDIA_ASSET_ID_PATTERN.test(assetId)) return hiddenBytes();
    return serveBytes(request, deps, assetId, now);
  }
  if (!request.desktop) return hiddenRoute();
  if (path === MEDIA_ROUTES.reference) {
    // Loaded on use: the resolver imports this module's pinned lookup.
    const { mediaReferenceRoute } = await import("./image-reference-resolver.ts");
    return mediaReferenceRoute(request, deps);
  }
  if (path !== MEDIA_ROUTES.resolve) return hiddenRoute();
  if (request.method !== "POST") return { status: 405, headers: { ...RESOLVE_HEADERS, allow: "POST" }, body: { error: "Resolve media with POST.", code: "method-not-allowed" } };
  try {
    let body: unknown;
    try { body = await request.readBody(); } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 413) fail(413, "too-large", "That media reference is too large.");
      fail(400, "invalid-request", "Choose media from this conversation, Files or its workspace.");
    }
    return { status: 200, headers: { ...RESOLVE_HEADERS }, body: await resolveMedia(parseRef(body), deps, now) };
  } catch (error) {
    if (error instanceof MediaError) return { status: error.status, headers: { ...RESOLVE_HEADERS }, body: { error: error.message, code: error.code } };
    throw error;
  }
}
