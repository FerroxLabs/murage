import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactKind, ArtifactPage, ArtifactPreview, ArtifactQuery, ArtifactRegistration } from "../shared/artifacts.ts";
import { redactSecretsInText } from "./redact.ts";

export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const ARTIFACT_STORAGE_MAX_BYTES = 512 * 1024 * 1024;
export const ARTIFACT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export interface ArtifactScope { botId: string; botName: string; workspaceRoot: string; threadId?: string; runId?: string; threadAvailable?: boolean }
export interface ArtifactAccess { owner: boolean; scopes: readonly ArtifactScope[] }
export class ArtifactError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new ArtifactError(status, message); }
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fingerprint = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const clean = (value: string, max: number) => redactSecretsInText(value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
function directory(path: string) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(409, "The file location is unsafe or changed."); return stat; }
function rootPath(path: string) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(403, "An authorized workspace is required.");
  directory(path); const root = realpathSync.native(path);
  if (root === parse(root).root || root === realpathSync.native(homedir())) fail(403, "A dedicated workspace is required.");
  return root;
}
// Canonical aliases (notably Darwin /var) must keep matching after the
// original workspace is deleted. Resolve existing ancestors only, no scan.
export function artifactWorkspaceIdentity(path: string): string {
  let current = resolve(path); const suffix: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try { return join(realpathSync.native(current), ...suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) break;
    suffix.unshift(basename(current)); current = parent;
  }
  fail(403, "An authorized workspace is required.");
}
function relativePath(path: string) {
  if (typeof path !== "string" || path.length > 2048 || /[\\\u0000-\u001f:]/.test(path) || isAbsolute(path)) fail(400, "Use a relative file path inside this task's workspace.");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") || part.length > 255)) fail(400, "Use a relative file path inside this task's workspace.");
  if (parts.some(part => /^(memory|skills|credentials)$/i.test(part)) || /^(MEMORY|SOUL|AGENTS|CLAUDE)\.md$/i.test(parts.at(-1)!)) fail(403, "Private setup and memory files are not deliverables.");
  return parts;
}
function sourceFile(root: string, relative: string) {
  const observed: Array<[string, Stats]> = [[root, directory(root)]];
  let path = root; const parts = relativePath(relative);
  for (const [index, part] of parts.entries()) {
    path = join(path, part); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(409, "Linked files are not supported.");
    if (index < parts.length - 1) { if (!stat.isDirectory()) fail(409, "The file location is unsafe or changed."); }
    else if (!stat.isFile() || stat.nlink !== 1) fail(409, "Only ordinary files are supported.");
    observed.push([path, stat]);
  }
  return { path, stat: observed.at(-1)![1], observed };
}
function readVerified(path: string, limit: number, expected?: Stats) {
  const before = expected ?? lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(409, "Only ordinary files are supported.");
  if (before.size > limit) fail(413, "This file exceeds the supported size limit.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(before, fstatSync(fd))) fail(409, "The file changed during verification.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) fail(409, "The file changed during verification."); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !same(before, fstatSync(fd)) || !same(before, lstatSync(path))) fail(409, "The file changed during verification.");
    return bytes;
  } finally { closeSync(fd); }
}
function format(path: string): { kind: ArtifactKind; mime: string; extension: string } {
  const extension = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return { kind: "html", mime: "text/html", extension };
  const images: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  if (images[extension]) return { kind: "image", mime: images[extension], extension };
  if ([".txt", ".md", ".csv", ".tsv", ".json", ".log"].includes(extension)) return { kind: "text", mime: "text/plain", extension };
  return { kind: "other", mime: "application/octet-stream", extension: /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin" };
}
function storage(path: string) {
  const parent = resolve(path); directory(join(parent, ".."));
  try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(parent); return realpathSync.native(parent);
}
function accessScopes(access: ArtifactAccess) {
  if (access.owner !== true) fail(404, "Files are unavailable.");
  if (!Array.isArray(access.scopes) || access.scopes.length > 20_000) fail(400, "Invalid file scope.");
  return access.scopes;
}
export function initializeArtifacts(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, extension TEXT NOT NULL, created_at INTEGER NOT NULL,
    bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, source_root TEXT NOT NULL,
    relative_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
    UNIQUE(bot_id,thread_id,run_id,source_root,relative_path,sha256));
    CREATE INDEX IF NOT EXISTS artifacts_scope_date ON artifacts(bot_id,source_root,thread_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS artifacts_kind_date ON artifacts(kind,created_at DESC);`);
}
interface Row { id: string; name: string; kind: ArtifactKind; mime: string; bytes: number; sha256: string; extension: string; created_at: number; bot_id: string; thread_id: string; run_id: string; source_root: string; relative_path: string; source_fingerprint: string }
const blobName = (row: Pick<Row, "sha256" | "extension">) => {
  if (!/^[a-f0-9]{64}$/.test(row.sha256) || !/^\.[a-z0-9]{1,12}$/.test(row.extension)) fail(409, "Saved file identity is invalid.");
  return row.sha256 + row.extension;
};
function matching(row: Row, access: ArtifactAccess) {
  return accessScopes(access).find(scope => scope.botId === row.bot_id && (scope.threadId === undefined || scope.threadId === row.thread_id) && artifactWorkspaceIdentity(scope.workspaceRoot) === row.source_root);
}
function publicRow(row: Row, scope: ArtifactScope, storageRoot: string): Artifact {
  let sourceState: Artifact["sourceState"] = "unavailable", savedState: Artifact["savedState"] = "unavailable";
  try { sourceState = fingerprint(sourceFile(row.source_root, row.relative_path).stat) === row.source_fingerprint ? "current" : "changed"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") sourceState = "missing"; }
  try { directory(storageRoot); const stat = lstatSync(join(storageRoot, blobName(row))); savedState = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === row.bytes ? "available" : "unavailable"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") savedState = "missing"; }
  return { id: row.id, name: row.name, filename: row.name.toLowerCase().endsWith(row.extension) ? row.name : row.name + row.extension, kind: row.kind, mime: row.mime, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at,
    botId: row.bot_id, botName: clean(scope.botName, 100), threadId: row.thread_id, ...(row.run_id ? { runId: row.run_id } : {}), relativePath: row.relative_path,
    sourceState, savedState, sourceConversationAvailable: scope.threadAvailable !== false && scope.threadId !== undefined };
}

/** Trusted caller provides the exact currently authorized workspace; input
 * cannot choose an absolute root or claim another run's provenance. */
export function registerArtifact(db: DatabaseSync, storageRoot: string, input: ArtifactRegistration, access: ArtifactAccess): Artifact {
  const scope = accessScopes(access).find(scope => scope.botId === input.botId && scope.threadId === input.threadId && scope.threadAvailable !== false);
  if (!scope) fail(404, "This task's file scope is unavailable.");
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)) fail(400, "Use a short file title.");
  try {
    const root = rootPath(scope.workspaceRoot), source = sourceFile(root, input.relativePath);
    const bytes = readVerified(source.path, ARTIFACT_MAX_BYTES, source.stat);
    if (source.observed.some(([path, stat]) => !same(stat, lstatSync(path)))) fail(409, "The file location changed during verification.");
    const sha256 = hash(bytes), fileFormat = format(input.relativePath), directoryPath = storage(storageRoot), blob = join(directoryPath, sha256 + fileFormat.extension);
    let exists = false;
    try { exists = hash(readVerified(blob, ARTIFACT_MAX_BYTES)) === sha256; if (!exists) fail(409, "The saved copy failed verification."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!exists) {
      let usage = 0; const names = readdirSync(directoryPath); if (names.length >= 10_000) fail(507, "The Files library has reached its storage limit.");
      for (const name of names) { const stat = lstatSync(join(directoryPath, name)); if (!stat.isFile() || stat.isSymbolicLink()) fail(409, "The Files storage needs attention."); usage += stat.size; }
      if (usage + bytes.length > ARTIFACT_STORAGE_MAX_BYTES) fail(507, "The Files library has reached its 512 MiB storage limit. No saved files were removed.");
      const candidate = join(directoryPath, `.candidate-${randomUUID()}`); let fd: number | undefined, created = false;
      try {
        fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); created = true;
        writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
        linkSync(candidate, blob);
      } finally { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(candidate); }
      if (hash(readVerified(blob, ARTIFACT_MAX_BYTES)) !== sha256) fail(409, "The saved copy failed verification.");
    }
    const id = randomUUID(), name = clean(input.name?.trim() || basename(input.relativePath), 200), run = scope.runId ?? "";
    db.prepare("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, name, fileFormat.kind, fileFormat.mime, bytes.length, sha256, fileFormat.extension, Date.now(), input.botId, input.threadId, run, root, input.relativePath, fingerprint(source.stat));
    const row = db.prepare("SELECT * FROM artifacts WHERE bot_id=? AND thread_id=? AND run_id=? AND source_root=? AND relative_path=? AND sha256=?")
      .get(input.botId, input.threadId, run, root, input.relativePath, sha256) as unknown as Row;
    return publicRow(row, { ...scope, workspaceRoot: root }, directoryPath);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(404, "That file was not found inside this task's workspace.");
    fail(409, "The file could not be safely saved. The original was preserved.");
  }
}

export function listArtifacts(db: DatabaseSync, storageRoot: string, query: ArtifactQuery, access: ArtifactAccess): ArtifactPage {
  const scopes = accessScopes(access), page = query.page ?? 0, pageSize = query.pageSize ?? 25;
  if (!Number.isInteger(page) || page < 0 || page > 100_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (query.query !== undefined && (typeof query.query !== "string" || query.query.length > 200))
    || [query.botId, query.threadId].some(value => value !== undefined && (typeof value !== "string" || value.length > 200))
    || (query.kind !== undefined && !["html", "text", "image", "other"].includes(query.kind))
    || [query.since, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) fail(400, "Invalid Files filters.");
  const predicate = `EXISTS (SELECT 1 FROM json_each(?) s WHERE json_extract(s.value,'$.botId')=bot_id AND json_extract(s.value,'$.workspaceRoot')=source_root AND (json_extract(s.value,'$.threadId') IS NULL OR json_extract(s.value,'$.threadId')=thread_id))
    AND (?='' OR bot_id=?) AND (?='' OR thread_id=?) AND (?='' OR kind=?) AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) AND (?='' OR instr(lower(name || ' ' || relative_path),?)>0)`;
  const search = (query.query ?? "").toLowerCase().trim();
  const args = [JSON.stringify(scopes.map(scope => ({ ...scope, workspaceRoot: artifactWorkspaceIdentity(scope.workspaceRoot) }))), query.botId ?? "", query.botId ?? "", query.threadId ?? "", query.threadId ?? "", query.kind ?? "", query.kind ?? "", query.since ?? null, query.since ?? null, query.until ?? null, query.until ?? null, search, search];
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE ${predicate}`).get(...args)?.n ?? 0);
  const rows = db.prepare(`SELECT * FROM artifacts WHERE ${predicate} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(...args, pageSize, page * pageSize) as unknown as Row[];
  return { items: rows.map(row => publicRow(row, matching(row, access)!, storageRoot)), total, page, pageSize };
}

export function describeArtifact(db: DatabaseSync, storageRoot: string, id: string, access: ArtifactAccess): Artifact {
  accessScopes(access); const row = db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as unknown as Row | undefined;
  const scope = row && matching(row, access); if (!row || !scope) fail(404, "This saved file is unavailable.");
  return publicRow(row, scope, storageRoot);
}

export function readArtifact(db: DatabaseSync, storageRoot: string, id: string, access: ArtifactAccess) {
  accessScopes(access); const row = db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as unknown as Row | undefined;
  const scope = row && matching(row, access); if (!row || !scope) fail(404, "This saved file is unavailable.");
  try {
    directory(storageRoot); const path = join(storageRoot, blobName(row)), bytes = readVerified(path, ARTIFACT_MAX_BYTES);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail(409, "The saved copy changed and cannot be opened. Register the original again if it is still available.");
    return { artifact: publicRow(row, scope, storageRoot), bytes, verifiedNativePath: path };
  } catch (error) { if (error instanceof ArtifactError) throw error; fail(410, "The saved copy is missing or unreadable. Register the original again if it is still available."); }
}

export function previewArtifact(db: DatabaseSync, storageRoot: string, id: string, access: ArtifactAccess): ArtifactPreview {
  const { artifact, bytes } = readArtifact(db, storageRoot, id, access);
  if (bytes.length > ARTIFACT_PREVIEW_MAX_BYTES || artifact.kind === "other") return { artifact, mode: "download" };
  if (artifact.kind === "image") return { artifact, mode: "image", content: `data:${artifact.mime};base64,${bytes.toString("base64")}` };
  let content: string; try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { artifact, mode: "download" }; }
  return { artifact, mode: artifact.kind, content };
}

/** Owner-only initial HTTP adapter. Root authenticates internal tool calls
 * separately; clients cannot pass workspaceRoot or native paths. */
export function artifactsRequest(db: DatabaseSync, storageRoot: string, request: { method: string; path: string; query?: ArtifactQuery; body?: ArtifactRegistration }, access: ArtifactAccess) {
  try {
    accessScopes(access);
    if (request.path === "/api/artifacts" && request.method === "GET") return { status: 200, body: listArtifacts(db, storageRoot, request.query ?? {}, access) };
    if (request.path === "/api/artifacts/register" && request.method === "POST") {
      if (!request.body || Object.keys(request.body).some(key => !["botId", "threadId", "relativePath", "name"].includes(key))) fail(400, "Invalid file registration.");
      return { status: 201, body: { artifact: registerArtifact(db, storageRoot, request.body, access) } };
    }
    const metadata = /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(request.path);
    if (metadata && request.method === "GET") return { status: 200, body: { artifact: describeArtifact(db, storageRoot, metadata[1], access) } };
    const match = /^\/api\/artifacts\/([a-f0-9-]{36})\/(preview|download)$/.exec(request.path);
    if (match && request.method === "GET") {
      if (match[2] === "preview") return { status: 200, body: previewArtifact(db, storageRoot, match[1], access), headers: { "content-type": "application/json; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "cache-control": "no-store" } };
      const { artifact, bytes } = readArtifact(db, storageRoot, match[1], access);
      return { status: 200, bytes, headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`, "x-content-type-options": "nosniff", "cache-control": "no-store" } };
    }
    return { status: 404, body: { error: "Files are unavailable." } };
  } catch (error) { if (error instanceof ArtifactError) return { status: error.status, body: { error: error.message } }; throw error; }
}
