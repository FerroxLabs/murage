import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Message, Store } from "./store.ts";
import type { RoutineCardHooks } from "./peer-approval.ts";
import { database } from "./database.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { notRestoreHeldSql, releaseHeldImageOperation, sqlRowRestoreHeld } from "./restore-fence.ts";
import { ATTACHMENTS_HOME, GENERATED_IMAGE_MAX_BYTES } from "./attachments.ts";
import { ATTACHMENT_READ_CEILING, readAttachmentFile } from "./attachment-read.ts";
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
import { murageToolOnThisServer } from "./murage-tool-surface.ts";
import { redactSecretsInText } from "./redact.ts";
import { murageLine } from "./murage-line.ts";

export interface ImageActor { botId: string; threadId: string; generation: string; assertActive: () => void; signal: AbortSignal;
  /** The provider turn running this generation, read from the turn's capability (internal-capabilities.ts providerTurnOf), never from a
   * request body. Rows carrying what the model wrote (the image, its prompt) name it, so revoking the turn's inputs withholds them. */
  turnId?: string }
interface Pending { threadId: string; botId: string; messageId: string; settle: (allow: boolean, source?: "user" | "system") => void; active: () => void;
  /** Held open by a routine run: its tool call gave up (the turn ended) and
   * the card is still the owner's to answer. */
  detached?: boolean;
  /** Its late Allow had nothing to carry it on, so it made no image. */
  unused?: boolean }
/* An image approval card waits for the owner until it is answered or its
 * turn ends (cards-wait 1.0.8, GROK-STOPPED F1): there is no expiry timer.
 * The generate_image MCP call in drivers/agents-proxy.ts keeps its HTTP
 * request open for as long as the harness holds it. */
const error = (status: number, message: string) => Object.assign(new Error(message), { status });
/** How an approval card ended, and what the bot is told for each: the
 * owner's own answer, or a turn that went away under it. */
type ApprovalAnswer = "allow" | "deny" | "gone";
const NOT_APPROVED: Record<Exclude<ApprovalAnswer, "allow">, string> = {
  deny: "Image generation was not approved by the owner, so nothing was sent.",
  gone: "Image generation was not approved; no image request was sent.",
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** No caller path is accepted. References must already belong to this exact
 * conversation: an uploaded or generated image it shows, or one prepared by
 * resolve_image_reference (F5-T4), which stores its pinned bytes the same way. */
export async function imageReferences(store: Store, threadId: string, names: unknown, assertLive: () => void): Promise<ImageReference[]> {
  if (names === undefined) return [];
  if (Array.isArray(names) && names.length > IMAGE_GENERATION_REFERENCE_MAX) throw error(400, `${names.length} reference images; Murage takes at most ${IMAGE_GENERATION_REFERENCE_MAX}. Nothing was sent.`);
  if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(name))) throw error(400, `Choose up to ${IMAGE_GENERATION_REFERENCE_MAX} image attachments from this conversation.`);
  const asked = names as string[];
  const allowed = new Set(conversationImageAttachments(store, threadId, ATTACHMENTS_HOME, asked).keys());
  let total = 0;
  const references: ImageReference[] = [];
  for (const name of asked) {
    if (!allowed.has(name)) throw error(403, "Image reference is unavailable in this conversation.");
    // Every byte read goes through the bounded attachment reader: no link,
    // FIFO, device or hard link, at most the generated-image cap.
    const read = await readAttachmentFile(ATTACHMENTS_HOME, name, Math.min(GENERATED_IMAGE_MAX_BYTES, ATTACHMENT_READ_CEILING));
    if (!read.ok) {
      if (read.reason === "io" || read.reason === "busy") throw error(503, "Could not read that image just now. Try again.");
      throw error(403, "Image reference is unavailable in this conversation.");
    }
    // A generated image is a reference up to its own cap; the model's limit is checked before the card.
    const decoded = decodeGeneratedImage(read.bytes.toString("base64"), GENERATED_IMAGE_MAX_BYTES); total += decoded.bytes.length;
    if (total > IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES || decoded.mime === "image/gif") throw error(400, `References must be PNG, JPEG or WebP and total at most ${IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`);
    references.push({ bytes: decoded.bytes, mime: decoded.mime });
  }
  // The reads awaited: every name must still belong to this conversation, and
  // the turn must still be live, before the bytes are used.
  const still = conversationImageAttachments(store, threadId, ATTACHMENTS_HOME, asked);
  if (asked.some(name => !still.has(name))) throw error(403, "Image reference is unavailable in this conversation.");
  assertLive();
  return references;
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
  /** Images this render asked for, kept at reserve so a turn's total is known. */
  count?: number;
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
 * bytes. The one await (the attachment step) is followed by a fresh check
 * of the actor before anything is attached or saved. */
