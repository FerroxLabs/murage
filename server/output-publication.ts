import { managedOutputWorkspace } from "./execution-audience.ts";
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
import { murageTool } from "./murage-tool-surface.ts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { notRestoreHeldSql, sqlRowRestoreHeld } from "./restore-fence.ts";
import {
  OUTPUT_PUBLICATION_LIMITS, canAdvanceOutputStage, isOutputProducer, isOutputReceiptStage,
  type LocalOutputReceipt, type OutputProducer, type OutputPublicationErrorCategory, type OutputReceiptStage,
} from "../shared/output-publication.ts";
import { OUTPUT_NAMESPACE, WORKSPACE_SEARCH_MAX_DEPTH, WORKSPACE_SEARCH_MAX_ENTRIES } from "../shared/workspace-files.ts";
import type { Artifact } from "../shared/artifacts.ts";
import { ARTIFACT_PREVIEW_MAX_BYTES, ARTIFACT_TEXT_EXTENSIONS, ArtifactError, artifactWorkspaceIdentity, readArtifact, registerArtifact, verifiedArtifactSource, type ArtifactScope } from "./artifacts.ts";
import { GENERATED_IMAGE_MAX_BYTES, IMAGE_MAX_BYTES, saveReceiptImage, writeNewReceiptImage, type SavedAttachment } from "./attachments.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { Store } from "./store.ts";
import { turnSucceeded } from "./turn-outcome.ts";
import { murageLine } from "./murage-line.ts";

export type TerminalTurnEvent = Extract<RuntimeEvent, { type: "turn.completed" }>;

/** Facts known at dispatch, after the workspace claim and before the
 * provider sees the prompt. */
export interface DispatchOutputContext {
  botId: string;
  threadId: string;
  /** Dispatch claim id for this turn (the run id receipts record). */
  runId: string;
  /** Canonical file workspace; may differ from a retained engine CWD. */
  workspaceRoot: string | undefined;
  /** True only for the Murage-managed dedicated task workspace (U-02). */
  managed: boolean;
  /** Other managed workspaces of the same project that this turn can write into (a hand-off writes into the lead's
   * outputs/, not its own). Each is snapshotted with the turn and swept with it under its own bot and conversation. */
  siblings?: Array<{ botId: string; threadId: string; workspaceRoot: string }>;
}

export interface OutputPublicationDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  artifactScopes: () => ArtifactScope[];
  /** The provider turn a run (the dispatch claim id receipts record) belongs to, from the server's capability state, never a request; undefined
   * when the capability is gone. The cards that name saved files carry it, so revoking that turn's inputs withholds them. */
  turnOfRun?: (threadId: string, runId: string) => string | undefined;
}

/** A start's recovery in slices (index.ts): at most `limit` image receipts per call, none of `tried` again, and the shell cards only when asked. */
export interface ResumePendingOptions { limit?: number; tried?: Set<string>; shellCards?: boolean }

export interface OutputPublisher {
  /** Called synchronously at dispatch. Must not throw or block. Takes the
   * U-02 `outputs/` snapshot for a managed task workspace. */
  beforeDispatch(context: DispatchOutputContext): boolean;
  /** Called once per turn.completed from the main event fold, outside the
   * direct-run lease release. Failures are recorded as receipts; the
   * returned promise does not reject. */
  publishTerminalOutputs(event: TerminalTurnEvent): Promise<void>;
  /** Startup reconciliation of pending assistant images and already registered
   * successful shell outputs. Shell recovery only repairs their missing cards. */
  resumePending(options?: ResumePendingOptions): Promise<void>;
  /** The owner released this held receipt: finish it directly (verify, save to Files, announce), whatever kind it is. Throws
   * an OutputPublicationError when it cannot finish, so the caller keeps the hold and the item stays listed for a retry. */
  completeReleased(receiptId: string): Promise<void>;
}

