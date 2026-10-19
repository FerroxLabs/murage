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
// - Bytes are PNG, JPEG or WebP, at most 10 MiB each (the frozen
//   IMAGE_REFERENCE_LIMITS), up to IMAGE_GENERATION_REFERENCE_MAX sources and
//   64 MiB together, matching image-operations. Each model's own lower caps
//   are enforced by generate_image before its approval card.
// - A prior generated image, or saved bytes that are already an attachment of
//   this conversation, reuse that attachment instead of copying it again.
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { attachmentNameOf, attachmentsHomeOf, probeAttachment, readAttachmentFile, storedPathOf, type AttachmentsHome } from "./attachment-read.ts";
import { ArtifactError, describeArtifact, readArtifact } from "./artifacts.ts";
import { deleteAttachment, saveImage } from "./attachments.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import { locateWorkspaceMedia, readPinnedMediaFile, sniffMedia, type MediaAssetsDeps } from "./media-assets.ts";
import type { DelegatedRequest, DelegatedResult } from "./route-delegation.ts";
import type { Store } from "./store.ts";
import {
  IMAGE_GENERATION_REFERENCE_MAX, IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES, IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_MIMES, isImageReferenceSource,
  type ImageReferenceErrorBody, type ImageReferenceErrorCode, type ImageReferenceMime, type ImageReferenceSource,
  type MediaReferenceResponse, type ResolveImageReferenceResponse, type ResolvedImageReference,
} from "../shared/media-assets.ts";

export type ImageReferenceDeps = MediaAssetsDeps & {
  /** Throws when the turn that asked is no longer live; asked again after the reads, before anything is written. */
  assertLive?: () => void;
};
/** The conversation a reference is prepared for. */
export interface ImageReferenceAudience { botId: string; threadId: string }
/** Identity taken from the verified internal capability, never the body. */
export interface ImageReferenceClaim { botId: string; threadId: string; generation: string }

/** Attachment names Murage itself writes (`<uuid>.<ext>`); .jpeg is accepted
 * as the existing reference allowlist accepts it. */
const ATTACHMENT_NAME = /^[A-Za-z0-9-]{1,160}\.(png|jpg|jpeg|webp)$/i;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;

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
const attachmentsHome = (deps: Pick<ImageReferenceDeps, "dataDir">) => attachmentsHomeOf(deps.dataDir);

// ---------------------------------------------------------------------------
// Which attachments belong to a conversation

/** How many of the conversation's newest pictures a request's bytes are compared with for a duplicate. */
const DUPLICATE_CANDIDATES = 64;
/** At most this many same-size candidates are read for a duplicate; past it the bytes are stored as a copy. */
export const DUPLICATE_READS = 4;

/** Image attachments this exact conversation already shows: harness-stored
 * attachments (generated images, prepared references) and images the person
 * uploaded with a message (`<attached-image path>` tags the composer writes
 * into user messages). A tag only counts when it names a file directly in
 * Murage's attachment directory; a bot's text never grants an attachment.
 * Read without loading the conversation: the images `asked` about (names) are
 * found through the message_image index however far back they are, by attachment
 * or by tag (the thread's fill, branch-store.ts, put the older rows there).
 * Returns name -> canonical attachment path: the names asked, and the newest pictures the conversation holds. */
