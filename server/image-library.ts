// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Saved prompt blocks and reference packs for image generation, the prompt
// each approved render was sent, and each model's last check (A.2, A.6, A.8).
//
// Scope: a bot saves into its own scope, the owner into the workspace. A bot
// reads and uses its own and the workspace's, never another bot's; its own
// comes first. Every save is a new version; saving what the latest version
// already holds returns that version. Deleting is soft: render records keep
// the version they used, and numbering carries on after a delete.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { initializeImageLibrary } from "./image-operations-schema.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import { IMAGE_GENERATION_REFERENCE_MAX } from "../shared/media-assets.ts";
import { GENERATED_IMAGE_MAX_BYTES } from "./attachments.ts";
import { IMAGE_PROMPT_HARD_MAX } from "../shared/image-capabilities.ts";
import type { ImageReference } from "./image-generation.ts";
import { murageTool } from "./tool-call-context.ts";

export type ImageLibraryScope = "workspace" | "bot";
/** Who is asking: a bot (its own scope plus the workspace) or the owner (everything). */
export type ImageLibraryActor = { kind: "bot"; botId: string } | { kind: "owner" };
export const IMAGE_LIBRARY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Most saved blocks one generate_image call may name. */
export const IMAGE_PROMPT_BLOCKS_MAX = 8;
/** What one scope (a bot, or the workspace) keeps live: names, and versions of one name. */
export const IMAGE_LIBRARY_NAMES_MAX = 100;
export const IMAGE_LIBRARY_VERSIONS_MAX = 50;
/** Refuses a save that would pass what one scope keeps. `table` is one of the two library tables. */
function checkRoom(db: DatabaseSync, table: "image_prompt_blocks" | "image_reference_packs", scope: ImageLibraryScope, botId: string, name: string, what: string): void {
  const versions = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL`).get(scope, botId, name) as { n: number }).n;
  if (versions >= IMAGE_LIBRARY_VERSIONS_MAX) refuse(409, `${name} already has ${IMAGE_LIBRARY_VERSIONS_MAX} versions, the most one ${what} keeps. Save it under a new name, or ask the owner to delete old versions in Settings.`);
  if (versions === 0) {
    const names = (db.prepare(`SELECT COUNT(DISTINCT name) AS n FROM ${table} WHERE scope=? AND bot_id=? AND deleted_at IS NULL`).get(scope, botId) as { n: number }).n;
    if (names >= IMAGE_LIBRARY_NAMES_MAX) refuse(409, `There are already ${IMAGE_LIBRARY_NAMES_MAX} saved ${what}s here, the most kept. Reuse a name, or ask the owner to delete some in Settings.`);
  }
}
/** Content-addressed reference-pack images: DATA_DIR/image-reference-packs/<sha256>.<ext>. */
export const IMAGE_REFERENCE_PACK_DIR = "image-reference-packs";
const PREVIEW_CHARS = 160;
const DAY_MS = 24 * 60 * 60_000;
/** Scheduled model checks: at most one per model per day and three a day in all. */
export const IMAGE_PROBE_DAILY_TOTAL = 3;

export class ImageLibraryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const refuse = (status: number, message: string): never => { throw new ImageLibraryError(status, message); };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ready = new WeakSet<DatabaseSync>();
function prepared(db: DatabaseSync): DatabaseSync {
  if (!ready.has(db)) { initializeImageLibrary(db); ready.add(db); }
  return db;
}

/** "name" or "name@3". */
export function parseLibraryRef(value: string, kind: "block" | "pack"): { name: string; version?: number } {
  const match = /^([a-z0-9][a-z0-9-]{0,63})(?:@([1-9][0-9]{0,8}))?$/.exec(value.trim());
  if (!match) refuse(400, `"${value.slice(0, 80)}" is not a saved ${kind === "block" ? "prompt block" : "reference pack"} name. Use lowercase letters, digits and hyphens, optionally with @version, for example brand-lock or brand-lock@3.`);
  return { name: match![1]!, ...(match![2] ? { version: Number(match![2]) } : {}) };
}
function checkName(name: unknown): string {
  if (typeof name !== "string" || !IMAGE_LIBRARY_NAME.test(name)) refuse(400, "A name is 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit.");
  return name as string;
}

// ── Prompt blocks ────────────────────────────────────────────────────────

interface BlockRow { id: string; scope: ImageLibraryScope; bot_id: string; name: string; version: number; text: string; chars: number; sha256: string; created_by: string; created_at: number; deleted_at: number | null }
export interface PromptBlockSummary { id: string; name: string; version: number; chars: number; scope: ImageLibraryScope; botId?: string; createdBy: string; createdAt: number }
export interface PromptBlock extends PromptBlockSummary { text: string; sha256: string }
const blockSummary = (row: BlockRow): PromptBlockSummary => ({ id: row.id, name: row.name, version: row.version, chars: row.chars, scope: row.scope, ...(row.bot_id ? { botId: row.bot_id } : {}), createdBy: row.created_by, createdAt: row.created_at });
const blockOf = (row: BlockRow): PromptBlock => ({ ...blockSummary(row), text: row.text, sha256: row.sha256 });

/** Saves a new version, or returns the latest when it already holds this text. */
export function savePromptBlock(db: DatabaseSync, input: { scope: ImageLibraryScope; botId?: string; name: string; text: string; createdBy: string; now?: number }): PromptBlock & { created: boolean } {
  const name = checkName(input.name);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > IMAGE_PROMPT_HARD_MAX) refuse(400, `A prompt block holds 1 to ${IMAGE_PROMPT_HARD_MAX.toLocaleString("en-US")} characters.`);
  const botId = input.scope === "bot" ? input.botId ?? "" : "";
  if (input.scope === "bot" && !botId) refuse(400, "A bot's block needs its bot.");
  const database = prepared(db);
  const latest = database.prepare("SELECT * FROM image_prompt_blocks WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1").get(input.scope, botId, name) as BlockRow | undefined;
  const digest = sha256(text);
  if (latest && latest.sha256 === digest && latest.text === text) return { ...blockOf(latest), created: false };
  checkRoom(database, "image_prompt_blocks", input.scope, botId, name, "prompt block");
  const top = database.prepare("SELECT MAX(version) AS version FROM image_prompt_blocks WHERE scope=? AND bot_id=? AND name=?").get(input.scope, botId, name) as { version: number | null };
  const row: BlockRow = { id: randomUUID(), scope: input.scope, bot_id: botId, name, version: (top.version ?? 0) + 1, text, chars: text.length, sha256: digest, created_by: input.createdBy.slice(0, 80), created_at: input.now ?? Date.now(), deleted_at: null };
  database.prepare("INSERT INTO image_prompt_blocks VALUES(?,?,?,?,?,?,?,?,?,?,NULL)").run(row.id, row.scope, row.bot_id, row.name, row.version, row.text, row.chars, row.sha256, row.created_by, row.created_at);
  return { ...blockOf(row), created: true };
}

/** The live rows the actor may read for one name: a bot's own first, then the workspace's. */
function visibleBlockRows(db: DatabaseSync, actor: ImageLibraryActor, name: string): BlockRow[] {
  const database = prepared(db);
  const rows = (scope: ImageLibraryScope, botId: string) => database.prepare("SELECT * FROM image_prompt_blocks WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL ORDER BY version DESC").all(scope, botId, name) as unknown as BlockRow[];
  if (actor.kind === "bot") { const own = rows("bot", actor.botId); if (own.length) return own; }
  return rows("workspace", "");
}

/** One block by "name" or "name@3", in lookup order. */
export function getPromptBlock(db: DatabaseSync, actor: ImageLibraryActor, ref: string): PromptBlock {
  const { name, version } = parseLibraryRef(ref, "block");
  const rows = visibleBlockRows(db, actor, name);
  if (!rows.length) refuse(404, `No saved prompt block is named ${name}. ${murageTool("list_prompt_blocks")} shows the ones you can use.`);
  const row = version === undefined ? rows[0] : rows.find(item => item.version === version);
  if (!row) refuse(404, `${name} has no version ${version}. Its latest is v${rows[0]!.version}.`);
  return blockOf(row!);
}

/** The blocks one generate_image call names, in the order given. */
export function resolvePromptBlocks(db: DatabaseSync, actor: ImageLibraryActor, refs: readonly string[]): PromptBlock[] {
  if (refs.length > IMAGE_PROMPT_BLOCKS_MAX) refuse(400, `${refs.length} prompt blocks; one image request takes at most ${IMAGE_PROMPT_BLOCKS_MAX}. Nothing was sent.`);
  return refs.map(ref => getPromptBlock(db, actor, ref));
}

/** A bot's list: the latest version of each of its own blocks and each workspace block, with the start of the text. */
export function listPromptBlocksForBot(db: DatabaseSync, botId: string): Array<PromptBlockSummary & { preview: string }> {
  const rows = prepared(db).prepare(`SELECT b.* FROM image_prompt_blocks b WHERE b.deleted_at IS NULL AND ((b.scope='bot' AND b.bot_id=?) OR b.scope='workspace')
    AND b.version=(SELECT MAX(version) FROM image_prompt_blocks c WHERE c.scope=b.scope AND c.bot_id=b.bot_id AND c.name=b.name AND c.deleted_at IS NULL) ORDER BY b.scope, b.name`).all(botId) as unknown as BlockRow[];
  return rows.map(row => ({ ...blockSummary(row), preview: row.text.slice(0, PREVIEW_CHARS) }));
}

/** The owner's list: the latest version of every live block, every scope. */
export function listPromptBlocksForOwner(db: DatabaseSync): PromptBlockSummary[] {
  const rows = prepared(db).prepare(`SELECT b.* FROM image_prompt_blocks b WHERE b.deleted_at IS NULL
    AND b.version=(SELECT MAX(version) FROM image_prompt_blocks c WHERE c.scope=b.scope AND c.bot_id=b.bot_id AND c.name=b.name AND c.deleted_at IS NULL) ORDER BY b.scope DESC, b.bot_id, b.name`).all() as unknown as BlockRow[];
  return rows.map(blockSummary);
}

/** One version by its id, for the owner. */
export function promptBlockById(db: DatabaseSync, id: string): PromptBlock {
  const row = prepared(db).prepare("SELECT * FROM image_prompt_blocks WHERE id=? AND deleted_at IS NULL").get(id) as BlockRow | undefined;
  if (!row) refuse(404, "That prompt block is not saved any more.");
  return blockOf(row!);
}

/** Soft-deletes every version of the block this id belongs to. */
export function deletePromptBlock(db: DatabaseSync, id: string, now = Date.now()): { name: string; versions: number } {
  const row = prepared(db).prepare("SELECT scope,bot_id,name FROM image_prompt_blocks WHERE id=?").get(id) as Pick<BlockRow, "scope" | "bot_id" | "name"> | undefined;
  if (!row) refuse(404, "That prompt block is not saved any more.");
  const result = db.prepare("UPDATE image_prompt_blocks SET deleted_at=? WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL").run(now, row!.scope, row!.bot_id, row!.name);
  return { name: row!.name, versions: Number(result.changes ?? 0) };
}

// ── Render records ───────────────────────────────────────────────────────

export interface RenderPromptBlock { name: string; version: number; scope: string; chars: number }
/** The full prompt an approved render is sent and the block versions it
 * pinned. Written before dispatch; the first record for an operation stays. */
export function recordRenderPrompt(db: DatabaseSync, input: { operationId: string; prompt: string; blocks: readonly RenderPromptBlock[]; now?: number }): void {
  prepared(db).prepare("INSERT OR IGNORE INTO image_render_prompts VALUES(?,?,?,?,?,?)").run(input.operationId, input.prompt, JSON.stringify(input.blocks), input.prompt.length, sha256(input.prompt), input.now ?? Date.now());
}
export function renderPrompt(db: DatabaseSync, operationId: string): { prompt: string; blocks: RenderPromptBlock[]; promptChars: number; sha256: string } | undefined {
  const row = prepared(db).prepare("SELECT * FROM image_render_prompts WHERE operation_id=?").get(operationId) as { prompt: string; blocks: string; prompt_chars: number; sha256: string } | undefined;
  return row ? { prompt: row.prompt, blocks: JSON.parse(row.blocks) as RenderPromptBlock[], promptChars: row.prompt_chars, sha256: row.sha256 } : undefined;
}

// ── Reference packs ──────────────────────────────────────────────────────

interface PackImage { sha256: string; mime: ImageReference["mime"]; bytes: number }
interface PackRow { id: string; scope: ImageLibraryScope; bot_id: string; name: string; version: number; images: string; count: number; created_by: string; created_at: number; deleted_at: number | null }
export interface ReferencePackSummary { id: string; name: string; version: number; count: number; scope: ImageLibraryScope; botId?: string; createdBy: string; createdAt: number }
const packSummary = (row: PackRow): ReferencePackSummary => ({ id: row.id, name: row.name, version: row.version, count: row.count, scope: row.scope, ...(row.bot_id ? { botId: row.bot_id } : {}), createdBy: row.created_by, createdAt: row.created_at });
const EXTENSIONS: Record<ImageReference["mime"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const packFile = (dataDir: string, image: Pick<PackImage, "sha256" | "mime">) => join(dataDir, IMAGE_REFERENCE_PACK_DIR, `${image.sha256}.${EXTENSIONS[image.mime]}`);
function inside(root: string, file: string) { const tail = relative(root, file); return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); }

/** Writes one image under its own sha256, once. An existing file is kept only
 * when its bytes still hash to its name. */
function storePackImage(dataDir: string, reference: ImageReference): PackImage {
  const image: PackImage = { sha256: sha256(reference.bytes), mime: reference.mime, bytes: reference.bytes.length };
  const folder = join(dataDir, IMAGE_REFERENCE_PACK_DIR), file = packFile(dataDir, image);
  mkdirSync(folder, { recursive: true });
  try { const stat = lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && stat.size === image.bytes && sha256(readFileSync(file)) === image.sha256) return image; } catch { /* not stored yet */ }
  const temp = join(folder, `.${image.sha256}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, reference.bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); } catch (error) { rmSync(temp, { force: true }); throw error; }
  return image;
}