/** Host facts only. Prose directs creation but never authorizes publication. */
export function outputDestinationInstructions(context: Pick<DispatchOutputContext, "workspaceRoot" | "managed"> | undefined, snapshotAdmitted: boolean, canRegister: boolean): string {
  if (!context?.workspaceRoot) return "";
  const destination = context.managed ? join(context.workspaceRoot, OUTPUT_NAMESPACE) : context.workspaceRoot;
  return `\n\nFile deliverables for this turn: save completed HTML, Markdown, text and other requested files in this server-selected folder, even when the request does not name a folder. This replaces earlier scratch-folder advice.\nMurage file destination: ${JSON.stringify(destination)}\n`
    + (context.managed && snapshotAdmitted
      ? "Create real files there. After successful completion Murage checks new or changed files for publication to Files and conversation cards; writing a path in prose is not proof that a file was saved."
      : canRegister
        ? `After creating each file, call ${murageTool("register_artifact")} with its path relative to the file workspace; wait for its verified result before saying it is saved to Files.`
        : "Automatic publication is unavailable for this turn and no registration tool is mounted. Report the actual file location without claiming a Files card was created.");
}

// ---------------------------------------------------------------------------
// Receipts (SQLite output_publications, schema frozen by K0)

interface ReceiptRow {
  id: string; producer: string; bot_id: string; thread_id: string; run_id: string; path_token: string; sha256: string; mime: string; bytes: number;
  stage: string; artifact_id: string | null; attachment_id: string | null; message_id: string | null; turn_id?: string | null; error_category: string | null; created_at: number; updated_at: number;
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
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.error_category && ERROR_CATEGORIES.has(row.error_category) ? { errorCategory: row.error_category as OutputPublicationErrorCategory } : {}),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class OutputPublicationError extends Error {
  readonly category: OutputPublicationErrorCategory;
  readonly status: number;
  constructor(category: OutputPublicationErrorCategory, message: string, status = 409) { super(message); this.category = category; this.status = status; }
}

export interface OutputReceiptInput { id?: string; producer: OutputProducer; botId: string; threadId: string; runId: string; pathToken: string; sha256: string; mime: string; bytes: number;
  /** The producing provider turn, from the server's own turn state; kept with the receipt so recovery after a restart can name it. */
  turnId?: string }

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
  // a receipt written before its turn was known gains it once; a turn already recorded is never replaced
  if (input.turnId && !row.turn_id) { db.prepare("UPDATE output_publications SET turn_id=? WHERE id=? AND turn_id IS NULL").run(input.turnId, row.id); row.turn_id = input.turnId; }
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
};
const utf8 = (bytes: Buffer) => { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; } };
/** The receipt's mime describes what Files will show for the saved copy. Text
 * is the shared artifact list (ARTIFACT_TEXT_EXTENSIONS: documents, data,
 * source and configuration formats) under the same bounds as the artifact
 * preview — at most ARTIFACT_PREVIEW_MAX_BYTES and valid UTF-8 — so a binary
 * blob behind a text extension, or an oversized text file, is recorded as an
 * octet stream, exactly as it downloads. */
