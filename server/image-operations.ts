import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import type { Store } from "./store.ts";
import { database } from "./database.ts";
import { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, saveImage } from "./attachments.ts";
import { DATA_DIR } from "./config.ts";
import type { ImageOperationDetails, ImageAttemptOutcome, ImageReference, GeneratedImageMetadata } from "./image-generation.ts";
import type { DecodedGeneratedImage } from "./generated-image.ts";
import { decodeGeneratedImage } from "./generated-image.ts";

export interface ImageActor { botId: string; threadId: string; generation: string; assertActive: () => void; signal: AbortSignal }
interface Pending { threadId: string; botId: string; messageId: string; settle: (allow: boolean) => void; active: () => void }
const error = (status: number, message: string) => Object.assign(new Error(message), { status });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, file: string) { const tail = relative(root, file); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); }
/** No caller path is accepted. References must already belong to this exact conversation. */
export function imageReferences(store: Store, threadId: string, names: unknown): ImageReference[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > 4 || names.some(name => typeof name !== "string" || !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(name))) throw error(400, "Choose up to four image attachments from this conversation.");
  const allowed = new Set(store.messagesFor(threadId).flatMap(message => message.attachments ?? []).filter(item => item.kind === "image").map(item => item.path));
  let total = 0;
  return names.map(name => {
    const file = join(ATTACHMENTS_DIR, name), root = realpathSync(ATTACHMENTS_DIR);
    const stat = lstatSync(file);
    if (!allowed.has(file) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(root, realpathSync(file)) || stat.size > IMAGE_MAX_BYTES) throw error(403, "Image reference is unavailable in this conversation.");
    const decoded = decodeGeneratedImage(readFileSync(file).toString("base64")); total += decoded.bytes.length;
    if (total > 20 * 1024 * 1024 || decoded.mime === "image/gif") throw error(400, "References must be PNG, JPEG or WebP and total at most 20 MB.");
    return { bytes: decoded.bytes, mime: decoded.mime };
  });
}
function imageWorkspace(botId: string): string {
  if (!/^[\w-]{1,160}$/.test(botId)) throw error(403, "Invalid image workspace.");
  const root = realpathSync(DATA_DIR);
  let directory = root;
  for (const part of ["workspaces", botId, "generated-images"]) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, realpathSync(directory))) throw error(403, "Generated-image workspace is not a private directory.");
  }
  return directory;
}
export interface ImageArtifact { id: string; path: string; url: string; mime: string; bytes: number; referenceId: string }
/** Uses the existing conversation/attachment flow. No async gap during authority + artifact commit. */
export function publishImage(store: Store, actor: ImageActor, image: DecodedGeneratedImage, metadata: GeneratedImageMetadata): ImageArtifact {
  actor.assertActive();
  if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
  const directory = imageWorkspace(actor.botId), id = randomUUID();
  const ext = image.mime === "image/jpeg" ? "jpg" : image.mime.split("/")[1];
  const path = join(directory, `${id}.${ext}`), partial = join(directory, `.${id}.partial`);
  // Directory/ref checks are repeated immediately before the synchronous commit.
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw error(403, "Image workspace changed.");
  actor.assertActive();
  try { writeFileSync(partial, image.bytes, { mode: 0o600, flag: "wx" }); renameSync(partial, path); }
  catch (e) { try { unlinkSync(partial); } catch {} throw e; }
  const saved = saveImage(image.bytes, image.mime, id);
  const artifact = { id, path, url: `/api/attachments/${basename(saved.path)}`, mime: saved.mime, bytes: saved.bytes, referenceId: basename(saved.path) };
  store.appendMessage(actor.threadId, { role: "bot", kind: "text", text: `Image created with ${metadata.model} through ${metadata.provider}.`,
    attachments: [{ kind: "image", path: saved.path, mime: saved.mime }] });
  return artifact;
}