/** Saves the images, in order, as a new version of a pack (1 to 16 images). */
export function saveReferencePack(db: DatabaseSync, dataDir: string, input: { scope: ImageLibraryScope; botId?: string; name: string; references: readonly ImageReference[]; createdBy: string; now?: number }): ReferencePackSummary & { created: boolean } {
  const name = checkName(input.name);
  if (!input.references.length || input.references.length > IMAGE_GENERATION_REFERENCE_MAX) refuse(400, `A reference pack holds 1 to ${IMAGE_GENERATION_REFERENCE_MAX} images.`);
  const botId = input.scope === "bot" ? input.botId ?? "" : "";
  if (input.scope === "bot" && !botId) refuse(400, "A bot's pack needs its bot.");
  // The same cap every generated image is kept to, so a saved pack can always be used.
  if (input.references.some(reference => reference.bytes.length > GENERATED_IMAGE_MAX_BYTES)) refuse(400, `Each image in a reference pack must be at most ${GENERATED_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`);
  const images = input.references.map(reference => storePackImage(dataDir, reference));
  const database = prepared(db);
  const latest = database.prepare("SELECT * FROM image_reference_packs WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1").get(input.scope, botId, name) as PackRow | undefined;
  const encoded = JSON.stringify(images);
  if (latest && latest.images === encoded) return { ...packSummary(latest), created: false };
  checkRoom(database, "image_reference_packs", input.scope, botId, name, "reference pack");
  const top = database.prepare("SELECT MAX(version) AS version FROM image_reference_packs WHERE scope=? AND bot_id=? AND name=?").get(input.scope, botId, name) as { version: number | null };
  const row: PackRow = { id: randomUUID(), scope: input.scope, bot_id: botId, name, version: (top.version ?? 0) + 1, images: encoded, count: images.length, created_by: input.createdBy.slice(0, 80), created_at: input.now ?? Date.now(), deleted_at: null };
  database.prepare("INSERT INTO image_reference_packs VALUES(?,?,?,?,?,?,?,?,?,NULL)").run(row.id, row.scope, row.bot_id, row.name, row.version, row.images, row.count, row.created_by, row.created_at);
  return { ...packSummary(row), created: true };
}

