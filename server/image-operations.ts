import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import type { Message, Store } from "./store.ts";
import type { RoutineCardHooks } from "./peer-approval.ts";
import { database } from "./database.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { ATTACHMENTS_DIR, GENERATED_IMAGE_MAX_BYTES } from "./attachments.ts";
import { IMAGE_GENERATION_REFERENCE_MAX, IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES } from "../shared/media-assets.ts";
import { DATA_DIR } from "./config.ts";
import type { ImageOperationDetails, ImageAttemptOutcome, ImageReference, GeneratedImageMetadata, ImageApprovalCardInput } from "./image-generation.ts";
import { ImageGenerationError, imageApprovalSubtitle, imageDeliveredSentence, imageProviderName } from "./image-generation.ts";
import type { DecodedGeneratedImage } from "./generated-image.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import type { LocalOutputReceipt } from "../shared/output-publication.ts";
import { completeImageOutput, outputReceipt, outputReceiptsForRun, retainImageOutput, type ImageOutputCompletion } from "./output-publication.ts";
import { conversationImageAttachments } from "./image-reference-resolver.ts";
import { recordRenderPrompt } from "./image-library.ts";
import { murageTool } from "./tool-call-context.ts";

export interface ImageActor { botId: string; threadId: string; generation: string; assertActive: () => void; signal: AbortSignal }
interface Pending { threadId: string; botId: string; messageId: string; settle: (allow: boolean, source?: "user" | "system") => void; active: () => void;
  /** Held open by a routine run: its tool call gave up (the turn ended) and
   * the card is still the owner's to answer. */
  detached?: boolean }
/** How long an image approval card waits for the owner: the same 15 minutes
 * every engine permission request gets (drivers/acp/core.ts, drivers/codex.ts)
 * before the harness closes it as unanswered. The generate_image MCP call in
 * drivers/agents-proxy.ts keeps its HTTP request open past this bound plus
 * generation time, so the proxy never gives up on a card first. */
export const IMAGE_APPROVAL_TIMEOUT_MS = 15 * 60_000;
const error = (status: number, message: string) => Object.assign(new Error(message), { status });
/** How an approval card ended, and what the bot is told for each: the
 * owner's own answer, a card that closed unanswered on the shared bound, or
 * a turn that went away under it. */
type ApprovalAnswer = "allow" | "deny" | "unanswered" | "gone";
const NOT_APPROVED: Record<Exclude<ApprovalAnswer, "allow">, string> = {
  deny: "Image generation was not approved by the owner, so nothing was sent.",
  unanswered: `Nobody answered the approval card within ${IMAGE_APPROVAL_TIMEOUT_MS / 60_000} minutes, so it was closed and nothing was sent. If the owner still wants this image, ask for it again; a new card will show.`,
  gone: "Image generation was not approved; no image request was sent.",
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, file: string) { const tail = relative(root, file); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); }
/** No caller path is accepted. References must already belong to this exact
 * conversation: an uploaded or generated image it shows, or one prepared by
 * resolve_image_reference (F5-T4), which stores its pinned bytes the same way. */
