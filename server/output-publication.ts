// Automatic publication of trusted outputs.
//
// R3-T3 (U-02): a Murage-managed dedicated task workspace gets an `outputs/`
// namespace. beforeDispatch snapshots (name,size,mtime,dev/ino) of that
// namespace; publishTerminalOutputs diffs it once on turn.completed. New or
// changed regular files become verified LocalOutputReceipts; a successful turn
// registers them into Files and persists exactly one host-authored card, a
// cancelled or failed turn leaves them `retained`. Custom project folders,
// cloud runs, rooms and HOME are never snapshotted.
//
// R3-T4 (C2): generated images (image operations and native assistant_image
// items) are written to a managed per-conversation root, receipted before any
// attachment/transcript/Files step, and completed idempotently from those
// retained bytes. Recovery never re-dispatches a provider request.
//
// Contract: shared/output-publication.ts and docs/plans/0152-CONTRACTS.md.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  OUTPUT_PUBLICATION_LIMITS, canAdvanceOutputStage, isOutputProducer, isOutputReceiptStage,
  type LocalOutputReceipt, type OutputProducer, type OutputPublicationErrorCategory, type OutputReceiptStage,
} from "../shared/output-publication.ts";
import { OUTPUT_NAMESPACE, WORKSPACE_SEARCH_MAX_DEPTH, WORKSPACE_SEARCH_MAX_ENTRIES } from "../shared/workspace-files.ts";
import type { Artifact } from "../shared/artifacts.ts";
import { ArtifactError, artifactWorkspaceIdentity, registerArtifact, type ArtifactScope } from "./artifacts.ts";
import { IMAGE_MAX_BYTES, saveImage, type SavedAttachment } from "./attachments.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { Store } from "./store.ts";

export type TerminalTurnEvent = Extract<RuntimeEvent, { type: "turn.completed" }>;

/** Facts known at dispatch, after the workspace claim and before the
 * provider sees the prompt. */
export interface DispatchOutputContext {
  botId: string;
  threadId: string;
  /** Dispatch claim id for this turn (the run id receipts record). */
  runId: string;
  /** Canonical working folder of this turn, when it has one. */
  workspaceRoot: string | undefined;
  /** True only for the Murage-managed dedicated task workspace (U-02). */
  managed: boolean;
}

export interface OutputPublicationDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  artifactScopes: () => ArtifactScope[];
}

export interface OutputPublisher {
  /** Called synchronously at dispatch. Must not throw or block. Takes the
   * U-02 `outputs/` snapshot for a managed task workspace. */
  beforeDispatch(context: DispatchOutputContext): void;
  /** Called once per turn.completed from the main event fold, outside the
   * direct-run lease release. Failures are recorded as receipts; the
   * returned promise does not reject. */
  publishTerminalOutputs(event: TerminalTurnEvent): Promise<void>;
  /** Startup reconciliation of known pending assistant-image receipts only.
   * Shell outputs are never auto-registered outside a successful turn. */
  resumePending(): void;
}

// ---------------------------------------------------------------------------
// Receipts (SQLite output_publications, schema frozen by K0)

interface ReceiptRow {
  id: string; producer: string; bot_id: string; thread_id: string; run_id: string; path_token: string; sha256: string; mime: string; bytes: number;
  stage: string; artifact_id: string | null; attachment_id: string | null; message_id: string | null; error_category: string | null; created_at: number; updated_at: number;
}

const ERROR_CATEGORIES = new Set<string>(["quota", "filesystem", "database", "attachment", "transcript", "scope", "verification", "limit"]);