const mimeFor = (path: string, bytes: Buffer) => {
  const extension = extname(path).toLowerCase();
  if (MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];
  if (ARTIFACT_TEXT_EXTENSIONS.includes(extension) && bytes.length <= ARTIFACT_PREVIEW_MAX_BYTES && utf8(bytes)) return "text/plain";
  return "application/octet-stream";
};

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
  // Per conversation, one record per dispatching bot: members of a project share a conversation, and one member's
  // dispatch must not discard another's snapshot. A record holds the bot's own outputs/ and its siblings' (hand-offs).
  const snapshots = new Map<string, Array<{ botId: string; runId: string; roots: OutputSnapshot[] }>>();
  const snapshotRoot = (botId: string, threadId: string, runId: string, workspaceRoot: string, create: boolean): OutputSnapshot | undefined => {
    const root = realpathSync.native(workspaceRoot);
    if (!lstatSync(root).isDirectory()) return undefined;
    if (create) {
      try { mkdirSync(join(root, OUTPUT_NAMESPACE), { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined; }
    }
    const listing = listOutputs(root);
    if (!listing || listing.incomplete) return undefined;
    return { botId, threadId, runId, root, directory: listing.directory,
      entries: new Map([...listing.entries].map(([path, stat]) => [path, entryKey(stat)])), incomplete: listing.incomplete };
  };

  const sweep = async (snapshot: OutputSnapshot, event: TerminalTurnEvent) => {
    const succeeded = turnSucceeded(event);
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
    // the producing turn, from the terminal event or the capability while it lives; persisted on each receipt so a later recovery names it
    const turnId = event.turnId ?? deps.turnOfRun?.(snapshot.threadId, snapshot.runId);
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
      try { receipt = recordOutputReceipt(db, { producer: "shell-output", botId: snapshot.botId, threadId: snapshot.threadId, runId: snapshot.runId, pathToken: path, sha256: sha256(bytes), mime: mimeFor(path, bytes), bytes: bytes.length, turnId }); }
      catch { notSaved++; continue; }
      // U-02: cancelled or failed turns keep verified receipts only. A stopped
      // turn settles ok:true with stopReason "cancelled", so `ok` is not enough.
      if (!succeeded) continue;
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
    if (!succeeded) return;
    // One host-authored card per turn. An artifact the bot already registered
    // with register_artifact in this run already has its own card.
    let referenced: Set<string>;
    // the thread's file rows, by index: never its chat
    try { referenced = new Set(deps.store.artifactRows(snapshot.threadId).flatMap(message => message.artifactIds ?? [])); } catch { return; }
    const fresh = registered.filter((item, index) => !referenced.has(item.artifact.id) && registered.findIndex(other => other.artifact.id === item.artifact.id) === index);
    if (!fresh.length && !notSaved) return;
    try {
      const message = deps.store.appendMessage(snapshot.threadId, murageLine({ role: "bot", kind: "text", text: outputCardText(fresh.map(item => item.artifact.name), notSaved), turnId,
        ...(fresh.length ? { artifactIds: fresh.map(item => item.artifact.id) } : {}) }));
      for (const item of fresh) { try { updateOutputReceipt(db, item.receipt.id, { messageId: message.id }); } catch {} }
    } catch {
      for (const item of fresh) { try { updateOutputReceipt(db, item.receipt.id, { errorCategory: "transcript" }); } catch {} }
      log("saved outputs could not be announced in the conversation; they remain in Files");
    }
  };

  const resumePending = async (options: ResumePendingOptions = {}) => {
    try { await resumePendingAssistantImages({ db: deps.database(), dataDir: deps.dataDir, store: deps.store }, options.limit ?? 50, options.tried); }
    catch (error) { log(`pending image recovery stopped (${outputErrorCategory(error, "database")})`); }
    if (options.shellCards === false) return;
    try { resumeRegisteredShellCards(deps); }
    catch (error) { log(`pending shell card recovery stopped (${outputErrorCategory(error, "database")})`); }
  };
  return {
    beforeDispatch(context) {
      const records = (snapshots.get(context.threadId) ?? []).filter(record => record.botId !== context.botId);
      if (records.length) snapshots.set(context.threadId, records); else snapshots.delete(context.threadId);
      if (!context.managed || !context.workspaceRoot) return false;
      let own: OutputSnapshot | undefined;
      try { own = snapshotRoot(context.botId, context.threadId, context.runId, context.workspaceRoot, true); } catch { own = undefined; }
      if (!own) return false;
      const roots = [own];
      for (const sibling of context.siblings ?? []) {
        try { const extra = snapshotRoot(sibling.botId, sibling.threadId, context.runId, sibling.workspaceRoot, true); if (extra && extra.root !== own.root) roots.push(extra); } catch { /* a sibling that cannot be watched never blocks this turn */ }
      }
      if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(context.threadId, [...records, { botId: context.botId, runId: context.runId, roots }]);
      return true;
    },
    async publishTerminalOutputs(event) {
      // Taken synchronously so a following dispatch starts a fresh snapshot.
      const records = snapshots.get(event.threadId);
      if (!records?.length) return;
      // The record of the run that just ended; when that cannot be told apart, every record of the conversation.
      const ended = event.turnId ? records.filter(record => deps.turnOfRun?.(event.threadId, record.runId) === event.turnId) : [];
      const taken = ended.length ? ended : records;
      const rest = records.filter(record => !taken.includes(record));
      if (rest.length) snapshots.set(event.threadId, rest); else snapshots.delete(event.threadId);
      for (const record of taken) for (const snapshot of record.roots) {
        try { await sweep(snapshot, event); }
        catch (error) { log(`automatic publication stopped (${outputErrorCategory(error, "database")})`); }
      }
    },
    resumePending,
    completeReleased: async receiptId => { await completeReleasedReceipt(deps, receiptId); },
  };
}

/** Owner-authorized completion of ONE receipt a restore held, for every receipt kind (retained, failed or registered
 * shell outputs and generated images). It never depends on a recovery batch picking the receipt up. */
async function completeReleasedReceipt(deps: OutputPublicationDeps, receiptId: string): Promise<void> {
  const db = deps.database();
  const receipt = outputReceipt(db, receiptId);
  if (!receipt) throw new OutputPublicationError("scope", "This saved output is unavailable.", 404);
  if (receipt.producer === "assistant-image" || receipt.producer === "image-operation") { await finishImageReceipt({ db, dataDir: deps.dataDir, store: deps.store }, receipt.id); return; }
  const scope = deps.artifactScopes().find(item => item.botId === receipt.botId && item.threadId === receipt.threadId && item.threadAvailable !== false && item.managedOutput !== true);
  const owner = deps.store.botByThread(receipt.threadId)?.id === receipt.botId || Boolean(deps.store.groupByThread(receipt.threadId)?.memberIds.includes(receipt.botId));
  if (!scope || !owner) throw new OutputPublicationError("scope", "The conversation this output belongs to is unavailable.", 404);
  if (!receipt.pathToken.startsWith(`${OUTPUT_NAMESPACE}/`) || privateOutputPath(receipt.pathToken)) throw new OutputPublicationError("verification", "The saved output identity changed.");
  let current = receipt;
  const filesDir = join(deps.dataDir, "artifact-files");
  try {
    if (!(current.stage === "registered" && current.artifactId)) {
      const root = artifactWorkspaceIdentity(scope.workspaceRoot);
      const source = verifiedArtifactSource(root, current.pathToken);
      const bytes = readStableFile(source.path, OUTPUT_PUBLICATION_LIMITS.maxFileBytes, source.stat);
      if (bytes.length !== current.bytes || sha256(bytes) !== current.sha256) throw new OutputPublicationError("verification", "The original output changed.");
      const artifact = registerArtifact(db, filesDir, { botId: current.botId, threadId: current.threadId, relativePath: current.pathToken },
        { owner: true, scopes: [{ ...scope, runId: current.runId }] }, { producer: "shell-output", publicationId: current.id });
      if (artifact.sha256 !== current.sha256) throw new OutputPublicationError("verification", "The saved copy did not match the original output.");
      current = updateOutputReceipt(db, current.id, { stage: "registered", artifactId: artifact.id, errorCategory: null });
    }
    if (current.messageId) return;
    const { artifact } = readArtifact(db, filesDir, current.artifactId!, { owner: true, scopes: [scope] });
    const existing = deps.store.messagesFor(current.threadId).find(message => message.artifactIds?.includes(artifact.id));
    // the card names the turn recorded with the receipt; a receipt with none has its card withheld (the saved file stays in Files)
    if (!existing && !current.turnId) return;
    const message = existing ?? deps.store.appendMessage(current.threadId, murageLine({ role: "bot", kind: "text", text: outputCardText([artifact.name], 0), turnId: current.turnId, artifactIds: [artifact.id] }));
    updateOutputReceipt(db, current.id, { messageId: message.id, errorCategory: null });
  } catch (error) {
    if (error instanceof OutputPublicationError) throw error;
    throw new OutputPublicationError(outputErrorCategory(error, "database"), "This saved output could not be finished yet.");
  }
}

/** Only registered shell receipts prove the successful terminal gate was
 * crossed. Retained/failed receipts cannot establish that after a restart.
 * Read recorded identities only, and never register or dispatch anything. */
function receiptsHeld(db: DatabaseSync, run: { bot_id: string; thread_id: string; run_id: string }): boolean {
  return (db.prepare("SELECT id FROM output_publications WHERE producer='shell-output' AND bot_id=? AND thread_id=? AND run_id=?").all(run.bot_id, run.thread_id, run.run_id) as Array<{ id: string }>)
    .some(row => sqlRowRestoreHeld(db, "output_receipt", row.id));
}
/** Extra condition for "and this receipt is held", for use inside the query so held runs never fill a batch. Held runs are
 * excluded before any batching; recovery of a run is not limited to a first page that held or unavailable runs could fill. */
const heldReceiptTest = (db: DatabaseSync, idExpr: string): string =>
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='restore_holds'").get()
    ? ` AND EXISTS (SELECT 1 FROM restore_holds rh WHERE rh.kind='output_receipt' AND rh.row_id=${idExpr})` : " AND 0";
/** The runs still owing a card: read through the partial index of registered, unannounced receipts, so the work follows those runs and
 * never the history of published outputs (SQLite otherwise prefers the unique index on `producer`, which walks every shell output).
 * Falls back to the plain query only if the index is somehow absent. */
function runsOwingShellCards(db: DatabaseSync): Array<{ bot_id: string; thread_id: string; run_id: string }> {
  const query = (hint: string) => `SELECT bot_id,thread_id,run_id FROM output_publications${hint}
    WHERE producer='shell-output' AND stage='registered' AND message_id IS NULL AND artifact_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM output_publications q WHERE q.producer='shell-output' AND q.bot_id=output_publications.bot_id AND q.thread_id=output_publications.thread_id AND q.run_id=output_publications.run_id${heldReceiptTest(db, "q.id")})
    GROUP BY bot_id,thread_id,run_id ORDER BY MIN(created_at),run_id`;
  try { return db.prepare(query(" INDEXED BY output_publications_unannounced")).all() as unknown as Array<{ bot_id: string; thread_id: string; run_id: string }>; }
  catch (error) {
    if (!/no such index|no query solution/i.test(String((error as Error)?.message))) throw error;
    return db.prepare(query("")).all() as unknown as Array<{ bot_id: string; thread_id: string; run_id: string }>;
  }
}
function resumeRegisteredShellCards(deps: OutputPublicationDeps): void {
  const db = deps.database();
  const runs = runsOwingShellCards(db);
  // Built once per boot pass: the scope list does not change between runs and rebuilding it per run cost 1.6 s at startup.
  const scopes = runs.length ? deps.artifactScopes() : [];
  for (const run of runs) {
    try {
      if (receiptsHeld(db, run)) continue;
      const scope = scopes.find(item => item.botId === run.bot_id && item.threadId === run.thread_id && item.threadAvailable !== false && item.managedOutput !== true);
      const owner = deps.store.botByThread(run.thread_id)?.id === run.bot_id
        || Boolean(deps.store.groupByThread(run.thread_id)?.memberIds.includes(run.bot_id));
      if (!scope || !owner) continue;
      const receipts = outputReceiptsForRun(db, "shell-output", run.bot_id, run.thread_id, run.run_id).filter(item => item.stage === "registered" && !item.messageId && item.artifactId);
      if (!receipts.length || receipts.length > OUTPUT_PUBLICATION_LIMITS.maxFilesPerTurn) continue;
      const root = artifactWorkspaceIdentity(scope.workspaceRoot);
      const verified = receipts.map(receipt => {
        const { artifact } = readArtifact(db, join(deps.dataDir, "artifact-files"), receipt.artifactId!, { owner: true, scopes: [scope] });
        if (!receipt.pathToken.startsWith(`${OUTPUT_NAMESPACE}/`) || privateOutputPath(receipt.pathToken)
          || artifact.botId !== receipt.botId || artifact.threadId !== receipt.threadId || artifact.relativePath !== receipt.pathToken
          || artifact.sha256 !== receipt.sha256 || artifact.bytes !== receipt.bytes || artifact.sourceState !== "current") {
          throw new OutputPublicationError("verification", "The saved output identity changed.");
        }
        const source = verifiedArtifactSource(root, receipt.pathToken);
        const bytes = readStableFile(source.path, OUTPUT_PUBLICATION_LIMITS.maxFileBytes, source.stat);
        if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256) throw new OutputPublicationError("verification", "The original output changed.");
        return { receipt, artifact };
      });
      const messages = deps.store.artifactRows(run.thread_id);
      const missing = verified.filter(item => !messages.some(message => message.artifactIds?.includes(item.artifact.id)));
      const fresh = missing.filter((item, index) => missing.findIndex(other => other.artifact.id === item.artifact.id) === index);
      // the card names the turn recorded with its receipts (kept across a restart); with none recorded it is withheld, never shown unattributed
      const turnId = fresh.map(item => item.receipt.turnId).find(Boolean);
      if (fresh.length && !turnId) continue;
      const card = fresh.length ? deps.store.appendMessage(run.thread_id, murageLine({ role: "bot", kind: "text", text: outputCardText(fresh.map(item => item.artifact.name), 0), turnId, artifactIds: fresh.map(item => item.artifact.id) })) : undefined;
      for (const item of verified) {
        const message = messages.find(message => message.artifactIds?.includes(item.artifact.id)) ?? card;
        if (message) updateOutputReceipt(db, item.receipt.id, { messageId: message.id, errorCategory: null });
      }
    } catch { /* The existing receipt stays pending; no producer is replayed. */ }
  }
}

