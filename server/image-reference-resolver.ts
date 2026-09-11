// IMG-SEED (0.1.52 F5-T4, media design M4): reference images for the image
// MCP. "Seed" means a reference image; a numeric RNG seed is never accepted as
// a substitute.
//
// One flow for every source. An uploaded or generated image already in this
// conversation, a saved Files image of this conversation pinned by its
// sha256, or an image file inside this conversation's own task workspace is
// resolved to exact bytes and returned as an opaque reference id: the name of
// a conversation attachment that holds those bytes. generate_image then takes
// that id through the existing `imageReferences` allowlist, which reads the
// same attachment again, so the provider receives the original bytes.
//
// Rules:
// - Identity (bot, conversation) comes from the verified internal capability
//   or, for the desktop action, from an explicitly named conversation that
//   must hold the source. No absolute path, root, URL or credential is ever
//   accepted, and nothing crosses into another conversation.
// - Every source is validated and read before anything is written. If one
//   fails, none is prepared (all-or-nothing), before any approval or billing.
// - Files are read through a pinned handle that never follows a link; a file
//   that changes while it is read, or whose pinned revision/digest no longer
//   matches, is refused as changed.
// - Bytes are PNG, JPEG or WebP, at most 10 MiB each and 20 MiB together,
//   matching image-operations and the frozen IMAGE_REFERENCE_LIMITS.
// - A prior generated image, or saved bytes that are already an attachment of
//   this conversation, reuse that attachment instead of copying it again.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ArtifactError, describeArtifact, readArtifact } from "./artifacts.ts";
import { deleteAttachment, saveImage } from "./attachments.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import { locateWorkspaceMedia, readPinnedMediaFile, sniffMedia, type MediaAssetsDeps } from "./media-assets.ts";
import type { DelegatedRequest, DelegatedResult } from "./route-delegation.ts";
import type { Store } from "./store.ts";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import {
  IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_MIMES, isImageReferenceSource,
  type ImageReferenceErrorBody, type ImageReferenceErrorCode, type ImageReferenceMime, type ImageReferenceSource,
  type MediaReferenceResponse, type ResolveImageReferenceResponse, type ResolvedImageReference,
} from "../shared/media-assets.ts";

export type ImageReferenceDeps = MediaAssetsDeps;
/** The conversation a reference is prepared for. */
export interface ImageReferenceAudience { botId: string; threadId: string }
/** Identity taken from the verified internal capability, never the body. */
export interface ImageReferenceClaim { botId: string; threadId: string; generation: string }

/** Attachment names Murage itself writes (`<uuid>.<ext>`); .jpeg is accepted
 * as the existing reference allowlist accepts it. */
const ATTACHMENT_NAME = /^[A-Za-z0-9-]{1,160}\.(png|jpg|jpeg|webp)$/i;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

const STATUS: Record<ImageReferenceErrorCode, number> = {
  "invalid-request": 400, unavailable: 404, denied: 403, missing: 410, changed: 409, unsupported: 415, "too-large": 413, storage: 507,
};

export class ImageReferenceError extends Error {
  readonly code: ImageReferenceErrorCode;
  readonly status: number;
  readonly index?: number;
  constructor(code: ImageReferenceErrorCode, message: string, index?: number, status = STATUS[code]) {
    super(message); this.code = code; this.status = status; this.index = index;
  }
}