export function imageReferences(store: Store, threadId: string, names: unknown): ImageReference[] {
  if (names === undefined) return [];
  if (Array.isArray(names) && names.length > IMAGE_GENERATION_REFERENCE_MAX) throw error(400, `${names.length} reference images; Murage takes at most ${IMAGE_GENERATION_REFERENCE_MAX}. Nothing was sent.`);
  if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(name))) throw error(400, `Choose up to ${IMAGE_GENERATION_REFERENCE_MAX} image attachments from this conversation.`);
  const allowed = new Set(conversationImageAttachments(store, threadId, ATTACHMENTS_DIR).values());
  let total = 0;
  return names.map(name => {
    const file = join(ATTACHMENTS_DIR, name), root = realpathSync(ATTACHMENTS_DIR);
    const stat = lstatSync(file);
    if (!allowed.has(file) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(root, realpathSync(file)) || stat.size > GENERATED_IMAGE_MAX_BYTES) throw error(403, "Image reference is unavailable in this conversation.");
    // A generated image is a reference up to its own cap; the model's limit is checked before the card.
    const decoded = decodeGeneratedImage(readFileSync(file).toString("base64"), GENERATED_IMAGE_MAX_BYTES); total += decoded.bytes.length;
    if (total > IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES || decoded.mime === "image/gif") throw error(400, `References must be PNG, JPEG or WebP and total at most ${IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`);
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
/** Retained images waiting to be published. `receiptId` is the first (older
 * rows hold only it); `receiptIds` lists every image of a multi-image render. */
interface PendingPublication { receiptId: string; receiptIds?: string[]; metadata: GeneratedImageMetadata;
  /** Each retained image's own metadata, aligned with receiptIds (absent on older rows). */
  items?: GeneratedImageMetadata[] }
interface ImageOperationResult { artifact: ImageArtifact; artifacts?: ImageArtifact[]; metadata: GeneratedImageMetadata }
/** What an operation row's `result` holds while it runs: the retained
 * images, and the provider job it waits on (kept before the first poll). */
interface OperationProgress { pending?: PendingPublication; job?: { id: string };
  /** bot, thread and request_id: finds a provider job again from a later turn. */
  resumeKey?: string }

const outputDeps = (store: Store) => ({ db: database(), dataDir: DATA_DIR, store });
/** The conversation line under each image: the real delivered pixels, read
 * from the image itself, and what was asked when that differs. */
export const imageTranscriptText = (metadata: GeneratedImageMetadata) => {
  const delivered = imageDeliveredSentence(metadata);
  const which = metadata.imageIndex !== undefined ? ` (image ${metadata.imageIndex + 1} of ${metadata.count})` : "";
  return `Image created with ${metadata.model} through ${imageProviderName(metadata.provider)}${which}.${delivered ? ` ${delivered}` : ""}`;
};
const artifactName = (metadata: GeneratedImageMetadata) => `Generated image (${metadata.model})`.slice(0, 200);
function imageArtifact(done: ImageOutputCompletion): ImageArtifact {
  const name = basename(done.saved.path), artifactId = done.artifact?.id ?? done.receipt.artifactId;
  return { id: done.receipt.id, path: done.path, url: `/api/attachments/${name}`, mime: done.saved.mime, bytes: done.saved.bytes, referenceId: name,
    ...(artifactId ? { artifactId } : {}), ...(done.filesError ? { filesError: done.filesError } : {}) };
}
function progressOf(result: string | null): OperationProgress {
  if (!result) return {};
  try { const value = JSON.parse(result) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as OperationProgress : {}; }
  catch { return {}; }
}
function parsePending(result: string | null): PendingPublication | undefined {
  const pending = progressOf(result).pending;
  if (!pending || typeof pending.receiptId !== "string" || !pending.metadata || typeof pending.metadata !== "object") return undefined;
  const ids = Array.isArray(pending.receiptIds) && pending.receiptIds.every(id => typeof id === "string") && pending.receiptIds[0] === pending.receiptId ? pending.receiptIds : [pending.receiptId];
  const items = Array.isArray(pending.items) && pending.items.length === ids.length && pending.items.every(item => item && typeof item === "object") ? pending.items : undefined;
  return { ...pending, receiptIds: ids, ...(items ? { items } : { items: undefined }) };
}
function parseJob(result: string | null): { id: string } | undefined {
  const job = progressOf(result).job;
  return job && typeof job.id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(job.id) ? { id: job.id } : undefined;
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
  return imageArtifact(completeImageOutput(deps, receipt.id, { transcriptText: imageTranscriptText(metadata), artifactName: artifactName(metadata) }));
}

export const imagePublishRecoveryMessage = (category?: string) => `Image received and kept locally, but publishing it to this conversation did not finish${category ? ` (${category})` : ""}. `
  + `Call ${murageTool("generate_image")} again with the same request_id during this turn to finish; no new provider request will be sent.`;

export type PublishOperationImage = (image: DecodedGeneratedImage, metadata: GeneratedImageMetadata) => Promise<ImageArtifact>;
export type ImageReserve = (details: ImageOperationDetails, card?: ImageApprovalCardInput) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void }>;
/** What the operation hands its work: its id (the Flux Idempotency-Key is its
 * sha256), a job to resume when this same request started one, and where to
 * record a new job id before the first poll. */
export interface ImageWorkContext { operationId: string; resumeJob?: { id: string }; jobStarted: (job: { id: string }) => void }

/** One explicit count grant, one attempt per turn, one active operation per bot workspace. */
export class ImageOperations {
  private readonly store: Store;
  private readonly waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void;
  private readonly speaker?: (threadId: string, botId: string) => Message["from"] | undefined;
  private readonly routineCard?: RoutineCardHooks;
  /** Tells the turn's silence watch that Murage is working on this image
   * (approval, then the render) and returns the release. */
  private readonly rendering?: (actor: Pick<ImageActor, "threadId" | "generation">) => () => void;
  /** An allow given after a routine run's turn had ended: the run's next
   * image in that conversation is already approved, once. */
  private readonly lateAllows = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly workspaces = new Set<string>();
  /** `speaker` names the member who asked when the card lands in a channel:
   * without it the card has no sender, so neither the channel view nor the
   * native approval notification can tell whose request it is. */
  constructor(options: { store: Store; waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void; speaker?: (threadId: string, botId: string) => Message["from"] | undefined; routineCard?: RoutineCardHooks;
    rendering?: (actor: Pick<ImageActor, "threadId" | "generation">) => () => void }) {
    this.store = options.store; this.waiting = options.waiting; this.speaker = options.speaker; this.routineCard = options.routineCard; this.rendering = options.rendering;
  }
  private db() {
    const db = database();
    initializeImageOperations(db);
    return db;
  }
  private receiptFor(actor: ImageActor, id: string) {
    return outputReceiptsForRun(database(), "image-operation", actor.botId, actor.threadId, id)[0];
  }
  /** Every retained receipt the pending record names, in order, or null when one is missing. */
  private pendingReceipts(actor: ImageActor, id: string, pending: PendingPublication) {
    const receipts = outputReceiptsForRun(database(), "image-operation", actor.botId, actor.threadId, id);
    const found = (pending.receiptIds ?? [pending.receiptId]).map(receiptId => receipts.find(receipt => receipt.id === receiptId));
    return found.every(Boolean) ? found as NonNullable<typeof found[number]>[] : null;
  }
  /** The row a repeat of this request_id would continue, without running it:
   * "settled" (published or waiting to publish: nothing is re-read) or "job"
   * (a provider job to poll, with the operation id its prompt was kept under).
   * The caller then skips re-reading saved blocks and packs, which may have
   * changed since the render was approved. */
  resumable(actor: Pick<ImageActor, "botId" | "threadId" | "generation">, requestId: string): { kind: "settled" | "job"; operationId: string } | undefined {
    if (!/^[\w-]{1,80}$/.test(requestId)) return undefined;
    const own = this.db().prepare("SELECT id,state,result FROM image_operations WHERE id=?").get(hash(`${actor.botId}:${actor.threadId}:${actor.generation}:${requestId}`)) as { id: string; state: string; result: string | null } | undefined;
    const row = own ?? this.db().prepare("SELECT id,state,result FROM image_operations WHERE state IN ('running','uncertain') AND json_valid(result) AND json_extract(result,'$.resumeKey')=? ORDER BY updated_at DESC LIMIT 1")
      .get(hash(`${actor.botId}:${actor.threadId}:${requestId}`)) as { id: string; state: string; result: string | null } | undefined;
    if (!row) return undefined;
    if (row.state === "published" || row.state === "publish-pending") return { kind: "settled", operationId: row.id };
    return ["running", "uncertain"].includes(row.state) && parseJob(row.result) && !parsePending(row.result) ? { kind: "job", operationId: row.id } : undefined;
  }
  execute<T>(actor: ImageActor, requestId: string, request: unknown, work: (reserve: ImageReserve, publish: PublishOperationImage, context: ImageWorkContext) => Promise<T>): Promise<T> {
    actor.assertActive();
    if (!/^[\w-]{1,80}$/.test(requestId)) throw error(400, "A stable request_id is required for image generation.");
    const requestHash = hash(JSON.stringify(request)), resumeKey = hash(`${actor.botId}:${actor.threadId}:${requestId}`);
    let id = hash(`${actor.botId}:${actor.threadId}:${actor.generation}:${requestId}`);
    type Prior = { id: string; request_hash: string; state: string; result: string | null };
    let prior = this.db().prepare("SELECT id,request_hash,state,result FROM image_operations WHERE id=?").get(id) as Prior | undefined;
    if (!prior) {
      // A provider job started in an earlier turn (or before a restart) is
      // found again by bot, thread and request_id: the same request polls
      // the same job under its first operation id, never a second render.
      const carried = this.db().prepare("SELECT id,request_hash,state,result FROM image_operations WHERE state IN ('running','uncertain') AND json_valid(result) AND json_extract(result,'$.resumeKey')=? ORDER BY updated_at DESC LIMIT 1").get(resumeKey) as Prior | undefined;
      if (carried && carried.request_hash === requestHash && parseJob(carried.result) && !parsePending(carried.result)) { id = carried.id; prior = carried; }
    }
    if (prior?.request_hash !== undefined && prior.request_hash !== requestHash) throw error(409, "This image request ID was already used for a different request.");
    if (this.jobs.has(id)) {
      // Joining a render still running: this turn waits on Murage too.
      let release: () => void = () => {};
      try { release = this.rendering?.(actor) ?? release; } catch { /* the watch never changes the operation */ }
      const joined = this.jobs.get(id) as Promise<T>;
      const settle = () => { try { release(); } catch { /* as above */ } };
      void joined.then(settle, settle);
      return joined;
    }
    if (prior?.state === "published" && prior.result) return Promise.resolve(this.refreshPublished(actor, id, JSON.parse(prior.result) as T));
    if (prior?.state === "publish-pending") return this.resume<T>(actor, id, prior.result);
    // A provider job this request already started (contract section 4): the
    // same request_id polls it again. It never submits a second render.
    const priorJob = prior && ["running", "uncertain"].includes(prior.state) && !parsePending(prior.result) ? parseJob(prior.result) : undefined;
    if (prior && !priorJob) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    if (!priorJob) {
      if (this.db().prepare("SELECT id FROM image_operations WHERE generation=?").get(actor.generation)) throw error(429, "One image attempt is allowed per turn. Start a new task or turn for another image.");
      this.db().prepare("INSERT INTO image_operations VALUES(?,?,?,'awaiting',NULL,?)").run(id, actor.generation, requestHash, Date.now());
    }
    this.workspaces.add(actor.botId);
    // The render is bounded by its own ceiling; until it ends, the engine's
    // quiet turn is waiting on Murage, not silent.
    let releaseWatch: () => void = () => {};
    try { releaseWatch = this.rendering?.(actor) ?? releaseWatch; } catch { /* the watch never changes the operation */ }
    let approvalStarted = false;
    // A pending publication record survives outcome receipts, so a received
    // image stays resumable even when its attempt is recorded as uncertain.
    // Progress (retained receipts, the job id) is merged, never dropped.
    const record = (state: string, patch?: OperationProgress) => {
      const current = patch ? progressOf((this.db().prepare("SELECT result FROM image_operations WHERE id=?").get(id) as { result: string | null } | undefined)?.result ?? null) : undefined;
      this.db().prepare("UPDATE image_operations SET state=?,result=COALESCE(?,result),updated_at=? WHERE id=?").run(state, patch ? JSON.stringify({ ...current, ...patch }) : null, Date.now(), id);
    };
    const retained: string[] = [], items: GeneratedImageMetadata[] = [];
    const publish: PublishOperationImage = async (image, metadata) => publishImage(this.store, actor, image, metadata, { operationId: id,
      onRetained: receipt => {
        retained.push(receipt.id); items.push(metadata);
        // The whole render's facts (every image's delivered pixels) plus each image's own.
        const whole: GeneratedImageMetadata = { ...items[0]!, delivered: items.flatMap(item => item.delivered ?? []) }; delete whole.imageIndex; delete whole.summary;
        record("running", { pending: { receiptId: retained[0]!, receiptIds: [...retained], metadata: whole, items: [...items] } });
      } });
    const reserve: ImageReserve = async (details, card) => {
      approvalStarted = true;
      actor.assertActive();
      // The owner already approved the job being resumed; no second card.
      const answer: ApprovalAnswer = priorJob ? "allow" : await this.approve(actor, details, request, card);
      actor.assertActive();
      if (answer !== "allow" || actor.signal.aborted) { record("not-dispatched"); throw error(403, NOT_APPROVED[answer === "allow" ? "gone" : answer]); }
      // The full prompt and the block versions it pinned, kept before the
      // provider is asked, so an uncertain render still has them.
      if (card?.prompt !== undefined) recordRenderPrompt(this.db(), { operationId: id, prompt: card.prompt, blocks: details.promptBlocks ?? [] });
      record("running");
      return { finish: (outcome: ImageAttemptOutcome) => record(outcome) };
    };
    const context: ImageWorkContext = { operationId: id, ...(priorJob ? { resumeJob: priorJob } : {}), jobStarted: job => record("running", { job, resumeKey }) };
    const job = Promise.resolve().then(() => work(reserve, publish, context)).then(result => {
      this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
      return result;
    }).catch(e => {
      if (!approvalStarted && !priorJob && e instanceof ImageGenerationError && e.correctablePreflight && !actor.signal.aborted) {
        // Synchronous identity-checked deletion under the existing job and
        // workspace lock. Crashes, denial and unknown failures retain the row.
        actor.assertActive();
        this.db().prepare("DELETE FROM image_operations WHERE id=? AND request_hash=? AND state='awaiting' AND result IS NULL").run(id, requestHash);
        throw e;
      }
      const row = this.db().prepare("SELECT state,result FROM image_operations WHERE id=?").get(id) as { state: string; result: string | null };
      if (row.state === "awaiting") record("not-dispatched"); else if (row.state === "running") record("uncertain");
      const pending = parsePending(row.result);
      const receipt = pending ? this.receiptFor(actor, id) : undefined;
      if (receipt) {
        // C2: valid bytes were received and retained. Keep the operation
        // resumable from them; never re-dispatch the provider request.
        this.db().prepare("UPDATE image_operations SET state='publish-pending',updated_at=? WHERE id=?").run(Date.now(), id);
        throw error(409, imagePublishRecoveryMessage(outputReceipt(database(), receipt.id)?.errorCategory));
      }
      throw e;
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); try { releaseWatch(); } catch { /* as above */ } });
    this.jobs.set(id, job); return job;
  }
  /** Completes every retained image of one operation from its receipts. */
  private completeAll(receipts: Array<{ id: string }>, metadata: GeneratedImageMetadata, items?: GeneratedImageMetadata[]): ImageOperationResult {
    const artifacts = receipts.map((receipt, index) => {
      const each: GeneratedImageMetadata = items?.[index] ?? (receipts.length > 1 ? { ...metadata, imageIndex: index, delivered: metadata.delivered?.[index] ? [metadata.delivered[index]!] : metadata.delivered } : metadata);
      return imageArtifact(completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: imageTranscriptText(each), artifactName: artifactName(each) }));
    });
    return { artifact: artifacts[0]!, artifacts, metadata };
  }
  /** Same request_id after a local publication failure: finish from the
   * retained receipts with zero provider calls and no new approval. */
  private resume<T>(actor: ImageActor, id: string, result: string | null): Promise<T> {
    const pending = parsePending(result), receipts = pending ? this.pendingReceipts(actor, id, pending) : null;
    if (!pending || !receipts || receipts[0]!.id !== pending.receiptId) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    this.workspaces.add(actor.botId);
    const job = Promise.resolve().then(() => {
      actor.assertActive();
      if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
      const value = this.completeAll(receipts, pending.metadata, pending.items);
      this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=? AND state='publish-pending'").run(JSON.stringify(value), Date.now(), id);
      return value as T;
    }).catch(e => {
      const category = outputReceipt(database(), receipts[0]!.id)?.errorCategory;
      throw (e as { status?: number }).status === 409 && /revoked|cancel/i.test(String((e as Error).message)) ? e : error(409, imagePublishRecoveryMessage(category));
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); });
    this.jobs.set(id, job); return job;
  }
  /** A published image whose Files copy did not finish is retried from its
   * retained bytes when the same request is repeated; no provider work. */
  private refreshPublished<T>(actor: ImageActor, id: string, value: T): T {
    if (!isOperationResult(value)) return value;
    const artifacts = value.artifacts?.length ? value.artifacts : [value.artifact];
    if (artifacts.every(artifact => artifact.artifactId)) return value;
    const receipts = outputReceiptsForRun(database(), "image-operation", actor.botId, actor.threadId, id);
    try {
      actor.assertActive();
      const refreshed = artifacts.map(artifact => {
        const receipt = receipts.find(item => item.id === artifact.id);
        return artifact.artifactId || !receipt ? artifact : imageArtifact(completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: imageTranscriptText(value.metadata), artifactName: artifactName(value.metadata) }));
      });
      const updated: ImageOperationResult = { ...value, artifact: refreshed[0]!, ...(value.artifacts ? { artifacts: refreshed } : {}) };
      this.db().prepare("UPDATE image_operations SET result=?,updated_at=? WHERE id=? AND state='published'").run(JSON.stringify(updated), Date.now(), id);
      return updated as T;
    } catch { return value; }
  }
  /** Startup reconciliation: only operations that recorded a retained image
   * receipt are completed, into their exact recorded conversation. */
  resumePendingPublications(limit = 50): number {
    this.releaseUndispatchedOperations(limit);
    const rows = this.db().prepare("SELECT id,state,result FROM image_operations WHERE state IN ('publish-pending','running','uncertain') AND result IS NOT NULL ORDER BY updated_at LIMIT ?").all(limit) as Array<{ id: string; state: string; result: string | null }>;
    let completed = 0;
    for (const row of rows) {
      const pending = parsePending(row.result);
      const receipts = pending ? pending.receiptIds!.map(receiptId => outputReceipt(database(), receiptId)) : [];
      if (!pending || !receipts.length || receipts.some(receipt => !receipt || receipt.producer !== "image-operation" || receipt.runId !== row.id)) continue;
      try {
        const value = this.completeAll(receipts as Array<{ id: string }>, pending.metadata, pending.items);
        this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=? AND state=?").run(JSON.stringify(value), Date.now(), row.id, row.state);
        completed++;
      } catch { /* stays pending with the receipt's recorded category */ }
    }
    return completed;
  }
  /** Startup reconciliation, the other half: a row still sitting at
   * `awaiting` was written when the request was accepted and abandoned before
   * anyone approved it — the process stopped with the approval card still on
   * screen. Nothing was sent, nothing was charged, and no image was retained
   * (a retained image writes `running` and a result). Left behind, that row
   * answers the same request with "already finished" and the same turn with
   * "one image attempt", forever. Clearing it is what the live path already
   * does for a request that never reached a provider. */
  private releaseUndispatchedOperations(limit = 50): number {
    const rows = this.db().prepare("SELECT id FROM image_operations WHERE state='awaiting' AND result IS NULL ORDER BY updated_at LIMIT ?").all(limit) as Array<{ id: string }>;
    let released = 0;
    for (const row of rows) {
      // Belt and braces: bytes are only ever retained through a receipt, and
      // retaining one writes `running` and a result in the same statement, so
      // this cannot match. Refuse to clear a row that somehow has one anyway —
      // and treat a receipts table that does not exist yet as "no receipts",
      // never as a reason to abandon the sweep.
      try { if (this.db().prepare("SELECT id FROM output_publications WHERE producer='image-operation' AND run_id=? LIMIT 1").get(row.id)) continue; } catch { /* no receipts recorded yet */ }
      released += Number(this.db().prepare("DELETE FROM image_operations WHERE id=? AND state='awaiting' AND result IS NULL").run(row.id).changes ?? 0);
    }
    return released;
  }
  private approve(actor: ImageActor, details: ImageOperationDetails, request: unknown, input?: ImageApprovalCardInput): Promise<ApprovalAnswer> {
    if (this.lateAllows.delete(actor.threadId)) return Promise.resolve("allow");
    const requestId = `image-${randomUUID()}`;
    // `held` is the full assembled prompt: exactly what the provider is sent.
    const prompt = (input?.prompt ?? (request && typeof request === "object" && "prompt" in request ? String(request.prompt) : ""))
      + (input?.negativePrompt ? `\n\nNegative prompt (sent in its own field): ${input.negativePrompt}` : "");
    const from = this.speaker?.(actor.threadId, actor.botId);
    const card = this.store.appendMessage(actor.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
      title: details.operation === "edit" ? "Approve image edit" : "Approve image generation",
      // F1-T4: the owner approves the exact upstream that will bill them. An
      // OpenRouter edit names its pinned endpoint; nothing else is routed.
      // No cost on the card: it states the engine, sizes, count, references
      // and prompt the owner is approving (image-generation.ts).
      subtitle: imageApprovalSubtitle(details),
      held: prompt, options: ["Allow", "Deny"], requestId, tool: "generate_image",
    } });
    this.waiting(actor.threadId, true, requestId, card.id, actor.botId);
    let held = false;
    try { held = this.routineCard?.opened(actor.threadId, requestId, card.card?.title ?? "Approve image") === true; } catch { /* delivery never changes authority */ }
    return new Promise<ApprovalAnswer>(resolve => {
      let settled = false;
      let answered = false;
      let expired = false;
      // Only the owner's own answer is recorded as allow/deny. A card nobody
      // answered (turn cancelled, request revoked, the shared bound elapsed)
      // settles as "unavailable", the same closing the harness gives every
      // other approval its turn abandoned, so it never reads as a denial.
      const finish = (allow: boolean, source: "user" | "system" = "system") => {
        const entry = this.pending.get(requestId);
        if (entry?.detached) {
          // the tool call already gave up; this is the owner's late answer
          if (answered) return; answered = true; this.pending.delete(requestId);
          const current = this.store.messagesFor(actor.threadId).find(message => message.id === card.id);
          if (current?.card && !current.card.answered) this.store.patchMessage(actor.threadId, card.id, { card: { ...current.card, answered: source === "user" ? (allow ? "allow" : "deny") : "unavailable", dismissed: source !== "user" } });
          let resumed = false;
          try { resumed = this.routineCard?.closed(actor.threadId, requestId, source === "user" ? (allow ? "allow" : "deny") : "none") === true; } catch { /* delivery never changes authority */ }
          if (resumed && allow && source === "user") this.lateAllows.add(actor.threadId);
          return;
        }
        if (settled) return; settled = true; clearTimeout(timer); actor.signal.removeEventListener("abort", abort); this.pending.delete(requestId);
        if (held) { try { this.routineCard?.closed(actor.threadId, requestId, source === "user" ? (allow ? "allow" : "deny") : "none"); } catch { /* delivery never changes authority */ } }
        const current = this.store.messagesFor(actor.threadId).find(message => message.id === card.id);
        if (current?.card && !current.card.answered) this.store.patchMessage(actor.threadId, card.id, { card: { ...current.card, answered: source === "user" ? (allow ? "allow" : "deny") : "unavailable", dismissed: source !== "user" } });
        this.waiting(actor.threadId, false, requestId, undefined, actor.botId);
        resolve(source === "user" ? (allow ? "allow" : "deny") : expired ? "unanswered" : "gone");
      };
      const abort = () => {
        // A routine run holds the card: the tool call gave up (its turn is
        // over), but the card stays the owner's to answer and the run waits.
        const entry = this.pending.get(requestId);
        if (held && entry && !settled) {
          settled = true; actor.signal.removeEventListener("abort", abort);
          entry.detached = true;
          this.waiting(actor.threadId, false, requestId, undefined, actor.botId); resolve("gone");
          return;
        }
        finish(false);
      };
      const timer = held ? undefined : setTimeout(() => { expired = true; abort(); }, IMAGE_APPROVAL_TIMEOUT_MS); timer?.unref();
      this.pending.set(requestId, { threadId: actor.threadId, botId: actor.botId, messageId: card.id, settle: finish, active: actor.assertActive });
      actor.signal.addEventListener("abort", abort, { once: true });
      if (actor.signal.aborted) abort();
    });
  }
  resolve(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer"): "allowed-once" | "rejected" | "unavailable" | null {
    if (!requestId.startsWith("image-")) return null;
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId || behavior === "answer") return "unavailable";
    if (!pending.detached) { try { pending.active(); } catch { pending.settle(false); return "unavailable"; } }
    pending.settle(behavior === "allow", "user"); return behavior === "allow" ? "allowed-once" : "rejected";
  }
  cancelThread(threadId: string) { for (const pending of this.pending.values()) if (pending.threadId === threadId) pending.settle(false); }
}