/** A bot's list: the latest version of its own packs and the workspace's. */
export function listReferencePacksForBot(db: DatabaseSync, botId: string): ReferencePackSummary[] {
  return (prepared(db).prepare(`SELECT p.* FROM image_reference_packs p WHERE p.deleted_at IS NULL AND ((p.scope='bot' AND p.bot_id=?) OR p.scope='workspace')
    AND p.version=(SELECT MAX(version) FROM image_reference_packs q WHERE q.scope=p.scope AND q.bot_id=p.bot_id AND q.name=p.name AND q.deleted_at IS NULL) ORDER BY p.scope, p.name`).all(botId) as unknown as PackRow[]).map(packSummary);
}
export function listReferencePacksForOwner(db: DatabaseSync): ReferencePackSummary[] {
  return (prepared(db).prepare(`SELECT p.* FROM image_reference_packs p WHERE p.deleted_at IS NULL
    AND p.version=(SELECT MAX(version) FROM image_reference_packs q WHERE q.scope=p.scope AND q.bot_id=p.bot_id AND q.name=p.name AND q.deleted_at IS NULL) ORDER BY p.scope DESC, p.bot_id, p.name`).all() as unknown as PackRow[]).map(packSummary);
}
export function deleteReferencePack(db: DatabaseSync, id: string, now = Date.now()): { name: string; versions: number } {
  const row = prepared(db).prepare("SELECT scope,bot_id,name FROM image_reference_packs WHERE id=?").get(id) as Pick<PackRow, "scope" | "bot_id" | "name"> | undefined;
  if (!row) refuse(404, "That reference pack is not saved any more.");
  const result = db.prepare("UPDATE image_reference_packs SET deleted_at=? WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL").run(now, row!.scope, row!.bot_id, row!.name);
  return { name: row!.name, versions: Number(result.changes ?? 0) };
}