export async function publishImage(store: Store, actor: ImageActor, image: DecodedGeneratedImage, metadata: GeneratedImageMetadata, options: PublishImageOptions = {}): Promise<ImageArtifact> {
  actor.assertActive();
  if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
  const deps = outputDeps(store);
  const receipt = retainImageOutput(deps, { producer: "image-operation", botId: actor.botId, threadId: actor.threadId, runId: options.operationId ?? actor.generation,
    bytes: image.bytes, mime: image.mime, beforeCommit: () => { actor.assertActive(); if (actor.signal.aborted) throw error(409, "Image operation was cancelled."); } });
  options.onRetained?.(receipt);
  return imageArtifact(await completeImageOutput(deps, receipt.id, { transcriptText: imageTranscriptText(metadata), artifactName: artifactName(metadata), turnId: actor.turnId,
    recheck: () => { actor.assertActive(); if (actor.signal.aborted) throw error(409, "Image operation was cancelled."); } }));
}

export const imagePublishRecoveryMessage = (category?: string) => `Image received and kept locally, but publishing it to this conversation did not finish${category ? ` (${category})` : ""}. `
  + `Call ${murageToolOnThisServer("generate_image")} again with the same request_id during this turn to finish; no new provider request will be sent.`;

/** The decision to make an image without a card (server/image-approval.ts):
 * `basis` names why ("Full access", "No limits", "the Images setting"). */
export interface ImageAutoApproval { basis: "Full access" | "No limits" | "the Images setting" }
/** What the decision is given: the images this request asks for, and the
 * images this turn has already made (so the "ask again after N" guard can see
 * both). A probe asks with `count: 0` whether the no-card path is open at all. */
export interface ImageAutoAsk { count: number; madeThisTurn: number }
export type PublishOperationImage = (image: DecodedGeneratedImage, metadata: GeneratedImageMetadata) => Promise<ImageArtifact>;
export type ImageReserve = (details: ImageOperationDetails, card?: ImageApprovalCardInput) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void }>;
/** What the operation hands its work: its id (the Flux Idempotency-Key is its
 * sha256), a job to resume when this same request started one, and where to
 * record a new job id before the first poll. */
export interface ImageWorkContext { operationId: string; resumeJob?: { id: string }; jobStarted: (job: { id: string }) => void }