function receiptFromRow(row: ReceiptRow): LocalOutputReceipt {
  if (!isOutputProducer(row.producer) || !isOutputReceiptStage(row.stage)) throw new OutputPublicationError("database", "An output receipt is invalid.");
  return {
    id: row.id, producer: row.producer, botId: row.bot_id, threadId: row.thread_id, runId: row.run_id, pathToken: row.path_token,
    sha256: row.sha256, mime: row.mime, bytes: Number(row.bytes), stage: row.stage,
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.attachment_id ? { attachmentId: row.attachment_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.error_category && ERROR_CATEGORIES.has(row.error_category) ? { errorCategory: row.error_category as OutputPublicationErrorCategory } : {}),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class OutputPublicationError extends Error {
  readonly category: OutputPublicationErrorCategory;
  readonly status: number;
  constructor(category: OutputPublicationErrorCategory, message: string, status = 409) { super(message); this.category = category; this.status = status; }
}

export interface OutputReceiptInput { id?: string; producer: OutputProducer; botId: string; threadId: string; runId: string; pathToken: string; sha256: string; mime: string; bytes: number }

/** Idempotent on (producer,bot,thread,run,path,sha256): a repeated sweep or
 * resume returns the existing receipt instead of creating a second one. */
export function recordOutputReceipt(db: DatabaseSync, input: OutputReceiptInput): LocalOutputReceipt {
  if (!isOutputProducer(input.producer) || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new OutputPublicationError("verification", "An output receipt is invalid.");
  const now = Date.now();
  db.prepare(`INSERT INTO output_publications(id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'retained',?,?) ON CONFLICT(producer,bot_id,thread_id,run_id,path_token,sha256) DO NOTHING`)
    .run(input.id ?? randomUUID(), input.producer, input.botId, input.threadId, input.runId, input.pathToken, input.sha256, input.mime, input.bytes, now, now);
  const row = db.prepare("SELECT * FROM output_publications WHERE producer=? AND bot_id=? AND thread_id=? AND run_id=? AND path_token=? AND sha256=?")
    .get(input.producer, input.botId, input.threadId, input.runId, input.pathToken, input.sha256) as unknown as ReceiptRow | undefined;
  if (!row) throw new OutputPublicationError("database", "The output receipt could not be saved.");
  return receiptFromRow(row);
}

export function outputReceipt(db: DatabaseSync, id: string): LocalOutputReceipt | undefined {
  const row = db.prepare("SELECT * FROM output_publications WHERE id=?").get(id) as unknown as ReceiptRow | undefined;
  return row ? receiptFromRow(row) : undefined;
}

export function outputReceiptsForRun(db: DatabaseSync, producer: OutputProducer, botId: string, threadId: string, runId: string): LocalOutputReceipt[] {
  return (db.prepare("SELECT * FROM output_publications WHERE producer=? AND bot_id=? AND thread_id=? AND run_id=? ORDER BY created_at,id")
    .all(producer, botId, threadId, runId) as unknown as ReceiptRow[]).map(receiptFromRow);
}

export interface OutputReceiptPatch { stage?: OutputReceiptStage; artifactId?: string; attachmentId?: string; messageId?: string; errorCategory?: OutputPublicationErrorCategory | null }

/** Stage changes follow OUTPUT_STAGE_TRANSITIONS and are conditional on the
 * stage just read, so two resumes cannot both advance one receipt. */
export function updateOutputReceipt(db: DatabaseSync, id: string, patch: OutputReceiptPatch): LocalOutputReceipt {
  const current = outputReceipt(db, id);
  if (!current) throw new OutputPublicationError("database", "The output receipt is unavailable.");
  const stage = patch.stage ?? current.stage;
  if (stage !== current.stage && !canAdvanceOutputStage(current.stage, stage)) throw new OutputPublicationError("database", `An output receipt cannot move from ${current.stage} to ${stage}.`);
  const result = db.prepare(`UPDATE output_publications SET stage=?, artifact_id=COALESCE(?,artifact_id), attachment_id=COALESCE(?,attachment_id), message_id=COALESCE(?,message_id),
    error_category=?, updated_at=? WHERE id=? AND stage=?`).run(stage, patch.artifactId ?? null, patch.attachmentId ?? null, patch.messageId ?? null,
    patch.errorCategory === undefined ? (current.errorCategory ?? null) : patch.errorCategory, Date.now(), id, current.stage);
  if (Number(result.changes) !== 1) throw new OutputPublicationError("database", "The output receipt changed during publication.");
  return outputReceipt(db, id)!;
}

/** Only redacted categories leave this module; paths and messages do not. */
export function outputErrorCategory(error: unknown, fallback: OutputPublicationErrorCategory): OutputPublicationErrorCategory {
  if (error instanceof OutputPublicationError) return error.category;
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 507) return "quota";
  if (status === 413) return "limit";
  if (status === 403 || status === 404) return "scope";
  if (error instanceof ArtifactError && status === 409) return "verification";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "quota";
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return "filesystem";
  return fallback;
}

function failReceipt(db: DatabaseSync, id: string, category: OutputPublicationErrorCategory) {
  try { return updateOutputReceipt(db, id, { stage: "failed", errorCategory: category }); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Verified reads

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Reads one ordinary, singly linked file without following links and
 * refuses a file that changes identity or size while it is read. */
function readStableFile(path: string, limit: number, expected?: Stats): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new OutputPublicationError("verification", "Only ordinary files are published.");
  if (expected && !sameFile(expected, before)) throw new OutputPublicationError("verification", "The output changed before it could be verified.");
  if (before.size > limit) throw new OutputPublicationError("limit", "The output exceeds the supported size limit.", 413);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, fstatSync(fd))) throw new OutputPublicationError("verification", "The output changed during verification.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new OutputPublicationError("verification", "The output changed during verification.");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path))) throw new OutputPublicationError("verification", "The output changed during verification.");
    return bytes;
  } finally { closeSync(fd); }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain", ".tsv": "text/plain", ".json": "text/plain", ".log": "text/plain",
};
const mimeFor = (path: string) => MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Same private-name rule as Files registration: setup, memory and
 * credential locations are never deliverables, even under outputs/. */
function privateOutputPath(relativePath: string) {
  const parts = relativePath.split("/");
  return parts.some(part => /^(memory|skills|credentials)$/i.test(part)) || /^(MEMORY|SOUL|AGENTS|CLAUDE)\.md$/i.test(parts.at(-1)!)
    || parts.some(part => part.length > 255 || /[\\\u0000-\u001f:]/.test(part)) || relativePath.length > 2048;
}

// ---------------------------------------------------------------------------
// R3-T3: outputs/ snapshot and terminal sweep

interface OutputListing { directory: { dev: number; ino: number }; entries: Map<string, Stats>; incomplete: boolean }
interface OutputSnapshot { botId: string; threadId: string; runId: string; root: string; directory: { dev: number; ino: number }; entries: Map<string, string>; incomplete: boolean }

const entryKey = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
const MAX_SNAPSHOTS = 500;

/** Bounded metadata walk of `<root>/outputs`: no content reads, no symlink
 * follow, hidden entries skipped, 2,000 entries / depth 8 (shared bounds). */
function listOutputs(root: string): OutputListing | undefined {
  const top = join(root, OUTPUT_NAMESPACE);
  let stat: Stats;
  try { stat = lstatSync(top); } catch { return undefined; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const entries = new Map<string, Stats>(); let visited = 0, incomplete = false;
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > WORKSPACE_SEARCH_MAX_DEPTH) { incomplete = true; return; }
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch { incomplete = true; return; }
    for (const name of names) {
      if (incomplete && visited >= WORKSPACE_SEARCH_MAX_ENTRIES) return;
      if (name.startsWith(".")) continue;
      if (++visited > WORKSPACE_SEARCH_MAX_ENTRIES) { incomplete = true; return; }
      const path = join(directory, name), relativePath = `${prefix}/${name}`;
      let entry: Stats;
      try { entry = lstatSync(path); } catch { continue; }
      if (entry.isDirectory()) walk(path, relativePath, depth + 1);
      else entries.set(relativePath, entry);
    }
  };
  walk(top, OUTPUT_NAMESPACE, 1);
  return { directory: { dev: stat.dev, ino: stat.ino }, entries, incomplete };
}