/** The pack "name" or "name@2" in lookup order, every image re-read and
 * checked against the sha256, type and size it was saved with. One changed
 * or missing image refuses the whole pack. */
export function resolveReferencePack(db: DatabaseSync, dataDir: string, actor: ImageLibraryActor, ref: string): { name: string; version: number; scope: ImageLibraryScope; references: ImageReference[] } {
  const { name, version } = parseLibraryRef(ref, "pack");
  const database = prepared(db);
  const rows = (scope: ImageLibraryScope, botId: string) => database.prepare("SELECT * FROM image_reference_packs WHERE scope=? AND bot_id=? AND name=? AND deleted_at IS NULL ORDER BY version DESC").all(scope, botId, name) as unknown as PackRow[];
  let found = actor.kind === "bot" ? rows("bot", actor.botId) : [];
  if (!found.length) found = rows("workspace", "");
  if (!found.length) refuse(404, `No saved reference pack is named ${name}. ${murageTool("list_reference_packs")} shows the ones you can use. Nothing was sent.`);
  const row = version === undefined ? found[0] : found.find(item => item.version === version);
  if (!row) refuse(404, `Reference pack ${name} has no version ${version}. Its latest is v${found[0]!.version}. Nothing was sent.`);
  let images: PackImage[] = [];
  try { images = JSON.parse(row!.images) as PackImage[]; } catch { images = []; }
  const changed = (index: number): never => refuse(409, `Reference pack ${name} v${row!.version}: image ${index + 1} of ${row!.count} is missing or changed on this computer. Nothing was sent. Save the pack again from images in the conversation.`);
  if (!Array.isArray(images) || images.length !== row!.count) changed(0);
  const root = join(dataDir, IMAGE_REFERENCE_PACK_DIR);
  let realRoot = "";
  try { realRoot = realpathSync(root); } catch { changed(0); }
  const references = images.map((image, index) => {
    if (!image || typeof image.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(image.sha256) || !Object.hasOwn(EXTENSIONS, image.mime)) return changed(index);
    const file = packFile(dataDir, image);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== image.bytes || stat.size > GENERATED_IMAGE_MAX_BYTES || !inside(realRoot, realpathSync(file))) return changed(index);
      const bytes = readFileSync(file);
      if (sha256(bytes) !== image.sha256 || decodeGeneratedImage(bytes.toString("base64"), GENERATED_IMAGE_MAX_BYTES).mime !== image.mime) return changed(index);
      return { bytes, mime: image.mime };
    } catch (error) { if (error instanceof ImageLibraryError) throw error; return changed(index); }
  });
  return { name, version: row!.version, scope: row!.scope, references };
}