// ---------------------------------------------------------------------------
// R3-T4 / C2: generated image outputs

export type ImageOutputProducer = Extract<OutputProducer, "image-operation" | "assistant-image">;
export interface ImageOutputDeps { db: DatabaseSync; dataDir: string; store: Store }

const inside = (root: string, path: string) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };
const imageIdentityPattern = /^[\w-]{1,160}$/;

/** <partitionRoot>/generated-images/<thread>, without touching disk.
 * Files authorizes saved rows under it with a `managedOutput` scope. */
export function managedImageOutputPath(dataDir: string, botId: string, threadId: string): string {
  return join(managedOutputWorkspace(dataDir, botId, threadId), "generated-images", threadId);
}

/** Creates (when asked) and verifies the private per-conversation image root:
 * every component is a real directory inside DATA_DIR, never a link. */
export function managedImageOutputRoot(dataDir: string, botId: string, threadId: string, create: boolean): string {
  if (!imageIdentityPattern.test(botId) || !imageIdentityPattern.test(threadId)) throw Object.assign(new Error("Invalid image workspace."), { status: 403 });
  const root = realpathSync.native(dataDir);
  let directory = root;
  for (const part of relative(dataDir, managedImageOutputPath(dataDir, botId, threadId)).split(sep)) {
    directory = join(directory, part);
    if (create) { try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, realpathSync.native(directory))) throw Object.assign(new Error("Generated-image workspace is not a private directory."), { status: 403 });
  }
  return directory;
}

