// Incoming images are authorized by server-owned message metadata or an
// upload bound to this exact conversation. Text paths never grant a read.
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import type { Store, Message } from "./store.ts";
import type { SendTurnInput } from "./contracts.ts";
import { readPinnedMediaFile, sniffMedia } from "./media-assets.ts";
import { IMAGE_REFERENCE_MIMES, TURN_IMAGE_LIMITS } from "../shared/media-assets.ts";
import { splitTranscriptAttachments, withoutImageTags } from "../src/lib/composer-attachments.ts";

export { withoutImageTags };

type Attachment = NonNullable<Message["attachments"]>[number];
export const TURN_IMAGE_UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const TURN_IMAGE_UPLOAD_CAP = 256;
const fail = () => Object.assign(new Error("This image is unavailable for this conversation. Reattach the image and send again."), { status: 400 });
/** The refusal for an image this conversation may not read (Fuigo's rule
 * for an unbound tag, unboundImagePolicy). */
export const turnImageUnavailable = fail;
const invalid = () => Object.assign(new Error("Attach a valid PNG, JPEG or WebP image."), { status: 415 });

/** Make an image fit: `"fits"` when it already does (no larger than
 * `maxBytes`, no side longer than `maxEdge`), new bytes that do, or null when
 * it cannot be made to (no resizer, an animation, an undecodable file).
 * server/image-thumbnail.ts `sharpShrink` is the real one. */
export type Shrink = (bytes: Buffer, target: { maxBytes: number; maxEdge: number }) => Promise<{ bytes: Buffer } | "fits" | null>;

/** What an engine takes for one picture.
 *  - hardMaxBytes: above this the engine refuses the image, so with no way
 *    to shrink it the image is left out.
 *  - targetBytes / maxEdge: what Murage shrinks to when it can. Anthropic
 *    refuses an image over 5 MB of base64, and one over 2000 px on a side
 *    once a request holds more than 20 images, which a resumed session
 *    reaches after two or three turns of ten. Every engine gets that target
 *    when a resizer is available: an ACP engine on Flux can be answered by a
 *    Claude model, and 2000 px is more than any model looks at. */
export interface TurnImageFit { hardMaxBytes: number; targetBytes: number; maxEdge: number }
/** 5 MB of base64. Claude Code refuses anything larger before it sends
 * (maxBase64Size 5242880, read from the 2.1.284 binary). */
const ANTHROPIC_IMAGE_MAX_RAW_BYTES = 5 * 1024 * 1024 * 3 / 4;
export const DEFAULT_TURN_IMAGE_FIT: TurnImageFit = { hardMaxBytes: TURN_IMAGE_LIMITS.maxBytesEach, targetBytes: ANTHROPIC_IMAGE_MAX_RAW_BYTES, maxEdge: 2000 };
export const CLAUDE_TURN_IMAGE_FIT: TurnImageFit = { hardMaxBytes: ANTHROPIC_IMAGE_MAX_RAW_BYTES, targetBytes: ANTHROPIC_IMAGE_MAX_RAW_BYTES, maxEdge: 2000 };
/** Below this much budget no picture is worth shrinking into it. */
const MIN_IMAGE_BUDGET = 64 * 1024;

/** The first `TURN_IMAGE_LIMITS.maxCount` distinct image paths a turn's text
 * names, in order, and the rest. Nothing is read or checked here: a path past
 * the count is left out of the turn whatever it is, and its tag is removed
 * from the text the bot receives (withoutImageTags). */
export function limitTurnImagePaths(text: string): { kept: string[]; overCount: string[] } {
  const paths = [...new Set(splitTranscriptAttachments(text).images)];
  return { kept: paths.slice(0, TURN_IMAGE_LIMITS.maxCount), overCount: paths.slice(TURN_IMAGE_LIMITS.maxCount) };
}

export interface CollectedTurnImages {
  images: NonNullable<SendTurnInput["images"]>;
  /** Canonical uploads this conversation never bound: carried as text by
   * most engines, a refusal on Fuigo (unboundImagePolicy). */
  unbound: string[];
  /** Past the per-turn count: left out unread. */
  overCount: string[];
  /** Did not fit the per-image ceiling or the turn's byte budget: left out. */
  tooLarge: string[];
}