export function conversationImageAttachments(store: Store, threadId: string, home: AttachmentsHome, asked: readonly string[] = []): Map<string, string> {
  const allowed = new Map<string, string>();
  const add = (path: string) => {
    const name = attachmentNameOf(home, path);
    if (name && ATTACHMENT_NAME.test(name)) allowed.set(name, storedPathOf(home, name));
  };
  // the images asked about, found by the message_image index wherever in the conversation they are named: an attachment
  // a message carries, or the tag the composer wrote into an upload's text
  const paths = asked.filter(name => ATTACHMENT_NAME.test(name)).map(name => storedPathOf(home, name));
  for (const [path, item] of store.boundAttachments(threadId, paths)) if (item.kind === "image") add(path);
  for (const path of store.imagePathsNamed(threadId, paths)) add(path);
  // and the conversation's newest pictures, the candidates a duplicate is looked for among (a copy of an older one is stored again, harmlessly)
  for (const path of store.recentImagePaths(threadId, DUPLICATE_CANDIDATES)) add(path);
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

/** One attachment through the bounded reader (attachment-read.ts). */
async function readAttachmentReference(home: AttachmentsHome, name: string, maxBytes: number, index: number): Promise<Buffer> {
  const read = await readAttachmentFile(home, name, maxBytes);
  if (read.ok) return read.bytes;
  if (read.reason === "missing") refuse("missing", "That image is no longer available.", index);
  if (read.reason === "not-regular") refuse("unsupported", "That attachment is not an ordinary image file.", index);
  if (read.reason === "too-large") refuse("too-large", `Each reference image must be at most ${maxBytes / (1024 * 1024)} MB.`, index);
  return refuse("changed", "That image changed while it was being read.", index);
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

/** An attachment of the conversation with exactly these bytes, if any.
 * Candidates are filtered by size without opening anything; at most
 * DUPLICATE_READS same-size files are read, one at a time. */
async function existingAttachment(home: AttachmentsHome, allowed: Map<string, string>, bytes: Buffer, digest: string): Promise<string | undefined> {
  let reads = 0;
  for (const name of allowed.keys()) {
    const probe = await probeAttachment(home, name, IMAGE_REFERENCE_LIMITS.maxBytesEach);
    if (!probe.ok || probe.id.size !== BigInt(bytes.length)) continue;
    if (reads >= DUPLICATE_READS) break; // stored as a copy instead, harmlessly
    reads++;
    const other = await readAttachmentFile(home, name, IMAGE_REFERENCE_LIMITS.maxBytesEach);
    if (other.ok && sha256(other.bytes) === digest) return name;
  }
  return undefined;
}

async function loadOne(source: ImageReferenceSource, index: number, audience: ImageReferenceAudience, deps: ImageReferenceDeps, allowed: Map<string, string>): Promise<Loaded> {
  const home = attachmentsHome(deps);
  if (source.kind === "attachment") {
    // A name alone is never authority: it must be an image this exact
    // conversation already shows.
    if (!allowed.has(source.attachmentId)) refuse("unavailable", "That image is not in this conversation.", index);
    const bytes = await readAttachmentReference(home, source.attachmentId, IMAGE_REFERENCE_LIMITS.maxBytesEach, index);
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
    return { index, source, bytes, sha256: digest, label: artifact.name, existing: await existingAttachment(home, allowed, bytes, digest), ...image };
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
  return { index, source, bytes, sha256: digest, label: source.relativePath, existing: await existingAttachment(home, allowed, bytes, digest), ...image };
}

function assertAudience(store: Store, audience: ImageReferenceAudience): void {
  const owner = conversationBots(store, audience.threadId);
  if (!owner || !owner.botIds.includes(audience.botId)) throw new ImageReferenceError("unavailable", `This conversation is not available. ${NONE}`);
}

/** Validate and read every source. Nothing is written. */
export async function loadImageReferences(sources: readonly unknown[], audience: ImageReferenceAudience, deps: ImageReferenceDeps): Promise<Loaded[]> {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > IMAGE_GENERATION_REFERENCE_MAX) {
    throw new ImageReferenceError("invalid-request", `Choose one to ${IMAGE_GENERATION_REFERENCE_MAX} reference images. ${NONE}`);
  }
  sources.forEach((source, index) => {
    if (!isImageReferenceSource(source)) refuse("invalid-request", "Name an image attachment of this conversation, a saved file with its sha256, or a relative path in this task's workspace. Absolute paths and URLs are not accepted.", index);
  });
  assertAudience(deps.store, audience);
  const allowed = conversationImageAttachments(deps.store, audience.threadId, attachmentsHome(deps),
    (sources as ImageReferenceSource[]).flatMap(source => source.kind === "attachment" ? [source.attachmentId] : []));
  const loaded: Loaded[] = [];
  let total = 0;
  for (const [index, source] of (sources as ImageReferenceSource[]).entries()) {
    const item = await loadOne(source, index, audience, deps, allowed);
    total += item.bytes.length;
    if (total > IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES) refuse("too-large", `Reference images must total at most ${IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`, index);
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
  const home = attachmentsHome(deps);
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
      if (attachmentNameOf(home, saved.path) !== name) {
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
        text: `Prepared ${count} for an image request from ${created.map(item => item.label).join(", ")}. Nothing is generated until you approve the image request.`,
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
    attachments: loaded.map((item, position) => ({ path: storedPathOf(home, names[position]!), name: names[position]!, mime: item.mime, bytes: item.bytes.length })),
  };
}

export async function resolveImageReferences(sources: readonly unknown[], audience: ImageReferenceAudience, deps: ImageReferenceDeps, options: { disclose: boolean }): Promise<PreparedImageReferences> {
  const loaded = await loadImageReferences(sources, audience, deps);
  // The reads awaited: the conversation, every attachment read and every
  // duplicate chosen must still be there, and the turn still live, before a
  // single attachment or message is written.
  assertAudience(deps.store, audience);
  const names = loaded.flatMap(item => [...(item.source.kind === "attachment" ? [item.source.attachmentId] : []), ...(item.existing ? [item.existing] : [])]);
  if (names.length) {
    const still = conversationImageAttachments(deps.store, audience.threadId, attachmentsHome(deps), names);
    if (names.some(name => !still.has(name))) throw new ImageReferenceError("unavailable", `That image is not in this conversation. ${NONE}`);
  }
  deps.assertLive?.();
  return commitImageReferences(loaded, audience, deps, options);
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