/** One explicit count grant, one active operation per bot workspace. A turn gets one attempt where the card is shown; where the bot makes images without asking it may go on, once every earlier attempt of the turn is settled. */
export class ImageOperations {
  private readonly store: Store;
  private readonly waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void;
  private readonly speaker?: (threadId: string, botId: string) => Message["from"] | undefined;
  private readonly routineCard?: RoutineCardHooks;
  private readonly holdProjectApproval?: (threadId:string)=>boolean;
  /** Whether this render needs no card. Null means ask; a throw means ask. */
  private readonly autoApproval?: (actor: ImageActor, ask: ImageAutoAsk) => ImageAutoApproval | null;
  /** Told once an image really is going ahead without a card (the decision log). */
  private readonly autoApprovalLogged?: (actor: ImageActor, details: ImageOperationDetails, auto: ImageAutoApproval) => void;
  /** Tells the turn's silence watch that Murage is working on this image
   * (approval, then the render) and returns the release. */
  private readonly rendering?: (actor: Pick<ImageActor, "threadId" | "generation">) => () => void;
  /** An allow given after a routine run's turn had ended: the run's next
   * image in that conversation is already approved, once. */
  private readonly lateAllows = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly startupUndispatched: Set<string>;
  private readonly workspaces = new Set<string>();
  /** `speaker` names the member who asked when the card lands in a channel:
   * without it the card has no sender, so neither the channel view nor the
   * native approval notification can tell whose request it is. */
  constructor(options: { store: Store; waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void; speaker?: (threadId: string, botId: string) => Message["from"] | undefined; routineCard?: RoutineCardHooks; holdProjectApproval?: (threadId:string)=>boolean;
    rendering?: (actor: Pick<ImageActor, "threadId" | "generation">) => () => void;
    autoApproval?: (actor: ImageActor, ask: ImageAutoAsk) => ImageAutoApproval | null;
    autoApprovalLogged?: (actor: ImageActor, details: ImageOperationDetails, auto: ImageAutoApproval) => void }) {
    this.autoApproval = options.autoApproval; this.autoApprovalLogged = options.autoApprovalLogged;
    this.store = options.store; this.waiting = options.waiting; this.speaker = options.speaker; this.routineCard = options.routineCard; this.holdProjectApproval=options.holdProjectApproval; this.rendering = options.rendering;
    this.startupUndispatched = new Set((this.db().prepare("SELECT id FROM image_operations WHERE state='awaiting' AND result IS NULL").all() as Array<{ id: string }>).map(row => row.id));
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
  resumable(actor: Pick<ImageActor, "botId" | "threadId" | "generation">, requestId: string, request: unknown): { kind: "settled" | "job"; operationId: string } | undefined {
    if (!/^[\w-]{1,80}$/.test(requestId)) return undefined;
    type Row = { id: string; request_hash: string; state: string; result: string | null };
    const own = this.db().prepare("SELECT id,request_hash,state,result FROM image_operations WHERE id=?").get(hash(`${actor.botId}:${actor.threadId}:${actor.generation}:${requestId}`)) as Row | undefined;
    // Only the request that started it collects it: another request reusing
    // the request_id is never sent the prompt kept for this one (its saved
    // blocks included). Within the turn that is a refusal, as execute()
    // gives; from a later turn it is a new render, as execute() starts.
    const same = (row: Row) => row.request_hash === hash(JSON.stringify(request));
    if (own && !same(own)) throw error(409, "This image request ID was already used for a different request.");
    const carried = own ? undefined : this.db().prepare("SELECT id,request_hash,state,result FROM image_operations WHERE state IN ('running','uncertain') AND json_valid(result) AND json_extract(result,'$.resumeKey')=? AND request_hash=? ORDER BY updated_at DESC LIMIT 1")
      .get(hash(`${actor.botId}:${actor.threadId}:${requestId}`), hash(JSON.stringify(request))) as Row | undefined;
    const row = own ?? (carried && same(carried) ? carried : undefined);
    if (!row) return undefined;
    if (row.state === "published" || row.state === "publish-pending") return { kind: "settled", operationId: row.id };
    return ["running", "uncertain"].includes(row.state) && parseJob(row.result) && !parsePending(row.result) ? { kind: "job", operationId: row.id } : undefined;
  }
  /** Restore-held operations that could be a re-ask of this request: those naming its resumeKey, and held rows that predate it. Narrowed by the request hash in SQL and never limited: the identity match
   * happens over every candidate, so newer unrelated holds cannot hide the one being asked for again. */
  private heldCandidates(resumeKey: string, requestHash: string) {
    type Held = { id: string; generation: string; request_hash: string; state: string; result: string | null };
    try {
      return this.db().prepare("SELECT o.id,o.generation,o.request_hash,o.state,o.result FROM image_operations o JOIN restore_holds h ON h.kind='image_operation' AND h.row_id=o.id WHERE o.state IN ('publish-pending','running','uncertain') AND json_valid(o.result) AND (json_extract(o.result,'$.resumeKey')=? OR json_extract(o.result,'$.resumeKey') IS NULL) AND o.request_hash=? ORDER BY o.updated_at DESC").all(resumeKey, requestHash) as unknown as Held[];
    } catch { return []; }
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
      const carried = this.db().prepare("SELECT id,request_hash,state,result FROM image_operations WHERE state IN ('running','uncertain') AND json_valid(result) AND json_extract(result,'$.resumeKey')=? AND request_hash=? ORDER BY updated_at DESC LIMIT 1").get(resumeKey, requestHash) as Prior | undefined;
      if (carried && carried.request_hash === requestHash && parseJob(carried.result) && !parsePending(carried.result)) { id = carried.id; prior = carried; }
    }
    if (!prior) {
      // A restore held a received image of this same request (bot, thread, request_id, request hash) in an earlier turn:
      // the owner asking again is the release. It is finished from the retained bytes, never rendered a second time.
      // A row held before resumeKey existed carries none: its identity is re-derived from the generation it was started under
      // (the id is a hash of bot, thread, that generation and the request id), so it matches the same way.
      const held = this.heldCandidates(resumeKey, requestHash).find(row => row.request_hash === requestHash && parsePending(row.result)
        && (progressOf(row.result).resumeKey === resumeKey || row.id === hash(`${actor.botId}:${actor.threadId}:${row.generation.split("#")[0]}:${requestId}`)));
      if (held) { id = held.id; prior = held; }
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
    if (prior?.state === "published" && prior.result) {
      const published = JSON.parse(prior.result) as T;
      return (async () => { const value = await this.refreshPublished(actor, id, published); this.releaseHoldWhenPublished(id, value); return value; })();
    }
    // The owner asking for an operation a restore held is the explicit action that releases it: it is finished from the
    // retained bytes (no provider call), also when the restore caught it before it was marked publish-pending.
    const heldByRestore = prior !== undefined && sqlRowRestoreHeld(this.db(), "image_operation", prior.id);
    // The hold is dropped only after the images are truly published (receipt, transcript AND Files copy): a Files failure keeps it.
    const releaseAfter = Boolean(prior && heldByRestore && parsePending(prior.result));
    // A held provider job without retained bytes is polled again: its hold stays through the polling and the Files copy
    // and is dropped only once every image is published (a failure anywhere keeps it held).
    const heldJob = Boolean(prior && heldByRestore && !parsePending(prior.result) && ["running", "uncertain"].includes(prior.state) && parseJob(prior.result));
    if (prior && heldByRestore && parsePending(prior.result)) {
      if (prior.state !== "publish-pending") { this.db().prepare("UPDATE image_operations SET state='publish-pending',updated_at=? WHERE id=?").run(Date.now(), prior.id); prior = { ...prior, state: "publish-pending" }; }
    } else if (prior && heldByRestore && !heldJob) releaseHeldImageOperation(this.db(), prior.id);
    if (prior?.state === "publish-pending") return this.resume<T>(actor, id, prior.result, releaseAfter);
    // A provider job this request already started (contract section 4): the
    // same request_id polls it again. It never submits a second render.
    const priorJob = prior && ["running", "uncertain"].includes(prior.state) && !parsePending(prior.result) ? parseJob(prior.result) : undefined;
    if (prior && !priorJob) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    if (!priorJob) {
      const earlier = this.turnOperations(actor);
      if (earlier.length) {
        // Card path: one attempt per turn, as always. Only where this bot makes
        // images without asking (probed with no images: the level, the setting
        // and the audience, not the count) may a turn go on, and only once every
        // earlier attempt is known: a new request_id can never start a second
        // render while the first one's outcome is unknown.
        if (!this.autoDecision(actor, { count: 0, madeThisTurn: 0 })) throw error(429, "One image attempt is allowed per turn. Start a new task or turn for another image. (Several requests in one turn are allowed only when this bot makes images without asking.)");
        if (earlier.some(row => row.state !== "published" && row.state !== "not-dispatched")) throw error(409, "An earlier image request in this turn has not finished or was interrupted. Check its earlier result and provider billing; no new request was sent.");
      }
      // The first attempt of a turn is keyed by the generation itself; a later one
      // gets its own key under it (the column is unique), so every row of the
      // turn is found by that prefix.
      this.db().prepare("INSERT INTO image_operations VALUES(?,?,?,'awaiting',NULL,?)").run(id, earlier.length ? `${actor.generation}#${id}` : actor.generation, requestHash, Date.now());
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
      this.db().prepare("UPDATE image_operations SET state=?,result=COALESCE(?,result),updated_at=? WHERE id=?").run(state, patch ? JSON.stringify({ ...current, ...patch, resumeKey }) : null, Date.now(), id);
    };
    const retained: string[] = [], items: GeneratedImageMetadata[] = [];
    const publish: PublishOperationImage = async (image, metadata) => await publishImage(this.store, actor, image, metadata, { operationId: id,
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
      record("running", { count: details.count });
      return { finish: (outcome: ImageAttemptOutcome) => record(outcome) };
    };
    const context: ImageWorkContext = { operationId: id, ...(priorJob ? { resumeJob: priorJob } : {}), jobStarted: job => record("running", { job, resumeKey }) };
    const job = Promise.resolve().then(() => work(reserve, publish, context)).then(result => {
      this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
      if (heldJob) this.releaseHoldWhenPublished(id, result);
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
  private async completeAll(receipts: Array<{ id: string }>, metadata: GeneratedImageMetadata, items?: GeneratedImageMetadata[], strict = false, recheck?: () => void, turnId?: string): Promise<ImageOperationResult> {
    // One at a time, in order, as before: each image's transcript entry follows the one before it.
    const artifacts: ImageArtifact[] = [];
    for (const [index, receipt] of receipts.entries()) {
      const each: GeneratedImageMetadata = items?.[index] ?? (receipts.length > 1 ? { ...metadata, imageIndex: index, delivered: metadata.delivered?.[index] ? [metadata.delivered[index]!] : metadata.delivered } : metadata);
      artifacts.push(imageArtifact(await completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: imageTranscriptText(each), artifactName: artifactName(each), turnId, recheck })));
    }
    // A held release needs the Files copy too; anything less throws so the caller keeps the hold.
    if (strict && artifacts.some(item => item.filesError || !item.artifactId)) throw error(409, imagePublishRecoveryMessage(artifacts.find(item => item.filesError)?.filesError));
    return { artifact: artifacts[0]!, artifacts, metadata };
  }
  /** Same request_id after a local publication failure: finish from the
   * retained receipts with zero provider calls and no new approval. */
  private resume<T>(actor: ImageActor, id: string, result: string | null, releaseHold = false): Promise<T> {
    const pending = parsePending(result), receipts = pending ? this.pendingReceipts(actor, id, pending) : null;
    if (!pending || !receipts || receipts[0]!.id !== pending.receiptId) throw error(409, "This image request already finished or was interrupted. Check its earlier result and provider billing; it will not be retried automatically.");
    if (this.workspaces.has(actor.botId)) throw error(409, "An image request is already active in this bot's workspace.");
    this.workspaces.add(actor.botId);
    const job = Promise.resolve().then(async () => {
      actor.assertActive();
      if (actor.signal.aborted) throw error(409, "Image operation was cancelled.");
      const value = await this.completeAll(receipts, pending.metadata, pending.items, releaseHold,
        () => { actor.assertActive(); if (actor.signal.aborted) throw error(409, "Image operation was cancelled."); }, actor.turnId);
      this.db().prepare("UPDATE image_operations SET state='published',result=?,updated_at=? WHERE id=? AND state='publish-pending'").run(JSON.stringify(value), Date.now(), id);
      if (releaseHold) releaseHeldImageOperation(this.db(), id);
      return value as T;
    }).catch(e => {
      const category = outputReceipt(database(), receipts[0]!.id)?.errorCategory;
      throw (e as { status?: number }).status === 409 && /revoked|cancel/i.test(String((e as Error).message)) ? e : error(409, imagePublishRecoveryMessage(category));
    }).finally(() => { this.jobs.delete(id); this.workspaces.delete(actor.botId); });
    this.jobs.set(id, job); return job;
  }
  /** Drops an operation's restore hold once every image of its result is published (receipt, transcript and Files copy). */
  private releaseHoldWhenPublished(id: string, value: unknown): void {
    try {
      if (!sqlRowRestoreHeld(this.db(), "image_operation", id) || !isOperationResult(value)) return;
      const artifacts = value.artifacts?.length ? value.artifacts : [value.artifact];
      if (artifacts.every(artifact => artifact.artifactId && !artifact.filesError)) releaseHeldImageOperation(this.db(), id);
    } catch { /* the hold stays; the next request for it tries again */ }
  }
  /** A published image whose Files copy did not finish is retried from its
   * retained bytes when the same request is repeated; no provider work. */
  private async refreshPublished<T>(actor: ImageActor, id: string, value: T): Promise<T> {
    if (!isOperationResult(value)) return value;
    const artifacts = value.artifacts?.length ? value.artifacts : [value.artifact];
    if (artifacts.every(artifact => artifact.artifactId)) return value;
    const receipts = outputReceiptsForRun(database(), "image-operation", actor.botId, actor.threadId, id);
    try {
      actor.assertActive();
      const refreshed: ImageArtifact[] = [];
      for (const artifact of artifacts) {
        const receipt = receipts.find(item => item.id === artifact.id);
        refreshed.push(artifact.artifactId || !receipt ? artifact : imageArtifact(await completeImageOutput(outputDeps(this.store), receipt.id, { transcriptText: imageTranscriptText(value.metadata), artifactName: artifactName(value.metadata), turnId: actor.turnId,
          recheck: () => actor.assertActive() })));
      }
      const updated: ImageOperationResult = { ...value, artifact: refreshed[0]!, ...(value.artifacts ? { artifacts: refreshed } : {}) };
      this.db().prepare("UPDATE image_operations SET result=?,updated_at=? WHERE id=? AND state='published'").run(JSON.stringify(updated), Date.now(), id);
      return updated as T;
    } catch { return value; }
  }
  /** Startup reconciliation: only operations that recorded a retained image
   * receipt are completed, into their exact recorded conversation. */
  async resumePendingPublications(limit = 50, options: { tried?: Set<string>; release?: boolean } = {}): Promise<number> {
    if (options.release !== false) this.releaseUndispatchedOperations();
    // `tried` (a start's recovery in slices): operations an earlier slice looked at are passed over, so one that stays pending never fills the next slice
    const tried = options.tried;
    const rows = (this.db().prepare(`SELECT id,state,result FROM image_operations WHERE state IN ('publish-pending','running','uncertain') AND result IS NOT NULL${notRestoreHeldSql(this.db(), "image_operation", "image_operations.id")} ORDER BY updated_at LIMIT ?`).all(limit + (tried?.size ?? 0)) as Array<{ id: string; state: string; result: string | null }>)
      .filter(row => !tried?.has(row.id)).slice(0, limit);
    for (const row of rows) tried?.add(row.id);
    let completed = 0;
    for (const row of rows) {
      // a restore keeps this image: only the owner's own request for it finishes it (execute). Held rows are
      // excluded in the query above, before the LIMIT, so they never fill the batch; this is the belt.
      if (sqlRowRestoreHeld(this.db(), "image_operation", row.id)) continue;
      const pending = parsePending(row.result);
      const receipts = pending ? pending.receiptIds!.map(receiptId => outputReceipt(database(), receiptId)) : [];
      if (!pending || !receipts.length || receipts.some(receipt => !receipt || receipt.producer !== "image-operation" || receipt.runId !== row.id)) continue;
      try {
        const value = await this.completeAll(receipts as Array<{ id: string }>, pending.metadata, pending.items);
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
  private releaseUndispatchedOperations(): number {
    // Only rows seen at startup are candidates, so walk exactly those: a LIMIT over every awaiting row would let
    // this process's own live requests fill the batch and hide the abandoned ones.
    const rows = [...this.startupUndispatched].map(id => ({ id }));
    let released = 0;
    for (const row of rows) {
      if (this.jobs.has(row.id)) continue;
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
  /** Every operation row this turn (generation) has, first attempt and later ones. */
  private turnOperations(actor: Pick<ImageActor, "generation">) {
    return this.db().prepare("SELECT state,result FROM image_operations WHERE generation=? OR (generation>=? AND generation<?)").all(actor.generation, `${actor.generation}#`, `${actor.generation}$`) as Array<{ state: string; result: string | null }>;
  }
  /** Images this turn already made or has under way: a finished render's own
   * image count, and the count a running one recorded when it was reserved. */
  private madeThisTurn(actor: Pick<ImageActor, "generation">): number {
    let total = 0;
    for (const row of this.turnOperations(actor)) {
      if (row.state === "published" && row.result) {
        try { const value = JSON.parse(row.result) as unknown; total += isOperationResult(value) ? (value.artifacts?.length || 1) : 1; } catch { total += 1; }
      } else if (row.state === "running" || row.state === "uncertain" || row.state === "publish-pending") {
        const count = progressOf(row.result).count;
        total += typeof count === "number" && count > 0 ? count : 1;
      }
    }
    return total;
  }
  /** The no-card decision for this turn, or null (ask). A decision that cannot be read asks. */
  private autoDecision(actor: ImageActor, ask: { count: number; madeThisTurn: number }): ImageAutoApproval | null {
    try { return this.autoApproval?.(actor, ask) ?? null; } catch { return null; }
  }
  private approve(actor: ImageActor, details: ImageOperationDetails, request: unknown, input?: ImageApprovalCardInput): Promise<ApprovalAnswer> {
    if (this.lateAllows.delete(actor.threadId)) return Promise.resolve("allow");
    const requestId = `image-${randomUUID()}`;
    // `held` is the full assembled prompt: exactly what the provider is sent.
    const prompt = (input?.prompt ?? (request && typeof request === "object" && "prompt" in request ? String(request.prompt) : ""))
      + (input?.negativePrompt ? `\n\nNegative prompt (sent in its own field): ${input.negativePrompt}` : "");
    const from = this.speaker?.(actor.threadId, actor.botId);
    // No card when the bot's level or its Images setting says so for this
    // turn's audience (server/image-approval.ts). A decision that cannot be
    // read asks, as it always has. The turn's Stop still ends the render.
    const auto = this.autoDecision(actor, { count: details.count, madeThisTurn: this.madeThisTurn(actor) });
    if (auto) {
      if (actor.signal.aborted) return Promise.resolve("gone");
      // logged only now: a Stop before this point must not log an image that was never made
      try { this.autoApprovalLogged?.(actor, details, auto); } catch { /* the log never changes the render */ }
      // Murage's line, but it quotes the model's prompt: it names the producing turn, so it rests on that turn's inputs (murage-line.ts)
      // and is withheld when they are revoked. With no turn named it rests on none.
      this.store.appendMessage(actor.threadId, murageLine({ role: "bot", kind: "activity", turnId: actor.turnId, ...(from ? { from } : {}), tool: {
        name: `Making an image without asking (${auto.basis})`, ok: true,
        imageRecord: { summary: imageApprovalSubtitle(details), prompt: redactSecretsInText(prompt) },
      } }));
      return Promise.resolve("allow");
    }
    // `held` is the model's prompt: the card names the producing turn so it is withheld with that turn's inputs, as the line above
    const card = this.store.appendMessage(actor.threadId, murageLine({ role: "bot", kind: "options", turnId: actor.turnId, ...(from ? { from } : {}), card: {
      title: details.operation === "edit" ? "Approve image edit" : "Approve image generation",
      // F1-T4: the owner approves the exact upstream that will bill them. An
      // OpenRouter edit names its pinned endpoint; nothing else is routed.
      // No cost on the card: it states the engine, sizes, count, references
      // and prompt the owner is approving (image-generation.ts).
      subtitle: imageApprovalSubtitle(details),
      held: prompt, options: ["Allow", "Deny"], requestId, tool: "generate_image",
    } }));
    this.waiting(actor.threadId, true, requestId, card.id, actor.botId);
    let held = false;
    try { held = this.routineCard?.opened(actor.threadId, requestId, card.card?.title ?? "Approve image") === true; } catch { /* delivery never changes authority */ }
    const projectHeld = this.holdProjectApproval?.(actor.threadId) === true;
    return new Promise<ApprovalAnswer>(resolve => {
      let settled = false;
      let answered = false;
      // Only the owner's own answer is recorded as allow/deny. A card nobody
      // answered (turn cancelled, request revoked)
      // settles as "unavailable", the same closing the harness gives every
      // other approval its turn abandoned, so it never reads as a denial.
      const finish = (allow: boolean, source: "user" | "system" = "system") => {
        const entry = this.pending.get(requestId);
        if (entry?.detached) {
          // the tool call already gave up; this is the owner's late answer
          if (answered) return; answered = true; this.pending.delete(requestId);
          let resumed = false;
          try { resumed = this.routineCard?.closed(actor.threadId, requestId, source === "user" ? (allow ? "allow" : "deny") : "none") === true; } catch { /* delivery never changes authority */ }
          // an Allow that nothing carries on (a project card whose call
          // ended, a routine that does not resume) makes no image: the card
          // closes as expired and the answer returns unavailable (the answer
          // route then says the request is no longer open), never "allowed"
          const unused = source === "user" && allow && !resumed;
          const current = this.store.messageById(actor.threadId, card.id);
          if (current?.card && !current.card.answered) this.store.patchMessage(actor.threadId, card.id, { card: { ...current.card, answered: source === "user" && !unused ? (allow ? "allow" : "deny") : "unavailable", dismissed: source !== "user" || unused } });
          if (unused && entry) entry.unused = true;
          if (resumed && allow && source === "user") this.lateAllows.add(actor.threadId);
          return;
        }
        if (settled) return; settled = true; actor.signal.removeEventListener("abort", abort); this.pending.delete(requestId);
        if (held) { try { this.routineCard?.closed(actor.threadId, requestId, source === "user" ? (allow ? "allow" : "deny") : "none"); } catch { /* delivery never changes authority */ } }
        const current = this.store.messageById(actor.threadId, card.id);
        if (current?.card && !current.card.answered) this.store.patchMessage(actor.threadId, card.id, { card: { ...current.card, answered: source === "user" ? (allow ? "allow" : "deny") : "unavailable", dismissed: source !== "user" } });
        this.waiting(actor.threadId, false, requestId, undefined, actor.botId);
        resolve(source === "user" ? (allow ? "allow" : "deny") : "gone");
      };
      const abort = () => {
        // A routine run holds the card: the tool call gave up (its turn is
        // over), but the card stays the owner's to answer and the run waits.
        const entry = this.pending.get(requestId);
        if ((held || projectHeld) && entry && !settled) {
          settled = true; actor.signal.removeEventListener("abort", abort);
          entry.detached = true;
          this.waiting(actor.threadId, false, requestId, undefined, actor.botId); resolve("gone");
          return;
        }
        finish(false);
      };
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
    pending.settle(behavior === "allow", "user");
    if (pending.unused) return "unavailable";
    return behavior === "allow" ? "allowed-once" : "rejected";
  }
  cancelThread(threadId: string) { for (const pending of this.pending.values()) if (pending.threadId === threadId) pending.settle(false); }
}