/** Validate actual ownership, including detached tasks and room membership. */
export function turnImageAudience(store: Store, threadId: string, botId?: string): boolean {
  const direct = store.bots.find(bot => !bot.hidden && (bot.threadId === threadId || bot.tasks?.some(task => task.threadId === threadId)));
  if (direct) return !botId || direct.id === botId;
  const room = store.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
  return Boolean(room && room.memberIds.some(id => (!botId || id === botId) && store.bots.some(bot => bot.id === id && !bot.hidden)));
}

export class TurnImages {
  private pending = new Map<string, { threadId: string; item: Attachment; expires: number }>();
  private readonly store: Store;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly shrink: () => Promise<Shrink | null>;
  constructor(store: Store, dataDir: string, now = Date.now, shrink: () => Promise<Shrink | null> = async () => null) { this.store = store; this.dataDir = dataDir; this.now = now; this.shrink = shrink; }
  private canonical(path: string): boolean {
    return /^[A-Za-z0-9-]{1,160}\.(png|jpe?g|webp)$/i.test(basename(path)) && path === join(this.dataDir, "attachments", basename(path));
  }
  private prune() {
    for (const [key, entry] of this.pending) {
      if (entry.expires <= this.now() || this.store.messagesFor(entry.threadId).some(message => message.attachments?.some(item => item.path === entry.item.path))) this.pending.delete(key);
    }
  }
  register(threadId: string, saved: { path: string; mime: string }): void {
    if (!turnImageAudience(this.store, threadId) || !this.canonical(saved.path)) throw fail();
    this.prune();
    const key = `${threadId}\0${saved.path}`;
    if (!this.pending.has(key) && this.pending.size >= TURN_IMAGE_UPLOAD_CAP) throw Object.assign(new Error("Too many pending image uploads. Send an existing draft or try again later."), { status: 429 });
    this.pending.set(key, { threadId, item: { kind: "image", ...saved }, expires: this.now() + TURN_IMAGE_UPLOAD_TTL });
  }
  /** Called at user append. Non-image and legacy callers retain their text;
   * ACP dispatch below explicitly refuses any unbound selected image. */
  promote(threadId: string, text: string): Attachment[] {
    // A turn that references no image is not an image request: an archived
    // bot still takes its own direct and webhook turns, and a refusal here
    // would name an image the person never attached.
    const paths = [...new Set(splitTranscriptAttachments(text).images)];
    if (!paths.length) return [];
    if (!turnImageAudience(this.store, threadId)) throw fail();
    this.prune();
    const historical = new Map(this.store.messagesFor(threadId).flatMap(message => (message.attachments ?? []).map(item => [item.path, item] as const)));
    return paths.flatMap(path => {
      if (!this.canonical(path)) return [];
      const item = historical.get(path) ?? this.pending.get(`${threadId}\0${path}`)?.item;
      return item ? [{ kind: "image" as const, path: item.path, mime: item.mime }] : [];
    });
  }
  /** The bytes for every image this conversation is allowed to inline, and
   * the canonical paths it is not. Every other refusal still throws.
   *
   * Two things can be wrong with an `<attached-image path>` and they are not
   * the same thing:
   *  - the path is not one Murage wrote into its attachments directory, or
   *    it is a link, a hard-linked alias or a masquerading file. That is
   *    refused, as it always was, whatever the engine.
   *  - the path IS one of Murage's own uploads, but nothing bound it to this
   *    conversation: a legacy upload the composer made without a thread, or
   *    a tag carried in from another thread. No bytes are read on the text's
   *    say-so — that is the invariant in this file's header — but the tag is
   *    still in the message, and until 0.1.55 every engine other than Fuigo
   *    simply received it as text and opened the file with its own tools.
   *    Those paths come back in `unbound` so the dispatch can keep doing
   *    exactly that instead of losing the whole turn.
   *
   * How many and how large are never a refusal (0.1.61). "Attach at most four
   * images per turn." failed whole turns, and Retry sent the same text into
   * the same wall. Past the count, and once the byte budget runs out, images
   * are left out in order and named in `overCount` and `tooLarge`; the
   * dispatch removes their tags and tells the owner in one line. Only the
   * first `maxCount` paths are looked at, so a path past the count is never
   * checked or read: it cannot reach the bot either way. */
  async collect(threadId: string, botId: string, text: string, fit: TurnImageFit = DEFAULT_TURN_IMAGE_FIT): Promise<CollectedTurnImages> {
    const { kept: paths, overCount } = limitTurnImagePaths(text);
    const images: CollectedTurnImages["images"] = [];
    const unbound: string[] = [];
    const tooLarge: string[] = [];
    if (!paths.length) return { images, unbound, overCount, tooLarge };
    if (!turnImageAudience(this.store, threadId, botId)) throw fail();
    const allowed = new Set(this.store.messagesFor(threadId).flatMap(message => (message.attachments ?? []).map(item => item.path)));
    const shrink = await this.shrink().catch(() => null);
    let total = 0;
    for (const [index, path] of paths.entries()) {
      if (!this.canonical(path)) throw fail();
      if (!allowed.has(path)) { unbound.push(path); continue; }
      const directory = join(this.dataDir, "attachments");
      let parent, stat;
      try { parent = lstatSync(directory); stat = lstatSync(path); } catch { throw fail(); }
      if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
      const remaining = TURN_IMAGE_LIMITS.maxTotalBytes - total;
      // The budget is spent: this image and every one after it stay out, so
      // what the bot sees is the first images in order, never a gap.
      const rest = () => { tooLarge.push(...paths.slice(index)); };
      if (remaining < MIN_IMAGE_BUDGET) { rest(); break; }
      // Read only what can be sent or shrunk; anything larger stays out unread.
      const readable = shrink ? TURN_IMAGE_LIMITS.maxReadBytes : fit.hardMaxBytes;
      if (stat.size > readable) { tooLarge.push(path); continue; }
      const bytes = await readPinnedMediaFile({ state: "ready", path, stat, observed: [[directory, parent]] }, readable);
      if (!bytes || !turnImageAudience(this.store, threadId, botId)) throw fail();
      const sniffed = sniffMedia(bytes, bytes.length);
      if (!sniffed.supported || sniffed.kind !== "image" || !(IMAGE_REFERENCE_MIMES as readonly string[]).includes(sniffed.mime)) throw invalid();
      let picture: { bytes: Buffer; mime: string } | null = null;
      if (shrink) {
        const made = await shrink(bytes, { maxBytes: Math.min(fit.targetBytes, remaining), maxEdge: fit.maxEdge }).catch(() => null);
        if (made === "fits") picture = { bytes, mime: sniffed.mime };
        else if (made) {
          // The resizer's output is checked like any upload before it rides.
          const out = sniffMedia(made.bytes, made.bytes.length);
          if (!out.supported || out.kind !== "image" || !(IMAGE_REFERENCE_MIMES as readonly string[]).includes(out.mime)) throw invalid();
          if (made.bytes.length <= Math.min(fit.hardMaxBytes, remaining)) picture = { bytes: made.bytes, mime: out.mime };
        }
      }
      if (!picture && bytes.length <= Math.min(fit.hardMaxBytes, remaining)) picture = { bytes, mime: sniffed.mime };
      if (!picture) {
        // Too large for any engine to take on its own: only this one is out.
        // Too large for what is left of the budget: this one and the rest.
        if (bytes.length > fit.hardMaxBytes) { tooLarge.push(path); continue; }
        rest(); break;
      }
      total += picture.bytes.length;
      images.push({ mimeType: picture.mime, data: picture.bytes.toString("base64") });
    }
    return { images, unbound, overCount, tooLarge };
  }
  /** `collect`, but an unbound path is a refusal of the whole turn. This is
   * what the Fuigo dispatch has done since inline images arrived; see
   * `unboundImagePolicy` in turn-image-dispatch.ts for which engines keep it. */
  async read(threadId: string, botId: string, text: string, fit?: TurnImageFit): Promise<NonNullable<SendTurnInput["images"]>> {
    const { images, unbound } = await this.collect(threadId, botId, text, fit);
    if (unbound.length) throw fail();
    return images;
  }
}
