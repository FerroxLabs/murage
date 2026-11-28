// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F5n (Q-K5, design docs/designs/1023-mcp-k5 r3 sections 2, 4, 5): the source cell, its epoch fence and the reads it allows.
// Owners: the cell/config contract is C-K5 (`engineSetup.sources`, section 5a); the reads, the per-open fence and the synchronous
// commit segment are R-K5. Consumers: pack slice R (its Review/Copy/Check/Update must call `reviewSources` / `commitFenced`), U-K5.
// A cell = (sourceKind, platform, instance, resolved root). It only decides whether a source may be read; the pack's import record
// stays the only item machine. OFF, UNQUALIFIED and refused cells make zero opens and zero stats of the app's files.
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ReadRefused, readScopedFile, realImportFs, type ImportFs } from "../claude-code-import.ts";
import { decodeSource, SOURCE_LABEL, sourceRevision, type DecodedSource, type SourceKind } from "./source-decode.ts";

export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

/** Build-time evidence (section 2, 4: UNQUALIFIED → OFF only by shipping code with the evidence). Each row is OPEN NO-OWNER. */
export const SOURCE_EVIDENCE = { x7GeminiSkills: false, x8CursorSkills: false, x9ClaudeDesktopWindows: false } as const;
export type SourceEvidence = { readonly [K in keyof typeof SOURCE_EVIDENCE]: boolean };

export type CellState = "qualified" | "unqualified" | "refused";
export interface SourceCell {
  cellId: string;
  sourceKind: SourceKind;
  platform: "darwin" | "win32" | "linux";
  instanceId: string;
  state: CellState;
  /** Skills from this source: always "unavailable" until X7 (Gemini) / X8 (Cursor) land; Claude Desktop has none on disk. */
  skills: "unavailable" | "none";
  /** Server-side only: never in a DTO. */
  readonly relParts: readonly string[];
}
export interface GeminiInstance { id: string; env?: Record<string, string | undefined> }
export interface CellListing { home: string; platform: NodeJS.Platform; geminiInstances?: readonly GeminiInstance[]; appData?: string; dataDir: string; evidence?: SourceEvidence }