const NONE = "No reference image was prepared.";
function refuse(code: ImageReferenceErrorCode, reason: string, index?: number): never {
  const which = index === undefined ? "" : `Reference ${index + 1}: `;
  throw new ImageReferenceError(code, `${which}${reason} ${NONE}`, index);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const attachmentsDirectory = (deps: Pick<ImageReferenceDeps, "dataDir">) => join(deps.dataDir, "attachments");

// ---------------------------------------------------------------------------
// Which attachments belong to a conversation

/** Image attachments this exact conversation already shows: harness-stored
 * attachments (generated images, prepared references) and images the person
 * uploaded with a message (`<attached-image path>` tags the composer writes
 * into user messages). A tag only counts when it names a file directly in
 * Murage's attachment directory; a bot's text never grants an attachment.
 * Returns name -> canonical attachment path. */
export function conversationImageAttachments(store: Store, threadId: string, attachmentsDir: string): Map<string, string> {
  const allowed = new Map<string, string>();
  const add = (path: string) => {
    const name = basename(path);
    const canonical = join(attachmentsDir, name);
    if (ATTACHMENT_NAME.test(name) && resolve(path) === canonical) allowed.set(name, canonical);
  };
  for (const message of store.messagesFor(threadId)) {
    for (const item of message.attachments ?? []) if (item.kind === "image") add(item.path);
    if (message.role === "user" && typeof message.text === "string" && message.text.includes("<attached-image")) {
      for (const path of splitTranscriptAttachments(message.text).images) add(path);
    }
  }
  return allowed;
}

/** A thread's bots: its own bot, or a room's members. */
function conversationBots(store: Store, threadId: string): { botIds: string[]; ownBot?: string } | undefined {
  for (const bot of store.bots) if (bot.threadId === threadId || (bot.tasks ?? []).some(task => task.threadId === threadId)) return { botIds: [bot.id], ownBot: bot.id };
  for (const group of store.groups) if (group.threadId === threadId || (group.tasks ?? []).some(task => task.threadId === threadId)) return { botIds: [...group.memberIds] };
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading exact bytes

/** One ordinary, unlinked file directly inside `directory`, read through a
 * handle that is checked to be the same file before and after the read. */
function readDirectFile(directory: string, name: string, maxBytes: number, index: number): Buffer {
  let parent: Stats;
  try { parent = lstatSync(directory); } catch { return refuse("unavailable", "That image is not in this conversation.", index); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) refuse("denied", "Murage's attachment folder is not a private folder.", index);
  const path = join(directory, name);
  let before: Stats;
  try { before = lstatSync(path); } catch { return refuse("missing", "That image is no longer available.", index); }
  if (before.isSymbolicLink()) refuse("denied", "Linked files are never used as references.", index);
  if (!before.isFile() || before.nlink !== 1) refuse("unsupported", "That attachment is not an ordinary image file.", index);
  if (before.size > maxBytes) refuse("too-large", `Each reference image must be at most ${maxBytes / (1024 * 1024)} MB.`, index);
  let fd: number;
  try { fd = openSync(path, FLAGS); } catch { return refuse("changed", "That image changed while it was being read.", index); }
  try {
    const opened = fstatSync(fd);
    if (fingerprint(opened) !== fingerprint(before)) refuse("changed", "That image changed while it was being read.", index);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    if (offset !== bytes.length || fingerprint(fstatSync(fd)) !== fingerprint(before)) refuse("changed", "That image changed while it was being read.", index);
    return bytes;
  } finally { closeSync(fd); }
}

interface Image { mime: ImageReferenceMime; width?: number; height?: number }

/** The same decoder the reference allowlist uses, plus the byte and pixel
 * checks media previews use. Bytes are never re-encoded. */
function validImage(bytes: Buffer, index: number): Image {
  if (bytes.length > IMAGE_REFERENCE_LIMITS.maxBytesEach) refuse("too-large", `Each reference image must be at most ${IMAGE_REFERENCE_LIMITS.maxBytesEach / (1024 * 1024)} MB.`, index);
  let decoded: ReturnType<typeof decodeGeneratedImage>;
  try { decoded = decodeGeneratedImage(bytes.toString("base64")); }
  catch { return refuse("unsupported", "References must be PNG, JPEG or WebP images; this file is not a valid image.", index); }
  if (!(IMAGE_REFERENCE_MIMES as readonly string[]).includes(decoded.mime) || !decoded.bytes.equals(bytes)) {
    refuse("unsupported", "References must be PNG, JPEG or WebP images.", index);
  }
  const sniffed = sniffMedia(bytes, bytes.length);
  if (sniffed.kind !== "image" || sniffed.mime !== decoded.mime) refuse("unsupported", "References must be PNG, JPEG or WebP images; this file is not a valid image.", index);
  if (!sniffed.supported) refuse("unsupported", sniffed.reason ?? "This image cannot be used as a reference.", index);
  return { mime: decoded.mime as ImageReferenceMime, ...(sniffed.width !== undefined && sniffed.height !== undefined ? { width: sniffed.width, height: sniffed.height } : {}) };
}

interface Loaded extends Image {
  index: number;
  source: ImageReferenceSource;
  bytes: Buffer;
  sha256: string;
  /** Label for the disclosure message. */
  label: string;
  /** Existing attachment of this conversation that already holds the bytes. */
  existing?: string;
}

/** An attachment of the conversation with exactly these bytes, if any. Only
 * same-size files are hashed, so this stays bounded by real candidates. */
function existingAttachment(allowed: Map<string, string>, bytes: Buffer, digest: string): string | undefined {
  for (const [name, path] of allowed) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length) continue;
      const other = readDirectFile(resolve(path, ".."), name, IMAGE_REFERENCE_LIMITS.maxBytesEach, 0);
      if (sha256(other) === digest) return name;
    } catch { /* not a usable duplicate; the bytes are copied instead */ }
  }
  return undefined;
}

