import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import type { Store } from "./store.ts";
import { database } from "./database.ts";
import { ATTACHMENTS_DIR, IMAGE_MAX_BYTES } from "./attachments.ts";
import { DATA_DIR } from "./config.ts";
import type { ImageOperationDetails, ImageAttemptOutcome, ImageReference, GeneratedImageMetadata } from "./image-generation.ts";
import type { DecodedGeneratedImage } from "./generated-image.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import type { LocalOutputReceipt } from "../shared/output-publication.ts";
import { completeImageOutput, outputReceipt, outputReceiptsForRun, retainImageOutput, type ImageOutputCompletion } from "./output-publication.ts";
import { conversationImageAttachments } from "./image-reference-resolver.ts";

export interface ImageActor { botId: string; threadId: string; generation: string; assertActive: () => void; signal: AbortSignal }
interface Pending { threadId: string; botId: string; messageId: string; settle: (allow: boolean) => void; active: () => void }
const error = (status: number, message: string) => Object.assign(new Error(message), { status });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, file: string) { const tail = relative(root, file); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); }
/** No caller path is accepted. References must already belong to this exact
 * conversation: an uploaded or generated image it shows, or one prepared by
 * resolve_image_reference (F5-T4), which stores its pinned bytes the same way. */
export function imageReferences(store: Store, threadId: string, names: unknown): ImageReference[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > 4 || names.some(name => typeof name !== "string" || !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(name))) throw error(400, "Choose up to four image attachments from this conversation.");
  const allowed = new Set(conversationImageAttachments(store, threadId, ATTACHMENTS_DIR).values());
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

export interface ImageArtifact {
  /** Operation-owned result identity: the local output receipt id (C2). */
  id: string; path: string; url: string; mime: string; bytes: number; referenceId: string;
  /** Saved Files version, once registration finished. */
  artifactId?: string;
  /** Redacted reason the image is not in Files yet. Repeating the same
   * request_id retries registration without any provider request. */
  filesError?: string;
}
export interface PublishImageOptions {
  /** Run id recorded on the receipt; the image operation id when known. */
  operationId?: string;
  /** Called after the bytes and their receipt are durable, before attachment. */
  onRetained?: (receipt: LocalOutputReceipt) => void;
}
interface PendingPublication { receiptId: string; metadata: GeneratedImageMetadata }
interface ImageOperationResult { artifact: ImageArtifact; metadata: GeneratedImageMetadata }

const outputDeps = (store: Store) => ({ db: database(), dataDir: DATA_DIR, store });
const transcriptText = (metadata: GeneratedImageMetadata) => `Image created with ${metadata.model} through ${metadata.provider}.`;
const artifactName = (metadata: GeneratedImageMetadata) => `Generated image (${metadata.model})`.slice(0, 200);
function imageArtifact(done: ImageOutputCompletion): ImageArtifact {
  const name = basename(done.saved.path), artifactId = done.artifact?.id ?? done.receipt.artifactId;
  return { id: done.receipt.id, path: done.path, url: `/api/attachments/${name}`, mime: done.saved.mime, bytes: done.saved.bytes, referenceId: name,
    ...(artifactId ? { artifactId } : {}), ...(done.filesError ? { filesError: done.filesError } : {}) };
}
function parsePending(result: string | null): PendingPublication | undefined {
  if (!result) return undefined;
  try {
    const value = JSON.parse(result) as { pending?: PendingPublication };
    return value.pending && typeof value.pending.receiptId === "string" && value.pending.metadata && typeof value.pending.metadata === "object" ? value.pending : undefined;
  } catch { return undefined; }
}
const isOperationResult = (value: unknown): value is ImageOperationResult =>
  Boolean(value && typeof value === "object" && "artifact" in value && "metadata" in value && typeof (value as ImageOperationResult).artifact?.id === "string");

/** Retains the provider bytes with a receipt first, then completes the
 * existing conversation attachment flow and Files registration from those
 * bytes. No async gap during authority + artifact commit. */