/** Provider renders (image-operation) may be large 4K images; an engine's
 * own assistant image keeps the upload cap. */
const imageOutputMaxBytes = (producer: string) => producer === "image-operation" ? GENERATED_IMAGE_MAX_BYTES : IMAGE_MAX_BYTES;

export interface RetainImageInput { producer: ImageOutputProducer; botId: string; threadId: string; runId: string; bytes: Buffer; mime: string; beforeCommit?: () => void }

/** Commits provider bytes to the managed root and persists their receipt
 * before any attachment, transcript or Files step can fail. */
export function retainImageOutput(deps: Pick<ImageOutputDeps, "db" | "dataDir">, input: RetainImageInput): LocalOutputReceipt {
  const extension = input.mime === "image/jpeg" ? "jpg" : input.mime.split("/")[1];
  if (!["png", "jpg", "gif", "webp"].includes(extension ?? "") || input.bytes.length === 0 || input.bytes.length > imageOutputMaxBytes(input.producer)) throw Object.assign(new Error("unsupported image output"), { status: 400 });
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
  /** The provider turn that produced the image (from the turn's capability or its receipt, never a request body); absent when no turn
   * produced it. With it the transcript row is that turn's engine output, so revoking the turn's inputs withholds it like its text reply. */
  turnId?: string;
  /** Asked again after the awaited attachment step, before anything is
   * attached or saved; throwing (a revoked caller) leaves the receipt as it was. */
  recheck?: () => void;
}