async function loadOne(source: ImageReferenceSource, index: number, audience: ImageReferenceAudience, deps: ImageReferenceDeps, allowed: Map<string, string>): Promise<Loaded> {
  const directory = attachmentsDirectory(deps);
  if (source.kind === "attachment") {
    // A name alone is never authority: it must be an image this exact
    // conversation already shows.
    if (!allowed.has(source.attachmentId)) refuse("unavailable", "That image is not in this conversation.", index);
    const bytes = readDirectFile(directory, source.attachmentId, IMAGE_REFERENCE_LIMITS.maxBytesEach, index);
    const image = validImage(bytes, index);
    return { index, source, bytes, sha256: sha256(bytes), label: source.attachmentId, existing: source.attachmentId, ...image };
  }
  if (source.kind === "artifact") {
    const storage = join(deps.dataDir, "artifact-files"), access = { owner: true, scopes: deps.artifactScopes() };
    let artifact;
    try { artifact = describeArtifact(deps.database(), storage, source.artifactId, access); }
    catch (error) { if (error instanceof ArtifactError) refuse("unavailable", "That saved file is not in this conversation.", index); throw error; }
    // A saved file is usable only by the conversation that produced it.
    if (artifact.threadId !== audience.threadId) refuse("unavailable", "That saved file is not in this conversation.", index);
    if (artifact.sha256 !== source.sha256) refuse("changed", "That saved file is a different version than the one chosen.", index);
    if (artifact.savedState === "missing") refuse("missing", "That saved file is no longer available.", index);
    if (artifact.bytes > IMAGE_REFERENCE_LIMITS.maxBytesEach) refuse("too-large", `Each reference image must be at most ${IMAGE_REFERENCE_LIMITS.maxBytesEach / (1024 * 1024)} MB.`, index);
    let bytes: Buffer;
    try { bytes = Buffer.from(readArtifact(deps.database(), storage, source.artifactId, access).bytes); }
    catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      return refuse(error.status === 410 ? "missing" : error.status === 404 ? "unavailable" : "changed", error.status === 410 ? "That saved file is no longer available." : "That saved file could not be verified.", index);
    }
    const digest = sha256(bytes);
    if (digest !== source.sha256) refuse("changed", "That saved file no longer matches its recorded digest.", index);
    const image = validImage(bytes, index);
    return { index, source, bytes, sha256: digest, label: artifact.name, existing: existingAttachment(allowed, bytes, digest), ...image };
  }
  // Workspace: the root is this conversation's own authorized workspace. The
  // lookup refuses links, private names, HOME and files outside the root.
  const located = locateWorkspaceMedia({ botId: audience.botId, threadId: audience.threadId }, source.relativePath, source.revision, deps);
  const outcome = located.outcome;
  if (outcome.state === "missing") refuse("missing", "That workspace file does not exist.", index);
  if (outcome.state === "changed") refuse("changed", "That workspace file changed since it was chosen.", index);
  if (outcome.state === "unsupported") refuse("unsupported", "That workspace path is not an ordinary image file.", index);
  if (outcome.state !== "ready") refuse("denied", "That workspace file cannot be used: it is linked, private, or outside this task's workspace.", index);
  if (outcome.stat.size > IMAGE_REFERENCE_LIMITS.maxBytesEach) refuse("too-large", `Each reference image must be at most ${IMAGE_REFERENCE_LIMITS.maxBytesEach / (1024 * 1024)} MB.`, index);
  const bytes = await readPinnedMediaFile(outcome, IMAGE_REFERENCE_LIMITS.maxBytesEach);
  if (!bytes) refuse("changed", "That workspace file changed while it was being read.", index);
  const image = validImage(bytes, index);
  const digest = sha256(bytes);
  return { index, source, bytes, sha256: digest, label: source.relativePath, existing: existingAttachment(allowed, bytes, digest), ...image };
}

function assertAudience(store: Store, audience: ImageReferenceAudience): void {
  const owner = conversationBots(store, audience.threadId);
  if (!owner || !owner.botIds.includes(audience.botId)) throw new ImageReferenceError("unavailable", `This conversation is not available. ${NONE}`);
}

