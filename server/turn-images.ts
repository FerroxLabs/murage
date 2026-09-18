// Incoming images are authorized by server-owned message metadata or an
// upload bound to this exact conversation. Text paths never grant a read.
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import type { Store, Message } from "./store.ts";
import type { SendTurnInput } from "./contracts.ts";
import { readPinnedMediaFile, sniffMedia } from "./media-assets.ts";
import { IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_MIMES } from "../shared/media-assets.ts";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";

type Attachment = NonNullable<Message["attachments"]>[number];
export const TURN_IMAGE_UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const TURN_IMAGE_UPLOAD_CAP = 256;
const fail = () => Object.assign(new Error("This image is unavailable for this conversation. Reattach the image and send again."), { status: 400 });

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
  constructor(store: Store, dataDir: string, now = Date.now) { this.store = store; this.dataDir = dataDir; this.now = now; }
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
   *    it is a link, a hard-linked alias, a masquerading file, or over
   *    budget. That is refused, as it always was, whatever the engine.
   *  - the path IS one of Murage's own uploads, but nothing bound it to this
   *    conversation: a legacy upload the composer made without a thread, or
   *    a tag carried in from another thread. No bytes are read on the text's
   *    say-so — that is the invariant in this file's header — but the tag is
   *    still in the message, and until 0.1.55 every engine other than Fuigo
   *    simply received it as text and opened the file with its own tools.
   *    Those paths come back in `unbound` so the dispatch can keep doing
   *    exactly that instead of losing the whole turn. */
  async collect(threadId: string, botId: string, text: string): Promise<{ images: NonNullable<SendTurnInput["images"]>; unbound: string[] }> {
    const paths = [...new Set(splitTranscriptAttachments(text).images)];
    if (!paths.length) return { images: [], unbound: [] };
    if (!turnImageAudience(this.store, threadId, botId)) throw fail();
    if (paths.length > IMAGE_REFERENCE_LIMITS.maxCount) throw Object.assign(new Error("Attach at most four images per turn."), { status: 413 });
    const allowed = new Set(this.store.messagesFor(threadId).flatMap(message => (message.attachments ?? []).map(item => item.path)));
    const images: NonNullable<SendTurnInput["images"]> = [];
    const unbound: string[] = [];
    let total = 0;
    for (const path of paths) {
      if (!this.canonical(path)) throw fail();
      if (!allowed.has(path)) { unbound.push(path); continue; }
      const directory = join(this.dataDir, "attachments");
      let parent, stat;
      try { parent = lstatSync(directory); stat = lstatSync(path); } catch { throw fail(); }
      if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
      total += stat.size;
      if (stat.size > IMAGE_REFERENCE_LIMITS.maxBytesEach || total > IMAGE_REFERENCE_LIMITS.maxTotalBytes) throw Object.assign(new Error("Images must be at most 10 MB each and 20 MB per turn."), { status: 413 });
      const bytes = await readPinnedMediaFile({ state: "ready", path, stat, observed: [[directory, parent]] }, IMAGE_REFERENCE_LIMITS.maxBytesEach);
      if (!bytes || !turnImageAudience(this.store, threadId, botId)) throw fail();
      const sniffed = sniffMedia(bytes, bytes.length);
      if (!sniffed.supported || sniffed.kind !== "image" || !(IMAGE_REFERENCE_MIMES as readonly string[]).includes(sniffed.mime)) throw Object.assign(new Error("Attach a valid PNG, JPEG or WebP image."), { status: 415 });
      images.push({ mimeType: sniffed.mime, data: bytes.toString("base64") });
    }
    return { images, unbound };
  }
  /** `collect`, but an unbound path is a refusal of the whole turn. This is
   * what the Fuigo dispatch has done since inline images arrived; see
   * `unboundImagePolicy` in turn-image-dispatch.ts for which engines keep it. */
  async read(threadId: string, botId: string, text: string): Promise<NonNullable<SendTurnInput["images"]>> {
    const { images, unbound } = await this.collect(threadId, botId, text);
    if (unbound.length) throw fail();
    return images;
  }
}