function outputCardText(names: string[], notSaved: number) {
  const shown = names.slice(0, 5).map(name => name.slice(0, 120));
  const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : "";
  const saved = names.length === 1 ? `Saved file: ${shown[0]}` : names.length ? `Saved ${names.length} files: ${shown.join(", ")}${more}` : "";
  const skipped = notSaved ? `${notSaved === 1 ? "1 file" : `${notSaved} files`} in outputs/ could not be saved automatically and remain in the task workspace.` : "";
  return [saved, skipped].filter(Boolean).join("\n");
}

const log = (message: string) => console.warn(`[output-publication] ${message}`);
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

export function createOutputPublisher(deps: OutputPublicationDeps): OutputPublisher {
  const snapshots = new Map<string, OutputSnapshot>();

  const sweep = async (snapshot: OutputSnapshot, event: TerminalTurnEvent) => {
    const after = listOutputs(snapshot.root);
    if (!after || after.directory.dev !== snapshot.directory.dev || after.directory.ino !== snapshot.directory.ino) { log("output folder was replaced during the turn; nothing was published automatically"); return; }
    if (snapshot.incomplete) { log("output folder exceeded the sweep budget before the turn; nothing was published automatically"); return; }
    const changed = [...after.entries].filter(([path, stat]) => snapshot.entries.get(path) !== entryKey(stat)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (!changed.length) return;
    let notSaved = 0; const eligible: Array<[string, Stats]> = [];
    for (const [path, stat] of changed) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > OUTPUT_PUBLICATION_LIMITS.maxFileBytes || privateOutputPath(path)) notSaved++;
      else eligible.push([path, stat]);
    }
    const selected = eligible.slice(0, OUTPUT_PUBLICATION_LIMITS.maxFilesPerTurn); notSaved += eligible.length - selected.length;
    const db = deps.database();
    const scope = deps.artifactScopes().find(scope => scope.botId === snapshot.botId && scope.threadId === snapshot.threadId && scope.threadAvailable !== false && scope.managedOutput !== true);
    let scopeMatches = false;
    try { scopeMatches = Boolean(scope) && artifactWorkspaceIdentity(scope!.workspaceRoot) === snapshot.root; } catch { scopeMatches = false; }
    const registered: Array<{ receipt: LocalOutputReceipt; artifact: Artifact }> = [];
    for (const [path, stat] of selected) {
      await nextTick();
      let bytes: Buffer;
      try { bytes = readStableFile(join(snapshot.root, ...path.split("/")), OUTPUT_PUBLICATION_LIMITS.maxFileBytes, stat); }
      catch { notSaved++; continue; }
      let receipt: LocalOutputReceipt;
      try { receipt = recordOutputReceipt(db, { producer: "shell-output", botId: snapshot.botId, threadId: snapshot.threadId, runId: snapshot.runId, pathToken: path, sha256: sha256(bytes), mime: mimeFor(path), bytes: bytes.length }); }
      catch { notSaved++; continue; }
      // U-02: cancelled or failed turns keep verified receipts only.
      if (!event.ok) continue;
      if (receipt.stage === "registered") continue;
      if (!scope || !scopeMatches) { failReceipt(db, receipt.id, "scope"); notSaved++; continue; }
      // A later run that rewrote identical bytes at the same path reuses the
      // version already saved from this workspace: no duplicate row or card.
      const prior = db.prepare(`SELECT p.artifact_id AS artifact_id FROM output_publications p JOIN artifacts a ON a.id=p.artifact_id
        WHERE p.producer='shell-output' AND p.stage='registered' AND p.bot_id=? AND p.thread_id=? AND p.path_token=? AND p.sha256=? AND p.run_id<>? AND a.source_root=? AND a.sha256=p.sha256
        ORDER BY p.updated_at DESC LIMIT 1`).get(snapshot.botId, snapshot.threadId, path, receipt.sha256, snapshot.runId, snapshot.root) as { artifact_id: string } | undefined;
      if (prior) { try { updateOutputReceipt(db, receipt.id, { stage: "registered", artifactId: prior.artifact_id, errorCategory: null }); } catch {} continue; }
      try {
        const artifact = registerArtifact(db, join(deps.dataDir, "artifact-files"), { botId: snapshot.botId, threadId: snapshot.threadId, relativePath: path },
          { owner: true, scopes: [{ ...scope, runId: snapshot.runId }] }, { producer: "shell-output", publicationId: receipt.id });
        if (artifact.sha256 !== receipt.sha256) { failReceipt(db, receipt.id, "verification"); notSaved++; continue; }
        registered.push({ receipt: updateOutputReceipt(db, receipt.id, { stage: "registered", artifactId: artifact.id, errorCategory: null }), artifact });
      } catch (error) {
        failReceipt(db, receipt.id, outputErrorCategory(error, "database")); notSaved++;
      }
    }
    if (!event.ok) return;
    // One host-authored card per turn. An artifact the bot already registered
    // with register_artifact in this run already has its own card.
    let referenced: Set<string>;
    try { referenced = new Set(deps.store.messagesFor(snapshot.threadId).flatMap(message => message.artifactIds ?? [])); } catch { return; }
    const fresh = registered.filter((item, index) => !referenced.has(item.artifact.id) && registered.findIndex(other => other.artifact.id === item.artifact.id) === index);
    if (!fresh.length && !notSaved) return;
    try {
      const message = deps.store.appendMessage(snapshot.threadId, { role: "bot", kind: "text", text: outputCardText(fresh.map(item => item.artifact.name), notSaved),
        ...(fresh.length ? { artifactIds: fresh.map(item => item.artifact.id) } : {}) });
      for (const item of fresh) { try { updateOutputReceipt(db, item.receipt.id, { messageId: message.id }); } catch {} }
    } catch {
      for (const item of fresh) { try { updateOutputReceipt(db, item.receipt.id, { errorCategory: "transcript" }); } catch {} }
      log("saved outputs could not be announced in the conversation; they remain in Files");
    }
  };

  return {
    beforeDispatch(context) {
      snapshots.delete(context.threadId);
      if (!context.managed || !context.workspaceRoot) return;
      try {
        const root = realpathSync.native(context.workspaceRoot);
        const rootStat = lstatSync(root);
        if (!rootStat.isDirectory()) return;
        try { mkdirSync(join(root, OUTPUT_NAMESPACE), { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return; }
        const listing = listOutputs(root);
        if (!listing) return;
        if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(context.threadId, { botId: context.botId, threadId: context.threadId, runId: context.runId, root, directory: listing.directory,
          entries: new Map([...listing.entries].map(([path, stat]) => [path, entryKey(stat)])), incomplete: listing.incomplete });
      } catch {
        snapshots.delete(context.threadId);
      }
    },
    async publishTerminalOutputs(event) {
      // Taken synchronously so a following dispatch starts a fresh snapshot.
      const snapshot = snapshots.get(event.threadId);
      if (!snapshot) return;
      snapshots.delete(event.threadId);
      try { await sweep(snapshot, event); }
      catch (error) { log(`automatic publication stopped (${outputErrorCategory(error, "database")})`); }
    },
    resumePending() {
      try { resumePendingAssistantImages({ db: deps.database(), dataDir: deps.dataDir, store: deps.store }); }
      catch (error) { log(`pending image recovery stopped (${outputErrorCategory(error, "database")})`); }
    },
  };
}

// ---------------------------------------------------------------------------
// R3-T4 / C2: generated image outputs

export type ImageOutputProducer = Extract<OutputProducer, "image-operation" | "assistant-image">;
export interface ImageOutputDeps { db: DatabaseSync; dataDir: string; store: Store }

const inside = (root: string, path: string) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };
const imageIdentityPattern = /^[\w-]{1,160}$/;