/** An image row in the conversation: the producing turn's engine output when one is named (withheld with the turn's inputs), else a
 * Murage line resting on no turn. */
export function imageOutputRow<T extends { role: "bot" }>(row: T, turnId: string | undefined): T & { turnId?: string; murageLine?: true } {
  return turnId ? { ...row, turnId } : murageLine(row);
}

function botName(store: Store, botId: string) {
  const bot = store.bot(botId);
  return bot ? bot.name : undefined;
}

/** Idempotent completion from retained bytes: attachment (same upload id),
 * optional transcript entry (found again after a crash), then Files. An
 * attachment or transcript failure throws after recording `failed`; a Files
 * failure is reported in the result so a received image is never hidden.
 * The attachment step awaits a byte-for-byte check of an existing entry
 * (saveReceiptImage); everything after it is synchronous, and the receipt and
 * its conversation are read again once that await returns. */
export async function completeImageOutput(deps: ImageOutputDeps, receiptId: string, options: CompleteImageOptions): Promise<ImageOutputCompletion> {
  const { receipt, root, bytes } = verifiedImageReceipt(deps, receiptId);
  let saved: SavedAttachment;
  try { saved = await saveReceiptImage(bytes, receipt.mime, receipt.id, imageOutputMaxBytes(receipt.producer)); }
  catch (error) { throw attachmentFailure(deps, receipt.id, error); }
  // Asked again after the await: the conversation may have gone, another
  // completion may have advanced the receipt, the caller may have been revoked.
  const current = outputReceipt(deps.db, receipt.id);
  if (!current) throw new OutputPublicationError("scope", "This image result is unavailable.", 404);
  if (!imageReceiptOwned(deps.store, current)) throw new OutputPublicationError("scope", "This image result belongs to a conversation that is no longer available.", 404);
  options.recheck?.();
  return finishImageCompletion(deps, current, root, saved, options);
}