const cellIdOf = (...parts: string[]) => `src_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const insideHome = (home: string, path: string) => {
  const rel = relative(home, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
};

/** Every cell this server lists (section 2 table). A root outside <home>, relative, or inside Murage's own data is refused, never replaced. */
export function listSourceCells(listing: CellListing): SourceCell[] {
  const evidence = listing.evidence ?? SOURCE_EVIDENCE;
  const platform = listing.platform === "darwin" || listing.platform === "win32" ? listing.platform : "linux";
  const home = resolve(listing.home);
  const cells: SourceCell[] = [];
  const cell = (sourceKind: SourceKind, instanceId: string, root: string, relParts: string[], state: CellState): void => {
    cells.push({ cellId: cellIdOf(sourceKind, platform, instanceId, root), sourceKind, platform, instanceId, state, skills: sourceKind === "claude-desktop" ? "none" : "unavailable", relParts });
  };
  if (platform === "darwin") cell("claude-desktop", "default", home, ["Library", "Application Support", "Claude", "claude_desktop_config.json"], "qualified");
  if (platform === "win32") {
    // X9 open: packaged-install path virtualization is unproven, so the row is unavailable; an %APPDATA% outside <home> never falls back.
    const appData = listing.appData;
    const ok = !!appData && isAbsolute(appData) && insideHome(home, resolve(appData)) && evidence.x9ClaudeDesktopWindows;
    const root = ok ? resolve(appData!) : home;
    cell("claude-desktop", "default", root, ok ? [...relative(home, root).split(sep), "Claude", "claude_desktop_config.json"] : [], ok ? "qualified" : "unqualified");
  }
  cell("cursor", "default", home, [".cursor", "mcp.json"], "qualified");
  const instances = listing.geminiInstances?.length ? listing.geminiInstances : [{ id: "default" }];
  for (const instance of instances) {
    // The instance's configured env, before driver scoping; never Murage's own process env (section 2, W8).
    const override = instance.env?.GEMINI_CLI_HOME;
    if (override === undefined || override === "") { cell("gemini", instance.id, home, [".gemini", "settings.json"], "qualified"); continue; }
    const root = isAbsolute(override) ? resolve(override) : "";
    const ok = !!root && insideHome(home, root) && !insideHome(resolve(listing.dataDir), root);
    const rel = ok ? relative(home, root) : "";
    cell("gemini", instance.id, root || override, ok ? [...(rel ? rel.split(sep) : []), ".gemini", "settings.json"] : [], ok ? "qualified" : "refused");
  }
  return cells;
}

/** The DTO for `GET /state` (section 5a): ids, kind, state and epoch only. Makes no file call. */
export function sourceCellsState(cells: readonly SourceCell[], store: SourceCellStore): Array<{ cellId: string; sourceKind: SourceKind; instanceId: string; state: CellState; skills: string; optIn: boolean; epoch: number }> {
  return cells.map((cell) => ({ cellId: cell.cellId, sourceKind: cell.sourceKind, instanceId: cell.instanceId, state: cell.state, skills: cell.skills, optIn: store.isOn(cell.cellId), epoch: store.epoch(cell.cellId) }));
}

// ------------------------------------------------------------------ the store (C-K5: engineSetup.sources)

export type SourcesMap = Record<string, { optIn: boolean; epoch: number }>;
/** The persisted map, read from the in-memory config (no I/O) and written through the config's one synchronous save. */
export interface SourcesPersistence { read(): SourcesMap; write(next: SourcesMap): void }

export class SourceCellStore {
  private readonly persistence: SourcesPersistence;
  constructor(persistence: SourcesPersistence) { this.persistence = persistence; }
  isOn(cellId: string): boolean { return this.persistence.read()[cellId]?.optIn === true; }
  epoch(cellId: string): number { return this.persistence.read()[cellId]?.epoch ?? 0; }

  /** THE source-state function (section 5a PUT): only a listed, qualified cell; every opt-in and opt-out increments the epoch. Synchronous, no lock. */
  setOptIn(cells: readonly SourceCell[], sourceKind: string, cellId: string, optIn: boolean): { status: 200; optIn: boolean; epoch: number } | { status: 400 | 409; error: string } {
    const cell = cells.find((candidate) => candidate.cellId === cellId);
    if (!cell || cell.sourceKind !== sourceKind) return { status: 400, error: "unknown-source" };
    if (cell.state !== "qualified") return { status: 409, error: "source-unavailable" };
    const current = this.persistence.read();
    const epoch = (current[cellId]?.epoch ?? 0) + 1;
    this.persistence.write({ ...current, [cellId]: { optIn, epoch } });
    return { status: 200, optIn, epoch };
  }

  /** Startup only (section 4 bounded map): drop OFF cells the server no longer lists. No review id can exist at startup. */
  pruneAtStartup(cells: readonly SourceCell[]): void {
    const current = this.persistence.read();
    const listed = new Set(cells.map((cell) => cell.cellId));
    const kept = Object.fromEntries(Object.entries(current).filter(([cellId, value]) => value.optIn || listed.has(cellId)));
    if (Object.keys(kept).length !== Object.keys(current).length) this.persistence.write(kept);
  }

  /** Whole-map compare (section 5 Binding): every bound cell ON at the same epoch. No I/O. */
  current(bound: Readonly<Record<string, number>>): boolean {
    const map = this.persistence.read();
    return Object.entries(bound).every(([cellId, epoch]) => map[cellId]?.optIn === true && map[cellId]!.epoch === epoch);
  }
}

/** `engineSetup.sources` from a stored config; anything malformed reads as absent (= OFF). */
export function sourcesFromConfig(config: unknown): SourcesMap {
  const sources = (config as { engineSetup?: { sources?: unknown } } | undefined)?.engineSetup?.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return {};
  const out: SourcesMap = {};
  for (const [cellId, value] of Object.entries(sources as Record<string, unknown>)) {
    const entry = value as { optIn?: unknown; epoch?: unknown } | null;
    if (/^src_[0-9a-f]{24}$/.test(cellId) && entry && typeof entry.optIn === "boolean" && Number.isSafeInteger(entry.epoch) && (entry.epoch as number) >= 0) out[cellId] = { optIn: entry.optIn, epoch: entry.epoch as number };
  }
  return out;
}

// ------------------------------------------------------------------ Review (section 5 per-open fence)

export type CellRead = { cellId: string; app: string; status: "read"; decoded: DecodedSource; revision: string } | { cellId: string; app: string; status: "nothingFound" | "couldNotRead" | "readingOff" };
interface ReviewSnapshot { bound: Record<string, number>; reads: CellRead[]; at: number }
const snapshots = new Map<string, ReviewSnapshot>();
const REVIEW_TTL_MS = 15 * 60_000;
const MAX_REVIEWS = 32;
export function resetSourceReviews(): void { snapshots.clear(); }
export function sourceReview(reviewId: string): ReviewSnapshot | undefined { return snapshots.get(reviewId); }

export interface SourceReadOptions { home: string; cells: readonly SourceCell[]; store: SourceCellStore; existingNames: readonly string[]; fs?: ImportFs; now?: () => number }
type Stale = { status: 409; error: "stale-review" };
const STALE: Stale = { status: 409, error: "stale-review" };

function readCells(options: SourceReadOptions, cellIds: readonly string[], bound: Record<string, number>): CellRead[] | Stale | { status: 400 | 409; error: string } {
  const reads: CellRead[] = [];
  for (const cellId of cellIds) {
    const cell = options.cells.find((candidate) => candidate.cellId === cellId);
    if (!cell) return { status: 400, error: "unknown-source" };
    if (cell.state !== "qualified") return { status: 409, error: "source-unavailable" };
  }
  for (const cellId of cellIds) {
    const cell = options.cells.find((candidate) => candidate.cellId === cellId)!;
    const app = SOURCE_LABEL[cell.sourceKind];
    if (!options.store.isOn(cellId)) { reads.push({ cellId, app, status: "readingOff" }); continue; }
    const parts = cell.relParts;
    const scope = { allowed: (candidate: readonly string[]) => candidate.length === parts.length && candidate.every((part, index) => part === parts[index]), isCurrent: () => options.store.current(bound) };
    let bytes: Buffer | "missing";
    try { bytes = readScopedFile(options.home, parts, scope, MAX_SOURCE_FILE_BYTES, options.fs ?? realImportFs, options.now ?? Date.now); } catch (error) {
      if (error instanceof ReadRefused && error.kind === "stale") return STALE;
      reads.push({ cellId, app, status: "couldNotRead" });
      continue;
    }
    if (bytes === "missing") { reads.push({ cellId, app, status: "nothingFound" }); continue; }
    const decoded = decodeSource(cell.sourceKind, bytes, options.existingNames);
    if ("error" in decoded) { reads.push({ cellId, app, status: "couldNotRead" }); continue; }
    reads.push({ cellId, app, status: "read", decoded, revision: sourceRevision(decoded) });
  }
  return reads;
}

/** Review: bind {cellId → epoch} for every requested cell (an OFF cell refuses before any open), read each through the fenced reader,
 *  re-check the whole map, and only then publish the snapshot. */
export function reviewSources(options: SourceReadOptions, cellIds: readonly string[]): { status: 200; reviewId: string; reads: CellRead[] } | { status: 400 | 409; error: string } {
  const bound: Record<string, number> = {};
  for (const cellId of cellIds) {
    if (!options.cells.some((cell) => cell.cellId === cellId)) return { status: 400, error: "unknown-source" };
    if (!options.store.isOn(cellId)) return { status: 409, error: "reading-off" };
    bound[cellId] = options.store.epoch(cellId);
  }
  const reads = readCells(options, cellIds, bound);
  if (!Array.isArray(reads)) return reads;
  if (!options.store.current(bound)) return STALE;
  const reviewId = randomUUID();
  while (snapshots.size >= MAX_REVIEWS) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(reviewId, { bound, reads, at: (options.now ?? Date.now)() });
  return { status: 200, reviewId, reads };
}

/** Check (section 5, F2-L1): no reviewId; the current state of each requested cell, OFF refused before any open ("Reading {app} is off"). */
export function checkSources(options: SourceReadOptions, cellIds: readonly string[]): { status: 200; reads: CellRead[] } | { status: 400 | 409; error: string } {
  const bound: Record<string, number> = {};
  for (const cellId of cellIds) if (options.store.isOn(cellId)) bound[cellId] = options.store.epoch(cellId);
  const reads = readCells(options, cellIds, bound);
  return Array.isArray(reads) ? { status: 200, reads } : reads;
}

// ------------------------------------------------------------------ Copy (section 5 Serialization)

export interface CommitDeps {
  /** The last pre-commit await (named seam for W10). Default: resolves at once. */
  beforeCommit?(): Promise<void>;
  /** The whole commit, synchronous: skill writes, persistMcp, import record/receipt. Called at most once, only after the compare.
   *  Returning a promise is refused (review #5): an async commit would leave the segment and let an opt-out land between its writes. */
  commit(reads: readonly CellRead[]): void;
  now?(): number;
}

/** Copy/Update's commit segment: every await sits before it; the bound-map compare and the commit run in ONE synchronous segment, so an
 *  opt-out lands either before the compare (409, zero writes) or after the commit (the commit had a valid read). Pack R's seat must
 *  route its Copy/Update through this (Fable r3 M2: pack R's side of the contract, OPEN NO-OWNER). */
export async function commitFenced(store: SourceCellStore, reviewId: string, deps: CommitDeps): Promise<{ status: 200 } | Stale> {
  const snapshot = snapshots.get(reviewId);
  if (snapshot && (deps.now ?? Date.now)() - snapshot.at > REVIEW_TTL_MS) snapshots.delete(reviewId);
  if (!snapshots.has(reviewId) || !store.current(snapshot!.bound)) return STALE;
  await (deps.beforeCommit ? deps.beforeCommit() : Promise.resolve());
  // ---- synchronous segment: no await below this line ----
  const now = snapshots.get(reviewId);
  if (!now || !store.current(now.bound)) return STALE;
  snapshots.delete(reviewId);
  const result: unknown = deps.commit(now.reads);
  if (result !== undefined) throw new Error("commitFenced: the commit must be synchronous");
  return { status: 200 };
}

/** The config-backed persistence: reads the server's in-memory config (no I/O) and writes the whole map through the one synchronous
 *  config save, then mirrors it into the in-memory config so the next compare sees it at once. */
export function configSourcesPersistence(config: () => { engineSetup?: { sources?: SourcesMap } }, save: (patch: { engineSetup: { sources: SourcesMap } }) => void): SourcesPersistence {
  return {
    read: () => sourcesFromConfig(config()),
    write: (next) => {
      save({ engineSetup: { sources: next } });
      const cfg = config();
      cfg.engineSetup = { ...(cfg.engineSetup ?? {}), sources: next };
    },
  };
}