/** DATA_DIR/workspaces/<bot>/generated-images/<thread>, without touching disk.
 * Files authorizes saved rows under it with a `managedOutput` scope. */
export function managedImageOutputPath(dataDir: string, botId: string, threadId: string): string {
  return join(dataDir, "workspaces", botId, "generated-images", threadId);
}

/** Creates (when asked) and verifies the private per-conversation image root:
 * every component is a real directory inside DATA_DIR, never a link. */
export function managedImageOutputRoot(dataDir: string, botId: string, threadId: string, create: boolean): string {
  if (!imageIdentityPattern.test(botId) || !imageIdentityPattern.test(threadId)) throw Object.assign(new Error("Invalid image workspace."), { status: 403 });
  const root = realpathSync.native(dataDir);
  let directory = root;
  for (const part of ["workspaces", botId, "generated-images", threadId]) {
    directory = join(directory, part);
    if (create) { try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, realpathSync.native(directory))) throw Object.assign(new Error("Generated-image workspace is not a private directory."), { status: 403 });
  }
  return directory;
}

export interface RetainImageInput { producer: ImageOutputProducer; botId: string; threadId: string; runId: string; bytes: Buffer; mime: string; beforeCommit?: () => void }

/** Commits provider bytes to the managed root and persists their receipt
 * before any attachment, transcript or Files step can fail. */