/** Validate and read every source. Nothing is written. */
export async function loadImageReferences(sources: readonly unknown[], audience: ImageReferenceAudience, deps: ImageReferenceDeps): Promise<Loaded[]> {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > IMAGE_REFERENCE_LIMITS.maxCount) {
    throw new ImageReferenceError("invalid-request", `Choose one to ${IMAGE_REFERENCE_LIMITS.maxCount} reference images. ${NONE}`);
  }
  sources.forEach((source, index) => {
    if (!isImageReferenceSource(source)) refuse("invalid-request", "Name an image attachment of this conversation, a saved file with its sha256, or a relative path in this task's workspace. Absolute paths and URLs are not accepted.", index);
  });
  assertAudience(deps.store, audience);
  const allowed = conversationImageAttachments(deps.store, audience.threadId, attachmentsDirectory(deps));
  const loaded: Loaded[] = [];
  let total = 0;
  for (const [index, source] of (sources as ImageReferenceSource[]).entries()) {
    const item = await loadOne(source, index, audience, deps, allowed);
    total += item.bytes.length;
    if (total > IMAGE_REFERENCE_LIMITS.maxTotalBytes) refuse("too-large", `Reference images must total at most ${IMAGE_REFERENCE_LIMITS.maxTotalBytes / (1024 * 1024)} MB.`, index);
    loaded.push(item);
  }
  return loaded;
}

export interface PreparedImageReferences {
  references: ResolvedImageReference[];
  attachments: Array<MediaReferenceResponse["attachment"]>;
}

/** Store every loaded image that is not yet an attachment of this
 * conversation, then (for the agent path) disclose them in one transcript
 * message. Any failure removes what this call wrote: all or nothing. */
export function commitImageReferences(loaded: readonly Loaded[], audience: ImageReferenceAudience, deps: ImageReferenceDeps, options: { disclose: boolean }): PreparedImageReferences {
  const directory = attachmentsDirectory(deps);
  const created: Array<{ path: string; mime: ImageReferenceMime; label: string }> = [];
  const byDigest = new Map<string, string>();
  const names: string[] = [];
  try {
    for (const item of loaded) {
      if (item.existing) { names.push(item.existing); continue; }
      const again = byDigest.get(item.sha256);
      if (again) { names.push(again); continue; }
      let saved;
      try { saved = saveImage(item.bytes, item.mime); }
      catch (error) {
        const status = (error as { status?: number }).status;
        throw new ImageReferenceError(status === 413 ? "too-large" : "storage", `Reference ${item.index + 1}: Murage could not store a copy of the image (${status === 413 || status === 507 ? "attachment storage is full" : "local storage failed"}). ${NONE}`, item.index);
      }
      const name = basename(saved.path);
      if (resolve(saved.path) !== join(directory, name)) {
        created.push({ path: saved.path, mime: item.mime, label: item.label });
        throw new ImageReferenceError("storage", `Reference ${item.index + 1}: the stored copy landed outside Murage's attachment folder. ${NONE}`, item.index);
      }
      created.push({ path: saved.path, mime: item.mime, label: item.label });
      byDigest.set(item.sha256, name);
      names.push(name);
    }
    if (options.disclose && created.length) {
      const count = created.length === 1 ? "a reference image" : `${created.length} reference images`;
      deps.store.appendMessage(audience.threadId, { role: "bot", kind: "text",
        text: `Prepared ${count} for an image request from ${created.map(item => item.label).join(", ")}. Nothing is generated or billed until you approve the image request.`,
        attachments: created.map(item => ({ kind: "image" as const, path: item.path, mime: item.mime })) });
    }
  } catch (error) {
    for (const item of created) { try { deleteAttachment(item.path); } catch { /* accounting invalidates on failure */ } }
    if (error instanceof ImageReferenceError) throw error;
    throw new ImageReferenceError("storage", `The reference images could not be added to this conversation. ${NONE}`);
  }
  return {
    references: loaded.map((item, position) => ({
      id: names[position]!, sha256: item.sha256, mime: item.mime, bytes: item.bytes.length, source: item.source.kind,
      ...(item.width !== undefined && item.height !== undefined ? { width: item.width, height: item.height } : {}),
    })),
    attachments: loaded.map((item, position) => ({ path: join(directory, names[position]!), name: names[position]!, mime: item.mime, bytes: item.bytes.length })),
  };
}