/** One explicit count grant, one attempt per turn, one active operation per bot workspace. */
export class ImageOperations {
  private readonly store: Store;
  private readonly waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string) => void;
  private readonly pending = new Map<string, Pending>();
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly workspaces = new Set<string>();
  constructor(options: { store: Store; waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string) => void }) {
    this.store = options.store; this.waiting = options.waiting;
  }
  private db() {
    const db = database();
    db.exec("CREATE TABLE IF NOT EXISTS image_operations(id TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");
    return db;
  }
  execute<T>(actor: ImageActor, requestId: string, request: unknown, work: (reserve: (details: ImageOperationDetails) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void }>) => Promise<T>): Promise<T> {
    actor.assertActive();
    if (!/^[\w-]{1,80}$/.test(requestId)) throw error(400, "A stable request_id is required for image generation.");
    const id = hash(`${actor.botId}:${actor.threadId}:${actor.generation}:${requestId}`), requestHash = hash(JSON.stringify(request));
    const prior = this.db().prepare("SELECT request_hash,state,result FROM image_operations WHERE id=?").get(id) as { request_hash: string; state: string; result: string | null } | undefined;
    if (prior?.request_hash !== undefined && prior.request_hash !== requestHash) throw error(409, "This image request ID was already used for a different request.");
    if (this.jobs.has(id)) return this.jobs.get(id) as Promise<T>;
    if (prior?.state === "published" && prior.result) return Promise.resolve(JSON.parse(prior.result) as T);
    if (prior) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    if (this.db().prepare("SELECT id FROM image_operations WHERE generation=?").get(actor.generation)) throw error(429, "One image attempt is allowed per turn. Start a new task or turn for another image.");
    this.db().prepare("INSERT INTO image_operations VALUES(?,?,?,'awaiting',NULL,?)").run(id, actor.generation, requestHash, Date.now());
    this.workspaces.add(actor.botId);
    const record = (state: string, result: unknown = null) => { this.db().prepare("UPDATE image_operations SET state=?,result=?,updated_at=? WHERE id=?").run(state, result === null ? null : JSON.stringify(result), Date.now(), id); };
    const job = Promise.resolve().then(() => work(async details => {
      actor.assertActive();
      const approved = await this.approve(actor, details, request);
      actor.assertActive();
      if (!approved || actor.signal.aborted) { record("not-dispatched"); throw error(403, "Image generation was not approved; no image request was sent."); }
      record("running");
      return { finish: (outcome: ImageAttemptOutcome) => record(outcome) };
    })).then(result => { record("published", result); return result; }).catch(e => {
      const row = this.db().prepare("SELECT state FROM image_operations WHERE id=?").get(id) as {state:string};
      if (row.state === "awaiting") record("not-dispatched"); else if (row.state === "running") record("uncertain");
      throw e;
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); });
    this.jobs.set(id, job); return job;
  }
  private approve(actor: ImageActor, details: ImageOperationDetails, request: unknown): Promise<boolean> {
    const requestId = `image-${randomUUID()}`;
    const prompt = request && typeof request === "object" && "prompt" in request ? String(request.prompt) : "";
    const card = this.store.appendMessage(actor.threadId, { role: "bot", kind: "options", card: {
      title: details.operation === "edit" ? "Approve image edit" : "Approve image generation",
      subtitle: `One image · ${details.connectionId} · ${details.model}${details.quality ? ` · ${details.quality}` : ""}${details.size ? ` · ${details.size}` : ""}. Provider charges apply; exact cost is not available.`,
      held: prompt, options: ["Allow", "Deny"], requestId, tool: "generate_image",
    } });
    this.waiting(actor.threadId, true, requestId, card.id);
    return new Promise(resolve => {
      let settled = false;
      const finish = (allow: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer); actor.signal.removeEventListener("abort", abort); this.pending.delete(requestId);
        const current = this.store.messagesFor(actor.threadId).find(message => message.id === card.id);
        if (current?.card && !current.card.answered) this.store.patchMessage(actor.threadId, card.id, { card: { ...current.card, answered: allow ? "allow" : "deny", dismissed: !allow } });
        this.waiting(actor.threadId, false, requestId); resolve(allow);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 60_000); timer.unref();
      this.pending.set(requestId, { threadId: actor.threadId, botId: actor.botId, messageId: card.id, settle: finish, active: actor.assertActive });
      actor.signal.addEventListener("abort", abort, { once: true });
      if (actor.signal.aborted) abort();
    });
  }
  resolve(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer"): "allowed-once" | "rejected" | "unavailable" | null {
    if (!requestId.startsWith("image-")) return null;
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId || behavior === "answer") return "unavailable";
    try { pending.active(); } catch { pending.settle(false); return "unavailable"; }
    pending.settle(behavior === "allow"); return behavior === "allow" ? "allowed-once" : "rejected";
  }
  cancelThread(threadId: string) { for (const pending of this.pending.values()) if (pending.threadId === threadId) pending.settle(false); }
}