export function retainImageOutput(deps: Pick<ImageOutputDeps, "db" | "dataDir">, input: RetainImageInput): LocalOutputReceipt {
  const extension = input.mime === "image/jpeg" ? "jpg" : input.mime.split("/")[1];
  if (!["png", "jpg", "gif", "webp"].includes(extension ?? "") || input.bytes.length === 0 || input.bytes.length > IMAGE_MAX_BYTES) throw Object.assign(new Error("unsupported image output"), { status: 400 });
  const directory = managedImageOutputRoot(deps.dataDir, input.botId, input.threadId, true), id = randomUUID();
  const name = `${id}.${extension}`, path = join(directory, name), partial = join(directory, `.${id}.partial`);
  // Directory identity and authority are rechecked immediately before the synchronous commit.
  if (realpathSync.native(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw Object.assign(new Error("Image workspace changed."), { status: 403 });
  input.beforeCommit?.();
  try { writeFileSync(partial, input.bytes, { mode: 0o600, flag: "wx" }); renameSync(partial, path); }
  catch (error) { try { unlinkSync(partial); } catch {} throw error; }
  return recordOutputReceipt(deps.db, { id, producer: input.producer, botId: input.botId, threadId: input.threadId, runId: input.runId, pathToken: name, sha256: sha256(input.bytes), mime: input.mime, bytes: input.bytes.length });
}

export interface ImageOutputCompletion { receipt: LocalOutputReceipt; path: string; saved: SavedAttachment; artifact?: Artifact; filesError?: OutputPublicationErrorCategory }
export interface CompleteImageOptions {
  /** Transcript text for a host-owned image message. Omitted when the caller
   * attaches the image to its own turn message (native assistant_image). */
  transcriptText?: string;
  artifactName: string;
}

function botName(store: Store, botId: string) {
  const bot = store.bot(botId);
  return bot ? bot.name : undefined;
}

/** Idempotent completion from retained bytes: attachment (same upload id),
 * optional transcript entry (found again after a crash), then Files. An
 * attachment or transcript failure throws after recording `failed`; a Files
 * failure is reported in the result so a received image is never hidden. */
export function completeImageOutput(deps: ImageOutputDeps, receiptId: string, options: CompleteImageOptions): ImageOutputCompletion {
  const { db, store } = deps;
  let receipt = outputReceipt(db, receiptId);
  if (!receipt || (receipt.producer !== "image-operation" && receipt.producer !== "assistant-image")) throw new OutputPublicationError("scope", "This image result is unavailable.", 404);
  const owner = store.botByThread(receipt.threadId)?.id === receipt.botId || Boolean(store.groupByThread(receipt.threadId)?.memberIds.includes(receipt.botId));
  if (!owner) throw new OutputPublicationError("scope", "This image result belongs to a conversation that is no longer available.", 404);
  let root: string, bytes: Buffer;
  try {
    root = managedImageOutputRoot(deps.dataDir, receipt.botId, receipt.threadId, false);
    if (!/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(receipt.pathToken)) throw new OutputPublicationError("verification", "The retained image identity is invalid.");
    bytes = readStableFile(join(root, receipt.pathToken), IMAGE_MAX_BYTES);
    if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256) throw new OutputPublicationError("verification", "The retained image changed.");
  } catch (error) {
    const category = outputErrorCategory(error, "verification");
    if (receipt.stage !== "registered") failReceipt(db, receipt.id, category);
    throw new OutputPublicationError(category, "The retained image could not be verified. It was not published.");
  }
  let saved: SavedAttachment;
  try { saved = saveImage(bytes, receipt.mime, receipt.id); }
  catch (error) {
    const category = outputErrorCategory(error, "attachment");
    if (receipt.stage !== "registered") failReceipt(db, receipt.id, category);
    throw new OutputPublicationError(category, "Image received and kept locally, but its conversation attachment could not finish.", 409);
  }
  const attachmentId = basename(saved.path);
  if (options.transcriptText !== undefined && !receipt.messageId) {
    try {
      const existing = store.messagesFor(receipt.threadId).find(message => message.attachments?.some(item => item.path === saved.path));
      const message = existing ?? store.appendMessage(receipt.threadId, { role: "bot", kind: "text", text: options.transcriptText, attachments: [{ kind: "image", path: saved.path, mime: saved.mime }] });
      receipt = updateOutputReceipt(db, receipt.id, { ...(receipt.stage === "registered" ? {} : { stage: "attached" as const }), attachmentId, messageId: message.id, errorCategory: null });
    } catch (error) {
      if (receipt.stage !== "registered") failReceipt(db, receipt.id, error instanceof OutputPublicationError ? error.category : "transcript");
      throw new OutputPublicationError("transcript", "Image received and kept locally, but it could not be added to the conversation.", 409);
    }
  } else if (receipt.attachmentId !== attachmentId) {
    receipt = updateOutputReceipt(db, receipt.id, { attachmentId });
  }
  if (receipt.stage === "registered" && receipt.artifactId) return { receipt, path: join(root, receipt.pathToken), saved };
  const name = botName(store, receipt.botId);
  try {
    if (name === undefined) throw new OutputPublicationError("scope", "The producing bot is unavailable.", 404);
    const artifact = registerArtifact(db, join(deps.dataDir, "artifact-files"), { botId: receipt.botId, threadId: receipt.threadId, relativePath: receipt.pathToken, name: options.artifactName },
      { owner: true, scopes: [{ botId: receipt.botId, botName: name, threadId: receipt.threadId, runId: receipt.runId, workspaceRoot: root, managedOutput: true }] },
      { producer: receipt.producer, publicationId: receipt.id, allowManagedOutput: true });
    if (artifact.sha256 !== receipt.sha256) throw new OutputPublicationError("verification", "The saved image copy did not match the retained bytes.");
    receipt = updateOutputReceipt(db, receipt.id, { stage: "registered", artifactId: artifact.id, attachmentId, errorCategory: null });
    return { receipt, path: join(root, receipt.pathToken), saved, artifact };
  } catch (error) {
    const category = outputErrorCategory(error, "database");
    receipt = failReceipt(db, receipt.id, category) ?? receipt;
    return { receipt, path: join(root, receipt.pathToken), saved, filesError: category };
  }
}

/** Native provider image (assistant_image): retained and receipted first,
 * attached for the caller's turn message, then saved to Files. */
export function publishAssistantImage(deps: ImageOutputDeps, input: { botId: string; threadId: string; runId: string; bytes: Buffer; mime: string }): SavedAttachment {
  const receipt = retainImageOutput(deps, { producer: "assistant-image", ...input });
  return completeImageOutput(deps, receipt.id, { artifactName: "Generated image" }).saved;
}

/** Startup reconciliation for assistant images whose attachment or Files
 * step did not finish. Only known receipts are read; no directory scan. */
export function resumePendingAssistantImages(deps: ImageOutputDeps, limit = 50): number {
  const rows = deps.db.prepare("SELECT * FROM output_publications WHERE producer='assistant-image' AND stage IN ('retained','failed') ORDER BY updated_at,id LIMIT ?").all(limit) as unknown as ReceiptRow[];
  let completed = 0;
  for (const row of rows) {
    try {
      const receipt = receiptFromRow(row);
      const done = completeImageOutput(deps, receipt.id, { artifactName: "Generated image" });
      // The in-memory turn attachment was lost with the process: attach once.
      if (!deps.store.messagesFor(receipt.threadId).some(message => message.attachments?.some(item => item.path === done.saved.path))) {
        const message = deps.store.appendMessage(receipt.threadId, { role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path: done.saved.path, mime: done.saved.mime }] });
        try { updateOutputReceipt(deps.db, receipt.id, { messageId: message.id }); } catch {}
      }
      if (done.artifact) completed++;
    } catch { /* stays failed with its category for the next startup */ }
  }
  return completed;
}