export function publishImage(store: Store, actor: ImageActor, image: DecodedGeneratedImage, metadata: GeneratedImageMetadata, options: PublishImageOptions = {}): ImageArtifact {
  actor.assertActive();
  if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
  const deps = outputDeps(store);
  const receipt = retainImageOutput(deps, { producer: "image-operation", botId: actor.botId, threadId: actor.threadId, runId: options.operationId ?? actor.generation,
    bytes: image.bytes, mime: image.mime, beforeCommit: () => { actor.assertActive(); if (actor.signal.aborted) throw error(409, "Image operation was cancelled."); } });
  options.onRetained?.(receipt);
  return imageArtifact(completeImageOutput(deps, receipt.id, { transcriptText: transcriptText(metadata), artifactName: artifactName(metadata) }));
}

const recoveryMessage = (category?: string) => `Image received and kept locally, but publishing it to this conversation did not finish${category ? ` (${category})` : ""}. `
  + "Call generate_image again with the same request_id during this turn to finish; no new provider request will be sent.";

export type PublishOperationImage = (image: DecodedGeneratedImage, metadata: GeneratedImageMetadata) => Promise<ImageArtifact>;

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
  private receiptFor(actor: ImageActor, id: string) {
    return outputReceiptsForRun(database(), "image-operation", actor.botId, actor.threadId, id)[0];
  }
  execute<T>(actor: ImageActor, requestId: string, request: unknown, work: (reserve: (details: ImageOperationDetails) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void }>, publish: PublishOperationImage) => Promise<T>): Promise<T> {
    actor.assertActive();
    if (!/^[\w-]{1,80}$/.test(requestId)) throw error(400, "A stable request_id is required for image generation.");
    const id = hash(`${actor.botId}:${actor.threadId}:${actor.generation}:${requestId}`), requestHash = hash(JSON.stringify(request));
    const prior = this.db().prepare("SELECT request_hash,state,result FROM image_operations WHERE id=?").get(id) as { request_hash: string; state: string; result: string | null } | undefined;
    if (prior?.request_hash !== undefined && prior.request_hash !== requestHash) throw error(409, "This image request ID was already used for a different request.");
    if (this.jobs.has(id)) return this.jobs.get(id) as Promise<T>;
    if (prior?.state === "published" && prior.result) return Promise.resolve(this.refreshPublished(actor, id, JSON.parse(prior.result) as T));
    if (prior?.state === "publish-pending") return this.resume<T>(actor, id, prior.result);
    if (prior) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    if (this.db().prepare("SELECT id FROM image_operations WHERE generation=?").get(actor.generation)) throw error(429, "One image attempt is allowed per turn. Start a new task or turn for another image.");
    this.db().prepare("INSERT INTO image_operations VALUES(?,?,?,'awaiting',NULL,?)").run(id, actor.generation, requestHash, Date.now());
    this.workspaces.add(actor.botId);
    // A pending publication record survives outcome receipts, so a received
    // image stays resumable even when its attempt is recorded as uncertain.
    const record = (state: string, result: unknown = null) => { this.db().prepare("UPDATE image_operations SET state=?,result=COALESCE(?,result),updated_at=? WHERE id=?").run(state, result === null ? null : JSON.stringify(result), Date.now(), id); };
    const publish: PublishOperationImage = async (image, metadata) => publishImage(this.store, actor, image, metadata, { operationId: id,
      onRetained: receipt => record("running", { pending: { receiptId: receipt.id, metadata } }) });
    const job = Promise.resolve().then(() => work(async details => {
      actor.assertActive();
      const approved = await this.approve(actor, details, request);
      actor.assertActive();
      if (!approved || actor.signal.aborted) { record("not-dispatched"); throw error(403, "Image generation was not approved; no image request was sent."); }
      record("running");
      return { finish: (outcome: ImageAttemptOutcome) => record(outcome) };
    }, publish)).then(result => { record("published", result); return result; }).catch(e => {
      const row = this.db().prepare("SELECT state,result FROM image_operations WHERE id=?").get(id) as { state: string; result: string | null };
      if (row.state === "awaiting") record("not-dispatched"); else if (row.state === "running") record("uncertain");
      const receipt = parsePending(row.result) ? this.receiptFor(actor, id) : undefined;
      if (receipt) {
        // C2: valid bytes were received and retained. Keep the operation
        // resumable from them; never re-dispatch the provider request.
        this.db().prepare("UPDATE image_operations SET state='publish-pending',updated_at=? WHERE id=?").run(Date.now(), id);
        throw error(409, recoveryMessage(outputReceipt(database(), receipt.id)?.errorCategory));
      }
      throw e;
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); });
    this.jobs.set(id, job); return job;
  }
  /** Same request_id after a local publication failure: finish from the
   * retained receipt with zero provider calls and no new approval. */
  private resume<T>(actor: ImageActor, id: string, result: string | null): Promise<T> {
    const pending = parsePending(result), receipt = pending ? this.receiptFor(actor, id) : undefined;
    if (!pending || !receipt || receipt.id !== pending.receiptId) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    this.workspaces.add(actor.botId);
    const job = Promise.resolve().then(() => {
      actor.assertActive();
      if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
      const value: ImageOperationResult = { artifact: imageArtifact(completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: transcriptText(pending.metadata), artifactName: artifactName(pending.metadata) })), metadata: pending.metadata };
      this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=? AND state='publish-pending'").run(JSON.stringify(value), Date.now(), id);
      return value as T;
    }).catch(e => {
      const category = outputReceipt(database(), receipt.id)?.errorCategory;
      throw (e as { status?: number }).status === 409 && /revoked|cancel/i.test(String((e as Error).message)) ? e : error(409, recoveryMessage(category));
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); });
    this.jobs.set(id, job); return job;
  }
  /** A published image whose Files copy did not finish is retried from its
   * retained bytes when the same request is repeated; no provider work. */
  private refreshPublished<T>(actor: ImageActor, id: string, value: T): T {
    if (!isOperationResult(value) || value.artifact.artifactId) return value;
    const receipt = this.receiptFor(actor, id);
    if (!receipt || receipt.id !== value.artifact.id) return value;
    try {
      actor.assertActive();
      const updated: ImageOperationResult = { ...value, artifact: imageArtifact(completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: transcriptText(value.metadata), artifactName: artifactName(value.metadata) })) };
      this.db().prepare("UPDATE image_operations SET result=?,updated_at=? WHERE id=? AND state='published'").run(JSON.stringify(updated), Date.now(), id);
      return updated as T;
    } catch { return value; }
  }
  /** Startup reconciliation: only operations that recorded a retained image
   * receipt are completed, into their exact recorded conversation. */
  resumePendingPublications(limit = 50): number {
    const rows = this.db().prepare("SELECT id,state,result FROM image_operations WHERE state IN ('publish-pending','running','uncertain') AND result IS NOT NULL ORDER BY updated_at LIMIT ?").all(limit) as Array<{ id: string; state: string; result: string | null }>;
    let completed = 0;
    for (const row of rows) {
      const pending = parsePending(row.result);
      const receipt = pending ? outputReceipt(database(), pending.receiptId) : undefined;
      if (!pending || !receipt || receipt.producer !== "image-operation" || receipt.runId !== row.id) continue;
      try {
        const value: ImageOperationResult = { artifact: imageArtifact(completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: transcriptText(pending.metadata), artifactName: artifactName(pending.metadata) })), metadata: pending.metadata };
        this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=? AND state=?").run(JSON.stringify(value), Date.now(), row.id, row.state);
        completed++;
      } catch { /* stays pending with the receipt's recorded category */ }
    }
    return completed;
  }
  private approve(actor: ImageActor, details: ImageOperationDetails, request: unknown): Promise<boolean> {
    const requestId = `image-${randomUUID()}`;
    const prompt = request && typeof request === "object" && "prompt" in request ? String(request.prompt) : "";
    const card = this.store.appendMessage(actor.threadId, { role: "bot", kind: "options", card: {
      title: details.operation === "edit" ? "Approve image edit" : "Approve image generation",
      subtitle: `One image${details.referenceCount ? ` from ${details.referenceCount === 1 ? "1 reference image" : `${details.referenceCount} reference images`}` : ""} · ${details.connectionId} · ${details.model}${details.quality ? ` · ${details.quality}` : ""}${details.size ? ` · ${details.size}` : ""}. Provider charges apply; exact cost is not available.`,
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