/** completeImageOutput for a receipt retained earlier in the same synchronous
 * step (publishAssistantImage, inside the runtime event fold, which stages the
 * image for its turn before the turn's completion is folded). Its attachment
 * id is new, so there is nothing to compare: write only, no await. */
function completeNewImageOutput(deps: ImageOutputDeps, receiptId: string, options: CompleteImageOptions): ImageOutputCompletion {
  const { receipt, root, bytes } = verifiedImageReceipt(deps, receiptId);
  let saved: SavedAttachment;
  try { saved = writeNewReceiptImage(bytes, receipt.mime, receipt.id, imageOutputMaxBytes(receipt.producer)); }
  catch (error) { throw attachmentFailure(deps, receipt.id, error); }
  return finishImageCompletion(deps, receipt, root, saved, options);
}

const imageReceiptOwned = (store: Store, receipt: LocalOutputReceipt) =>
  store.botByThread(receipt.threadId)?.id === receipt.botId || Boolean(store.groupByThread(receipt.threadId)?.memberIds.includes(receipt.botId));

/** Scope, ownership and the retained bytes against the receipt's sha256. */
function verifiedImageReceipt(deps: ImageOutputDeps, receiptId: string): { receipt: LocalOutputReceipt; root: string; bytes: Buffer } {
  const { db, store } = deps;
  const receipt = outputReceipt(db, receiptId);
  if (!receipt || (receipt.producer !== "image-operation" && receipt.producer !== "assistant-image")) throw new OutputPublicationError("scope", "This image result is unavailable.", 404);
  if (!imageReceiptOwned(store, receipt)) throw new OutputPublicationError("scope", "This image result belongs to a conversation that is no longer available.", 404);
  try {
    const root = managedImageOutputRoot(deps.dataDir, receipt.botId, receipt.threadId, false);
    if (!/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(receipt.pathToken)) throw new OutputPublicationError("verification", "The retained image identity is invalid.");
    const bytes = readStableFile(join(root, receipt.pathToken), imageOutputMaxBytes(receipt.producer));
    if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256) throw new OutputPublicationError("verification", "The retained image changed.");
    return { receipt, root, bytes };
  } catch (error) {
    const category = outputErrorCategory(error, "verification");
    if (receipt.stage !== "registered") failReceipt(db, receipt.id, category);
    throw new OutputPublicationError(category, "The retained image could not be verified. It was not published.");
  }
}

/** The attachment step failed: record it (unless already registered) and
 * answer with the attachment error. */