export async function resolveImageReferences(sources: readonly unknown[], audience: ImageReferenceAudience, deps: ImageReferenceDeps, options: { disclose: boolean }): Promise<PreparedImageReferences> {
  return commitImageReferences(await loadImageReferences(sources, audience, deps), audience, deps, options);
}

// ---------------------------------------------------------------------------
// Routes

function answer(error: unknown): DelegatedResult {
  if (error instanceof ImageReferenceError) {
    const body: ImageReferenceErrorBody = { error: error.message, code: error.code, ...(error.index === undefined ? {} : { index: error.index }) };
    return { status: error.status, headers: { ...HEADERS }, body };
  }
  throw error;
}

async function body(request: DelegatedRequest): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.readBody(); }
  catch (error) {
    if ((error as { status?: unknown } | null)?.status === 413) throw new ImageReferenceError("too-large", `That request is too large. ${NONE}`);
    throw new ImageReferenceError("invalid-request", `The request was not valid JSON. ${NONE}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImageReferenceError("invalid-request", `The request must be a JSON object. ${NONE}`);
  return value as Record<string, unknown>;
}

/** POST /api/internal/resolve-image-reference, reached only after
 * server/index.ts verified an active agents capability for this turn.
 * Body: `{source}` or `{sources:[...]}` (1-4). The prepared images are shown
 * in the conversation before any approval is requested. */
export async function resolveImageReferenceRoute(request: DelegatedRequest, claim: ImageReferenceClaim, deps: ImageReferenceDeps): Promise<DelegatedResult> {
  if (request.method !== "POST") return { status: 405, headers: { ...HEADERS, allow: "POST" }, body: { error: "resolve-image-reference requires POST", code: "invalid-request" } };
  try {
    const value = await body(request), keys = Object.keys(value);
    const single = keys.length === 1 && keys[0] === "source";
    if (!single && !(keys.length === 1 && keys[0] === "sources" && Array.isArray(value.sources))) {
      throw new ImageReferenceError("invalid-request", `Send {"source": ...} or {"sources": [...]}. ${NONE}`);
    }
    const sources = single ? [value.source] : value.sources as unknown[];
    const prepared = await resolveImageReferences(sources, { botId: claim.botId, threadId: claim.threadId }, deps, { disclose: true });
    const response: ResolveImageReferenceResponse = { references: prepared.references, ...(single ? { reference: prepared.references[0] } : {}) };
    return { status: 200, headers: { ...HEADERS }, body: response };
  } catch (error) { return answer(error); }
}

/** POST /api/media/reference (desktop proof checked by mediaAssetsRoute and
 * DESKTOP_AUTHORITY_ROUTES): the owner's "Use as reference". The image is
 * pinned into an attachment of the named conversation, which the owner's
 * next message carries; the composer chip is the disclosure, so no transcript
 * entry is written here. Nothing is generated or billed. */
export async function mediaReferenceRoute(request: DelegatedRequest, deps: ImageReferenceDeps): Promise<DelegatedResult> {
  if (request.method !== "POST") return { status: 405, headers: { ...HEADERS, allow: "POST" }, body: { error: "Use an image as a reference with POST.", code: "invalid-request" } };
  try {
    const value = await body(request), keys = Object.keys(value).sort().join(",");
    if (keys !== "source,threadId" && keys !== "botId,source,threadId") throw new ImageReferenceError("invalid-request", `Name the conversation and one image. ${NONE}`);
    if (typeof value.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.threadId)) throw new ImageReferenceError("invalid-request", `Name the conversation and one image. ${NONE}`);
    if (value.botId !== undefined && (typeof value.botId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.botId))) throw new ImageReferenceError("invalid-request", `Name the conversation and one image. ${NONE}`);
    const owner = conversationBots(deps.store, value.threadId);
    if (!owner) throw new ImageReferenceError("unavailable", `This conversation is not available. ${NONE}`);
    const botId = (value.botId as string | undefined) ?? owner.ownBot ?? (isImageReferenceSource(value.source) && value.source.kind !== "workspace" ? owner.botIds[0] : undefined);
    if (!botId) throw new ImageReferenceError("invalid-request", `Choose which room member's workspace holds the file. ${NONE}`);
    const prepared = await resolveImageReferences([value.source], { botId, threadId: value.threadId }, deps, { disclose: false });
    const response: MediaReferenceResponse = { reference: prepared.references[0]!, attachment: prepared.attachments[0]! };
    return { status: 200, headers: { ...HEADERS }, body: response };
  } catch (error) { return answer(error); }
}