// ── Model checks (A.8) ───────────────────────────────────────────────────

export interface ImageProbeRow { connectionId: string; model: string; lastProbeAt: number; ok: boolean; lastGoodAt?: number; lastFailedAt?: number; errorCode?: string; errorMessage?: string; durationMs?: number; costUsd?: number }
interface ProbeDbRow { connection_id: string; model: string; last_probe_at: number; ok: number; last_good_at: number | null; last_failed_at: number | null; error_code: string | null; error_message: string | null; duration_ms: number | null; cost_usd: number | null }
const probeOf = (row: ProbeDbRow): ImageProbeRow => ({ connectionId: row.connection_id, model: row.model, lastProbeAt: row.last_probe_at, ok: row.ok === 1,
  ...(row.last_good_at !== null ? { lastGoodAt: row.last_good_at } : {}), ...(row.last_failed_at !== null ? { lastFailedAt: row.last_failed_at } : {}),
  ...(row.error_code !== null ? { errorCode: row.error_code } : {}), ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}), ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}) });

/** One check's result. A success keeps the last failure's time; a failure keeps the last success's. */
export function recordImageProbe(db: DatabaseSync, input: { connectionId: string; model: string; ok: boolean; at: number; durationMs?: number; errorCode?: string; errorMessage?: string; costUsd?: number }): ImageProbeRow {
  const database = prepared(db);
  database.prepare(`INSERT INTO image_model_probes VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id, model) DO UPDATE SET last_probe_at=excluded.last_probe_at, ok=excluded.ok,
    last_good_at=COALESCE(excluded.last_good_at, image_model_probes.last_good_at), last_failed_at=COALESCE(excluded.last_failed_at, image_model_probes.last_failed_at),
    error_code=excluded.error_code, error_message=excluded.error_message, duration_ms=excluded.duration_ms, cost_usd=excluded.cost_usd`).run(
    input.connectionId, input.model, input.at, input.ok ? 1 : 0, input.ok ? input.at : null, input.ok ? null : input.at,
    input.ok ? null : (input.errorCode ?? "failed").slice(0, 80), input.ok ? null : (input.errorMessage ?? "").slice(0, 400), input.durationMs ?? null,
    typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0 ? input.costUsd : null);
  return imageProbes(db, input.connectionId).get(input.model)!;
}
export function imageProbes(db: DatabaseSync, connectionId: string): Map<string, ImageProbeRow> {
  const rows = prepared(db).prepare("SELECT * FROM image_model_probes WHERE connection_id=?").all(connectionId) as unknown as ProbeDbRow[];
  return new Map(rows.map(row => [row.model, probeOf(row)]));
}
/** Whether the scheduled check may run for this model now: not checked in
 * the last day, and fewer than three checks of any model in the last day. */