function attachmentFailure(deps: ImageOutputDeps, receiptId: string, error: unknown): OutputPublicationError {
  const category = outputErrorCategory(error, "attachment");
  const current = outputReceipt(deps.db, receiptId);
  if (current && current.stage !== "registered") failReceipt(deps.db, receiptId, category);
  return new OutputPublicationError(category, "Image received and kept locally, but its conversation attachment could not finish.", 409);
}

/** Transcript entry and Files, synchronously after the attachment step. */
function finishImageCompletion(deps: ImageOutputDeps, start: LocalOutputReceipt, root: string, saved: SavedAttachment, options: CompleteImageOptions): ImageOutputCompletion {
  const { db, store } = deps;
  let receipt = start;
  const attachmentId = basename(saved.path);
  if (options.transcriptText !== undefined && !receipt.messageId) {
    try {
      const existing = store.rowAttaching(receipt.threadId, saved.path);
      const row = { role: "bot" as const, kind: "text" as const, text: options.transcriptText, attachments: [{ kind: "image" as const, path: saved.path, mime: saved.mime }] };
      const message = existing ?? store.appendMessage(receipt.threadId, imageOutputRow(row, options.turnId));
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
  return completeNewImageOutput(deps, receipt.id, { artifactName: "Generated image" }).saved;
}

/** Startup reconciliation for assistant images whose attachment or Files
 * step did not finish. Only known receipts are read; no directory scan. */
export async function resumePendingAssistantImages(deps: ImageOutputDeps, limit = 50, tried?: Set<string>): Promise<number> {
  // Held rows are excluded in SQL, before the LIMIT: a restore's held images must never fill the batch and starve a released one.
  // `tried` (a start's recovery in slices): rows an earlier slice looked at are passed over, so one that stays failed never fills the next slice.
  const rows = (deps.db.prepare(`SELECT * FROM output_publications WHERE producer='assistant-image' AND stage IN ('retained','failed')${notRestoreHeldSql(deps.db, "output_receipt", "output_publications.id")} ORDER BY updated_at,id LIMIT ?`).all(limit + (tried?.size ?? 0)) as unknown as ReceiptRow[])
    .filter(row => !tried?.has(row.id)).slice(0, limit);
  for (const row of rows) tried?.add(row.id);
  let completed = 0;
  for (const row of rows) {
    try {
      // belt: a restore keeps this image until the owner releases it
      if (sqlRowRestoreHeld(deps.db, "output_receipt", row.id)) continue;
      if (await finishImageReceipt(deps, row.id)) completed++;
    } catch { /* stays failed with its category for the next startup */ }
  }
  return completed;
}

/** Completes one retained image receipt and attaches it once. True when a Files artifact was saved by this call. Throws on failure. */
async function finishImageReceipt(deps: ImageOutputDeps, receiptId: string): Promise<boolean> {
  const receipt = outputReceipt(deps.db, receiptId);
  if (!receipt) throw new OutputPublicationError("scope", "This saved output is unavailable.", 404);
  const done = await completeImageOutput(deps, receipt.id, { artifactName: "Generated image" });
  // The in-memory turn attachment was lost with the process: attach once.
  // A receipt that already names its message is attached: on a thread not yet filled after an upgrade rowAttaching answers from an empty index, and a second message would be added.
  if (!receipt.messageId && !done.receipt.messageId && !deps.store.rowAttaching(receipt.threadId, done.saved.path)) {
    // An assistant image's run id is the provider turn that sent it (index.ts publishAssistantImage gets event.turnId): the row is that
    // turn's engine output, written from the receipt, never from a request.
    const row = { role: "bot" as const, kind: "text" as const, text: "", attachments: [{ kind: "image" as const, path: done.saved.path, mime: done.saved.mime }] };
    const message = deps.store.appendMessage(receipt.threadId, imageOutputRow(row, receipt.producer === "assistant-image" && receipt.runId ? receipt.runId : undefined));
    try { updateOutputReceipt(deps.db, receipt.id, { messageId: message.id }); } catch {}
  }
  // A Files copy that did not land is an incomplete publication: throw so a Release keeps its hold and answers 409.
  if (done.filesError || !(done.artifact ?? done.receipt.artifactId)) throw new OutputPublicationError(done.filesError ?? "database", "This saved output could not be finished yet.");
  return Boolean(done.artifact);
}