export function scheduledProbeDue(db: DatabaseSync, connectionId: string, model: string, now = Date.now()): boolean {
  const database = prepared(db);
  const recent = database.prepare("SELECT COUNT(*) AS n FROM image_model_probes WHERE last_probe_at>?").get(now - DAY_MS) as { n: number };
  if (recent.n >= IMAGE_PROBE_DAILY_TOTAL) return false;
  const last = database.prepare("SELECT last_probe_at FROM image_model_probes WHERE connection_id=? AND model=?").get(connectionId, model) as { last_probe_at: number } | undefined;
  return !last || now - last.last_probe_at >= DAY_MS;
}

export type ImageAvailability = "verified" | "failed" | "catalog-listed" | "unverified";
export interface AvailabilityFields { availability: ImageAvailability | string; lastGoodAt?: number; lastFailedAt?: number; lastError?: string; offeredToKey?: boolean }
/** Availability from the model's own last check first, then whether the
 * provider lists it for this key. A failed model is marked, never removed. */
export function applyImageAvailability<T extends AvailabilityFields & { id: string }>(models: readonly T[], probes: ReadonlyMap<string, ImageProbeRow>): T[] {
  return models.map(model => {
    const probe = probes.get(model.id);
    if (!probe) return model;
    const facts = { ...(probe.lastGoodAt !== undefined ? { lastGoodAt: probe.lastGoodAt } : {}), ...(probe.lastFailedAt !== undefined ? { lastFailedAt: probe.lastFailedAt } : {}) };
    return probe.ok ? { ...model, ...facts, availability: "verified" } : { ...model, ...facts, availability: "failed", lastError: [probe.errorCode, probe.errorMessage].filter(Boolean).join(": ").slice(0, 400) };
  });
}
